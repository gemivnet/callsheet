import { jest } from '@jest/globals';

const mockExecFileSync = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

const print = await import('../src/print.js');

const noSleep = () => Promise.resolve();

/** Make execFileSync answer `lp` and `lpstat` calls from small scripts. */
function scriptCups(handlers: {
  lp?: () => unknown;
  pending?: () => unknown;
  state?: () => unknown;
}) {
  mockExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
    const a = args as string[];
    if (cmd === 'lp') return handlers.lp?.() ?? 'request id is Office-7 (1 file(s))';
    if (cmd === 'lpstat' && a[0] === '-W') return handlers.pending?.() ?? '';
    if (cmd === 'lpstat' && a[0] === '-p') return handlers.state?.() ?? '';
    throw new Error(`unexpected command ${String(cmd)}`);
  });
}

let logSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('printPdf', () => {
  it('calls lp with the printer and path as argv, and returns the job id', () => {
    scriptCups({});

    const id = print.printPdf('/tmp/test.pdf', 'Brother_HL');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'lp',
      ['-d', 'Brother_HL', '/tmp/test.pdf'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(id).toBe('Office-7');
  });

  it('does not let a printer name from config reach a shell', () => {
    scriptCups({});

    print.printPdf('/tmp/test.pdf', '"; touch /tmp/pwned; #');

    // One literal argv entry; execFileSync spawns no shell to interpret it.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'lp',
      ['-d', '"; touch /tmp/pwned; #', '/tmp/test.pdf'],
      expect.anything(),
    );
  });

  it('returns undefined when lp prints nothing', () => {
    scriptCups({ lp: () => '' });
    expect(print.printPdf('/tmp/a.pdf', 'P')).toBeUndefined();
  });

  it('tolerates a mocked or empty return value', () => {
    mockExecFileSync.mockReturnValue(undefined);
    expect(print.printPdf('/tmp/a.pdf', 'P')).toBeUndefined();
  });
});

describe('parseJobId', () => {
  it('reads the request id from lp output', () => {
    expect(print.parseJobId('request id is Office_Printer-156 (1 file(s))')).toBe('Office_Printer-156');
  });

  it('returns undefined for anything else', () => {
    expect(print.parseJobId('lp: Error - something')).toBeUndefined();
  });
});

describe('describePrintError', () => {
  it('names a dead CUPS socket for what it is', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'lpstat: Scheduler is not running.',
    });
    expect(print.describePrintError(err)).toMatch(/CUPS unreachable.*socket/);
  });

  it('explains the misleading "printer does not exist" message', () => {
    const err = Object.assign(new Error('Command failed: lp -d X a.pdf'), {
      stderr: 'lp: Error - The printer or class does not exist.',
    });
    expect(print.describePrintError(err)).toMatch(/stale or unreachable/);
  });

  it('spots a missing lp binary', () => {
    expect(print.describePrintError(new Error('spawnSync lp ENOENT'))).toMatch(/cups-client/);
  });

  it('falls back to the message, trimmed to one line', () => {
    expect(print.describePrintError(new Error('paper\n  jam'))).toBe('paper jam');
  });

  it('copes with a thrown non-Error', () => {
    expect(print.describePrintError('weird')).toBe('weird');
  });
});

describe('isJobPending', () => {
  it('is true while the job is listed as not completed', () => {
    scriptCups({ pending: () => 'Office-7 node 44032 Wed 14 Oct\nOffice-8 node 1 Wed\n' });
    expect(print.isJobPending('Office-7', 'Office')).toBe(true);
  });

  it('is false once the job has left the list', () => {
    scriptCups({ pending: () => 'Office-8 node 1 Wed\n' });
    expect(print.isJobPending('Office-7', 'Office')).toBe(false);
  });

  it('does not match a job id that is only a prefix of another', () => {
    scriptCups({ pending: () => 'Office-70 node 1 Wed\n' });
    expect(print.isJobPending('Office-7', 'Office')).toBe(false);
  });

  it('handles empty lpstat output', () => {
    mockExecFileSync.mockReturnValue(undefined);
    expect(print.isJobPending('Office-7', 'Office')).toBe(false);
  });
});

describe('printerState', () => {
  it('returns the printer line, collapsed', () => {
    scriptCups({ state: () => 'printer Office is idle.\n  enabled since today\n' });
    expect(print.printerState('Office')).toBe('printer Office is idle. enabled since today');
  });

  it('returns an empty string when lpstat fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('nope');
    });
    expect(print.printerState('Office')).toBe('');
  });

  it('returns an empty string for empty output', () => {
    mockExecFileSync.mockReturnValue(undefined);
    expect(print.printerState('Office')).toBe('');
  });
});

describe('printAndConfirm', () => {
  it('reports printed once the job leaves the queue', async () => {
    let checks = 0;
    scriptCups({ pending: () => (++checks < 3 ? 'Office-7 node 1\n' : '') });

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', {
      sleep: noSleep,
      pollMs: 10,
      confirmTimeoutMs: 1000,
    });

    expect(result).toEqual({ outcome: 'printed', jobId: 'Office-7' });
    expect(checks).toBe(3);
  });

  it('retries a failed submission and succeeds', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    scriptCups({
      lp: () => {
        if (++attempts < 2) throw new Error('Scheduler is not running');
        return 'request id is Office-9 (1 file(s))';
      },
    });

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      retryDelayMs: 100,
      pollMs: 10,
      confirmTimeoutMs: 10,
    });

    expect(result.outcome).toBe('printed');
    expect(result.jobId).toBe('Office-9');
    expect(sleeps[0]).toBe(100);
  });

  it('gives up after the configured attempts with an actionable reason', async () => {
    scriptCups({
      lp: () => {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'lp: Error - The printer or class does not exist.',
        });
      },
    });

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', {
      sleep: noSleep,
      attempts: 3,
    });

    expect(result.outcome).toBe('failed');
    expect(result.detail).toMatch(/stale or unreachable/);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it('reports queued, with the printer state, when the job never completes', async () => {
    scriptCups({
      pending: () => 'Office-7 node 1\n',
      state: () => 'printer Office disabled since today - paper out',
    });

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', {
      sleep: noSleep,
      pollMs: 60_000,
      confirmTimeoutMs: 5 * 60_000,
    });

    expect(result.outcome).toBe('queued');
    expect(result.detail).toMatch(/still queued after 5 min/);
    expect(result.detail).toMatch(/paper out/);
  });

  it('keeps watching when lpstat itself errors', async () => {
    let checks = 0;
    scriptCups({
      pending: () => {
        if (++checks === 1) throw new Error('lpstat hiccup');
        return '';
      },
    });

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', {
      sleep: noSleep,
      pollMs: 10,
      confirmTimeoutMs: 100,
    });

    expect(result.outcome).toBe('printed');
  });

  it('cannot confirm without a job id, and says printed', async () => {
    scriptCups({ lp: () => '' });

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', { sleep: noSleep });

    expect(result).toEqual({ outcome: 'printed', jobId: undefined });
  });

  it('skips the watch when confirmation is turned off', async () => {
    scriptCups({});

    const result = await print.printAndConfirm('/tmp/a.pdf', 'Office', {
      sleep: noSleep,
      confirmTimeoutMs: 0,
    });

    expect(result).toEqual({ outcome: 'printed', jobId: 'Office-7' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('uses real timers by default', async () => {
    jest.useFakeTimers();
    scriptCups({});

    const pending = print.printAndConfirm('/tmp/a.pdf', 'Office', {
      pollMs: 1000,
      confirmTimeoutMs: 1000,
    });
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.outcome).toBe('printed');
    jest.useRealTimers();
  });
});
