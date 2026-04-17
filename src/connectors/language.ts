/**
 * Language connector — persistent per-language phrase history so the brief's
 * language phrase never repeats itself across briefs.
 *
 * Background: the phrase-of-the-day previously lived in `extras:` and relied
 * on the LLM's memory system (7-day shared bucket of free-form insights) to
 * avoid repeats. That didn't work — the same phrase came back 3+ days in a
 * row because phrases were never persisted as structured data.
 *
 * This connector:
 *   1. Loads a long-horizon history of phrases the brief has emitted
 *      (default 30 days).
 *   2. Feeds that list into the prompt so the LLM knows what NOT to repeat.
 *   3. Provides context cues (today's themes, level) so the LLM can pick
 *      something relevant to the rest of the brief rather than a generic
 *      greeting.
 *   4. Exports `recordBriefPhrase()` — called by core.ts after the brief is
 *      generated — which parses the emitted phrase out of the brief and
 *      appends it to the history file.
 *
 * The phrase renders INSIDE the Executive Brief section as its last item,
 * not a section of its own.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Connector, ConnectorConfig, ConnectorResult, Check, Brief } from '../types.js';
import { PASS, INFO, WARN } from '../test-icons.js';

interface LanguageHistoryEntry {
  date: string;
  phrase: string;
  translation?: string;
}

interface LanguageHistory {
  entries: LanguageHistoryEntry[];
}

const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_LABEL_PREFIX = 'Español';
const DEFAULT_TARGET_LANGUAGE = 'Spanish';
const DEFAULT_LEVEL = 'A1-A2';

/**
 * Themes are cycled deterministically by day-of-year so no single topic runs
 * for weeks. The LLM is free to pick a different theme if today's connector
 * data has a strong signal (e.g. a flight lesson → aviation), but absent
 * signal we rotate.
 */
const DEFAULT_THEMES = [
  'greetings',
  'food and cooking',
  'restaurants and dining out',
  'directions and places in town',
  'hobbies and free time',
  'technology',
  'politics',
  'finance and economics',
  'weather',
  'household and daily routine',
  'questions you ask others',
  'plans and scheduling',
  'emotions and small talk',
  'travel and transportation',
  'family and relationships',
  'time and dates',
  'work and study',
  'shopping and money',
];

function historyPath(outputDir: string): string {
  return join(outputDir, 'language_history.json');
}

function loadHistory(outputDir: string): LanguageHistory {
  const path = historyPath(outputDir);
  if (!existsSync(path)) return { entries: [] };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LanguageHistory>;
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    // Corrupt file — start over rather than crashing the brief.
    return { entries: [] };
  }
}

function saveHistory(outputDir: string, history: LanguageHistory): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(historyPath(outputDir), JSON.stringify(history, null, 2));
}

function pruneHistory(history: LanguageHistory, retentionDays: number): LanguageHistory {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffYmd = cutoff.toISOString().slice(0, 10);
  return {
    entries: history.entries.filter((e) => e.date >= cutoffYmd),
  };
}

export function create(config: ConnectorConfig): Connector {
  const targetLanguage = (config.target_language as string) ?? DEFAULT_TARGET_LANGUAGE;
  const labelPrefix = (config.label_prefix as string) ?? DEFAULT_LABEL_PREFIX;
  const level = (config.level as string) ?? DEFAULT_LEVEL;
  const historyDays = (config.history_days as number) ?? DEFAULT_HISTORY_DAYS;
  const outputDir = (config.output_dir as string) ?? 'output';

  return {
    name: 'language',
    description: `${targetLanguage} phrase-of-the-day with anti-repeat history`,

    async fetch(): Promise<ConnectorResult> {
      const history = pruneHistory(loadHistory(outputDir), historyDays);
      const pastPhrases = history.entries.map((e) => ({
        date: e.date,
        phrase: e.phrase,
        translation: e.translation,
      }));

      const dayOfYear = Math.floor(
        (Date.now() - Date.UTC(new Date().getFullYear(), 0, 0)) / 86_400_000,
      );
      const todayTheme = DEFAULT_THEMES[dayOfYear % DEFAULT_THEMES.length];

      return {
        source: 'language',
        description:
          `${targetLanguage} language learning — phrase-of-the-day. ` +
          `**Render this as the LAST item inside the Executive Brief section** ` +
          "(NOT as its own section). Do not create a separate 'Language' section. " +
          `Label format: \`${labelPrefix}: "<phrase in ${targetLanguage}>" — <English translation>\`. ` +
          `Optionally include 1-3 vocabulary notes in the item's \`note\` field, formatted ` +
          `as \`word = meaning; word = meaning\`. ` +
          `Target level: ${level}. ` +
          `Today's suggested theme: **${todayTheme}** (feel free to pick a different theme ` +
          `if today's connector data gives a stronger cue — e.g. food vocab on a restaurant ` +
          `plan, travel vocab as a trip approaches, weather vocab on an unusual-weather day). ` +
          `**CRITICAL ANTI-REPEAT RULES:** ` +
          `The \`past_phrases\` list contains every phrase the brief has emitted in the last ` +
          `${historyDays} days — you MUST NOT repeat any of them, even in a slightly different ` +
          `form. Pick a fresh phrase. Vary the grammar pattern (statements, questions, ` +
          `commands, expressions of feeling) across days. Teach new vocabulary — avoid ` +
          `recycling words that appear frequently in past phrases.`,
        data: {
          target_language: targetLanguage,
          label_prefix: labelPrefix,
          level,
          retention_days: historyDays,
          today_theme: todayTheme,
          past_phrases: pastPhrases,
          past_count: pastPhrases.length,
        },
        priorityHint: 'low',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const targetLanguage = (config.target_language as string) ?? DEFAULT_TARGET_LANGUAGE;
  const level = (config.level as string) ?? DEFAULT_LEVEL;
  const historyDays = (config.history_days as number) ?? DEFAULT_HISTORY_DAYS;
  const outputDir = (config.output_dir as string) ?? 'output';

  checks.push([PASS, `Target language: ${targetLanguage}`, `level ${level}`]);
  checks.push([INFO, `Retention: ${historyDays} days`, 'anti-repeat window']);

  const path = historyPath(outputDir);
  if (existsSync(path)) {
    try {
      const history = JSON.parse(readFileSync(path, 'utf-8')) as LanguageHistory;
      checks.push([PASS, `History loaded: ${history.entries?.length ?? 0} entries`, path]);
    } catch (e) {
      checks.push([WARN, 'History file corrupt — will start fresh', String(e)]);
    }
  } else {
    checks.push([INFO, 'No history yet — will be created on first brief', path]);
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Recording — called from core.ts after the brief JSON is generated
// ---------------------------------------------------------------------------

/**
 * Regex that extracts the phrase and translation from a label like:
 *   Español: "Buenos días" — Good morning
 * Quotes can be straight or curly; separator can be em/en/hyphen.
 */
function buildPhraseRegex(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept straight and curly quotes, plus any dash variant as separator.
  return new RegExp(
    `^\\s*${escaped}\\s*[:\u2013\u2014-]\\s*["\u201C]([^"\u201D\u201C]+)["\u201D]\\s*[\u2014\u2013-]\\s*(.+?)\\s*$`,
    'i',
  );
}

interface ExtractedPhrase {
  phrase: string;
  translation: string;
}

/**
 * Walk every section's items looking for a label that matches the language
 * prefix. Returns null if the brief didn't surface a phrase (e.g. the LLM
 * skipped it, or the brief is an error brief).
 */
export function extractPhraseFromBrief(brief: Brief, labelPrefix: string): ExtractedPhrase | null {
  const re = buildPhraseRegex(labelPrefix);
  for (const section of brief.sections ?? []) {
    for (const item of section.items ?? []) {
      const m = item.label.match(re);
      if (m) {
        return { phrase: m[1].trim(), translation: m[2].trim() };
      }
    }
  }
  return null;
}

/**
 * Append today's phrase to the history file, pruning anything past the
 * retention horizon. Safe to call with a brief that has no phrase — it
 * silently no-ops.
 *
 * Called from core.ts after `generateBrief` returns. Errors are swallowed
 * because recording phrases is strictly an ergonomic nicety — a failure
 * here must never block the brief from printing.
 */
export function recordBriefPhrase(
  brief: Brief,
  config: { output_dir?: string; connectors?: Record<string, ConnectorConfig> },
): void {
  try {
    const connConfig = config.connectors?.language;
    if (!connConfig?.enabled) return;

    const labelPrefix = (connConfig.label_prefix as string) ?? DEFAULT_LABEL_PREFIX;
    const historyDays = (connConfig.history_days as number) ?? DEFAULT_HISTORY_DAYS;
    const outputDir = config.output_dir ?? 'output';

    const extracted = extractPhraseFromBrief(brief, labelPrefix);
    if (!extracted) return;

    const history = pruneHistory(loadHistory(outputDir), historyDays);
    const today = new Date().toISOString().slice(0, 10);

    // If today already has an entry, replace it rather than duplicate — the
    // brief may be regenerated within the same day (manual re-run, retry).
    history.entries = history.entries.filter((e) => e.date !== today);
    history.entries.push({
      date: today,
      phrase: extracted.phrase,
      translation: extracted.translation,
    });

    saveHistory(outputDir, history);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Failed to record language phrase: ${msg}`);
  }
}
