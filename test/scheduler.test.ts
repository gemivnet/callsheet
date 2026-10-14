import { jest } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockValidate = jest.fn<(expr: string) => boolean>();
const mockSchedule = jest.fn<(expr: string, cb: () => void) => Record<string, unknown>>();

jest.unstable_mockModule('node-cron', () => ({
  default: {
    validate: mockValidate,
    schedule: mockSchedule,
  },
}));

const mockLoadConfig = jest.fn<(path: string) => Record<string, unknown>>();
const mockRunPipeline = jest.fn<(...args: unknown[]) => Promise<unknown>>();

const mockReadStatus = jest.fn<(dir: string) => Record<string, unknown>>().mockReturnValue({});

jest.unstable_mockModule('../src/status.js', () => ({
  readStatus: mockReadStatus,
  scheduledRunExists: (status: { lastScheduled?: { date?: string } }, date: string) =>
    status.lastScheduled?.date === date,
}));

/** What runPipeline resolves to for a run that wrote and printed its brief. */
const OK_RUN = { generated: true, print: { outcome: 'printed' } };

/** A cron task double: never matches, records listeners. */
function fakeTask(overrides: Record<string, unknown> = {}) {
  return { stop: jest.fn(), on: jest.fn(), match: jest.fn(() => false), ...overrides };
}

jest.unstable_mockModule('../src/core.js', () => ({
  loadConfig: mockLoadConfig,
  runPipeline: mockRunPipeline,
}));

// Import after mocks
const scheduler = await import('../src/scheduler.js');

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockReadStatus.mockReturnValue({});
});

afterEach(() => {
  scheduler.stopScheduler();
});

describe('isGenerating', () => {
  it('should return false initially', () => {
    expect(scheduler.isGenerating()).toBe(false);
  });
});

describe('startScheduler', () => {
  it('should throw on invalid cron expression', () => {
    mockValidate.mockReturnValue(false);

    expect(() => scheduler.startScheduler('bad-cron', '/tmp/config.yaml')).toThrow(
      'Invalid cron expression: bad-cron',
    );
    expect(mockValidate).toHaveBeenCalledWith('bad-cron');
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('should call cron.schedule with valid expression', () => {
    mockValidate.mockReturnValue(true);
    const mockTask = fakeTask();
    mockSchedule.mockReturnValue(mockTask);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const task = scheduler.startScheduler('0 6 * * *', '/tmp/config.yaml');

    expect(mockValidate).toHaveBeenCalledWith('0 6 * * *');
    expect(mockSchedule).toHaveBeenCalledWith('0 6 * * *', expect.any(Function));
    expect(task).toBe(mockTask);

    consoleSpy.mockRestore();
  });

  it('should log schedule details', () => {
    mockValidate.mockReturnValue(true);
    mockSchedule.mockReturnValue(fakeTask());

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    scheduler.startScheduler('30 7 * * 1-5', '/home/user/config.yaml');

    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logs).toContainEqual(expect.stringContaining('30 7 * * 1-5'));
    expect(logs).toContainEqual(expect.stringContaining('/home/user/config.yaml'));

    consoleSpy.mockRestore();
  });

  it('should invoke runGeneration when cron callback fires', () => {
    mockValidate.mockReturnValue(true);
    mockRunPipeline.mockResolvedValue(OK_RUN);
    mockLoadConfig.mockReturnValue({ model: 'test' });

    let cronCallback: (() => void) | undefined;
    mockSchedule.mockImplementation((_expr: string, cb: () => void) => {
      cronCallback = cb;
      return fakeTask();
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    scheduler.startScheduler('0 6 * * *', '/tmp/config.yaml');
    expect(cronCallback).toBeDefined();

    // Fire the cron callback — it calls runGeneration internally
    cronCallback!();

    expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/config.yaml');

    consoleSpy.mockRestore();
  });

  it('should handle errors in cron callback via .catch', async () => {
    mockValidate.mockReturnValue(true);
    mockLoadConfig.mockImplementation(() => {
      throw new Error('config broke');
    });

    let cronCallback: (() => void) | undefined;
    mockSchedule.mockImplementation((_expr: string, cb: () => void) => {
      cronCallback = cb;
      return fakeTask();
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    scheduler.startScheduler('0 6 * * *', '/tmp/config.yaml');
    expect(cronCallback).toBeDefined();

    // Fire the cron callback — runGeneration will fail but the .catch should handle it
    cronCallback!();

    // Give the async .catch a tick to settle
    await new Promise((r) => setTimeout(r, 50));

    // The error should be caught by runGeneration's try/catch, not the outer .catch
    // But the outer .catch on line 47 handles truly unhandled rejections
    expect(consoleErrorSpy).toHaveBeenCalledWith('[scheduler] Run failed:', expect.any(Error));

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('runGeneration', () => {
  it('should call loadConfig and runPipeline, printing by default', async () => {
    const mockConfig = { model: 'claude-sonnet-4-20250514', output_dir: '/tmp' };
    mockLoadConfig.mockReturnValue(mockConfig);
    mockRunPipeline.mockResolvedValue(OK_RUN);
    delete process.env.PRINT_BRIEF;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/config.yaml');
    // Default: print (preview false) so the container matches a host cron.
    expect(mockRunPipeline).toHaveBeenCalledWith(mockConfig, {
      preview: false,
      trigger: 'scheduled',
    });

    consoleSpy.mockRestore();
  });

  it('should skip printing (preview) when PRINT_BRIEF=false', async () => {
    const mockConfig = { model: 'test', output_dir: '/tmp' };
    mockLoadConfig.mockReturnValue(mockConfig);
    mockRunPipeline.mockResolvedValue(OK_RUN);
    process.env.PRINT_BRIEF = 'false';

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(mockRunPipeline).toHaveBeenCalledWith(mockConfig, {
      preview: true,
      trigger: 'scheduled',
    });

    delete process.env.PRINT_BRIEF;
    consoleSpy.mockRestore();
  });

  it('should log start and completion messages', async () => {
    mockLoadConfig.mockReturnValue({});
    mockRunPipeline.mockResolvedValue(OK_RUN);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    const logs = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logs.some((l) => l.includes('Starting scheduled generation'))).toBe(true);
    expect(logs.some((l) => l.includes('brief: written, print: printed'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('should handle errors gracefully without throwing', async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('config not found');
    });

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Should not throw
    await scheduler.runGeneration('/bad/path.yaml');

    expect(consoleErrorSpy).toHaveBeenCalledWith('[scheduler] Run failed:', expect.any(Error));

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should handle runPipeline rejection gracefully', async () => {
    mockLoadConfig.mockReturnValue({});
    mockRunPipeline.mockRejectedValue(new Error('API down'));

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(consoleErrorSpy).toHaveBeenCalledWith('[scheduler] Run failed:', expect.any(Error));

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should reset running state after error', async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('boom');
    });

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    // running should be reset to false, so isGenerating returns false
    expect(scheduler.isGenerating()).toBe(false);

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should skip pipeline when on vacation', async () => {
    mockLoadConfig.mockReturnValue({
      vacation: [{ start: '2026-04-22', end: '2026-05-04' }],
    });
    mockRunPipeline.mockResolvedValue(OK_RUN);

    // Pin "today" to a vacation date via TZ-stable Date mock
    const realNow = Date.now;
    Date.now = () => new Date('2026-04-25T12:00:00Z').getTime();
    const realDate = global.Date;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.Date = class extends realDate {
      constructor(...args: ConstructorParameters<typeof realDate>) {
        if (args.length === 0) super('2026-04-25T12:00:00Z');
        else super(...args);
      }
    } as DateConstructor;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await scheduler.runGeneration('/tmp/config.yaml');
      expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/config.yaml');
      expect(mockRunPipeline).not.toHaveBeenCalled();
      const logs = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(logs.some((l) => l.includes('On vacation'))).toBe(true);
    } finally {
      Date.now = realNow;
      global.Date = realDate;
      consoleSpy.mockRestore();
    }
  });

  it('should run pipeline when vacation list does not cover today', async () => {
    mockLoadConfig.mockReturnValue({
      vacation: [{ start: '2026-04-22', end: '2026-05-04' }],
    });
    mockRunPipeline.mockResolvedValue(OK_RUN);

    const realDate = global.Date;
    global.Date = class extends realDate {
      constructor(...args: ConstructorParameters<typeof realDate>) {
        if (args.length === 0) super('2026-05-05T12:00:00Z');
        else super(...args);
      }
    } as DateConstructor;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await scheduler.runGeneration('/tmp/config.yaml');
      expect(mockRunPipeline).toHaveBeenCalled();
    } finally {
      global.Date = realDate;
      consoleSpy.mockRestore();
    }
  });

  it('should prevent concurrent runs via mutex', async () => {
    // Create a deferred promise so we can control when runPipeline resolves
    let resolveFirst!: () => void;
    const firstRunPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    mockLoadConfig.mockReturnValue({});
    mockRunPipeline.mockReturnValue(firstRunPromise.then(() => OK_RUN));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Start first run (will hang on the pipeline)
    const run1 = scheduler.runGeneration('/tmp/config.yaml');

    // isGenerating should be true while running
    expect(scheduler.isGenerating()).toBe(true);

    // Second run should be skipped
    await scheduler.runGeneration('/tmp/config.yaml');

    // loadConfig should only have been called once (the second run was skipped)
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);

    // Verify skip message was logged
    const logs = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logs.some((l) => l.includes('already in progress'))).toBe(true);

    // Resolve first run
    resolveFirst();
    await run1;

    // Now running should be false again
    expect(scheduler.isGenerating()).toBe(false);

    consoleSpy.mockRestore();
  });
});

describe('isOnVacation', () => {
  it('returns false when no vacation config', () => {
    expect(scheduler.isOnVacation({}, '2026-05-01')).toBe(false);
  });

  it('returns false on empty array', () => {
    expect(scheduler.isOnVacation({ vacation: [] }, '2026-05-01')).toBe(false);
  });

  it('returns true on the start date (inclusive)', () => {
    expect(
      scheduler.isOnVacation(
        { vacation: [{ start: '2026-04-22', end: '2026-05-04' }] },
        '2026-04-22',
      ),
    ).toBe(true);
  });

  it('returns true on the end date (inclusive)', () => {
    expect(
      scheduler.isOnVacation(
        { vacation: [{ start: '2026-04-22', end: '2026-05-04' }] },
        '2026-05-04',
      ),
    ).toBe(true);
  });

  it('returns true mid-range', () => {
    expect(
      scheduler.isOnVacation(
        { vacation: [{ start: '2026-04-22', end: '2026-05-04' }] },
        '2026-04-28',
      ),
    ).toBe(true);
  });

  it('returns false the day before start', () => {
    expect(
      scheduler.isOnVacation(
        { vacation: [{ start: '2026-04-22', end: '2026-05-04' }] },
        '2026-04-21',
      ),
    ).toBe(false);
  });

  it('returns false the day after end', () => {
    expect(
      scheduler.isOnVacation(
        { vacation: [{ start: '2026-04-22', end: '2026-05-04' }] },
        '2026-05-05',
      ),
    ).toBe(false);
  });

  it('handles multiple ranges', () => {
    const config = {
      vacation: [
        { start: '2026-04-22', end: '2026-05-04' },
        { start: '2026-05-08', end: '2026-05-25' },
      ],
    };
    expect(scheduler.isOnVacation(config, '2026-05-06')).toBe(false);
    expect(scheduler.isOnVacation(config, '2026-05-08')).toBe(true);
    expect(scheduler.isOnVacation(config, '2026-05-20')).toBe(true);
    expect(scheduler.isOnVacation(config, '2026-05-26')).toBe(false);
  });

  it('skips malformed range entries', () => {
    const config = {
      vacation: [
        { start: '', end: '2026-05-04' } as { start: string; end: string },
        { start: '2026-04-22', end: '2026-05-04' },
      ],
    };
    expect(scheduler.isOnVacation(config, '2026-04-25')).toBe(true);
    expect(scheduler.isOnVacation(config, '2026-04-15')).toBe(false);
  });

  it('uses today in TZ when no date passed', () => {
    // Just verify it doesn't throw and returns a boolean for an empty config
    expect(typeof scheduler.isOnVacation({})).toBe('boolean');
  });
});

// ── Catch-up ─────────────────────────────────────────────────────────────────

/** A task that fires at 04:00 local time every day. */
const at4am = (d: Date) => d.getHours() === 4 && d.getMinutes() === 0;

/** Let a chain of resolved promises settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('catchupHours', () => {
  afterEach(() => {
    delete process.env.CATCHUP_HOURS;
  });

  it('defaults to six hours', () => {
    expect(scheduler.catchupHours()).toBe(scheduler.DEFAULT_CATCHUP_HOURS);
  });

  it('reads CATCHUP_HOURS, including 0 to disable', () => {
    process.env.CATCHUP_HOURS = '2';
    expect(scheduler.catchupHours()).toBe(2);
    process.env.CATCHUP_HOURS = '0';
    expect(scheduler.catchupHours()).toBe(0);
  });

  it('ignores nonsense and negatives', () => {
    for (const bad of ['abc', '-1', '  ']) {
      process.env.CATCHUP_HOURS = bad;
      expect(scheduler.catchupHours()).toBe(scheduler.DEFAULT_CATCHUP_HOURS);
    }
  });
});

describe('lastOccurrence', () => {
  it('finds the most recent matching minute within the window', () => {
    const now = new Date(2026, 9, 14, 9, 17, 42);
    const occ = scheduler.lastOccurrence({ match: at4am }, now, 6);
    expect(occ).toEqual(new Date(2026, 9, 14, 4, 0, 0));
  });

  it('counts the current minute', () => {
    const now = new Date(2026, 9, 14, 4, 0, 30);
    expect(scheduler.lastOccurrence({ match: at4am }, now, 1)).toEqual(
      new Date(2026, 9, 14, 4, 0, 0),
    );
  });

  it('returns null when nothing matched inside the window', () => {
    const now = new Date(2026, 9, 14, 11, 0);
    expect(scheduler.lastOccurrence({ match: at4am }, now, 6)).toBeNull();
  });
});

describe('catchUpIfDue', () => {
  let logSpy: ReturnType<typeof jest.spyOn>;
  let errSpy: ReturnType<typeof jest.spyOn>;
  const task = { match: at4am };
  const morning = new Date(2026, 9, 14, 9, 0);

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadConfig.mockReturnValue({ output_dir: '/tmp/out' });
    mockRunPipeline.mockResolvedValue(OK_RUN);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.CATCHUP_HOURS;
  });

  it('runs a catch-up when the scheduled time passed with no brief', async () => {
    const ran = await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning);

    expect(ran).toBe(true);
    expect(mockReadStatus).toHaveBeenCalledWith('/tmp/out');
    expect(mockRunPipeline).toHaveBeenCalledWith(expect.anything(), {
      preview: false,
      trigger: 'catch-up',
    });
  });

  it('does nothing when the scheduler already ran for that day', async () => {
    mockReadStatus.mockReturnValue({ lastScheduled: { date: '2026-10-14' } });

    expect(await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning)).toBe(false);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('does nothing once the catch-up window has passed', async () => {
    const afternoon = new Date(2026, 9, 14, 11, 30);
    expect(await scheduler.catchUpIfDue(task, '/tmp/config.yaml', afternoon)).toBe(false);
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it('can be turned off with CATCHUP_HOURS=0', async () => {
    process.env.CATCHUP_HOURS = '0';
    expect(await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning)).toBe(false);
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it('respects vacation', async () => {
    mockLoadConfig.mockReturnValue({
      output_dir: '/tmp/out',
      vacation: [{ start: '2026-10-10', end: '2026-10-20' }],
    });
    expect(await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning)).toBe(false);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('does not throw when the config cannot be loaded', async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('gone');
    });
    expect(await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning)).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('defaults the output directory', async () => {
    mockLoadConfig.mockReturnValue({});
    await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning);
    expect(mockReadStatus).toHaveBeenCalledWith('output');
  });

  it('does not start a second run while one is in progress', async () => {
    let release!: () => void;
    mockRunPipeline.mockReturnValue(new Promise((r) => (release = () => r(OK_RUN))));
    const first = scheduler.runGeneration('/tmp/config.yaml');

    expect(await scheduler.catchUpIfDue(task, '/tmp/config.yaml', morning)).toBe(false);

    release();
    await first;
  });
});

describe('startScheduler catch-up wiring', () => {
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(2026, 9, 14, 9, 0),
      doNotFake: ['nextTick', 'queueMicrotask'],
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockValidate.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({ output_dir: '/tmp/out' });
    mockRunPipeline.mockResolvedValue(OK_RUN);
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
  });

  it('catches up on start-up when the container came up after the scheduled time', async () => {
    mockSchedule.mockReturnValue(fakeTask({ match: at4am }));

    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');
    await flush();

    expect(mockRunPipeline).toHaveBeenCalledWith(expect.anything(), {
      preview: false,
      trigger: 'catch-up',
    });
  });

  it('runs the missed brief when node-cron reports a missed execution', async () => {
    // Already ran at start-up today? No — the status says yesterday.
    mockReadStatus.mockReturnValue({ lastScheduled: { date: '2026-10-13' } });
    const handlers: Record<string, (ctx: { date: Date }) => void> = {};
    mockSchedule.mockReturnValue(
      fakeTask({
        match: at4am,
        on: jest.fn((event: string, fn: (ctx: { date: Date }) => void) => {
          handlers[event] = fn;
        }),
      }),
    );

    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');
    await flush();
    mockRunPipeline.mockClear();
    // The start-up check ran it; pretend that run never recorded itself.
    handlers['execution:missed']({ date: new Date(2026, 9, 14, 4, 0) });
    await flush();

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('missed the run due at'))).toBe(true);
  });

  it('re-checks from a watchdog timer', async () => {
    const match = jest.fn(() => false);
    mockSchedule.mockReturnValue(fakeTask({ match }));

    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');
    await flush();
    const afterStartup = match.mock.calls.length;

    jest.advanceTimersByTime(15 * 60_000);
    await flush();

    expect(match.mock.calls.length).toBeGreaterThan(afterStartup);
  });

  it('logs, rather than throws, when a catch-up check fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSchedule.mockReturnValue(
      fakeTask({
        match: () => {
          throw new Error('matcher broke');
        },
      }),
    );

    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');
    await flush();

    expect(errSpy).toHaveBeenCalledWith(
      '[scheduler] Catch-up after start-up failed:',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('remembers the config path it was started with', () => {
    mockSchedule.mockReturnValue(fakeTask());
    scheduler.startScheduler('0 4 * * *', '/etc/callsheet.yaml');
    expect(scheduler.schedulerConfigPath()).toBe('/etc/callsheet.yaml');
  });
});

describe('expectedRunDate', () => {
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockValidate.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({});
    // These tests start a scheduler with a real clock; keep its start-up
    // catch-up out of the way so the outcome cannot depend on the time of day.
    process.env.CATCHUP_HOURS = '0';
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.CATCHUP_HOURS;
  });

  it('is null when no scheduler is running', () => {
    expect(scheduler.expectedRunDate({}, new Date(2026, 9, 14, 9, 0))).toBeNull();
  });

  it("names today once today's run is past its grace period", () => {
    mockSchedule.mockReturnValue(fakeTask({ match: at4am }));
    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');

    expect(scheduler.expectedRunDate({}, new Date(2026, 9, 14, 9, 0))).toBe('2026-10-14');
  });

  it('names yesterday while today is still inside the grace period', () => {
    mockSchedule.mockReturnValue(fakeTask({ match: at4am }));
    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');

    expect(scheduler.expectedRunDate({}, new Date(2026, 9, 14, 5, 0))).toBe('2026-10-13');
  });

  it('is null on a vacation day', () => {
    mockSchedule.mockReturnValue(fakeTask({ match: at4am }));
    scheduler.startScheduler('0 4 * * *', '/tmp/config.yaml');

    expect(
      scheduler.expectedRunDate(
        { vacation: [{ start: '2026-10-14', end: '2026-10-14' }] },
        new Date(2026, 9, 14, 9, 0),
      ),
    ).toBeNull();
  });

  it('is null when the schedule has not fired in the last day', () => {
    mockSchedule.mockReturnValue(fakeTask({ match: () => false }));
    scheduler.startScheduler('0 4 1 1 *', '/tmp/config.yaml');

    expect(scheduler.expectedRunDate({}, new Date(2026, 9, 14, 9, 0))).toBeNull();
  });
});
