/**
 * Printing through CUPS, with retries and a check that the page came out.
 *
 * `lp` succeeding only means CUPS queued the job. Before this module the
 * pipeline treated a successful `lp` as "printed" and a failed one as a crash
 * that took the rest of the run down with it, logged as "Generation failed"
 * even though the brief had been written. From 2026-09-28 every print failed
 * that way for more than two weeks, and nothing said so anywhere a person
 * would see.
 */
import { execFileSync } from 'node:child_process';
import type { PrintOutcome } from './status.js';

export interface PrintResult {
  outcome: Exclude<PrintOutcome, 'skipped'>;
  /** CUPS request id, e.g. "Office_Printer-156". */
  jobId?: string;
  /** Why it failed or is still waiting, in one line. */
  detail?: string;
}

export interface PrintOptions {
  /** Submission attempts before giving up. */
  attempts?: number;
  /** Delay before the second attempt; later attempts back off linearly. */
  retryDelayMs?: number;
  /** How long to watch the job for completion. 0 skips the check. */
  confirmTimeoutMs?: number;
  /** Interval between job-state checks. */
  pollMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS: Required<Omit<PrintOptions, 'sleep'>> = {
  attempts: 3,
  retryDelayMs: 30_000,
  // A healthy job on the household printer completes in about a minute,
  // including waking it from sleep. Five minutes is generous for that and
  // short enough that an alert still arrives before anyone is up.
  confirmTimeoutMs: 5 * 60_000,
  pollMs: 10_000,
};

const sleepMs = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit a PDF to a CUPS queue and return the request id.
 *
 * execFileSync, not execSync: `printer` comes from config.yaml, which the
 * dashboard can rewrite unauthenticated, so an interpolated shell string was a
 * command-injection sink. No shell is spawned here, so quoting is not required
 * and metacharacters are inert.
 */
export function printPdf(pdfPath: string, printer: string): string | undefined {
  const out = execFileSync('lp', ['-d', printer, pdfPath], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Typed as a string, but a stubbed or odd `lp` can hand back nothing at all.
  const text = typeof out === 'string' ? out.trim() : '';
  if (text) console.log(`  ${text}`);
  return parseJobId(text);
}

/** Pull the request id out of `lp` output: "request id is Office-156 (1 file(s))". */
export function parseJobId(lpOutput: string): string | undefined {
  return /request id is (\S+)/.exec(lpOutput)?.[1];
}

/**
 * Turn an `lp` failure into something a person can act on.
 *
 * The raw message is often misleading: when the CUPS socket inside the
 * container is dead, `lp -d <queue>` reports "The printer or class does not
 * exist" — about a printer that exists and is idle on the host.
 */
export function describePrintError(err: unknown): string {
  const e = err as { stderr?: unknown; message?: string };
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
  const raw = (stderr || (e?.message ?? String(err))).replace(/\s+/g, ' ').trim();
  if (/scheduler is not running|unable to connect|connection refused|no such file/i.test(raw)) {
    return `CUPS unreachable (${raw.slice(0, 80)}) — check the CUPS socket mount`;
  }
  if (/printer or class does not exist/i.test(raw)) {
    return (
      'CUPS says the printer does not exist — if it does on the host, ' +
      'the CUPS socket is stale or unreachable'
    );
  }
  if (raw.includes('ENOENT')) return '`lp` is not installed (install cups-client)';
  return raw.slice(0, 160);
}

/** True while `jobId` is still in the printer's not-completed list. */
export function isJobPending(jobId: string, printer: string): boolean {
  const out = execFileSync('lpstat', ['-W', 'not-completed', '-o', printer], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (typeof out === 'string' ? out : '')
    .split('\n')
    .some((line) => line.split(/\s+/)[0] === jobId);
}

/** The printer's own state line, for the alert when a job sits in the queue. */
export function printerState(printer: string): string {
  try {
    const out = execFileSync('lpstat', ['-p', printer], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return (typeof out === 'string' ? out : '').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * Print a PDF, retrying submission, then watch the job until CUPS reports it
 * finished. Never throws — the outcome says what happened.
 */
export async function printAndConfirm(
  pdfPath: string,
  printer: string,
  options: PrintOptions = {},
): Promise<PrintResult> {
  const opts = { ...DEFAULTS, ...options };
  const sleep = options.sleep ?? sleepMs;

  let jobId: string | undefined;
  let lastError: unknown;
  let submitted = false;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      jobId = printPdf(pdfPath, printer);
      submitted = true;
      break;
    } catch (e) {
      lastError = e;
      console.log(`  Print attempt ${attempt} failed: ${describePrintError(e)}`);
      if (attempt < opts.attempts) await sleep(opts.retryDelayMs * attempt);
    }
  }
  if (!submitted) return { outcome: 'failed', detail: describePrintError(lastError) };

  // Without a job id (an `lp` that printed nothing) or a watch window there is
  // nothing to confirm; CUPS accepted it, which is all that can be said.
  if (!jobId || opts.confirmTimeoutMs <= 0) return { outcome: 'printed', jobId };

  const polls = Math.max(1, Math.ceil(opts.confirmTimeoutMs / opts.pollMs));
  for (let i = 0; i < polls; i++) {
    await sleep(opts.pollMs);
    try {
      if (!isJobPending(jobId, printer)) {
        console.log(`  Print job ${jobId} completed.`);
        return { outcome: 'printed', jobId };
      }
    } catch {
      // lpstat itself failing says nothing about the job; keep watching.
    }
  }

  const state = printerState(printer);
  return {
    outcome: 'queued',
    jobId,
    detail: `job ${jobId} still queued after ${Math.round(opts.confirmTimeoutMs / 60_000)} min${
      state ? ` (${state})` : ''
    }`,
  };
}
