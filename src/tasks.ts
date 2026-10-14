/**
 * Task coach — turns the brief from a list of tasks into a plan for the day.
 *
 * Six months of briefs printed a median of eleven checkboxes a morning, the
 * same ones day after day: one inbox item appeared in 133 of 137 briefs, and
 * of every task printed, 92% had been printed the day before and 2% were done
 * by the next morning. The brief never picked a few, never said when, never
 * asked whether a task stuck for months should be dropped, and the actions it
 * found in email lived only on paper and evaporated two days later.
 *
 * The writer now returns a structured plan alongside the brief — a few focus
 * picks per person with a time slot, a decision for each stuck task, and the
 * actions it found that are not in Todoist yet. This module checks that plan
 * against the real task data, records it, carries it out in Todoist (adding
 * captured tasks under a label, scheduling undated focus picks for today),
 * and renders it onto the page with yesterday's results.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Brief, BriefItem, BriefSection, CallsheetConfig } from './types.js';
import { shiftYmd } from './dates.js';
import { retry, HttpError } from './retry.js';

const TODOIST_API = 'https://api.todoist.com/api/v1';
const TASKS_DIR = 'tasks';

/** Section headings this module owns; the review leaves them alone. */
export const FOCUS_HEADING = "Today's Focus";
export const DECIDE_HEADING = 'Stuck — Decide Today';
export const ADDED_HEADING = 'Added to Todoist';
export const CAPTURE_HEADING = 'Capture';
export const COACH_HEADINGS = [FOCUS_HEADING, DECIDE_HEADING, ADDED_HEADING, CAPTURE_HEADING];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TaskCoachSettings {
  enabled: boolean;
  focusPerPerson: number;
  maxDecide: number;
  capture: boolean;
  maxCaptures: number;
  captureLabel: string;
  scheduleFocus: boolean;
}

/** Settings from `task_coach` in config, with defaults. Off unless enabled. */
export function coachSettings(config: CallsheetConfig): TaskCoachSettings {
  const c = (config.task_coach ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
  return {
    enabled: c.enabled === true,
    focusPerPerson: num(c.focus_per_person, 3),
    maxDecide: num(c.max_decide, 3),
    capture: c.capture !== false,
    maxCaptures: num(c.max_captures, 3),
    captureLabel:
      typeof c.capture_label === 'string' && c.capture_label ? c.capture_label : 'callsheet',
    scheduleFocus: c.schedule_focus !== false,
  };
}

// ---------------------------------------------------------------------------
// Reading the day's task data
// ---------------------------------------------------------------------------

/** A task as the Todoist connector shapes it (the fields used here). */
export interface CoachTask {
  id: string;
  content: string;
  priority?: string;
  dueDate?: string;
  isRecurring?: boolean;
  daysOverdue?: number;
  ageDays?: number;
  postponedCount?: number;
  project?: string;
}

export interface PersonTasks {
  person: string;
  open: (CoachTask & { bucket: 'today' | 'inbox' | 'upcoming' | 'backlog' })[];
  completedIds: string[];
}

/** Each person's open and recently completed tasks, from the run's payload. */
export function readTodoist(dataPayload: string): PersonTasks[] {
  try {
    const sections = JSON.parse(dataPayload) as {
      source?: string;
      data?: Record<string, unknown>;
    }[];
    const todoist = Array.isArray(sections)
      ? sections.find((s) => s?.source === 'todoist')
      : undefined;
    const accounts = (todoist?.data?.accounts ?? []) as Record<string, unknown>[];
    return accounts.map((a) => {
      const open: PersonTasks['open'] = [];
      for (const bucket of ['today', 'inbox', 'upcoming', 'backlog'] as const) {
        for (const t of (a[bucket] as CoachTask[] | undefined) ?? []) {
          if (t && typeof t.id === 'string') open.push({ ...t, bucket });
        }
      }
      const completedIds = ((a.recently_completed as { id?: string }[] | undefined) ?? [])
        .map((c) => c.id)
        .filter((id): id is string => typeof id === 'string');
      return { person: typeof a.person === 'string' ? a.person : '', open, completedIds };
    });
  } catch {
    return [];
  }
}

/** Each person's free stretches today, from the calendar payload. */
export function readFreeTime(dataPayload: string): Record<string, string[]> {
  try {
    const sections = JSON.parse(dataPayload) as {
      source?: string;
      data?: Record<string, unknown>;
    }[];
    const cal = Array.isArray(sections)
      ? sections.find((s) => s?.source === 'google_calendar')
      : undefined;
    return (cal?.data?.free_time_today as Record<string, string[]> | undefined) ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The ledger — what the coach has seen and done
// ---------------------------------------------------------------------------

export interface LedgerTask {
  firstSeen: string;
  lastSeen: string;
  focusCount: number;
  lastDecided?: string;
}

export interface CapturedRecord {
  key: string;
  date: string;
  person: string;
  content: string;
  taskId?: string;
}

export interface DaySummary {
  date: string;
  open: number;
  overdue: number;
  focusPicked: number;
  focusDone: number;
  captured: number;
}

export interface Ledger {
  tasks: Record<string, LedgerTask>;
  captured: CapturedRecord[];
  days: DaySummary[];
}

const ledgerPath = (outputDir: string) => join(outputDir, TASKS_DIR, 'ledger.json');

export function loadLedger(outputDir: string): Ledger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(outputDir), 'utf-8')) as Partial<Ledger>;
    return { tasks: raw.tasks ?? {}, captured: raw.captured ?? [], days: raw.days ?? [] };
  } catch {
    return { tasks: {}, captured: [], days: [] };
  }
}

export function saveLedger(outputDir: string, ledger: Ledger): void {
  mkdirSync(join(outputDir, TASKS_DIR), { recursive: true });
  writeFileSync(ledgerPath(outputDir), JSON.stringify(ledger, null, 2));
}

/** Record today's sighting of every open task, and forget tasks long gone. */
export function observeTasks(ledger: Ledger, people: PersonTasks[], today: string): Ledger {
  const tasks = { ...ledger.tasks };
  for (const p of people) {
    for (const t of p.open) {
      const prev = tasks[t.id];
      tasks[t.id] = prev
        ? { ...prev, lastSeen: today }
        : { firstSeen: today, lastSeen: today, focusCount: 0 };
    }
  }
  const forgetBefore = shiftYmd(today, -90);
  const kept = Object.fromEntries(
    Object.entries(tasks).filter(([, t]) => t.lastSeen >= forgetBefore),
  );
  const captured = ledger.captured.filter((c) => c.date >= shiftYmd(today, -120));
  return { ...ledger, tasks: kept, captured };
}

// ---------------------------------------------------------------------------
// Stuck tasks and yesterday's results
// ---------------------------------------------------------------------------

export interface StuckTask {
  task_id: string;
  person: string;
  content: string;
  reason: string;
}

/**
 * Tasks that are not moving: long overdue, pushed back again and again, left
 * in an inbox for weeks, picked as a focus repeatedly without being done. A
 * task decided on in the last week is left alone, so the page asks about a
 * stuck task once rather than every morning.
 */
export function findStuck(
  people: PersonTasks[],
  ledger: Ledger,
  today: string,
  limit = 5,
): StuckTask[] {
  const recentDecision = shiftYmd(today, -7);
  const scored: (StuckTask & { score: number })[] = [];
  for (const p of people) {
    for (const t of p.open) {
      if (t.isRecurring) continue;
      const seen = ledger.tasks[t.id];
      if (seen?.lastDecided && seen.lastDecided >= recentDecision) continue;
      const reasons: string[] = [];
      let score = 0;
      if ((t.daysOverdue ?? 0) >= 7) {
        reasons.push(`overdue ${t.daysOverdue} days`);
        score += t.daysOverdue ?? 0;
      }
      if ((t.postponedCount ?? 0) >= 3) {
        reasons.push(`rescheduled ${t.postponedCount} times`);
        score += 10 + (t.postponedCount ?? 0);
      }
      if (t.bucket === 'inbox' && (t.ageDays ?? 0) >= 14) {
        reasons.push(`in the inbox ${t.ageDays} days`);
        score += (t.ageDays ?? 0) / 2;
      }
      if (t.bucket === 'backlog' && (t.ageDays ?? 0) >= 60) {
        reasons.push(`untouched for ${t.ageDays} days`);
        score += (t.ageDays ?? 0) / 10;
      }
      if ((seen?.focusCount ?? 0) >= 3) {
        reasons.push(`picked as a focus ${seen?.focusCount} times and still open`);
        score += 5 * (seen?.focusCount ?? 0);
      }
      if (!reasons.length) continue;
      scored.push({
        task_id: t.id,
        person: p.person,
        content: t.content,
        reason: reasons.join(', '),
        score,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...rest }) => rest);
}

export interface FocusRecord {
  date: string;
  picks: { person: string; task_id: string; content: string }[];
}

const focusPath = (outputDir: string, date: string) =>
  join(outputDir, TASKS_DIR, `focus_${date}.json`);

export interface YesterdayResult {
  picked: number;
  done: number;
  byPerson: Record<string, { picked: number; done: number }>;
}

/** How yesterday's focus picks fared: done when they appear in recently completed. */
export function yesterdayResults(
  outputDir: string,
  people: PersonTasks[],
  today: string,
): YesterdayResult | null {
  const path = focusPath(outputDir, shiftYmd(today, -1));
  if (!existsSync(path)) return null;
  let record: FocusRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf-8')) as FocusRecord;
  } catch {
    return null;
  }
  if (!record.picks?.length) return null;
  const completed = new Set(people.flatMap((p) => p.completedIds));
  const result: YesterdayResult = { picked: 0, done: 0, byPerson: {} };
  for (const pick of record.picks) {
    const row = (result.byPerson[pick.person] ??= { picked: 0, done: 0 });
    row.picked++;
    result.picked++;
    if (completed.has(pick.task_id)) {
      row.done++;
      result.done++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// What the writer is told, and what it must return
// ---------------------------------------------------------------------------

/** The plan the writer returns alongside the brief. */
export interface TaskPlan {
  focus: { person: string; task_id: string; when: string; why: string }[];
  decide: {
    task_id: string;
    action: 'schedule' | 'first_step' | 'delegate' | 'drop';
    detail: string;
  }[];
  capture: { person: string; content: string; due_date?: string; source: string }[];
  capture_prompts: string[];
}

export const EMPTY_PLAN: TaskPlan = { focus: [], decide: [], capture: [], capture_prompts: [] };

/** Schema fragment for the plan, merged into the brief's output schema. */
export const PLAN_SCHEMA_PROPERTIES = {
  focus: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        person: { type: 'string' },
        task_id: { type: 'string' },
        when: { type: 'string' },
        why: { type: 'string' },
      },
      required: ['person', 'task_id', 'when', 'why'],
      additionalProperties: false,
    },
  },
  decide: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        action: { type: 'string', enum: ['schedule', 'first_step', 'delegate', 'drop'] },
        detail: { type: 'string' },
      },
      required: ['task_id', 'action', 'detail'],
      additionalProperties: false,
    },
  },
  capture: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        person: { type: 'string' },
        content: { type: 'string' },
        due_date: { type: 'string', format: 'date' },
        source: { type: 'string' },
      },
      required: ['person', 'content', 'source'],
      additionalProperties: false,
    },
  },
  capture_prompts: { type: 'array', items: { type: 'string' } },
} as const;

/**
 * The task-coach part of the writer's instructions for today: who has which
 * free stretches, which tasks are stuck and why, how yesterday went, and the
 * rules for the plan.
 */
export function buildCoachContext(
  settings: TaskCoachSettings,
  stuck: StuckTask[],
  freeTime: Record<string, string[]>,
  yesterday: YesterdayResult | null,
  people: PersonTasks[],
): string {
  let ctx = '\n\n<task_coach>\n';
  ctx +=
    'Besides the sections, return a plan in `focus`, `decide`, `capture` and `capture_prompts`. ' +
    'Code renders these onto the page and carries them out in Todoist — do NOT also write a ' +
    '"Today\'s Focus", "Decide", "Added to Todoist" or "Capture" section yourself, and keep any ' +
    'task you put in `focus` or `decide` out of the Tasks section.\n\n';
  ctx +=
    `focus: up to ${settings.focusPerPerson} tasks per person (${people
      .map((p) => p.person)
      .join(', ')}) that matter most TODAY, by task_id from that person's Todoist data — overdue ` +
    "or due today first, then anything tied to today's events or deadlines, then a quick win " +
    'that fits a free stretch. Never pick a recurring chore that is not due, a task from a ' +
    'collapsed project, or more than the person can do. `when` is a concrete slot from their ' +
    'free time below ("12:30 PM", "after 5 PM", "lunch"); `why` is at most eight words.\n';
  ctx +=
    `decide: for up to ${settings.maxDecide} of the stuck tasks listed below, recommend exactly ` +
    'one action — `schedule` (detail: the date and why then), `first_step` (detail: the first ' +
    'concrete step, under ten minutes), `delegate` (detail: to whom), or `drop` (detail: why it ' +
    'no longer matters). Be decisive; a task untouched for months is usually a drop or a first ' +
    'step.\n';
  ctx +=
    `capture: up to ${settings.maxCaptures} actions you found in email or the calendar that are ` +
    "NOT already in anyone's Todoist — a bill to pay, a form, an RSVP, an appointment to book, " +
    'a reply someone is waiting on. Each needs the person, short imperative content ("Pay water ' +
    'bill"), `due_date` when the source states one, and `source` (the email subject or event). ' +
    'Never capture from a thread where `lastFromUs` is true, anything already done, or anything ' +
    'already a task.\n';
  ctx +=
    'capture_prompts: up to two short questions that jog memory for tasks nobody has written ' +
    'down, tied to what happened yesterday or is coming up ("After last night\'s meeting — any ' +
    'follow-ups?"). Leave empty when nothing prompts one.\n\n';

  ctx += 'Free time today:\n';
  for (const [person, windows] of Object.entries(freeTime)) {
    ctx += `- ${person}: ${windows.length ? windows.join(', ') : 'no free stretch'}\n`;
  }
  if (!Object.keys(freeTime).length) ctx += '- (no calendar data)\n';

  ctx += '\nStuck tasks (candidates for `decide`):\n';
  for (const s of stuck) ctx += `- [${s.task_id}] ${s.person}: "${s.content}" — ${s.reason}\n`;
  if (!stuck.length) ctx += '- none\n';

  if (yesterday) {
    ctx +=
      `\nYesterday's focus: ${yesterday.done} of ${yesterday.picked} done. ` +
      'This is printed for the household by code; do not repeat it.\n';
  }
  ctx += '</task_coach>\n';
  return ctx;
}

/**
 * Split the writer's output into the brief and the plan, and keep only the
 * parts of the plan that refer to real tasks and stay within the limits.
 */
export function extractPlan(
  raw: Record<string, unknown>,
  people: PersonTasks[],
  settings: TaskCoachSettings,
  stuck: StuckTask[],
): { brief: Brief; plan: TaskPlan } {
  const { focus, decide, capture, capture_prompts: prompts, ...rest } = raw;
  const brief = rest as unknown as Brief;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      : [];

  const owner = new Map<string, string>();
  for (const p of people) for (const t of p.open) owner.set(t.id, p.person);
  const undatedRecurring = new Set(
    people.flatMap((p) => p.open.filter((t) => t.isRecurring && !t.dueDate).map((t) => t.id)),
  );

  const plan: TaskPlan = { focus: [], decide: [], capture: [], capture_prompts: [] };
  const perPerson = new Map<string, number>();
  for (const f of list(focus)) {
    const id = str(f.task_id);
    const person = owner.get(id);
    if (!person || undatedRecurring.has(id) || plan.focus.some((x) => x.task_id === id)) {
      continue;
    }
    const n = perPerson.get(person) ?? 0;
    if (n >= settings.focusPerPerson) continue;
    perPerson.set(person, n + 1);
    plan.focus.push({ person, task_id: id, when: str(f.when), why: str(f.why) });
  }

  const stuckIds = new Set(stuck.map((s) => s.task_id));
  const actions = new Set(['schedule', 'first_step', 'delegate', 'drop']);
  for (const d of list(decide)) {
    if (plan.decide.length >= settings.maxDecide) break;
    const id = str(d.task_id);
    const action = str(d.action);
    if (!stuckIds.has(id) || !actions.has(action)) continue;
    if (plan.decide.some((x) => x.task_id === id) || plan.focus.some((x) => x.task_id === id)) {
      continue;
    }
    plan.decide.push({
      task_id: id,
      action: action as TaskPlan['decide'][number]['action'],
      detail: str(d.detail),
    });
  }

  const names = new Set(people.map((p) => p.person));
  for (const c of list(capture)) {
    if (plan.capture.length >= settings.maxCaptures) break;
    const person = str(c.person);
    const content = str(c.content).trim();
    if (!names.has(person) || !content) continue;
    const due = str(c.due_date);
    plan.capture.push({
      person,
      content: content.slice(0, 120),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(due) ? { due_date: due } : {}),
      source: str(c.source).slice(0, 120),
    });
  }

  plan.capture_prompts = (Array.isArray(prompts) ? prompts : [])
    .map(str)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.slice(0, 160));
  return { brief, plan };
}

// ---------------------------------------------------------------------------
// Carrying the plan out in Todoist
// ---------------------------------------------------------------------------

/** Words that identify a task, for "is this already a task?" checks. */
function taskWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3),
  );
}

/** Dedupe key for a capture: the person and the content's words, sorted. */
export function captureKey(person: string, content: string): string {
  return `${person.toLowerCase()}|${[...taskWords(content)].sort().join(' ')}`;
}

/** True when an open task already says much the same thing. */
function alreadyATask(content: string, open: CoachTask[]): boolean {
  const words = taskWords(content);
  if (!words.size) return true;
  return open.some((t) => {
    const other = taskWords(t.content);
    let shared = 0;
    for (const w of words) if (other.has(w)) shared++;
    return shared / words.size >= 0.6;
  });
}

export interface TodoistActionResult {
  added: { person: string; content: string; due_date?: string; source: string; taskId?: string }[];
  scheduled: { person: string; task_id: string; content: string }[];
  skipped: { what: string; why: string }[];
  errors: string[];
}

async function todoistPost(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return retry(
    async () => {
      const resp = await fetch(`${TODOIST_API}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new HttpError(resp.status, `Todoist ${path}: ${resp.status}`);
      const text = await resp.text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    },
    { retries: 2, baseDelayMs: 500 },
  );
}

/**
 * Add the captured tasks to each person's Todoist inbox (labelled, so they
 * are easy to find and undo) and set undated, non-recurring focus picks to
 * today so they show on phones. Never deletes, closes or rewrites a task.
 * Captures already made once — even if since deleted — are never re-added.
 */
export async function applyPlan(
  plan: TaskPlan,
  people: PersonTasks[],
  config: CallsheetConfig,
  settings: TaskCoachSettings,
  ledger: Ledger,
  today: string,
): Promise<TodoistActionResult> {
  const result: TodoistActionResult = { added: [], scheduled: [], skipped: [], errors: [] };
  const accounts = (config.connectors?.todoist?.accounts ?? []) as {
    name: string;
    token_env: string;
  }[];
  const tokenFor = (person: string) => {
    const acct = accounts.find((a) => a.name.toLowerCase() === person.toLowerCase());
    return acct ? (process.env[acct.token_env] ?? '') : '';
  };
  const known = new Set(ledger.captured.map((c) => c.key));

  if (settings.capture) {
    for (const c of plan.capture) {
      const key = captureKey(c.person, c.content);
      const open = people.find((p) => p.person === c.person)?.open ?? [];
      if (known.has(key)) {
        result.skipped.push({ what: c.content, why: 'captured before' });
        continue;
      }
      if (alreadyATask(c.content, open)) {
        result.skipped.push({ what: c.content, why: 'already a task' });
        continue;
      }
      const token = tokenFor(c.person);
      if (!token) {
        result.skipped.push({ what: c.content, why: `no Todoist token for ${c.person}` });
        continue;
      }
      try {
        const created = await todoistPost(token, 'tasks', {
          content: c.content,
          description: `Added by callsheet on ${today} — from: ${c.source}`,
          labels: [settings.captureLabel],
          ...(c.due_date ? { due_date: c.due_date } : {}),
        });
        const taskId = typeof created.id === 'string' ? created.id : undefined;
        result.added.push({ ...c, taskId });
        ledger.captured.push({ key, date: today, person: c.person, content: c.content, taskId });
        known.add(key);
      } catch (e) {
        result.errors.push(`add "${c.content}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (settings.scheduleFocus) {
    for (const f of plan.focus) {
      const task = people.find((p) => p.person === f.person)?.open.find((t) => t.id === f.task_id);
      // Only undated or future-dated, never recurring: setting a date on a
      // recurring task would replace its recurrence, and an overdue task is
      // already on today's list.
      if (!task || task.isRecurring || (task.dueDate && task.dueDate <= today)) continue;
      const token = tokenFor(f.person);
      if (!token) continue;
      try {
        await todoistPost(token, `tasks/${f.task_id}`, { due_date: today });
        result.scheduled.push({ person: f.person, task_id: f.task_id, content: task.content });
      } catch (e) {
        result.errors.push(
          `schedule "${task.content}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return result;
}

/** Remember today's focus picks and decisions, and the day's numbers. */
export function recordDay(
  outputDir: string,
  ledger: Ledger,
  plan: TaskPlan,
  people: PersonTasks[],
  today: string,
  yesterday: YesterdayResult | null,
  added: number,
): Ledger {
  const content = new Map(people.flatMap((p) => p.open.map((t) => [t.id, t.content] as const)));
  const focus: FocusRecord = {
    date: today,
    picks: plan.focus.map((f) => ({
      person: f.person,
      task_id: f.task_id,
      content: content.get(f.task_id) ?? '',
    })),
  };
  mkdirSync(join(outputDir, TASKS_DIR), { recursive: true });
  writeFileSync(focusPath(outputDir, today), JSON.stringify(focus, null, 2));

  const tasks = { ...ledger.tasks };
  for (const f of plan.focus) {
    if (tasks[f.task_id]) {
      tasks[f.task_id] = { ...tasks[f.task_id], focusCount: tasks[f.task_id].focusCount + 1 };
    }
  }
  for (const d of plan.decide) {
    if (tasks[d.task_id]) tasks[d.task_id] = { ...tasks[d.task_id], lastDecided: today };
  }
  const summary: DaySummary = {
    date: today,
    open: people.reduce((n, p) => n + p.open.length, 0),
    overdue: people.reduce((n, p) => n + p.open.filter((t) => (t.daysOverdue ?? 0) > 0).length, 0),
    focusPicked: plan.focus.length,
    focusDone: 0,
    captured: added,
  };
  const days = [...ledger.days.filter((d) => d.date !== today), summary]
    .map((d) =>
      yesterday && d.date === shiftYmd(today, -1) ? { ...d, focusDone: yesterday.done } : d,
    )
    .slice(-60);
  return { ...ledger, tasks, days };
}

/** The last seven days of coach numbers, for the weekly review. */
export function weekStats(ledger: Ledger, today: string): string | null {
  const from = shiftYmd(today, -7);
  const week = ledger.days.filter((d) => d.date >= from && d.date < today);
  if (!week.length) return null;
  const picked = week.reduce((n, d) => n + d.focusPicked, 0);
  const done = week.reduce((n, d) => n + d.focusDone, 0);
  const captured = week.reduce((n, d) => n + d.captured, 0);
  const first = week[0];
  const last = week[week.length - 1];
  return (
    `Task coach, last ${week.length} day(s): ${done} of ${picked} focus picks done; ` +
    `${captured} task(s) captured into Todoist; open tasks ${first.open} → ${last.open}, ` +
    `overdue ${first.overdue} → ${last.overdue}.`
  );
}

// ---------------------------------------------------------------------------
// Rendering the plan onto the page
// ---------------------------------------------------------------------------

const ACTION_LABEL: Record<TaskPlan['decide'][number]['action'], string> = {
  schedule: 'Schedule',
  first_step: 'First step',
  delegate: 'Hand off',
  drop: 'Drop it',
};

/** Insert `section` after the first section whose heading matches one of `after`, else at `fallback`. */
function insertAfter(
  sections: BriefSection[],
  section: BriefSection,
  after: RegExp[],
  fallback: number,
): void {
  for (const re of after) {
    const i = sections.findIndex((s) => re.test(s.heading));
    if (i >= 0) {
      sections.splice(i + 1, 0, section);
      return;
    }
  }
  sections.splice(Math.min(fallback, sections.length), 0, section);
}

/**
 * Put the plan on the page: the focus picks (with yesterday's score) after the
 * Executive Brief, the stuck-task decisions after the Tasks section, and what
 * was added to Todoist and the capture prompts at the end. Task names are
 * taken from Todoist, never from the writer.
 */
export function renderPlan(
  brief: Brief,
  plan: TaskPlan,
  people: PersonTasks[],
  stuck: StuckTask[],
  actions: TodoistActionResult | null,
  yesterday: YesterdayResult | null,
  settings: TaskCoachSettings,
): Brief {
  const sections = brief.sections.filter((s) => !COACH_HEADINGS.includes(s.heading));
  const tasks = new Map(people.flatMap((p) => p.open.map((t) => [t.id, t] as const)));
  const scheduled = new Set(actions?.scheduled.map((s) => s.task_id) ?? []);

  const focusItems: BriefItem[] = [];
  if (yesterday) {
    const parts = Object.entries(yesterday.byPerson).map(([p, r]) => `${p} ${r.done}/${r.picked}`);
    focusItems.push({
      label: `Yesterday: ${yesterday.done} of ${yesterday.picked} focus tasks done`,
      note: parts.join(', '),
    });
  }
  for (const f of plan.focus) {
    const t = tasks.get(f.task_id);
    if (!t) continue;
    const notes = [f.person, f.why, scheduled.has(f.task_id) ? 'set for today in Todoist' : '']
      .filter(Boolean)
      .join(' · ');
    focusItems.push({
      label: t.content,
      ...(f.when ? { time: f.when } : {}),
      note: notes,
      checkbox: true,
      ...(t.priority === 'p1' || (t.daysOverdue ?? 0) > 0 ? { highlight: true } : {}),
    });
  }
  if (focusItems.some((i) => i.checkbox)) {
    insertAfter(sections, { heading: FOCUS_HEADING, items: focusItems }, [/executive brief/i], 0);
  }

  const reasons = new Map(stuck.map((s) => [s.task_id, s] as const));
  const decideItems: BriefItem[] = plan.decide.flatMap((d) => {
    const s = reasons.get(d.task_id);
    if (!s) return [];
    return [
      {
        label: s.content,
        note: `${s.person} · ${s.reason} → ${ACTION_LABEL[d.action]}: ${d.detail}`,
        checkbox: true,
      },
    ];
  });
  if (decideItems.length) {
    insertAfter(
      sections,
      { heading: DECIDE_HEADING, items: decideItems },
      [/^tasks$/i, /focus/i],
      2,
    );
  }

  const addedItems: BriefItem[] = [
    ...(actions?.added.map((a) => ({
      label: a.content,
      note: `${a.person} · ${a.due_date ? `due ${a.due_date}` : 'inbox'} · from ${a.source} · label "${settings.captureLabel}"`,
      checkbox: true,
    })) ?? []),
  ];
  if (addedItems.length) sections.push({ heading: ADDED_HEADING, items: addedItems });

  if (plan.capture_prompts.length) {
    sections.push({
      heading: CAPTURE_HEADING,
      body: [
        ...plan.capture_prompts.map((p) => `→ ${p}`),
        'New tasks go straight into Todoist.',
      ].join('\n'),
    });
  }

  return { ...brief, sections };
}
