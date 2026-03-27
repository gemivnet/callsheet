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
});

describe('runGeneration', () => {
  it('should call loadConfig and runPipeline', async () => {
    const mockConfig = { model: 'claude-sonnet-4-20250514', output_dir: '/tmp' };
    mockLoadConfig.mockReturnValue(mockConfig);
    mockRunPipeline.mockResolvedValue(undefined);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await scheduler.runGeneration('/tmp/config.yaml');

    expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/config.yaml');
    expect(mockRunPipeline).toHaveBeenCalledWith(mockConfig, { preview: true });

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
