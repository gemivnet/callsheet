import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallsheetConfig } from '../src/types.js';

const mockLogUsage = jest.fn();
jest.unstable_mockModule('../src/usage.js', () => ({ logUsage: mockLogUsage }));

const living = await import('../src/living.js');

const TODAY = '2026-10-14';
const config: CallsheetConfig = {
  context: {
    work: 'Alex works at Example Corp, fully remote.',
    pets: { text: 'Two cats.' },
    blank: '  ',
  },
};
const payload = JSON.stringify([
  {
    source: 'gmail',
    data: {
      emails: [
        { subject: 'Your offer letter from Northwind', snippet: 'We are thrilled to welcome you' },
        { subject: 'Trip confirmed', snippet: 'Your flight on Dec 3 is confirmed' },
      ],
    },
  },
  { source: 'market', data: { note: 'secret market words' } },
]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callsheet-living-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const empty = () => ({ facts: [], retired: [], staleConfig: [] });

describe('settings, storage and active facts', () => {
  it('is off unless enabled, and keeps only usable vetoes', () => {
    expect(living.livingSettings({})).toEqual({ enabled: false, ignore: [] });
    expect(
      living.livingSettings({ living_context: { enabled: true, ignore: ['x', '', 3 as never] } }),
    ).toEqual({ enabled: true, ignore: ['x'] });
  });

  it('round-trips and reads a missing or corrupt file as empty', () => {
    expect(living.loadLiving(dir)).toEqual(empty());
    living.saveLiving(dir, {
      ...empty(),
      facts: [{ id: 'a', topic: 't', text: 'x', since: TODAY, until: TODAY, source: 's' }],
    });
    expect(living.loadLiving(dir).facts).toHaveLength(1);
    writeFileSync(join(dir, 'context', 'living.json'), '{bad');
    expect(living.loadLiving(dir)).toEqual(empty());
    writeFileSync(join(dir, 'context', 'living.json'), '{"facts":"no"}');
    expect(living.loadLiving(dir)).toEqual(empty());
  });

  it('serves unexpired, unvetoed facts, and lists them for the writer', () => {
    const ctx = {
      ...empty(),
      facts: [
        {
          id: '1',
          topic: 'work',
          text: 'Alex started at Northwind',
          since: TODAY,
          until: '2026-12-01',
          source: 's',
        },
        {
          id: '2',
          topic: 'trip',
          text: 'Trip to the coast',
          since: TODAY,
          until: '2026-10-01',
          source: 's',
        },
        {
          id: '3',
          topic: 'pets',
          text: 'Adopted a dog',
          since: TODAY,
          until: '2026-12-01',
          source: 's',
        },
      ],
    };
    const facts = living.activeFacts(ctx, TODAY, ['DOG']);
    expect(facts.map((f) => f.id)).toEqual(['1']);
    expect(living.buildLivingContext(facts)).toContain(
      '- **work** (since 2026-10-14): Alex started at Northwind',
    );
    expect(living.buildLivingContext([])).toBe('');
  });
});

describe('applyReview', () => {
  it('adds proven facts with an expiry, flags contradicted config, and drops unproven ones', () => {
    const { living: next, changes } = living.applyReview(
      {
        add: [
          {
            topic: 'work',
            text: 'Alex accepted an offer at Northwind.',
            evidence: 'Your offer letter from Northwind',
          },
          {
            topic: 'trip',
            text: 'Flying out Dec 3.',
            until: '2026-12-08',
            evidence: 'flight on Dec 3 is confirmed',
          },
          { topic: 'x', text: 'Invented fact', evidence: 'nowhere in the data at all' },
          {
            topic: '',
            text: 'Bad until',
            until: '2020-01-01',
            evidence: 'We are thrilled to welcome you',
          },
          {
            text: 'Alex accepted an offer at Northwind.',
            evidence: 'Your offer letter from Northwind',
          },
        ],
        stale_config: [
          { key: 'work', reason: 'New job', evidence: 'Your offer letter from Northwind' },
          { key: 'nope', reason: 'r', evidence: 'Your offer letter from Northwind' },
          { key: 'pets', reason: 'r', evidence: 'short' },
        ],
      },
      empty(),
      config,
      payload,
      TODAY,
    );
    expect(changes.added.map((f) => f.text)).toEqual([
      'Alex accepted an offer at Northwind.',
      'Flying out Dec 3.',
      'Bad until',
    ]);
    expect(changes.added[0]).toMatchObject({ until: '2026-12-13', since: TODAY, topic: 'work' });
    expect(changes.added[1].until).toBe('2026-12-08');
    expect(changes.added[2]).toMatchObject({ topic: 'household', until: '2026-12-13' });
    expect(changes.flagged).toEqual([
      {
        key: 'work',
        reason: 'New job',
        date: TODAY,
        text: 'Alex works at Example Corp, fully remote.',
      },
    ]);
    expect(next.facts).toHaveLength(3);

    // Flagging the same unchanged entry again is a no-op.
    const again = living.applyReview(
      {
        stale_config: [
          { key: 'work', reason: 'Still', evidence: 'Your offer letter from Northwind' },
        ],
      },
      next,
      config,
      payload,
      TODAY,
    );
    expect(again.changes.flagged).toEqual([]);
  });

  it('retires a learned fact only on proven evidence, and expires old ones', () => {
    const start = {
      ...empty(),
      facts: [
        {
          id: 'keep',
          topic: 't',
          text: 'Still true',
          since: '2026-09-01',
          until: '2026-12-01',
          source: 's',
        },
        {
          id: 'gone',
          topic: 't',
          text: 'Job at Example Corp',
          since: '2026-09-01',
          until: '2026-12-01',
          source: 's',
        },
        {
          id: 'old',
          topic: 't',
          text: 'Expired thing',
          since: '2026-08-01',
          until: '2026-10-01',
          source: 's',
        },
      ],
      retired: [
        {
          id: 'ancient',
          topic: 't',
          text: 'x',
          since: '2026-01-01',
          until: '2026-02-01',
          source: 's',
          retiredOn: '2026-02-01',
          reason: 'expired',
        },
      ],
    };
    const { living: next, changes } = living.applyReview(
      {
        retire: [
          { id: 'gone', reason: 'New job', evidence: 'Your offer letter from Northwind' },
          { id: 'keep', reason: 'unproven', evidence: 'not in data' },
          { id: 'missing', reason: 'x', evidence: 'Your offer letter from Northwind' },
        ],
      },
      start,
      config,
      payload,
      TODAY,
    );
    expect(changes.retired.map((f) => f.id)).toEqual(['gone']);
    expect(next.facts.map((f) => f.id)).toEqual(['keep']);
    expect(next.retired.map((f) => `${f.id}:${f.reason}`)).toEqual(['gone:New job', 'old:expired']);
  });

  it('caps the changes one run can make', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      topic: 't',
      text: `Fact number ${i}`,
      evidence: 'Your offer letter from Northwind',
    }));
    const { changes } = living.applyReview({ add: many }, empty(), config, payload, TODAY);
    expect(changes.added).toHaveLength(3);
  });

  it('treats an edited config entry as no longer flagged', () => {
    const flagged = {
      ...empty(),
      staleConfig: [{ key: 'work', reason: 'r', date: TODAY, text: 'old text' }],
    };
    expect(living.openConfigFlags(flagged, config)).toEqual([]);
    const current = {
      ...empty(),
      staleConfig: [
        {
          key: 'work',
          reason: 'r',
          date: TODAY,
          text: 'Alex works at Example Corp, fully remote.',
        },
      ],
    };
    expect(living.openConfigFlags(current, config)).toHaveLength(1);
    expect(living.openConfigFlags(current, {})).toEqual([]);
  });
});

describe('reviewLivingContext', () => {
  const create = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const client = { messages: { create } } as never;
  let logSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    create.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('asks with a schema, without the sources that say nothing about the household, and applies', async () => {
    create.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            add: [
              {
                topic: 'work',
                text: 'New job at Northwind',
                evidence: 'Your offer letter from Northwind',
              },
            ],
            retire: [],
            stale_config: [],
          }),
        },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const { changes } = await living.reviewLivingContext(
      client,
      'claude-haiku-5-5',
      config,
      empty(),
      payload,
      TODAY,
      dir,
    );

    expect(changes.added.map((f) => f.text)).toEqual(['New job at Northwind']);
    const params = create.mock.calls[0][0] as {
      messages: { content: string }[];
      output_config: { format: { type: string } };
    };
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.messages[0].content).toContain('Example Corp');
    expect(params.messages[0].content).not.toContain('secret market words');
    expect(mockLogUsage).toHaveBeenCalled();
  });

  it('changes nothing and warns when the call fails', async () => {
    create.mockRejectedValueOnce(new Error('overloaded')).mockRejectedValueOnce('bare');
    const warn = jest.fn();
    const start = empty();
    const r = await living.reviewLivingContext(client, 'm', config, start, payload, TODAY, dir, {
      warn,
    });
    expect(r.living).toBe(start);
    expect(r.changes).toEqual({ added: [], retired: [], flagged: [] });
    expect(warn).toHaveBeenCalledWith('overloaded');
    await living.reviewLivingContext(client, 'm', config, start, 'not json', TODAY, dir);
  });
});

describe('changeItems', () => {
  it('prints what was learned, retired and flagged', () => {
    const items = living.changeItems({
      added: [
        {
          id: '1',
          topic: 't',
          text: 'New job at Northwind',
          since: TODAY,
          until: '2026-12-13',
          source: 'offer letter',
        },
      ],
      retired: [
        {
          id: '2',
          topic: 't',
          text: 'Old job',
          since: TODAY,
          until: TODAY,
          source: 's',
          reason: 'changed jobs',
        },
      ],
      flagged: [{ key: 'work', reason: 'New job', date: TODAY, text: 't' }],
    });
    expect(items).toEqual([
      { label: 'Learned: New job at Northwind', note: 'from "offer letter" · until 2026-12-13' },
      { label: 'No longer true: Old job', note: 'changed jobs' },
      { label: 'Update the "work" context in config.yaml', note: 'New job', checkbox: true },
    ]);
  });
});

void mkdirSync;
