import { jest } from '@jest/globals';
import type { Brief } from '../src/types.js';

const mockLogUsage = jest.fn();
jest.unstable_mockModule('../src/usage.js', () => ({ logUsage: mockLogUsage }));

const review = await import('../src/review.js');

const brief = (): Brief => ({
  title: 'Wednesday',
  sections: [
    {
      heading: 'Executive Brief',
      items: [
        { label: 'Garbage pickup tomorrow — bins out tonight' },
        { label: 'Español: "¿Dónde está la estación?" — Where is the station?' },
        { label: 'Tight evening: meeting 6 PM after practice 4 PM' },
        { label: 'Short one' },
      ],
    },
    {
      heading: 'Tasks',
      items: [{ label: 'Put garbage bins out tonight — pickup tomorrow', checkbox: true }],
    },
    { heading: 'Schedule', items: [{ time: '4:00 PM', label: 'Practice', note: 'Field 2' }] },
    { heading: 'Week in Review', body: 'Three lessons flown this week.' },
  ],
});

describe('contentWords', () => {
  it('keeps the meaningful words only', () => {
    expect([...review.contentWords('Put the garbage bins out TONIGHT, for pickup!')]).toEqual([
      'put',
      'garbage',
      'bins',
      'out',
      'pickup',
    ]);
  });
});

describe('dedupeExecutiveBrief', () => {
  it('drops an Executive item that restates one task, and nothing else', () => {
    const { brief: out, removed } = review.dedupeExecutiveBrief(brief(), ['Español:']);
    expect(removed).toEqual(['Garbage pickup tomorrow — bins out tonight']);
    expect(out.sections[0].items?.map((i) => i.label)).toEqual([
      'Español: "¿Dónde está la estación?" — Where is the station?',
      'Tight evening: meeting 6 PM after practice 4 PM',
      'Short one',
    ]);
  });

  it('never removes a protected line, however much it overlaps', () => {
    const b = brief();
    b.sections[1].items!.push({ label: 'Español: dónde está la estación — where is the station' });
    const { removed } = review.dedupeExecutiveBrief(b, ['Español:']);
    expect(removed).not.toContain(b.sections[0].items![1].label);
  });

  it('drops the section when nothing is left', () => {
    const b: Brief = {
      title: 't',
      sections: [
        { heading: 'Executive Brief', items: [{ label: 'Renew passport application online' }] },
        { heading: 'Tasks', items: [{ label: 'Renew passport application online today' }] },
      ],
    };
    const { brief: out } = review.dedupeExecutiveBrief(b);
    expect(out.sections.map((s) => s.heading)).toEqual(['Tasks']);
  });

  it('leaves a brief without an Executive Brief, or without repeats, untouched', () => {
    const plain: Brief = { title: 't', sections: [{ heading: 'Tasks', items: [] }] };
    expect(review.dedupeExecutiveBrief(plain)).toEqual({ brief: plain, removed: [] });
    const b = brief();
    b.sections[1].items = [{ label: 'Something unrelated entirely here' }];
    const res = review.dedupeExecutiveBrief(b);
    expect(res.removed).toEqual([]);
    expect(res.brief).toBe(b);
  });
});

describe('verifyFactIssues', () => {
  const data = JSON.stringify([
    { source: 'calendar', data: { summary: 'Practice "B"', timeLabel: '4:30 PM' } },
  ]);
  const issue = (over: Partial<review.FactIssue> = {}): review.FactIssue => ({
    brief_quote: '4:00 PM',
    payload_quote: "timeLabel: '4:30 PM'",
    corrected_text: '4:30 PM',
    explanation: 'x',
    ...over,
  });

  it('accepts a finding whose quotes are both real', () => {
    const ok = issue({ payload_quote: '"timeLabel":"4:30 PM"' });
    expect(review.verifyFactIssues([ok], brief(), data)).toEqual([ok]);
  });

  it('matches data quotes through JSON escaping', () => {
    const ok = issue({
      brief_quote: 'Practice',
      corrected_text: 'Practice B',
      payload_quote: 'Practice "B"',
    });
    expect(review.verifyFactIssues([ok], brief(), data)).toHaveLength(1);
  });

  it('rejects quotes that are absent, ambiguous, trivial or protected', () => {
    const b = brief();
    const rejected = [
      issue({ payload_quote: 'not in the data' }),
      issue({ brief_quote: 'nowhere in the brief' }),
      issue({ brief_quote: 'PM' }),
      issue({ brief_quote: 'tonight', payload_quote: '4:30 PM' }),
      issue({ brief_quote: 'Dónde', payload_quote: '4:30 PM', corrected_text: 'Donde' }),
      issue({ corrected_text: '  ' }),
      issue({ corrected_text: '4:00 pm' }),
      issue({ corrected_text: 'x'.repeat(200) }),
      { brief_quote: 5, payload_quote: null, corrected_text: [] } as unknown as review.FactIssue,
    ];
    expect(review.verifyFactIssues(rejected, b, data, ['Español:'])).toEqual([]);
  });

  it('rejects a quote that appears twice in one field', () => {
    const b = brief();
    b.sections[2].items![0].note = 'from 4:30 PM to 4:30 PM';
    expect(
      review.verifyFactIssues(
        [issue({ brief_quote: '4:30 PM', payload_quote: '4:30 PM', corrected_text: '5 PM' })],
        b,
        data,
      ),
    ).toEqual([]);
  });
});

describe('applyCorrections', () => {
  it('replaces the quote in the one field holding it, in labels, notes, times and bodies', () => {
    const fixes = [
      { brief_quote: '4:00 PM', payload_quote: '', corrected_text: '4:30 PM', explanation: '' },
      { brief_quote: 'Field 2', payload_quote: '', corrected_text: 'Field 3', explanation: '' },
      {
        brief_quote: 'Three lessons',
        payload_quote: '',
        corrected_text: 'Two lessons',
        explanation: '',
      },
      { brief_quote: 'not there', payload_quote: '', corrected_text: 'x', explanation: '' },
    ];
    const original = brief();
    const { brief: out, applied } = review.applyCorrections(original, fixes);

    expect(applied).toHaveLength(3);
    expect(out.sections[2].items?.[0]).toMatchObject({ time: '4:30 PM', note: 'Field 3' });
    expect(out.sections[3].body).toBe('Two lessons flown this week.');
    // The input brief is not modified.
    expect(original.sections[2].items?.[0].time).toBe('4:00 PM');
  });
});

describe('factCheckBrief', () => {
  const create = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const client = { messages: { create } } as never;
  const reply = (obj: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    create.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('asks for evidence-bound findings with a schema and returns them', async () => {
    const issues = [
      { brief_quote: 'a', payload_quote: 'b', corrected_text: 'c', explanation: 'd' },
    ];
    create.mockResolvedValue(reply({ issues }));

    const out = await review.factCheckBrief(client, 'claude-haiku-5-5', brief(), '[]', '/o');

    expect(out).toEqual(issues);
    const params = create.mock.calls[0][0] as {
      output_config: { format: { type: string } };
      system: string;
    };
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.system).toContain('priority 4 is the HIGHEST');
    expect(mockLogUsage).toHaveBeenCalledWith('/o', 'claude-haiku-5-5', 'critique', 3, 2);
  });

  it('treats an answer without a list as no findings', async () => {
    create.mockResolvedValue(reply({}));
    expect(await review.factCheckBrief(client, 'm', brief(), '[]', '/o')).toEqual([]);
  });

  it('reports a failure through warn and finds nothing', async () => {
    create.mockRejectedValueOnce(new Error('overloaded')).mockRejectedValueOnce('bare');
    const warn = jest.fn();
    expect(await review.factCheckBrief(client, 'm', brief(), '[]', '/o', { warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith('overloaded');
    expect(await review.factCheckBrief(client, 'm', brief(), '[]', '/o')).toEqual([]);
  });
});
