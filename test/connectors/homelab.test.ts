import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { create, validate } = await import('../../src/connectors/homelab.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

/** Write a status document to a throwaway path and return it. */
async function doc(body: unknown, mtime?: Date): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'homelab-test-'));
  const path = join(dir, 'status.json');
  await writeFile(path, JSON.stringify(body), 'utf8');
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('homelab connector', () => {
  describe('validate', () => {
    it('fails when path is missing', () => {
      const checks = validate({ enabled: true });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('passes when path is set', () => {
      const checks = validate({ enabled: true, path: '/tmp/whatever.json' });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });
  });

  describe('fetch', () => {
    it('throws when path is not configured, rather than silently reporting nothing', async () => {
      await expect(create({ enabled: true }).fetch()).rejects.toThrow('`path` is not set');
    });

    it('passes the document through and reports it as current', async () => {
      const path = await doc({
        generated_at: hoursAgo(1),
        severity: 'INFO',
        summary: 'nothing to report',
      });
      const r = await create({ enabled: true, path }).fetch();
      expect(r.source).toBe('homelab');
      expect(r.data.summary).toBe('nothing to report');
      expect(r.data.stale).toBe(false);
      expect(r.description).toContain('which is current');
    });

    it('maps INFO to low, so a quiet night is mentioned only if noteworthy', async () => {
      const path = await doc({ generated_at: hoursAgo(1), severity: 'INFO' });
      expect((await create({ enabled: true, path }).fetch()).priorityHint).toBe('low');
    });

    it('maps WARN to normal', async () => {
      const path = await doc({ generated_at: hoursAgo(1), severity: 'WARN' });
      expect((await create({ enabled: true, path }).fetch()).priorityHint).toBe('normal');
    });

    it('maps CRIT to high', async () => {
      const path = await doc({ generated_at: hoursAgo(1), severity: 'CRIT' });
      expect((await create({ enabled: true, path }).fetch()).priorityHint).toBe('high');
    });

    it('treats a missing severity as INFO', async () => {
      const path = await doc({ generated_at: hoursAgo(1) });
      const r = await create({ enabled: true, path }).fetch();
      expect(r.priorityHint).toBe('low');
      expect(r.description).toContain('Severity is INFO');
    });

    it('accepts lowercase severity', async () => {
      const path = await doc({ generated_at: hoursAgo(1), severity: 'crit' });
      expect((await create({ enabled: true, path }).fetch()).priorityHint).toBe('high');
    });

    // The interesting failure: a job that stopped writing looks exactly like a quiet night.
    it('escalates a stale document to high and says the writing job probably stopped', async () => {
      const path = await doc({ generated_at: hoursAgo(72), severity: 'INFO' });
      const r = await create({ enabled: true, path }).fetch();
      expect(r.data.stale).toBe(true);
      expect(r.priorityHint).toBe('high');
      expect(r.description).toContain('has probably stopped running');
    });

    it('honours a custom stale_hours', async () => {
      const path = await doc({ generated_at: hoursAgo(5), severity: 'INFO' });
      expect((await create({ enabled: true, path, stale_hours: 2 }).fetch()).data.stale).toBe(true);
      expect((await create({ enabled: true, path, stale_hours: 99 }).fetch()).data.stale).toBe(
        false,
      );
    });

    it('falls back to file mtime when generated_at is absent', async () => {
      const path = await doc({ severity: 'INFO' }, new Date(Date.now() - 80 * 3_600_000));
      const r = await create({ enabled: true, path }).fetch();
      expect(r.data.stale).toBe(true);
      expect(Number(r.data.age_hours)).toBeGreaterThan(70);
    });

    it('uses the configured label in the description', async () => {
      const path = await doc({ generated_at: hoursAgo(1), severity: 'INFO' });
      const r = await create({ enabled: true, path, label: 'greenhouse' }).fetch();
      expect(r.description).toContain('greenhouse');
    });

    it('instructs Claude never to reproduce credentials or addresses', async () => {
      const path = await doc({ generated_at: hoursAgo(1), severity: 'INFO' });
      const r = await create({ enabled: true, path }).fetch();
      expect(r.description).toContain('Never reproduce credentials');
    });

    it('rejects a document that is not valid JSON', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'homelab-bad-'));
      const path = join(dir, 'status.json');
      await writeFile(path, 'not json{', 'utf8');
      await expect(create({ enabled: true, path }).fetch()).rejects.toThrow();
    });
  });
});
