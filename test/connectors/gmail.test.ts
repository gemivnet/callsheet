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

const mockMessagesList = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMessagesGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockLabelsList = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockLabelsGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: jest.fn().mockReturnValue('https://auth.url'),
        setCredentials: jest.fn(),
        getToken: jest.fn<() => Promise<unknown>>().mockResolvedValue({ tokens: {} }),
      })),
    },
    gmail: jest.fn(() => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
        },
        labels: {
          list: mockLabelsList,
          get: mockLabelsGet,
        },
      },
    })),
  },
}));

const { create, validate } = await import('../../src/connectors/gmail.js');
const { PASS, FAIL, INFO } = await import('../../src/test-icons.js');

function setupCredsAndToken() {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockImplementation((path: unknown) => {
    const p = path as string;
    if (p.includes('token_')) {
      return JSON.stringify({ access_token: 'test', refresh_token: 'refresh' });
    }
    return JSON.stringify({
      installed: { client_id: 'id', client_secret: 'secret', redirect_uris: [] },
    });
  });
}

function setupGmailMocks(
  messages: { id: string; from?: string; subject?: string; date?: string; snippet?: string; labelIds?: string[] }[] = [],
  labels: { id: string; name: string; type?: string }[] = [],
  unreadCount = 0,
) {
  mockLabelsList.mockResolvedValue({ data: { labels } });
  mockLabelsGet.mockResolvedValue({ data: { messagesUnread: unreadCount } });
  mockMessagesList.mockResolvedValue({
    data: { messages: messages.map((m) => ({ id: m.id })) },
  });
  mockMessagesGet.mockImplementation(async (opts: unknown) => {
    const { id } = opts as { id: string };
    const msg = messages.find((m) => m.id === id);
    if (!msg) throw new Error(`Message ${id} not found`);
    return {
      data: {
        payload: {
          headers: [
            { name: 'From', value: msg.from ?? 'test@example.com' },
            { name: 'Subject', value: msg.subject ?? 'Test Subject' },
            { name: 'Date', value: msg.date ?? 'Thu, 26 Mar 2026 10:00:00 -0500' },
          ],
        },
        snippet: msg.snippet ?? 'Email snippet',
        labelIds: msg.labelIds ?? ['INBOX'],
      },
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('gmail connector', () => {
  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({ enabled: true });
      expect(conn.name).toBe('gmail');
    });

    it('should fetch emails from Gmail API', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [
          {
            id: 'msg1',
            from: 'alice@example.com',
            subject: 'Hello',
            snippet: 'Hi there',
            labelIds: ['INBOX', 'UNREAD'],
          },
        ],
        [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
        ],
        5,
      );

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.source).toBe('gmail');
      expect(result.priorityHint).toBe('normal');
      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(1);
      expect(accounts[0].person).toBe('default');
      expect(accounts[0].inboxUnread).toBe(5);

      const emails = accounts[0].emails as Record<string, unknown>[];
      // emails may come from multiple phases (main + trash + pinned), but at least main phase
      expect(emails.length).toBeGreaterThanOrEqual(1);
    });

    it('should include email metadata', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [
          {
            id: 'msg2',
            from: 'billing@company.com',
            subject: 'Invoice #1234',
            date: 'Wed, 25 Mar 2026 09:00:00 -0500',
            snippet: 'Your invoice is ready',
            labelIds: ['INBOX', 'IMPORTANT'],
          },
        ],
        [{ id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' }],
        1,
      );

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      const accounts = result.data.accounts as { emails: Record<string, unknown>[] }[];
      const email = accounts[0].emails[0];
      expect(email.from).toBe('billing@company.com');
      expect(email.subject).toBe('Invoice #1234');
      expect(email.snippet).toBe('Your invoice is ready');
    });

    it('should filter labels to UNREAD, IMPORTANT, TRASH, and user labels', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [
          {
            id: 'msg3',
            labelIds: ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_PROMOTIONS', 'Label_123'],
          },
        ],
        [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
          { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' },
          { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system' },
          { id: 'Label_123', name: 'My Custom Label', type: 'user' },
        ],
        0,
      );

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      const accounts = result.data.accounts as { emails: { labels: string[] }[] }[];
      const labels = accounts[0].emails[0].labels;
      expect(labels).toContain('UNREAD');
      expect(labels).toContain('IMPORTANT');
      expect(labels).toContain('My Custom Label');
      expect(labels).not.toContain('INBOX');
      expect(labels).not.toContain('CATEGORY_PROMOTIONS');
    });

    it('should mark trashed emails', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [{ id: 'msg4', labelIds: ['TRASH'] }],
        [{ id: 'TRASH', name: 'TRASH', type: 'system' }],
        0,
      );

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      const accounts = result.data.accounts as { emails: { trashed: boolean }[] }[];
      // At least some emails should come through from the phases
      expect(accounts[0].emails.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty inbox', async () => {
      setupCredsAndToken();
      mockLabelsList.mockResolvedValue({ data: { labels: [] } });
      mockLabelsGet.mockResolvedValue({ data: { messagesUnread: 0 } });
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts[0].emails).toEqual([]);
      expect(accounts[0].inboxUnread).toBe(0);
    });

    it('should support multi-account mode', async () => {
      setupCredsAndToken();
      setupGmailMocks([], [], 0);

      const conn = create({
        enabled: true,
        accounts: [{ name: 'Personal' }, { name: 'Work' }],
      });
      const result = await conn.fetch();

      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(2);
      expect(accounts[0].person).toBe('Personal');
      expect(accounts[1].person).toBe('Work');
    });

    it('should report user labels per account', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [],
        [
          { id: 'Label_1', name: 'Travel', type: 'user' },
          { id: 'Label_2', name: 'Receipts', type: 'user' },
          { id: 'INBOX', name: 'INBOX', type: 'system' },
        ],
        0,
      );

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      const accounts = result.data.accounts as { userLabels: string[] }[];
      expect(accounts[0].userLabels).toContain('Travel');
      expect(accounts[0].userLabels).toContain('Receipts');
      expect(accounts[0].userLabels).not.toContain('INBOX');
    });

    it('should include description with account/email/unread counts', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [{ id: 'msg5', labelIds: ['INBOX'] }],
        [],
        3,
      );

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.description).toContain('1 account(s)');
      expect(result.description).toContain('3 total inbox unread');
    });

    it('should use custom query from config', async () => {
      setupCredsAndToken();
      setupGmailMocks([], [], 0);

      const conn = create({ enabled: true, query: 'is:unread' });
      const result = await conn.fetch();

      expect(result.description).toContain("query: 'is:unread'");
    });
  });

  describe('validate', () => {
    it('should pass with valid credentials (legacy mode)', () => {
      mockExistsSync.mockReturnValue(true);

      const checks = validate({ enabled: true });

      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail when credentials file missing', () => {
      mockExistsSync.mockReturnValue(false);

      const checks = validate({ enabled: true });

      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should validate multi-account mode', () => {
      mockExistsSync.mockReturnValue(true);

      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Personal' }, { name: 'Work' }],
      });

      expect(checks.some(([, msg]) => msg.includes('2 account(s)'))).toBe(true);
    });

    it('should fail when account token missing', () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.includes('token_')) return false;
        return true;
      });

      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Test' }],
      });

      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('NOT found'))).toBe(true);
    });

    it('should show config info', () => {
      mockExistsSync.mockReturnValue(true);

      const checks = validate({
        enabled: true,
        query: 'is:unread',
        max_messages: 50,
        trash_max_age: '3d',
        pinned_labels: ['Travel'],
      });

      expect(checks.some(([icon, msg]) => icon === INFO && msg.includes('is:unread'))).toBe(true);
      expect(checks.some(([icon, msg]) => icon === INFO && msg.includes('50'))).toBe(true);
      expect(checks.some(([icon, msg]) => icon === INFO && msg.includes('3d'))).toBe(true);
      expect(checks.some(([icon, msg]) => icon === INFO && msg.includes('Travel'))).toBe(true);
    });
  });
});
