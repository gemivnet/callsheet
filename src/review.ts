/**
 * Review: the checks that run on a finished brief before it is printed.
 *
 * The previous design had a small model critique the brief in free text, a
 * second model "repair" whatever the critique named, and the critique fed back
 * into the next morning's prompt as a list of recurring sins. Six months of
 * output said it made things worse: under half the critique's findings were
 * real, a large share concluded in their own words that the brief was correct,
 * and the repair pass applied them verbatim anyway — it moved a game to the
 * wrong night, turned a weekend span into a long weekend, deleted the language
 * line, and erased a warning that two appointments overlapped. The recurring
 * banner never changed the writer's behaviour.
 *
 * What replaces it:
 *  - Duplication, the one category the critique was usually right about, is
 *    removed deterministically, in code, from the Executive Brief.
 *  - The fact check must quote the brief and the data that contradicts it, and
 *    say what the brief should read instead. Both quotes are verified against
 *    the actual texts before anything is changed.
 *  - A verified correction is applied as an exact string replacement inside
 *    the one field that contains it. No second model rewrites the brief.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Brief, BriefItem } from './types.js';
import { logUsage } from './usage.js';
import { extractResponseText, normaliseForQuote } from './llm.js';

// ---------------------------------------------------------------------------
// Duplication — in code
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'the a an and or for to of in on at by with from into over this that these those ' +
    'is are was were be been it its as but not no yes do does done today tonight tomorrow ' +
    'am pm due now new your our their his her they them we you i me my per via vs'
  ).split(' '),
);

/** Content words of a line: lower-case, punctuation stripped, stopwords and short words out. */
export function contentWords(text: string): Set<string> {
  return new Set(
    normaliseForQuote(text)
      .replace(/[^a-z0-9$' ]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

const itemText = (item: BriefItem): string => `${item.label} ${item.note ?? ''}`;

/** True when `item` is the language phrase (or another protected line). */
function isProtected(item: BriefItem, protectedPrefixes: string[]): boolean {
  return protectedPrefixes.some((p) => item.label.trimStart().startsWith(p));
}

/** Share of an Executive Brief item's words that must reappear in one other item to count as a repeat. */
const DUPLICATE_OVERLAP = 0.6;

/**
 * Drop Executive Brief items that restate a single item from another section.
 *
 * The Executive Brief is for synthesis — a conflict, a consequence, a
 * deadline drawn from several sources. An item whose words are mostly one
 * task's or one email's words is that task or email again, taking the most
 * valuable space on the page. Protected items (the language line) are never
 * touched. Returns the new brief and the labels removed.
 */
export function dedupeExecutiveBrief(
  brief: Brief,
  protectedPrefixes: string[] = [],
): { brief: Brief; removed: string[] } {
  const exec = brief.sections.find((s) => /executive brief/i.test(s.heading));
  if (!exec?.items?.length) return { brief, removed: [] };

  const others = brief.sections
    .filter((s) => s !== exec)
    .flatMap((s) => s.items ?? [])
    .map((i) => contentWords(itemText(i)));

  const removed: string[] = [];
  const kept = exec.items.filter((item) => {
    if (isProtected(item, protectedPrefixes)) return true;
    const words = contentWords(itemText(item));
    if (words.size < 3) return true;
    const repeat = others.some((o) => {
      let shared = 0;
      for (const w of words) if (o.has(w)) shared++;
      return shared / words.size >= DUPLICATE_OVERLAP;
    });
    if (repeat) removed.push(item.label);
    return !repeat;
  });
  if (!removed.length) return { brief, removed };

  const sections = brief.sections.flatMap((s) => {
    if (s !== exec) return [s];
    return kept.length ? [{ ...s, items: kept }] : [];
  });
  return { brief: { ...brief, sections }, removed };
}

// ---------------------------------------------------------------------------
// Fact check — evidence-bound
// ---------------------------------------------------------------------------

export interface FactIssue {
  brief_quote: string;
  payload_quote: string;
  corrected_text: string;
  explanation: string;
}

const FACT_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          brief_quote: { type: 'string' },
          payload_quote: { type: 'string' },
          corrected_text: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['brief_quote', 'payload_quote', 'corrected_text', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'],
  additionalProperties: false,
} as const;

/** How much of the payload the checker sees. Sized to fit a whole day, not to save tokens. */
const FACT_CHECK_PAYLOAD_CHARS = 400_000;

/**
 * Ask a small model for statements the data contradicts. Returns its raw
 * findings; nothing here is trusted until verifyFactIssues has checked it.
 * Never throws.
 */
export async function factCheckBrief(
  client: Anthropic,
  model: string,
  brief: Brief,
  dataPayload: string,
  outputDir: string,
  options: { maxTokens?: number; warn?: (message: string) => void } = {},
): Promise<FactIssue[]> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 8_000,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: FACT_SCHEMA as unknown as Record<string, unknown> },
      },
      system:
        'You check a household morning brief against the raw data it was written from, looking only ' +
        'for statements the data CONTRADICTS: a wrong time, date, weekday, count, amount, name, person, ' +
        'priority or status. For each one give: brief_quote — the wrong words, copied exactly from the ' +
        'brief (keep it short, under 120 characters); payload_quote — the exact text from the raw data ' +
        "that shows it is wrong; corrected_text — what brief_quote should say instead, in the brief's " +
        'own style; explanation — one sentence. Do not report anything you can confirm is correct, ' +
        'anything merely missing, style, length, grouping or duplication, or the language-practice ' +
        'phrase. Two traps: Todoist priority 4 is the HIGHEST (p1 in the app) and 1 the lowest; an ' +
        "all-day calendar event's `end` date is exclusive, so it ends the day before. Search the whole " +
        'payload before reporting. An empty list is the normal answer for a good brief.',
      messages: [
        {
          role: 'user',
          content:
            `Brief:\n${JSON.stringify(brief, null, 2)}\n\n` +
            `Raw data:\n${dataPayload.slice(0, FACT_CHECK_PAYLOAD_CHARS)}`,
        },
      ],
    });
    logUsage(
      outputDir,
      model,
      'critique',
      response.usage.input_tokens,
      response.usage.output_tokens,
    );
    const parsed = JSON.parse(extractResponseText(response)) as { issues?: FactIssue[] };
    return Array.isArray(parsed.issues) ? parsed.issues : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Fact check failed: ${msg}`);
    options.warn?.(msg);
    return [];
  }
}

/** Every editable text field of the brief, with a setter, in reading order. */
function briefFields(
  brief: Brief,
): { get: () => string; set: (v: string) => void; item?: BriefItem }[] {
  const fields: { get: () => string; set: (v: string) => void; item?: BriefItem }[] = [];
  for (const section of brief.sections) {
    if (section.body !== undefined) {
      fields.push({ get: () => section.body ?? '', set: (v) => (section.body = v) });
    }
    for (const item of section.items ?? []) {
      fields.push({ get: () => item.label, set: (v) => (item.label = v), item });
      if (item.note !== undefined) {
        fields.push({ get: () => item.note ?? '', set: (v) => (item.note = v), item });
      }
      if (item.time !== undefined) {
        fields.push({ get: () => item.time ?? '', set: (v) => (item.time = v), item });
      }
    }
  }
  return fields;
}

/** The data as text a quote can be matched against — JSON escapes undone. */
function payloadText(dataPayload: string): string {
  return normaliseForQuote(dataPayload.replace(/\\"/g, '"').replace(/\\n/g, ' '));
}

/**
 * Keep the findings that hold up: the brief quote occurs exactly once in one
 * field, outside any protected item; the payload quote really is in the data;
 * and the correction is a real, proportionate change.
 */
export function verifyFactIssues(
  issues: FactIssue[],
  brief: Brief,
  dataPayload: string,
  protectedPrefixes: string[] = [],
): FactIssue[] {
  const fields = briefFields(brief);
  const data = payloadText(dataPayload);
  return issues.filter((issue) => {
    const quote = typeof issue.brief_quote === 'string' ? issue.brief_quote : '';
    const evidence = typeof issue.payload_quote === 'string' ? issue.payload_quote : '';
    const fix = typeof issue.corrected_text === 'string' ? issue.corrected_text : '';
    if (quote.trim().length < 3 || evidence.trim().length < 3 || !fix.trim()) return false;
    if (normaliseForQuote(fix) === normaliseForQuote(quote)) return false;
    if (fix.length > quote.length * 2 + 60) return false;
    if (!data.includes(normaliseForQuote(evidence))) return false;
    const hits = fields.filter((f) => f.get().includes(quote));
    if (hits.length !== 1) return false;
    const [hit] = hits;
    if (hit.get().split(quote).length !== 2) return false;
    return !(hit.item && isProtected(hit.item, protectedPrefixes));
  });
}

/**
 * Apply verified corrections as exact replacements, each in the one field
 * that contains its quote. Returns a new brief and the corrections applied.
 */
export function applyCorrections(
  brief: Brief,
  issues: FactIssue[],
): { brief: Brief; applied: FactIssue[] } {
  const copy = structuredClone(brief);
  const applied: FactIssue[] = [];
  for (const issue of issues) {
    const field = briefFields(copy).find((f) => f.get().includes(issue.brief_quote));
    if (!field) continue;
    field.set(field.get().replace(issue.brief_quote, issue.corrected_text));
    applied.push(issue);
  }
  return { brief: copy, applied };
}
