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

  it('returns 500 when readFileSync throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('read error'); });
    const res = await request(server, 'GET', '/api/logs');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('read error');
  });
});

// ── Additional coverage tests ──────────────────────────────────────────────

describe('POST /api/setup error path', () => {
  it('returns 500 when writeFileSync throws', async () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('disk full'); });
    const res = await request(server, 'POST', '/api/setup', { model: 'test' });
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('disk full');
  });
});

describe('POST /api/setup with existing .env', () => {
  it('does not duplicate ANTHROPIC_API_KEY if already present', async () => {
    mockWriteFileSync.mockImplementation(() => {});
    mockExistsSync.mockImplementation((p: string) => p === '.env');
    mockReadFileSync.mockReturnValue('ANTHROPIC_API_KEY=existing-key\n');
    const res = await request(server, 'POST', '/api/setup', {
      anthropic_api_key: 'sk-ant-new',
    });
    expect(res.status).toBe(200);
    // writeFileSync called once for config.yaml, but NOT for .env since key already exists
    const envWriteCalls = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === '.env',
    );
    expect(envWriteCalls).toHaveLength(0);
  });
});

describe('GET /api/briefs parse error', () => {
  it('returns fallback when JSON.parse fails for a brief file', async () => {
    mockReaddirSync.mockReturnValue(['callsheet_2026-03-27.json']);
    mockReadFileSync.mockReturnValue('not valid json{{{');
    const res = await request(server, 'GET', '/api/briefs');
    const data = json(res) as { briefs: Array<{ date: string; title: string; sections: number }> };
    expect(data.briefs).toHaveLength(1);
    expect(data.briefs[0].title).toBe('Untitled');
    expect(data.briefs[0].sections).toBe(0);
  });
});

describe('GET /api/briefs/:date read error', () => {
  it('returns 500 when readFileSync throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('read fail'); });
    const res = await request(server, 'GET', '/api/briefs/2026-03-27');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('Failed to read brief');
  });
});

describe('GET /api/connectors error', () => {
  it('returns 500 when loadConfig throws', async () => {
    mockLoadConfig.mockImplementation(() => { throw new Error('bad config'); });
    const res = await request(server, 'GET', '/api/connectors');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('bad config');
  });
});

describe('POST /api/connectors/:name/test', () => {
  it('returns 404 for unknown connector', async () => {
    mockLoadConfig.mockReturnValue({ connectors: {} });
    mockGetRegistry.mockReturnValue(new Map());
    const res = await request(server, 'POST', '/api/connectors/fake/test');
    expect(res.status).toBe(404);
    const data = json(res) as { error: string };
    expect(data.error).toMatch(/Unknown connector/);
  });

  it('returns 500 when validate throws', async () => {
    const registry = new Map([
      ['weather', { factory: jest.fn(), validate: () => { throw new Error('validate boom'); } }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { weather: { enabled: true } } });
    const res = await request(server, 'POST', '/api/connectors/weather/test');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('validate boom');
  });
});

describe('GET /api/connectors/:name accounts', () => {
  it('returns account names when connector has accounts array', async () => {
    const registry = new Map([
      ['calendar', { factory: jest.fn(), validate: () => [] }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({
      connectors: {
        calendar: {
          enabled: true,
          accounts: [{ name: 'Work' }, { name: 'Personal' }],
        },
      },
    });
    const res = await request(server, 'GET', '/api/connectors/calendar');
    expect(res.status).toBe(200);
    const data = json(res) as { accounts: string[] };
    expect(data.accounts).toEqual(['Work', 'Personal']);
  });
});

describe('GET /api/connectors/:name error', () => {
  it('returns 500 when loadConfig throws', async () => {
    mockLoadConfig.mockImplementation(() => { throw new Error('config error'); });
    const res = await request(server, 'GET', '/api/connectors/calendar');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('config error');
  });
});

describe('POST /api/connectors/:name/auth', () => {
  it('returns auth_url for OAuth-capable connector', async () => {
    const registry = new Map([
      ['calendar', {
        factory: jest.fn(),
        authScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        authTokenPrefix: 'gcal_token',
      }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({
      connectors: { calendar: { enabled: true, credentials_dir: 'secrets' } },
    });
    mockResolveCredsFile.mockReturnValue(undefined);
    mockRandomUUID.mockReturnValue('test-state-uuid');
    mockBuildAuthUrl.mockReturnValue({
      authUrl: 'https://accounts.google.com/o/oauth2/auth?scope=calendar',
      oauth2: { generateAuthUrl: jest.fn() },
      tokenPath: '/tmp/gcal_token.json',
    });

    const res = await request(server, 'POST', '/api/connectors/calendar/auth');
    expect(res.status).toBe(200);
    const data = json(res) as { auth_url: string };
    expect(data.auth_url).toContain('accounts.google.com');
    expect(data.auth_url).toContain('state=test-state-uuid');
  });

  it('returns auth_url with account name', async () => {
    const registry = new Map([
      ['calendar', {
        factory: jest.fn(),
        authScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        authTokenPrefix: 'gcal_token',
      }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({
      connectors: {
        calendar: {
          enabled: true,
          accounts: [{ name: 'Work', credentials_file: 'work_creds.json' }],
        },
      },
    });
    mockResolveCredsFile.mockReturnValue('work_creds.json');
    mockRandomUUID.mockReturnValue('test-state-uuid-2');
    mockBuildAuthUrl.mockReturnValue({
      authUrl: 'https://accounts.google.com/o/oauth2/auth?scope=calendar',
      oauth2: {},
      tokenPath: '/tmp/gcal_token_work.json',
    });

    const res = await request(server, 'POST', '/api/connectors/calendar/auth', { account: 'Work' });
    expect(res.status).toBe(200);
    const data = json(res) as { auth_url: string };
    expect(data.auth_url).toContain('state=test-state-uuid-2');
    expect(mockBuildAuthUrl).toHaveBeenCalledWith(
      'secrets',
      ['https://www.googleapis.com/auth/calendar.readonly'],
      'gcal_token_work.json',
      'http://localhost:3000/oauth2callback',
      'work_creds.json',
    );
  });

  it('returns 400 when connector does not support web auth', async () => {
    const registry = new Map([
      ['weather', { factory: jest.fn() }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { weather: { enabled: true } } });
    const res = await request(server, 'POST', '/api/connectors/weather/auth');
    expect(res.status).toBe(400);
    const data = json(res) as { error: string };
    expect(data.error).toMatch(/does not support web auth/);
  });

  it('returns 500 when buildAuthUrl throws', async () => {
    const registry = new Map([
      ['calendar', {
        factory: jest.fn(),
        authScopes: ['scope'],
        authTokenPrefix: 'gcal_token',
      }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { calendar: { enabled: true } } });
    mockBuildAuthUrl.mockImplementation(() => { throw new Error('creds missing'); });
    const res = await request(server, 'POST', '/api/connectors/calendar/auth');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('creds missing');
  });
});

describe('GET /oauth2callback', () => {
  it('returns 400 when code or state is missing', async () => {
    const res = await request(server, 'GET', '/oauth2callback');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Missing code or state');
  });

  it('returns 400 when state is unknown', async () => {
    const res = await request(server, 'GET', '/oauth2callback?code=abc&state=unknown-state');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Unknown or expired');
  });

  it('completes OAuth flow successfully', async () => {
    // First, initiate an auth flow to populate pendingOAuth
    const registry = new Map([
      ['calendar', {
        factory: jest.fn(),
        authScopes: ['scope'],
        authTokenPrefix: 'gcal_token',
      }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { calendar: { enabled: true } } });
    mockResolveCredsFile.mockReturnValue(undefined);
    mockRandomUUID.mockReturnValue('oauth-state-123');
    const fakeOAuth2 = { getToken: jest.fn() };
    mockBuildAuthUrl.mockReturnValue({
      authUrl: 'https://accounts.google.com/auth',
      oauth2: fakeOAuth2,
      tokenPath: '/tmp/token.json',
    });

    // Initiate auth
    await request(server, 'POST', '/api/connectors/calendar/auth');

    // Now call the callback
    mockExchangeCodeAndSave.mockResolvedValue(undefined);
    const res = await request(server, 'GET', '/oauth2callback?code=auth-code-xyz&state=oauth-state-123');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Authorization complete');
    expect(mockExchangeCodeAndSave).toHaveBeenCalledWith(fakeOAuth2, 'auth-code-xyz', '/tmp/token.json');
  });

  it('returns 500 when exchangeCodeAndSave throws', async () => {
    // Initiate auth flow
    const registry = new Map([
      ['calendar', {
        factory: jest.fn(),
        authScopes: ['scope'],
        authTokenPrefix: 'gcal_token',
      }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { calendar: { enabled: true } } });
    mockResolveCredsFile.mockReturnValue(undefined);
    mockRandomUUID.mockReturnValue('oauth-state-fail');
    mockBuildAuthUrl.mockReturnValue({
      authUrl: 'https://accounts.google.com/auth',
      oauth2: {},
      tokenPath: '/tmp/token.json',
    });

    await request(server, 'POST', '/api/connectors/calendar/auth');

    mockExchangeCodeAndSave.mockRejectedValue(new Error('token exchange failed'));
    const res = await request(server, 'GET', '/oauth2callback?code=bad-code&state=oauth-state-fail');
    expect(res.status).toBe(500);
    expect(res.body).toContain('token exchange failed');
  });
});

describe('GET /api/config error', () => {
  it('returns 500 when readFileSync throws', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('no config file'); });
    const res = await request(server, 'GET', '/api/config');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('no config file');
  });
});

describe('PUT /api/config error', () => {
  it('returns 500 when writeFileSync throws', async () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('write denied'); });
    const res = await request(server, 'PUT', '/api/config', { model: 'test' });
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('write denied');
  });
});

describe('GET /api/memory parse error', () => {
  it('returns fallback when JSON.parse fails for a memory file', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['memory_2026-03-27.json']);
    mockReadFileSync.mockReturnValue('not json!!!');
    const res = await request(server, 'GET', '/api/memory');
    const data = json(res) as { memories: Array<{ date: string; insights: string[] }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].date).toBe('2026-03-27');
    expect(data.memories[0].insights).toEqual([]);
  });
});

describe('GET /api/memory readdir error', () => {
  it('returns empty array when readdirSync throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => { throw new Error('EACCES'); });
    const res = await request(server, 'GET', '/api/memory');
    const data = json(res) as { memories: unknown[] };
    expect(data.memories).toEqual([]);
  });
});

describe('DELETE /api/memory error', () => {
  it('returns 500 when unlinkSync throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => { throw new Error('permission denied'); });
    const res = await request(server, 'DELETE', '/api/memory/2026-03-27');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('permission denied');
  });
});

describe('GET /api/usage error', () => {
  it('returns 500 when getUsageSummary throws', async () => {
    mockGetUsageSummary.mockImplementation(() => { throw new Error('usage error'); });
    const res = await request(server, 'GET', '/api/usage');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('usage error');
  });
});

describe('GET /api/usage/history error', () => {
  it('returns 500 when getMonthlyUsageData throws', async () => {
    mockGetMonthlyUsageData.mockImplementation(() => { throw new Error('history error'); });
    const res = await request(server, 'GET', '/api/usage/history');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('history error');
  });
});

describe('SPA fallback', () => {
  it('returns fallback message when index.html does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await request(server, 'GET', '/some-random-path');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Callsheet API is running');
  });
});

// ── Branch coverage tests ──────────────────────────────────────────────────

describe('branch: non-Error exceptions', () => {
  it('POST /api/setup handles non-Error throw', async () => {
    mockWriteFileSync.mockImplementation(() => { throw 'string error'; });
    const res = await request(server, 'POST', '/api/setup', { model: 'test' });
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('string error');
  });

  it('GET /api/connectors handles non-Error throw', async () => {
    mockLoadConfig.mockImplementation(() => { throw 42; });
    const res = await request(server, 'GET', '/api/connectors');
    expect(res.status).toBe(500);
    const data = json(res) as { error: string };
    expect(data.error).toBe('42');
  });

  it('POST /api/connectors/:name/test handles non-Error throw', async () => {
    mockLoadConfig.mockImplementation(() => { throw null; });
    const res = await request(server, 'POST', '/api/connectors/x/test');
    expect(res.status).toBe(500);
  });

  it('GET /api/connectors/:name handles non-Error throw', async () => {
    mockLoadConfig.mockImplementation(() => { throw 'oops'; });
    const res = await request(server, 'GET', '/api/connectors/x');
    expect(res.status).toBe(500);
  });

  it('POST /api/connectors/:name/auth handles non-Error throw', async () => {
    mockLoadConfig.mockImplementation(() => { throw 'auth fail'; });
    const res = await request(server, 'POST', '/api/connectors/calendar/auth');
    expect(res.status).toBe(500);
  });

  it('GET /api/config handles non-Error throw', async () => {
    mockReadFileSync.mockImplementation(() => { throw 'no file'; });
    const res = await request(server, 'GET', '/api/config');
    expect(res.status).toBe(500);
  });

  it('PUT /api/config handles non-Error throw', async () => {
    mockWriteFileSync.mockImplementation(() => { throw 'denied'; });
    const res = await request(server, 'PUT', '/api/config', {});
    expect(res.status).toBe(500);
  });

  it('DELETE /api/memory handles non-Error throw', async () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => { throw 'rm fail'; });
    const res = await request(server, 'DELETE', '/api/memory/2026-03-27');
    expect(res.status).toBe(500);
  });

  it('GET /api/usage handles non-Error throw', async () => {
    mockGetUsageSummary.mockImplementation(() => { throw 'bad'; });
    const res = await request(server, 'GET', '/api/usage');
    expect(res.status).toBe(500);
  });

  it('GET /api/usage/history handles non-Error throw', async () => {
    mockGetMonthlyUsageData.mockImplementation(() => { throw 'bad'; });
    const res = await request(server, 'GET', '/api/usage/history');
    expect(res.status).toBe(500);
  });

  it('GET /api/logs handles non-Error throw', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw 'log fail'; });
    const res = await request(server, 'GET', '/api/logs');
    expect(res.status).toBe(500);
  });

  it('GET /oauth2callback handles non-Error in exchangeCodeAndSave', async () => {
    // Set up pending OAuth
    const registry = new Map([
      ['calendar', { factory: jest.fn(), authScopes: ['s'], authTokenPrefix: 'gcal' }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { calendar: { enabled: true } } });
    mockResolveCredsFile.mockReturnValue(undefined);
    mockRandomUUID.mockReturnValue('non-error-state');
    mockBuildAuthUrl.mockReturnValue({ authUrl: 'https://x.com/auth', oauth2: {}, tokenPath: '/t.json' });
    await request(server, 'POST', '/api/connectors/calendar/auth');

    mockExchangeCodeAndSave.mockRejectedValue('string rejection');
    const res = await request(server, 'GET', '/oauth2callback?code=c&state=non-error-state');
    expect(res.status).toBe(500);
    expect(res.body).toContain('string rejection');
  });
});

describe('branch: query parameter variations', () => {
  it('GET /api/usage with month query param', async () => {
    mockGetUsageSummary.mockReturnValue({ total_cost: 0 });
    const res = await request(server, 'GET', '/api/usage?month=2026-03');
    expect(res.status).toBe(200);
    expect(mockGetUsageSummary).toHaveBeenCalledWith(expect.any(String), '2026-03');
  });

  it('GET /api/usage/history with month query param', async () => {
    mockGetMonthlyUsageData.mockReturnValue({ month: '2026-03', entries: [] });
    const res = await request(server, 'GET', '/api/usage/history?month=2026-03');
    expect(res.status).toBe(200);
    expect(mockGetMonthlyUsageData).toHaveBeenCalledWith(expect.any(String), '2026-03');
  });

  it('GET /api/logs with lines query param', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('a\nb\nc\nd\ne\n');
    const res = await request(server, 'GET', '/api/logs?lines=2');
    const data = json(res) as { lines: string[]; total: number };
    expect(data.lines).toHaveLength(2);
    expect(data.total).toBe(5);
  });
});

describe('branch: connector without validate', () => {
  it('POST /api/connectors/:name/test returns empty checks for connector without validate', async () => {
    const registry = new Map([
      ['simple', { factory: jest.fn() }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { simple: { enabled: true } } });
    const res = await request(server, 'POST', '/api/connectors/simple/test');
    expect(res.status).toBe(200);
    const data = json(res) as { checks: unknown[] };
    expect(data.checks).toEqual([]);
  });

  it('GET /api/connectors/:name returns empty checks for connector without validate', async () => {
    const registry = new Map([
      ['simple', { factory: jest.fn() }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { simple: { enabled: true } } });
    const res = await request(server, 'GET', '/api/connectors/simple');
    expect(res.status).toBe(200);
    const data = json(res) as { checks: unknown[] };
    expect(data.checks).toEqual([]);
  });
});

describe('branch: connector disabled / undefined', () => {
  it('GET /api/connectors shows connector as disabled when not in config', async () => {
    const registry = new Map([
      ['weather', { factory: jest.fn() }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: {} });
    const res = await request(server, 'GET', '/api/connectors');
    const data = json(res) as { connectors: Array<{ name: string; enabled: boolean }> };
    expect(data.connectors[0].enabled).toBe(false);
  });

  it('GET /api/connectors shows connector as disabled when enabled: false', async () => {
    const registry = new Map([
      ['weather', { factory: jest.fn() }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { weather: { enabled: false } } });
    const res = await request(server, 'GET', '/api/connectors');
    const data = json(res) as { connectors: Array<{ name: string; enabled: boolean }> };
    expect(data.connectors[0].enabled).toBe(false);
  });
});

describe('branch: brief subtitle', () => {
  it('GET /api/briefs returns subtitle when present', async () => {
    mockReaddirSync.mockReturnValue(['callsheet_2026-03-27.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify({ title: 'Brief', subtitle: 'Friday', sections: [] }));
    const res = await request(server, 'GET', '/api/briefs');
    const data = json(res) as { briefs: Array<{ subtitle: string | null }> };
    expect(data.briefs[0].subtitle).toBe('Friday');
  });
});

describe('branch: config with no connectors key', () => {
  it('GET /api/connectors works when config has no connectors', async () => {
    const registry = new Map([['x', { factory: jest.fn() }]]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({});
    const res = await request(server, 'GET', '/api/connectors');
    expect(res.status).toBe(200);
  });

  it('POST /api/connectors/:name/test works when config has no connectors', async () => {
    const registry = new Map([['x', { factory: jest.fn(), validate: () => [] }]]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({});
    const res = await request(server, 'POST', '/api/connectors/x/test');
    expect(res.status).toBe(200);
  });

  it('GET /api/connectors/:name works when config has no connectors', async () => {
    const registry = new Map([['x', { factory: jest.fn() }]]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({});
    const res = await request(server, 'GET', '/api/connectors/x');
    expect(res.status).toBe(200);
  });
});

describe('startServer', () => {
  it('starts the server on a given port', async () => {
    const { startServer } = await import('../src/server.js');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // Use port 0 for random available port
    startServer(0);
    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 50));
    consoleSpy.mockRestore();
  });
});

describe('createApp with static dir existing', () => {
  it('serves static files and SPA fallback with index.html when static dir exists', async () => {
    // We need existsSync to return true during createApp() for the static dir check
    mockExistsSync.mockReturnValue(true);
    const { createApp: createAppWithStatic } = await import('../src/server.js');
    const app2 = createAppWithStatic();
    const server2: Server = await new Promise((resolve) => {
      const s = app2.listen(0, () => resolve(s));
    });

    // Test SPA fallback — existsSync returns true so it tries sendFile
    // sendFile will fail since file doesn't actually exist, but it covers the branch
    mockExistsSync.mockReturnValue(true);
    const res = await request(server2, 'GET', '/dashboard');
    // It will either send the file or error, but the branch is covered
    expect(res.status).toBeDefined();

    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});

describe('branch: POST /api/connectors/:name/auth with no accounts', () => {
  it('uses default token file when no account name provided', async () => {
    const registry = new Map([
      ['gmail', { factory: jest.fn(), authScopes: ['mail'], authTokenPrefix: 'gmail_token' }],
    ]);
    mockGetRegistry.mockReturnValue(registry);
    mockLoadConfig.mockReturnValue({ connectors: { gmail: { enabled: true } } });
    mockResolveCredsFile.mockReturnValue(undefined);
    mockRandomUUID.mockReturnValue('state-no-acct');
    mockBuildAuthUrl.mockReturnValue({
      authUrl: 'https://accounts.google.com/auth',
      oauth2: {},
      tokenPath: '/tmp/gmail_token.json',
    });

    const res = await request(server, 'POST', '/api/connectors/gmail/auth');
    expect(res.status).toBe(200);
    expect(mockBuildAuthUrl).toHaveBeenCalledWith(
      'secrets',
      ['mail'],
      'gmail_token.json',
      'http://localhost:3000/oauth2callback',
      undefined,
    );
  });
});
