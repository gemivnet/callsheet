import cron from 'node-cron';
import { loadConfig, runPipeline } from './core.js';
import type { CallsheetConfig } from './types.js';

let running = false;

/**
 * Returns today's date as YYYY-MM-DD in the configured timezone (TZ env var
 * or system default). Forcing en-CA gives a clean ISO date without UTC drift
 * when the brief runs late at night or pre-dawn.
 */
function todayInTz(): string {
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

/**
 * Run a single brief generation cycle.
 * Includes a mutex to prevent concurrent runs (e.g. scheduler + API trigger).
 */
export async function runGeneration(configPath: string): Promise<void> {
  if (running) {
    console.log('[scheduler] Generation already in progress, skipping.');
    return;
  }

  running = true;
  const startTime = Date.now();
  console.log(`[scheduler] Starting generation at ${new Date().toISOString()}`);

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
    await runPipeline(config, { preview });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[scheduler] Generation complete in ${elapsed}s`);
  } catch (e) {
    console.error(`[scheduler] Generation failed:`, e);
  } finally {
    running = false;
  }
}

/**
 * Start the cron scheduler for Docker modes.
 * Runs brief generation on the given cron schedule.
 */
export function startScheduler(schedule: string, configPath: string): cron.ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  console.log(`[scheduler] Scheduled brief generation: ${schedule}`);
  console.log(`[scheduler] Config: ${configPath}`);
  console.log(`[scheduler] Timezone: ${process.env.TZ ?? 'system default'}`);

  const task = cron.schedule(schedule, () => {
    runGeneration(configPath).catch((e) => {
      console.error('[scheduler] Unhandled error in generation:', e);
    });
  });

  return task;
}

/** Check if a generation is currently running. */
export function isGenerating(): boolean {
  return running;
}
