import { jest } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockStartScheduler = jest.fn();
const mockStartServer = jest.fn();

jest.unstable_mockModule('dotenv/config', () => ({}));

jest.unstable_mockModule('../src/scheduler.js', () => ({
  startScheduler: mockStartScheduler,
}));

jest.unstable_mockModule('../src/server.js', () => ({
  startServer: mockStartServer,
}));

jest.unstable_mockModule('../src/cli.js', () => ({}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const originalEnv = process.env.MODE;
const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {
  // no-op — don't throw, just record the call
}) as never);

let consoleSpy: ReturnType<typeof jest.spyOn>;
let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the module registry so entrypoint.ts re-evaluates with fresh env
  jest.resetModules();
  // Re-register mocks after resetModules clears them
  jest.unstable_mockModule('dotenv/config', () => ({}));
  jest.unstable_mockModule('../src/scheduler.js', () => ({
    startScheduler: mockStartScheduler,
  }));
  jest.unstable_mockModule('../src/server.js', () => ({
    startServer: mockStartServer,
  }));
  jest.unstable_mockModule('../src/cli.js', () => ({}));

  consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Restore MODE to its original value (or delete it)
  if (originalEnv === undefined) {
    delete process.env.MODE;
  } else {
    process.env.MODE = originalEnv;
  }
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

afterAll(() => {
  mockExit.mockRestore();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('entrypoint', () => {
  it('should default to headless_local when MODE is not set', async () => {
    delete process.env.MODE;

    await import('../src/entrypoint.js');

    // headless_local imports cli.js — no scheduler or server calls
    expect(mockStartScheduler).not.toHaveBeenCalled();
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  it('should import cli.js in headless_local mode', async () => {
    process.env.MODE = 'headless_local';

    await import('../src/entrypoint.js');

    expect(mockStartScheduler).not.toHaveBeenCalled();
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  it('should call startScheduler in headless_docker mode', async () => {
    process.env.MODE = 'headless_docker';

    await import('../src/entrypoint.js');

    expect(mockStartScheduler).toHaveBeenCalledTimes(1);
    expect(mockStartScheduler).toHaveBeenCalledWith('30 6 * * *', 'config.yaml');
    expect(mockStartServer).not.toHaveBeenCalled();
  });

  it('should call startScheduler and startServer in headed_docker mode', async () => {
    process.env.MODE = 'headed_docker';

    await import('../src/entrypoint.js');
    // main() is async — give it a tick to complete the dynamic import
    await new Promise((r) => setTimeout(r, 50));

    expect(mockStartScheduler).toHaveBeenCalledTimes(1);
    expect(mockStartScheduler).toHaveBeenCalledWith('30 6 * * *', 'config.yaml');
    expect(mockStartServer).toHaveBeenCalledTimes(1);
  });

  it('should call process.exit(1) for unknown MODE', async () => {
    process.env.MODE = 'invalid_mode';

    await import('../src/entrypoint.js');

    // Give the async main().catch() a tick to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown MODE'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should respect custom CRON_SCHEDULE and CONFIG_PATH', async () => {
    process.env.MODE = 'headless_docker';
    process.env.CRON_SCHEDULE = '0 8 * * 1-5';
    process.env.CONFIG_PATH = '/etc/callsheet/custom.yaml';

    await import('../src/entrypoint.js');

    expect(mockStartScheduler).toHaveBeenCalledWith('0 8 * * 1-5', '/etc/callsheet/custom.yaml');

    // Clean up custom env vars
    delete process.env.CRON_SCHEDULE;
    delete process.env.CONFIG_PATH;
  });

  it('should handle fatal error in main() via catch handler', async () => {
    process.env.MODE = 'headed_docker';

    // Make startServer throw to trigger main().catch()
    jest.unstable_mockModule('../src/server.js', () => ({
      startServer: () => {
        throw new Error('Fatal server crash');
      },
    }));

    await import('../src/entrypoint.js');
    // Give async catch handler time to settle
    await new Promise((r) => setTimeout(r, 100));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[entrypoint] Fatal error:',
      expect.any(Error),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('should be case-insensitive for MODE', async () => {
    process.env.MODE = 'HEADLESS_DOCKER';

    await import('../src/entrypoint.js');

    expect(mockStartScheduler).toHaveBeenCalledTimes(1);
    expect(mockStartServer).not.toHaveBeenCalled();
  });
});
