import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockLogUsage = jest.fn();
jest.unstable_mockModule('../src/usage.js', () => ({ logUsage: mockLogUsage }));

const ac = await import('../src/autoclose.js');
const { todayYmd, shiftYmd } = await import('../src/dates.js');

/** A payload with two people, a shared task, a recurring task, email and a transaction. */
function payload(): string {
  return JSON.stringify([
    { source: 'weather', data: { forecast: 'sunny' } },
    {
      source: 'todoist',
      data: {
        accounts: [
          {
            person: 'Alex',
            today: [
              {
                id: 't1',
                content: 'Pay the water bill',
                dueDate: '2026-10-10',
                isRecurring: false,
              },
              { id: 't2', content: 'Change furnace filter', isRecurring: true },
            ],
            inbox: [{ id: 't3', content: 'Return the library books', project: 'Inbox' }],
            backlog: [{ id: 'shared', content: 'Book the plumber' }],
          },
          { person: 'Sam', backlog: [{ id: 'shared', content: 'Book the plumber' }] },
        ],
      },
    },
    {
      source: 'gmail',
      data: {
        accounts: [
          {
            person: 'Alex',
            emails: [
              {
                from: 'City Water <billing@example.com>',
                subject: 'Payment confirmation',
                snippet: 'We&#39;ve received your payment of $61.20. Thank you!',
                date: 'Mon, 12 Oct 2026 10:00:00 -0500',
              },
              { from: 'Library', subject: 'Your items are due Friday' },
            ],
          },
        ],
      },
    },
    {
      source: 'actual_budget',
      data: { recentTransactions: [{ date: '2026-10-11', payee: 'Plumbing Co', amount: -150 }] },
    },
  ]);
}

describe('collectAutoCloseInput', () => {
  it('gathers open tasks once each and the emails and transactions that could prove them', () => {
    const input = ac.collectAutoCloseInput(payload());

    expect(input.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 'shared']);
    expect(input.tasks.find((t) => t.id === 't2')?.recurring).toBe(true);
    expect(input.tasks.find((t) => t.id === 't1')).toMatchObject({
      person: 'Alex',
      due: '2026-10-10',
    });
    expect(input.evidence.map((e) => e.id)).toEqual(['e1', 'e2', 't3']);
    expect(input.evidence[0].text).toContain('Payment confirmation');
    expect(input.evidence[2]).toMatchObject({ kind: 'transaction' });
    expect(input.evidence[2].text).toContain('Plumbing Co');
  });

  it('returns empty lists for a payload it cannot read', () => {
    expect(ac.collectAutoCloseInput('not json')).toEqual({ tasks: [], evidence: [] });
    expect(ac.collectAutoCloseInput('{"todoist":"data"}')).toEqual({ tasks: [], evidence: [] });
  });

  it('skips malformed tasks, emails and transactions', () => {
    const input = ac.collectAutoCloseInput(
      JSON.stringify([
        { source: 'todoist', data: { accounts: [{ today: [{ content: 'no id' }, { id: 7 }] }] } },
        { source: 'gmail', data: { accounts: [{ emails: [{ labels: [] }] }] } },
        { source: 'actual_budget', data: { recentTransactions: [{ cleared: true }] } },
      ]),
    );
    expect(input).toEqual({ tasks: [], evidence: [] });
  });
});

describe('verifyClosures', () => {
  const input = ac.collectAutoCloseInput(payload());

  it('keeps a closure whose quote really appears in the cited evidence', () => {
    const out = ac.verifyClosures(
      [
        {
          task_id: 't1',
          evidence_id: 'e1',
          // Entities and curly quotes in the source still match a faithful quote.
          evidence_quote: 'We’ve received your payment of $61.20',
          reason: 'Paid',
        },
      ],
      input,
    );
    expect(out).toEqual([
      {
        task_id: 't1',
        task_content: 'Pay the water bill',
        person: 'Alex',
        reason: 'Paid',
        evidence: 'We’ve received your payment of $61.20',
      },
    ]);
  });

  it('drops a quote that is not in the evidence', () => {
    expect(
      ac.verifyClosures(
        [{ task_id: 't1', evidence_id: 'e1', evidence_quote: 'bill paid in full', reason: 'x' }],
        input,
      ),
    ).toEqual([]);
  });

  it('drops a quote that is in a different evidence item than the one cited', () => {
    expect(
      ac.verifyClosures(
        [{ task_id: 't3', evidence_id: 'e1', evidence_quote: 'items are due Friday', reason: 'x' }],
        input,
      ),
    ).toEqual([]);
  });

  it('drops recurring tasks, unknown tasks, unknown evidence and trivial quotes', () => {
    expect(
      ac.verifyClosures(
        [
          { task_id: 't2', evidence_id: 'e1', evidence_quote: 'received your payment' },
          { task_id: 'nope', evidence_id: 'e1', evidence_quote: 'received your payment' },
          { task_id: 't1', evidence_id: 'e99', evidence_quote: 'received your payment' },
          { task_id: 't1', evidence_id: 'e1', evidence_quote: 'payment' },
          { task_id: 't1', evidence_id: 'e1', evidence_quote: 42 },
        ],
        input,
      ),
    ).toEqual([]);
  });

  it('closes a task once and never more than three per run', () => {
    const many = ac.collectAutoCloseInput(
      JSON.stringify([
        {
          source: 'todoist',
          data: {
            accounts: [
              {
                person: 'Alex',
                today: ['a', 'b', 'c', 'd'].map((id) => ({ id, content: `Task ${id}` })),
              },
            ],
          },
        },
        {
          source: 'gmail',
          data: { accounts: [{ emails: [{ subject: 'All four tasks are complete now' }] }] },
        },
      ]),
    );
    const quote = { evidence_id: 'e1', evidence_quote: 'tasks are complete now', reason: 'r' };
    const out = ac.verifyClosures(
      [
        { task_id: 'a', ...quote },
        { task_id: 'a', ...quote },
        { task_id: 'b', ...quote },
        { task_id: 'c', ...quote },
        { task_id: 'd', ...quote },
      ],
      many,
    );
    expect(out.map((r) => r.task_id)).toEqual(['a', 'b', 'c']);
  });

  it('defaults a missing reason', () => {
    const [r] = ac.verifyClosures(
      [{ task_id: 't1', evidence_id: 'e1', evidence_quote: 'your payment of $61.20' }],
      input,
    );
    expect(r.reason).toBe('resolved');
  });
});

describe('detectResolvableTasks', () => {
  const create = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const client = { messages: { create } } as never;
  const reply = (obj: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    create.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('asks with a schema and returns only verified closures', async () => {
    create.mockResolvedValue(
      reply({
        closures: [
          {
            task_id: 't1',
            evidence_id: 'e1',
            evidence_quote: 'your payment of $61.20',
            reason: 'r',
          },
          { task_id: 't3', evidence_id: 'e2', evidence_quote: 'books were returned', reason: 'r' },
        ],
      }),
    );

    const out = await ac.detectResolvableTasks(client, 'claude-haiku-5-5', payload(), '/tmp/out');

    expect(out.map((r) => r.task_id)).toEqual(['t1']);
    const params = create.mock.calls[0][0] as {
      output_config: { format: { type: string } };
      messages: { content: string }[];
    };
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.messages[0].content).toContain('Return the library books');
    expect(mockLogUsage).toHaveBeenCalledWith('/tmp/out', 'claude-haiku-5-5', 'auto_close', 10, 5);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dropped 1 unverified'));
  });

  it('does not call the model when there is nothing to check', async () => {
    expect(await ac.detectResolvableTasks(client, 'm', '[]', '/tmp/out')).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('treats a reply without a closures list as none', async () => {
    create.mockResolvedValue(reply({}));
    expect(await ac.detectResolvableTasks(client, 'm', payload(), '/tmp/out')).toEqual([]);
  });

  it('reports a failed call through warn and closes nothing', async () => {
    create.mockRejectedValue(new Error('overloaded'));
    const warn = jest.fn();
    expect(await ac.detectResolvableTasks(client, 'm', payload(), '/tmp/out', warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('overloaded');
  });

  it('reports a non-Error failure too', async () => {
    create.mockRejectedValue('bad');
    expect(await ac.detectResolvableTasks(client, 'm', payload(), '/tmp/out')).toEqual([]);
  });
});

describe('closeTodoistTasks', () => {
  const rec = { task_id: 't1', task_content: 'Pay', person: 'Alex', reason: 'paid' };
  const config = {
    connectors: { todoist: { accounts: [{ name: 'Alex', token_env: 'TEST_TODOIST_ALEX' }] } },
  };
  const originalFetch = globalThis.fetch;
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.TEST_TODOIST_ALEX = 'tok';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.TEST_TODOIST_ALEX;
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
  });

  it("closes through the person's token and reports what closed", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await ac.closeTodoistTasks([rec], config)).toEqual([rec]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.todoist.com/api/v1/tasks/t1/close',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer tok' } }),
    );
  });

  it('skips a person with no token, and survives API errors', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await ac.closeTodoistTasks(
      [{ ...rec, person: 'Nobody' }, rec, { ...rec, task_id: 't9' }],
      config,
    );

    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('copes with no Todoist config at all', async () => {
    expect(await ac.closeTodoistTasks([rec], {})).toEqual([]);
  });
});

describe('auto-close log and prompt context', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'callsheet-ac-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves nothing when nothing closed', () => {
    ac.saveAutoCloseLog([], dir);
    expect(existsSync(join(dir, 'auto_close'))).toBe(false);
  });

  it("saves today's closures and reports yesterday's to the writer", () => {
    const rec = { task_id: 't1', task_content: 'Pay the bill', person: 'Alex', reason: 'paid' };
    ac.saveAutoCloseLog([rec], dir);
    const saved = JSON.parse(
      readFileSync(join(dir, 'auto_close', `closed_${todayYmd()}.json`), 'utf-8'),
    ) as { closed: unknown[] };
    expect(saved.closed).toEqual([rec]);

    expect(ac.buildAutoCloseContext(dir)).toBe('');
    writeFileSync(
      join(dir, 'auto_close', `closed_${shiftYmd(todayYmd(), -1)}.json`),
      JSON.stringify({ closed: [rec] }),
    );
    expect(ac.buildAutoCloseContext(dir)).toContain('"Pay the bill" (Alex) — paid');
  });

  it('ignores a missing directory, a corrupt log and a log without closures', () => {
    expect(ac.buildAutoCloseContext(join(dir, 'missing'))).toBe('');
    mkdirSync(join(dir, 'auto_close'));
    const y = join(dir, 'auto_close', `closed_${shiftYmd(todayYmd(), -1)}.json`);
    writeFileSync(y, '{oops');
    expect(ac.buildAutoCloseContext(dir)).toBe('');
    writeFileSync(y, '{}');
    expect(ac.buildAutoCloseContext(dir)).toBe('');
  });
});
