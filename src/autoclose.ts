/**
 * Auto-close: tick off Todoist tasks that another source proves are done.
 *
 * The first version handed the model `dataPayload.slice(0, 8000)` — the first
 * eight thousand characters of a 50-150k character payload, which is the
 * calendar. Todoist data stopped fitting inside that window at the end of July
 * and email or transactions never fitted at all, so in 150 runs the only
 * correct answer was "nothing to close", and it never closed anything.
 *
 * This version builds the input from what the question needs — the open tasks,
 * and the emails and transactions that could prove one of them done — asks for
 * structured output, and then checks every recommendation in code: the task
 * must exist, it must not be recurring, and the quoted evidence must actually
 * appear in the email or transaction it cites. A recommendation that fails any
 * check is dropped, not trusted.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutoCloseRecommendation, CallsheetConfig } from './types.js';
import { logUsage } from './usage.js';
import { todayYmd, shiftYmd } from './dates.js';
import { createMessage, extractResponseText, normaliseForQuote } from './llm.js';

/** At most this many tasks are closed in one run, however sure the model is. */
const MAX_CLOSURES_PER_RUN = 3;

/** A quote shorter than this proves nothing ("paid", "done"). */
const MIN_QUOTE_CHARS = 8;

export interface OpenTask {
  id: string;
  person: string;
  content: string;
  project?: string;
  due?: string;
  recurring: boolean;
}

export interface Evidence {
  id: string;
  kind: 'email' | 'transaction';
  person?: string;
  text: string;
}

export interface AutoCloseInput {
  tasks: OpenTask[];
  evidence: Evidence[];
}

interface Section {
  source?: string;
  data?: Record<string, unknown>;
}

interface RawTask {
  id?: unknown;
  content?: unknown;
  project?: unknown;
  dueDate?: unknown;
  isRecurring?: unknown;
}

/**
 * Pull the open tasks and the candidate evidence out of the run's payload.
 * Returns empty lists, never throws, when a source is missing or malformed.
 */
export function collectAutoCloseInput(dataPayload: string): AutoCloseInput {
  let sections: Section[];
  try {
    const parsed: unknown = JSON.parse(dataPayload);
    sections = Array.isArray(parsed) ? (parsed as Section[]) : [];
  } catch {
    sections = [];
  }
  const find = (source: string) => sections.find((s) => s?.source === source)?.data;

  const tasks: OpenTask[] = [];
  const seen = new Set<string>();
  const todoist = find('todoist');
  for (const acct of (todoist?.accounts as Record<string, unknown>[] | undefined) ?? []) {
    const person = typeof acct.person === 'string' ? acct.person : '';
    for (const bucket of ['today', 'inbox', 'upcoming', 'backlog']) {
      for (const t of (acct[bucket] as RawTask[] | undefined) ?? []) {
        const id = typeof t.id === 'string' ? t.id : '';
        // A task in a shared project is listed under each account that can
        // see it; one entry is enough.
        if (!id || seen.has(id)) continue;
        seen.add(id);
        tasks.push({
          id,
          person,
          content: typeof t.content === 'string' ? t.content : '',
          project: typeof t.project === 'string' && t.project ? t.project : undefined,
          due: typeof t.dueDate === 'string' && t.dueDate ? t.dueDate : undefined,
          recurring: t.isRecurring === true,
        });
      }
    }
  }

  const evidence: Evidence[] = [];
  const gmail = find('gmail');
  for (const acct of (gmail?.accounts as Record<string, unknown>[] | undefined) ?? []) {
    const person = typeof acct.person === 'string' ? acct.person : undefined;
    for (const e of (acct.emails as Record<string, unknown>[] | undefined) ?? []) {
      const parts = [e.from, e.subject, e.snippet].filter((p) => typeof p === 'string');
      if (!parts.length) continue;
      evidence.push({
        id: `e${evidence.length + 1}`,
        kind: 'email',
        person,
        text: `${parts.join(' | ')}${typeof e.date === 'string' ? ` (${e.date})` : ''}`,
      });
    }
  }
  const budget = find('actual_budget');
  for (const t of (budget?.recentTransactions as Record<string, unknown>[] | undefined) ?? []) {
    const parts = [t.date, t.payee, t.amount, t.category, t.notes]
      .filter((p) => typeof p === 'string' || typeof p === 'number')
      .map(String);
    if (!parts.length) continue;
    evidence.push({ id: `t${evidence.length + 1}`, kind: 'transaction', text: parts.join(' | ') });
  }

  return { tasks, evidence };
}

/** The shape the model must answer in. */
const CLOSURE_SCHEMA = {
  type: 'object',
  properties: {
    closures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          evidence_id: { type: 'string' },
          evidence_quote: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['task_id', 'evidence_id', 'evidence_quote', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['closures'],
  additionalProperties: false,
} as const;

interface RawClosure {
  task_id?: unknown;
  evidence_id?: unknown;
  evidence_quote?: unknown;
  reason?: unknown;
}

/**
 * Keep only the recommendations that hold up: the task exists and is not
 * recurring (closing one would silently skip an occurrence), the evidence item
 * exists, and the quote is long enough to mean something and really appears in
 * that item. Capped at MAX_CLOSURES_PER_RUN.
 */
export function verifyClosures(
  raw: RawClosure[],
  input: AutoCloseInput,
): AutoCloseRecommendation[] {
  const out: AutoCloseRecommendation[] = [];
  const used = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_CLOSURES_PER_RUN) break;
    const task = input.tasks.find((t) => t.id === r.task_id);
    const ev = input.evidence.find((e) => e.id === r.evidence_id);
    const quote = typeof r.evidence_quote === 'string' ? normaliseForQuote(r.evidence_quote) : '';
    if (!task || task.recurring || used.has(task.id) || !ev) continue;
    if (quote.length < MIN_QUOTE_CHARS || !normaliseForQuote(ev.text).includes(quote)) continue;
    used.add(task.id);
    out.push({
      task_id: task.id,
      task_content: task.content,
      person: task.person,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : 'resolved',
      evidence: String(r.evidence_quote).slice(0, 200),
    });
  }
  return out;
}

/**
 * Ask the model which open tasks the evidence proves done, then verify.
 * Never throws; problems are reported through `warn` and yield no closures.
 */
export async function detectResolvableTasks(
  client: Anthropic,
  model: string,
  dataPayload: string,
  outputDir: string,
  warn: (message: string) => void = () => {},
  maxTokens = 8_000,
): Promise<AutoCloseRecommendation[]> {
  const input = collectAutoCloseInput(dataPayload);
  if (!input.tasks.length || !input.evidence.length) return [];

  try {
    const response = await createMessage(client, {
      model,
      max_tokens: maxTokens,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: CLOSURE_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      system:
        'You find Todoist tasks that are already DONE, proven by an email or a transaction. ' +
        'Close a task only when an item shows that the exact action in the task was completed: ' +
        'a payment or renewal receipt for the bill the task names, a confirmation that the booking, ' +
        'cancellation, submission or reply the task describes happened, or a delivery for the order ' +
        'it tracks. A reminder, an invoice, a request or a reply that is still pending is NOT proof. ' +
        'For each closure give the task id, the evidence id, and a short verbatim quote (copied ' +
        'exactly, 8-120 characters) from that evidence item that proves it. When in doubt, leave the ' +
        'task open. An empty list is the normal answer.',
      messages: [
        {
          role: 'user',
          content:
            `Open tasks:\n${JSON.stringify(input.tasks)}\n\n` +
            `Evidence (emails and transactions):\n${JSON.stringify(input.evidence)}`,
        },
      ],
    });

    logUsage(
      outputDir,
      model,
      'auto_close',
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    const parsed = JSON.parse(extractResponseText(response)) as { closures?: RawClosure[] };
    const proposed = Array.isArray(parsed.closures) ? parsed.closures : [];
    const verified = verifyClosures(proposed, input);
    if (proposed.length > verified.length) {
      console.log(
        `  Auto-close: dropped ${proposed.length - verified.length} unverified recommendation(s).`,
      );
    }
    return verified;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Auto-close detection failed: ${msg}`);
    warn(msg);
    return [];
  }
}

/** Close the verified tasks through each person's own Todoist token. */
export async function closeTodoistTasks(
  recommendations: AutoCloseRecommendation[],
  config: CallsheetConfig,
): Promise<AutoCloseRecommendation[]> {
  const closed: AutoCloseRecommendation[] = [];
  const accounts = (config.connectors?.todoist?.accounts ?? []) as {
    name: string;
    token_env: string;
  }[];

  for (const rec of recommendations) {
    const acct = accounts.find((a) => a.name.toLowerCase() === rec.person.toLowerCase());
    const token = acct ? (process.env[acct.token_env] ?? '') : '';
    if (!token) {
      console.log(`  Auto-close: skipping "${rec.task_content}" — no token for ${rec.person}`);
      continue;
    }

    try {
      const resp = await fetch(`https://api.todoist.com/api/v1/tasks/${rec.task_id}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        closed.push(rec);
        console.log(`  Auto-closed: "${rec.task_content}" (${rec.person}) — ${rec.reason}`);
      } else {
        console.log(`  Auto-close failed (${resp.status}): "${rec.task_content}"`);
      }
    } catch (e) {
      console.log(`  Auto-close error: "${rec.task_content}" — ${String(e)}`);
    }
  }

  return closed;
}

/** Record today's closures so tomorrow's brief can report them. */
export function saveAutoCloseLog(closed: AutoCloseRecommendation[], outputDir: string): void {
  if (!closed.length) return;
  const logDir = join(outputDir, 'auto_close');
  mkdirSync(logDir, { recursive: true });
  const today = todayYmd();
  writeFileSync(
    join(logDir, `closed_${today}.json`),
    JSON.stringify({ date: today, closed }, null, 2),
  );
}

function loadRecentAutoCloses(outputDir: string): AutoCloseRecommendation[] {
  const logDir = join(outputDir, 'auto_close');
  if (!existsSync(logDir)) return [];
  const logPath = join(logDir, `closed_${shiftYmd(todayYmd(), -1)}.json`);
  try {
    if (existsSync(logPath)) {
      const data = JSON.parse(readFileSync(logPath, 'utf-8')) as {
        closed?: AutoCloseRecommendation[];
      };
      return data.closed ?? [];
    }
  } catch {
    /* ignore */
  }
  return [];
}

/** Prompt section telling the writer what was closed yesterday, so it can say so. */
export function buildAutoCloseContext(outputDir: string): string {
  const recent = loadRecentAutoCloses(outputDir);
  if (!recent.length) return '';

  let ctx = '\n\n## Auto-closed tasks\n\n';
  ctx +=
    'The following tasks were automatically closed yesterday because data confirmed they were resolved. ';
  ctx +=
    '**You MUST mention these in the Executive Brief** so the user knows what was auto-closed and can re-open if needed:\n\n';
  for (const r of recent) {
    ctx += `- ✅ "${r.task_content}" (${r.person}) — ${r.reason}\n`;
  }
  return ctx;
}
