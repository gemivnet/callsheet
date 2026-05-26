import { jest } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockValidate = jest.fn<(expr: string) => boolean>();
const mockSchedule = jest.fn<(expr: string, cb: () => void) => { stop: () => void }>();

jest.unstable_mockModule('node-cron', () => ({
  default: {
    validate: mockValidate,
    schedule: mockSchedule,
  },
}));

const mockLoadConfig = jest.fn<(path: string) => Record<string, unknown>>();
const mockRunPipeline = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule('../src/core.js', () => ({
  loadConfig: mockLoadConfig,
  runPipeline: mockRunPipeline,
}));

// Import after mocks
const scheduler = await import('../src/scheduler.js');

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
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
    const mockTask = { stop: jest.fn() };
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
    mockSchedule.mockReturnValue({ stop: jest.fn() });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    scheduler.startScheduler('30 7 * * 1-5', '/home/user/config.yaml');

    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logs).toContainEqual(expect.stringContaining('30 7 * * 1-5'));
    expect(logs).toContainEqual(expect.stringContaining('/home/user/config.yaml'));

    consoleSpy.mockRestore();
  });

  it('should invoke runGeneration when cron callback fires', () => {
    mockValidate.mockReturnValue(true);
    mockRunPipeline.mockResolvedValue(undefined);
    mockLoadConfig.mockReturnValue({ model: 'test' });

    let cronCallback: (() => void) | undefined;
    mockSchedule.mockImplementation((_expr: string, cb: () => void) => {
      cronCallback = cb;
      return { stop: jest.fn() };
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
      return { stop: jest.fn() };
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
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[scheduler] Generation failed:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('runGeneration', () => {
  it('should call loadConfig and runPipeline, printing by default', async () => {
    const mockConfig = { model: 'claude-sonnet-4-20250514', output_dir: '/tmp' };
    mockLoadConfig.mockReturnValue(mockConfig);
    mockRunPipeline.mockResolvedValue(undefined);
    delete process.env.PRINT_BRIEF;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/config.yaml');
    // Default: print (preview false) so the container matches a host cron.
    expect(mockRunPipeline).toHaveBeenCalledWith(mockConfig, { preview: false });

    consoleSpy.mockRestore();
  });

  it('should skip printing (preview) when PRINT_BRIEF=false', async () => {
    const mockConfig = { model: 'test', output_dir: '/tmp' };
    mockLoadConfig.mockReturnValue(mockConfig);
    mockRunPipeline.mockResolvedValue(undefined);
    process.env.PRINT_BRIEF = 'false';

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(mockRunPipeline).toHaveBeenCalledWith(mockConfig, { preview: true });

    delete process.env.PRINT_BRIEF;
    consoleSpy.mockRestore();
  });

  it('should log start and completion messages', async () => {
    mockLoadConfig.mockReturnValue({});
    mockRunPipeline.mockResolvedValue(undefined);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    const logs = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logs.some((l) => l.includes('Starting generation'))).toBe(true);
    expect(logs.some((l) => l.includes('Generation complete'))).toBe(true);

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

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[scheduler] Generation failed:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should handle runPipeline rejection gracefully', async () => {
    mockLoadConfig.mockReturnValue({});
    mockRunPipeline.mockRejectedValue(new Error('API down'));

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[scheduler] Generation failed:',
      expect.any(Error),
    );

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
    mockRunPipeline.mockResolvedValue(undefined);

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
    mockRunPipeline.mockResolvedValue(undefined);

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
    mockRunPipeline.mockReturnValue(firstRunPromise);

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
