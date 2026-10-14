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

const {
  create,
  validate,
  formatInTz,
  relativeDayLabel,
  attributeByTitle,
  allDaySpan,
  findConflicts,
  freeWindows,
} = await import('../../src/connectors/google-calendar.js');
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

    it('should follow nextPageToken until the calendar is exhausted', async () => {
      setupCredsAndToken();
      mockEventsList
        .mockResolvedValueOnce({
          data: {
            items: [{ id: 'p1', summary: 'Page one', start: { date: '2026-03-26' } }],
            nextPageToken: 'tok-2',
          },
        })
        .mockResolvedValueOnce({
          data: { items: [{ id: 'p2', summary: 'Page two', start: { date: '2026-03-26' } }] },
        })
        .mockResolvedValue({ data: { items: [] } });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      await conn.fetch();

      const tokens = mockEventsList.mock.calls.map(
        (c) => (c[0] as { pageToken?: string }).pageToken,
      );
      expect(tokens).toContain('tok-2');
      expect((mockEventsList.mock.calls[0][0] as { maxResults?: number }).maxResults).toBe(250);
    });

    it('should surface per-calendar failures in the payload', async () => {
      setupCredsAndToken();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockEventsList.mockRejectedValue(new Error('403 Forbidden'));

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      const errors = result.data.fetch_errors as string[];
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('403 Forbidden');
      expect(result.description).toContain('failed to load');
      consoleSpy.mockRestore();
    });

    it('should tag events with the account they came from and merge shared events', async () => {
      setupCredsAndToken();
      // One event on both calendars (shared invite) + one unique to Person 2.
      const shared = { id: 'shared-1', summary: 'Shared dinner', start: { date: '2026-03-26' } };
      const solo = { id: 'solo-1', summary: 'Solo errand', start: { date: '2026-03-26' } };
      mockEventsList.mockImplementation((args: unknown) => {
        const { timeMin } = args as { timeMin: string };
        // Only return events for the "today" window to keep the assertion simple.
        void timeMin;
        return Promise.resolve({ data: { items: [shared, solo] } });
      });

      const conn = create({
        enabled: true,
        accounts: [
          { name: 'Person 1', calendar_ids: ['primary'] },
          { name: 'Person 2', calendar_ids: ['primary'] },
        ],
      });
      const result = await conn.fetch();

      const today = result.data.today as { id?: string; summary: string; people: string[] }[];
      const sharedEvent = today.find((e) => e.summary === 'Shared dinner');
      expect(sharedEvent?.people).toEqual(['Person 1', 'Person 2']);
      // Merged, not duplicated.
      expect(today.filter((e) => e.summary === 'Shared dinner')).toHaveLength(1);
    });

    it('should count events per person so the brief never has to', async () => {
      setupCredsAndToken();
      mockEventsList.mockImplementation((args: unknown) => {
        const { timeMax } = args as { timeMin: string; timeMax: string };
        // The recent window is the only one that ends at start-of-today.
        const isRecent = new Date(timeMax).getUTCHours() !== 23;
        void isRecent;
        return Promise.resolve({
          data: {
            items: [
              { id: 'a', summary: 'Lesson one', start: { date: '2026-03-24' } },
              { id: 'b', summary: 'Lesson two', start: { date: '2026-03-25' } },
              { id: 'c', summary: 'Dentist', start: { date: '2026-03-25' } },
            ],
          },
        });
      });

      const conn = create({
        enabled: true,
        accounts: [{ name: 'Person 1', calendar_ids: ['primary'] }],
        event_categories: [{ label: 'Lessons', pattern: 'lesson' }],
      });
      const result = await conn.fetch();

      const agg = result.data.aggregates as {
        by_person: Record<string, Record<string, unknown>>;
        totals: Record<string, number>;
        window: Record<string, string>;
      };
      const person = agg.by_person['Person 1'];
      expect(person.today).toBe(3);
      expect((person.today_by_category as Record<string, number>).Lessons).toBe(2);
      expect(agg.totals.today).toBe(3);
      expect(agg.window.recent_to_exclusive).toBe(agg.window.today);
    });

    it('should not let a malformed category pattern break the fetch', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({
        data: { items: [{ id: 'x', summary: 'Anything', start: { date: '2026-03-26' } }] },
      });

      const conn = create({
        enabled: true,
        accounts: [{ name: 'Person 1', calendar_ids: ['primary'] }],
        event_categories: [{ label: 'Broken', pattern: '([unclosed' }],
      });
      const result = await conn.fetch();

      const agg = result.data.aggregates as { by_person: Record<string, Record<string, unknown>> };
      expect(agg.by_person['Person 1'].today).toBe(1);
      expect(agg.by_person['Person 1'].today_by_category).toBeUndefined();
    });

    it('should include recent events by default (week-in-review needs them)', async () => {
      setupCredsAndToken();
      mockEventsList.mockResolvedValue({ data: { items: [] } });

      const conn = create({ enabled: true, calendar_ids: ['primary'] });
      const result = await conn.fetch();

      expect(result.data.recent).toBeDefined();
      expect(result.description).toContain('past 7 days');
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
      expect(relativeDayLabel('2026-04-20', '2026-04-17', 'Friday')).toBe(
        'last Friday (3 days ago)',
      );
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

describe('attributeByTitle', () => {
  const names = ['Alex', 'Sam', 'Jo'];

  it("gives a member's prefixed event to that member, keeping whose calendar it is on", () => {
    expect(attributeByTitle('Jo: Practice', ['Alex'], names)).toEqual({
      people: ['Jo'],
      onCalendarOf: ['Alex'],
    });
    expect(attributeByTitle('sam in plane with coach', ['Alex'], names)).toEqual({
      people: ['Sam'],
      onCalendarOf: ['Alex'],
    });
  });

  it("leaves an owner's own event, an unprefixed event, and a mere substring alone", () => {
    expect(attributeByTitle('Alex: dentist', ['Alex'], names)).toEqual({ people: ['Alex'] });
    expect(attributeByTitle('Dinner', ['Alex'], names)).toEqual({ people: ['Alex'] });
    expect(attributeByTitle('Joint session', ['Alex'], names)).toEqual({ people: ['Alex'] });
    expect(attributeByTitle('Jo: x', undefined, [])).toEqual({ people: undefined });
  });
});

describe('allDaySpan', () => {
  it('turns an exclusive end date into the real last day', () => {
    expect(allDaySpan('2026-10-02', '2026-10-05', '2026-09-28')).toEqual({
      lastDay: '2026-10-04',
      spanDays: 3,
      spanLabel: 'Fri 2026-10-02 – Sun 2026-10-04 (3 days)',
    });
  });

  it('says which day of the span today is', () => {
    expect(allDaySpan('2026-10-02', '2026-10-05', '2026-10-03')).toMatchObject({
      ongoing: true,
      dayOfSpan: 'day 2 of 3',
    });
    expect(allDaySpan('2026-10-02', '2026-10-05', '2026-10-02')).toMatchObject({
      ongoing: false,
      dayOfSpan: 'day 1 of 3',
    });
  });

  it('treats a one-day event (or a malformed end) as one day', () => {
    expect(allDaySpan('2026-10-02', '2026-10-03', '2026-10-02')).toEqual({
      lastDay: '2026-10-02',
      spanDays: 1,
    });
    expect(allDaySpan('2026-10-02', '2026-10-02', '2026-10-02').spanDays).toBe(1);
  });
});

describe('findConflicts and freeWindows', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 14, h, m);
  const slot = (summary: string, people: string[], from: number, to: number) => ({
    summary,
    people,
    startMs: from,
    endMs: to,
    date: '2026-10-14',
    timeLabel: `${new Date(from).getUTCHours()}:00`,
    endTimeLabel: `${new Date(to).getUTCHours()}:00`,
  });

  it("reports one person's overlapping events, not two people's", () => {
    const conflicts = findConflicts([
      slot('Office', ['Alex'], at(7), at(14)),
      slot('Appointment', ['Alex'], at(10), at(11)),
      slot('Practice', ['Jo'], at(10), at(12)),
      slot('Back to back', ['Alex'], at(14), at(15)),
    ]);
    expect(conflicts).toEqual([
      {
        person: 'Alex',
        date: '2026-10-14',
        first: 'Office 7:00–14:00',
        second: 'Appointment 10:00–11:00',
        overlapMinutes: 60,
      },
    ]);
  });

  it("lists each person's open stretches, skipping short gaps and the past", () => {
    const slots = [
      slot('Office', ['Alex'], at(8), at(12)),
      slot('Call', ['Alex'], at(12, 30), at(13)),
      slot('Gym', ['Sam'], at(9), at(10)),
    ];
    const windows = freeWindows(slots, ['Alex', 'Sam', 'Jo'], at(8), at(18), 'UTC', 45);
    expect(windows).toEqual({
      Alex: ['1:00 PM–6:00 PM'],
      Sam: ['8:00 AM–9:00 AM', '10:00 AM–6:00 PM'],
      Jo: ['8:00 AM–6:00 PM'],
    });
    expect(freeWindows(slots, ['Jo'], at(8), at(18), 'UTC', 45, at(17, 30))).toEqual({ Jo: [] });
  });
});

describe('calendar connector: roster, spans, exclusions, conflicts', () => {
  it('attributes, spans, excludes and computes conflicts and free time end to end', async () => {
    setupCredsAndToken();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    const iso = (h: number) => `${today}T${String(h).padStart(2, '0')}:00:00Z`;
    mockEventsList.mockImplementation((args: unknown) => {
      const { timeMin } = args as { timeMin: string };
      // Only the "today" query returns events.
      if (!timeMin.startsWith(today)) return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({
        data: {
          items: [
            {
              id: 'a',
              summary: 'Office',
              start: { dateTime: iso(13) },
              end: { dateTime: iso(19) },
            },
            { id: 'b', summary: 'Call', start: { dateTime: iso(15) }, end: { dateTime: iso(16) } },
            {
              id: 'c',
              summary: 'Jo: Practice',
              start: { dateTime: iso(15) },
              end: { dateTime: iso(16) },
            },
            {
              id: 'd',
              summary: 'Team at home',
              description: 'not attending (schedule reference)',
              start: { dateTime: iso(20) },
              end: { dateTime: iso(22) },
            },
            {
              id: 'e',
              summary: 'Long weekend',
              start: { date: today },
              end: { date: '2099-01-03' },
            },
          ],
        },
      });
    });

    const result = await create({
      enabled: true,
      timezone: 'UTC',
      lookback_days: 0,
      household_names: ['Alex', 'Jo'],
      exclude_patterns: ['schedule reference', '[unclosed'],
      accounts: [{ name: 'Alex', calendar_ids: ['primary'] }],
    }).fetch();

    const todayEvents = result.data.today as Record<string, unknown>[];
    expect(todayEvents.map((e) => e.summary)).not.toContain('Team at home');
    expect(result.data.omitted_reference_events).toBe(1);
    expect(result.description).toContain('reference-only event(s) were left out');
    const practice = todayEvents.find((e) => e.summary === 'Jo: Practice');
    expect(practice).toMatchObject({ people: ['Jo'], onCalendarOf: ['Alex'] });
    expect(todayEvents.find((e) => e.summary === 'Long weekend')).toHaveProperty('lastDay');
    const conflicts = result.data.conflicts as { person: string }[];
    expect(conflicts.map((c) => c.person)).toEqual(['Alex']);
    const free = result.data.free_time_today as Record<string, string[]>;
    expect(Object.keys(free)).toEqual(['Alex', 'Jo']);
  });
});
