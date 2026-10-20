import { jest } from '@jest/globals';
import type { CallsheetConfig, ConnectorResult, Brief } from '../src/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();
const mockReaddirSync = jest.fn<(...args: unknown[]) => string[]>();
const mockUnlinkSync = jest.fn();
const mockRenameSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockExecFileSync = jest.fn();

const fsMock = {
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  unlinkSync: mockUnlinkSync,
  renameSync: mockRenameSync,
  copyFileSync: mockCopyFileSync,
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
  execFileSync: mockExecFileSync,
}));

jest.unstable_mockModule('js-yaml', () => ({
  load: (content: string) => JSON.parse(content),
  dump: (value: unknown) => JSON.stringify(value),
}));

const mockLoadConnectors = jest
  .fn<(...args: unknown[]) => { connectors: unknown[]; initErrors: unknown[] }>()
  .mockReturnValue({ connectors: [], initErrors: [] });

jest.unstable_mockModule('../src/connectors/index.js', () => ({
  loadConnectors: mockLoadConnectors,
}));

const mockMessagesCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
    // Models that take the server-side refusal fallback go through the beta
    // endpoint. One mock serves both so mockResolvedValueOnce sequences hold.
    beta: { messages: { create: mockMessagesCreate } },
  })),
}));

const mockRenderPdf = jest
  .fn<(...args: unknown[]) => Promise<string>>()
  .mockResolvedValue('/tmp/test.pdf');

jest.unstable_mockModule('../src/render.js', () => ({
  renderPdf: mockRenderPdf,
}));

const mockLogUsage = jest.fn();

jest.unstable_mockModule('../src/usage.js', () => ({
  logUsage: mockLogUsage,
}));

// Import after mocks
const core = await import('../src/core.js');
const { todayYmd, shiftYmd } = await import('../src/dates.js');

/**
 * The brief's title is computed from the date, not taken from the model, so
 * tests assert its shape rather than whatever title the mocked response used.
 */
const DATE_TITLE = /^\w+day, \w+ \d{1,2}, \d{4}$/;

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

describe('buildHouseholdContext', () => {
  it('returns nothing when no household is configured', () => {
    expect(core.buildHouseholdContext(undefined)).toBe('');
    expect(core.buildHouseholdContext([])).toBe('');
  });

  it('lists every member, including one with no accounts of their own', () => {
    const out = core.buildHouseholdContext([
      { name: 'Person 1', role: 'self' },
      { name: 'Person 3', role: 'guest', notes: 'No calendar or email of their own.' },
    ]);

    expect(out).toContain('## Household members');
    expect(out).toContain('**Person 1**: self');
    expect(out).toContain('**Person 3**: guest — No calendar or email of their own.');
    // The whole point: a member without accounts must not be treated as absent.
    expect(out).toContain('no calendar, inbox or task list of their own');
  });

  it('maps connector account names to people when they differ', () => {
    const out = core.buildHouseholdContext([
      { name: 'Person 1', calendar_account: 'p1-cal', todoist_account: 'p1-todo' },
      { name: 'Person 2' },
    ]);

    expect(out).toContain('Person 1 → calendar "p1-cal", todoist "p1-todo"');
    // Person 2 has no links, so they get no mapping line.
    expect(out).not.toContain('Person 2 →');
  });

  it('omits the mapping section entirely when nobody has linked accounts', () => {
    const out = core.buildHouseholdContext([{ name: 'Person 1' }]);
    expect(out).toContain('**Person 1**');
    expect(out).not.toContain('Connector accounts map to people');
  });
});

describe('buildFeedbackContext', () => {
  it('is empty when the household has left no notes', () => {
    mockExistsSync.mockReturnValue(false);
    expect(core.buildFeedbackContext({})).toBe('');
    expect(core.buildFeedbackContext()).toBe('');
  });

  it('includes notes from config and from feedback.md', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('feedback.md'));
    mockReadFileSync.mockReturnValue('Use bullet points.');

    const ctx = core.buildFeedbackContext({ feedback_notes: 'Never list games we skip.' });

    expect(ctx).toContain('## User feedback');
    expect(ctx).toContain('Never list games we skip.');
    expect(ctx).toContain('Use bullet points.');
  });

  it('ignores an empty feedback.md and blank config notes', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('feedback.md'));
    mockReadFileSync.mockReturnValue('   ');
    expect(core.buildFeedbackContext({ feedback_notes: '  ' })).toBe('');
  });

  it('never feeds self-review findings back to the writer', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['critique_2026-03-27.json', 'review_2026-10-14.json']);
    mockReadFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith('feedback.md') ? '' : '{"issues":["Duplication: x"]}',
    );
    expect(core.buildFeedbackContext({})).toBe('');
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

describe('extractResponseText', () => {
  it('returns the text of a normal response', () => {
    expect(
      core.extractResponseText({
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
      }),
    ).toBe('{"ok":true}');
  });

  it('skips non-text blocks rather than assuming the first is text', () => {
    expect(
      core.extractResponseText({
        content: [
          { type: 'thinking' },
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        stop_reason: 'end_turn',
      }),
    ).toBe('part one part two');
  });

  it('explains a truncated response instead of returning half a document', () => {
    expect(() =>
      core.extractResponseText({
        content: [{ type: 'text', text: '{"incomp' }],
        stop_reason: 'max_tokens',
      }),
    ).toThrow(/output limit/);
  });

  it('reports a refusal as such', () => {
    expect(() => core.extractResponseText({ content: [], stop_reason: 'refusal' })).toThrow(
      /declined/,
    );
  });

  it('reports an empty response with its stop reason', () => {
    expect(() => core.extractResponseText({ content: [], stop_reason: 'end_turn' })).toThrow(
      /No text in response \(stop_reason: end_turn\)/,
    );
    expect(() => core.extractResponseText({ content: [] })).toThrow(/unknown/);
  });
});

describe('usesCalendarDerivedStations', () => {
  const both = {
    connectors: {
      google_calendar: { enabled: true },
      aviation_weather: { enabled: true },
    },
  };

  it('is on when both the calendar and aviation weather are enabled', () => {
    expect(core.usesCalendarDerivedStations(both)).toBe(true);
  });

  it('is off when either connector is disabled', () => {
    expect(
      core.usesCalendarDerivedStations({
        connectors: { google_calendar: { enabled: false }, aviation_weather: { enabled: true } },
      }),
    ).toBe(false);
    expect(
      core.usesCalendarDerivedStations({
        connectors: { google_calendar: { enabled: true }, aviation_weather: { enabled: false } },
      }),
    ).toBe(false);
    expect(core.usesCalendarDerivedStations({})).toBe(false);
  });

  it('can be turned off explicitly', () => {
    expect(
      core.usesCalendarDerivedStations({
        connectors: {
          google_calendar: { enabled: true },
          aviation_weather: { enabled: true, derive_stations: false },
        },
      }),
    ).toBe(false);
  });
});

describe('withDerivedStations', () => {
  const baseConfig = {
    connectors: {
      google_calendar: { enabled: true },
      aviation_weather: { enabled: true, stations: ['KAAA'] },
    },
  };

  const calendarResult = (events: { summary?: string; location?: string }[]) => ({
    source: 'google_calendar',
    description: '',
    data: { today: events, upcoming: [] },
    priorityHint: 'high' as const,
  });

  it('adds airports named in events to the configured stations', () => {
    const out = core.withDerivedStations(
      baseConfig,
      calendarResult([{ summary: 'Lesson at KBBB', location: '' }]),
    );
    expect(out.connectors?.aviation_weather.stations).toEqual(['KAAA', 'KBBB']);
    expect(out.connectors?.aviation_weather.derived_stations).toEqual(['KBBB']);
  });

  it('leaves the config untouched when events name no airports', () => {
    const out = core.withDerivedStations(
      baseConfig,
      calendarResult([{ summary: 'Dentist', location: 'Elm St' }]),
    );
    expect(out).toBe(baseConfig);
  });

  it('does not duplicate an airport already configured', () => {
    const out = core.withDerivedStations(
      baseConfig,
      calendarResult([{ summary: 'Lesson at KAAA', location: '' }]),
    );
    expect(out).toBe(baseConfig);
  });

  it('handles a missing calendar result or aviation connector', () => {
    expect(core.withDerivedStations(baseConfig, null)).toBe(baseConfig);
    expect(core.withDerivedStations({ connectors: {} }, calendarResult([]))).toEqual({
      connectors: {},
    });
  });

  it('never mutates the config it was given', () => {
    const out = core.withDerivedStations(
      baseConfig,
      calendarResult([{ summary: 'Lesson at KBBB', location: '' }]),
    );
    expect(baseConfig.connectors.aviation_weather.stations).toEqual(['KAAA']);
    expect(out).not.toBe(baseConfig);
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

describe('printPdf (re-exported from print.ts)', () => {
  it('calls lp with the printer and path as argv', () => {
    core.printPdf('/tmp/my brief.pdf', 'My Printer');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'lp',
      ['-d', 'My Printer', '/tmp/my brief.pdf'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});

describe('fetchAll', () => {
  it('should return results from successful connectors', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
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
      ],
      initErrors: [],
    });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('test');
    expect(issues).toHaveLength(0);
  });

  it('should capture connector errors as issues', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'broken',
          description: 'broken connector',
          fetch: jest
            .fn<() => Promise<ConnectorResult>>()
            .mockRejectedValue(new Error('connection timeout')),
        },
      ],
      initErrors: [],
    });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].connector).toBe('broken');
    expect(issues[0].error).toBe('connection timeout');
  });

  it('should handle mixed success and failure', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
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
      ],
      initErrors: [],
    });

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it('should handle non-Error thrown values', async () => {
    mockLoadConnectors.mockReturnValue({
      connectors: [
        {
          name: 'weird',
          description: 'throws string',
          fetch: jest.fn<() => Promise<ConnectorResult>>().mockRejectedValue('string error'),
        },
      ],
      initErrors: [],
    });

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
    // A bare string gets the default expiry.
    expect(parsed.insights[0]).toEqual({
      fact: 'Package arriving tomorrow',
      until: shiftYmd(todayYmd(), 3),
    });
  });

  it('stores dated facts from the structured reply and asks without the excluded sources', async () => {
    const until = shiftYmd(todayYmd(), 5);
    mockMessagesCreate.mockResolvedValue(
      mockApiResponse(JSON.stringify({ insights: [{ fact: 'Form due Friday', until }] })),
    );
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    const payload = JSON.stringify([
      { source: 'gmail', data: { subject: 'Please return the form by Friday' } },
      { source: 'language', data: { today_theme: 'shopping' } },
      { source: 'market', data: { symbol: 'XYZ' } },
    ]);

    await core.saveMemory(mockClient, 'claude-haiku-5-5', payload, '/tmp/output');

    const params = mockMessagesCreate.mock.calls[0][0] as {
      messages: { content: string }[];
      output_config: { format: { type: string } };
    };
    expect(params.messages[0].content).toContain('return the form');
    expect(params.messages[0].content).not.toContain('today_theme');
    expect(params.messages[0].content).not.toContain('XYZ');
    expect(params.output_config.format.type).toBe('json_schema');
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(parsed.insights).toEqual([{ fact: 'Form due Friday', until }]);
  });

  it('should not save when no insights are generated', async () => {
    mockMessagesCreate.mockResolvedValue(mockApiResponse('[]'));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    // mkdirSync is called for the memory dir, but writeFileSync should not be called
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('prunes memory files by age, keeping recent ones for later reading', async () => {
    mockMessagesCreate.mockResolvedValue(mockApiResponse('["insight"]'));
    mockExistsSync.mockReturnValue(true);
    const old = `memory_${shiftYmd(todayYmd(), -61)}.json`;
    const recent = `memory_${shiftYmd(todayYmd(), -20)}.json`;
    mockReaddirSync.mockReturnValue([old, recent, 'notes.txt']);
    mockUnlinkSync.mockImplementationOnce(() => {
      throw new Error('busy');
    });

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    expect(String(mockUnlinkSync.mock.calls[0][0])).toContain(old);
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
    mockMessagesCreate.mockResolvedValue(mockApiResponse('```json\n["fenced insight"]\n```'));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    await core.saveMemory(mockClient, 'claude-haiku-4-5-20251001', '{}', '/tmp/output');

    expect(mockWriteFileSync).toHaveBeenCalled();
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(parsed.insights.map((i: { fact: string }) => i.fact)).toEqual(['fenced insight']);
  });
});

describe('normaliseInsights', () => {
  const today = '2026-10-14';

  it('reads the structured shape and the legacy array', () => {
    expect(
      core.normaliseInsights({ insights: [{ fact: 'a', until: '2026-10-20' }] }, today),
    ).toEqual([{ fact: 'a', until: '2026-10-20' }]);
    expect(core.normaliseInsights(['b'], today)).toEqual([{ fact: 'b', until: '2026-10-17' }]);
  });

  it('replaces a past or malformed expiry with the default, and drops junk', () => {
    expect(
      core.normaliseInsights(
        [
          { fact: 'past', until: '2026-10-01' },
          { fact: 'bad', until: 'Friday' },
          { fact: '  ' },
          { until: '2026-10-20' },
          7,
          null,
        ],
        today,
      ),
    ).toEqual([
      { fact: 'past', until: '2026-10-17' },
      { fact: 'bad', until: '2026-10-17' },
    ]);
  });

  it('caps the list at eight and handles nonsense', () => {
    expect(
      core.normaliseInsights(
        Array.from({ length: 12 }, (_, i) => `f${i}`),
        today,
      ),
    ).toHaveLength(8);
    expect(core.normaliseInsights('nope', today)).toEqual([]);
    expect(core.normaliseInsights(null, today)).toEqual([]);
  });
});

describe('loadRecentMemories', () => {
  const today = '2026-10-14';

  it('loads only the last seven days, skips today, and drops expired facts', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'memory_2026-09-01.json',
      'memory_2026-10-13.json',
      'memory_2026-10-10.json',
      'memory_2026-10-14.json',
      'memory_2026-10-09.json',
      'other.json',
    ]);
    mockReadFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('10-13.json'))
        return JSON.stringify({
          insights: [
            { fact: 'still live', until: '2026-10-15' },
            { fact: 'expired', until: '2026-10-13' },
            'legacy string',
          ],
        });
      if (path.endsWith('10-10.json')) return '{corrupt';
      if (path.endsWith('10-09.json'))
        return JSON.stringify({ insights: [{ fact: 'gone', until: '2026-10-09' }] });
      return JSON.stringify({ insights: ['should not load'] });
    });

    const mems = core.loadRecentMemories('/tmp/output', today);

    expect(mems).toEqual([
      {
        date: '2026-10-13',
        insights: [{ fact: 'still live', until: '2026-10-15' }, 'legacy string'],
      },
    ]);
  });

  it('is empty without a memory directory', () => {
    mockExistsSync.mockReturnValue(false);
    expect(core.loadRecentMemories('/tmp/output', today)).toEqual([]);
  });
});

describe('notifyFailure', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('does nothing without a configured webhook', async () => {
    const spy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = spy;

    await core.notifyFailure({}, new Error('boom'));

    expect(spy).not.toHaveBeenCalled();
  });

  it('posts a short ASCII line naming a credit failure', async () => {
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = spy;
    const err = Object.assign(
      new Error('Your credit balance is too low to access the Anthropic API.'),
      { status: 400 },
    );

    await core.notifyFailure({ notify_webhook: 'http://relay.invalid/george' }, err);

    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((spy.mock.calls[0][1] as { body: string }).body) as {
      title: string;
      message: string;
    };
    expect(body.title).toBe('Callsheet');
    expect(body.message).toContain('CRIT');
    expect(body.message).toContain('credit exhausted');
    expect(body.message).toContain('400');
    expect(body.message.length).toBeLessThanOrEqual(155);
    // GSM-7 safe: anything outside printable ASCII halves the SMS segment size.
    expect(body.message).toMatch(/^[\x20-\x7E]*$/);
  });

  it('never lets the alarm break the run it was watching', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      core.notifyFailure({ notify_webhook: 'http://relay.invalid/george' }, new Error('boom')),
    ).resolves.toBeUndefined();

    consoleSpy.mockRestore();
  });
});

describe('notify', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('strips non-ASCII and caps the line at one SMS segment', async () => {
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = spy;

    await core.notify({ notify_webhook: 'http://relay.invalid/x' }, `CRIT ⚠ ${'x'.repeat(300)}`);

    const body = JSON.parse((spy.mock.calls[0][1] as { body: string }).body) as {
      message: string;
    };
    expect(body.message).toMatch(/^CRIT {2}x+$/);
    expect(body.message.length).toBe(155);
  });

  it('logs a non-OK webhook response without throwing', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 502 });

    await core.notify({ notify_webhook: 'http://relay.invalid/x' }, 'WARN test');

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('502'));
    errSpy.mockRestore();
  });
});

describe('pingHeartbeat', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('GETs the URL', async () => {
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as { fetch?: unknown }).fetch = spy;

    await core.pingHeartbeat('https://hc.invalid/abc');

    expect(spy).toHaveBeenCalledWith('https://hc.invalid/abc', expect.anything());
  });

  it('never throws, whatever the endpoint does', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockRejectedValueOnce('bare string');

    await expect(core.pingHeartbeat('https://hc.invalid/abc')).resolves.toBeUndefined();
    await expect(core.pingHeartbeat('https://hc.invalid/abc')).resolves.toBeUndefined();
    await expect(core.pingHeartbeat('https://hc.invalid/abc')).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('404'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('bare string'));
    errSpy.mockRestore();
  });
});

describe('supportsServerFallback', () => {
  it('is on for the models that accept fallbacks: "default"', () => {
    expect(core.supportsServerFallback('claude-sonnet-5-5')).toBe(true);
    expect(core.supportsServerFallback('claude-opus-5-5')).toBe(true);
    expect(core.supportsServerFallback('claude-fable-5-1')).toBe(true);
  });

  it('is off for models that do not', () => {
    expect(core.supportsServerFallback('claude-haiku-5-5')).toBe(false);
    expect(core.supportsServerFallback('claude-sonnet-5')).toBe(false);
  });
});

describe('model defaults', () => {
  it('writes the brief on Fable 5.1 and does housekeeping on Opus 5.5', () => {
    expect(core.DEFAULT_MODEL).toBe('claude-fable-5-1');
    expect(core.CRITIQUE_MODEL).toBe('claude-opus-5-5');
  });
});

describe('preservePrintedRun', () => {
  const today = '2026-10-14';
  const status = (lastScheduled: unknown) => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('status.json')) return true;
      if (path.includes('.printed.')) return path.endsWith('.printed.pdf');
      return true;
    });
    mockReadFileSync.mockImplementation((p: unknown) =>
      String(p).endsWith('status.json') ? JSON.stringify({ lastScheduled }) : '{}',
    );
  };

  it("keeps a copy of the morning's printed files before a manual re-run overwrites them", () => {
    status({ date: today, generated: true });
    core.preservePrintedRun('/out', today, 'manual');
    expect(mockCopyFileSync.mock.calls.map((c) => String(c[1]))).toEqual([
      '/out/callsheet_2026-10-14.printed.json',
      '/out/connector_data_2026-10-14.printed.json',
    ]);
  });

  it('keeps a copy on the first day of run status, when no scheduled run is on record', () => {
    status(undefined);
    core.preservePrintedRun('/out', today, 'dashboard');
    expect(mockCopyFileSync.mock.calls.map((c) => String(c[1]))).toEqual([
      '/out/callsheet_2026-10-14.printed.json',
      '/out/connector_data_2026-10-14.printed.json',
    ]);
  });

  it('does nothing for scheduled runs, other days, error pages, or a failed copy', () => {
    status({ date: today, generated: true });
    core.preservePrintedRun('/out', today, 'catch-up');
    status({ date: '2026-10-13', generated: true });
    core.preservePrintedRun('/out', today, 'dashboard');
    status({ date: today, generated: false });
    core.preservePrintedRun('/out', today, 'manual');
    expect(mockCopyFileSync).not.toHaveBeenCalled();

    status({ date: today, generated: true });
    mockCopyFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(() => core.preservePrintedRun('/out', today, 'manual')).not.toThrow();
  });
});

describe('isErrorBrief', () => {
  it('recognises the generation-failed page', () => {
    expect(
      core.isErrorBrief({
        title: 'x',
        subtitle: '⚠ GENERATION FAILED',
        sections: [{ heading: 'Generation Error', body: 'b' }],
      }),
    ).toBe(true);
    expect(core.isErrorBrief({ title: 'x', sections: [{ heading: 'Generation Error' }] })).toBe(
      true,
    );
  });

  it('does not mistake a real brief for one', () => {
    expect(core.isErrorBrief({ title: 'x', sections: [{ heading: 'Executive Brief' }] })).toBe(
      false,
    );
    expect(core.isErrorBrief({ title: 'x', sections: [] })).toBe(false);
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

    // The title is overwritten with a computed date — the model's own attempt
    // at it drifted a day on a sixth of briefs.
    expect(brief.title).toMatch(/^\w+day, \w+ \d{1,2}, \d{4}$/);
    expect(brief.title).not.toBe('Morning Brief');
    expect(brief.sections).toHaveLength(1);
  });

  it('should date the brief itself rather than trusting the model', async () => {
    const briefJson = JSON.stringify({
      title: 'Tuesday, January 1, 1999',
      sections: [{ heading: 'Overview', body: 'All clear.' }],
    });
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(briefJson))
      .mockResolvedValueOnce(mockApiResponse('["insight"]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'You are a morning brief generator.';
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const brief = await core.generateBrief(
      { ...minimalConfig, timezone: 'America/Chicago' },
      '{"data": "test"}',
    );

    const expected = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date());
    expect(brief.title).toBe(expected);
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
    expect(brief.title).toMatch(DATE_TITLE);
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

    await core.generateBrief(minimalConfig, '{}', [{ connector: 'weather', error: 'timeout' }]);

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
    expect(brief.title).toMatch(DATE_TITLE);
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

    const yesterday = shiftYmd(todayYmd(), -1);
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.includes('system.md')) return 'You are a morning brief generator.';
      if (p.includes(`memory_${yesterday}.json`))
        return JSON.stringify({
          date: yesterday,
          insights: [
            { fact: 'Package arriving tomorrow', until: shiftYmd(todayYmd(), 1) },
            'Bill due Friday',
          ],
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
      if (p.includes('/memory')) return [`memory_${yesterday}.json`];
      return [];
    });

    const brief = await core.generateBrief(minimalConfig, '{"data": "test"}');
    expect(brief.title).toMatch(DATE_TITLE);

    // The system prompt should contain memory context
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('Memory from previous briefs');
    expect(opts.system).toContain('Package arriving tomorrow (relevant until');
    expect(opts.system).toContain('- Bill due Friday');
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
    expect(brief.title).toMatch(DATE_TITLE);

    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('User feedback');
    expect(opts.system).toContain('Be more concise');
    // Old critique files are history for people, not instructions for the writer.
    expect(opts.system).not.toContain('Too verbose in tasks section');
    expect(opts.system).not.toContain('RECURRING');
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
    expect(brief.title).toMatch(DATE_TITLE);

    // The user message should contain previous brief context
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { messages: { content: string }[] };
    expect(opts.messages[0].content).toContain('previous_brief');
    expect(opts.messages[0].content).toContain('Buy groceries');
    expect(opts.messages[0].content).toContain('[URGENT]');
    expect(opts.messages[0].content).toContain('A quiet day overall');
  });

  it("diffs against yesterday's printed page when a later preview replaced the brief", async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(JSON.stringify({ title: 'B', sections: [] })))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));
    const yesterday = shiftYmd(todayYmd(), -1);
    const page = (label: string) =>
      JSON.stringify({ title: 'Y', sections: [{ heading: 'Tasks', items: [{ label }] }] });
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('system.md')) return 'System prompt.';
      if (p.endsWith(`callsheet_${yesterday}.printed.json`)) return page('Printed in the morning');
      if (p.endsWith(`callsheet_${yesterday}.json`)) return page('Previewed in the afternoon');
      return '{}';
    });
    mockExistsSync.mockImplementation((path: unknown) =>
      String(path).includes(`callsheet_${yesterday}`),
    );
    mockReaddirSync.mockReturnValue([]);

    await core.generateBrief(minimalConfig, '{}');

    const content = (mockMessagesCreate.mock.calls[0][0] as { messages: { content: string }[] })
      .messages[0].content;
    expect(content).toContain('Printed in the morning');
    expect(content).not.toContain('Previewed in the afternoon');
  });

  it('should include household context and extras in prompt', async () => {
    const configWithContext: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      context: {
        family: '2 adults, 1 dog',
        location: 'Portland, OR',
      },
      extras: [{ name: 'Daily Quote', instruction: 'Include an inspiring quote.' }],
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
    expect(brief.title).toMatch(DATE_TITLE);
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

    expect(result.brief.title).toMatch(DATE_TITLE);
    expect(result.pdfPath).toBe('/tmp/test.pdf');
    expect(result.jsonPath).toMatch(/callsheet_.*\.json$/);
    expect(result.dataPath).toMatch(/connector_data_.*\.json$/);

    // Should have called lp for printing
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'lp',
      expect.arrayContaining(['-d', 'Brother_HL']),
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(result.generated).toBe(true);
    expect(result.print.outcome).toBe('printed');

    consoleSpy.mockRestore();
  });

  it('should skip printing in preview mode', async () => {
    setupPipelineMocks();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline(pipelineConfig, { preview: true });

    expect(result.brief.title).toMatch(DATE_TITLE);
    // Should NOT have called lp
    expect(mockExecFileSync).not.toHaveBeenCalled();

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

    expect(result.brief.title).toMatch(DATE_TITLE);
    expect(mockExecFileSync).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should throw when no data is fetched', async () => {
    mockLoadConnectors.mockReturnValue({ connectors: [], initErrors: [] });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(core.runPipeline(pipelineConfig)).rejects.toThrow('No data fetched');

    consoleSpy.mockRestore();
  });

  it('asks for the server-side refusal fallback when the model supports it', async () => {
    setupPipelineMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await core.runPipeline({ ...pipelineConfig, model: 'claude-sonnet-5-5' }, { preview: true });

    const briefCall = mockMessagesCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(briefCall.model).toBe('claude-sonnet-5-5');
    expect(briefCall.fallbacks).toBe('default');
    expect(briefCall.betas).toEqual(['server-side-fallback-2026-07-01']);
    logSpy.mockRestore();
  });

  it('does not send the fallback to a model that would reject it', async () => {
    setupPipelineMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await core.runPipeline(pipelineConfig, { preview: true });

    const briefCall = mockMessagesCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(briefCall).not.toHaveProperty('fallbacks');
    expect(briefCall).not.toHaveProperty('betas');
    logSpy.mockRestore();
  });

  describe('delivery reporting', () => {
    const noSleep = () => Promise.resolve();
    let fetchSpy: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
    let logSpy: ReturnType<typeof jest.spyOn>;
    let errSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      fetchSpy = jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ ok: true, status: 200 });
      (globalThis as { fetch?: unknown }).fetch = fetchSpy;
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // clearAllMocks keeps implementations; a CUPS script from one test must not leak.
      mockExecFileSync.mockReset();
    });

    afterEach(() => {
      delete (globalThis as { fetch?: unknown }).fetch;
      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    /** The JSON written to the status file's temporary path. */
    function writtenStatus(): { last: { print: string; trigger: string; generated: boolean } } {
      // The last write: scheduled runs also write the file earlier to track
      // connector failure streaks.
      const call = mockWriteFileSync.mock.calls
        .filter((c) => String(c[0]).endsWith('status.json.tmp'))
        .at(-1);
      expect(call).toBeDefined();
      return JSON.parse(String(call![1])) as never;
    }

    function webhookMessages(): string[] {
      return fetchSpy.mock.calls
        .filter((c) => c[1] && (c[1] as { method?: string }).method === 'POST')
        .map((c) => (JSON.parse((c[1] as { body: string }).body) as { message: string }).message);
    }

    const webhookConfig: CallsheetConfig = {
      ...pipelineConfig,
      notify_webhook: 'http://relay.invalid/house',
      heartbeat_url: 'https://hc.invalid/ping/abc',
    };

    it('reports a print failure without throwing, alerts, and records it', async () => {
      setupPipelineMocks();
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'lp: Error - The printer or class does not exist.',
        });
      });

      const result = await core.runPipeline(webhookConfig, {
        trigger: 'scheduled',
        print: { sleep: noSleep, attempts: 2 },
      });

      expect(result.generated).toBe(true);
      expect(result.print.outcome).toBe('failed');
      expect(webhookMessages()[0]).toMatch(/^CRIT Callsheet brief not printed: /);
      const status = writtenStatus();
      expect(status.last.print).toBe('failed');
      expect(status.last.trigger).toBe('scheduled');
      expect(mockRenameSync).toHaveBeenCalled();
      // A run that produced nothing on paper must not tell the dead-man's switch it was fine.
      expect(fetchSpy.mock.calls.some((c) => c[0] === webhookConfig.heartbeat_url)).toBe(false);
    });

    it('warns when the print job is accepted but never completes', async () => {
      setupPipelineMocks();
      mockExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
        if (cmd === 'lp') return 'request id is Brother_HL-5 (1 file(s))';
        if ((args as string[])[0] === '-W') return 'Brother_HL-5 node 1 today\n';
        return 'printer Brother_HL disabled - paper out';
      });

      const result = await core.runPipeline(webhookConfig, {
        trigger: 'scheduled',
        print: { sleep: noSleep, pollMs: 10, confirmTimeoutMs: 30 },
      });

      expect(result.print.outcome).toBe('queued');
      expect(webhookMessages()[0]).toMatch(/^WARN Callsheet print stuck: job Brother_HL-5/);
      expect(writtenStatus().last.print).toBe('queued');
    });

    it('pings the heartbeat after a good scheduled run', async () => {
      setupPipelineMocks();

      await core.runPipeline(webhookConfig, { trigger: 'scheduled', print: { sleep: noSleep } });

      expect(fetchSpy).toHaveBeenCalledWith(webhookConfig.heartbeat_url, expect.anything());
      expect(webhookMessages()).toEqual([]);
    });

    it('does not ping the heartbeat for a manual run', async () => {
      setupPipelineMocks();

      const result = await core.runPipeline(webhookConfig, { print: { sleep: noSleep } });

      expect(result.print.outcome).toBe('printed');
      expect(writtenStatus().last.trigger).toBe('manual');
      expect(fetchSpy.mock.calls.some((c) => c[0] === webhookConfig.heartbeat_url)).toBe(false);
    });

    it('records a dashboard preview as a skipped print', async () => {
      setupPipelineMocks();

      await core.runPipeline(webhookConfig, { preview: true });

      expect(writtenStatus().last).toMatchObject({ trigger: 'dashboard', print: 'skipped' });
    });

    it('records and alerts when a scheduled run fetches nothing', async () => {
      mockLoadConnectors.mockReturnValue({ connectors: [], initErrors: [] });

      await expect(core.runPipeline(webhookConfig, { trigger: 'scheduled' })).rejects.toThrow(
        'No data fetched',
      );

      expect(writtenStatus().last.generated).toBe(false);
      expect(webhookMessages()[0]).toMatch(/^CRIT Callsheet: No data fetched/);
    });

    it('does not alert when a manual run fetches nothing', async () => {
      mockLoadConnectors.mockReturnValue({ connectors: [], initErrors: [] });

      await expect(core.runPipeline(webhookConfig)).rejects.toThrow('No data fetched');

      expect(webhookMessages()).toEqual([]);
    });

    it("drops warnings left over from an earlier run and records this run's own", async () => {
      setupPipelineMocks();
      core.runtimeErrors.add('stale_source', 'from yesterday', 'warning');

      await core.runPipeline(webhookConfig, { trigger: 'scheduled', print: { sleep: noSleep } });

      expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain(
        '  Dropping 1 warning(s) left over from an earlier run.',
      );
      const status = writtenStatus() as unknown as { last: { warnings?: string[] } };
      expect(status.last.warnings ?? []).not.toContain('stale_source: from yesterday');
    });

    it('announces a connector that has failed two scheduled mornings running', async () => {
      setupPipelineMocks();
      mockLoadConnectors.mockReturnValue({
        connectors: [
          {
            name: 'weather',
            description: 'Weather',
            fetch: jest
              .fn<() => Promise<ConnectorResult>>()
              .mockRejectedValue(new Error('HTTP 503')),
          },
          {
            name: 'calendar',
            description: 'Calendar',
            fetch: jest.fn<() => Promise<ConnectorResult>>().mockResolvedValue({
              source: 'calendar',
              description: 'c',
              data: {},
              priorityHint: 'low',
            }),
          },
        ],
        initErrors: [],
      });
      const yesterday = shiftYmd(todayYmd(), -1);
      mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('status.json'));
      mockReadFileSync.mockImplementation((p: unknown) => {
        const path = String(p);
        if (path.includes('system.md')) return 'System prompt.';
        if (path.endsWith('status.json'))
          return JSON.stringify({
            connectorStreaks: { weather: { since: yesterday, last: yesterday, days: 1 } },
          });
        return '{}';
      });

      await core.runPipeline(webhookConfig, { trigger: 'scheduled', print: { sleep: noSleep } });

      expect(webhookMessages()).toContain(
        `WARN Callsheet: weather has failed 2 mornings running (since ${yesterday}): HTTP 503`,
      );
    });

    it('records an error page as a failed generation, with its explanation', async () => {
      setupPipelineMocks();
      mockMessagesCreate.mockReset();
      mockMessagesCreate.mockRejectedValue(
        Object.assign(new Error('Your credit balance is too low'), { status: 400 }),
      );

      const result = await core.runPipeline(webhookConfig, {
        trigger: 'scheduled',
        print: { sleep: noSleep },
      });

      expect(result.generated).toBe(false);
      const status = writtenStatus() as unknown as { last: { generated: boolean; error: string } };
      expect(status.last.generated).toBe(false);
      expect(status.last.error).toMatch(/^Brief generation failed after 1 attempt/);
      expect(fetchSpy.mock.calls.some((c) => c[0] === webhookConfig.heartbeat_url)).toBe(false);
    });
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
    expect(result.brief.title).toMatch(DATE_TITLE);

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
      core.generateBrief({ model: 'claude-sonnet-4-20250514', output_dir: '/tmp/output' }, '{}'),
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
            {
              task_id: '123',
              task_content: 'Pay bill',
              person: 'Person1',
              reason: 'Payment confirmed',
            },
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
    expect(brief.title).toMatch(DATE_TITLE);

    // The system prompt should contain auto-close context
    const firstCall = mockMessagesCreate.mock.calls[0] as unknown[];
    const opts = firstCall[0] as { system: string };
    expect(opts.system).toContain('Auto-closed tasks');
    expect(opts.system).toContain('Pay bill');
  });

  it("closes a task an email proves done, through the person's own token", async () => {
    const autoCloseConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      auto_close_tasks: true,
      connectors: {
        todoist: { accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }] },
      },
    };
    process.env.TODOIST_TOKEN_PERSON1 = 'fake-todoist-token';
    const payload = JSON.stringify([
      {
        source: 'todoist',
        data: {
          accounts: [
            {
              person: 'Person1',
              today: [{ id: '12345', content: 'Pay electric bill', isRecurring: false }],
            },
          ],
        },
      },
      {
        source: 'gmail',
        data: {
          accounts: [
            {
              person: 'Person1',
              emails: [
                {
                  from: 'Utility Co <billing@example.com>',
                  subject: 'Payment received',
                  snippet: 'Thank you, your payment of $42.10 was received.',
                },
              ],
            },
          ],
        },
      },
    ]);

    mockMessagesCreate
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({ title: 'Brief', sections: [{ heading: 'A', body: 'b' }] }),
        ),
      )
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('[]')) // critique
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({
            closures: [
              {
                task_id: '12345',
                evidence_id: 'e1',
                evidence_quote: 'your payment of $42.10 was received',
                reason: 'Payment confirmation email',
              },
            ],
          }),
        ),
      );
    mockReadFileSync.mockImplementation((path: unknown) =>
      String(path).includes('system.md') ? 'System prompt.' : '{}',
    );
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const mockFetch = jest
      .fn<(...args: unknown[]) => Promise<{ ok: boolean; status: number }>>()
      .mockResolvedValue({ ok: true, status: 204 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await core.generateBrief(autoCloseConfig, payload, [], { applyActions: true });

      // The detection call sees the tasks and the email, not a prefix of the payload.
      const detection = mockMessagesCreate.mock.calls[3][0] as {
        messages: { content: string }[];
        output_config: { format: { type: string } };
      };
      expect(detection.messages[0].content).toContain('Pay electric bill');
      expect(detection.messages[0].content).toContain('Payment received');
      expect(detection.output_config.format.type).toBe('json_schema');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0][0])).toContain('tasks/12345/close');
      expect(mockWriteFileSync.mock.calls.some((c) => String(c[0]).includes('auto_close'))).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TODOIST_TOKEN_PERSON1;
      consoleSpy.mockRestore();
    }
  });

  it('logs that nothing qualified when the payload has no tasks to check', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(JSON.stringify({ title: 'B', sections: [] })))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));
    mockReadFileSync.mockImplementation((path: unknown) =>
      String(path).includes('system.md') ? 'System prompt.' : '{}',
    );
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await core.generateBrief(
      { model: 'claude-sonnet-4-20250514', output_dir: '/tmp/output', auto_close_tasks: true },
      '[]',
      [],
      { applyActions: true },
    );

    // No tasks means no detection call at all — three calls, not four.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
    const logs = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('No tasks to auto-close'))).toBe(true);
    consoleSpy.mockRestore();
  });

  it('never auto-closes a task on a preview, however strong the evidence', async () => {
    process.env.TODOIST_TOKEN_PERSON1 = 'fake-todoist-token';
    const payload = JSON.stringify([
      {
        source: 'todoist',
        data: {
          accounts: [
            {
              person: 'Person1',
              today: [{ id: '12345', content: 'Pay electric bill', isRecurring: false }],
            },
          ],
        },
      },
      {
        source: 'gmail',
        data: {
          accounts: [
            {
              person: 'Person1',
              emails: [{ subject: 'Payment received', snippet: 'Your payment was received.' }],
            },
          ],
        },
      },
    ]);
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(JSON.stringify({ title: 'B', sections: [] })))
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('[]'));
    mockReadFileSync.mockImplementation((path: unknown) =>
      String(path).includes('system.md') ? 'System prompt.' : '{}',
    );
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const mockFetch = jest.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await core.generateBrief(
        {
          model: 'claude-sonnet-4-20250514',
          output_dir: '/tmp/output',
          auto_close_tasks: true,
          connectors: {
            todoist: { accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }] },
          },
        },
        payload,
      );

      // No detection call and no Todoist request: closing a task is a write.
      expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
      expect(mockFetch).not.toHaveBeenCalled();
      const logs = consoleSpy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes('auto-closable'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TODOIST_TOKEN_PERSON1;
      consoleSpy.mockRestore();
    }
  });

  it("records the language phrase on a real run, never on a preview's", async () => {
    const config: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      connectors: { language: { enabled: true, label_prefix: 'Español' } },
    };
    const briefJson = JSON.stringify({
      title: 'B',
      sections: [
        {
          heading: 'Executive Brief',
          items: [{ label: 'Español: "¿Dónde está la estación?" — Where is the station?' }],
        },
      ],
    });
    const queueRun = () =>
      mockMessagesCreate
        .mockResolvedValueOnce(mockApiResponse(briefJson))
        .mockResolvedValueOnce(mockApiResponse('[]'))
        .mockResolvedValueOnce(mockApiResponse('[]'));
    mockReadFileSync.mockImplementation((path: unknown) =>
      String(path).includes('system.md') ? 'System prompt.' : '{}',
    );
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const historyWrites = () =>
      mockWriteFileSync.mock.calls.filter((c) => String(c[0]).endsWith('language_history.json'));
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    queueRun();
    await core.generateBrief(config, '[]');
    expect(historyWrites()).toHaveLength(0);

    queueRun();
    await core.generateBrief(config, '[]', [], { applyActions: true });
    expect(historyWrites()).toHaveLength(1);
    expect(String(historyWrites()[0][1])).toContain('¿Dónde está la estación?');
    consoleSpy.mockRestore();
  });

  describe('task coach', () => {
    const coachConfig: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      output_dir: '/tmp/output',
      task_coach: { enabled: true },
      connectors: {
        todoist: { accounts: [{ name: 'Alex', token_env: 'TODOIST_TOKEN_COACH' }] },
      },
    };
    const payload = JSON.stringify([
      {
        source: 'todoist',
        data: {
          accounts: [
            {
              person: 'Alex',
              backlog: [
                { id: 't1', content: 'Return the library books', ageDays: 2 },
                { id: 't2', content: 'Clean the garage', ageDays: 200 },
              ],
              recently_completed: [],
            },
          ],
        },
      },
      { source: 'google_calendar', data: { free_time_today: { Alex: ['12:00 PM–3:00 PM'] } } },
    ]);
    const written = {
      title: 'T',
      sections: [{ heading: 'Executive Brief', items: [{ label: 'Quiet day ahead' }] }],
      focus: [{ person: 'Alex', task_id: 't1', when: '12:30 PM', why: 'due back soon' }],
      decide: [{ task_id: 't2', action: 'first_step', detail: 'Clear one shelf' }],
      capture: [{ person: 'Alex', content: 'Pay the water bill', source: 'Water bill email' }],
      capture_prompts: ['Anything from the meeting to add?'],
    };

    function queueReplies() {
      mockMessagesCreate
        .mockResolvedValueOnce(mockApiResponse(JSON.stringify(written)))
        .mockResolvedValueOnce(mockApiResponse('[]')) // memory
        .mockResolvedValueOnce(mockApiResponse('{"issues":[]}')); // fact check
      mockReadFileSync.mockImplementation((p: unknown) =>
        String(p).includes('system.md') ? 'System prompt.' : '{}',
      );
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue([]);
    }

    afterEach(() => {
      delete process.env.TODOIST_TOKEN_COACH;
      delete (globalThis as { fetch?: unknown }).fetch;
    });

    it('plans the day, carries the plan out in Todoist and prints it', async () => {
      queueReplies();
      process.env.TODOIST_TOKEN_COACH = 'tok';
      const fetchSpy = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"id":"new-1"}'),
      });
      (globalThis as { fetch?: unknown }).fetch = fetchSpy;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const brief = await core.generateBrief(coachConfig, payload, [], { applyActions: true });

      const call = mockMessagesCreate.mock.calls[0][0] as {
        output_config: { format: { schema: { properties: Record<string, unknown> } } };
        messages: { content: string }[];
      };
      expect(call.output_config.format.schema.properties).toHaveProperty('focus');
      expect(call.messages[0].content).toContain('<task_coach>');
      expect(call.messages[0].content).toContain(
        '[t2] Alex: "Clean the garage" — untouched for 200 days',
      );

      const headings = brief.sections.map((s) => s.heading);
      expect(headings).toEqual([
        'Executive Brief',
        "Today's Focus",
        'Stuck — Decide Today',
        'Added to Todoist',
        'Capture',
      ]);
      expect(brief.sections[1].items?.[0]).toMatchObject({
        label: 'Return the library books',
        time: '12:30 PM',
      });

      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls).toContain('https://api.todoist.com/api/v1/tasks');
      expect(urls).toContain('https://api.todoist.com/api/v1/tasks/t1');
      const writes = mockWriteFileSync.mock.calls.map((c) => String(c[0]));
      expect(writes.some((p) => p.endsWith('ledger.json'))).toBe(true);
      expect(writes.some((p) => /focus_\d{4}-\d{2}-\d{2}\.json$/.test(p))).toBe(true);
      expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain(
        '  Task coach: 1 focus pick(s), 1 decision(s), 1 task(s) added, 1 scheduled for today.',
      );
      logSpy.mockRestore();
    });

    it('writes nothing to Todoist or the ledger on a preview', async () => {
      queueReplies();
      const fetchSpy = jest.fn();
      (globalThis as { fetch?: unknown }).fetch = fetchSpy;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const brief = await core.generateBrief(coachConfig, payload);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(brief.sections.map((s) => s.heading)).not.toContain('Added to Todoist');
      expect(brief.sections.map((s) => s.heading)).toContain("Today's Focus");
      expect(mockWriteFileSync.mock.calls.some((c) => String(c[0]).endsWith('ledger.json'))).toBe(
        false,
      );
      expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain(
        '  Task coach: 1 focus pick(s), 1 decision(s), 1 capture(s) proposed (preview: nothing written).',
      );
      logSpy.mockRestore();
    });

    it('reports Todoist failures as run warnings', async () => {
      queueReplies();
      process.env.TODOIST_TOKEN_COACH = 'tok';
      (globalThis as { fetch?: unknown }).fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await core.generateBrief(coachConfig, payload, [], { applyActions: true });

      const warnings = core.runtimeErrors.drain();
      expect(warnings.some((w) => w.source === 'task_coach' && w.error.includes('401'))).toBe(true);
      logSpy.mockRestore();
    });
  });

  it('marks stale context as history and lists it for housekeeping on the review day', async () => {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    mockMessagesCreate
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({ title: 'T', sections: [{ heading: 'Executive Brief', items: [] }] }),
        ),
      )
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('{"issues":[]}'));
    mockReadFileSync.mockImplementation((p: unknown) =>
      String(p).includes('system.md') ? 'System prompt.' : '{}',
    );
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const brief = await core.generateBrief(
      {
        model: 'claude-sonnet-4-20250514',
        output_dir: '/tmp/output',
        weekly_review_day: days[new Date().getDay()],
        context: {
          travel: 'Trip May 7-25, 2020.',
          old: { text: 'Something', until: '2020-01-01' },
          people: 'Two adults',
        },
      },
      '[]',
    );

    const system = (mockMessagesCreate.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain('- **travel**: Trip May 7-25, 2020. [Every date in this note');
    expect(system).toContain('- **people**: Two adults');
    expect(system).not.toContain('Something');
    const housekeeping = brief.sections.find((s) => s.heading === 'Housekeeping');
    expect(housekeeping?.items?.map((i) => i.label)).toEqual([
      'Update the "travel" context in config.yaml',
      'Remove the "old" context from config.yaml',
    ]);
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain(
      '  Note: context "travel" only mentions past dates (latest 2020-05-25) — update it in config.yaml.',
    );
    logSpy.mockRestore();
  });

  it('learns household changes before writing, and prints them under Housekeeping', async () => {
    const payload = JSON.stringify([
      { source: 'gmail', data: { emails: [{ subject: 'Your offer letter from Northwind' }] } },
    ]);
    mockMessagesCreate
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({
            add: [
              {
                topic: 'work',
                text: 'Alex has a new job at Northwind',
                evidence: 'offer letter from Northwind',
              },
            ],
            retire: [],
            stale_config: [
              { key: 'work', reason: 'Started a new job', evidence: 'offer letter from Northwind' },
            ],
          }),
        ),
      ) // context review
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({ title: 'T', sections: [{ heading: 'Executive Brief', items: [] }] }),
        ),
      ) // brief
      .mockResolvedValueOnce(mockApiResponse('[]')) // memory
      .mockResolvedValueOnce(mockApiResponse('{"issues":[]}')); // fact check
    mockReadFileSync.mockImplementation((p: unknown) =>
      String(p).includes('system.md') ? 'System prompt.' : '{}',
    );
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const brief = await core.generateBrief(
      {
        model: 'claude-sonnet-4-20250514',
        output_dir: '/tmp/output',
        living_context: { enabled: true },
        context: { work: 'Alex works at Example Corp.' },
      },
      payload,
      [],
      { applyActions: true },
    );

    const system = (mockMessagesCreate.mock.calls[1][0] as { system: string }).system;
    expect(system).toContain('## Recent household changes (learned from the data)');
    expect(system).toContain('Alex has a new job at Northwind');
    const housekeeping = brief.sections.find((s) => s.heading === 'Housekeeping');
    expect(housekeeping?.items?.map((i) => i.label)).toEqual([
      'Learned: Alex has a new job at Northwind',
      'Update the "work" context in config.yaml',
    ]);
    expect(mockWriteFileSync.mock.calls.some((c) => String(c[0]).endsWith('living.json'))).toBe(
      true,
    );
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain(
      '  Context: 1 fact(s) learned, 0 retired, 1 config entry flagged.',
    );
    logSpy.mockRestore();
  });

  it('reads the living context on a preview but never reviews or saves it', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({ title: 'T', sections: [{ heading: 'Executive Brief', items: [] }] }),
        ),
      )
      .mockResolvedValueOnce(mockApiResponse('[]'))
      .mockResolvedValueOnce(mockApiResponse('{"issues":[]}'));
    mockReadFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('system.md')) return 'System prompt.';
      if (path.endsWith('living.json'))
        return JSON.stringify({
          facts: [
            {
              id: '1',
              topic: 'trip',
              text: 'Away Dec 3-8',
              since: '2026-10-01',
              until: '2099-01-01',
              source: 's',
            },
          ],
        });
      return '{}';
    });
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    await core.generateBrief(
      {
        model: 'claude-sonnet-4-20250514',
        output_dir: '/tmp/output',
        living_context: { enabled: true },
      },
      '[]',
    );

    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
    expect((mockMessagesCreate.mock.calls[0][0] as { system: string }).system).toContain(
      'Away Dec 3-8',
    );
    expect(mockWriteFileSync.mock.calls.some((c) => String(c[0]).endsWith('living.json'))).toBe(
      false,
    );
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

  it('reviews the brief: drops a repeated Executive item and applies a verified correction', async () => {
    setupPipelineMocks();
    mockMessagesCreate.mockReset();
    const draft = {
      title: 'x',
      sections: [
        {
          heading: 'Executive Brief',
          items: [
            { label: 'Recycling pickup tomorrow — bins out tonight' },
            { label: 'Rain clears by noon, dry afternoon' },
          ],
        },
        {
          heading: 'Tasks',
          items: [{ label: 'Put recycling bins out tonight for pickup tomorrow', checkbox: true }],
        },
        { heading: 'Schedule', items: [{ time: '3:00 PM', label: 'Dentist' }] },
      ],
    };
    mockMessagesCreate
      .mockResolvedValueOnce(mockApiResponse(JSON.stringify(draft)))
      .mockResolvedValueOnce(mockApiResponse('["insight"]')) // memory
      .mockResolvedValueOnce(
        mockApiResponse(
          JSON.stringify({
            issues: [
              {
                brief_quote: '3:00 PM',
                payload_quote: 'conditions',
                corrected_text: '2:30 PM',
                explanation: 'The data says 2:30.',
              },
              {
                brief_quote: 'Dentist',
                payload_quote: 'not in the data at all',
                corrected_text: 'Doctor',
                explanation: 'unverifiable',
              },
            ],
          }),
        ),
      );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline({ ...pipelineConfig, printer: '' });

    const exec = result.brief.sections.find((s) => s.heading === 'Executive Brief');
    expect(exec?.items?.map((i) => i.label)).toEqual(['Rain clears by noon, dry afternoon']);
    const schedule = result.brief.sections.find((s) => s.heading === 'Schedule');
    // Verified: '3:00 PM' is in the brief once and 'conditions' is in the data.
    expect(schedule?.items?.[0].time).toBe('2:30 PM');
    // Unverified: its data quote appears nowhere, so the label stays.
    expect(schedule?.items?.[0].label).toBe('Dentist');
    const logs = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(
      logs.some((l) =>
        l.includes(
          'Review: 1 repeated Executive Brief item(s) removed; 2 fact issue(s) reported, 1 verified, 1 corrected.',
        ),
      ),
    ).toBe(true);
    expect(mockWriteFileSync.mock.calls.some((c) => String(c[0]).includes('review_'))).toBe(true);
    consoleSpy.mockRestore();
  });

  it('keeps going when the review log cannot be written', async () => {
    setupPipelineMocks();
    mockWriteFileSync.mockImplementation((path: unknown) => {
      if (String(path).includes('review_')) throw new Error('disk full');
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await core.runPipeline({ ...pipelineConfig, printer: '' });

    expect(result.generated).toBe(true);
    mockWriteFileSync.mockReset();
    consoleSpy.mockRestore();
  });
});
