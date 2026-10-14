import { jest } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStatus,
  recordRun,
  updateConnectorStreaks,
  scheduledRunExists,
  evaluateHealth,
  isScheduledTrigger,
  type RunRecord,
} from '../src/status.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callsheet-status-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  date: '2026-10-14',
  trigger: 'scheduled',
  startedAt: '2026-10-14T09:00:00.000Z',
  finishedAt: '2026-10-14T09:02:00.000Z',
  generated: true,
  print: 'printed',
  ...over,
});

describe('isScheduledTrigger', () => {
  it('counts scheduled and catch-up runs, not manual or dashboard ones', () => {
    expect(isScheduledTrigger('scheduled')).toBe(true);
    expect(isScheduledTrigger('catch-up')).toBe(true);
    expect(isScheduledTrigger('manual')).toBe(false);
    expect(isScheduledTrigger('dashboard')).toBe(false);
  });
});

describe('readStatus / recordRun', () => {
  it('reads an empty status when no file exists', () => {
    expect(readStatus(dir)).toEqual({});
  });

  it('reads an empty status from a corrupt file', () => {
    writeFileSync(join(dir, 'status.json'), '{not json');
    expect(readStatus(dir)).toEqual({});
  });

  it('reads an empty status from a file holding a non-object', () => {
    writeFileSync(join(dir, 'status.json'), 'null');
    expect(readStatus(dir)).toEqual({});
  });

  it('records a scheduled run as both last and lastScheduled', () => {
    recordRun(dir, run());
    const s = readStatus(dir);
    expect(s.last?.date).toBe('2026-10-14');
    expect(s.lastScheduled?.date).toBe('2026-10-14');
    expect(existsSync(join(dir, 'status.json.tmp'))).toBe(false);
  });

  it('keeps lastScheduled when a later manual run happens', () => {
    recordRun(dir, run());
    recordRun(dir, run({ trigger: 'dashboard', date: '2026-10-15', print: 'skipped' }));
    const s = readStatus(dir);
    expect(s.last?.trigger).toBe('dashboard');
    expect(s.lastScheduled?.date).toBe('2026-10-14');
  });

  it('creates the output directory when needed', () => {
    const nested = join(dir, 'a', 'b');
    recordRun(nested, run());
    expect(JSON.parse(readFileSync(join(nested, 'status.json'), 'utf-8')).last.date).toBe(
      '2026-10-14',
    );
  });

  it('never throws when the status cannot be written', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    chmodSync(dir, 0o500);
    try {
      expect(() => recordRun(dir, run())).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
      spy.mockRestore();
    }
  });
});

describe('scheduledRunExists', () => {
  it('is true only for the date the scheduler last ran', () => {
    const s = { lastScheduled: run() };
    expect(scheduledRunExists(s, '2026-10-14')).toBe(true);
    expect(scheduledRunExists(s, '2026-10-15')).toBe(false);
    expect(scheduledRunExists({}, '2026-10-14')).toBe(false);
  });
});

describe('evaluateHealth', () => {
  it('is ok after a printed scheduled run', () => {
    const r = evaluateHealth({ lastScheduled: run() }, '2026-10-14');
    expect(r.state).toBe('ok');
    expect(r.reasons).toEqual([]);
  });

  it('is overdue when the expected run has no record', () => {
    const r = evaluateHealth({ lastScheduled: run({ date: '2026-10-03' }) }, '2026-10-04');
    expect(r.state).toBe('overdue');
    expect(r.reasons[0]).toMatch(/2026-10-04.*last one was 2026-10-03/);
  });

  it('is overdue when nothing has ever run but a run is due', () => {
    const r = evaluateHealth({}, '2026-10-04');
    expect(r.state).toBe('overdue');
    expect(r.reasons[0]).not.toMatch(/last one/);
  });

  it('is not overdue when the last run is newer than the expected date', () => {
    const r = evaluateHealth({ lastScheduled: run({ date: '2026-10-15' }) }, '2026-10-14');
    expect(r.state).toBe('ok');
  });

  it('is unknown before any scheduled run when none is due yet', () => {
    expect(evaluateHealth({}, null).state).toBe('unknown');
  });

  it('fails when the brief could not be written', () => {
    const r = evaluateHealth(
      { lastScheduled: run({ generated: false, error: 'credit exhausted' }) },
      null,
    );
    expect(r.state).toBe('failed');
    expect(r.reasons).toEqual(['Brief generation failed on 2026-10-14', 'credit exhausted']);
  });

  it('fails when the brief was written but not printed', () => {
    const r = evaluateHealth({ lastScheduled: run({ print: 'failed' }) }, '2026-10-14');
    expect(r.state).toBe('failed');
    expect(r.reasons[0]).toMatch(/was not printed/);
  });

  it('is degraded when the print job was queued but not seen to finish', () => {
    const r = evaluateHealth({ lastScheduled: run({ print: 'queued' }) }, '2026-10-14');
    expect(r.state).toBe('degraded');
  });

  it('stays failed, not degraded, when both generation and print went wrong', () => {
    const r = evaluateHealth(
      { lastScheduled: run({ generated: false, print: 'queued' }) },
      '2026-10-14',
    );
    expect(r.state).toBe('failed');
  });

  it('treats a skipped print (preview deployment) as ok', () => {
    expect(evaluateHealth({ lastScheduled: run({ print: 'skipped' }) }, null).state).toBe('ok');
  });
});

describe('updateConnectorStreaks', () => {
  it('starts, extends and announces a streak once, and forgets recovered connectors', () => {
    expect(updateConnectorStreaks(dir, '2026-10-12', ['budget', 'budget'], '2026-10-11')).toEqual(
      {},
    );
    expect(readStatus(dir).connectorStreaks).toEqual({
      budget: { since: '2026-10-12', last: '2026-10-12', days: 1 },
    });

    const reached = updateConnectorStreaks(dir, '2026-10-13', ['budget', 'pireps'], '2026-10-12');
    expect(reached).toEqual({ budget: { since: '2026-10-12', last: '2026-10-13', days: 2 } });
    // A re-run the same day neither extends nor re-announces it.
    expect(updateConnectorStreaks(dir, '2026-10-13', ['budget', 'pireps'], '2026-10-12')).toEqual(
      {},
    );

    expect(updateConnectorStreaks(dir, '2026-10-14', ['budget'], '2026-10-13')).toEqual({});
    expect(readStatus(dir).connectorStreaks).toEqual({
      budget: { since: '2026-10-12', last: '2026-10-14', days: 3 },
    });
  });

  it('restarts a streak after a gap', () => {
    updateConnectorStreaks(dir, '2026-10-01', ['budget'], '2026-09-30');
    updateConnectorStreaks(dir, '2026-10-05', ['budget'], '2026-10-04');
    expect(readStatus(dir).connectorStreaks?.budget).toEqual({
      since: '2026-10-05',
      last: '2026-10-05',
      days: 1,
    });
  });

  it('never throws when the status cannot be written', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    chmodSync(dir, 0o500);
    try {
      expect(updateConnectorStreaks(dir, '2026-10-01', ['x'], '2026-09-30')).toEqual({});
    } finally {
      chmodSync(dir, 0o700);
      spy.mockRestore();
    }
  });
});
