import { jest } from '@jest/globals';
import type { CallsheetConfig, ConnectorResult, Brief } from '../src/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();
const mockReaddirSync = jest.fn<(...args: unknown[]) => string[]>();
const mockUnlinkSync = jest.fn();
const mockExecSync = jest.fn();

const fsMock = {
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  unlinkSync: mockUnlinkSync,
};

jest.unstable_mockModule('node:fs', () => ({
  ...fsMock,
  default: fsMock,
}));

jest.unstable_mockModule('fs', () => ({
  ...fsMock,
  default: fsMock,
}));

jest.unstable_mockModule('node:child_process', () => ({
  execSync: mockExecSync,
}));

jest.unstable_mockModule('js-yaml', () => ({
  default: {
    load: (content: string) => JSON.parse(content),
  },
}));

const mockLoadConnectors = jest.fn<(...args: unknown[]) => { connectors: unknown[]; initErrors: unknown[] }>()
  .mockReturnValue({ connectors: [], initErrors: [] });

jest.unstable_mockModule('../src/connectors/index.js', () => ({
  loadConnectors: mockLoadConnectors,
}));

const mockMessagesCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

const mockRenderPdf = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('/tmp/test.pdf');

jest.unstable_mockModule('../src/render.js', () => ({
  renderPdf: mockRenderPdf,
}));

const mockLogUsage = jest.fn();

jest.unstable_mockModule('../src/usage.js', () => ({
  logUsage: mockLogUsage,
}));

// Import after mocks
const core = await import('../src/core.js');

// Helper to create mock API responses with usage data
function mockApiResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('stripJsonCodeFences', () => {
  it('returns plain text unchanged', () => {
    expect(core.stripJsonCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(core.stripJsonCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences', () => {
    expect(core.stripJsonCodeFences('```\n[1,2,3]\n```')).toBe('[1,2,3]');
  });

  it('strips fences with surrounding whitespace', () => {
    expect(core.stripJsonCodeFences('   ```json\n{"a":1}\n```   ')).toBe('{"a":1}');
  });

  it('strips fences without trailing newline before closing fence', () => {
    expect(core.stripJsonCodeFences('```json\n{"a":1}```')).toBe('{"a":1}');
  });

  it('handles multiline JSON inside fences', () => {
    const multiline = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
    expect(core.stripJsonCodeFences(multiline)).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('returns trimmed text when no fences present', () => {
    expect(core.stripJsonCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('strips fences when the model adds trailing commentary', () => {
    // Real-world failure mode observed in auto-close: the model emits the
    // fenced JSON and then a sentence of commentary, which used to break
    // the anchored regex and trip JSON.parse on the leading backtick.
    const input = '```json\n[]\n```\n\nNo tasks qualify for auto-close today.';
    expect(core.stripJsonCodeFences(input)).toBe('[]');
  });

  it('strips fences when the model adds leading commentary', () => {
    const input = "Here's the JSON you asked for:\n```json\n[1,2,3]\n```";
    expect(core.stripJsonCodeFences(input)).toBe('[1,2,3]');
  });
});

describe('resolveWeeklyReviewDay', () => {
  it('returns null for undefined', () => {
    expect(core.resolveWeeklyReviewDay(undefined)).toBeNull();
  });

  it('returns the same number for a valid 0-6 input', () => {
    expect(core.resolveWeeklyReviewDay(0)).toBe(0);
    expect(core.resolveWeeklyReviewDay(6)).toBe(6);
  });

  it('returns null for out-of-range numbers', () => {
    expect(core.resolveWeeklyReviewDay(7)).toBeNull();
    expect(core.resolveWeeklyReviewDay(-1)).toBeNull();
  });

  it('parses lowercase day names', () => {
    expect(core.resolveWeeklyReviewDay('sunday')).toBe(0);
    expect(core.resolveWeeklyReviewDay('saturday')).toBe(6);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(core.resolveWeeklyReviewDay('  Saturday  ')).toBe(6);
    expect(core.resolveWeeklyReviewDay('THURSDAY')).toBe(4);
  });

  it('returns null for unrecognized strings', () => {
    expect(core.resolveWeeklyReviewDay('funday')).toBeNull();
  });
});

describe('isWeeklyReviewDay', () => {
  it('returns false when no weekly_review_day is configured', () => {
    expect(core.isWeeklyReviewDay({}, new Date('2026-04-11T12:00:00'))).toBe(false);
  });

  it('returns true when today matches the configured day name', () => {
    // 2026-04-11 is a Saturday in local time
    const sat = new Date(2026, 3, 11, 12, 0, 0);
    expect(core.isWeeklyReviewDay({ weekly_review_day: 'saturday' }, sat)).toBe(true);
  });

  it('returns false when today does not match the configured day', () => {
    const fri = new Date(2026, 3, 10, 12, 0, 0);
    expect(core.isWeeklyReviewDay({ weekly_review_day: 'saturday' }, fri)).toBe(false);
  });

  it('accepts numeric day-of-week', () => {
    const sat = new Date(2026, 3, 11, 12, 0, 0);
    expect(core.isWeeklyReviewDay({ weekly_review_day: 6 }, sat)).toBe(true);
  });
});

describe('withWeeklyReviewOverrides', () => {
  it('returns the input unchanged when not a review day', () => {
    const cfg: CallsheetConfig = {
      weekly_review_day: 'saturday',
      connectors: { google_calendar: { enabled: true, lookback_days: 0 } },
    };
    // Force a non-Saturday by using Friday 2026-04-10
    const realDate = Date;
    const fixedNow = new realDate(2026, 3, 10, 12, 0, 0);
    const SpyDate = class extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(fixedNow);
          return;
        }
        // @ts-expect-error spread into Date ctor
        super(...args);
      }
      static now() {
        return fixedNow.getTime();
      }
    } as DateConstructor;
    global.Date = SpyDate;
    try {
      expect(core.withWeeklyReviewOverrides(cfg)).toBe(cfg);
    } finally {
      global.Date = realDate;
    }
  });

  it('bumps calendar lookback to 7 on review days when calendar is enabled', () => {
    const cfg: CallsheetConfig = {
      weekly_review_day: 'saturday',
      connectors: {
        google_calendar: { enabled: true, lookback_days: 0 },
        weather: { enabled: true },
      },
    };
    const realDate = Date;
    const sat = new realDate(2026, 3, 11, 12, 0, 0);
    const SpyDate = class extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(sat);
          return;
        }
        // @ts-expect-error spread into Date ctor
        super(...args);
      }
      static now() {
        return sat.getTime();
      }
    } as DateConstructor;
    global.Date = SpyDate;
    try {
      const out = core.withWeeklyReviewOverrides(cfg);
      expect(out).not.toBe(cfg);
      expect(out.connectors?.google_calendar?.lookback_days).toBe(7);
      // Other connectors are untouched
      expect(out.connectors?.weather).toEqual({ enabled: true });
      // Original is not mutated
      expect(cfg.connectors?.google_calendar?.lookback_days).toBe(0);
    } finally {
      global.Date = realDate;
    }
  });

  it('does not bump lookback when calendar is disabled', () => {
    const cfg: CallsheetConfig = {
      weekly_review_day: 'saturday',
      connectors: { google_calendar: { enabled: false, lookback_days: 0 } },
    };
    const realDate = Date;
    const sat = new realDate(2026, 3, 11, 12, 0, 0);
    const SpyDate = class extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(sat);
          return;
        }
        // @ts-expect-error spread into Date ctor
        super(...args);
      }
      static now() {
        return sat.getTime();
      }
    } as DateConstructor;
    global.Date = SpyDate;
    try {
      expect(core.withWeeklyReviewOverrides(cfg)).toBe(cfg);
    } finally {
      global.Date = realDate;
    }
  });

  it('preserves an existing larger lookback', () => {
    const cfg: CallsheetConfig = {
      weekly_review_day: 'saturday',
      connectors: { google_calendar: { enabled: true, lookback_days: 14 } },
    };
    const realDate = Date;
    const sat = new realDate(2026, 3, 11, 12, 0, 0);
    const SpyDate = class extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(sat);
          return;
        }
        // @ts-expect-error spread into Date ctor
        super(...args);
      }
      static now() {
        return sat.getTime();
      }
    } as DateConstructor;
    global.Date = SpyDate;
    try {
      expect(core.withWeeklyReviewOverrides(cfg)).toBe(cfg);
    } finally {
      global.Date = realDate;
    }
  });
});

describe('loadConfig', () => {
  it('should load and parse a config file', () => {
    const mockConfig = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      printer: 'test-printer',
    });
    mockReadFileSync.mockReturnValue(mockConfig);

    const config = core.loadConfig('config.yaml');

    expect(mockReadFileSync).toHaveBeenCalledWith('config.yaml', 'utf-8');
    expect(config).toEqual({
      model: 'claude-sonnet-4-20250514',
      printer: 'test-printer',
    });
  });

  it('should throw error if config not found', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => core.loadConfig('missing.yaml')).toThrow('Config not found');
  });
});

describe('buildDataPayload', () => {
  it('should format connector results as JSON', () => {
    const results: ConnectorResult[] = [
      {
        source: 'weather',
        description: 'test',
        data: { temp: 72 },
        priorityHint: 'low',
      },
    ];
    const payload = core.buildDataPayload(results);
    const parsed = JSON.parse(payload);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].source).toBe('weather');
    expect(parsed[0].data.temp).toBe(72);
    expect(parsed[0].priority).toBe('low');
  });

  it('should handle empty results', () => {
    const payload = core.buildDataPayload([]);
    expect(JSON.parse(payload)).toEqual([]);
  });

  it('should include description in payload', () => {
    const results: ConnectorResult[] = [
      {
        source: 'test',
        description: 'Very important data',
        data: {},
        priorityHint: 'high',
      },
    ];
    const payload = core.buildDataPayload(results);
    const parsed = JSON.parse(payload);
    expect(parsed[0].description).toBe('Very important data');
  });
});

describe('saveDataPayload', () => {
  it('should write data to connector_data file', () => {
    const path = core.saveDataPayload('{"test": true}', '/tmp/output');

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/output', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(path).toMatch(/connector_data_\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('should use the current date in filename', () => {
    const today = new Date().toISOString().slice(0, 10);
    const path = core.saveDataPayload('{}', '/tmp/out');
    expect(path).toContain(`connector_data_${today}.json`);
  });
});

describe('saveBrief', () => {
  it('should write brief JSON to output dir', () => {
    const brief: Brief = {
      title: 'Test Brief',
      sections: [{ heading: 'Test', items: [] }],
    };
    const path = core.saveBrief(brief, '/tmp/output');

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/output', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(path).toMatch(/callsheet_\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('should write valid JSON', () => {
    const brief: Brief = {
      title: 'Brief',
      sections: [{ heading: 'Section', body: 'Content' }],
    };
    core.saveBrief(brief, '/tmp');

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.title).toBe('Brief');
  });
});

describe('printPdf', () => {
  it('should call lp with correct printer and path', () => {
    core.printPdf('/tmp/test.pdf', 'Brother_HL');

    expect(mockExecSync).toHaveBeenCalledWith('lp -d "Brother_HL" "/tmp/test.pdf"', {
      stdio: 'inherit',
    });
  });

  it('should properly quote paths with spaces', () => {
    core.printPdf('/tmp/my brief.pdf', 'My Printer');

    expect(mockExecSync).toHaveBeenCalledWith('lp -d "My Printer" "/tmp/my brief.pdf"', {
      stdio: 'inherit',
    });
  });
});

describe('fetchAll', () => {
  it('should return results from successful connectors', async () => {
    mockLoadConnectors.mockReturnValue({ connectors: [
      {
        name: 'test',
        description: 'test connector',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
          source: 'test',
          description: 'test',
          data: {},
          priorityHint: 'normal',
        }),
      },
    ], initErrors: [] });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('test');
    expect(issues).toHaveLength(0);
  });

  it('should capture connector errors as issues', async () => {
    mockLoadConnectors.mockReturnValue({ connectors: [
      {
        name: 'broken',
        description: 'broken connector',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockRejectedValue(new Error('connection timeout')),
      },
    ], initErrors: [] });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].connector).toBe('broken');
    expect(issues[0].error).toBe('connection timeout');
  });

  it('should handle mixed success and failure', async () => {
    mockLoadConnectors.mockReturnValue({ connectors: [
      {
        name: 'good',
        description: 'works',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
          source: 'good',
          description: 'ok',
          data: { value: 1 },
          priorityHint: 'normal',
        }),
      },
      {
        name: 'bad',
        description: 'fails',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockRejectedValue(new Error('oops')),
      },
    ], initErrors: [] });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it('should handle non-Error thrown values', async () => {
    mockLoadConnectors.mockReturnValue({ connectors: [
      {
        name: 'weird',
        description: 'throws string',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockRejectedValue('string error'),
      },
    ], initErrors: [] });

    const { issues } = await core.fetchAll({ connectors: {} });
    expect(issues[0].error).toBe('string error');
  });

  it('should include init errors in issues', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [],
      initErrors: [{ connector: 'broken_init', error: 'Init failed: missing config' }],
    });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].connector).toBe('broken_init');
    expect(issues[0].error).toContain('Init failed');
  });

  it('should run connectors in parallel, not sequentially', async () => {
    // Each connector takes 100ms. Sequentially this would take ~300ms;
    // in parallel it should take ~100ms. We allow generous slack to avoid
    // flakiness on slow CI but still catch a regression to sequential.
    const slow = (name: string) => ({
      name,
      description: name,
      fetch: jest.fn<() => Promise<ConnectorResult>>().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  source: name,
                  description: name,
                  data: {},
                  priorityHint: 'normal',
                }),
              100,
            ),
          ),
      ),
    });

    mockLoadConnectors.mockReturnValue({
      connectors: [slow('a'), slow('b'), slow('c')],
      initErrors: [],
    });

    const start = Date.now();
    const { results } = await core.fetchAll({ connectors: {} });
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(3);
    // Sequential would be >=300ms; parallel should be well under 250ms.
    expect(elapsed).toBeLessThan(250);
  });

  it('should preserve connector order in results regardless of completion order', async () => {
    const fast = {
      name: 'fast',
      description: 'fast',
      fetch: jest.fn<() => Promise<ConnectorResult>>().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  source: 'fast',
                  description: 'fast',
                  data: {},
                  priorityHint: 'normal',
                }),
              10,
            ),
          ),
      ),
    };
    const slow = {
      name: 'slow',
      description: 'slow',
      fetch: jest.fn<() => Promise<ConnectorResult>>().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  source: 'slow',
                  description: 'slow',
                  data: {},
                  priorityHint: 'normal',
                }),
              80,
            ),
          ),
      ),
    };

    mockLoadConnectors.mockReturnValue({ connectors: [slow, fast], initErrors: [] });

    const { results } = await core.fetchAll({ connectors: {} });
    expect(results.map((r) => r.source)).toEqual(['slow', 'fast']);
  });

  it('should abandon a connector that exceeds the deadline', async () => {
    const hanging = {
      name: 'hanging',
      description: 'never resolves',
      fetch: jest
        .fn<() => Promise<ConnectorResult>>()
        .mockImplementation(() => new Promise(() => {})),
    };
    mockLoadConnectors.mockReturnValue({ connectors: [hanging], initErrors: [] });

    const { results, issues } = await core.fetchAll({
      connectors: {},
      connector_timeout_ms: 50,
    });

    expect(results).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].connector).toBe('hanging');
    expect(issues[0].error).toMatch(/deadline/);
  });

  it('should not let one timeout block other connectors', async () => {
    const hanging = {
      name: 'hanging',
      description: 'never resolves',
      fetch: jest
        .fn<() => Promise<ConnectorResult>>()
        .mockImplementation(() => new Promise(() => {})),
    };
    const fast = {
      name: 'fast',
      description: 'fast',
      fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
        source: 'fast',
        description: 'fast',
        data: {},
        priorityHint: 'normal',
      }),
    };

    mockLoadConnectors.mockReturnValue({ connectors: [hanging, fast], initErrors: [] });

    const { results, issues } = await core.fetchAll({
      connectors: {},
      connector_timeout_ms: 50,
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('fast');
    expect(issues).toHaveLength(1);
    expect(issues[0].connector).toBe('hanging');
  });
});

describe('saveMemory', () => {
  const mockClient = { messages: { create: mockMessagesCreate } } as never;

  it('should save memory file when insights are generated', async () => {
    mockMessagesCreate.mockResolvedValue(
      mockApiResponse('["Package arriving tomorrow", "Bill due Friday"]'),
    );
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.insights).toHaveLength(2);
    expect(parsed.insights[0]).toBe('Package arriving tomorrow');
  });

  it('should not save when no insights are generated', async () => {
    mockMessagesCreate.mockResolvedValue(mockApiResponse('[]'));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    // mkdirSync is called for the memory dir, but writeFileSync should not be called
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should prune old memory files beyond 7 days', async () => {
    mockMessagesCreate.mockResolvedValue(mockApiResponse('["insight"]'));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'memory_2026-03-18.json',
      'memory_2026-03-19.json',
      'memory_2026-03-20.json',
      'memory_2026-03-21.json',
      'memory_2026-03-22.json',
      'memory_2026-03-23.json',
      'memory_2026-03-24.json',
      'memory_2026-03-25.json',
    ]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    // Should delete the oldest file to keep at most 7
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('should handle API errors gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockMessagesCreate.mockRejectedValue(new Error('API rate limit'));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    // Should not throw, just log warning
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should strip code fences from API response', async () => {
    mockMessagesCreate.mockResolvedValue(
      mockApiResponse('```json\n["fenced insight"]\n```'),
    );
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    expect(mockWriteFileSync).toHaveBeenCalled();
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(parsed.insights).toEqual(['fenced insight']);
  });
});

describe('critiqueBrief', () => {
  const mockClient = { messages: { create: mockMessagesCreate } } as never;
  const sampleBrief: Brief = {
    title: 'Test Brief',
    sections: [{ heading: 'Tasks', items: [{ label: 'Do something' }] }],
  };

  it('should return issues from critique', async () => {
    mockMessagesCreate.mockResolvedValue(
      mockApiResponse('["Duplicate item in tasks and exec brief"]'),
    );
    mockExistsSync.mockReturnValue(false);

    const issues = await core.critiqueBrief(mockClient, sampleBrief, '{}', '/tmp/output');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Duplicate');
  });

  it('should save critique to feedback dir', async () => {
    mockMessagesCreate.mockResolvedValue(mockApiResponse('["Too verbose"]'));

    const issues = await core.critiqueBrief(mockClient, sampleBrief, '{}', '/tmp/output');

    expect(issues).toEqual(['Too verbose']);
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writtenPath).toContain('critique_');
  });

  it('should return empty array when no issues found', async () => {
    mockMessagesCreate.mockResolvedValue(mockApiResponse('[]'));

    const issues = await core.critiqueBrief(mockClient, sampleBrief, '{}', '/tmp/output');

    expect(issues).toEqual([]);
    // Should not write file when no issues
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should handle API failure gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockMessagesCreate.mockRejectedValue(new Error('Service unavailable'));

    const issues = await core.critiqueBrief(mockClient, sampleBrief, '{}', '/tmp/output');

    expect(issues).toEqual([]);
    consoleSpy.mockRestore();
  });
});

describe('generateBrief', () => {
  const minimalConfig: CallsheetConfig = {
    model: 'claude-sonnet-4-20250514',
    output_dir: '/tmp/output',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should generate and return a brief', async () => {
    const briefJson = JSON.stringify({
      title: 'Morning Brief',
      sections: [{ heading: 'Overview', body: 'All clear.' }],
    });

    // generateBrief calls messages.create 3 times: brief, memory, critique
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // main brief
      .mockResolvedValueOnce(mockApiResponse('["insight"]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')); // critique

    // Mock file system for prompt loading and memory/feedback
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'You are a morning brief generator.';
      if (p.includes('callsheet_')) return JSON.stringify({ title: 'Old', sections: [] });
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const brief = await core.generateBrief(minimalConfig, '{"data": "test"}');

    expect(brief.title).toBe('Morning Brief');
    expect(brief.sections).toHaveLength(1);
  });

  it('should strip code fences from brief response', async () => {
    const briefJson = JSON.stringify({
      title: 'Fenced Brief',
      sections: [],
    });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse('```json\n' + briefJson + '\n```'))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const brief = await core.generateBrief(minimalConfig, '{}');
    expect(brief.title).toBe('Fenced Brief');
  });

  it('should throw if ANTHROPIC_API_KEY not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(core.generateBrief(minimalConfig, '{}')).rejects.toThrow(
      'ANTHROPIC_API_KEY not set',
    );
  });

  it('should inject a Week in Review instruction on weekly_review_day', async () => {
    const briefJson = JSON.stringify({
      title: 'Saturday, April 11, 2026',
      sections: [{ heading: 'Week in Review', body: 'Short retrospective blurb.' }],
    });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    const readPaths: string[] = [];
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      readPaths.push(p);
      if (p.includes('system.md')) return 'Daily prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    // Pin "now" to a Saturday (2026-04-11)
    const realDate = Date;
    const sat = new realDate(2026, 3, 11, 9, 0, 0);
    const SpyDate = class extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(sat);
          return;
        }
        // @ts-expect-error spread into Date ctor
        super(...args);
      }
      static now() {
        return sat.getTime();
      }
    } as DateConstructor;
    global.Date = SpyDate;

    try {
      await core.generateBrief(
        { ...minimalConfig, weekly_review_day: 'saturday' },
        '{"data":"test"}',
      );
    } finally {
      global.Date = realDate;
    }

    // Week in Review is a supplemental section in the daily brief — system.md
    // is still the only prompt loaded, weekly.md does not exist anymore.
    expect(readPaths.some((p) => p.endsWith('system.md'))).toBe(true);
    expect(readPaths.some((p) => p.endsWith('weekly.md'))).toBe(false);

    // On Saturdays, the user message includes the injected Week in Review
    // blurb instruction — tight, supplemental, first section.
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { messages: { content: string }[] };
    const userMessage = opts.messages[0].content;
    expect(userMessage).toContain('Week in Review');
    expect(userMessage).toContain('VERY FIRST section');
    expect(userMessage).toContain('supplement, NOT a replacement');
  });

  it('should NOT inject Week in Review instruction on non-review days', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse('{"title":"Fri","sections":[]}'))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Daily prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    // Pin "now" to a Friday (2026-04-10)
    const realDate = Date;
    const fri = new realDate(2026, 3, 10, 9, 0, 0);
    const SpyDate = class extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(fri);
          return;
        }
        // @ts-expect-error spread into Date ctor
        super(...args);
      }
      static now() {
        return fri.getTime();
      }
    } as DateConstructor;
    global.Date = SpyDate;

    try {
      await core.generateBrief(
        { ...minimalConfig, weekly_review_day: 'saturday' },
        '{"data":"test"}',
      );
    } finally {
      global.Date = realDate;
    }

    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { messages: { content: string }[] };
    expect(opts.messages[0].content).not.toContain('Week in Review');
  });

  it('should include connector issues in context', async () => {
    const briefJson = JSON.stringify({ title: 'Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    await core.generateBrief(minimalConfig, '{}', [
      { connector: 'weather', error: 'timeout' },
    ]);

    // The system prompt (first arg of first call) should contain the issue
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('weather');
    expect(opts.system).toContain('timeout');
  });

  it('should retry on 529 overloaded errors', async () => {
    const briefJson = JSON.stringify({ title: 'Retry Brief', sections: [] });
    const overloadedError = Object.assign(new Error('Overloaded'), { status: 529 });

    mockMessagesCreate
      .mockRejectedValueOnce(overloadedError) // 1st attempt fails
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // 2nd attempt succeeds
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')); // critique

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const brief = await core.generateBrief(minimalConfig, '{}');
    expect(brief.title).toBe('Retry Brief');
    // Should have been called twice for the brief (retry) + memory + critique
    expect(mockMessagesCreate).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('should return error brief after all retries exhausted', async () => {
    const overloadedError = Object.assign(new Error('Overloaded'), { status: 529 });

    mockMessagesCreate.mockRejectedValue(overloadedError);

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const brief = await core.generateBrief(minimalConfig, '[]', [
      { connector: 'gmail', error: 'auth expired' },
    ]);

    expect(brief.subtitle).toContain('GENERATION FAILED');
    // Should include the connector issue
    const issuesSection = brief.sections.find((s) => s.heading === 'Issues During This Run');
    expect(issuesSection).toBeDefined();
    expect(issuesSection!.items![0].label).toBe('gmail');

    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
  }, 60_000);

  it('should not retry on non-retryable errors (e.g. 401)', async () => {
    const authError = Object.assign(new Error('Unauthorized'), { status: 401 });

    mockMessagesCreate.mockRejectedValue(authError);

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const brief = await core.generateBrief(minimalConfig, '[]');

    // Should not retry — only 1 call
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(brief.subtitle).toContain('GENERATION FAILED');

    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('should include memory context when memory files exist', async () => {
    const briefJson = JSON.stringify({
      title: 'Memory Brief',
      sections: [{ heading: 'Overview', body: 'All clear.' }],
    });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // brief
      .mockResolvedValueOnce(mockApiResponse('["new insight"]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')); // critique

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'You are a morning brief generator.';
      if (p.includes('memory_2026-03-27.json'))
        return JSON.stringify({
          date: '2026-03-27',
          insights: ['Package arriving tomorrow', 'Bill due Friday'],
        });
      return '{}';
    });

    // existsSync: memory dir exists, feedback dir doesn't, no previous brief, no auto-close dir, feedback.md doesn't exist
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/memory')) return true;
      if (p.includes('feedback.md')) return false;
      if (p.includes('/feedback')) return false;
      if (p.includes('/auto_close')) return false;
      if (p.includes('callsheet_')) return false;
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/memory')) return ['memory_2026-03-27.json'];
      return [];
    });

    const brief = await core.generateBrief(minimalConfig, '{"data": "test"}');
    expect(brief.title).toBe('Memory Brief');

    // The system prompt should contain memory context
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('Memory from previous briefs');
    expect(opts.system).toContain('Package arriving tomorrow');
  });

  it('should include feedback context when feedback.md and critiques exist', async () => {
    const briefJson = JSON.stringify({
      title: 'Feedback Brief',
      sections: [{ heading: 'Overview', body: 'All clear.' }],
    });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      if (p.includes('feedback.md')) return 'Be more concise. Use bullet points.';
      if (p.includes('critique_2026-03-27.json'))
        return JSON.stringify({
          date: '2026-03-27',
          issues: ['Too verbose in tasks section'],
        });
      return '{}';
    });

    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('feedback.md')) return true;
      if (p.includes('/feedback')) return true;
      if (p.includes('/memory')) return false;
      if (p.includes('/auto_close')) return false;
      if (p.includes('callsheet_')) return false;
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/feedback')) return ['critique_2026-03-27.json'];
      return [];
    });

    const brief = await core.generateBrief(minimalConfig, '{}');
    expect(brief.title).toBe('Feedback Brief');

    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('User feedback');
    expect(opts.system).toContain('Be more concise');
    expect(opts.system).toContain('Quality issues from recent briefs');
    expect(opts.system).toContain('Too verbose in tasks section');
  });

  it('should include previous brief diff context when yesterday brief exists', async () => {
    const briefJson = JSON.stringify({
      title: 'Diff Brief',
      sections: [{ heading: 'Overview', body: 'Changes today.' }],
    });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const previousBrief = {
      title: 'Yesterday Brief',
      sections: [
        {
          heading: 'Tasks',
          items: [
            { label: 'Buy groceries', note: 'From Costco', urgent: true },
            { label: 'Pay electric bill' },
          ],
        },
        { heading: 'Summary', body: 'A quiet day overall with no major issues.' },
      ],
    };

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      if (p.includes(`callsheet_${yesterdayStr}.json`)) return JSON.stringify(previousBrief);
      return '{}';
    });

    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes(`callsheet_${yesterdayStr}.json`)) return true;
      if (p.includes('feedback.md')) return false;
      if (p.includes('/memory')) return false;
      if (p.includes('/feedback')) return false;
      if (p.includes('/auto_close')) return false;
      return false;
    });

    mockReaddirSync.mockReturnValue([]);

    const brief = await core.generateBrief(minimalConfig, '{}');
    expect(brief.title).toBe('Diff Brief');

    // The user message should contain previous brief context
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { messages: { content: string }[] };
    expect(opts.messages[0].content).toContain('previous_brief');
    expect(opts.messages[0].content).toContain('Buy groceries');
    expect(opts.messages[0].content).toContain('[URGENT]');
    expect(opts.messages[0].content).toContain('A quiet day overall');
  });

  it('should run auto-close flow when config.auto_close_tasks is true', async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: {
        todoist: {
          accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
        },
      },
    };

    process.env.TODOIST_TOKEN_PERSON1 = 'fake-todoist-token';

    const briefJson = JSON.stringify({
      title: 'Auto-close Brief',
      sections: [{ heading: 'Overview', body: 'Tasks resolved.' }],
    });

    const autoCloseRecs = JSON.stringify([
      {
        task_id: '12345',
        task_content: 'Pay electric bill',
        person: 'Person1',
        reason: 'Payment confirmed via email',
      },
    ]);

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // brief
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')) // critique
      .mockResolvedValueOnce(mockApiResponse(autoCloseRecs)); // auto-close detection

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    // Mock global fetch for Todoist close API
    const mockFetch = jest.fn<(...args: unknown[]) => Promise<{ ok: boolean; status: number }>>()
      .mockResolvedValue({ ok: true, status: 204 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const brief = await core.generateBrief(autoCloseConfig, '{"todoist": "data"}');
      expect(brief.title).toBe('Auto-close Brief');

      // Verify Todoist close API was called
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toContain('tasks/12345/close');

      // Verify auto-close log was saved
      expect(mockWriteFileSync).toHaveBeenCalled();
      const autoCloseWriteCall = mockWriteFileSync.mock.calls.find(
        (call) => (call[0] as string).includes('auto_close'),
      );
      expect(autoCloseWriteCall).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TODOIST_TOKEN_PERSON1;
      consoleSpy.mockRestore();
    }
  });

  it('should handle auto-close with no matching token', async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: {
        todoist: {
          accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
        },
      },
    };

    // No token set in env

    const briefJson = JSON.stringify({
      title: 'No Token Brief',
      sections: [],
    });

    const autoCloseRecs = JSON.stringify([
      {
        task_id: '99999',
        task_content: 'Some task',
        person: 'Unknown', // no matching account
        reason: 'Resolved',
      },
    ]);

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse(autoCloseRecs));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const mockFetch = jest.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const brief = await core.generateBrief(autoCloseConfig, '{}');
      expect(brief.title).toBe('No Token Brief');
      // fetch should NOT have been called (no token)
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      consoleSpy.mockRestore();
    }
  });

  it('should include household context and extras in prompt', async () => {
    const configWithContext: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      context: {
        family: '2 adults, 1 dog',
        location: 'Portland, OR',
      },
      extras: [
        { name: 'Daily Quote', instruction: 'Include an inspiring quote.' },
      ],
    };

    const briefJson = JSON.stringify({ title: 'Context Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Base prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    await core.generateBrief(configWithContext, '{}');

    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('Household context');
    expect(opts.system).toContain('2 adults, 1 dog');
    expect(opts.system).toContain('Portland, OR');
    expect(opts.system).toContain('Extras');
    expect(opts.system).toContain('Daily Quote');
    expect(opts.system).toContain('inspiring quote');
  });

  it('should retry on 429 rate limit errors', async () => {
    const briefJson = JSON.stringify({ title: 'Rate Limited Brief', sections: [] });
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });

    mockMessagesCreate
      .mockRejectedValueOnce(rateLimitError) // 1st attempt fails
      .mockRejectedValueOnce(rateLimitError) // 2nd attempt fails
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // 3rd attempt succeeds
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')); // critique

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'Prompt';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const brief = await core.generateBrief(minimalConfig, '{}');
    expect(brief.title).toBe('Rate Limited Brief');
    // 3 attempts for brief + 1 memory + 1 critique = 5
    expect(mockMessagesCreate).toHaveBeenCalledTimes(5);
  }, 60_000);
});

describe('runtimeErrors', () => {
  it('should add and drain errors', () => {
    core.runtimeErrors.add('test_source', 'something broke', 'error');
    core.runtimeErrors.add('other_source', 'minor issue', 'warning');

    expect(core.runtimeErrors.length).toBe(2);

    const drained = core.runtimeErrors.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]).toEqual({
      source: 'test_source',
      error: 'something broke',
      severity: 'error',
    });
    expect(drained[1]).toEqual({
      source: 'other_source',
      error: 'minor issue',
      severity: 'warning',
    });

    // After drain, length should be 0
    expect(core.runtimeErrors.length).toBe(0);
  });

  it('should default severity to error', () => {
    core.runtimeErrors.add('src', 'msg');
    const drained = core.runtimeErrors.drain();
    expect(drained[0].severity).toBe('error');
  });

  it('should report length correctly as items are added', () => {
    expect(core.runtimeErrors.length).toBe(0);
    core.runtimeErrors.add('a', 'err1');
    expect(core.runtimeErrors.length).toBe(1);
    core.runtimeErrors.add('b', 'err2');
    expect(core.runtimeErrors.length).toBe(2);
    core.runtimeErrors.drain(); // clean up
  });

  it('should include runtime errors in connector issues context via generateBrief', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    // Add a runtime error before generating brief
    core.runtimeErrors.add('scheduler', 'Cron job delayed 5 minutes', 'warning');

    const briefJson = JSON.stringify({ title: 'Runtime Error Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const config: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
    };

    await core.generateBrief(config, '{}');

    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('scheduler');
    expect(opts.system).toContain('Cron job delayed');

    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe('runPipeline', () => {
  const pipelineConfig: CallsheetConfig = {
    model: 'claude-sonnet-4-20250514',
    output_dir: '/tmp/output',
    printer: 'Brother_HL',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  function setupPipelineMocks() {
    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'weather',
          description: 'Weather data',
          fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
            source: 'weather',
            description: 'Current weather',
            data: { temp: 65, conditions: 'sunny' },
            priorityHint: 'low' as const,
          }),
        },
      ],
      initErrors: [],
    });

    const briefJson = JSON.stringify({
      title: 'Pipeline Brief',
      sections: [{ heading: 'Weather', body: 'Sunny and 65°F.' }],
    });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // brief
      .mockResolvedValueOnce(mockApiResponse('["sunny day"]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')); // critique

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });

    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  }

  it('should run full pipeline with printing', async () => {
    setupPipelineMocks();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline(pipelineConfig);

    expect(result.brief.title).toBe('Pipeline Brief');
    expect(result.pdfPath).toBe('/tmp/test.pdf');
    expect(result.jsonPath).toMatch(/callsheet_.*\.json$/);
    expect(result.dataPath).toMatch(/connector_data_.*\.json$/);

    // Should have called lp for printing
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('lp -d "Brother_HL"'),
      { stdio: 'inherit' },
    );

    consoleSpy.mockRestore();
  });

  it('should skip printing in preview mode', async () => {
    setupPipelineMocks();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline(pipelineConfig, { preview: true });

    expect(result.brief.title).toBe('Pipeline Brief');
    // Should NOT have called lp
    expect(mockExecSync).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should skip printing when no printer configured', async () => {
    setupPipelineMocks();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const noPrinterConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
    };

    const result = await core.runPipeline(noPrinterConfig);

    expect(result.brief.title).toBe('Pipeline Brief');
    expect(mockExecSync).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should throw when no data is fetched', async () => {
    mockLoadConnectors.mockReturnValue({ connectors: [], initErrors: [] });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(core.runPipeline(pipelineConfig)).rejects.toThrow('No data fetched');

    consoleSpy.mockRestore();
  });

  it('should note connector issues in pipeline', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'weather',
          description: 'Weather',
          fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
            source: 'weather',
            description: 'Current weather',
            data: { temp: 65 },
            priorityHint: 'low' as const,
          }),
        },
      ],
      initErrors: [{ connector: 'gmail', error: 'Auth expired' }],
    });

    const briefJson = JSON.stringify({ title: 'Issues Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline({ ...pipelineConfig, printer: '' });
    expect(result.brief.title).toBe('Issues Brief');

    // Connector issues should have been passed to generateBrief
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('gmail');
    expect(opts.system).toContain('Auth expired');

    consoleSpy.mockRestore();
  });

  it('should generate error brief when API fails in pipeline', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'weather',
          description: 'Weather',
          fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
            source: 'weather',
            description: 'Weather',
            data: {},
            priorityHint: 'low' as const,
          }),
        },
      ],
      initErrors: [],
    });

    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
    mockMessagesCreate.mockRejectedValue(serverError);

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await core.runPipeline({ ...pipelineConfig, printer: '' });

    // Should have an error brief
    expect(result.brief.subtitle).toContain('GENERATION FAILED');
    expect(result.brief.sections[0].heading).toBe('Generation Error');
    expect(result.brief.sections[0].body).toContain('Internal Server Error');

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  }, 60_000);

  it('should handle corrupted memory files gracefully', async () => {
    setupPipelineMocks();

    // Override readFileSync to throw for memory files (covers line 134)
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      if (p.includes('memory_') && p.endsWith('.json')) throw new Error('corrupt JSON');
      return '{}';
    });
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/memory')) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/memory')) return ['memory_2026-03-27.json'];
      return [];
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline({ ...pipelineConfig, printer: '' });
    expect(result.brief).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('should handle corrupted critique files gracefully', async () => {
    setupPipelineMocks();

    // Override readFileSync to throw for critique files (covers line 303)
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      if (p.includes('critique_') && p.endsWith('.json')) throw new Error('corrupt JSON');
      return '{}';
    });
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/feedback')) return true;
      if (p.includes('feedback.md')) return false;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/feedback')) return ['critique_2026-03-27.json'];
      return [];
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline({ ...pipelineConfig, printer: '' });
    expect(result.brief).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('should throw when system prompt file is missing', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'weather',
          description: 'Weather',
          fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
            source: 'weather',
            description: 'Weather',
            data: {},
            priorityHint: 'low' as const,
          }),
        },
      ],
      initErrors: [],
    });

    // Make readFileSync throw for system.md (covers line 617)
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) throw new Error('ENOENT');
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    // loadPrompt is called before the try/catch, so it throws
    await expect(
      core.generateBrief(
        { model: 'claude-sonnet-4-20250514', output_dir: '/tmp/output' },
        '{}',
      ),
    ).rejects.toThrow('Prompt not found');
  });

  it('should include auto-close context from yesterday in prompt', async () => {
    const briefJson = JSON.stringify({ title: 'AutoClose Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      if (p.includes(`closed_${yesterdayStr}.json`))
        return JSON.stringify({
          date: yesterdayStr,
          closed: [
            { task_id: '123', task_content: 'Pay bill', person: 'Person1', reason: 'Payment confirmed' },
          ],
        });
      return '{}';
    });

    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('/auto_close')) return true;
      if (p.includes(`closed_${yesterdayStr}.json`)) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([]);

    const config: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
    };

    const brief = await core.generateBrief(config, '{}');
    expect(brief.title).toBe('AutoClose Brief');

    // The system prompt should contain auto-close context
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('Auto-closed tasks');
    expect(opts.system).toContain('Pay bill');
  });

  it('should include runtime errors in error brief', async () => {
    // Add a runtime error before generating
    core.runtimeErrors.add('test_pipeline', 'something broke', 'error');

    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'weather',
          description: 'Weather',
          fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
            source: 'weather',
            description: 'Weather',
            data: {},
            priorityHint: 'low' as const,
          }),
        },
      ],
      initErrors: [],
    });

    const nonRetryableError = Object.assign(new Error('Bad Request'), { status: 400 });
    mockMessagesCreate.mockRejectedValue(nonRetryableError);

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const brief = await core.generateBrief(
      { model: 'claude-sonnet-4-20250514', output_dir: '/tmp/output' },
      '{}',
      [{ connector: 'gmail', error: 'auth expired' }],
    );

    expect(brief.subtitle).toContain('GENERATION FAILED');
    const issuesSection = brief.sections.find((s) => s.heading === 'Issues During This Run');
    expect(issuesSection).toBeDefined();
    // Should contain both connector issue and runtime error
    expect(issuesSection!.items!.some((i) => i.label === 'gmail')).toBe(true);
    expect(issuesSection!.items!.some((i) => i.label === 'test_pipeline')).toBe(true);

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should log self-critique issue count when issues found', async () => {
    setupPipelineMocks();

    // Clear and re-set mockMessagesCreate to return critique issues
    mockMessagesCreate.mockReset();
    mockMessagesCreate
      .mockResolvedValueOnce(
        mockApiResponse(JSON.stringify({
          title: 'Critique Brief',
          sections: [{ heading: 'Weather', body: 'Sunny.' }],
        })),
      )
      .mockResolvedValueOnce(mockApiResponse('["insight"]')) // memory
      .mockResolvedValueOnce(mockApiResponse('["Too verbose", "Missing data"]')); // critique

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await core.runPipeline({ ...pipelineConfig, printer: '' });

    const logs = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logs.some((l) => l.includes('Self-critique: 2 issue(s)'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('should log "No tasks to auto-close" when detection returns empty', async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: { todoist: { accounts: [] } },
    };

    const briefJson = JSON.stringify({ title: 'No Close Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // brief
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')) // critique
      .mockResolvedValueOnce(mockApiResponse('[]')); // auto-close detection (empty)

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const brief = await core.generateBrief(autoCloseConfig, '{}');
    expect(brief.title).toBe('No Close Brief');

    const logs = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logs.some((l) => l.includes('No tasks to auto-close'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('should handle auto-close detection API failure gracefully', async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: { todoist: { accounts: [] } },
    };

    const briefJson = JSON.stringify({ title: 'Detection Fail Brief', sections: [] });

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson)) // brief
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')) // critique
      .mockRejectedValueOnce(new Error('API timeout')); // auto-close detection fails

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const brief = await core.generateBrief(autoCloseConfig, '{}');
    expect(brief.title).toBe('Detection Fail Brief');

    consoleSpy.mockRestore();
  });

  it('should handle Todoist close API failure gracefully', async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: {
        todoist: {
          accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
        },
      },
    };

    process.env.TODOIST_TOKEN_PERSON1 = 'fake-token';

    const briefJson = JSON.stringify({ title: 'Close Fail Brief', sections: [] });

    const autoCloseRecs = JSON.stringify([
      {
        task_id: '999',
        task_content: 'Close failing task',
        person: 'Person1',
        reason: 'Should be resolved',
      },
    ]);

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse(autoCloseRecs));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    // Mock fetch to throw a network error
    const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(new Error('Network error'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const brief = await core.generateBrief(autoCloseConfig, '{}');
      expect(brief.title).toBe('Close Fail Brief');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TODOIST_TOKEN_PERSON1;
      consoleSpy.mockRestore();
    }
  });

  it('should handle Todoist close API returning non-ok status', async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: {
        todoist: {
          accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
        },
      },
    };

    process.env.TODOIST_TOKEN_PERSON1 = 'fake-token';

    const briefJson = JSON.stringify({ title: 'Non-ok Close Brief', sections: [] });

    const autoCloseRecs = JSON.stringify([
      {
        task_id: '888',
        task_content: 'Non-ok close task',
        person: 'Person1',
        reason: 'Should fail',
      },
    ]);

    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse(autoCloseRecs));

    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'System prompt.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const mockFetch = jest.fn<(...args: unknown[]) => Promise<{ ok: boolean; status: number }>>()
      .mockResolvedValue({ ok: false, status: 403 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const brief = await core.generateBrief(autoCloseConfig, '{}');
      expect(brief.title).toBe('Non-ok Close Brief');
      // Should NOT save auto-close log since nothing was closed
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TODOIST_TOKEN_PERSON1;
      consoleSpy.mockRestore();
    }
  });
});
