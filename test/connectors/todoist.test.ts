import { jest } from '@jest/globals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TODOIST_TOKEN_PERSON1;
  delete process.env.TODOIST_TOKEN_PERSON2;
});

const { create, validate, priorityLabel, daysBetween, splitDue, buildAccounts } =
  await import('../../src/connectors/todoist.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

const TZ = 'America/New_York';
const TODAY = '2026-10-14';

/** A raw API task, as fetchAccount hands it to buildAccounts. */
const raw = (over: Record<string, unknown> = {}) => ({
  id: 't',
  content: 'Task',
  projectName: 'Home',
  inInbox: false,
  priority: 1,
  ...over,
});

describe('priorityLabel', () => {
  it('maps the API scale (4 = most urgent) onto the app labels (p1 = most urgent)', () => {
    expect(priorityLabel(4)).toBe('p1');
    expect(priorityLabel(3)).toBe('p2');
    expect(priorityLabel(2)).toBe('p3');
    expect(priorityLabel(1)).toBe('p4');
    expect(priorityLabel(undefined)).toBe('p4');
  });
});

describe('daysBetween', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-10-04', '2026-10-14')).toBe(10);
    expect(daysBetween('2026-10-14', '2026-10-14')).toBe(0);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('splitDue', () => {
  it('passes a plain date through', () => {
    expect(splitDue('2026-10-14', TZ)).toEqual({ date: '2026-10-14' });
  });

  it('reads a floating local time', () => {
    expect(splitDue('2026-10-14T14:05:00', TZ)).toEqual({ date: '2026-10-14', time: '2:05 PM' });
    expect(splitDue('2026-10-14T00:30:00', TZ)).toEqual({ date: '2026-10-14', time: '12:30 AM' });
  });

  it('converts a fixed instant into the household zone, including the date', () => {
    // 02:00 UTC on the 15th is 10 PM on the 14th in New York.
    expect(splitDue('2026-10-15T02:00:00Z', TZ)).toEqual({ date: '2026-10-14', time: '10:00 PM' });
    expect(splitDue('2026-10-15T02:00:00+00:00', TZ).date).toBe('2026-10-14');
  });
});

describe('buildAccounts', () => {
  it('buckets tasks and pre-computes the numbers a writer would get wrong', () => {
    const [acct] = buildAccounts(
      [
        {
          person: 'Alex',
          userId: 'u1',
          projects: { p1: 'Home' },
          completed: [],
          tasks: [
            raw({
              id: 'late',
              content: 'Renew registration',
              priority: 4,
              due: { date: '2026-10-04', string: 'Oct 4', is_recurring: false },
              added_at: '2026-09-01T12:00:00Z',
              postponed_count: 3,
              labels: ['errand'],
              deadline: { date: '2026-10-31' },
              description: 'Bring the form',
            }),
            raw({ id: 'now', due: { date: '2026-10-14T15:00:00' } }),
            raw({ id: 'soon', due: { date: '2026-10-18' } }),
            raw({ id: 'later', due: { date: '2026-11-30' } }),
            raw({ id: 'inbox', inInbox: true }),
            raw({ id: 'someday' }),
          ],
        },
      ],
      TODAY,
      TZ,
    );

    const ids = (key: string) => (acct[key] as { id: string }[]).map((t) => t.id);
    expect(ids('today')).toEqual(['late', 'now']);
    expect(ids('upcoming')).toEqual(['soon']);
    expect(ids('inbox')).toEqual(['inbox']);
    expect(ids('backlog')).toEqual(['someday']);

    const late = (acct.today as Record<string, unknown>[])[0];
    expect(late).toMatchObject({
      priority: 'p1',
      daysOverdue: 10,
      dueWeekday: 'Sunday',
      ageDays: 43,
      addedDate: '2026-09-01',
      postponedCount: 3,
      labels: ['errand'],
      deadline: '2026-10-31',
      description: 'Bring the form',
      dueString: 'Oct 4',
    });
    expect((acct.today as Record<string, unknown>[])[1]).toMatchObject({ dueTime: '3:00 PM' });
    expect((acct.today as Record<string, unknown>[])[1]).not.toHaveProperty('daysOverdue');
    expect(acct.summary).toEqual({
      overdue: 1,
      dueToday: 1,
      inbox: 1,
      upcoming: 1,
      backlog: 1,
      oldestOverdueDays: 10,
      completedLast3Days: 0,
    });
  });

  it('lists a shared task once, under its assignee, naming who else sees it', () => {
    const shared = raw({ id: 'shared', content: 'Book the plumber', responsible_uid: 'u2' });
    const accounts = buildAccounts(
      [
        {
          person: 'Alex',
          userId: 'u1',
          projects: {},
          completed: [],
          tasks: [shared, raw({ id: 'a' })],
        },
        { person: 'Sam', userId: 'u2', projects: {}, completed: [], tasks: [shared] },
      ],
      TODAY,
      TZ,
    );
    const backlog = (i: number) => accounts[i].backlog as Record<string, unknown>[];
    expect(backlog(0).map((t) => t.id)).toEqual(['a']);
    expect(backlog(1)).toEqual([
      expect.objectContaining({ id: 'shared', assignee: 'Sam', sharedWith: ['Alex'] }),
    ]);
  });

  it('keeps an unassigned shared task with the first account that listed it', () => {
    const shared = raw({ id: 'shared' });
    const accounts = buildAccounts(
      [
        { person: 'Alex', projects: {}, completed: [], tasks: [shared] },
        { person: 'Sam', projects: {}, completed: [], tasks: [shared] },
      ],
      TODAY,
      TZ,
    );
    expect((accounts[0].backlog as unknown[]).length).toBe(1);
    expect((accounts[1].backlog as unknown[]).length).toBe(0);
  });

  it('summarises collapsed projects instead of listing them, keeping p1 items visible', () => {
    const [acct] = buildAccounts(
      [
        {
          person: 'Alex',
          projects: {},
          completed: [],
          tasks: [
            raw({ id: 'h1', projectName: 'Infra', priority: 4, due: { date: '2026-10-10' } }),
            raw({ id: 'h2', projectName: 'Infra', priority: 4 }),
            raw({ id: 'h3', projectName: 'Infra', priority: 4 }),
            raw({ id: 'h4', projectName: 'infra', priority: 1 }),
            raw({ id: 'keep', projectName: 'Home' }),
          ],
        },
      ],
      TODAY,
      TZ,
      ['INFRA'],
    );
    expect((acct.backlog as { id: string }[]).map((t) => t.id)).toEqual(['keep']);
    expect(acct.today).toEqual([]);
    expect(acct.collapsed).toEqual([
      {
        project: 'Infra',
        open: 3,
        overdue: 1,
        urgent: [
          { content: 'Task', priority: 'p1', daysOverdue: 4 },
          { content: 'Task', priority: 'p1', daysOverdue: undefined },
        ],
      },
      { project: 'infra', open: 1, overdue: 0, urgent: [] },
    ]);
  });

  it('shapes completed tasks with the local date and who finished them', () => {
    const [acct] = buildAccounts(
      [
        {
          person: 'Alex',
          userId: 'u1',
          projects: { p9: 'Errands' },
          tasks: [],
          completed: [
            {
              id: 'c1',
              content: 'Mail the form',
              project_id: 'p9',
              completed_at: '2026-10-14T01:00:00Z',
              completed_by_uid: 'u1',
            },
            { id: 'c2', content: 'Unknown when' },
          ],
          completedError: undefined,
        },
      ],
      TODAY,
      TZ,
    );
    expect(acct.recently_completed).toEqual([
      {
        id: 'c1',
        content: 'Mail the form',
        project: 'Errands',
        completedDate: '2026-10-13',
        completedBy: 'Alex',
      },
      { id: 'c2', content: 'Unknown when', project: '', completedDate: undefined },
    ]);
    expect(acct).not.toHaveProperty('completedError');
  });

  it('passes a completed-fetch failure through', () => {
    const [acct] = buildAccounts(
      [{ person: 'Alex', projects: {}, tasks: [], completed: [], completedError: 'HTTP 500' }],
      TODAY,
      TZ,
    );
    expect(acct.completedError).toBe('HTTP 500');
  });
});

describe('todoist connector', () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(new Date());

  function mockApi(options: { completedStatus?: number; userStatus?: number } = {}) {
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const u = url.toString();
      const ok = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (u.endsWith('/user')) {
        if (options.userStatus) return Promise.resolve({ ok: false, status: options.userStatus });
        return ok({ id: 'u1' });
      }
      if (u.includes('/projects')) {
        return ok({
          results: [
            { id: 'proj1', name: 'Work', inbox_project: false },
            { id: 'proj2', name: 'Inbox', inbox_project: true },
          ],
          next_cursor: null,
        });
      }
      if (u.includes('/completed/')) {
        if (options.completedStatus) {
          return Promise.resolve({
            ok: false,
            status: options.completedStatus,
            json: () => Promise.resolve({}),
          });
        }
        return ok({
          items: [
            {
              id: 'done1',
              content: 'Old task',
              project_id: 'proj1',
              completed_at: '2026-03-24T10:00:00Z',
            },
          ],
        });
      }
      if (u.includes('/tasks')) {
        return ok({
          results: [
            {
              id: 'task1',
              content: 'Buy groceries',
              project_id: 'proj2',
              priority: 4,
              due: { date: today, string: 'today', is_recurring: false },
            },
            { id: 'task2', content: 'Review PR', project_id: 'proj1', priority: 2, due: null },
            { id: 'task3', content: 'Inbox item', project_id: 'proj2', priority: 1, due: null },
          ],
          next_cursor: null,
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as typeof fetch);
  }

  it('has the right name', () => {
    expect(create({ enabled: true }).name).toBe('todoist');
  });

  it('fetches, buckets and describes each account', async () => {
    process.env.TODOIST_TOKEN_PERSON1 = 'tok';
    mockApi();
    const result = await create({
      enabled: true,
      accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
    }).fetch();

    const [acct] = result.data.accounts as Record<string, unknown>[];
    expect(acct.person).toBe('Person1');
    expect((acct.today as { id: string; priority: string }[])[0]).toMatchObject({
      id: 'task1',
      priority: 'p1',
    });
    expect((acct.inbox as { id: string }[]).map((t) => t.id)).toEqual(['task3']);
    expect((acct.backlog as { id: string }[]).map((t) => t.id)).toEqual(['task2']);
    expect((acct.recently_completed as unknown[]).length).toBe(1);
    expect(result.description).toContain('p1 is the most urgent');
    expect(result.description).not.toContain('could NOT be fetched');
    expect(result.data.today_ymd).toBe(today);
    expect(result.priorityHint).toBe('high');
  });

  it('says so when recently completed could not be fetched', async () => {
    process.env.TODOIST_TOKEN_PERSON1 = 'tok';
    mockApi({ completedStatus: 403, userStatus: 500 });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await create({
      enabled: true,
      accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      collapse_projects: ['Infra'],
    }).fetch();

    expect(result.description).toContain('Recently completed could NOT be fetched for Person1');
    expect(result.description).toContain('summarised rather than listed');
    const [acct] = result.data.accounts as Record<string, unknown>[];
    expect(acct.completedError).toContain('403');
    logSpy.mockRestore();
  });

  it('skips accounts whose token is missing', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    const result = await create({
      enabled: true,
      accounts: [{ name: 'Person2', token_env: 'TODOIST_TOKEN_PERSON2' }],
    }).fetch();

    expect(result.data.accounts).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('survives the user lookup throwing', async () => {
    process.env.TODOIST_TOKEN_PERSON1 = 'tok';
    mockApi();
    const inner = globalThis.fetch;
    globalThis.fetch = jest.fn(((url: string | URL | Request) =>
      url.toString().endsWith('/user')
        ? Promise.reject(new Error('ENOTFOUND'))
        : (inner as (u: unknown) => Promise<unknown>)(url)) as typeof fetch);

    const result = await create({
      enabled: true,
      accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
    }).fetch();

    expect((result.data.accounts as unknown[]).length).toBe(1);
  });
});

describe('validate', () => {
  it('passes when accounts are configured with tokens', () => {
    process.env.TODOIST_TOKEN_PERSON1 = 'test-token-long-enough';
    const checks = validate({
      enabled: true,
      accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
    });
    expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    expect(checks.some(([, msg]) => msg.includes('1 account'))).toBe(true);
  });

  it('fails with no accounts, or a missing token', () => {
    expect(validate({ enabled: true, accounts: [] }).some(([i]) => i === FAIL)).toBe(true);
    expect(
      validate({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      }).some(([i]) => i === FAIL),
    ).toBe(true);
  });

  it('masks a short token entirely', () => {
    process.env.TODOIST_TOKEN_PERSON1 = 'short';
    const checks = validate({
      enabled: true,
      accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
    });
    expect(checks.some(([, , detail]) => detail === '***')).toBe(true);
  });
});
