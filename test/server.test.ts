import { jest } from '@jest/globals';
import http from 'node:http';
import type { Server, IncomingMessage } from 'node:http';

// ── Mock functions ──────────────────────────────────────────────────────────

const mockExistsSync = jest.fn<(p: string) => boolean>().mockReturnValue(false);
const mockReadFileSync = jest.fn<(p: string, enc?: string) => string>().mockReturnValue('');
const mockReaddirSync = jest.fn<(p: string) => string[]>().mockReturnValue([]);
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();

const mockLoadConfig = jest.fn();
const mockRunPipeline = jest.fn();
const mockGetRegistry = jest.fn().mockReturnValue(new Map());
const mockIsGenerating = jest.fn().mockReturnValue(false);
const mockGetMonthlyUsageData = jest.fn().mockReturnValue({ month: '2026-03', entries: [] });
const mockGetUsageSummary = jest.fn().mockReturnValue({ total_cost: 0, total_input_tokens: 0, total_output_tokens: 0, brief_count: 0, api_calls: 0, by_model: {} });
const mockBuildAuthUrl = jest.fn();
const mockExchangeCodeAndSave = jest.fn();
const mockResolveCredsFile = jest.fn().mockReturnValue(undefined);
const mockRandomUUID = jest.fn().mockReturnValue('test-uuid-1234');

// ── Register mocks ──────────────────────────────────────────────────────────

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  existsSync: mockExistsSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
  default: {
    readFileSync: mockReadFileSync,
    readdirSync: mockReaddirSync,
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
  },
}));

jest.unstable_mockModule('node:crypto', () => ({
  default: { randomUUID: mockRandomUUID },
  randomUUID: mockRandomUUID,
}));

jest.unstable_mockModule('../src/core.js', () => ({
  loadConfig: mockLoadConfig,
  runPipeline: mockRunPipeline,
}));

jest.unstable_mockModule('../src/connectors/index.js', () => ({
  getRegistry: mockGetRegistry,
}));

jest.unstable_mockModule('../src/connectors/google-auth.js', () => ({
  buildAuthUrl: mockBuildAuthUrl,
  exchangeCodeAndSave: mockExchangeCodeAndSave,
  resolveCredsFile: mockResolveCredsFile,
}));

jest.unstable_mockModule('../src/usage.js', () => ({
  getMonthlyUsageData: mockGetMonthlyUsageData,
  getUsageSummary: mockGetUsageSummary,
}));

jest.unstable_mockModule('../src/scheduler.js', () => ({
  isGenerating: mockIsGenerating,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

const { createApp } = await import('../src/server.js');

// ── Test helpers ────────────────────────────────────────────────────────────

type ResponseData = { status: number; headers: Record<string, string>; body: string };

function request(server: Server, method: string, path: string, body?: unknown): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') return reject(new Error('No address'));
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function json(r: ResponseData): unknown {
  return JSON.parse(r.body);
}

// ── Tests ───────────────────────────────────────────────────────────────────

let server: Server;

beforeAll((done) => {
  const app = createApp();
  server = app.listen(0, () => done());
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockGetRegistry.mockReturnValue(new Map());
  mockIsGenerating.mockReturnValue(false);
});

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const res = await request(server, 'GET', '/api/health');
    const data = json(res) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data).toHaveProperty('uptime_seconds');
    expect(data).toHaveProperty('started_at');
  });
});

describe('GET /api/setup/status', () => {
  it('returns config_exists false when no config', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'GET', '/api/setup/status');
    const data = json(res) as Record<string, unknown>;
    expect(data.config_exists).toBe(false);
  });

  it('returns config_exists true when config exists', async () => {
    mockExistsSync.mockImplementation((p: string) => p.includes('config'));
    const res = await request(server, 'GET', '/api/setup/status');
    const data = json(res) as Record<string, unknown>;
    expect(data.config_exists).toBe(true);
  });
});

describe('POST /api/setup', () => {
  it('writes config.yaml and returns success', async () => {
    const res = await request(server, 'POST', '/api/setup', {
      model: 'claude-sonnet-4-20250514',
      connectors: { weather: { enabled: true } },
    });
    const data = json(res) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('appends API key to .env', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'POST', '/api/setup', {
      anthropic_api_key: 'sk-ant-test',
    });
    expect(res.status).toBe(200);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '.env',
      expect.stringContaining('ANTHROPIC_API_KEY=sk-ant-test'),
    );
  });
});

describe('GET /api/briefs', () => {
  it('returns empty array when output dir does not exist', async () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const res = await request(server, 'GET', '/api/briefs');
    const data = json(res) as { briefs: unknown[] };
    expect(data.briefs).toEqual([]);
  });

  it('returns brief list from JSON files', async () => {
    mockReaddirSync.mockReturnValue(['callsheet_2026-03-27.json', 'other.txt']);
    mockReadFileSync.mockReturnValue(JSON.stringify({ title: 'Test Brief', sections: [1, 2] }));
    const res = await request(server, 'GET', '/api/briefs');
    const data = json(res) as { briefs: Array<{ date: string; title: string; sections: number }> };
    expect(data.briefs).toHaveLength(1);
    expect(data.briefs[0].date).toBe('2026-03-27');
    expect(data.briefs[0].title).toBe('Test Brief');
    expect(data.briefs[0].sections).toBe(2);
  });
});

describe('GET /api/briefs/:date', () => {
  it('returns 404 when brief does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'GET', '/api/briefs/2026-03-27');
    expect(res.status).toBe(404);
  });

  it('returns brief JSON when it exists', async () => {
    mockExistsSync.mockReturnValue(true);
    const briefData = { title: 'Test', sections: [] };
    mockReadFileSync.mockReturnValue(JSON.stringify(briefData));
    const res = await request(server, 'GET', '/api/briefs/2026-03-27');
    expect(res.status).toBe(200);
    expect(json(res)).toEqual(briefData);
  });
});

describe('GET /api/briefs/:date/pdf', () => {
  it('returns 404 when PDF does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'GET', '/api/briefs/2026-03-27/pdf');
    expect(res.status).toBe(404);
  });

  it('returns PDF when it exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.from('%PDF-1.4') as unknown as string);
    const res = await request(server, 'GET', '/api/briefs/2026-03-27/pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });
});

describe('POST /api/briefs/generate', () => {
  it('returns 409 if generation is in progress', async () => {
    mockIsGenerating.mockReturnValue(true);
    const res = await request(server, 'POST', '/api/briefs/generate');
    expect(res.status).toBe(409);
  });

  it('generates a brief and returns result', async () => {
    mockLoadConfig.mockReturnValue({ connectors: {} });
    mockRunPipeline.mockResolvedValue({
      brief: { title: 'Today' },
      pdfPath: 'output/callsheet_2026-03-27.pdf',
      jsonPath: 'output/callsheet_2026-03-27.json',
    });
    const res = await request(server, 'POST', '/api/briefs/generate');
    expect(res.status).toBe(200);
    const data = json(res) as Record<string, unknown>;
    expect(data.success).toBe(true);
    expect(data.title).toBe('Today');
  });

  it('returns 500 on pipeline error', async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('Config not found');
    });
    const res = await request(server, 'POST', '/api/briefs/generate');
    expect(res.status).toBe(500);
    const data = json(res) as Record<string, unknown>;
    expect(data.error).toBe('Config not found');
  });
});

describe('GET /api/connectors', () => {
  it('returns connector list from registry', async () => {
    const registry = new Map([
      ['weather', { factory: jest.fn(), validate: jest.fn() }],
      ['todoist', { factory: jest.fn() }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({
      connectors: { weather: { enabled: true }, todoist: { enabled: true } },
    });
    const res = await request(server, 'GET', '/api/connectors');
    const data = json(res) as { connectors: Array<{ name: string; enabled: boolean }> };
    expect(data.connectors).toHaveLength(2);
    expect(data.connectors[0].name).toBe('weather');
    expect(data.connectors[0].enabled).toBe(true);
  });
});

describe('GET /api/connectors/:name', () => {
  it('returns 404 for unknown connector', async () => {
    mockGetRegistry.mockReturnValue(new Map());
    mockLoadConfig.mockReturnValue({ connectors: {} });
    const res = await request(server, 'GET', '/api/connectors/fake');
    expect(res.status).toBe(404);
  });

  it('returns connector detail with redacted secrets', async () => {
    const registry = new Map([
      ['todoist', { factory: jest.fn(), validate: () => [['check', 'ok', '']] }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({
      connectors: { todoist: { enabled: true, token_env: 'MY_SECRET' } },
    });
    const res = await request(server, 'GET', '/api/connectors/todoist');
    const data = json(res) as { name: string; config: Record<string, unknown> };
    expect(data.name).toBe('todoist');
    expect(data.config.token_env).toBe('•••••');
  });
});

describe('POST /api/connectors/:name/test', () => {
  it('returns validation checks', async () => {
    const registry = new Map([
      ['weather', { factory: jest.fn(), validate: () => [['✅', 'Lat set', null]] }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { weather: { enabled: true } } });
    const res = await request(server, 'POST', '/api/connectors/weather/test');
    const data = json(res) as { checks: Array<{ icon: string; message: string }> };
    expect(data.checks).toHaveLength(1);
    expect(data.checks[0].icon).toBe('✅');
  });
});

describe('GET /api/config', () => {
  it('returns parsed YAML config', async () => {
    mockReadFileSync.mockReturnValue('model: claude-sonnet-4-20250514\nprinter: test\n');
    const res = await request(server, 'GET', '/api/config');
    const data = json(res) as Record<string, unknown>;
    expect(data.model).toBe('claude-sonnet-4-20250514');
    expect(data.printer).toBe('test');
  });
});

describe('PUT /api/config', () => {
  it('writes config and returns success', async () => {
    const res = await request(server, 'PUT', '/api/config', { model: 'claude-opus-4-6' });
    expect(res.status).toBe(200);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

describe('GET /api/memory', () => {
  it('returns empty when memory dir does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'GET', '/api/memory');
    const data = json(res) as { memories: unknown[] };
    expect(data.memories).toEqual([]);
  });

  it('returns memory list', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['memory_2026-03-27.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify({ date: '2026-03-27', insights: ['test'] }));
    const res = await request(server, 'GET', '/api/memory');
    const data = json(res) as { memories: Array<{ date: string; insights: string[] }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].insights).toEqual(['test']);
  });
});

describe('DELETE /api/memory/:date', () => {
  it('returns 404 when memory not found', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'DELETE', '/api/memory/2026-03-27');
    expect(res.status).toBe(404);
  });

  it('deletes memory and returns success', async () => {
    mockExistsSync.mockReturnValue(true);
    const res = await request(server, 'DELETE', '/api/memory/2026-03-27');
    expect(res.status).toBe(200);
    expect(mockUnlinkSync).toHaveBeenCalled();
  });
});

describe('GET /api/schedule', () => {
  it('returns cron schedule', async () => {
    const res = await request(server, 'GET', '/api/schedule');
    const data = json(res) as { cron: string; timezone: string };
    expect(data.cron).toBeDefined();
    expect(data.timezone).toBeDefined();
  });
});

describe('GET /api/usage', () => {
  it('returns usage summary', async () => {
    const res = await request(server, 'GET', '/api/usage');
    const data = json(res) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(data).toHaveProperty('total_cost');
  });
});

describe('GET /api/usage/history', () => {
  it('returns usage history', async () => {
    const res = await request(server, 'GET', '/api/usage/history');
    const data = json(res) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(data).toHaveProperty('entries');
  });
});

describe('GET /api/logs', () => {
  it('returns empty when log file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'GET', '/api/logs');
    const data = json(res) as { lines: string[]; total: number };
    expect(data.lines).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('returns log lines', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('line1\nline2\nline3\n');
    const res = await request(server, 'GET', '/api/logs');
    const data = json(res) as { lines: string[]; total: number };
    expect(data.lines).toHaveLength(3);
    expect(data.total).toBe(3);
  });
});
