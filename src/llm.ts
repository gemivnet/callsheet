/**
 * Small helpers shared by every call to the model. Kept apart from core.ts so
 * modules core.ts depends on can use them without an import cycle.
 */

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Models that accept the server-side refusal fallback. On these, a request a
 * safety classifier declines is re-run on Anthropic's recommended fallback
 * model inside the same call instead of coming back empty — a household brief
 * full of medical and financial detail is exactly the kind of payload a
 * classifier can occasionally trip on, and the housekeeping passes read the
 * same data.
 */
const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
]);

/** True when `model` accepts `fallbacks: "default"`. */
export function supportsServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODELS.has(model);
}

/** The parts of a Messages API response the pipeline reads, from either endpoint. */
export interface ModelResponse {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Send one request, opting into the server-side refusal fallback when the
 * model takes it. The fallback is a beta parameter, so those models go through
 * the beta endpoint; the response carries the same content, stop_reason and
 * usage either way.
 */
export function createMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<ModelResponse> {
  return supportsServerFallback(params.model)
    ? client.beta.messages.create({
        ...(params as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
    : client.messages.create(params);
}

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
