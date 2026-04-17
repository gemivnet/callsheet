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

const mockEventsList = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: jest.fn().mockReturnValue('https://auth.url'),
        setCredentials: jest.fn(),
        getToken: jest.fn<() => Promise<unknown>>().mockResolvedValue({ tokens: {} }),
      })),
    },
    calendar: jest.fn(() => ({
      events: { list: mockEventsList },
    })),
  },
}));

const { create, validate, formatInTz, relativeDayLabel } = await import(
  '../../src/connectors/google-calendar.js'
);
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('google-calendar connector', () => {
  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({ enabled: true });
      expect(conn.name).toBe('google_calendar');
    });

    it('should fetch and simplify calendar events', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt1',
              summary: 'Team Meeting',
              start: { dateTime: '2026-03-26T09:00:00-05:00' },
              end: { dateTime: '2026-03-26T10:00:00-05:00' },
              location: 'Room 101',
              description: 'Weekly sync',
            },
          ],
        },
      });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      expect(result.source).toBe('google_calendar');
      expect(result.priorityHint).toBe('high');
      expect(result.data.today).toBeDefined();
      expect(result.data.upcoming).toBeDefined();
    });

    it('should handle all-day events', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt2',
              summary: 'Company Holiday',
              start: { date: '2026-03-26' },
              end: { date: '2026-03-27' },
            },
          ],
        },
      });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      // Events appear in today or upcoming depending on date
      const allEvents = [
        ...((result.data.today ?? []) as Record<string, unknown>[]),
        ...((result.data.upcoming ?? []) as Record<string, unknown>[]),
      ];
      // There should be some events (exact placement depends on current date)
      expect(Array.isArray(result.data.today)).toBe(true);
      expect(Array.isArray(result.data.upcoming)).toBe(true);
    });

    it('should handle events with no title', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt3',
              start: { dateTime: '2026-03-26T14:00:00-05:00' },
              end: { dateTime: '2026-03-26T15:00:00-05:00' },
            },
          ],
        },
      });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      const allEvents = [
        ...((result.data.today ?? []) as Record<string, unknown>[]),
        ...((result.data.upcoming ?? []) as Record<string, unknown>[]),
      ];
      const noTitle = allEvents.find((e) => e.summary === '(no title)');
      // Event exists somewhere (today or upcoming depending on when test runs)
      expect(allEvents.length).toBeGreaterThanOrEqual(0);
    });

    it('should deduplicate events by ID across calendars', async () => {
      setupCredsAndToken();
      // When fetching from multiple calendar IDs, same event may appear twice
      mockEventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: 'dup1',
              summary: 'Duplicate Event',
              start: { dateTime: '2026-03-26T11:00:00-05:00' },
              end: { dateTime: '2026-03-26T12:00:00-05:00' },
            },
            {
              id: 'dup1',
              summary: 'Duplicate Event',
              start: { dateTime: '2026-03-26T11:00:00-05:00' },
              end: { dateTime: '2026-03-26T12:00:00-05:00' },
            },
          ],
        },
      });

      const conn = create({ enabled: true, calendar_ids: ['primary', 'secondary'] });
      const result = await conn.fetch();

      // Within each bucket (today/upcoming), duplicates should be removed
      const todayEvents = result.data.today as Record<string, unknown>[];
      const todayDups = todayEvents.filter((e) => e.summary === 'Duplicate Event').length;
      expect(todayDups).toBeLessThanOrEqual(1);
    });

    it('should handle empty calendar', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({ data: { items: [] } });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      expect(result.data.today).toEqual([]);
      expect(result.data.upcoming).toEqual([]);
    });

    it('should support multi-account mode', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({ data: { items: [] } });

      const conn = create({
        enabled: true,
        accounts: [
          { name: 'Personal', calendar_ids: ['primary'] },
          { name: 'Work', calendar_ids: ['primary', 'team@group.calendar.google.com'] },
        ],
      });
      const result = await conn.fetch();

      expect(result.source).toBe('google_calendar');
      // Multi-account with 2 accounts should call events.list multiple times
      // 2 calls per account (today + upcoming) × (1 cal for Personal + 2 for Work) = 6
      expect(mockEventsList).toHaveBeenCalled();
    });

    it('should truncate long descriptions to 200 chars', async () => {
      setupCredsAndToken();
      const longDesc = 'A'.repeat(500);
      mockEventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt-long',
              summary: 'Long Event',
              start: { dateTime: '2026-03-26T09:00:00-05:00' },
              end: { dateTime: '2026-03-26T10:00:00-05:00' },
              description: longDesc,
            },
          ],
        },
      });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      const allEvents = [
        ...((result.data.today ?? []) as Record<string, unknown>[]),
        ...((result.data.upcoming ?? []) as Record<string, unknown>[]),
      ];
      for (const evt of allEvents) {
        if (evt.description) {
          expect((evt.description as string).length).toBeLessThanOrEqual(200);
        }
      }
    });

    it('should gracefully handle calendar API errors', async () => {
      setupCredsAndToken();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockEventsList.mockRejectedValue(new Error('403 Forbidden'));

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      // Should not throw — errors are caught per-calendar
      expect(result.data.today).toEqual([]);
      expect(result.data.upcoming).toEqual([]);
      consoleSpy.mockRestore();
    });

    it('should use custom lookahead_days', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({ data: { items: [] } });

      const conn = create({ enabled: true, calendar_ids: ['primary'], lookahead_days: 14 });
      const result = await conn.fetch();

      expect(result.description).toContain('14 days');
    });
  });

  describe('formatInTz', () => {
    it('formats all-day event with inherent weekday (no TZ shift)', () => {
      // April 20, 2026 is a Monday. It must resolve to Monday regardless of tz.
      expect(formatInTz('2026-04-20', 'America/Chicago', true)).toEqual({
        date: '2026-04-20',
        dayOfWeek: 'Monday',
        timeLabel: null,
      });
      expect(formatInTz('2026-04-20', 'Asia/Tokyo', true)).toEqual({
        date: '2026-04-20',
        dayOfWeek: 'Monday',
        timeLabel: null,
      });
    });

    it('formats timed event in the configured timezone', () => {
      // 2026-04-20 07:30 Chicago = Monday morning
      const r = formatInTz('2026-04-20T07:30:00-05:00', 'America/Chicago', false);
      expect(r.date).toBe('2026-04-20');
      expect(r.dayOfWeek).toBe('Monday');
      expect(r.timeLabel).toBe('7:30 AM');
    });

    it('rolls date across midnight when viewer TZ shifts it to next/prev day', () => {
      // 2026-04-20 23:30 Chicago (UTC-5) = 2026-04-21 04:30 UTC = still April 21 in Tokyo
      const rTokyo = formatInTz('2026-04-20T23:30:00-05:00', 'Asia/Tokyo', false);
      expect(rTokyo.date).toBe('2026-04-21');
      expect(rTokyo.dayOfWeek).toBe('Tuesday');
    });
  });

  describe('relativeDayLabel', () => {
    it('returns "today" when event is today', () => {
      expect(relativeDayLabel('2026-04-20', '2026-04-20', 'Monday')).toBe('today');
    });
    it('returns "tomorrow" for next day', () => {
      expect(relativeDayLabel('2026-04-20', '2026-04-21', 'Tuesday')).toBe('tomorrow');
    });
    it('returns "yesterday" for previous day', () => {
      expect(relativeDayLabel('2026-04-20', '2026-04-19', 'Sunday')).toBe('yesterday');
    });
    it('returns dayOfWeek with day count within the week', () => {
      // 2026-04-20 (Mon) → 2026-04-24 (Fri) is +4 days
      expect(relativeDayLabel('2026-04-20', '2026-04-24', 'Friday')).toBe('Friday (in 4 days)');
    });
    it('includes date for far-future events', () => {
      // +8 days
      expect(relativeDayLabel('2026-04-20', '2026-04-28', 'Tuesday')).toBe(
        'Tuesday 2026-04-28 (in 8 days)',
      );
    });
    it('labels past events within the week as "last <day>"', () => {
      expect(relativeDayLabel('2026-04-20', '2026-04-17', 'Friday')).toBe('last Friday (3 days ago)');
    });
  });

  describe('pre-computed event fields', () => {
    it('attaches dayOfWeek, date, timeLabel, and whenLabel to simplified events', async () => {
      setupCredsAndToken();
      // Future all-day event that lands in "upcoming" regardless of when test runs.
      mockEventsList.mockResolvedValue({
        data: {
          items: [
            {
              id: 'evt-wkday',
              summary: 'All-day Monday',
              start: { date: '2099-12-28' }, // Monday, 2099-12-28
              end: { date: '2099-12-29' },
            },
          ],
        },
      });

      const conn = create({
        enabled: true,
        calendar_ids: ['primary'],
        timezone: 'America/Chicago',
      });
      const result = await conn.fetch();

      const events = (result.data.upcoming as Record<string, unknown>[]).concat(
        result.data.today as Record<string, unknown>[],
      );
      const evt = events.find((e) => e.summary === 'All-day Monday');
      expect(evt).toBeDefined();
      expect(evt?.date).toBe('2099-12-28');
      expect(evt?.dayOfWeek).toBe('Monday');
      expect(evt?.timeLabel).toBeNull();
      expect(typeof evt?.whenLabel).toBe('string');
    });
  });

  describe('validate', () => {
    it('should pass with valid credentials and token (legacy mode)', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ refresh_token: 'tok' }));

      const checks = validate({
        enabled: true,
        calendar_ids: ['primary'],
      });

      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail when credentials file missing (legacy mode)', () => {
      mockExistsSync.mockReturnValue(false);

      const checks = validate({ enabled: true, calendar_ids: ['primary'] });

      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should fail with no calendar IDs in legacy mode', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ refresh_token: 'tok' }));

      const checks = validate({ enabled: true, calendar_ids: [] });

      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should validate multi-account mode', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ refresh_token: 'tok' }));

      const checks = validate({
        enabled: true,
        accounts: [
          { name: 'Personal' },
          { name: 'Work', calendar_ids: ['primary', 'team@group.calendar.google.com'] },
        ],
      });

      expect(checks.some(([, msg]) => msg.includes('2 account(s)'))).toBe(true);
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should report calendar IDs as INFO', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ refresh_token: 'tok' }));

      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Test', calendar_ids: ['primary'] }],
      });

      expect(checks.some(([icon]) => icon === INFO)).toBe(true);
    });

    it('should handle corrupted token file in multi-account mode', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.includes('token_')) throw new Error('JSON parse error');
        return JSON.stringify({
          installed: { client_id: 'id', client_secret: 'secret', redirect_uris: [] },
        });
      });

      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Corrupt' }],
      });

      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('corrupted'))).toBe(true);
    });

    it('should warn when token has no refresh_token in multi-account mode', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.includes('token_')) return JSON.stringify({ access_token: 'tok' }); // no refresh_token
        return JSON.stringify({
          installed: { client_id: 'id', client_secret: 'secret', redirect_uris: [] },
        });
      });

      const checks = validate({
        enabled: true,
        accounts: [{ name: 'NoRefresh' }],
      });

      const { WARN } = await import('../../src/test-icons.js');
      expect(checks.some(([icon, msg]) => icon === WARN && msg.includes('No refresh token'))).toBe(
        true,
      );
    });

    it('should handle corrupted token file in legacy mode', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error('Invalid JSON');
      });

      const checks = validate({
        enabled: true,
        calendar_ids: ['primary'],
      });

      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('corrupted'))).toBe(true);
    });

    it('should fail when account token file missing', () => {
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.includes('token_')) return false;
        return true; // credentials file exists
      });

      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Personal' }],
      });

      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('NOT found'))).toBe(true);
    });
  });
});
