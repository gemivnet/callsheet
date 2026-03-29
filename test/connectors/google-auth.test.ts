import { jest } from '@jest/globals';

const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();
const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

const mockCreateServer = jest.fn();

jest.unstable_mockModule('node:http', () => ({
  createServer: mockCreateServer,
}));

const mockGenerateAuthUrl = jest.fn().mockReturnValue('https://auth.url');
const mockSetCredentials = jest.fn();
const mockGetToken = jest
  .fn<() => Promise<unknown>>()
  .mockResolvedValue({ tokens: { access_token: 'tok123', refresh_token: 'ref456' } });

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: mockGenerateAuthUrl,
        setCredentials: mockSetCredentials,
        getToken: mockGetToken,
      })),
    },
  },
}));

const {
  loadOAuth2,
  getCredentials,
  resolveCredsFile,
  buildAuthUrl,
  exchangeCodeAndSave,
  makeAuthFromConfig,
  runOAuthFlow,
} = await import('../../src/connectors/google-auth.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('google-auth', () => {
  describe('loadOAuth2', () => {
    it('should load credentials from installed app format', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          installed: {
            client_id: 'test-id',
            client_secret: 'test-secret',
            redirect_uris: ['http://localhost'],
          },
        }),
      );

      const client = loadOAuth2('/path/to/creds');
      expect(client).toBeDefined();
      expect(mockReadFileSync).toHaveBeenCalled();
    });

    it('should throw when credentials file not found', () => {
      mockExistsSync.mockReturnValue(false);

      expect(() => loadOAuth2('/path/to/creds')).toThrow('not found');
    });

    it('should use custom credentials filename', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          installed: {
            client_id: 'id',
            client_secret: 'secret',
            redirect_uris: [],
          },
        }),
      );

      loadOAuth2('/creds', 'custom_creds.json');
      const calledPath = mockReadFileSync.mock.calls[0][0] as string;
      expect(calledPath).toContain('custom_creds.json');
    });

    it('should load credentials from web app format', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          web: {
            client_id: 'web-id',
            client_secret: 'web-secret',
            redirect_uris: ['http://localhost'],
          },
        }),
      );

      const client = loadOAuth2('/path/to/creds');
      expect(client).toBeDefined();
    });
  });

  describe('getCredentials', () => {
    it('should load and set token credentials', () => {
      mockExistsSync.mockReturnValue(true);
      // First call: credentials file, second call: token exists check, third: token read
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.includes('token_')) {
          return JSON.stringify({ access_token: 'test', refresh_token: 'refresh' });
        }
        return JSON.stringify({
          installed: {
            client_id: 'id',
            client_secret: 'secret',
            redirect_uris: [],
          },
        });
      });

      const client = getCredentials('/creds', 'token_test.json');
      expect(client).toBeDefined();
    });

    it('should throw when token file not found', () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.includes('token_')) return false;
        return true;
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          installed: { client_id: 'id', client_secret: 'secret', redirect_uris: [] },
        }),
      );

      expect(() => getCredentials('/creds', 'token_missing.json')).toThrow('No valid credentials');
    });
  });

  describe('resolveCredsFile', () => {
    it('should prefer account credentials_file', () => {
      const result = resolveCredsFile(
        { name: 'test', credentials_file: 'acct_creds.json' },
        { credentials_file: 'global_creds.json' },
      );
      expect(result).toBe('acct_creds.json');
    });

    it('should fall back to config credentials_file', () => {
      const result = resolveCredsFile({ name: 'test' }, { credentials_file: 'global_creds.json' });
      expect(result).toBe('global_creds.json');
    });

    it('should return undefined when neither is set', () => {
      const result = resolveCredsFile({ name: 'test' }, {});
      expect(result).toBeUndefined();
    });

    it('should handle undefined account', () => {
      const result = resolveCredsFile(undefined, { credentials_file: 'creds.json' });
      expect(result).toBe('creds.json');
    });
  });

  describe('buildAuthUrl', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          installed: {
            client_id: 'id',
            client_secret: 'secret',
            redirect_uris: ['http://localhost'],
          },
        }),
      );
    });

    it('should return authUrl, oauth2, and tokenPath', () => {
      const result = buildAuthUrl('/creds', ['scope1'], 'token.json');
      expect(result.authUrl).toBe('https://auth.url');
      expect(result.oauth2).toBeDefined();
      expect(result.tokenPath).toContain('token.json');
    });

    it('should set the redirectUri on the oauth2 client', () => {
      const result = buildAuthUrl('/creds', ['scope1'], 'token.json', 'http://custom:4000/cb');
      expect((result.oauth2 as unknown as { redirectUri: string }).redirectUri).toBe(
        'http://custom:4000/cb',
      );
    });

    it('should call generateAuthUrl with offline access and scopes', () => {
      buildAuthUrl('/creds', ['scope1', 'scope2'], 'token.json');
      expect(mockGenerateAuthUrl).toHaveBeenCalledWith({
        access_type: 'offline',
        scope: ['scope1', 'scope2'],
      });
    });

    it('should pass custom credsFile to loadOAuth2', () => {
      buildAuthUrl('/creds', ['scope1'], 'token.json', undefined, 'custom_creds.json');
      const calledPath = mockReadFileSync.mock.calls[0][0] as string;
      expect(calledPath).toContain('custom_creds.json');
    });
  });

  describe('exchangeCodeAndSave', () => {
    it('should exchange code, set credentials, and write token file', async () => {
      const mockOAuth2 = {
        getToken: mockGetToken,
        setCredentials: mockSetCredentials,
      };

      await exchangeCodeAndSave(mockOAuth2 as never, 'auth-code-123', '/creds/token.json');

      expect(mockGetToken).toHaveBeenCalledWith('auth-code-123');
      expect(mockSetCredentials).toHaveBeenCalledWith({
        access_token: 'tok123',
        refresh_token: 'ref456',
      });
      expect(mockMkdirSync).toHaveBeenCalledWith('/creds', { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/creds/token.json',
        JSON.stringify({ access_token: 'tok123', refresh_token: 'ref456' }, null, 2),
      );
    });
  });

  describe('runOAuthFlow', () => {
    let mockProcessExit: jest.SpiedFunction<typeof process.exit>;

    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          installed: {
            client_id: 'id',
            client_secret: 'secret',
            redirect_uris: ['http://localhost'],
          },
        }),
      );

      mockProcessExit = jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as typeof process.exit);
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      mockProcessExit.mockRestore();
      (console.log as jest.Mock).mockRestore?.();
    });

    it('should create server, exchange code, and exit', async () => {
      const mockServer = {
        on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'request') {
            const mockReq = { url: '/oauth2callback?code=test-code' };
            const mockRes = {
              writeHead: jest.fn(),
              end: jest.fn(),
            };
            // Call handler asynchronously to let the Promise constructor finish
            setTimeout(() => handler(mockReq, mockRes), 0);
          }
        }),
        listen: jest.fn(),
        close: jest.fn().mockImplementation((cb: () => void) => cb()),
        unref: jest.fn(),
      };
      mockCreateServer.mockReturnValue(mockServer);

      await runOAuthFlow('/creds', ['scope1'], 'token.json', 'TestLabel', 'myaccount');

      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockServer.listen).toHaveBeenCalledWith(3000);
      expect(mockGetToken).toHaveBeenCalledWith('test-code');
      expect(mockServer.close).toHaveBeenCalled();
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    });

    it('should log with account name when provided', async () => {
      const mockServer = {
        on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'request') {
            setTimeout(
              () =>
                handler(
                  { url: '/oauth2callback?code=c' },
                  { writeHead: jest.fn(), end: jest.fn() },
                ),
              0,
            );
          }
        }),
        listen: jest.fn(),
        close: jest.fn().mockImplementation((cb: () => void) => cb()),
        unref: jest.fn(),
      };
      mockCreateServer.mockReturnValue(mockServer);

      await runOAuthFlow('/creds', ['scope1'], 'token.json', 'Gmail', 'work');

      expect(console.log).toHaveBeenCalledWith('Authorizing Gmail for "work"...');
    });

    it('should log without account name when not provided', async () => {
      const mockServer = {
        on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'request') {
            setTimeout(
              () =>
                handler(
                  { url: '/oauth2callback?code=c' },
                  { writeHead: jest.fn(), end: jest.fn() },
                ),
              0,
            );
          }
        }),
        listen: jest.fn(),
        close: jest.fn().mockImplementation((cb: () => void) => cb()),
        unref: jest.fn(),
      };
      mockCreateServer.mockReturnValue(mockServer);

      await runOAuthFlow('/creds', ['scope1'], 'token.json', 'Gmail');

      expect(console.log).toHaveBeenCalledWith('Authorizing Gmail...');
    });

    it('should reject on timeout', async () => {
      jest.useFakeTimers();

      const mockServer = {
        on: jest.fn().mockImplementation(() => {
          // Don't call the handler — let it timeout
        }),
        listen: jest.fn(),
        close: jest.fn().mockImplementation((cb: () => void) => cb()),
        unref: jest.fn(),
      };
      mockCreateServer.mockReturnValue(mockServer);

      const promise = runOAuthFlow('/creds', ['scope1'], 'token.json', 'Test');

      // Advance timers past the 2-minute timeout
      jest.advanceTimersByTime(120_001);

      await expect(promise).rejects.toThrow('Auth timeout (2 min)');

      jest.useRealTimers();
    });

    it('should respond 400 when no code in request', async () => {
      const mockRes400 = { writeHead: jest.fn(), end: jest.fn() };
      const mockResOk = { writeHead: jest.fn(), end: jest.fn() };

      const mockServer = {
        on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'request') {
            setTimeout(() => {
              // First request: no code
              handler({ url: '/oauth2callback' }, mockRes400);
              // Second request: has code
              handler({ url: '/oauth2callback?code=ok' }, mockResOk);
            }, 0);
          }
        }),
        listen: jest.fn(),
        close: jest.fn().mockImplementation((cb: () => void) => cb()),
        unref: jest.fn(),
      };
      mockCreateServer.mockReturnValue(mockServer);

      await runOAuthFlow('/creds', ['scope1'], 'token.json', 'Test');

      expect(mockRes400.writeHead).toHaveBeenCalledWith(400);
      expect(mockRes400.end).toHaveBeenCalledWith('No code found');
      expect(mockResOk.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    });
  });

  describe('makeAuthFromConfig', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          installed: {
            client_id: 'id',
            client_secret: 'secret',
            redirect_uris: ['http://localhost'],
          },
        }),
      );

      jest
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as typeof process.exit);
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      (process.exit as unknown as jest.Mock).mockRestore?.();
      (console.log as jest.Mock).mockRestore?.();
    });

    function setupMockServer() {
      const mockServer = {
        on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'request') {
            setTimeout(
              () =>
                handler(
                  { url: '/oauth2callback?code=c' },
                  { writeHead: jest.fn(), end: jest.fn() },
                ),
              0,
            );
          }
        }),
        listen: jest.fn(),
        close: jest.fn().mockImplementation((cb: () => void) => cb()),
        unref: jest.fn(),
      };
      mockCreateServer.mockReturnValue(mockServer);
      return mockServer;
    }

    it('should return a ConnectorAuth function', () => {
      const authFn = makeAuthFromConfig(['scope'], 'Gmail', 'gmail_token');
      expect(typeof authFn).toBe('function');
    });

    it('should use account-specific token file when accountName matches', async () => {
      setupMockServer();

      const authFn = makeAuthFromConfig(['scope'], 'Gmail', 'gmail_token');
      const config = {
        accounts: [{ name: 'Work', credentials_file: 'work_creds.json' }],
      };

      await authFn('/creds', config, 'Work');

      // Should write to gmail_token_work.json (lowercased)
      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toContain('gmail_token_work.json');
    });

    it('should use default token file when no accountName', async () => {
      setupMockServer();

      const authFn = makeAuthFromConfig(['scope'], 'Gmail', 'gmail_token');
      await authFn('/creds', {}, undefined);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toContain('gmail_token.json');
    });

    it('should use custom credentials_file from matched account', async () => {
      setupMockServer();

      const authFn = makeAuthFromConfig(['scope'], 'Gmail', 'gmail_token');
      const config = {
        accounts: [{ name: 'Personal', credentials_file: 'personal_creds.json' }],
      };

      await authFn('/creds', config, 'Personal');

      // loadOAuth2 reads the creds file; check it was called with personal_creds.json
      const readCalls = mockReadFileSync.mock.calls.map((c) => c[0] as string);
      expect(readCalls.some((p) => p.includes('personal_creds.json'))).toBe(true);
    });

    it('should handle accountName that does not match any account', async () => {
      setupMockServer();

      const authFn = makeAuthFromConfig(['scope'], 'Gmail', 'gmail_token');
      const config = {
        accounts: [{ name: 'Work' }],
      };

      // "Unknown" doesn't match "Work", so no custom creds file
      await authFn('/creds', config, 'Unknown');

      const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toContain('gmail_token_unknown.json');
    });
  });
});
