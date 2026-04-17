/**
 * Shared retry helper used by connectors to survive flaky upstream APIs.
 *
 * The previous approach — `try { await fetch(...) } catch { return null }` —
 * silently dropped whole connector payloads whenever an upstream had a
 * five-second hiccup. Since the user depends on the brief running to
 * completion on a 4 AM cron, data loss can't be recovered until the next
 * day. This module centralises exponential-backoff retry with jitter so
 * every connector can lean on the same semantics.
 *
 * Only transient failures are retried:
 *   - Network errors (ECONNRESET, ENOTFOUND, socket hang up, etc.)
 *   - Timeouts / aborts (AbortError, TimeoutError)
 *   - HTTP 408, 429, and 5xx responses
 *
 * Client-side errors (4xx other than 408/429) are NOT retried — they
 * indicate a configuration or auth issue that won't resolve by waiting.
 */

export interface RetryOptions {
  /** Number of retries AFTER the initial attempt. Default: 3 (4 total tries). */
  retries?: number;
  /** Starting backoff in ms. Doubles each attempt. Default: 500ms. */
  baseDelayMs?: number;
  /** Ceiling applied after backoff and jitter. Default: 10_000ms. */
  maxDelayMs?: number;
  /** Callback per retry attempt. attempt is 1-indexed (first retry = 1). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Custom decision for whether an error should be retried. */
  shouldRetry?: (err: unknown) => boolean;
  /** Optional deterministic RNG injected by tests so backoff jitter is predictable. */
  random?: () => number;
  /** Optional sleeper for tests so they don't wait real wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly url?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Default decision function — retries on the usual batch of transient
 * failures. Callers can override via `opts.shouldRetry` when an API needs
 * different semantics (e.g. retry on a specific structured response).
 */
export function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('abort')) return true;
    if (
      msg.includes('econn') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('fetch failed')
    ) {
      return true;
    }
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with retry + exponential backoff + jitter. Throws the last error
 * if all attempts fail. The `onRetry` callback fires BEFORE the delay so
 * callers can log "retrying in Nms" with the actual wait time.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 10_000;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const rand = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) throw err;
      // Full jitter: uniform [0, exp_delay] keeps the distribution sane under
      // thundering-herd conditions without blowing past maxDelayMs.
      const exp = Math.min(max, base * 2 ** attempt);
      const delay = Math.floor(rand() * exp);
      opts.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Fetch with retry. On a retriable HTTP status, throws HttpError so the
 * retry loop picks it up. Non-retriable responses (4xx that isn't 408/429)
 * are returned to the caller to handle normally — letting connectors
 * distinguish "temporary glitch" from "your token is bad".
 *
 * Callers that want to treat, say, 404 as null can still inspect `res.ok`
 * after this returns.
 */
export async function retryFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  return retry(async () => {
    const res = await fetch(url, init);
    if (!res.ok && (res.status >= 500 || res.status === 408 || res.status === 429)) {
      // Drain the body so undici can release the connection before we retry.
      await res.text().catch(() => undefined);
      throw new HttpError(res.status, `${res.status} ${res.statusText}`, String(url));
    }
    return res;
  }, opts);
}
