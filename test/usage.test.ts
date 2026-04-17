import { jest } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();

const fsMock = {
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
};

jest.unstable_mockModule('node:fs', () => ({
  ...fsMock,
  default: fsMock,
}));

jest.unstable_mockModule('fs', () => ({
  ...fsMock,
  default: fsMock,
}));

// Import after mocks
const usage = await import('../src/usage.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Freeze time so timestamps and month strings are deterministic. */
function freezeTime(iso: string) {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(iso));
}

function restoreTime() {
  jest.useRealTimers();
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  restoreTime();
});

// ── logUsage ─────────────────────────────────────────────────────────────────

describe('logUsage', () => {
  it('should create usage directory with recursive flag', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    usage.logUsage('/out', 'claude-sonnet-4-20250514', 'brief', 1000, 500);

    expect(mockMkdirSync).toHaveBeenCalledWith('/out/usage', { recursive: true });
  });

  it('should create a new monthly file when none exists', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    usage.logUsage('/out', 'claude-sonnet-4-20250514', 'brief', 1000, 500);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(filePath).toBe('/out/usage/usage_2026-03.json');

    const written = JSON.parse(content) as { month: string; entries: unknown[] };
    expect(written.month).toBe('2026-03');
    expect(written.entries).toHaveLength(1);
  });

  it('should append to an existing monthly file', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    const existing = {
      month: '2026-03',
      entries: [
        {
          timestamp: '2026-03-14T08:00:00.000Z',
          model: 'claude-sonnet-4-20250514',
          purpose: 'brief',
          input_tokens: 500,
          output_tokens: 200,
          cost_usd: 0.0045,
        },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));

    usage.logUsage('/out', 'claude-sonnet-4-20250514', 'critique', 2000, 1000);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { month: string; entries: unknown[] };
    expect(written.entries).toHaveLength(2);
  });

  it('should calculate cost correctly for Sonnet model', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    // Sonnet: input $3/M, output $15/M
    // 1_000_000 input tokens -> $3, 500_000 output tokens -> $7.50
    usage.logUsage('/out', 'claude-sonnet-4-20250514', 'brief', 1_000_000, 500_000);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { entries: Array<{ cost_usd: number }> };
    expect(written.entries[0].cost_usd).toBeCloseTo(10.5, 5);
  });

  it('should calculate cost correctly for Opus model', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    // Opus: input $15/M, output $75/M
    // 100_000 input -> $1.50, 50_000 output -> $3.75
    usage.logUsage('/out', 'claude-opus-4-20250514', 'brief', 100_000, 50_000);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { entries: Array<{ cost_usd: number }> };
    expect(written.entries[0].cost_usd).toBeCloseTo(5.25, 5);
  });

  it('should calculate cost correctly for Opus 4.7 model', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    // Opus 4.7: input $15/M, output $75/M (same as Opus 4.0)
    usage.logUsage('/out', 'claude-opus-4-7', 'brief', 100_000, 50_000);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { entries: Array<{ cost_usd: number }> };
    expect(written.entries[0].cost_usd).toBeCloseTo(5.25, 5);
  });

  it('should calculate cost correctly for Haiku model', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    // Haiku: input $1/M, output $5/M
    // 200_000 input -> $0.20, 100_000 output -> $0.50
    usage.logUsage('/out', 'claude-haiku-4-5-20251001', 'memory', 200_000, 100_000);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { entries: Array<{ cost_usd: number }> };
    expect(written.entries[0].cost_usd).toBeCloseTo(0.7, 5);
  });

  it('should use default (Sonnet) pricing for unknown models', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    usage.logUsage('/out', 'claude-unknown-model', 'brief', 1_000_000, 1_000_000);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { entries: Array<{ cost_usd: number }> };
    // Default Sonnet pricing: (1M * 3 + 1M * 15) / 1M = 18
    expect(written.entries[0].cost_usd).toBeCloseTo(18, 5);
  });

  it('should store the correct entry fields', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    usage.logUsage('/out', 'claude-sonnet-4-20250514', 'auto_close', 400, 200);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { entries: Array<Record<string, unknown>> };
    const entry = written.entries[0];
    expect(entry.timestamp).toBe('2026-03-15T10:00:00.000Z');
    expect(entry.model).toBe('claude-sonnet-4-20250514');
    expect(entry.purpose).toBe('auto_close');
    expect(entry.input_tokens).toBe(400);
    expect(entry.output_tokens).toBe(200);
  });

  it('should create a fresh monthly object when existing file has corrupt JSON', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('NOT VALID JSON');

    usage.logUsage('/out', 'claude-sonnet-4-20250514', 'brief', 100, 50);

    const [, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(content) as { month: string; entries: unknown[] };
    expect(written.month).toBe('2026-03');
    expect(written.entries).toHaveLength(1);
  });
});

// ── getMonthlyUsageData ──────────────────────────────────────────────────────

describe('getMonthlyUsageData', () => {
  it('should read and parse an existing monthly file', () => {
    const data = {
      month: '2026-02',
      entries: [
        {
          timestamp: '2026-02-10T10:00:00.000Z',
          model: 'claude-sonnet-4-20250514',
          purpose: 'brief',
          input_tokens: 500,
          output_tokens: 200,
          cost_usd: 0.0045,
        },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(data));

    const result = usage.getMonthlyUsageData('/out', '2026-02');

    expect(result).toEqual(data);
    expect(mockReadFileSync).toHaveBeenCalledWith('/out/usage/usage_2026-02.json', 'utf-8');
  });

  it('should return empty entries when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = usage.getMonthlyUsageData('/out', '2026-01');

    expect(result).toEqual({ month: '2026-01', entries: [] });
  });

  it('should default to current month when month is not specified', () => {
    freezeTime('2026-03-15T10:00:00.000Z');
    mockExistsSync.mockReturnValue(false);

    const result = usage.getMonthlyUsageData('/out');

    expect(result).toEqual({ month: '2026-03', entries: [] });
  });

  it('should return empty entries when file has corrupt JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('BROKEN');

    const result = usage.getMonthlyUsageData('/out', '2026-02');

    expect(result).toEqual({ month: '2026-02', entries: [] });
  });
});

// ── getUsageSummary ──────────────────────────────────────────────────────────

describe('getUsageSummary', () => {
  it('should aggregate data correctly across multiple entries', () => {
    const data = {
      month: '2026-03',
      entries: [
        {
          timestamp: '2026-03-10T08:00:00.000Z',
          model: 'claude-sonnet-4-20250514',
          purpose: 'brief',
          input_tokens: 1000,
          output_tokens: 500,
          cost_usd: 0.01,
        },
        {
          timestamp: '2026-03-10T09:00:00.000Z',
          model: 'claude-sonnet-4-20250514',
          purpose: 'critique',
          input_tokens: 2000,
          output_tokens: 800,
          cost_usd: 0.02,
        },
        {
          timestamp: '2026-03-11T08:00:00.000Z',
          model: 'claude-opus-4-20250514',
          purpose: 'brief',
          input_tokens: 500,
          output_tokens: 300,
          cost_usd: 0.05,
        },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(data));

    const summary = usage.getUsageSummary('/out', '2026-03');

    expect(summary.month).toBe('2026-03');
    expect(summary.total_cost_usd).toBeCloseTo(0.08, 5);
    expect(summary.total_input_tokens).toBe(3500);
    expect(summary.total_output_tokens).toBe(1600);
    expect(summary.brief_count).toBe(2);
    expect(summary.total_api_calls).toBe(3);
    expect(summary.by_model).toEqual({
      'claude-sonnet-4-20250514': { calls: 2, cost: 0.03 },
      'claude-opus-4-20250514': { calls: 1, cost: 0.05 },
    });
  });

  it('should return zeros for an empty month', () => {
    mockExistsSync.mockReturnValue(false);

    const summary = usage.getUsageSummary('/out', '2026-01');

    expect(summary.month).toBe('2026-01');
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.total_input_tokens).toBe(0);
    expect(summary.total_output_tokens).toBe(0);
    expect(summary.brief_count).toBe(0);
    expect(summary.total_api_calls).toBe(0);
    expect(summary.by_model).toEqual({});
  });

  it('should correctly count only brief entries in brief_count', () => {
    const data = {
      month: '2026-03',
      entries: [
        { timestamp: '', model: 'm', purpose: 'brief', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        { timestamp: '', model: 'm', purpose: 'memory', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        { timestamp: '', model: 'm', purpose: 'critique', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        { timestamp: '', model: 'm', purpose: 'auto_close', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        { timestamp: '', model: 'm', purpose: 'brief', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(data));

    const summary = usage.getUsageSummary('/out', '2026-03');

    expect(summary.brief_count).toBe(2);
    expect(summary.total_api_calls).toBe(5);
  });
});
