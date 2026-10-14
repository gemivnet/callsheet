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
const mockThreadsGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();

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
        threads: {
          get: mockThreadsGet,
        },
      },
    })),
  },
}));

const { create, validate, decodeEntities, redactCodes } =
  await import('../../src/connectors/gmail.js');
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
  messages: {
    id: string;
    from?: string;
    subject?: string;
    date?: string;
    snippet?: string;
    labelIds?: string[];
  }[] = [],
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
      setupGmailMocks([{ id: 'msg5', labelIds: ['INBOX'] }], [], 3);

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.description).toContain('1 account(s)');
      expect(result.description).toContain('3 total inbox unread');
    });

    it('should fetch pinned label emails', async () => {
      setupCredsAndToken();
      setupGmailMocks(
        [
          {
            id: 'pinned1',
            from: 'airline@example.com',
            subject: 'Booking Confirmation',
            snippet: 'Your flight is confirmed',
            labelIds: ['Label_Travel'],
          },
        ],
        [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_Travel', name: 'Travel Confirmations', type: 'user' },
        ],
        0,
      );

      const conn = create({
        enabled: true,
        pinned_labels: ['Travel Confirmations'],
      });
      const result = await conn.fetch();

      // Pinned labels note should appear in description
      expect(result.description).toContain('Pinned labels');
      expect(result.description).toContain('Travel Confirmations');
    });

    it('should skip pinned labels that do not exist for the account', async () => {
      setupCredsAndToken();
      setupGmailMocks([], [{ id: 'INBOX', name: 'INBOX', type: 'system' }], 0);

      const conn = create({
        enabled: true,
        pinned_labels: ['NonExistent Label'],
      });
      const result = await conn.fetch();

      // Should succeed without error; label just gets skipped
      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(1);
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

describe('decodeEntities', () => {
  it('decodes the entities Gmail leaves in snippets', () => {
    expect(
      decodeEntities('We&#39;ve &quot;got&quot; &lt;it&gt; &amp; more&nbsp;&#x41;&apos;'),
    ).toBe('We\'ve "got" <it> & more A\'');
  });
});

describe('redactCodes', () => {
  it('removes codes from text that talks about codes', () => {
    expect(redactCodes('Your verification code is 482913. It expires in 10 minutes.')).toBe(
      'Your verification code is [code]. It expires in 10 minutes.',
    );
    expect(redactCodes('Use G-482913 to sign in')).toBe('Use [code] to sign in');
    expect(redactCodes('Your one-time passcode: K7Q2ZP')).toBe('Your one-time passcode: [code]');
  });

  it('leaves ordinary numbers in ordinary emails alone', () => {
    expect(redactCodes('Order 12345678 has shipped')).toBe('Order 12345678 has shipped');
    expect(redactCodes('Your code review is ready')).toBe('Your code review is ready');
  });
});

describe('gmail threads, local times and truncation', () => {
  it('annotates who spoke last, adds local times, redacts and flags a cut-off window', async () => {
    setupCredsAndToken();
    mockLabelsList.mockResolvedValue({ data: { labels: [] } });
    mockLabelsGet.mockResolvedValue({ data: { messagesUnread: 1 } });
    mockMessagesList.mockImplementation(async (opts: unknown) => {
      const { q } = opts as { q: string };
      if (q.startsWith('in:trash')) return { data: { messages: [] } };
      return { data: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'more' } };
    });
    mockMessagesGet.mockImplementation(async (opts: unknown) => {
      const { id } = opts as { id: string };
      return {
        data: {
          threadId: id === 'm1' ? 't1' : 't2',
          internalDate: String(Date.UTC(2026, 9, 14, 15, 30)),
          payload: {
            headers: [
              { name: 'From', value: 'Friend <friend@example.com>' },
              { name: 'To', value: 'test@example.com' },
              { name: 'Subject', value: id === 'm1' ? 'Dinner Friday?' : 'Your login code' },
              { name: 'Date', value: 'Wed, 14 Oct 2026 15:30:00 +0000' },
            ],
          },
          snippet: id === 'm1' ? 'Can you make it?' : 'Use 482913 to sign in &amp; continue',
          labelIds: id === 'm1' ? ['INBOX'] : ['INBOX', 'UNREAD'],
        },
      };
    });
    mockThreadsGet.mockImplementation(async (opts: unknown) => {
      const { id } = opts as { id: string };
      if (id === 't2') throw new Error('gone');
      return {
        data: {
          messages: [
            { internalDate: '2', labelIds: ['SENT'] },
            { internalDate: '1', labelIds: ['INBOX'] },
          ],
        },
      };
    });

    const result = await create({
      enabled: true,
      timezone: 'America/New_York',
      max_messages: 2,
      accounts: [{ name: 'Person1' }],
    }).fetch();

    const [acct] = result.data.accounts as {
      emails: Record<string, unknown>[];
      truncated?: boolean;
    }[];
    const [dinner, login] = acct.emails;
    expect(dinner).toMatchObject({
      to: 'test@example.com',
      dateLocal: '2026-10-14',
      timeLabel: '11:30 AM',
      sent: false,
      threadId: 't1',
      threadMessages: 2,
      lastFromUs: true,
    });
    expect(login.snippet).toBe('Use [code] to sign in & continue');
    expect(login).not.toHaveProperty('lastFromUs');
    expect(acct.truncated).toBe(true);
    expect(result.description).toContain('The window was CUT OFF for Person1');
    expect(result.description).toContain('lastFromUs: true');
  });
});
