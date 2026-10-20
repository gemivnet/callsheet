/**
 * Living context — household facts callsheet keeps up to date from the data.
 *
 * The `context` block in config is written by hand and goes stale: plans end,
 * jobs change, an exam is passed, and nobody edits the YAML. The date scan
 * in context.ts catches prose whose dates have all passed, but not a change
 * the prose never anticipated.
 *
 * Each real run, the housekeeping model compares the household context with the
 * morning's data and proposes changes: a new fact the data establishes (an
 * offer letter, a booked trip), retiring a learned fact that has stopped being
 * true, or flagging a config entry the data contradicts. Every proposal must
 * quote the email, event or task behind it, and the quote is checked against
 * the data before anything is kept. Learned facts carry an expiry and live in
 * `output/context/living.json`; config is never edited — a contradicted entry
 * is listed for the household to update by hand. What changed is printed on
 * the day it changed, so the household can see what callsheet now believes,
 * and `living_context.ignore` vetoes a fact it got wrong.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BriefItem, CallsheetConfig } from './types.js';
import { shiftYmd } from './dates.js';
import { createMessage, extractResponseText, normaliseForQuote } from './llm.js';
import { logUsage } from './usage.js';

/** How long a learned fact lasts when the model gives no end date. */
const DEFAULT_FACT_DAYS = 60;
/** Changes accepted per run, so one odd morning cannot rewrite the household. */
const MAX_ADDS_PER_RUN = 3;
const MAX_RETIRES_PER_RUN = 3;

export interface LivingFact {
  id: string;
  topic: string;
  text: string;
  /** Day it was learned. */
  since: string;
  /** Last day it is assumed true. */
  until: string;
  /** Where it came from, quoted. */
  source: string;
}

export interface StaleConfigFlag {
  key: string;
  reason: string;
  date: string;
  /** The entry's text when flagged; an edited entry clears the flag. */
  text: string;
}

export interface LivingContext {
  facts: LivingFact[];
  retired: (LivingFact & { retiredOn: string; reason: string })[];
  staleConfig: StaleConfigFlag[];
}

export interface LivingChanges {
  added: LivingFact[];
  retired: (LivingFact & { reason: string })[];
  flagged: StaleConfigFlag[];
}

export interface LivingSettings {
  enabled: boolean;
  ignore: string[];
}

export function livingSettings(config: CallsheetConfig): LivingSettings {
  const c = (config.living_context ?? {}) as { enabled?: unknown; ignore?: unknown };
  return {
    enabled: c.enabled === true,
    ignore: Array.isArray(c.ignore)
      ? c.ignore.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [],
  };
}

const livingPath = (outputDir: string) => join(outputDir, 'context', 'living.json');

export function loadLiving(outputDir: string): LivingContext {
  try {
    const raw = JSON.parse(readFileSync(livingPath(outputDir), 'utf-8')) as Partial<LivingContext>;
    return {
      facts: Array.isArray(raw.facts) ? raw.facts : [],
      retired: Array.isArray(raw.retired) ? raw.retired : [],
      staleConfig: Array.isArray(raw.staleConfig) ? raw.staleConfig : [],
    };
  } catch {
    return { facts: [], retired: [], staleConfig: [] };
  }
}

export function saveLiving(outputDir: string, living: LivingContext): void {
  mkdirSync(join(outputDir, 'context'), { recursive: true });
  writeFileSync(livingPath(outputDir), JSON.stringify(living, null, 2));
}

/** Learned facts in force today, minus any the household has vetoed. */
export function activeFacts(
  living: LivingContext,
  today: string,
  ignore: string[] = [],
): LivingFact[] {
  const vetoes = ignore.map((s) => s.toLowerCase());
  return living.facts.filter(
    (f) => f.until >= today && !vetoes.some((v) => f.text.toLowerCase().includes(v)),
  );
}

/** Text of each config context entry, keyed. */
function configEntries(config: CallsheetConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.context ?? {})) {
    const text = typeof value === 'string' ? value : (value?.text ?? '');
    if (text.trim()) out[key] = text.trim();
  }
  return out;
}

/** Config entries still flagged as contradicted (an entry edited since is no longer flagged). */
export function openConfigFlags(living: LivingContext, config: CallsheetConfig): StaleConfigFlag[] {
  const entries = configEntries(config);
  return living.staleConfig.filter((f) => entries[f.key] === f.text);
}

/** Prompt section listing the learned facts. */
export function buildLivingContext(facts: LivingFact[]): string {
  if (!facts.length) return '';
  let out = '\n\n## Recent household changes (learned from the data)\n\n';
  out +=
    'Facts callsheet learned from earlier emails, events and tasks, newer than the household ' +
    "context above. Where they disagree with it, these win; today's data wins over both.\n\n";
  for (const f of facts) out += `- **${f.topic}** (since ${f.since}): ${f.text}\n`;
  return out;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    add: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          text: { type: 'string' },
          until: { type: 'string', format: 'date' },
          evidence: { type: 'string' },
        },
        required: ['topic', 'text', 'evidence'],
        additionalProperties: false,
      },
    },
    retire: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['id', 'reason', 'evidence'],
        additionalProperties: false,
      },
    },
    stale_config: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          reason: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['key', 'reason', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['add', 'retire', 'stale_config'],
  additionalProperties: false,
} as const;

/** Sources that say nothing about how the household lives. */
const SKIP_SOURCES = new Set(['language', 'market', 'weather', 'aviation_weather', 'sun_moon']);

function reviewPayload(dataPayload: string): string {
  try {
    const parsed: unknown = JSON.parse(dataPayload);
    if (!Array.isArray(parsed)) return dataPayload;
    return JSON.stringify(
      (parsed as { source?: string }[]).filter((s) => !SKIP_SOURCES.has(s?.source ?? '')),
    );
  } catch {
    return dataPayload;
  }
}

interface RawReview {
  add?: { topic?: unknown; text?: unknown; until?: unknown; evidence?: unknown }[];
  retire?: { id?: unknown; reason?: unknown; evidence?: unknown }[];
  stale_config?: { key?: unknown; reason?: unknown; evidence?: unknown }[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Keep only proposals whose evidence really is in the data, within the per-run
 * limits, and apply them. Pure — the caller saves the result.
 */
export function applyReview(
  raw: RawReview,
  living: LivingContext,
  config: CallsheetConfig,
  dataPayload: string,
  today: string,
): { living: LivingContext; changes: LivingChanges } {
  const data = normaliseForQuote(dataPayload.replace(/\\"/g, '"').replace(/\\n/g, ' '));
  const proven = (evidence: string) =>
    evidence.length >= 8 && data.includes(normaliseForQuote(evidence));
  const changes: LivingChanges = { added: [], retired: [], flagged: [] };
  const next: LivingContext = {
    facts: [...living.facts],
    retired: [...living.retired],
    staleConfig: [...living.staleConfig],
  };

  for (const a of raw.add ?? []) {
    if (changes.added.length >= MAX_ADDS_PER_RUN) break;
    const text = str(a.text).slice(0, 200);
    const topic = str(a.topic).slice(0, 40) || 'household';
    const evidence = str(a.evidence);
    if (!text || !proven(evidence)) continue;
    if (next.facts.some((f) => normaliseForQuote(f.text) === normaliseForQuote(text))) continue;
    const until = str(a.until);
    const fact: LivingFact = {
      id: `${today}-${next.facts.length + next.retired.length + 1}`,
      topic,
      text,
      since: today,
      until:
        /^\d{4}-\d{2}-\d{2}$/.test(until) && until >= today
          ? until
          : shiftYmd(today, DEFAULT_FACT_DAYS),
      source: evidence.slice(0, 160),
    };
    next.facts.push(fact);
    changes.added.push(fact);
  }

  for (const r of raw.retire ?? []) {
    if (changes.retired.length >= MAX_RETIRES_PER_RUN) break;
    const id = str(r.id);
    const fact = next.facts.find((f) => f.id === id);
    if (!fact || !proven(str(r.evidence))) continue;
    const reason = str(r.reason).slice(0, 160);
    next.facts = next.facts.filter((f) => f.id !== id);
    next.retired.push({ ...fact, retiredOn: today, reason });
    changes.retired.push({ ...fact, reason });
  }

  const entries = configEntries(config);
  for (const s of raw.stale_config ?? []) {
    const key = str(s.key);
    if (!entries[key] || !proven(str(s.evidence))) continue;
    if (next.staleConfig.some((f) => f.key === key && f.text === entries[key])) continue;
    const flag: StaleConfigFlag = {
      key,
      reason: str(s.reason).slice(0, 160),
      date: today,
      text: entries[key],
    };
    next.staleConfig = [...next.staleConfig.filter((f) => f.key !== key), flag];
    changes.flagged.push(flag);
  }

  // Expired facts move to the retired list; old history is trimmed.
  for (const f of next.facts.filter((x) => x.until < today)) {
    next.retired.push({ ...f, retiredOn: today, reason: 'expired' });
  }
  next.facts = next.facts.filter((f) => f.until >= today);
  next.retired = next.retired.filter((r) => r.retiredOn >= shiftYmd(today, -180));
  return { living: next, changes };
}

/**
 * Ask the model what in the household context the morning's data has
 * changed, then verify and apply. Never throws; on failure nothing changes.
 */
export async function reviewLivingContext(
  client: Anthropic,
  model: string,
  config: CallsheetConfig,
  living: LivingContext,
  dataPayload: string,
  today: string,
  outputDir: string,
  options: { maxTokens?: number; warn?: (message: string) => void } = {},
): Promise<{ living: LivingContext; changes: LivingChanges }> {
  const none = { living, changes: { added: [], retired: [], flagged: [] } };
  const entries = configEntries(config);
  try {
    const payload = reviewPayload(dataPayload);
    const response = await createMessage(client, {
      model,
      max_tokens: options.maxTokens ?? 8_000,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      system:
        `Today is ${today}. You keep a household's background facts current. You are given the ` +
        "context the household wrote, the facts already learned, and this morning's data. Report " +
        'only CHANGES that the data plainly establishes about how the household lives — a new job ' +
        'or a job that ended, a trip booked or cancelled, a certificate earned, a project finished, ' +
        'a new pet, school or program change. Not daily events, tasks, deliveries, bills or ' +
        "appointments: those are the brief's job. For each, quote `evidence` exactly from the data " +
        '(8-150 characters). `add`: a new fact, one sentence, with `until` when it has a natural end ' +
        "(a trip's last day). `retire`: a learned fact (by id) that the data shows is no longer " +
        'true. `stale_config`: a context entry (by key) that the data contradicts, with why. Empty ' +
        'lists are the normal answer.',
      messages: [
        {
          role: 'user',
          content:
            `Household context (from config):\n${JSON.stringify(entries, null, 2)}\n\n` +
            `Learned facts:\n${JSON.stringify(
              living.facts.map((f) => ({ id: f.id, topic: f.topic, text: f.text, since: f.since })),
              null,
              2,
            )}\n\n` +
            `This morning's data:\n${payload}`,
        },
      ],
    });
    logUsage(outputDir, model, 'memory', response.usage.input_tokens, response.usage.output_tokens);
    const raw = JSON.parse(extractResponseText(response)) as RawReview;
    return applyReview(raw, living, config, payload, today);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Context review failed: ${msg}`);
    options.warn?.(msg);
    return none;
  }
}

/** Housekeeping lines for what changed in the living context today. */
export function changeItems(changes: LivingChanges): BriefItem[] {
  return [
    ...changes.added.map((f) => ({
      label: `Learned: ${f.text}`,
      note: `from "${f.source}"${f.until ? ` · until ${f.until}` : ''}`,
    })),
    ...changes.retired.map((f) => ({ label: `No longer true: ${f.text}`, note: f.reason })),
    ...changes.flagged.map((f) => ({
      label: `Update the "${f.key}" context in config.yaml`,
      note: f.reason,
      checkbox: true,
    })),
  ];
}
