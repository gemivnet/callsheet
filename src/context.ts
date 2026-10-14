/**
 * Household context that knows when it has gone out of date.
 *
 * The `context` block in config is free prose the household writes once and
 * rarely revisits. Months later the writer was still being told about a trip
 * that had ended, a deadline that had passed and a school the household had
 * left, and it acted on them: it invented countdowns to the finished trip,
 * gave lesson weather for the old airfield, and carried a past deadline into
 * new briefs. Nothing ever said the prose was stale.
 *
 * An entry can now carry an `until` date and drops out after it. For plain
 * prose entries, the dates they mention are read: when every one of them is
 * in the past, the entry is still given to the writer but marked as history,
 * and the household is told to update it.
 */
import { shiftYmd } from './dates.js';

/** A context entry: prose, or prose with the last day it is true. */
export type ContextEntry = string | { text: string; until?: string };

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((m) => m.startsWith(lower.slice(0, 3))) + 1;
}

/**
 * Every date a piece of prose names, as YYYY-MM-DD: ISO dates, "May 7, 2026",
 * "May 7-25, 2026" (the range's end), and "June 2026" or "end of June 2026"
 * (the month's last day). Dates without a year are ambiguous and ignored.
 */
export function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    out.push(ymd(+m[1], +m[2], +m[3]));
  }
  const monthNames =
    '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const withDay = new RegExp(
    `\\b${monthNames}\\.?\\s+(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`,
    'gi',
  );
  const covered: [number, number][] = [];
  for (const m of text.matchAll(withDay)) {
    const month = monthIndex(m[1]);
    const day = Number(m[3] ?? m[2]);
    if (month < 1 || day < 1 || day > 31) continue;
    out.push(ymd(+m[4], month, Math.min(day, lastDayOfMonth(+m[4], month))));
    covered.push([m.index, m.index + m[0].length]);
  }
  const monthOnly = new RegExp(`\\b${monthNames}\\.?\\s+(20\\d{2})\\b`, 'gi');
  for (const m of text.matchAll(monthOnly)) {
    if (covered.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const month = monthIndex(m[1]);
    if (month < 1) continue;
    out.push(ymd(+m[2], month, lastDayOfMonth(+m[2], month)));
  }
  return out.sort();
}

export interface PreparedContext {
  /** Entries to give the writer, already annotated where stale. */
  entries: [string, string][];
  /** Entries whose `until` has passed; left out entirely. */
  expired: string[];
  /** Prose entries all of whose dates have passed, with the latest of them. */
  stale: { key: string; latest: string }[];
}

/**
 * Sort context entries into current, stale and expired for `today`.
 * A prose entry counts as stale only when it names at least one date and the
 * latest is more than `graceDays` behind today.
 */
export function prepareContext(
  context: Record<string, ContextEntry> | undefined,
  today: string,
  graceDays = 1,
): PreparedContext {
  const result: PreparedContext = { entries: [], expired: [], stale: [] };
  const cutoff = shiftYmd(today, -graceDays);
  for (const [key, value] of Object.entries(context ?? {})) {
    const text = typeof value === 'string' ? value : (value?.text ?? '');
    if (!text.trim()) continue;
    const until = typeof value === 'object' ? value?.until : undefined;
    if (until && until < today) {
      result.expired.push(key);
      continue;
    }
    const dates = datesIn(text);
    const latest = dates[dates.length - 1];
    if (!until && latest && latest < cutoff) {
      result.stale.push({ key, latest });
      result.entries.push([
        key,
        `${text.trim()} [Every date in this note (latest ${latest}) has passed — treat it as history, not as current plans, and never count down to it.]`,
      ]);
      continue;
    }
    result.entries.push([key, text.trim()]);
  }
  return result;
}
