import { readFile, stat } from 'node:fs/promises';

import { FAIL, PASS } from '../test-icons.js';
import type { Check, Connector, ConnectorConfig, ConnectorResult } from '../types.js';

/**
 * Reads a status document written by an external monitoring job.
 *
 * Deliberately generic: it reads whatever JSON lives at `path` and hands it to Claude with
 * an instruction about how to treat it. No host names, no service names, no network detail
 * live in this file — all of that belongs in the private config and in the document itself.
 *
 * The contract is loose on purpose. The producer is free to change its own shape; the only
 * fields this connector interprets are `severity` (to decide priority) and `generated_at`
 * (to notice a stale document). Everything else is passed through for Claude to read.
 */

interface StatusDoc {
  severity?: string;
  action_taken?: boolean;
  generated_at?: string;
  [key: string]: unknown;
}

const DEFAULT_STALE_HOURS = 26;

/** Config values arrive as `unknown`; narrow rather than String()-ing an object into '[object Object]'. */
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback;
}

/**
 * A quiet night should cost the brief nothing, so INFO maps to "low" — Claude mentions it
 * only if something in the document is noteworthy. A stale document outranks its own
 * severity, because a job that stopped writing looks exactly like a clean night.
 */
function priorityFor(severity: string, stale: boolean): ConnectorResult['priorityHint'] {
  if (stale || severity === 'CRIT') return 'high';
  if (severity === 'WARN') return 'normal';
  return 'low';
}

export function create(config: ConnectorConfig): Connector {
  const path = str(config.path, '');
  const label = str(config.label, 'infrastructure');
  const staleHours = Number(config.stale_hours ?? DEFAULT_STALE_HOURS);

  return {
    name: 'homelab',
    description: `${label} status from the overnight maintenance job`,

    async fetch(): Promise<ConnectorResult> {
      if (!path) throw new Error('homelab connector: `path` is not set in config');

      const raw = await readFile(path, 'utf8');
      const doc = JSON.parse(raw) as StatusDoc;

      // Age matters more than content. A document that stopped being written is the
      // interesting case — it means the job that writes it stopped running, and silence
      // is indistinguishable from a clean night unless someone checks the timestamp.
      const { mtime } = await stat(path);
      const stamp = doc.generated_at ? new Date(doc.generated_at) : mtime;
      const ageHours = (Date.now() - stamp.getTime()) / 3_600_000;
      const stale = ageHours > staleHours;

      const severity = str(doc.severity, 'INFO').toUpperCase();
      const priorityHint = priorityFor(severity, stale);

      return {
        source: 'homelab',
        description: [
          `Overnight ${label} maintenance report, written before this brief was generated.`,
          stale
            ? `IMPORTANT: this document is ${ageHours.toFixed(0)} hours old, which means the job that writes it has probably stopped running. Say so plainly near the top of the brief — a monitoring job that silently stops looks exactly like a quiet night.`
            : `It is ${ageHours.toFixed(1)} hours old, which is current.`,
          `Severity is ${severity}.`,
          'If severity is INFO and nothing in the document needs a decision, omit this entirely — do not pad the brief with "all systems normal".',
          doc.action_taken
            ? 'Work was carried out overnight. Say what was done in at least one line — the reader\u2019s standing request is to be told what was handled on their behalf, so silence here reads as nothing having happened. The mechanism does not matter; the outcome does.'
            : 'Nothing was changed overnight, so do not imply that it was.',
          'If something needs a person to act, lead with what and why, and keep it to the decision rather than the diagnosis.',
          'Never reproduce credentials, tokens, file paths or network addresses from this document into the brief.',
        ].join(' '),
        data: { stale, age_hours: Number(ageHours.toFixed(1)), ...doc },
        priorityHint,
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const path = String(config.path ?? '');
  checks.push(
    path
      ? [PASS, `Reading status from ${path}`, '']
      : [FAIL, 'path not configured', 'Set `path` in the homelab config block'],
  );
  return checks;
}
