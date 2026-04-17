import { jest } from '@jest/globals';
import { retry, retryFetch, HttpError, defaultShouldRetry } from '../src/retry.js';

describe('defaultShouldRetry', () => {
  it('retries 5xx HttpErrors', () => {
    expect(defaultShouldRetry(new HttpError(500, 'x'))).toBe(true);
    expect(defaultShouldRetry(new HttpError(503, 'x'))).toBe(true);
  });

  it('retries 408 and 429 but not other 4xx', () => {
    expect(defaultShouldRetry(new HttpError(408, 'x'))).toBe(true);
    expect(defaultShouldRetry(new HttpError(429, 'x'))).toBe(true);
    expect(defaultShouldRetry(new HttpError(400, 'x'))).toBe(false);
    expect(defaultShouldRetry(new HttpError(401, 'x'))).toBe(false);
    expect(defaultShouldRetry(new HttpError(404, 'x'))).toBe(false);
  });

  it('retries AbortError and TimeoutError', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(defaultShouldRetry(abort)).toBe(true);

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(defaultShouldRetry(timeout)).toBe(true);
  });

  it('retries network-layer errors by message substring', () => {
    expect(defaultShouldRetry(new Error('ECONNRESET'))).toBe(true);
    expect(defaultShouldRetry(new Error('ENOTFOUND example.com'))).toBe(true);
    expect(defaultShouldRetry(new Error('socket hang up'))).toBe(true);
    expect(defaultShouldRetry(new Error('fetch failed'))).toBe(true);
  });

  it('does NOT retry plain application errors', () => {
    expect(defaultShouldRetry(new Error('bad input'))).toBe(false);
    expect(defaultShouldRetry(new SyntaxError('Unexpected token'))).toBe(false);
    expect(defaultShouldRetry('not an error')).toBe(false);
  });
});

describe('retry', () => {
  it('returns on first success without sleeping', async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const result = await retry(fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on retriable errors then succeeds', async () => {
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError(503, 'busy'))
      .mockRejectedValueOnce(new HttpError(500, 'busy'))
      .mockResolvedValueOnce('ok');
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const onRetry = jest.fn();
    const result = await retry(fn, { sleep, onRetry, random: () => 0.5 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on non-retriable errors', async () => {
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new HttpError(401, 'nope'));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(retry(fn, { sleep })).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the last error after exhausting retries', async () => {
    const err = new HttpError(503, 'down');
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(retry(fn, { sleep, retries: 2, random: () => 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('applies exponential backoff with jitter', async () => {
    const delays: number[] = [];
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockImplementation(async (ms) => {
      delays.push(ms);
    });
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError(503, 'a'))
      .mockRejectedValueOnce(new HttpError(503, 'b'))
      .mockRejectedValueOnce(new HttpError(503, 'c'))
      .mockResolvedValueOnce('ok');
    await retry(fn, { sleep, baseDelayMs: 100, maxDelayMs: 10_000, random: () => 1 });
    // rand=1 => delay = floor(exp) i.e. exactly the cap
    // attempt 0: 100 * 2^0 = 100; attempt 1: 200; attempt 2: 400
    expect(delays).toEqual([100, 200, 400]);
  });
});

describe('retryFetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns successful responses without retrying', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const res = await retryFetch('https://example.com', {}, { sleep });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 then succeeds', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const res = await retryFetch('https://example.com', {}, { sleep, random: () => 0 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry 404 — leaves it for the caller', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 404 }));
    globalThis.fetch = fetchMock;
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const res = await retryFetch('https://example.com', {}, { sleep });
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
