/**
 * Small helpers shared by every call to the model. Kept apart from core.ts so
 * modules core.ts depends on can use them without an import cycle.
 */

/**
 * Strip Markdown code fences from a string before JSON.parse.
 *
 * Claude sometimes wraps JSON output in ```json ... ``` even when told not to,
 * and sometimes emits commentary before or after the fenced block. Extracts
 * the first fenced region anywhere in the text; falls back to the trimmed
 * input when no fence is present.
 */
export function stripJsonCodeFences(text: string): string {
  const trimmed = text.trim();
  // Unanchored so trailing/leading commentary outside the fence is ignored.
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * Pull the text out of a Claude response.
 *
 * Indexing `content[0]` assumed the first block is always text, which stops
 * being true the moment a response leads with anything else, and said nothing
 * useful when a response came back truncated or declined. `stop_reason` is
 * checked here so those cases fail with a description of what happened rather
 * than a parse error further down.
 */
export function extractResponseText(response: {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
}): string {
  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer this request.');
  }

  const text = response.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');

  if (!text) {
    throw new Error(`No text in response (stop_reason: ${response.stop_reason ?? 'unknown'}).`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Response hit the output limit and is incomplete — raise max_tokens.');
  }

  return text;
}

/**
 * Normalise text for "does this quote really appear in the source" checks:
 * decode the HTML entities Gmail snippets carry, lower-case, and collapse
 * whitespace and typographic quotes so a faithful quote matches its source.
 */
export function normaliseForQuote(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
