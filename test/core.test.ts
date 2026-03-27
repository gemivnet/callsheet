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

const mockLoadConnectors = jest.fn<(...args: unknown[]) => unknown[]>().mockReturnValue([]);

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
    mockLoadConnectors.mockReturnValue([
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
    ]);

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('test');
    expect(issues).toHaveLength(0);
  });

  it('should capture connector errors as issues', async () => {
    mockLoadConnectors.mockReturnValue([
      {
        name: 'broken',
        description: 'broken connector',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockRejectedValue(new Error('connection timeout')),
      },
    ]);

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0].connector).toBe('broken');
    expect(issues[0].error).toBe('connection timeout');
  });

  it('should handle mixed success and failure', async () => {
    mockLoadConnectors.mockReturnValue([
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
    ]);

    const { results, issues } = await core.fetchAll({ connectors: {} });

    expect(results).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it('should handle non-Error thrown values', async () => {
    mockLoadConnectors.mockReturnValue([
      {
        name: 'weird',
        description: 'throws string',
        fetch: jest.fn<() => Promise<ConnectorResult>>().mockRejectedValue('string error'),
      },
    ]);

    const { issues } = await core.fetchAll({ connectors: {} });
    expect(issues[0].error).toBe('string error');
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
});
