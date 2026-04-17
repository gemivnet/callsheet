import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, validate, extractPhraseFromBrief, recordBriefPhrase } from '../../src/connectors/language.js';
import { PASS, INFO } from '../../src/test-icons.js';
import type { Brief } from '../../src/types.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'callsheet-language-'));
}

describe('language connector', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  describe('create().fetch()', () => {
    it('returns empty past_phrases when no history file exists', async () => {
      const conn = create({ enabled: true, output_dir: outputDir });
      const result = await conn.fetch();
      expect(result.source).toBe('language');
      expect(result.priorityHint).toBe('low');
      expect(result.data.past_count).toBe(0);
      expect(result.data.past_phrases).toEqual([]);
    });

    it('loads past phrases from history and exposes them to the prompt', async () => {
      const historyPath = join(outputDir, 'language_history.json');
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(
        historyPath,
        JSON.stringify({
          entries: [
            { date: today, phrase: 'Buenos días', translation: 'Good morning' },
            { date: today, phrase: '¿Dónde está el café?', translation: 'Where is the coffee?' },
          ],
        }),
      );

      const conn = create({ enabled: true, output_dir: outputDir });
      const result = await conn.fetch();
      const past = result.data.past_phrases as { phrase: string }[];
      expect(past.length).toBe(2);
      expect(past.map((p) => p.phrase)).toContain('Buenos días');
    });

    it('prunes entries older than history_days', async () => {
      const historyPath = join(outputDir, 'language_history.json');
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(
        historyPath,
        JSON.stringify({
          entries: [
            { date: oldDate.toISOString().slice(0, 10), phrase: 'Viejo', translation: 'Old' },
            { date: today, phrase: 'Nuevo', translation: 'New' },
          ],
        }),
      );

      const conn = create({ enabled: true, output_dir: outputDir, history_days: 30 });
      const result = await conn.fetch();
      const past = result.data.past_phrases as { phrase: string }[];
      expect(past.map((p) => p.phrase)).toEqual(['Nuevo']);
    });

    it('respects custom target_language and label_prefix', async () => {
      const conn = create({
        enabled: true,
        output_dir: outputDir,
        target_language: 'French',
        label_prefix: 'Français',
        level: 'B1',
      });
      const result = await conn.fetch();
      expect(result.data.target_language).toBe('French');
      expect(result.data.label_prefix).toBe('Français');
      expect(result.data.level).toBe('B1');
      expect(result.description).toContain('French');
      expect(result.description).toContain('Français');
    });

    it('tells the brief writer to embed the phrase in Executive Brief, not a new section', async () => {
      const conn = create({ enabled: true, output_dir: outputDir });
      const result = await conn.fetch();
      expect(result.description).toMatch(/Executive Brief/i);
      expect(result.description).toMatch(/NOT as its own section/i);
    });

    it('includes anti-repeat guidance in the description', async () => {
      const conn = create({ enabled: true, output_dir: outputDir });
      const result = await conn.fetch();
      expect(result.description).toMatch(/MUST NOT repeat/i);
    });

    it('survives a corrupt history file', async () => {
      writeFileSync(join(outputDir, 'language_history.json'), 'not json {{{');
      const conn = create({ enabled: true, output_dir: outputDir });
      const result = await conn.fetch();
      expect(result.data.past_count).toBe(0);
    });
  });

  describe('validate', () => {
    it('reports target language and retention', () => {
      const checks = validate({
        enabled: true,
        output_dir: outputDir,
        target_language: 'French',
        history_days: 30,
      });
      expect(checks.some(([icon, msg]) => icon === PASS && msg.includes('French'))).toBe(true);
      expect(checks.some(([icon, msg]) => icon === INFO && msg.includes('30 days'))).toBe(true);
    });

    it('notes when history file does not yet exist', () => {
      const checks = validate({ enabled: true, output_dir: outputDir });
      expect(checks.some(([, msg]) => msg.includes('No history yet'))).toBe(true);
    });

    it('reports entry count when history exists', () => {
      writeFileSync(
        join(outputDir, 'language_history.json'),
        JSON.stringify({ entries: [{ date: '2026-04-15', phrase: 'x' }] }),
      );
      const checks = validate({ enabled: true, output_dir: outputDir });
      expect(checks.some(([, msg]) => msg.includes('1 entries'))).toBe(true);
    });

    it('warns when history file exists but is corrupt', () => {
      writeFileSync(join(outputDir, 'language_history.json'), 'not json {{{');
      const checks = validate({ enabled: true, output_dir: outputDir });
      expect(checks.some(([, msg]) => msg.includes('History file corrupt'))).toBe(true);
    });
  });

  describe('extractPhraseFromBrief', () => {
    function briefWith(label: string): Brief {
      return {
        title: 't',
        sections: [
          {
            heading: 'Executive Brief',
            items: [{ label: 'Something unrelated' }, { label }],
          },
        ],
      };
    }

    it('parses the standard straight-quote em-dash format', () => {
      const r = extractPhraseFromBrief(briefWith('Español: "Buenos días" — Good morning'), 'Español');
      expect(r).toEqual({ phrase: 'Buenos días', translation: 'Good morning' });
    });

    it('parses curly quotes', () => {
      const r = extractPhraseFromBrief(briefWith('Español: \u201CHola\u201D \u2014 Hi'), 'Español');
      expect(r).toEqual({ phrase: 'Hola', translation: 'Hi' });
    });

    it('parses with a plain hyphen separator', () => {
      const r = extractPhraseFromBrief(briefWith('Español: "Gracias" - Thank you'), 'Español');
      expect(r).toEqual({ phrase: 'Gracias', translation: 'Thank you' });
    });

    it('returns null when no matching item exists', () => {
      const r = extractPhraseFromBrief(briefWith('Not a language item at all'), 'Español');
      expect(r).toBeNull();
    });

    it('returns null on an empty brief', () => {
      const r = extractPhraseFromBrief({ title: 't', sections: [] }, 'Español');
      expect(r).toBeNull();
    });

    it('respects custom label prefix', () => {
      const r = extractPhraseFromBrief(briefWith('Français: "Bonjour" — Hello'), 'Français');
      expect(r).toEqual({ phrase: 'Bonjour', translation: 'Hello' });
    });
  });

  describe('recordBriefPhrase', () => {
    function makeBrief(label: string): Brief {
      return {
        title: 'Brief',
        sections: [{ heading: 'Executive Brief', items: [{ label }] }],
      };
    }

    it('appends today\'s phrase to the history file', () => {
      recordBriefPhrase(makeBrief('Español: "Buenas noches" — Good evening'), {
        output_dir: outputDir,
        connectors: { language: { enabled: true, label_prefix: 'Español' } },
      });

      const history = JSON.parse(readFileSync(join(outputDir, 'language_history.json'), 'utf-8'));
      expect(history.entries.length).toBe(1);
      expect(history.entries[0].phrase).toBe('Buenas noches');
      expect(history.entries[0].translation).toBe('Good evening');
      expect(history.entries[0].date).toBe(new Date().toISOString().slice(0, 10));
    });

    it('replaces an existing same-day entry instead of duplicating', () => {
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(
        join(outputDir, 'language_history.json'),
        JSON.stringify({ entries: [{ date: today, phrase: 'Old', translation: 'Old' }] }),
      );

      recordBriefPhrase(makeBrief('Español: "New" — New'), {
        output_dir: outputDir,
        connectors: { language: { enabled: true, label_prefix: 'Español' } },
      });

      const history = JSON.parse(readFileSync(join(outputDir, 'language_history.json'), 'utf-8'));
      expect(history.entries.length).toBe(1);
      expect(history.entries[0].phrase).toBe('New');
    });

    it('no-ops when language connector is disabled', () => {
      recordBriefPhrase(makeBrief('Español: "Bueno" — Good'), {
        output_dir: outputDir,
        connectors: { language: { enabled: false } },
      });
      expect(existsSync(join(outputDir, 'language_history.json'))).toBe(false);
    });

    it('no-ops when brief has no matching label', () => {
      recordBriefPhrase(makeBrief('Just a regular item'), {
        output_dir: outputDir,
        connectors: { language: { enabled: true, label_prefix: 'Español' } },
      });
      expect(existsSync(join(outputDir, 'language_history.json'))).toBe(false);
    });

    it('swallows and logs errors so the brief never breaks', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      // Point output_dir at an unwritable path so saveHistory() throws.
      recordBriefPhrase(makeBrief('Español: "Hola" — Hi'), {
        output_dir: '/proc/invalid/path/that/cannot/be/created',
        connectors: { language: { enabled: true, label_prefix: 'Español' } },
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to record language phrase'),
      );
      logSpy.mockRestore();
    });

    it('no-ops when language connector config is missing', () => {
      recordBriefPhrase(makeBrief('Español: "Hola" — Hi'), {
        output_dir: outputDir,
        connectors: {},
      });
      expect(existsSync(join(outputDir, 'language_history.json'))).toBe(false);
    });
  });
});
