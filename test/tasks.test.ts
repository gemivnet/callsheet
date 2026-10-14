import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Brief, CallsheetConfig } from '../src/types.js';

const tasks = await import('../src/tasks.js');
const { shiftYmd } = await import('../src/dates.js');

const TODAY = '2026-10-14';
let dir: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callsheet-tasks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  delete process.env.TEST_TD_ALEX;
  delete process.env.TEST_TD_SAM;
});

const settings = (over: Partial<ReturnType<typeof tasks.coachSettings>> = {}) => ({
  ...tasks.coachSettings({ task_coach: { enabled: true } }),
  ...over,
});

/** Two people's task data in the shape the Todoist connector produces. */
function payload(): string {
  return JSON.stringify([
    {
      source: 'todoist',
      data: {
        accounts: [
          {
            person: 'Alex',
            today: [
              {
                id: 'late',
                content: 'Renew registration',
                priority: 'p1',
                dueDate: '2026-10-01',
                daysOverdue: 13,
              },
              { id: 'chore', content: 'Water plants', dueDate: '2026-10-14', isRecurring: true },
            ],
            inbox: [{ id: 'old-inbox', content: 'Sort the insurance paperwork', ageDays: 190 }],
            upcoming: [{ id: 'soon', content: 'Book the plumber', dueDate: '2026-10-18' }],
            backlog: [
              { id: 'someday', content: 'Clean the garage', ageDays: 200, postponedCount: 4 },
              { id: 'undated-rec', content: 'Monthly filter', isRecurring: true },
            ],
            recently_completed: [{ id: 'done-1' }],
          },
          {
            person: 'Sam',
            backlog: [{ id: 'sam-1', content: 'Return the library books', ageDays: 3 }],
            recently_completed: [],
          },
        ],
      },
    },
    {
      source: 'google_calendar',
      data: { free_time_today: { Alex: ['12:00 PM–3:30 PM'], Sam: [] } },
    },
  ]);
}

describe('coachSettings', () => {
  it('is off by default and fills in defaults when on', () => {
    expect(tasks.coachSettings({}).enabled).toBe(false);
    expect(tasks.coachSettings({ task_coach: { enabled: true } })).toEqual({
      enabled: true,
      focusPerPerson: 3,
      maxDecide: 3,
      capture: true,
      maxCaptures: 3,
      captureLabel: 'callsheet',
      scheduleFocus: true,
    });
  });

  it('honours overrides and ignores nonsense', () => {
    const s = tasks.coachSettings({
      task_coach: {
        enabled: true,
        focus_per_person: 2,
        max_decide: -1,
        capture: false,
        capture_label: '',
        schedule_focus: false,
      },
    } as CallsheetConfig);
    expect(s).toMatchObject({
      focusPerPerson: 2,
      maxDecide: 3,
      capture: false,
      captureLabel: 'callsheet',
      scheduleFocus: false,
    });
  });
});

describe('reading the payload', () => {
  it("reads each person's open and completed tasks, and free time", () => {
    const people = tasks.readTodoist(payload());
    expect(people.map((p) => p.person)).toEqual(['Alex', 'Sam']);
    expect(people[0].open.map((t) => `${t.id}:${t.bucket}`)).toEqual([
      'late:today',
      'chore:today',
      'old-inbox:inbox',
      'soon:upcoming',
      'someday:backlog',
      'undated-rec:backlog',
    ]);
    expect(people[0].completedIds).toEqual(['done-1']);
    expect(tasks.readFreeTime(payload())).toEqual({ Alex: ['12:00 PM–3:30 PM'], Sam: [] });
  });

  it('returns nothing for a payload without the source, or one that is not JSON', () => {
    expect(tasks.readTodoist('[]')).toEqual([]);
    expect(tasks.readTodoist('nope')).toEqual([]);
    expect(tasks.readTodoist('{}')).toEqual([]);
    expect(tasks.readFreeTime('[]')).toEqual({});
    expect(tasks.readFreeTime('nope')).toEqual({});
    expect(
      tasks.readTodoist(
        JSON.stringify([{ source: 'todoist', data: { accounts: [{ today: [null, { x: 1 }] }] } }]),
      ),
    ).toEqual([{ person: '', open: [], completedIds: [] }]);
  });
});

describe('the ledger', () => {
  it('round-trips, and reads a missing or corrupt file as empty', () => {
    expect(tasks.loadLedger(dir)).toEqual({ tasks: {}, captured: [], days: [] });
    tasks.saveLedger(dir, {
      tasks: { a: { firstSeen: TODAY, lastSeen: TODAY, focusCount: 1 } },
      captured: [],
      days: [],
    });
    expect(tasks.loadLedger(dir).tasks.a.focusCount).toBe(1);
    writeFileSync(join(dir, 'tasks', 'ledger.json'), '{oops');
    expect(tasks.loadLedger(dir)).toEqual({ tasks: {}, captured: [], days: [] });
    writeFileSync(join(dir, 'tasks', 'ledger.json'), '{}');
    expect(tasks.loadLedger(dir)).toEqual({ tasks: {}, captured: [], days: [] });
  });

  it('records sightings and forgets tasks and captures long gone', () => {
    const people = tasks.readTodoist(payload());
    const ledger = tasks.observeTasks(
      {
        tasks: {
          late: { firstSeen: '2026-09-01', lastSeen: '2026-10-13', focusCount: 2 },
          ancient: { firstSeen: '2026-01-01', lastSeen: '2026-06-01', focusCount: 0 },
        },
        captured: [
          { key: 'k1', date: '2026-01-01', person: 'Alex', content: 'x' },
          { key: 'k2', date: '2026-10-01', person: 'Alex', content: 'y' },
        ],
        days: [],
      },
      people,
      TODAY,
    );
    expect(ledger.tasks.late).toEqual({ firstSeen: '2026-09-01', lastSeen: TODAY, focusCount: 2 });
    expect(ledger.tasks.soon).toEqual({ firstSeen: TODAY, lastSeen: TODAY, focusCount: 0 });
    expect(ledger.tasks).not.toHaveProperty('ancient');
    expect(ledger.captured.map((c) => c.key)).toEqual(['k2']);
  });
});

describe('findStuck', () => {
  it('ranks stuck tasks with their reasons, skipping recurring and recently decided ones', () => {
    const people = tasks.readTodoist(payload());
    const ledger = tasks.observeTasks({ tasks: {}, captured: [], days: [] }, people, TODAY);
    ledger.tasks['sam-1'] = { firstSeen: TODAY, lastSeen: TODAY, focusCount: 4 };

    const stuck = tasks.findStuck(people, ledger, TODAY);

    // Scores: inbox 190 days → 95; rescheduled 4× and 200 days old → 34;
    // picked 4× → 20; overdue 13 days → 13.
    expect(stuck.map((s) => s.task_id)).toEqual(['old-inbox', 'someday', 'sam-1', 'late']);
    expect(stuck.find((s) => s.task_id === 'someday')?.reason).toBe(
      'rescheduled 4 times, untouched for 200 days',
    );
    expect(stuck.find((s) => s.task_id === 'late')?.reason).toBe('overdue 13 days');
    expect(stuck.find((s) => s.task_id === 'sam-1')).toMatchObject({
      person: 'Sam',
      reason: 'picked as a focus 4 times and still open',
    });

    ledger.tasks['old-inbox'].lastDecided = shiftYmd(TODAY, -3);
    expect(tasks.findStuck(people, ledger, TODAY, 2).map((s) => s.task_id)).toEqual([
      'someday',
      'sam-1',
    ]);
  });
});

describe('yesterdayResults', () => {
  const write = (picks: unknown) => {
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    writeFileSync(
      join(dir, 'tasks', `focus_${shiftYmd(TODAY, -1)}.json`),
      JSON.stringify({ picks }),
    );
  };

  it("counts yesterday's picks that were completed", () => {
    write([
      { person: 'Alex', task_id: 'done-1', content: 'a' },
      { person: 'Alex', task_id: 'late', content: 'b' },
      { person: 'Sam', task_id: 'sam-1', content: 'c' },
    ]);
    expect(tasks.yesterdayResults(dir, tasks.readTodoist(payload()), TODAY)).toEqual({
      picked: 3,
      done: 1,
      byPerson: { Alex: { picked: 2, done: 1 }, Sam: { picked: 1, done: 0 } },
    });
  });

  it('is null with no record, an empty record, or a corrupt one', () => {
    const people = tasks.readTodoist(payload());
    expect(tasks.yesterdayResults(dir, people, TODAY)).toBeNull();
    write([]);
    expect(tasks.yesterdayResults(dir, people, TODAY)).toBeNull();
    writeFileSync(join(dir, 'tasks', `focus_${shiftYmd(TODAY, -1)}.json`), '{bad');
    expect(tasks.yesterdayResults(dir, people, TODAY)).toBeNull();
  });
});

describe('buildCoachContext', () => {
  it('tells the writer the rules, the free time, the stuck tasks and how yesterday went', () => {
    const people = tasks.readTodoist(payload());
    const ctx = tasks.buildCoachContext(
      settings(),
      [{ task_id: 'someday', person: 'Alex', content: 'Clean the garage', reason: 'untouched' }],
      { Alex: ['12:00 PM–3:30 PM'], Sam: [] },
      { picked: 2, done: 1, byPerson: {} },
      people,
    );
    expect(ctx).toContain('up to 3 tasks per person (Alex, Sam)');
    expect(ctx).toContain('- Alex: 12:00 PM–3:30 PM');
    expect(ctx).toContain('- Sam: no free stretch');
    expect(ctx).toContain('[someday] Alex: "Clean the garage" — untouched');
    expect(ctx).toContain("Yesterday's focus: 1 of 2 done");
    expect(ctx).toContain('Never capture from a thread where `lastFromUs` is true');
  });

  it('says when there is no calendar data and no stuck task', () => {
    const ctx = tasks.buildCoachContext(settings(), [], {}, null, []);
    expect(ctx).toContain('(no calendar data)');
    expect(ctx).toContain('- none');
    expect(ctx).not.toContain("Yesterday's focus");
  });
});

describe('extractPlan', () => {
  const people = tasks.readTodoist(payload());
  const stuck = [
    { task_id: 'someday', person: 'Alex', content: 'Clean the garage', reason: 'r' },
    { task_id: 'old-inbox', person: 'Alex', content: 'Sort', reason: 'r' },
  ];

  it('separates the plan from the brief and keeps only what refers to real tasks', () => {
    const { brief, plan } = tasks.extractPlan(
      {
        title: 'T',
        sections: [{ heading: 'Executive Brief', items: [] }],
        focus: [
          { person: 'Sam', task_id: 'late', when: '12:30 PM', why: 'overdue' },
          { person: 'Alex', task_id: 'late', when: 'again', why: 'dup' },
          { person: 'Alex', task_id: 'undated-rec', when: 'x', why: 'recurring' },
          { person: 'Alex', task_id: 'ghost', when: 'x', why: 'not a task' },
          { person: 'Alex', task_id: 'soon', when: 7, why: null },
          { person: 'Alex', task_id: 'someday', when: 'x', why: 'over the cap' },
          'junk',
        ],
        decide: [
          { task_id: 'soon', action: 'drop', detail: 'not stuck' },
          { task_id: 'old-inbox', action: 'explode', detail: 'bad action' },
          { task_id: 'old-inbox', action: 'first_step', detail: 'Open the folder' },
          { task_id: 'old-inbox', action: 'drop', detail: 'dup' },
        ],
        capture: [
          {
            person: 'Alex',
            content: ' Pay the water bill ',
            due_date: '2026-10-20',
            source: 'Water bill',
          },
          { person: 'Nobody', content: 'x', source: 'y' },
          { person: 'Sam', content: '   ', source: 'y' },
          { person: 'Sam', content: 'RSVP to the party', due_date: 'Friday', source: 'Invite' },
        ],
        capture_prompts: ['  Any follow-ups from the meeting?  ', '', 42, 'Second', 'Third'],
      },
      people,
      settings({ focusPerPerson: 2 }),
      stuck,
    );

    expect(brief).toEqual({ title: 'T', sections: [{ heading: 'Executive Brief', items: [] }] });
    // The owner comes from the data, not from what the writer claimed.
    expect(plan.focus).toEqual([
      { person: 'Alex', task_id: 'late', when: '12:30 PM', why: 'overdue' },
      { person: 'Alex', task_id: 'soon', when: '', why: '' },
    ]);
    expect(plan.decide).toEqual([
      { task_id: 'old-inbox', action: 'first_step', detail: 'Open the folder' },
    ]);
    expect(plan.capture).toEqual([
      {
        person: 'Alex',
        content: 'Pay the water bill',
        due_date: '2026-10-20',
        source: 'Water bill',
      },
      { person: 'Sam', content: 'RSVP to the party', source: 'Invite' },
    ]);
    expect(plan.capture_prompts).toEqual(['Any follow-ups from the meeting?', 'Second']);
  });

  it('respects the decide and capture caps, and keeps a focus pick out of decide', () => {
    const { plan } = tasks.extractPlan(
      {
        title: 'T',
        sections: [],
        focus: [{ task_id: 'someday', person: 'Alex', when: 'x', why: 'y' }],
        decide: [
          { task_id: 'someday', action: 'drop', detail: 'is a focus' },
          { task_id: 'old-inbox', action: 'drop', detail: 'ok' },
        ],
        capture: [
          { person: 'Alex', content: 'One', source: 's' },
          { person: 'Alex', content: 'Two', source: 's' },
        ],
      },
      people,
      settings({ maxDecide: 0, maxCaptures: 1 }),
      stuck,
    );
    expect(plan.decide).toEqual([]);
    expect(plan.capture.map((c) => c.content)).toEqual(['One']);
    expect(plan.capture_prompts).toEqual([]);
  });

  it('copes with a writer that returned no plan at all', () => {
    const { plan } = tasks.extractPlan({ title: 'T', sections: [] }, people, settings(), stuck);
    expect(plan).toEqual(tasks.EMPTY_PLAN);
  });
});

describe('captureKey', () => {
  it('ignores case, punctuation and word order', () => {
    expect(tasks.captureKey('Alex', 'Pay the WATER bill!')).toBe(
      tasks.captureKey('alex', 'bill water pay the'),
    );
  });
});

describe('applyPlan', () => {
  const config: CallsheetConfig = {
    connectors: {
      todoist: {
        accounts: [
          { name: 'Alex', token_env: 'TEST_TD_ALEX' },
          { name: 'Sam', token_env: 'TEST_TD_SAM' },
        ],
      },
    },
  };
  const people = () => tasks.readTodoist(payload());
  const emptyLedger = (): ReturnType<typeof tasks.loadLedger> => ({
    tasks: {},
    captured: [],
    days: [],
  });

  function mockTodoist(fail: (path: string) => boolean = () => false) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = jest.fn(((url: string | URL | Request, init?: { body?: string }) => {
      const u = url.toString();
      calls.push({ url: u, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      if (fail(u))
        return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('') });
      if (u.endsWith('/tasks')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"id":"new-1"}'),
        });
      }
      return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') });
    }) as typeof fetch);
    return calls;
  }

  it('adds captures under the label, schedules undated focus picks, and records both', async () => {
    process.env.TEST_TD_ALEX = 'tok-a';
    process.env.TEST_TD_SAM = 'tok-s';
    const calls = mockTodoist();
    const ledger = emptyLedger();

    const result = await tasks.applyPlan(
      {
        focus: [
          { person: 'Alex', task_id: 'late', when: '', why: '' }, // overdue: already on today's list
          { person: 'Alex', task_id: 'soon', when: '', why: '' }, // future-dated: moved to today
          { person: 'Alex', task_id: 'chore', when: '', why: '' }, // recurring: never touched
          { person: 'Sam', task_id: 'sam-1', when: '', why: '' }, // undated: set to today
          { person: 'Sam', task_id: 'ghost', when: '', why: '' }, // not a task
        ],
        decide: [],
        capture: [
          {
            person: 'Alex',
            content: 'Pay the water bill',
            due_date: '2026-10-20',
            source: 'Water bill',
          },
          { person: 'Alex', content: 'Book the plumber', source: 'dup of a task' },
        ],
        capture_prompts: [],
      },
      people(),
      config,
      settings(),
      ledger,
      TODAY,
    );

    expect(result.added).toEqual([
      {
        person: 'Alex',
        content: 'Pay the water bill',
        due_date: '2026-10-20',
        source: 'Water bill',
        taskId: 'new-1',
      },
    ]);
    expect(result.skipped).toEqual([{ what: 'Book the plumber', why: 'already a task' }]);
    expect(result.scheduled.map((s) => s.task_id)).toEqual(['soon', 'sam-1']);
    expect(result.errors).toEqual([]);
    const add = calls.find((c) => c.url.endsWith('/tasks'));
    expect(add?.body).toMatchObject({
      content: 'Pay the water bill',
      labels: ['callsheet'],
      due_date: '2026-10-20',
    });
    expect(String(add?.body.description)).toContain('from: Water bill');
    expect(calls.find((c) => c.url.endsWith('/tasks/soon'))?.body).toEqual({ due_date: TODAY });
    expect(ledger.captured).toEqual([
      expect.objectContaining({ person: 'Alex', content: 'Pay the water bill', taskId: 'new-1' }),
    ]);
  });

  it('never re-adds a capture made before, and skips people without a token', async () => {
    process.env.TEST_TD_ALEX = 'tok-a';
    const calls = mockTodoist();
    const ledger = emptyLedger();
    ledger.captured.push({
      key: tasks.captureKey('Alex', 'Pay the water bill'),
      date: '2026-10-01',
      person: 'Alex',
      content: 'Pay the water bill',
    });

    const result = await tasks.applyPlan(
      {
        focus: [{ person: 'Sam', task_id: 'sam-1', when: '', why: '' }],
        decide: [],
        capture: [
          { person: 'Alex', content: 'pay water bill the', source: 's' },
          { person: 'Sam', content: 'RSVP to the party', source: 's' },
          { person: 'Alex', content: '!!!', source: 's' },
        ],
        capture_prompts: [],
      },
      people(),
      config,
      settings(),
      ledger,
      TODAY,
    );

    expect(result.skipped).toEqual([
      { what: 'pay water bill the', why: 'captured before' },
      { what: 'RSVP to the party', why: 'no Todoist token for Sam' },
      { what: '!!!', why: 'already a task' },
    ]);
    expect(result.scheduled).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reports API failures without throwing', async () => {
    process.env.TEST_TD_ALEX = 'tok-a';
    mockTodoist(() => true);
    const result = await tasks.applyPlan(
      {
        focus: [{ person: 'Alex', task_id: 'soon', when: '', why: '' }],
        decide: [],
        capture: [{ person: 'Alex', content: 'Pay the water bill', source: 's' }],
        capture_prompts: [],
      },
      people(),
      config,
      settings(),
      emptyLedger(),
      TODAY,
    );
    expect(result.added).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringMatching(/^add "Pay the water bill": Todoist tasks: 400/),
      expect.stringMatching(/^schedule "Book the plumber": Todoist tasks\/soon: 400/),
    ]);
  });

  it('does nothing when capture and scheduling are both off, or without config', async () => {
    const calls = mockTodoist();
    const plan = {
      focus: [{ person: 'Alex', task_id: 'soon', when: '', why: '' }],
      decide: [],
      capture: [{ person: 'Alex', content: 'Pay the water bill', source: 's' }],
      capture_prompts: [],
    };
    await tasks.applyPlan(
      plan,
      people(),
      config,
      settings({ capture: false, scheduleFocus: false }),
      emptyLedger(),
      TODAY,
    );
    const none = await tasks.applyPlan(plan, people(), {}, settings(), emptyLedger(), TODAY);
    expect(none.skipped).toEqual([
      { what: 'Pay the water bill', why: 'no Todoist token for Alex' },
    ]);
    expect(calls).toEqual([]);
  });

  it('reads an empty response body as success', async () => {
    process.env.TEST_TD_ALEX = 'tok-a';
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') }),
    ) as unknown as typeof fetch;
    const result = await tasks.applyPlan(
      {
        focus: [],
        decide: [],
        capture: [{ person: 'Alex', content: 'Pay the water bill', source: 's' }],
        capture_prompts: [],
      },
      people(),
      config,
      settings(),
      emptyLedger(),
      TODAY,
    );
    expect(result.added).toEqual([expect.objectContaining({ taskId: undefined })]);
  });
});

describe('recordDay and weekStats', () => {
  it('saves the focus record, counts focus and decisions, and keeps daily numbers', () => {
    const people = tasks.readTodoist(payload());
    let ledger = tasks.observeTasks({ tasks: {}, captured: [], days: [] }, people, TODAY);
    ledger.days.push({
      date: shiftYmd(TODAY, -1),
      open: 9,
      overdue: 2,
      focusPicked: 3,
      focusDone: 0,
      captured: 1,
    });
    ledger.days.push({
      date: TODAY,
      open: 0,
      overdue: 0,
      focusPicked: 0,
      focusDone: 0,
      captured: 0,
    });

    ledger = tasks.recordDay(
      dir,
      ledger,
      {
        focus: [
          { person: 'Alex', task_id: 'late', when: '', why: '' },
          { person: 'Alex', task_id: 'ghost', when: '', why: '' },
        ],
        decide: [
          { task_id: 'someday', action: 'drop', detail: '' },
          { task_id: 'ghost2', action: 'drop', detail: '' },
        ],
        capture: [],
        capture_prompts: [],
      },
      people,
      TODAY,
      { picked: 3, done: 2, byPerson: {} },
      1,
    );

    const focus = JSON.parse(readFileSync(join(dir, 'tasks', `focus_${TODAY}.json`), 'utf-8')) as {
      picks: { task_id: string; content: string }[];
    };
    expect(focus.picks).toEqual([
      { person: 'Alex', task_id: 'late', content: 'Renew registration' },
      { person: 'Alex', task_id: 'ghost', content: '' },
    ]);
    expect(ledger.tasks.late.focusCount).toBe(1);
    expect(ledger.tasks.someday.lastDecided).toBe(TODAY);
    expect(ledger.days).toEqual([
      { date: shiftYmd(TODAY, -1), open: 9, overdue: 2, focusPicked: 3, focusDone: 2, captured: 1 },
      { date: TODAY, open: 7, overdue: 1, focusPicked: 2, focusDone: 0, captured: 1 },
    ]);

    expect(tasks.weekStats(ledger, shiftYmd(TODAY, 1))).toBe(
      'Task coach, last 2 day(s): 2 of 5 focus picks done; 2 task(s) captured into Todoist; open tasks 9 → 7, overdue 2 → 1.',
    );
    expect(tasks.weekStats({ tasks: {}, captured: [], days: [] }, TODAY)).toBeNull();
  });
});

describe('renderPlan', () => {
  const people = tasks.readTodoist(payload());
  const base = (): Brief => ({
    title: 'T',
    sections: [
      { heading: 'Executive Brief', items: [{ label: 'x' }] },
      { heading: 'Tasks', items: [{ label: 'y', checkbox: true }] },
      { heading: "Today's Focus", items: [{ label: 'the writer was told not to do this' }] },
      { heading: 'Upcoming', items: [] },
    ],
  });
  const plan = {
    focus: [
      { person: 'Alex', task_id: 'late', when: '12:30 PM', why: 'overdue' },
      { person: 'Alex', task_id: 'soon', when: '', why: '' },
      { person: 'Alex', task_id: 'ghost', when: '', why: '' },
    ],
    decide: [
      { task_id: 'someday', action: 'drop' as const, detail: 'No longer needed' },
      { task_id: 'ghost', action: 'drop' as const, detail: '' },
    ],
    capture: [],
    capture_prompts: ['Any follow-ups from the meeting?'],
  };
  const stuck = [
    {
      task_id: 'someday',
      person: 'Alex',
      content: 'Clean the garage',
      reason: 'untouched for 200 days',
    },
  ];

  it('puts focus after the Executive Brief, decisions after Tasks, and actions and prompts last', () => {
    const out = tasks.renderPlan(
      base(),
      plan,
      people,
      stuck,
      {
        added: [
          { person: 'Sam', content: 'RSVP', source: 'Invite', due_date: '2026-10-20' },
          { person: 'Sam', content: 'Call back', source: 'Voicemail' },
        ],
        scheduled: [{ person: 'Alex', task_id: 'soon', content: 'Book the plumber' }],
        skipped: [],
        errors: [],
      },
      { picked: 2, done: 1, byPerson: { Alex: { picked: 2, done: 1 } } },
      settings(),
    );

    expect(out.sections.map((s) => s.heading)).toEqual([
      'Executive Brief',
      "Today's Focus",
      'Tasks',
      'Stuck — Decide Today',
      'Upcoming',
      'Added to Todoist',
      'Capture',
    ]);
    const focus = out.sections[1].items!;
    expect(focus[0]).toEqual({ label: 'Yesterday: 1 of 2 focus tasks done', note: 'Alex 1/2' });
    expect(focus[1]).toEqual({
      label: 'Renew registration',
      time: '12:30 PM',
      note: 'Alex · overdue',
      checkbox: true,
      highlight: true,
    });
    expect(focus[2]).toEqual({
      label: 'Book the plumber',
      note: 'Alex · set for today in Todoist',
      checkbox: true,
    });
    expect(out.sections[3].items).toEqual([
      {
        label: 'Clean the garage',
        note: 'Alex · untouched for 200 days → Drop it: No longer needed',
        checkbox: true,
      },
    ]);
    expect(out.sections[5].items?.[0].note).toBe(
      'Sam · due 2026-10-20 · from Invite · label "callsheet"',
    );
    expect(out.sections[5].items?.[1].note).toContain('inbox');
    expect(out.sections[6].body).toBe(
      '→ Any follow-ups from the meeting?\nNew tasks go straight into Todoist.',
    );
  });

  it('adds nothing when there is nothing to show, and falls back on positions', () => {
    const empty = tasks.renderPlan(
      { title: 'T', sections: [{ heading: 'Schedule', items: [] }] },
      tasks.EMPTY_PLAN,
      people,
      [],
      null,
      null,
      settings(),
    );
    expect(empty.sections.map((s) => s.heading)).toEqual(['Schedule']);

    const noExec = tasks.renderPlan(
      { title: 'T', sections: [{ heading: 'Schedule', items: [] }] },
      { ...plan, capture_prompts: [] },
      people,
      stuck,
      null,
      null,
      settings(),
    );
    expect(noExec.sections.map((s) => s.heading)).toEqual([
      "Today's Focus",
      'Stuck — Decide Today',
      'Schedule',
    ]);
    expect(existsSync(join(dir, 'tasks'))).toBe(false);
  });
});
