import { normaliseForQuote } from '../src/llm.js';

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
