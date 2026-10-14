/**
 * Run status — what happened the last time a brief was produced.
 *
 * Until this existed the only record of a run was the console. Every print
 * between 2026-09-28 and 2026-10-14 failed while the container reported itself
 * healthy, the dashboard showed a fresh brief each morning, and nothing anyone
 * looked at said the page never came out of the printer. A brief that is
 * generated but not delivered is a failed run, and it has to be visible as one.
 *
 * The file lives in the output directory next to the briefs, so it survives
 * container recreation and is readable by anything that can read the briefs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What started a run. Only scheduler-started runs count toward "did today's brief happen". */
export type RunTrigger = 'scheduled' | 'catch-up' | 'manual' | 'dashboard';

/**
 * How printing went.
 *
 * - `printed` — CUPS accepted the job and reported it complete.
 * - `queued` — CUPS accepted the job but it had not completed when we stopped
 *   watching (printer asleep, offline, out of paper).
 * - `failed` — the job could not be submitted at all.
 * - `skipped` — preview run, or no printer configured.
 */
export type PrintOutcome = 'printed' | 'queued' | 'failed' | 'skipped';

export interface RunRecord {
  /** Household-local date the brief is for (YYYY-MM-DD). */
  date: string;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt?: string;
  /** False when the model could not write the brief and an error page went out instead. */
  generated: boolean;
  print: PrintOutcome;
  /** CUPS job id, when one was assigned. */
  printJob?: string;
  /** One short line describing the failure, for the dashboard and alerts. */
  error?: string;
  /** Connectors that failed during the fetch, as "name: error". */
  connectorIssues?: string[];
}

export interface StatusFile {
  /** The most recent run of any kind. */
  last?: RunRecord;
  /** The most recent run started by the scheduler (on time or as a catch-up). */
  lastScheduled?: RunRecord;
}

const STATUS_FILE = 'status.json';

/** True for triggers that represent the morning's scheduled brief. */
export function isScheduledTrigger(trigger: RunTrigger): boolean {
  return trigger === 'scheduled' || trigger === 'catch-up';
}

/** Read the status file. A missing or unreadable file is an empty status, never an error. */
export function readStatus(outputDir: string): StatusFile {
  const path = join(outputDir, STATUS_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StatusFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record a finished run. Scheduler-started runs also become `lastScheduled`.
 *
 * Written to a temporary file and renamed into place so a reader never sees a
 * half-written document. Never throws: losing a status line is not worth
 * failing the run it describes.
 */
export function recordRun(outputDir: string, run: RunRecord): void {
  try {
    mkdirSync(outputDir, { recursive: true });
    const status = readStatus(outputDir);
    status.last = run;
    if (isScheduledTrigger(run.trigger)) status.lastScheduled = run;
    const path = join(outputDir, STATUS_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    console.error(`  Warning: could not record run status: ${e instanceof Error ? e.message : e}`);
  }
}

/** True when the scheduler already produced today's brief, successfully or not. */
export function scheduledRunExists(status: StatusFile, date: string): boolean {
  return status.lastScheduled?.date === date;
}

export type HealthState = 'ok' | 'degraded' | 'failed' | 'overdue' | 'unknown';

export interface HealthReport {
  state: HealthState;
  reasons: string[];
  last?: RunRecord;
  lastScheduled?: RunRecord;
}

/**
 * Judge whether the household actually got its brief.
 *
 * `expectedDate` is the date of the most recent scheduled run that should have
 * happened by now (with any grace period already applied by the caller), or
 * null when no run is due — before the first scheduled time, or on a vacation
 * day. A run that is due but has no record is `overdue`; a run that produced an
 * error page or never reached the printer is `failed`; a print job that was
 * accepted but not seen to complete is `degraded`.
 */
export function evaluateHealth(status: StatusFile, expectedDate: string | null): HealthReport {
  const { last, lastScheduled } = status;
  const reasons: string[] = [];

  // YYYY-MM-DD compares correctly as a string. A run newer than the expected
  // date (today's ran, yesterday's was the last one past its grace) is fine.
  if (expectedDate && (!lastScheduled || lastScheduled.date < expectedDate)) {
    reasons.push(
      `No scheduled brief recorded for ${expectedDate}` +
        (lastScheduled ? ` (last one was ${lastScheduled.date})` : ''),
    );
    return { state: 'overdue', reasons, last, lastScheduled };
  }

  if (!lastScheduled) {
    return { state: 'unknown', reasons: ['No scheduled run recorded yet'], last, lastScheduled };
  }

  let state: HealthState = 'ok';
  if (!lastScheduled.generated) {
    state = 'failed';
    reasons.push(`Brief generation failed on ${lastScheduled.date}`);
  }
  if (lastScheduled.print === 'failed') {
    state = 'failed';
    reasons.push(`Brief for ${lastScheduled.date} was not printed`);
  } else if (lastScheduled.print === 'queued' && state === 'ok') {
    state = 'degraded';
    reasons.push(`Print job for ${lastScheduled.date} was queued but not seen to complete`);
  }
  if (lastScheduled.error) reasons.push(lastScheduled.error);

  return { state, reasons, last, lastScheduled };
}
