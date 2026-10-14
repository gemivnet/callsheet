import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL } from '../test-icons.js';
import { retry, HttpError } from '../retry.js';
import { todayYmd, shiftYmd } from '../dates.js';

const API = 'https://api.todoist.com/api/v1';

/** Retry budget for Todoist calls — their API has periodic 503 blips. */
const TODOIST_RETRIES = 3;
const TODOIST_BASE_DELAY_MS = 500;

/** How far back "recently completed" looks. */
const COMPLETED_LOOKBACK_DAYS = 3;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function todoistOnRetry(label: string): (attempt: number, err: unknown, delayMs: number) => void {
  return (attempt, err, delayMs) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `  todoist: ${label} attempt ${attempt} failed (${msg}), retrying in ${delayMs}ms...`,
    );
  };
}

/** A task as the v1 API returns it (the fields this connector reads). */
interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  labels?: string[];
  added_at?: string | null;
  responsible_uid?: string | null;
  postponed_count?: number | null;
  deadline?: { date?: string } | null;
  due?: {
    date: string;
    string?: string;
    is_recurring?: boolean;
    timezone?: string | null;
  } | null;
}

interface CompletedTask extends TodoistTask {
  completed_at?: string | null;
  completed_by_uid?: string | null;
}

interface PaginatedResponse<T> {
  results: T[];
  next_cursor: string | null;
}

/** Todoist's own label for an API priority. The API counts the other way: 4 is p1. */
export type PriorityLabel = 'p1' | 'p2' | 'p3' | 'p4';

/** A task shaped for the brief, with everything a writer would otherwise compute. */
export interface BriefTask {
  id: string;
  content: string;
  description?: string;
  project: string;
  /**
   * Todoist's label, never the raw number. The raw `priority: 1` is the
   * LOWEST priority, and briefs repeatedly printed such tasks as "priority 1"
   * — the opposite of what the data said.
   */
  priority: PriorityLabel;
  labels?: string[];
  dueDate: string;
  dueTime?: string;
  dueWeekday?: string;
  dueString?: string;
  isRecurring: boolean;
  /** Whole days past due, computed in the household timezone; absent when not overdue. */
  daysOverdue?: number;
  deadline?: string;
  /** Local date the task was created, and its age in days. */
  addedDate?: string;
  ageDays?: number;
  /** How many times the due date has been pushed back. */
  postponedCount?: number;
  /** Household member it is assigned to, when it is assigned. */
  assignee?: string;
  /** Other household members who see this task in a shared project. */
  sharedWith?: string[];
}

interface AccountFetch {
  person: string;
  userId?: string;
  tasks: (TodoistTask & { projectName: string; inInbox: boolean })[];
  completed: CompletedTask[];
  completedError?: string;
  projects: Record<string, string>;
}

/** Map an API priority (4 = most urgent) to the label the app shows (p1 = most urgent). */
export function priorityLabel(apiPriority: number | undefined): PriorityLabel {
  if (apiPriority === 4) return 'p1';
  if (apiPriority === 3) return 'p2';
  if (apiPriority === 2) return 'p3';
  return 'p4';
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD each). */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Weekday name of a YYYY-MM-DD date. */
function weekdayOf(ymd: string): string {
  return WEEKDAYS[
    new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), 12)).getUTCDay()
  ];
}

/**
 * Split a Todoist due value into a local date and an optional time label.
 *
 * `due.date` is "YYYY-MM-DD" for a date, "YYYY-MM-DDTHH:MM:SS" for a floating
 * local time, and the same with a trailing "Z" for a fixed instant. Comparing
 * the whole string against today's date (what the connector used to do) filed
 * a task due today at 2 PM under "upcoming".
 */
export function splitDue(date: string, tz: string): { date: string; time?: string } {
  if (!date.includes('T')) return { date: date.slice(0, 10) };
  if (date.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(date)) {
    const instant = new Date(date);
    return {
      date: todayYmd(tz, instant),
      time: new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(instant),
    };
  }
  const [h, m] = date.slice(11, 16).split(':').map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return {
    date: date.slice(0, 10),
    time: `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`,
  };
}

async function getPaged<T>(token: string, endpoint: string, params?: Record<string, string>) {
  const headers = { Authorization: `Bearer ${token}` };
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${API}/${endpoint}`);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    if (cursor) url.searchParams.set('cursor', cursor);

    const data = await retry(
      async () => {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!resp.ok) {
          throw new HttpError(resp.status, `Todoist ${endpoint}: ${resp.status}`, url.toString());
        }
        return (await resp.json()) as PaginatedResponse<T>;
      },
      {
        retries: TODOIST_RETRIES,
        baseDelayMs: TODOIST_BASE_DELAY_MS,
        onRetry: todoistOnRetry(endpoint),
      },
    );
    all.push(...(data.results ?? []));
    cursor = data.next_cursor;
  } while (cursor);
  return all;
}

async function fetchAccount(token: string, person: string): Promise<AccountFetch> {
  const headers = { Authorization: `Bearer ${token}` };

  // The account's own user id lets a task in a shared project be attributed
  // to whoever it is assigned to rather than to whichever account listed it.
  let userId: string | undefined;
  try {
    const resp = await fetch(`${API}/user`, { headers, signal: AbortSignal.timeout(15_000) });
    if (resp.ok) userId = ((await resp.json()) as { id?: string }).id;
  } catch {
    /* attribution falls back to the account that listed the task */
  }

  const projectList = await getPaged<{ id: string; name: string; inbox_project?: boolean }>(
    token,
    'projects',
  );
  const projects = Object.fromEntries(projectList.map((p) => [p.id, p.name]));
  const inboxId = projectList.find((p) => p.inbox_project)?.id;

  const tasks = (await getPaged<TodoistTask>(token, 'tasks')).map((t) => ({
    ...t,
    projectName: projects[t.project_id ?? ''] ?? '',
    inInbox: t.project_id === inboxId,
  }));

  // Recently completed: so the brief never re-flags a finished task, and so it
  // can say what got done. A failure is reported, not swallowed — an outage
  // used to look exactly like a household that had finished nothing.
  let completed: CompletedTask[] = [];
  let completedError: string | undefined;
  try {
    const until = new Date();
    const since = new Date(until.getTime() - COMPLETED_LOOKBACK_DAYS * 86_400_000);
    const url = new URL(`${API}/tasks/completed/by_completion_date`);
    url.searchParams.set('since', since.toISOString());
    url.searchParams.set('until', until.toISOString());
    url.searchParams.set('limit', '200');
    const data = await retry(
      async () => {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!resp.ok) {
          throw new HttpError(resp.status, `Todoist completed: ${resp.status}`, url.toString());
        }
        return (await resp.json()) as { items?: CompletedTask[] };
      },
      {
        retries: TODOIST_RETRIES,
        baseDelayMs: TODOIST_BASE_DELAY_MS,
        onRetry: todoistOnRetry('completed'),
      },
    );
    completed = data.items ?? [];
  } catch (e) {
    completedError = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: todoist ${person}: recently completed unavailable (${completedError})`);
  }

  return { person, userId, tasks, completed, completedError, projects };
}

/** Shape one task for the brief. */
function shapeTask(
  t: TodoistTask & { projectName: string },
  today: string,
  tz: string,
  people: Map<string, string>,
): BriefTask {
  const due = t.due?.date ? splitDue(t.due.date, tz) : undefined;
  const added = t.added_at ? todayYmd(tz, new Date(t.added_at)) : undefined;
  const overdue = due && due.date < today ? daysBetween(due.date, today) : 0;
  const assignee = t.responsible_uid ? people.get(t.responsible_uid) : undefined;

  const out: BriefTask = {
    id: t.id,
    content: t.content,
    project: t.projectName,
    priority: priorityLabel(t.priority),
    dueDate: due?.date ?? '',
    isRecurring: t.due?.is_recurring ?? false,
  };
  const description = (t.description ?? '').slice(0, 200);
  if (description) out.description = description;
  if (t.labels?.length) out.labels = t.labels;
  if (due?.time) out.dueTime = due.time;
  if (due) out.dueWeekday = weekdayOf(due.date);
  if (t.due?.string) out.dueString = t.due.string;
  if (overdue > 0) out.daysOverdue = overdue;
  if (t.deadline?.date) out.deadline = t.deadline.date;
  if (added) {
    out.addedDate = added;
    out.ageDays = daysBetween(added, today);
  }
  if (t.postponed_count) out.postponedCount = t.postponed_count;
  if (assignee) out.assignee = assignee;
  return out;
}

interface CollapsedProject {
  project: string;
  open: number;
  overdue: number;
  /** The most urgent few, so a genuine emergency is not hidden by the summary. */
  urgent: { content: string; priority: PriorityLabel; daysOverdue?: number }[];
}

/**
 * Bucket and summarise each person's tasks.
 *
 * Tasks in a shared project come back from every account that can see them;
 * they are listed once — under their assignee when they have one, otherwise
 * under the first account — with the others named in `sharedWith`. Counting
 * them once per account had turned 23 backlog items into "46".
 */
export function buildAccounts(
  fetched: AccountFetch[],
  today: string,
  tz: string,
  collapseProjects: string[] = [],
): Record<string, unknown>[] {
  const people = new Map<string, string>();
  for (const a of fetched) if (a.userId) people.set(a.userId, a.person);
  const collapse = new Set(collapseProjects.map((p) => p.toLowerCase()));
  const weekOut = shiftYmd(today, 7);

  // id -> owner person, and who else sees it
  const owner = new Map<string, string>();
  const seenBy = new Map<string, string[]>();
  for (const a of fetched) {
    for (const t of a.tasks) {
      seenBy.set(t.id, [...(seenBy.get(t.id) ?? []), a.person]);
      if (!owner.has(t.id)) {
        const assigned = t.responsible_uid ? people.get(t.responsible_uid) : undefined;
        owner.set(t.id, assigned ?? a.person);
      }
    }
  }

  return fetched.map((a) => {
    const mine = a.tasks.filter((t) => owner.get(t.id) === a.person);
    const shaped = mine.map((t) => {
      const s = shapeTask(t, today, tz, people);
      const others = (seenBy.get(t.id) ?? []).filter((p) => p !== a.person);
      if (others.length) s.sharedWith = [...new Set(others)];
      return { raw: t, task: s };
    });

    const collapsed = new Map<string, CollapsedProject>();
    const listed = shaped.filter(({ raw, task }) => {
      if (!collapse.has(raw.projectName.toLowerCase())) return true;
      const c = collapsed.get(raw.projectName) ?? {
        project: raw.projectName,
        open: 0,
        overdue: 0,
        urgent: [],
      };
      c.open++;
      if (task.daysOverdue) c.overdue++;
      if (task.priority === 'p1' && c.urgent.length < 2) {
        c.urgent.push({
          content: task.content,
          priority: task.priority,
          daysOverdue: task.daysOverdue,
        });
      }
      collapsed.set(raw.projectName, c);
      return false;
    });

    const today_ = listed.filter(({ task }) => task.dueDate && task.dueDate <= today);
    const inbox = listed.filter(({ raw, task }) => raw.inInbox && !task.dueDate);
    const upcoming = listed.filter(
      ({ task }) => task.dueDate && task.dueDate > today && task.dueDate <= weekOut,
    );
    const backlog = listed.filter(({ raw, task }) => !task.dueDate && !raw.inInbox);
    const overdue = today_.filter(({ task }) => task.daysOverdue);

    const completed = a.completed.map((c) => {
      const at = c.completed_at ? new Date(c.completed_at) : undefined;
      const by = c.completed_by_uid ? people.get(c.completed_by_uid) : undefined;
      return {
        id: c.id,
        content: c.content,
        project: a.projects[c.project_id ?? ''] ?? '',
        completedDate: at ? todayYmd(tz, at) : undefined,
        ...(by ? { completedBy: by } : {}),
      };
    });

    return {
      person: a.person,
      summary: {
        overdue: overdue.length,
        dueToday: today_.length - overdue.length,
        inbox: inbox.length,
        upcoming: upcoming.length,
        backlog: backlog.length,
        oldestOverdueDays: overdue.reduce((m, { task }) => Math.max(m, task.daysOverdue ?? 0), 0),
        completedLast3Days: completed.length,
      },
      today: today_.map(({ task }) => task),
      inbox: inbox.map(({ task }) => task),
      upcoming: upcoming.map(({ task }) => task),
      backlog: backlog.map(({ task }) => task),
      recently_completed: completed,
      ...(a.completedError ? { completedError: a.completedError } : {}),
      ...(collapsed.size ? { collapsed: [...collapsed.values()] } : {}),
    };
  });
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'todoist',
    description: 'Todoist — tasks, inbox, and upcoming for each person',

    async fetch(): Promise<ConnectorResult> {
      const accounts = (config.accounts ?? []) as { name: string; token_env: string }[];
      const tz =
        (config.timezone as string | undefined) ??
        process.env.TZ ??
        Intl.DateTimeFormat().resolvedOptions().timeZone;
      const today = todayYmd(tz);
      const collapseProjects = (config.collapse_projects as string[] | undefined) ?? [];

      const fetched: AccountFetch[] = [];
      for (const acct of accounts) {
        const token = process.env[acct.token_env] ?? '';
        if (!token) {
          console.log(`  Warning: ${acct.token_env} not set, skipping ${acct.name}`);
          continue;
        }
        fetched.push(await fetchAccount(token, acct.name));
      }

      const results = buildAccounts(fetched, today, tz, collapseProjects);
      const sum = (key: string) =>
        results.reduce((n, r) => n + ((r.summary as Record<string, number>)[key] ?? 0), 0);
      const failedCompleted = results.filter((r) => r.completedError).map((r) => r.person);

      return {
        source: 'todoist',
        description:
          `Todoist data for ${results.length} account(s), as of ${today}. ` +
          `${sum('overdue')} overdue, ${sum('dueToday')} due today, ${sum('inbox')} in inboxes, ` +
          `${sum('backlog')} in backlogs, ${sum('completedLast3Days')} completed in the last 3 days. ` +
          "Each account has a pre-computed `summary` (use its counts, never your own tally), 'today' " +
          "(due today or overdue), 'inbox' (unsorted, no date), 'upcoming' (next 7 days), 'backlog' " +
          "(no due date) and 'recently_completed' (finished in the last 3 days — anything there is " +
          'DONE; never re-flag it). ' +
          '`priority` is the label the app shows: p1 is the most urgent and p4 is the default for a ' +
          'task nobody prioritised — never call a p4 task high priority. ' +
          '`daysOverdue`, `ageDays` (days since created) and `postponedCount` (times rescheduled) are ' +
          'computed in the household timezone; quote them rather than working out dates yourself. ' +
          'A task in a shared project appears once, under its `assignee` when assigned, with ' +
          '`sharedWith` naming the others who see it. ' +
          (collapseProjects.length
            ? `Projects summarised rather than listed (\`collapsed\`): ${collapseProjects.join(', ')} — mention one only through its count, plus any p1 item it lists, and never list its tasks. `
            : '') +
          (failedCompleted.length
            ? `Recently completed could NOT be fetched for ${failedCompleted.join(', ')} — do not read an empty list as "nothing done". `
            : '') +
          "Inbox items are not necessarily actionable today — they're things to be aware of or process.",
        data: { today_ymd: today, accounts: results },
        priorityHint: 'high',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const accounts = (config.accounts ?? []) as { name: string; token_env: string }[];

  if (!accounts.length) {
    checks.push([FAIL, 'No accounts configured', '']);
    return checks;
  }

  checks.push([PASS, `${accounts.length} account(s) configured`, '']);

  for (const acct of accounts) {
    const token = process.env[acct.token_env] ?? '';
    if (token) {
      const masked = token.length > 12 ? token.slice(0, 8) + '...' + token.slice(-4) : '***';
      checks.push([PASS, `${acct.name}: ${acct.token_env} is set`, masked]);
    } else {
      checks.push([FAIL, `${acct.name}: ${acct.token_env} is NOT set`, 'Add it to .env']);
    }
  }

  return checks;
}
