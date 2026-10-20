import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import * as yaml from 'js-yaml';
import type {
  CallsheetConfig,
  ConnectorResult,
  Brief,
  BriefItem,
  HouseholdMember,
} from './types.js';
import { loadConnectors } from './connectors/index.js';
import { recordBriefPhrase, languageLabelPrefix } from './connectors/language.js';
import { renderPdf } from './render.js';
import { logUsage } from './usage.js';
import { todayYmd, shiftYmd, formatLongDate } from './dates.js';
import { deriveStationsFromEvents, type AirportAlias } from './airports.js';
import { prepareContext } from './context.js';
import {
  activeFacts,
  buildLivingContext,
  changeItems,
  livingSettings,
  loadLiving,
  openConfigFlags,
  reviewLivingContext,
  saveLiving,
  type LivingChanges,
} from './living.js';
import { printAndConfirm, type PrintOptions, type PrintResult } from './print.js';
import { createMessage, extractResponseText, stripJsonCodeFences } from './llm.js';
import {
  applyCorrections,
  dedupeExecutiveBrief,
  factCheckBrief,
  verifyFactIssues,
  type FactIssue,
} from './review.js';
import {
  COACH_HEADINGS,
  PLAN_SCHEMA_PROPERTIES,
  applyPlan,
  buildCoachContext,
  coachSettings,
  extractPlan,
  findStuck,
  loadLedger,
  observeTasks,
  readFreeTime,
  readTodoist,
  recordDay,
  yesterdayResults,
  renderPlan,
  saveLedger,
  weekStats,
  type TaskPlan,
  type TodoistActionResult,
} from './tasks.js';
import {
  buildAutoCloseContext,
  closeTodoistTasks,
  detectResolvableTasks,
  saveAutoCloseLog,
} from './autoclose.js';
import {
  recordRun,
  isScheduledTrigger,
  readStatus,
  updateConnectorStreaks,
  type RunTrigger,
} from './status.js';

// Moved to their own modules; re-exported so existing imports keep working.
export { printPdf } from './print.js';
export { extractResponseText, stripJsonCodeFences, supportsServerFallback } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Model that writes the brief when config doesn't name one. */
export const DEFAULT_MODEL = 'claude-fable-5-1';

/**
 * Model for the housekeeping passes: living context, memory, fact check and
 * auto-close. Together they read more than twice the brief's input every day,
 * so they stay a tier below the writer; on Fable 5.1 they would cost several
 * times what the brief does.
 */
export const CRITIQUE_MODEL = 'claude-opus-5-5';

/**
 * Output budget for the housekeeping passes. Current small models think before
 * answering and that reasoning is drawn from the same budget, so the old
 * 512-2048 token caps would cut the JSON off mid-array — the exact failure that
 * silently lost memory on most runs for four months in 2026. Output is a small
 * share of what the passes cost, and they run at low effort.
 */
const HOUSEKEEPING_MAX_TOKENS = 8_000;

// ---------------------------------------------------------------------------
// RuntimeErrors — global collector for any error conditions during a run.
// Connectors, process handlers, and pipeline code all push here.
// generateBrief drains these into the Claude prompt so they appear in the brief.
// ---------------------------------------------------------------------------

export interface RuntimeError {
  source: string;
  error: string;
  severity: 'warning' | 'error';
}

class RuntimeErrorCollector {
  private errors: RuntimeError[] = [];

  add(source: string, error: string, severity: 'warning' | 'error' = 'error'): void {
    this.errors.push({ source, error, severity });
  }

  /** Drain all collected errors (empties the list). */
  drain(): RuntimeError[] {
    return this.errors.splice(0);
  }

  get length(): number {
    return this.errors.length;
  }
}

export const runtimeErrors = new RuntimeErrorCollector();

/**
 * Best-effort string conversion for thrown values that aren't Errors.
 * Some libraries (looking at you, @actual-app/api) throw bare objects that
 * lose all information when coerced via String(). JSON-serialise first so
 * the connector issue line in the brief shows something debuggable.
 */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return '[unserialisable error object]';
    }
  }
  return String(err);
}

export function loadConfig(configPath: string): CallsheetConfig {
  let config: CallsheetConfig;
  try {
    config = yaml.load(readFileSync(configPath, 'utf-8')) as CallsheetConfig;
  } catch {
    throw new Error(
      `Config not found: ${configPath}. Copy config.example.yaml to config.yaml and edit it.`,
    );
  }

  // Adopt the household's zone process-wide so every later "what day is it"
  // agrees — output filenames, the brief's own date, memory keys and the
  // scheduler. Previously filenames followed UTC while the visible dates
  // followed the configured zone, which only lines up for part of the day.
  if (config?.timezone) {
    process.env.TZ = config.timezone;
  }

  return config;
}

export interface ConnectorIssue {
  connector: string;
  error: string;
}

/** Default per-connector deadline. Connectors that hang past this are abandoned. */
const DEFAULT_CONNECTOR_TIMEOUT_MS = 60_000;

/** Lookback window the Week in Review needs from the calendar connector. */
const WEEKLY_REVIEW_LOOKBACK_DAYS = 7;

/**
 * On Week in Review days, return a shallow-cloned config with the calendar
 * connector's `lookback_days` bumped to at least 7 so the retrospective has
 * past events to reference. On non-review days, returns the input as-is.
 *
 * Never mutates the caller's config object.
 */
export function withWeeklyReviewOverrides(config: CallsheetConfig): CallsheetConfig {
  if (!isWeeklyReviewDay(config)) return config;

  const connectors = config.connectors ?? {};
  const calendar = connectors.google_calendar;
  if (!calendar?.enabled) return config;

  const currentLookback = (calendar.lookback_days as number | undefined) ?? 0;
  if (currentLookback >= WEEKLY_REVIEW_LOOKBACK_DAYS) return config;

  return {
    ...config,
    connectors: {
      ...connectors,
      google_calendar: {
        ...calendar,
        lookback_days: WEEKLY_REVIEW_LOOKBACK_DAYS,
      },
    },
  };
}

/** Wrap a promise so it rejects with a clear timeout error after `ms` milliseconds. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} exceeded ${ms / 1000}s deadline`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Fetch one connector under a deadline, logging the outcome. */
function runConnector(
  conn: { name: string; fetch: () => Promise<ConnectorResult> },
  timeoutMs: number,
): Promise<ConnectorResult> {
  return withDeadline(conn.fetch(), timeoutMs, conn.name).then(
    (result) => {
      console.log(`  ✓ ${conn.name}`);
      return result;
    },
    (err) => {
      // Re-throw so allSettled records it as rejected with the right name attached.
      // Bare objects (@actual-app/api throws `{reason: 'x'}`) would stringify
      // to "[object Object]" — JSON-serialise them so the brief shows why.
      const e = err instanceof Error ? err : new Error(formatUnknownError(err));
      (e as Error & { __connector?: string }).__connector = conn.name;
      throw e;
    },
  );
}

/** True when the calendar should be consulted for which airports to fetch weather for. */
export function usesCalendarDerivedStations(config: CallsheetConfig): boolean {
  const connectors = config.connectors ?? {};
  const aviation = connectors.aviation_weather;
  return Boolean(
    aviation?.enabled && connectors.google_calendar?.enabled && aviation.derive_stations !== false,
  );
}

/**
 * Merge the airports named in calendar events into the aviation config.
 *
 * Configured stations are kept — they are the household's home fields — and
 * anything the calendar mentions is added on top, so a lesson booked at an
 * unfamiliar field still gets a forecast.
 */
export function withDerivedStations(
  config: CallsheetConfig,
  calendarResult: ConnectorResult | null,
): CallsheetConfig {
  const connectors = config.connectors ?? {};
  const aviation = connectors.aviation_weather;
  if (!aviation || !calendarResult) return config;

  const data = calendarResult.data as {
    today?: { summary?: string; location?: string }[];
    upcoming?: { summary?: string; location?: string }[];
  };
  const events = [...(data.today ?? []), ...(data.upcoming ?? [])];

  const derived = deriveStationsFromEvents(
    events,
    (aviation.airport_aliases as AirportAlias[] | undefined) ?? [],
    aviation.activity_pattern as string | undefined,
  );
  if (derived.length === 0) return config;

  const configured = (aviation.stations as string[] | undefined) ?? [];
  const merged = [...new Set([...configured, ...derived])];
  if (merged.length === configured.length) return config;

  console.log(`  Airports from calendar: ${derived.join(', ')}`);
  return {
    ...config,
    connectors: {
      ...connectors,
      aviation_weather: { ...aviation, stations: merged, derived_stations: derived },
    },
  };
}

export async function fetchAll(
  config: CallsheetConfig,
): Promise<{ results: ConnectorResult[]; issues: ConnectorIssue[] }> {
  // On Week in Review days, ensure the calendar connector has at least a
  // 7-day lookback so the retrospective has past events to reference. Done as
  // a per-run override on a shallow clone — never mutate the caller's config.
  const withReview = withWeeklyReviewOverrides(config);
  const results: ConnectorResult[] = [];
  const issues: ConnectorIssue[] = [];
  const timeoutMs = config.connector_timeout_ms ?? DEFAULT_CONNECTOR_TIMEOUT_MS;

  // When aviation weather is on, the calendar goes first so the airports it
  // names can be folded into the weather request. Left to a static list, the
  // stations drift out of date and the brief reports conditions for fields
  // nobody flies from any more.
  let calendarResult: ConnectorResult | null = null;
  let effectiveConfig = withReview;
  if (usesCalendarDerivedStations(withReview)) {
    const { connectors: pre } = loadConnectors(withReview as Record<string, unknown>);
    const calendar = pre.find((c) => c.name === 'google_calendar');
    if (calendar) {
      try {
        calendarResult = await runConnector(calendar, timeoutMs);
        results.push(calendarResult);
      } catch (err) {
        issues.push({ connector: 'google_calendar', error: formatUnknownError(err) });
      }
      effectiveConfig = withDerivedStations(withReview, calendarResult);
    }
  }

  const { connectors: loaded, initErrors } = loadConnectors(
    effectiveConfig as Record<string, unknown>,
  );
  const connectors = calendarResult ? loaded.filter((c) => c.name !== 'google_calendar') : loaded;

  // Surface init errors as connector issues
  for (const err of initErrors) {
    issues.push({ connector: err.connector, error: err.error });
  }

  // Fire the remaining connector fetches in parallel. Each is wrapped in a
  // deadline so a single hanging connector cannot stall the brief.
  // Promise.allSettled ensures one connector's failure never short-circuits
  // the others.
  console.log(`  Fetching ${connectors.length} connector(s) in parallel...`);
  const settled = await Promise.allSettled(connectors.map((conn) => runConnector(conn, timeoutMs)));

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const { name } = connectors[i];
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      const error =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : formatUnknownError(outcome.reason);
      issues.push({ connector: name, error });
      console.log(`  \u2717 ${name}: ${error}`);
    }
  }

  return { results, issues };
}

export function buildDataPayload(results: ConnectorResult[]): string {
  const sections = results.map((r) => ({
    source: r.source,
    description: r.description,
    priority: r.priorityHint,
    data: r.data,
  }));
  return JSON.stringify(sections, null, 2);
}

// ---------------------------------------------------------------------------
// Memory system — persists insights between daily briefs
// ---------------------------------------------------------------------------

const MEMORY_DIR = 'memory';

/** Memory older than this many days never reaches the writer, whatever it says. */
const MEMORY_WINDOW_DAYS = 7;

/** Memory files are kept this long for reading later, then deleted. */
const MEMORY_RETENTION_DAYS = 60;

/** How long a remembered fact stays relevant when the model gives no date. */
const DEFAULT_MEMORY_TTL_DAYS = 3;

/**
 * Sources memory is never extracted from. The language connector's data
 * describes a theme, not a phrase, and the extractor invented a phrase from it
 * every day — in October every memory file held one that was never printed.
 * Market, weather and the like are recomputed fresh each morning.
 */
const MEMORY_EXCLUDED_SOURCES = new Set([
  'language',
  'market',
  'weather',
  'aviation_weather',
  'garbage_recycling',
  'sun_moon',
]);

/** One remembered fact and the last day it matters. */
export interface MemoryInsight {
  fact: string;
  /** YYYY-MM-DD; the fact is dropped after this day. */
  until: string;
}

interface DailyMemory {
  date: string;
  /** Plain strings are from before facts carried an expiry. */
  insights: (string | MemoryInsight)[];
}

function getMemoryDir(outputDir: string): string {
  return join(outputDir, MEMORY_DIR);
}

/**
 * Memories from the last MEMORY_WINDOW_DAYS calendar days, newest last, with
 * expired facts removed.
 *
 * This used to load the seven newest files, however old: after a vacation or
 * a run of failed saves, notes from 57 days earlier were presented as recent.
 * Today's own file is skipped so a re-run does not read back its own notes.
 */
export function loadRecentMemories(outputDir: string, today: string = todayYmd()): DailyMemory[] {
  const memDir = getMemoryDir(outputDir);
  if (!existsSync(memDir)) return [];
  const oldest = shiftYmd(today, -MEMORY_WINDOW_DAYS);

  return readdirSync(memDir)
    .map((f) => /^memory_(\d{4}-\d{2}-\d{2})\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null && m[1] >= oldest && m[1] < today)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map((m) => {
      try {
        const mem = JSON.parse(readFileSync(join(memDir, m[0]), 'utf-8')) as DailyMemory;
        const live = (mem.insights ?? []).filter(
          (i) => typeof i === 'string' || (typeof i?.fact === 'string' && i.until >= today),
        );
        return { date: m[1], insights: live };
      } catch {
        return { date: m[1], insights: [] };
      }
    })
    .filter((mem) => mem.insights.length > 0);
}

function buildMemoryContext(memories: DailyMemory[]): string {
  if (!memories.length) return '';

  let ctx = '\n\n## Memory from previous briefs\n\n';
  ctx += 'Notes kept from the last few mornings about things still in motion — deliveries, ';
  ctx += 'deadlines, appointments mentioned only in email, replies being waited on. Use them to ';
  ctx += 'follow an item after its email has aged out of the data, and to avoid repeating ';
  ctx += 'yesterday without news.\n\n';
  ctx += "**Memory is not evidence.** Today's live data always wins:\n";
  ctx += '- A remembered task that is no longer in Todoist was finished — do not surface it.\n';
  ctx +=
    '- Anything in `recently_completed`, or settled by a newer email or transaction, is done.\n';
  ctx +=
    "- Never copy a number, count, identifier or date from memory into the brief unless today's data confirms it.\n\n";

  for (const mem of memories) {
    ctx += `### ${mem.date}\n`;
    for (const insight of mem.insights) {
      ctx +=
        typeof insight === 'string'
          ? `- ${insight}\n`
          : `- ${insight.fact} (relevant until ${insight.until})\n`;
    }
    ctx += '\n';
  }

  return ctx;
}

/** The payload with the sources memory must not draw on removed. */
function memoryPayload(dataPayload: string): string {
  try {
    const parsed: unknown = JSON.parse(dataPayload);
    if (!Array.isArray(parsed)) return dataPayload;
    return JSON.stringify(
      (parsed as { source?: string }[]).filter(
        (s) => !MEMORY_EXCLUDED_SOURCES.has(s?.source ?? ''),
      ),
    );
  } catch {
    return dataPayload;
  }
}

const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fact: { type: 'string' },
          until: { type: 'string', format: 'date' },
        },
        required: ['fact', 'until'],
        additionalProperties: false,
      },
    },
  },
  required: ['insights'],
  additionalProperties: false,
} as const;

/** Keep well-formed facts, give a missing or past expiry a short default, cap the count. */
export function normaliseInsights(raw: unknown, today: string = todayYmd()): MemoryInsight[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (Array.isArray((raw as { insights?: unknown } | null)?.insights)) {
    list = (raw as { insights: unknown[] }).insights;
  }
  const fallback = shiftYmd(today, DEFAULT_MEMORY_TTL_DAYS);
  const out: MemoryInsight[] = [];
  for (const item of list) {
    const fact = typeof item === 'string' ? item : (item as { fact?: unknown })?.fact;
    if (typeof fact !== 'string' || !fact.trim()) continue;
    const until = (item as { until?: unknown })?.until;
    const valid = typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until) && until >= today;
    out.push({ fact: fact.trim().slice(0, 300), until: valid ? until : fallback });
  }
  return out.slice(0, 8);
}

async function generateMemoryInsights(
  client: Anthropic,
  model: string,
  dataPayload: string,
  outputDir: string,
): Promise<MemoryInsight[]> {
  try {
    const today = todayYmd();
    const response = await createMessage(client, {
      model,
      // 512 truncated the JSON array mid-string on most runs, so the parse
      // failed and a day's memory was silently lost.
      max_tokens: HOUSEKEEPING_MAX_TOKENS,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: MEMORY_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      system:
        `Today is ${today}. You keep a short list of open loops for tomorrow's household brief: ` +
        "things still in motion that tomorrow's data may no longer show, because emails age out " +
        'of the window after two days. Good examples: a delivery in transit and its expected date; ' +
        'a bill, form or RSVP with its due date; an appointment or deadline mentioned only in an ' +
        'email; a reply the household is waiting on. Return 0-8 facts. Each must be traceable to ' +
        'a specific email, task, event or transaction in the data, state its date when one is ' +
        'given, and carry `until` — the last day it matters (the due date, the delivery date, the ' +
        'appointment). Skip anything already on the calendar or in Todoist, anything routine, and ' +
        'any count or total. Never invent a fact the data does not state.',
      messages: [
        {
          role: 'user',
          content:
            "Here is today's raw connector data. Extract only facts that are " +
            'directly evidenced in this data:\n\n' +
            memoryPayload(dataPayload),
        },
      ],
    });

    logUsage(outputDir, model, 'memory', response.usage.input_tokens, response.usage.output_tokens);

    const text = stripJsonCodeFences(extractResponseText(response));
    return normaliseInsights(JSON.parse(text), today);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Memory generation failed: ${msg}`);
    runtimeErrors.add('memory_generation', msg, 'warning');
    return [];
  }
}

export async function saveMemory(
  client: Anthropic,
  model: string,
  dataPayload: string,
  outputDir: string,
): Promise<void> {
  const memDir = getMemoryDir(outputDir);
  mkdirSync(memDir, { recursive: true });

  const today = todayYmd();
  const insights = await generateMemoryInsights(client, model, dataPayload, outputDir);

  if (insights.length) {
    const memory: DailyMemory = { date: today, insights };
    writeFileSync(join(memDir, `memory_${today}.json`), JSON.stringify(memory, null, 2));
    console.log(`  Saved ${insights.length} memory insights for tomorrow.`);
  }

  // Prune by age, not by count: old files are harmless now that loading is
  // date-bounded, and a few weeks of them make it possible to audit what the
  // brief was told.
  if (existsSync(memDir)) {
    const cutoff = shiftYmd(today, -MEMORY_RETENTION_DAYS);
    for (const f of readdirSync(memDir)) {
      const m = /^memory_(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m || m[1] >= cutoff) continue;
      try {
        unlinkSync(join(memDir, f));
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Feedback — notes the household writes about how they want the brief
// ---------------------------------------------------------------------------

const REVIEW_DIR = 'feedback';

/**
 * The household's own notes on how to improve the brief, from `feedback_notes`
 * in config and/or a `feedback.md` beside the process.
 *
 * Self-critique findings used to be appended here too, as a "RECURRING
 * quality problems" banner and a list of recent examples. Across six months
 * the banner flagged duplication on almost every prompt and the duplication
 * rate never moved, while false findings in the examples taught the writer
 * the wrong lessons. Review results now go to a log for people to read; only
 * people's notes go to the writer.
 */
export function buildFeedbackContext(config: CallsheetConfig = {}): string {
  const notes: string[] = [];
  if (typeof config.feedback_notes === 'string' && config.feedback_notes.trim()) {
    notes.push(config.feedback_notes.trim());
  }
  const feedbackPath = join(process.cwd(), 'feedback.md');
  if (existsSync(feedbackPath)) {
    const raw = readFileSync(feedbackPath, 'utf-8').trim();
    if (raw) notes.push(raw);
  }
  if (!notes.length) return '';

  return (
    '\n\n## User feedback\n\n' +
    'The user has left these notes about how to improve the brief. Follow them:\n\n' +
    notes.join('\n\n') +
    '\n'
  );
}

/** What the review did to today's brief, kept for people (and audits), not for the writer. */
interface ReviewLog {
  date: string;
  removedDuplicates: string[];
  factIssues: FactIssue[];
  corrected: FactIssue[];
}

function saveReviewLog(outputDir: string, log: ReviewLog): void {
  try {
    const dir = join(outputDir, REVIEW_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `review_${log.date}.json`), JSON.stringify(log, null, 2));
  } catch {
    /* a review log is for reading later, never worth failing a run over */
  }
}

/** Language-phrase label prefixes, which the review must never edit or remove. */
function protectedLabelPrefixes(config: CallsheetConfig): string[] {
  const prefix = languageLabelPrefix(config);
  return prefix ? [`${prefix}:`] : [];
}

// ---------------------------------------------------------------------------
// Failure notification
// ---------------------------------------------------------------------------

/**
 * Post a short failure line to a webhook. Optional and generic on purpose — it
 * is a URL in config, not a vendor.
 *
 * Motivation: between 2026-06-25 and 07-10 every brief was a GENERATION FAILED
 * page because the Anthropic account had no credit. Sixteen mornings, printed,
 * with nothing telling anyone. A brief that cannot be written is exactly the
 * case where the machine has to speak up.
 */
export async function notifyFailure(config: CallsheetConfig, error: unknown): Promise<void> {
  const { status } = error as { status?: number };
  const raw = error instanceof Error ? error.message : String(error);
  let detail = raw.replace(/\s+/g, ' ').slice(0, 80);
  if (/credit balance is too low/i.test(raw)) {
    detail = 'Anthropic credit exhausted';
  } else if (/api[_ ]?key|authentication|unauthorized/i.test(raw)) {
    detail = 'Anthropic auth rejected';
  }

  await notify(config, `CRIT Callsheet brief failed${status ? ` (${status})` : ''}: ${detail}`);
}

/**
 * Post one alert line to the configured webhook, if there is one.
 *
 * Shared by every failure the household needs to hear about — a brief that
 * could not be written, and one that was written but never printed. The second
 * went unreported for over two weeks in 2026 because only the first had a path
 * to this function.
 */
export async function notify(config: CallsheetConfig, text: string): Promise<void> {
  const url = config.notify_webhook;
  if (!url) return;

  // Plain ASCII, one short line: SMS gateways drop to a 70-character segment the
  // moment a message leaves GSM-7, and a truncated alert is a wasted one.
  const message = text.replace(/[^\x20-\x7E]/g, '').slice(0, 155);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Callsheet', message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`  Failure webhook returned ${res.status}`);
  } catch (e) {
    // Never let the alarm take down the thing it was watching.
    console.error(`  Failure webhook error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Yesterday's brief — for diff context
// ---------------------------------------------------------------------------

function loadPreviousBrief(outputDir: string): { brief: Brief; label: string } | null {
  // Always diff against yesterday — reruns today should act like a fresh first run.
  // Prefer the copy the scheduled run printed: a later preview replaces
  // callsheet_DATE.json, but the printed page is the one the household read.
  const dateStr = shiftYmd(todayYmd(), -1);
  for (const name of [`callsheet_${dateStr}.printed.json`, `callsheet_${dateStr}.json`]) {
    const briefPath = join(outputDir, name);
    try {
      if (existsSync(briefPath)) {
        return {
          brief: JSON.parse(readFileSync(briefPath, 'utf-8')) as Brief,
          label: 'yesterday',
        };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function extractBriefSummary(brief: Brief): Record<string, string[]> {
  const summary: Record<string, string[]> = {};
  for (const section of brief.sections) {
    const items: string[] = [];
    if (section.items) {
      for (const item of section.items) {
        let line = item.label;
        if (item.note) line += ` (${item.note})`;
        if (item.urgent) line = `[URGENT] ${line}`;
        items.push(line);
      }
    }
    if (section.body) {
      items.push(section.body.slice(0, 200));
    }
    if (items.length) summary[section.heading] = items;
  }
  return summary;
}

function buildDiffContext(prev: { brief: Brief; label: string }): string {
  // Send a structured summary instead of full JSON to save tokens
  const summary = extractBriefSummary(prev.brief);
  let ctx = '\n\n<previous_brief>\n';
  ctx += `Summary of ${prev.label}'s brief. Use it to:\n`;
  ctx += "- Highlight what's NEW or CHANGED\n";
  ctx += '- Follow up on items still relevant\n';
  ctx += '- Avoid repeating identical insights\n';
  ctx += '- Note resolved items (tasks done, events passed)\n';
  ctx += 'This is a summary of what was WRITTEN yesterday, not data. Never copy a number, ';
  ctx += "count, identifier or date out of it — take those from today's payload.\n\n";
  for (const [heading, items] of Object.entries(summary)) {
    ctx += `${heading}:\n`;
    for (const item of items) {
      ctx += `  - ${item}\n`;
    }
  }
  ctx += '</previous_brief>\n';
  return ctx;
}

// ---------------------------------------------------------------------------

function buildConnectorIssuesContext(
  issues: ConnectorIssue[],
  errors: RuntimeError[] = [],
): string {
  if (!issues.length && !errors.length) return '';

  let ctx = '\n\n## Issues during this run\n\n';
  ctx +=
    'The following problems occurred. Name the affected sources once, in a single short line ' +
    'at the end of the Executive Brief, so the household knows what may be missing — and draw ' +
    'no conclusions from those sources. Internal warnings (memory, review, auto-close, task ' +
    'coach) are for the maintainers, not the household: leave them off the page.\n\n';

  for (const issue of issues) {
    ctx += `- **${issue.connector}** (connector): ${issue.error}\n`;
  }
  for (const err of errors) {
    ctx += `- **${err.source}** (${err.severity}): ${err.error}\n`;
  }

  return ctx;
}

/**
 * Resolve a `weekly_review_day` config value to a day-of-week number (0-6,
 * Sunday=0). Accepts both string names ("saturday", case-insensitive) and
 * numbers. Returns null if the value is missing or unparseable.
 */
export function resolveWeeklyReviewDay(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 6 ? value : null;
  }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const idx = days.indexOf(value.trim().toLowerCase());
  return idx === -1 ? null : idx;
}

/**
 * Whether today is the configured weekly-review day. Centralized so the
 * prompt selection and the user message stay in sync.
 */
export function isWeeklyReviewDay(config: CallsheetConfig, now: Date = new Date()): boolean {
  const target = resolveWeeklyReviewDay(config.weekly_review_day);
  return target !== null && now.getDay() === target;
}

/**
 * Render the household roster for the prompt.
 *
 * The roster is the answer to "who is this brief about". Without it the only
 * people the writer knows are the ones with connector accounts, so a member
 * who has none is invisible even when their name is all over the calendar.
 */
export function buildHouseholdContext(household?: HouseholdMember[]): string {
  if (!household || household.length === 0) return '';

  let out = '\n\n## Household members\n\n';
  out +=
    'These are the people this brief is about. Some of them have no calendar, ' +
    'inbox or task list of their own — they still live here and still appear in ' +
    "other people's events. Never assume the household is only the account holders, " +
    "and never attribute a person's activity to whoever's calendar it happens to sit on.\n\n";

  for (const m of household) {
    const parts = [m.role, m.notes].filter(Boolean).join(' — ');
    out += `- **${m.name}**${parts ? `: ${parts}` : ''}\n`;
  }

  const linked = household.filter(
    (m) => m.calendar_account ?? m.gmail_account ?? m.todoist_account,
  );
  if (linked.length > 0) {
    out += '\nConnector accounts map to people as follows:\n\n';
    for (const m of linked) {
      const links = [
        m.calendar_account && `calendar "${m.calendar_account}"`,
        m.gmail_account && `gmail "${m.gmail_account}"`,
        m.todoist_account && `todoist "${m.todoist_account}"`,
      ]
        .filter(Boolean)
        .join(', ');
      out += `- ${m.name} → ${links}\n`;
    }
  }

  return out;
}

function loadPrompt(config: CallsheetConfig): string {
  const promptPath = join(__dirname, 'prompts', 'system.md');
  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8');
  } catch {
    throw new Error(`Prompt not found: ${promptPath}`);
  }

  prompt += buildHouseholdContext(config.household);

  // Context the household wrote once and may not have revisited: expired
  // entries are left out and entries whose dates have all passed are marked
  // as history, so the writer stops counting down to finished plans.
  const context = prepareContext(config.context, todayYmd(config.timezone));
  for (const { key, latest } of context.stale) {
    console.log(
      `  Note: context "${key}" only mentions past dates (latest ${latest}) — update it in config.yaml.`,
    );
  }
  if (context.entries.length > 0) {
    prompt += '\n\n## Household context\n\n';
    prompt +=
      'Background the household wrote about itself. It may be out of date: use it to interpret ' +
      "today's data, never to contradict it.\n\n";
    for (const [key, value] of context.entries) {
      prompt += `- **${key}**: ${value}\n`;
    }
  }

  // Inject extras (fun recurring items)
  const extras = config.extras ?? [];
  if (extras.length > 0) {
    prompt += '\n\n## Extras\n\n';
    prompt += 'The user has configured these recurring items for the Executive Brief:\n\n';
    for (const extra of extras) {
      prompt += `### ${extra.name}\n${extra.instruction}\n\n`;
    }
  }

  // Load memory from previous briefs
  const outputDir = config.output_dir ?? 'output';
  const memories = loadRecentMemories(outputDir);
  prompt += buildMemoryContext(memories);

  // The household's own notes on what they want from the brief
  prompt += buildFeedbackContext(config);

  // Load auto-close notifications from yesterday
  prompt += buildAutoCloseContext(outputDir);

  return prompt;
}

// ---------------------------------------------------------------------------
// Retry helper with exponential backoff
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5_000; // 5s, 10s, 20s

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  let attemptsMade = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attemptsMade = attempt + 1;
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const { status } = e as { status?: number };
      const retryable = status === 429 || status === 529 || status === 500 || status === 503;
      if (!retryable || attempt === retries) break;

      const delay = BASE_DELAY_MS * 2 ** attempt;
      console.log(
        `  Attempt ${attempt + 1} failed (${status}), retrying ${label} in ${delay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Annotate with the REAL number of attempts. A non-retryable status (a billing
  // 400, a bad key) breaks after one; reporting the ceiling made a two-week credit
  // outage in June 2026 read as API flakiness on every one of those mornings.
  if (lastError !== null && typeof lastError === 'object') {
    (lastError as { attemptsMade?: number }).attemptsMade = attemptsMade;
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Error brief — generated when the Claude API is completely unreachable
// ---------------------------------------------------------------------------

function buildErrorBrief(
  error: unknown,
  connectorIssues: ConnectorIssue[],
  errors: RuntimeError[] = [],
): Brief {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const errMsg = error instanceof Error ? error.message : String(error);
  const { status, attemptsMade } = error as { status?: number; attemptsMade?: number };
  const attempts = attemptsMade ?? MAX_RETRIES + 1;
  // 4xx other than 429 is our fault or our account's: bad key, no credit, bad request.
  // It will be exactly as broken tomorrow, so say so instead of promising a retry.
  const terminal = status !== undefined && status >= 400 && status < 500 && status !== 429;

  const sections: Brief['sections'] = [
    {
      heading: 'Generation Error',
      body:
        `Brief generation failed after ${attempts} attempt${attempts === 1 ? '' : 's'}. ` +
        (status ? `API returned status ${status}. ` : '') +
        `Error: ${errMsg}\n\n` +
        (terminal
          ? 'This is a TERMINAL error — billing, credentials, or a malformed request. ' +
            'It will not fix itself on the next run, and retries were skipped deliberately. ' +
            'Someone has to act.'
          : 'Data was fetched successfully and cached — the brief will retry on the next run.'),
    },
  ];

  // Surface all issues: connector errors + runtime errors
  const allIssueItems = [
    ...connectorIssues.map((issue) => ({
      label: issue.connector,
      note: issue.error,
      urgent: true,
    })),
    ...errors.map((err) => ({
      label: err.source,
      note: err.error,
      urgent: err.severity === 'error',
    })),
  ];

  if (allIssueItems.length) {
    sections.push({
      heading: 'Issues During This Run',
      items: allIssueItems,
    });
  }

  return {
    title: `Callsheet — ${dateStr}`,
    subtitle: '⚠ GENERATION FAILED',
    sections,
  };
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    time: { type: 'string' },
    note: { type: 'string' },
    checkbox: { type: 'boolean' },
    highlight: { type: 'boolean' },
    urgent: { type: 'boolean' },
  },
  required: ['label'],
  additionalProperties: false,
} as const;

/**
 * The brief's JSON schema, sent as structured output so the response always
 * parses. With the task coach on, the plan fields are part of it.
 */
export function briefSchema(withPlan: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            items: { type: 'array', items: ITEM_SCHEMA },
            body: { type: 'string' },
          },
          required: ['heading'],
          additionalProperties: false,
        },
      },
      ...(withPlan ? PLAN_SCHEMA_PROPERTIES : {}),
    },
    required: [
      'title',
      'sections',
      ...(withPlan ? ['focus', 'decide', 'capture', 'capture_prompts'] : []),
    ],
    additionalProperties: false,
  };
}

/** Yesterday's focus results; a corrupt record is no results, never a failed run. */
function yesterdayResultsSafe(
  outputDir: string,
  people: ReturnType<typeof readTodoist>,
  today: string,
): ReturnType<typeof yesterdayResults> {
  try {
    return yesterdayResults(outputDir, people, today);
  } catch {
    return null;
  }
}

/** Heading of the weekly section listing stale config context. */
const HOUSEKEEPING_HEADING = 'Housekeeping';

/** Options for one brief generation. */
export interface GenerateOptions {
  /**
   * Act on the brief: carry out the task coach's plan, auto-close tasks, and
   * record the focus, learned context and language phrase. True for real
   * runs; false for previews, so a dashboard "generate" never writes to
   * Todoist or overwrites the record of what the morning's brief said.
   */
  applyActions?: boolean;
}

export async function generateBrief(
  config: CallsheetConfig,
  dataPayload: string,
  connectorIssues: ConnectorIssue[] = [],
  options: GenerateOptions = {},
): Promise<Brief> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set.');
  }

  const client = new Anthropic({ apiKey });
  const model = config.model ?? DEFAULT_MODEL;
  const drainedErrors = runtimeErrors.drain();
  const today = new Date();
  const todayStr = todayYmd(config.timezone, today);
  const dateStr = formatLongDate(todayStr);
  const weekly = isWeeklyReviewDay(config, today);
  const outputDir = config.output_dir ?? 'output';

  // Living context: learn what the morning's data has changed about the
  // household before the writer reads its context (real runs only).
  const livingCfg = livingSettings(config);
  let living = livingCfg.enabled ? loadLiving(outputDir) : null;
  let livingChanges: LivingChanges | null = null;
  if (living && options.applyActions) {
    const reviewed = await reviewLivingContext(
      client,
      CRITIQUE_MODEL,
      config,
      living,
      dataPayload,
      todayStr,
      outputDir,
      {
        maxTokens: HOUSEKEEPING_MAX_TOKENS,
        warn: (msg) => runtimeErrors.add('context_review', msg, 'warning'),
      },
    );
    living = reviewed.living;
    livingChanges = reviewed.changes;
    saveLiving(outputDir, living);
    const { added, retired, flagged } = livingChanges;
    if (added.length + retired.length + flagged.length) {
      console.log(
        `  Context: ${added.length} fact(s) learned, ${retired.length} retired, ` +
          `${flagged.length} config entr${flagged.length === 1 ? 'y' : 'ies'} flagged.`,
      );
    }
  }

  const systemPrompt =
    loadPrompt(config) +
    (living ? buildLivingContext(activeFacts(living, todayStr, livingCfg.ignore)) : '') +
    buildConnectorIssuesContext(connectorIssues, drainedErrors);

  // Previous-brief diff context runs every day, weekly review or not — the
  // weekly blurb is a small supplement to the daily brief, not a replacement,
  // so yesterday's brief is still relevant for duplication checks.
  const prevBrief = loadPreviousBrief(outputDir);
  const diffContext = prevBrief ? buildDiffContext(prevBrief) : '';

  // Task coach: what the writer needs to plan the day, computed in code.
  const coach = coachSettings(config);
  const people = coach.enabled ? readTodoist(dataPayload) : [];
  let ledger = coach.enabled ? observeTasks(loadLedger(outputDir), people, todayStr) : undefined;
  const stuck = ledger ? findStuck(people, ledger, todayStr, coach.maxDecide + 2) : [];
  const yesterday = coach.enabled ? yesterdayResultsSafe(outputDir, people, todayStr) : null;
  const coachContext = coach.enabled
    ? buildCoachContext(coach, stuck, readFreeTime(dataPayload), yesterday, people)
    : '';
  const weekNumbers = weekly && ledger ? weekStats(ledger, todayStr) : null;

  let brief: Brief;
  let plan: TaskPlan;

  try {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      // Current models reason before answering, and that reasoning is
      // drawn from the same budget as the response, so this has to cover
      // both. Kept under the SDK's ~21k ceiling for non-streaming
      // requests.
      max_tokens: 20_000,
      // Without an explicit effort the model reasons at full depth, and on
      // a payload this size it spent an entire 16k budget thinking and
      // returned no brief at all. The judgement calls here are modest —
      // what to include and how to phrase it — and the facts arrive
      // pre-computed, so it does not need to deliberate at that length.
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: briefSchema(coach.enabled) },
      },
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            `Today is ${dateStr}.\n\n` +
            (weekly
              ? 'This is a **Week in Review** day. Generate the normal daily brief as usual — ' +
                'but ALSO add a compact "Week in Review" section as the VERY FIRST section of ' +
                'the brief (before the Executive Brief). This section must use `body` (not `items`) ' +
                'and contain a single short paragraph of 2–4 sentences (~60 words max) reflecting ' +
                'on the past 7 days: what actually happened and what got done. Build it ONLY from ' +
                "the calendar's `recent` events, Todoist's completed tasks and the numbers below — " +
                'never from memory or earlier briefs, and never claim an outcome (passed, booked, ' +
                "cleared, approved) unless an email or completed task in today's data says so. " +
                'It is a supplement, NOT a replacement for the daily brief. Do not repeat week-in-review ' +
                'content in other sections.\n' +
                (weekNumbers ? `${weekNumbers}\n` : '') +
                '\n'
              : '') +
            'Here is all available data from the connected sources:\n' +
            `<data>\n${dataPayload}\n</data>\n` +
            diffContext +
            coachContext +
            '\n' +
            'Generate the morning brief JSON now. Return ONLY valid JSON matching the schema — no explanation, no code fences.',
        },
      ],
    };
    const response = await withRetry(() => createMessage(client, params), 'Claude API call');

    logUsage(outputDir, model, 'brief', response.usage.input_tokens, response.usage.output_tokens);

    const text = stripJsonCodeFences(extractResponseText(response));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    ({ brief, plan } = extractPlan(parsed, people, coach, stuck));

    // The heading is a fact, not a judgement call, so it is set here rather
    // than taken from the model. Left to the writer it drifted: briefs went
    // out pairing the correct weekday with the following day's date.
    brief.title = dateStr;
  } catch (e) {
    console.error(`  Brief generation failed: ${e}`);
    console.log('  Generating error brief with cached data...');
    await notifyFailure(config, e);
    return buildErrorBrief(e, connectorIssues, drainedErrors);
  }

  // Save memory for future briefs
  // Extracting a handful of facts from data that has already been read is
  // housekeeping, not writing. Running it on the brief model cost more per day
  // than the brief itself did on some runs.
  await saveMemory(client, CRITIQUE_MODEL, dataPayload, outputDir);

  // Carry the plan out in Todoist (real runs only), then put it on the page.
  if (coach.enabled && ledger) {
    let actions: TodoistActionResult | null = null;
    if (options.applyActions) {
      actions = await applyPlan(plan, people, config, coach, ledger, todayStr);
      for (const err of actions.errors) runtimeErrors.add('task_coach', err, 'warning');
      ledger = recordDay(
        outputDir,
        ledger,
        plan,
        people,
        todayStr,
        yesterday,
        actions.added.length,
      );
      saveLedger(outputDir, ledger);
    }
    brief = renderPlan(brief, plan, people, stuck, actions, yesterday, coach);
    console.log(
      `  Task coach: ${plan.focus.length} focus pick(s), ${plan.decide.length} decision(s), ` +
        (actions
          ? `${actions.added.length} task(s) added, ${actions.scheduled.length} scheduled for today` +
            (actions.skipped.length ? `, ${actions.skipped.length} capture(s) skipped` : '')
          : `${plan.capture.length} capture(s) proposed (preview: nothing written)`) +
        '.',
    );
  }

  // Housekeeping: what the living context learned today, and once a week the
  // context entries the household should update by hand.
  const housekeeping: BriefItem[] = livingChanges ? changeItems(livingChanges) : [];
  if (weekly) {
    const ctx = prepareContext(config.context, todayStr);
    const listed = new Set(housekeeping.map((i) => i.label));
    const weeklyItems: BriefItem[] = [
      ...ctx.stale.map(({ key, latest }) => ({
        label: `Update the "${key}" context in config.yaml`,
        note: `every date it mentions has passed (latest ${latest})`,
        checkbox: true,
      })),
      ...ctx.expired.map((key) => ({
        label: `Remove the "${key}" context from config.yaml`,
        note: 'its until date has passed, so it is no longer used',
        checkbox: true,
      })),
      ...(living ? openConfigFlags(living, config) : []).map((f) => ({
        label: `Update the "${f.key}" context in config.yaml`,
        note: `${f.reason} (noticed ${f.date})`,
        checkbox: true,
      })),
    ];
    for (const item of weeklyItems) {
      if (!listed.has(item.label)) {
        housekeeping.push(item);
        listed.add(item.label);
      }
    }
  }
  if (housekeeping.length) {
    brief.sections.push({ heading: HOUSEKEEPING_HEADING, items: housekeeping });
  }

  // Review before printing: repeats out of the Executive Brief, in code; then
  // a fact check whose findings must quote both the brief and the data, and
  // are applied as exact replacements only once both quotes are verified.
  const protectedPrefixes = protectedLabelPrefixes(config);
  const deduped = dedupeExecutiveBrief(brief, protectedPrefixes);
  brief = deduped.brief;
  const factIssues = await factCheckBrief(client, CRITIQUE_MODEL, brief, dataPayload, outputDir, {
    maxTokens: HOUSEKEEPING_MAX_TOKENS,
    warn: (msg) => runtimeErrors.add('fact_check', msg, 'warning'),
  });
  const verified = verifyFactIssues(factIssues, brief, dataPayload, protectedPrefixes, [
    ...COACH_HEADINGS,
    HOUSEKEEPING_HEADING,
  ]);
  const { brief: corrected, applied } = applyCorrections(brief, verified);
  if (applied.length) {
    brief = corrected;
    // The date is derived, not written — a correction must never move it.
    brief.title = dateStr;
  }
  console.log(
    `  Review: ${deduped.removed.length} repeated Executive Brief item(s) removed; ` +
      `${factIssues.length} fact issue(s) reported, ${verified.length} verified, ` +
      `${applied.length} corrected.`,
  );
  saveReviewLog(outputDir, {
    date: todayYmd(),
    removedDuplicates: deduped.removed,
    factIssues,
    corrected: applied,
  });

  // Record today's language phrase into its own long-horizon history so
  // tomorrow's brief can avoid repeating it. Lives separately from the
  // shared memory bucket because it needs a longer retention window.
  // Runs AFTER the review so the recorded phrase is the one that was printed.
  // Never on a preview: its phrase is not printed, and recording it would
  // replace the morning's, letting the one the household saw come back.
  if (options.applyActions) recordBriefPhrase(brief, config);

  // Auto-close: optionally close Todoist tasks proven resolved by other data
  // sources. Closing a task is a Todoist write, so a preview never does it.
  if (config.auto_close_tasks && options.applyActions) {
    console.log('  Checking for auto-closable tasks...');
    const recommendations = await detectResolvableTasks(
      client,
      CRITIQUE_MODEL,
      dataPayload,
      outputDir,
      (msg) => runtimeErrors.add('auto_close', msg, 'warning'),
      HOUSEKEEPING_MAX_TOKENS,
    );
    if (recommendations.length) {
      console.log(`  Found ${recommendations.length} task(s) to auto-close:`);
      const closed = await closeTodoistTasks(recommendations, config);
      saveAutoCloseLog(closed, outputDir);
      if (closed.length) {
        console.log(
          `  ✓ Auto-closed ${closed.length} task(s). Will be reported in tomorrow's brief.`,
        );
      }
    } else {
      console.log('  No tasks to auto-close.');
    }
  }

  return brief;
}

export function saveDataPayload(dataPayload: string, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const today = todayYmd();
  const path = join(outputDir, `connector_data_${today}.json`);
  writeFileSync(path, dataPayload);
  return path;
}

export function saveBrief(brief: Brief, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const today = todayYmd();
  const path = join(outputDir, `callsheet_${today}.json`);
  writeFileSync(path, JSON.stringify(brief, null, 2));
  return path;
}

/** Internal warnings for the status record, or nothing when there were none. */
function warningsField(errors: RuntimeError[]): { warnings?: string[] } {
  return errors.length ? { warnings: errors.map((e) => `${e.source}: ${e.error}`) } : {};
}

/**
 * Before a non-scheduled run overwrites today's files, keep a copy of the ones
 * the scheduled run printed (`callsheet_DATE.printed.json`/`.pdf`, and the
 * data behind them). Re-running in the afternoon used to replace the brief
 * the household had read that morning, leaving no record of it.
 */
export function preservePrintedRun(outputDir: string, date: string, trigger: RunTrigger): void {
  if (isScheduledTrigger(trigger)) return;
  const scheduled = readStatus(outputDir).lastScheduled;
  // With no scheduled run on record at all (the first day on a version that
  // keeps run status), nothing says whose files these are, and losing the
  // morning's brief is worse than keeping a copy of an earlier re-run.
  if (scheduled && (scheduled.date !== date || !scheduled.generated)) return;
  for (const [from, to] of [
    [`callsheet_${date}.json`, `callsheet_${date}.printed.json`],
    [`callsheet_${date}.pdf`, `callsheet_${date}.printed.pdf`],
    [`connector_data_${date}.json`, `connector_data_${date}.printed.json`],
  ]) {
    const src = join(outputDir, from);
    const dst = join(outputDir, to);
    try {
      if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
    } catch {
      /* a lost copy is not worth failing the run */
    }
  }
}

/** True for the page `buildErrorBrief` produces when the model could not write a brief. */
export function isErrorBrief(brief: Brief): boolean {
  return (
    Boolean(brief.subtitle?.includes('GENERATION FAILED')) ||
    brief.sections[0]?.heading === 'Generation Error'
  );
}

/** First paragraph of an error page's explanation, for the status file. */
function errorBriefSummary(brief: Brief): string {
  const body = brief.sections[0]?.body ?? '';
  return body.split('\n')[0].slice(0, 200) || 'Brief generation failed';
}

/**
 * Ping a dead-man's-switch URL (e.g. a healthchecks.io check) after a good
 * scheduled run. The alerts above cover runs that fail; only a missing ping can
 * cover a run that never started — a container that is down, or a scheduler
 * that never fired. Never throws.
 */
export async function pingHeartbeat(url: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.error(`  Heartbeat returned ${res.status}`);
  } catch (e) {
    console.error(`  Heartbeat error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Pipeline — reusable generation flow for CLI, scheduler, and web API
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /** Generate the PDF without printing it. */
  preview?: boolean;
  /** What started the run; recorded in the status file. */
  trigger?: RunTrigger;
  /** Print retry/confirmation tuning — tests shorten the waits. */
  print?: PrintOptions;
}

export interface PipelineResult {
  brief: Brief;
  jsonPath: string;
  pdfPath: string;
  dataPath: string;
  /** False when an error page was produced instead of a brief. */
  generated: boolean;
  print: PrintResult | { outcome: 'skipped'; jobId?: undefined; detail?: string };
}

export async function runPipeline(
  config: CallsheetConfig,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const trigger: RunTrigger = options.trigger ?? (options.preview ? 'dashboard' : 'manual');
  const startedAt = new Date().toISOString();
  const runDate = todayYmd();
  const outputDir = config.output_dir ?? 'output';

  // Warnings raised after a previous run finished writing its brief (memory,
  // review, auto-close) would otherwise surface as this morning's problems.
  const leftover = runtimeErrors.drain();
  if (leftover.length) {
    console.log(`  Dropping ${leftover.length} warning(s) left over from an earlier run.`);
  }

  // Fetch
  console.log('Fetching data...');
  const { results, issues: connectorIssues } = await fetchAll(config);
  const issueLines = connectorIssues.map((i) => `${i.connector}: ${i.error}`);

  if (isScheduledTrigger(trigger)) {
    const reached = updateConnectorStreaks(
      outputDir,
      runDate,
      connectorIssues.map((i) => i.connector),
      shiftYmd(runDate, -1),
    );
    for (const [name, streak] of Object.entries(reached)) {
      const why = connectorIssues.find((i) => i.connector === name)?.error ?? '';
      await notify(
        config,
        `WARN Callsheet: ${name} has failed ${streak.days} mornings running (since ${streak.since}): ${why}`,
      );
    }
  }

  if (results.length === 0) {
    const message = 'No data fetched. Check your config and connector settings.';
    recordRun(outputDir, {
      date: runDate,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      generated: false,
      print: 'skipped',
      error: message,
      connectorIssues: issueLines,
    });
    if (isScheduledTrigger(trigger)) await notify(config, `CRIT Callsheet: ${message}`);
    throw new Error(message);
  }

  if (connectorIssues.length) {
    console.log(`  ${connectorIssues.length} connector(s) had issues — will be noted in brief.`);
  }

  const dataPayload = buildDataPayload(results);

  // A manual or dashboard re-run must not erase the morning's printed brief
  // or the data it was written from — the record of what the household saw.
  preservePrintedRun(outputDir, runDate, trigger);

  // Save raw data
  const dataPath = saveDataPayload(dataPayload, outputDir);
  console.log(`  Data: ${dataPath}`);

  // Generate
  console.log(`Generating brief via Claude (${config.model ?? DEFAULT_MODEL})...`);
  let brief: Brief;
  try {
    brief = await generateBrief(config, dataPayload, connectorIssues, {
      applyActions: !options.preview,
    });
  } catch (e) {
    // Safety net: if generateBrief throws despite its internal catch,
    // still produce an error brief rather than crashing the whole pipeline.
    console.error(`  Pipeline caught brief error: ${e}`);
    brief = buildErrorBrief(e, connectorIssues, runtimeErrors.drain());
  }

  const jsonPath = saveBrief(brief, outputDir);
  console.log(`  JSON: ${jsonPath}`);

  const pdfPath = await renderPdf(brief, outputDir);
  console.log(`  PDF:  ${pdfPath}`);

  const generated = !isErrorBrief(brief);

  // Print (unless preview mode). A print failure is reported, not thrown: the
  // brief exists and is on the dashboard, and the run should say exactly what
  // went wrong instead of collapsing into a generic "generation failed".
  let print: PipelineResult['print'] = { outcome: 'skipped' };
  if (!options.preview) {
    const printer = config.printer ?? '';
    if (printer) {
      console.log(`Printing to ${printer}...`);
      print = await printAndConfirm(pdfPath, printer, options.print);
      if (print.outcome === 'failed') {
        console.error(`  Print FAILED: ${print.detail}`);
        await notify(config, `CRIT Callsheet brief not printed: ${print.detail}`);
      } else if (print.outcome === 'queued') {
        console.error(`  Print not confirmed: ${print.detail}`);
        await notify(config, `WARN Callsheet print stuck: ${print.detail}`);
      } else {
        console.log('Done.');
      }
    } else {
      console.log("No printer configured. Set 'printer' in config.yaml to enable printing.");
    }
  }

  recordRun(outputDir, {
    date: runDate,
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    generated,
    print: print.outcome,
    printJob: print.jobId,
    error: generated ? print.detail : errorBriefSummary(brief),
    connectorIssues: issueLines.length ? issueLines : undefined,
    ...warningsField(runtimeErrors.drain()),
  });

  if (
    config.heartbeat_url &&
    isScheduledTrigger(trigger) &&
    generated &&
    print.outcome !== 'failed'
  ) {
    await pingHeartbeat(config.heartbeat_url);
  }

  return { brief, jsonPath, pdfPath, dataPath, generated, print };
}
