import cron, { type ScheduledTask } from 'node-cron';
import { loadConfig, runPipeline } from './core.js';
import type { CallsheetConfig } from './types.js';
import { readStatus, scheduledRunExists, type RunTrigger } from './status.js';
import { todayYmd } from './dates.js';

let running = false;

/** The live cron task and its config, kept so health checks can ask what was due. */
let activeTask: ScheduledTask | null = null;
let activeConfigPath = 'config.yaml';
let watchdog: ReturnType<typeof setInterval> | null = null;

/**
 * How long after a scheduled time a brief is still worth producing late.
 *
 * Long enough to cover a container restarted mid-morning or a host that was
 * paused across the scheduled minute, short enough that nobody gets a
 * "morning" brief printed in the middle of the afternoon. Override with the
 * CATCHUP_HOURS environment variable; 0 disables catch-up entirely.
 */
export const DEFAULT_CATCHUP_HOURS = 6;

/** How often the watchdog re-checks for a missed run. */
const WATCHDOG_INTERVAL_MS = 15 * 60_000;

/** Grace after a scheduled time before /api/status calls the brief overdue. */
export const OVERDUE_GRACE_MINUTES = 90;

/**
 * Returns today's date as YYYY-MM-DD in the configured timezone (TZ env var
 * or system default). Forcing en-CA gives a clean ISO date without UTC drift
 * when the brief runs late at night or pre-dawn.
 */
export function todayInTz(): string {
  const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Returns true if `today` (YYYY-MM-DD) falls within any configured vacation
 * range. Ranges are inclusive on both ends. Pass `today` for testability;
 * defaults to today in the configured TZ.
 */
export function isOnVacation(config: CallsheetConfig, today: string = todayInTz()): boolean {
  const ranges = config.vacation;
  if (!ranges || ranges.length === 0) return false;
  return ranges.some((r) => {
    if (!r?.start || !r?.end) return false;
    return today >= r.start && today <= r.end;
  });
}

/** Catch-up window in hours, from CATCHUP_HOURS or the default. */
export function catchupHours(): number {
  const raw = process.env.CATCHUP_HOURS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CATCHUP_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CATCHUP_HOURS;
}

/**
 * Run a single brief generation cycle.
 * Includes a mutex to prevent concurrent runs (e.g. scheduler + API trigger).
 */
export async function runGeneration(
  configPath: string,
  trigger: RunTrigger = 'scheduled',
): Promise<void> {
  if (running) {
    console.log('[scheduler] Generation already in progress, skipping.');
    return;
  }

  running = true;
  const startTime = Date.now();
  console.log(`[scheduler] Starting ${trigger} generation at ${new Date().toISOString()}`);

  try {
    const config = loadConfig(configPath);
    if (isOnVacation(config)) {
      console.log(`[scheduler] On vacation today (${todayInTz()}), skipping generation.`);
      return;
    }
    // Scheduled briefs print to the configured printer by default, matching a
    // host cron. Set PRINT_BRIEF=false (e.g. UI-only deployments) to generate
    // the PDF and dashboard artifacts without sending a print job.
    const preview = process.env.PRINT_BRIEF === 'false';
    const result = await runPipeline(config, { preview, trigger });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[scheduler] Run complete in ${elapsed}s — brief: ${
        result.generated ? 'written' : 'ERROR PAGE'
      }, print: ${result.print.outcome}${result.print.detail ? ` (${result.print.detail})` : ''}`,
    );
  } catch (e) {
    console.error(`[scheduler] Run failed:`, e);
  } finally {
    running = false;
  }
}

/**
 * The most recent minute at or before `now` on which `task` fires, looking
 * back no further than `withinHours`. node-cron can say when a task fires
 * next but not when it last should have, so this walks back a minute at a
 * time — at most a few thousand cheap matches.
 */
export function lastOccurrence(
  task: Pick<ScheduledTask, 'match'>,
  now: Date,
  withinHours: number,
): Date | null {
  const start = new Date(now);
  start.setSeconds(0, 0);
  const steps = Math.floor(withinHours * 60);
  for (let i = 0; i <= steps; i++) {
    const t = new Date(start.getTime() - i * 60_000);
    if (task.match(t)) return t;
  }
  return null;
}

/**
 * Produce the brief late if its scheduled time passed without one.
 *
 * node-cron 4 drops a tick it notices too late — on 2026-10-04 the host was
 * paused across 04:00, node-cron logged "missed execution" three minutes later
 * and the household got no brief that day. A container recreated or restarted
 * across the scheduled minute loses the run the same way. This is called on
 * start-up, on node-cron's missed-execution event, and by a periodic watchdog;
 * it is idempotent because a scheduled run records itself in the status file.
 *
 * Returns true when it started a run.
 */
export async function catchUpIfDue(
  task: Pick<ScheduledTask, 'match'>,
  configPath: string,
  now: Date = new Date(),
): Promise<boolean> {
  const hours = catchupHours();
  if (hours <= 0 || running) return false;

  const occurrence = lastOccurrence(task, now, hours);
  if (!occurrence) return false;

  let config: CallsheetConfig;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error(`[scheduler] Catch-up check could not load config: ${e}`);
    return false;
  }

  const date = todayYmd(config.timezone, occurrence);
  if (isOnVacation(config, date)) return false;
  if (scheduledRunExists(readStatus(config.output_dir ?? 'output'), date)) return false;

  console.log(
    `[scheduler] No brief yet for the run scheduled at ${occurrence.toISOString()} — catching up.`,
  );
  await runGeneration(configPath, 'catch-up');
  return true;
}

/**
 * The household date whose scheduled brief should exist by `now`, or null when
 * none is due (no scheduler running, before the first run, or a vacation day).
 * Used by /api/status to tell "not yet" from "overdue".
 */
export function expectedRunDate(config: CallsheetConfig, now: Date = new Date()): string | null {
  if (!activeTask) return null;
  const cutoff = new Date(now.getTime() - OVERDUE_GRACE_MINUTES * 60_000);
  const occurrence = lastOccurrence(activeTask, cutoff, 26);
  if (!occurrence) return null;
  const date = todayYmd(config.timezone, occurrence);
  return isOnVacation(config, date) ? null : date;
}

/**
 * Start the cron scheduler for Docker modes.
 * Runs brief generation on the given cron schedule, and catches up on a run
 * that was missed while the process was paused or down.
 */
export function startScheduler(schedule: string, configPath: string): ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  console.log(`[scheduler] Scheduled brief generation: ${schedule}`);
  console.log(`[scheduler] Config: ${configPath}`);
  console.log(`[scheduler] Timezone: ${process.env.TZ ?? 'system default'}`);
  console.log(`[scheduler] Catch-up window: ${catchupHours()}h`);

  const task = cron.schedule(schedule, () => {
    runGeneration(configPath).catch((e) => {
      console.error('[scheduler] Unhandled error in generation:', e);
    });
  });

  const check = (why: string) => {
    catchUpIfDue(task, configPath).catch((e) => {
      console.error(`[scheduler] Catch-up after ${why} failed:`, e);
    });
  };

  // Registering a listener also silences node-cron's own warning, so say it here.
  task.on('execution:missed', (ctx) => {
    console.log(`[scheduler] node-cron missed the run due at ${ctx.date.toISOString()}.`);
    check('missed execution');
  });

  activeTask = task;
  activeConfigPath = configPath;

  // On start-up: a container recreated after the scheduled minute would
  // otherwise wait a whole day for its first brief.
  check('start-up');

  // And periodically, for anything neither of the above sees.
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => check('watchdog'), WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  return task;
}

/** Stop the watchdog and forget the active task (tests, shutdown). */
export function stopScheduler(): void {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  activeTask = null;
}

/** The config path the running scheduler was started with. */
export function schedulerConfigPath(): string {
  return activeConfigPath;
}

/** Check if a generation is currently running. */
export function isGenerating(): boolean {
  return running;
}
