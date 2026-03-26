import { jest } from '@jest/globals';

const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();
const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: jest.fn(),
  existsSync: mockExistsSync,
  mkdirSync: jest.fn(),
}));

jest.unstable_mockModule('node:http', () => ({
  createServer: jest.fn(),
}));

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: jest.fn().mockReturnValue('https://auth.url'),
        setCredentials: jest.fn(),
        getToken: jest.fn<() => Promise<unknown>>().mockResolvedValue({ tokens: {} }),
      })),
    },
  },
}));

const { loadOAuth2, getCredentials, resolveCredsFile } = await import(
  '../../src/connectors/google-auth.js'
);

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
});
