import { jest } from '@jest/globals';
import type Anthropic from '@anthropic-ai/sdk';
import { createMessage, normaliseForQuote, supportsServerFallback } from '../src/llm.js';

describe('normaliseForQuote', () => {
  it('decodes the entities Gmail snippets carry', () => {
    expect(normaliseForQuote('We&#39;ve &quot;got&quot; it &amp; more &lt;3 &gt;')).toBe(
      'we\'ve "got" it & more <3 >',
    );
  });

  it('folds typographic quotes, case and whitespace', () => {
    expect(normaliseForQuote('  It’s   “Done”\n now ')).toBe('it\'s "done" now');
  });
});

describe('createMessage', () => {
  const reply = { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } };
  const make = () => {
    const create = jest.fn(() => Promise.resolve(reply));
    const betaCreate = jest.fn(() => Promise.resolve(reply));
    const client = {
      messages: { create },
      beta: { messages: { create: betaCreate } },
    } as unknown as Anthropic;
    return { client, create, betaCreate };
  };
  const params = (model: string) => ({
    model,
    max_tokens: 100,
    messages: [{ role: 'user' as const, content: 'hi' }],
  });

  it('opts the housekeeping and brief models into the server-side refusal fallback', async () => {
    for (const model of ['claude-fable-5-1', 'claude-opus-5-5']) {
      const { client, create, betaCreate } = make();
      await expect(createMessage(client, params(model))).resolves.toBe(reply);
      expect(create).not.toHaveBeenCalled();
      expect(betaCreate).toHaveBeenCalledWith({
        ...params(model),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    }
  });

  it('sends a plain request to a model that would reject the fallback', async () => {
    const { client, create, betaCreate } = make();
    await createMessage(client, params('claude-haiku-5-5'));
    expect(betaCreate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(params('claude-haiku-5-5'));
    expect(supportsServerFallback('claude-haiku-5-5')).toBe(false);
  });
});
