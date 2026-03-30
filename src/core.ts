import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import yaml from 'js-yaml';
import type { CallsheetConfig, ConnectorResult, Brief, AutoCloseRecommendation } from './types.js';
import { loadConnectors } from './connectors/index.js';
import { renderPdf } from './render.js';
import { logUsage } from './usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// RuntimeErrors — global collector for any error conditions during a run.
// Connectors, process handlers, and pipeline code all push here.
// generateBrief drains these into the Claude prompt so they appear in the brief.
// ---------------------------------------------------------------------------

export interface RuntimeError {
  source: string;
  error: string;
  severity: 'warning' | 'error';
}

class RuntimeErrorCollector {
  private errors: RuntimeError[] = [];

  add(source: string, error: string, severity: 'warning' | 'error' = 'error'): void {
    this.errors.push({ source, error, severity });
  }

  /** Drain all collected errors (empties the list). */
  drain(): RuntimeError[] {
    return this.errors.splice(0);
  }

  get length(): number {
    return this.errors.length;
  }
}

export const runtimeErrors = new RuntimeErrorCollector();

export function loadConfig(configPath: string): CallsheetConfig {
  try {
    return yaml.load(readFileSync(configPath, 'utf-8')) as CallsheetConfig;
  } catch {
    throw new Error(
      `Config not found: ${configPath}. Copy config.example.yaml to config.yaml and edit it.`,
    );
  }
}

export interface ConnectorIssue {
  connector: string;
  error: string;
}

export async function fetchAll(
  config: CallsheetConfig,
): Promise<{ results: ConnectorResult[]; issues: ConnectorIssue[] }> {
  const { connectors, initErrors } = loadConnectors(config as Record<string, unknown>);
  const results: ConnectorResult[] = [];
  const issues: ConnectorIssue[] = [];

  // Surface init errors as connector issues
  for (const err of initErrors) {
    issues.push({ connector: err.connector, error: err.error });
  }

  for (const conn of connectors) {
    try {
      console.log(`  Fetching ${conn.name}...`);
      const result = await conn.fetch();
      results.push(result);
      console.log(`  \u2713 ${conn.name}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      issues.push({ connector: conn.name, error });
      console.log(`  \u2717 ${conn.name}: ${error}`);
    }
  }

  return { results, issues };
}

export function buildDataPayload(results: ConnectorResult[]): string {
  const sections = results.map((r) => ({
    source: r.source,
    description: r.description,
    priority: r.priorityHint,
    data: r.data,
  }));
  return JSON.stringify(sections, null, 2);
}

// ---------------------------------------------------------------------------
// Memory system — persists insights between daily briefs
// ---------------------------------------------------------------------------

const MEMORY_DIR = 'memory';
const MAX_MEMORY_DAYS = 7;

interface DailyMemory {
  date: string;
  insights: string[];
}

function getMemoryDir(outputDir: string): string {
  return join(outputDir, MEMORY_DIR);
}

function loadRecentMemories(outputDir: string): DailyMemory[] {
  const memDir = getMemoryDir(outputDir);
  if (!existsSync(memDir)) return [];

  const files = readdirSync(memDir)
    .filter((f) => f.startsWith('memory_') && f.endsWith('.json'))
    .sort()
    .slice(-MAX_MEMORY_DAYS);

  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(join(memDir, f), 'utf-8')) as DailyMemory;
    } catch {
      return { date: f, insights: [] };
    }
  });
}

function buildMemoryContext(memories: DailyMemory[]): string {
  if (!memories.length) return '';

  let ctx = '\n\n## Memory from previous briefs\n\n';
  ctx += 'You have access to notes from your previous briefs. Use these to:\n';
  ctx += '- Track ongoing situations (packages in transit, bills coming due, project progress)\n';
  ctx += '- Avoid repeating the same insight if nothing has changed\n';
  ctx += '- Notice trends or follow up on previous observations\n\n';
  ctx += "**CRITICAL — Memory is not truth. Today's live data always wins:**\n";
  ctx +=
    "- Memory is a hint, not a source of truth. EVERY claim from memory must be verified against today's live data.\n";
  ctx +=
    "- If a memorized issue has NO corresponding email, task, or transaction in today's data, treat it as RESOLVED or outdated — do NOT surface it.\n";
  ctx +=
    "- If a memorized task no longer appears in today's Todoist data, it was completed — do NOT surface it.\n";
  ctx +=
    '- If a memorized issue has a NEWER email showing resolution (approval, confirmation, payment received), treat it as RESOLVED.\n';
  ctx += "- Check the 'recently_completed' list in Todoist data — anything there is DONE.\n";
  ctx +=
    '- Check trashed/archived emails — if someone trashed a notification, they already handled it.\n';
  ctx += "- Do NOT let memory override clear resolution signals in today's data.\n";
  ctx +=
    "- The ABSENCE of data about a memorized item IS a resolution signal. If memory says 'KLM LOA rejected' but there are zero KLM emails in today's data, do NOT re-surface it.\n";
  ctx +=
    "- If a memory item has been repeated 3+ days with no change, it's stale — drop it entirely.\n\n";

  for (const mem of memories) {
    ctx += `### ${mem.date}\n`;
    for (const insight of mem.insights) {
      ctx += `- ${insight}\n`;
    }
    ctx += '\n';
  }

  return ctx;
}

async function generateMemoryInsights(
  client: Anthropic,
  model: string,
  dataPayload: string,
  outputDir: string,
): Promise<string[]> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system:
        "You extract key facts worth remembering for tomorrow's brief. " +
        'Return a JSON array of 3-8 short strings. Focus on: ' +
        'ongoing situations (deliveries, upcoming deadlines, bills due soon), ' +
        'notable patterns (spending spikes, inbox growth), ' +
        'things to follow up on tomorrow. ' +
        'CRITICAL: You are given ONLY the raw connector data (emails, tasks, calendar, etc.). ' +
        'Every insight you return MUST be directly traceable to a specific item in this data — ' +
        'a specific email, task, calendar event, or transaction. ' +
        'If you cannot point to the exact data source for a claim, do NOT include it. ' +
        'Do NOT infer or assume ongoing situations that are not evidenced in the data. ' +
        'Do NOT carry forward items from the brief that lack backing data — the brief may ' +
        'contain stale items from previous memory that are no longer relevant. ' +
        'Skip routine/static info. Be concise. Return ONLY the JSON array.',
      messages: [
        {
          role: 'user',
          content:
            "Here is today's raw connector data. Extract only facts that are " +
            'directly evidenced in this data:\n\n' +
            dataPayload,
        },
      ],
    });

    logUsage(outputDir, model, 'memory', response.usage.input_tokens, response.usage.output_tokens);

    let text = (response.content[0] as { type: 'text'; text: string }).text.trim();
    // Strip code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }
    return JSON.parse(text) as string[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Memory generation failed: ${msg}`);
    runtimeErrors.add('memory_generation', msg, 'warning');
    return [];
  }
}

export async function saveMemory(
  client: Anthropic,
  model: string,
  dataPayload: string,
  outputDir: string,
): Promise<void> {
  const memDir = getMemoryDir(outputDir);
  mkdirSync(memDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const insights = await generateMemoryInsights(client, model, dataPayload, outputDir);

  if (insights.length) {
    const memory: DailyMemory = { date: today, insights };
    writeFileSync(join(memDir, `memory_${today}.json`), JSON.stringify(memory, null, 2));
    console.log(`  Saved ${insights.length} memory insights for tomorrow.`);
  }

  // Prune old memories
  if (existsSync(memDir)) {
    const files = readdirSync(memDir)
      .filter((f) => f.startsWith('memory_') && f.endsWith('.json'))
      .sort();
    while (files.length > MAX_MEMORY_DAYS) {
      const old = files.shift()!;
      try {
        unlinkSync(join(memDir, old));
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Feedback loop — user notes + self-critique history that improve future briefs
// ---------------------------------------------------------------------------

const FEEDBACK_DIR = 'feedback';
const MAX_CRITIQUE_DAYS = 7;

interface CritiqueEntry {
  date: string;
  issues: string[];
}

function loadFeedbackNotes(): string {
  // User-written feedback file — lives in project root, not output dir
  const feedbackPath = join(process.cwd(), 'feedback.md');
  if (!existsSync(feedbackPath)) return '';

  const raw = readFileSync(feedbackPath, 'utf-8').trim();
  if (!raw) return '';

  return (
    '\n\n## User feedback\n\n' +
    'The user has left these notes about how to improve the brief. Follow them:\n\n' +
    raw +
    '\n'
  );
}

function loadRecentCritiques(outputDir: string): CritiqueEntry[] {
  const critiqueDir = join(outputDir, FEEDBACK_DIR);
  if (!existsSync(critiqueDir)) return [];

  const files = readdirSync(critiqueDir)
    .filter((f) => f.startsWith('critique_') && f.endsWith('.json'))
    .sort()
    .slice(-MAX_CRITIQUE_DAYS);

  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(join(critiqueDir, f), 'utf-8')) as CritiqueEntry;
    } catch {
      return { date: f, issues: [] };
    }
  });
}

function buildFeedbackContext(outputDir: string): string {
  let ctx = '';

  // User feedback notes
  ctx += loadFeedbackNotes();

  // Recent self-critique history
  const critiques = loadRecentCritiques(outputDir);
  const recentIssues = critiques
    .flatMap((c) => c.issues)
    .filter((issue, i, arr) => arr.indexOf(issue) === i); // deduplicate

  if (recentIssues.length) {
    ctx += '\n\n## Quality issues from recent briefs\n\n';
    ctx += 'Your previous briefs had these problems. Actively avoid repeating them:\n\n';
    for (const issue of recentIssues.slice(-10)) {
      ctx += `- ${issue}\n`;
    }
  }

  return ctx;
}

export async function critiqueBrief(
  client: Anthropic,
  brief: Brief,
  dataPayload: string,
  outputDir: string,
): Promise<string[]> {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', // Use Haiku for cheap self-review
      max_tokens: 512,
      system:
        'You are a quality reviewer for a daily household brief. ' +
        'Analyze the brief for structural issues. Return a JSON array of 0-5 short strings describing problems found. ' +
        'Check for:\n' +
        '- Duplication: same topic appearing in multiple sections (e.g. exec brief AND tasks)\n' +
        '- Poor grouping: tasks that jump between unrelated topics instead of clustering by theme\n' +
        "- Missing data: tasks, calendar events, or emails in the raw data that should have been surfaced but weren't\n" +
        "- Stale items: items from memory that don't appear in today's live data\n" +
        '- Verbosity: items that are too long or wordy for a printed brief\n' +
        'If the brief is good, return an empty array []. Return ONLY the JSON array.',
      messages: [
        {
          role: 'user',
          content:
            `Today's brief:\n${JSON.stringify(brief, null, 2)}\n\n` +
            `Raw data (key sources):\n${dataPayload.slice(0, 6000)}`,
        },
      ],
    });

    logUsage(
      outputDir,
      'claude-haiku-4-5-20251001',
      'critique',
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    let text = (response.content[0] as { type: 'text'; text: string }).text.trim();
    const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
    if (fenceMatch) text = fenceMatch[1].trim();

    const issues = JSON.parse(text) as string[];

    if (issues.length) {
      const critiqueDir = join(outputDir, FEEDBACK_DIR);
      mkdirSync(critiqueDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const entry: CritiqueEntry = { date: today, issues };
      writeFileSync(join(critiqueDir, `critique_${today}.json`), JSON.stringify(entry, null, 2));
    }

    return issues;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Self-critique failed: ${msg}`);
    runtimeErrors.add('self_critique', msg, 'warning');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Yesterday's brief — for diff context
// ---------------------------------------------------------------------------

function loadPreviousBrief(outputDir: string): { brief: Brief; label: string } | null {
  // Always diff against yesterday — reruns today should act like a fresh first run
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);
  const briefPath = join(outputDir, `callsheet_${dateStr}.json`);
  try {
    if (existsSync(briefPath)) {
      return {
        brief: JSON.parse(readFileSync(briefPath, 'utf-8')) as Brief,
        label: 'yesterday',
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractBriefSummary(brief: Brief): Record<string, string[]> {
  const summary: Record<string, string[]> = {};
  for (const section of brief.sections) {
    const items: string[] = [];
    if (section.items) {
      for (const item of section.items) {
        let line = item.label;
        if (item.note) line += ` (${item.note})`;
        if (item.urgent) line = `[URGENT] ${line}`;
        items.push(line);
      }
    }
    if (section.body) {
      items.push(section.body.slice(0, 200));
    }
    if (items.length) summary[section.heading] = items;
  }
  return summary;
}

function buildDiffContext(prev: { brief: Brief; label: string }): string {
  // Send a structured summary instead of full JSON to save tokens
  const summary = extractBriefSummary(prev.brief);
  let ctx = '\n\n<previous_brief>\n';
  ctx += `Summary of ${prev.label}'s brief. Use it to:\n`;
  ctx += "- Highlight what's NEW or CHANGED\n";
  ctx += '- Follow up on items still relevant\n';
  ctx += '- Avoid repeating identical insights\n';
  ctx += '- Note resolved items (tasks done, events passed)\n\n';
  for (const [heading, items] of Object.entries(summary)) {
    ctx += `${heading}:\n`;
    for (const item of items) {
      ctx += `  - ${item}\n`;
    }
  }
  ctx += '</previous_brief>\n';
  return ctx;
}

// ---------------------------------------------------------------------------
// Auto-close: optionally close Todoist tasks when data shows they're resolved
// ---------------------------------------------------------------------------

async function detectResolvableTasks(
  client: Anthropic,
  dataPayload: string,
  outputDir: string,
): Promise<AutoCloseRecommendation[]> {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:
        'You identify Todoist tasks that should be CLOSED because another data source proves they are resolved. ' +
        'Return a JSON array of objects with: task_id, task_content, person, reason. ' +
        'Be EXTREMELY conservative. Only recommend closing a task if there is CLEAR, UNAMBIGUOUS evidence: ' +
        "- An email confirmation that the exact action was completed (e.g. 'subscription cancelled', 'payment received', 'LOA approved') " +
        '- A transaction showing the bill was paid ' +
        "- A delivery confirmation for something that had a 'track package' task " +
        "Do NOT close tasks based on: assumptions, partial evidence, or if you're merely unsure whether it's done. " +
        'When in doubt, do NOT close. Return [] if nothing qualifies. Return ONLY the JSON array.',
      messages: [
        {
          role: 'user',
          content: `Here is today's connector data. Find Todoist tasks that are proven resolved by emails, transactions, or other sources:\n\n${dataPayload.slice(0, 8000)}`,
        },
      ],
    });

    logUsage(
      outputDir,
      'claude-haiku-4-5-20251001',
      'auto_close',
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    let text = (response.content[0] as { type: 'text'; text: string }).text.trim();
    const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
    if (fenceMatch) text = fenceMatch[1].trim();
    return JSON.parse(text) as AutoCloseRecommendation[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Warning: Auto-close detection failed: ${msg}`);
    runtimeErrors.add('auto_close', msg, 'warning');
    return [];
  }
}

async function closeTodoistTasks(
  recommendations: AutoCloseRecommendation[],
  config: CallsheetConfig,
): Promise<AutoCloseRecommendation[]> {
  const closed: AutoCloseRecommendation[] = [];
  const accounts = (config.connectors?.todoist?.accounts ?? []) as {
    name: string;
    token_env: string;
  }[];

  for (const rec of recommendations) {
    // Find the right token for this person
    const acct = accounts.find((a) => a.name.toLowerCase() === rec.person.toLowerCase());
    const token = acct ? (process.env[acct.token_env] ?? '') : '';
    if (!token) {
      console.log(`  Auto-close: skipping "${rec.task_content}" — no token for ${rec.person}`);
      continue;
    }

    try {
      const resp = await fetch(`https://api.todoist.com/api/v1/tasks/${rec.task_id}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        closed.push(rec);
        console.log(`  Auto-closed: "${rec.task_content}" (${rec.person}) — ${rec.reason}`);
      } else {
        console.log(`  Auto-close failed (${resp.status}): "${rec.task_content}"`);
      }
    } catch (e) {
      console.log(`  Auto-close error: "${rec.task_content}" — ${e}`);
    }
  }

  return closed;
}

function saveAutoCloseLog(closed: AutoCloseRecommendation[], outputDir: string): void {
  if (!closed.length) return;
  const logDir = join(outputDir, 'auto_close');
  mkdirSync(logDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(logDir, `closed_${today}.json`),
    JSON.stringify({ date: today, closed }, null, 2),
  );
}

function loadRecentAutoCloses(outputDir: string): AutoCloseRecommendation[] {
  const logDir = join(outputDir, 'auto_close');
  if (!existsSync(logDir)) return [];

  // Load yesterday's auto-closes to report in today's brief
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);
  const logPath = join(logDir, `closed_${dateStr}.json`);

  try {
    if (existsSync(logPath)) {
      const data = JSON.parse(readFileSync(logPath, 'utf-8'));
      return data.closed as AutoCloseRecommendation[];
    }
  } catch {
    /* ignore */
  }
  return [];
}

function buildAutoCloseContext(outputDir: string): string {
  const recent = loadRecentAutoCloses(outputDir);
  if (!recent.length) return '';

  let ctx = '\n\n## Auto-closed tasks\n\n';
  ctx +=
    'The following tasks were automatically closed yesterday because data confirmed they were resolved. ';
  ctx +=
    '**You MUST mention these in the Executive Brief** so the user knows what was auto-closed and can re-open if needed:\n\n';
  for (const r of recent) {
    ctx += `- ✅ "${r.task_content}" (${r.person}) — ${r.reason}\n`;
  }
  return ctx;
}

// ---------------------------------------------------------------------------

function buildConnectorIssuesContext(
  issues: ConnectorIssue[],
  errors: RuntimeError[] = [],
): string {
  if (!issues.length && !errors.length) return '';

  let ctx = '\n\n## Issues during this run\n\n';
  ctx +=
    'The following problems occurred. Mention them in the Executive Brief so the household ' +
    'knows what data may be missing or degraded:\n\n';

  for (const issue of issues) {
    ctx += `- **${issue.connector}** (connector): ${issue.error}\n`;
  }
  for (const err of errors) {
    ctx += `- **${err.source}** (${err.severity}): ${err.error}\n`;
  }

  return ctx;
}

function loadPrompt(config: CallsheetConfig): string {
  const promptPath = join(__dirname, 'prompts', 'system.md');
  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8');
  } catch {
    throw new Error(`System prompt not found: ${promptPath}`);
  }

  const context = config.context ?? {};
  if (Object.keys(context).length > 0) {
    prompt += '\n\n## Household context\n\n';
    prompt += 'Use this information to make smarter observations and connections:\n\n';
    for (const [key, value] of Object.entries(context)) {
      prompt += `- **${key}**: ${value}\n`;
    }
  }

  // Inject extras (fun recurring items)
  const extras = config.extras ?? [];
  if (extras.length > 0) {
    prompt += '\n\n## Extras\n\n';
    prompt += 'The user has configured these recurring items for the Executive Brief:\n\n';
    for (const extra of extras) {
      prompt += `### ${extra.name}\n${extra.instruction}\n\n`;
    }
  }

  // Load memory from previous briefs
  const outputDir = config.output_dir ?? 'output';
  const memories = loadRecentMemories(outputDir);
  prompt += buildMemoryContext(memories);

  // Load feedback loop context (user notes + self-critique history)
  prompt += buildFeedbackContext(outputDir);

  // Load auto-close notifications from yesterday
  prompt += buildAutoCloseContext(outputDir);

  return prompt;
}

// ---------------------------------------------------------------------------
// Retry helper with exponential backoff
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5_000; // 5s, 10s, 20s

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const { status } = e as { status?: number };
      const retryable = status === 429 || status === 529 || status === 500 || status === 503;
      if (!retryable || attempt === retries) break;

      const delay = BASE_DELAY_MS * 2 ** attempt;
      console.log(
        `  Attempt ${attempt + 1} failed (${status}), retrying ${label} in ${delay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Error brief — generated when the Claude API is completely unreachable
// ---------------------------------------------------------------------------

function buildErrorBrief(
  error: unknown,
  connectorIssues: ConnectorIssue[],
  errors: RuntimeError[] = [],
): Brief {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const errMsg = error instanceof Error ? error.message : String(error);
  const { status } = error as { status?: number };

  const sections: Brief['sections'] = [
    {
      heading: 'Generation Error',
      body:
        `Brief generation failed after ${MAX_RETRIES + 1} attempts. ` +
        (status ? `API returned status ${status}. ` : '') +
        `Error: ${errMsg}\n\n` +
        'Data was fetched successfully and cached — the brief will retry on the next run.',
    },
  ];

  // Surface all issues: connector errors + runtime errors
  const allIssueItems = [
    ...connectorIssues.map((issue) => ({
      label: issue.connector,
      note: issue.error,
      urgent: true,
    })),
    ...errors.map((err) => ({
      label: err.source,
      note: err.error,
      urgent: err.severity === 'error',
    })),
  ];

  if (allIssueItems.length) {
    sections.push({
      heading: 'Issues During This Run',
      items: allIssueItems,
    });
  }

  return {
    title: `Callsheet — ${dateStr}`,
    subtitle: '⚠ GENERATION FAILED',
    sections,
  };
}

export async function generateBrief(
  config: CallsheetConfig,
  dataPayload: string,
  connectorIssues: ConnectorIssue[] = [],
): Promise<Brief> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set.');
  }

  const client = new Anthropic({ apiKey });
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const drainedErrors = runtimeErrors.drain();
  const systemPrompt =
    loadPrompt(config) + buildConnectorIssuesContext(connectorIssues, drainedErrors);

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Load previous brief for diff context
  const outputDir = config.output_dir ?? 'output';
  const prevBrief = loadPreviousBrief(outputDir);
  const diffContext = prevBrief ? buildDiffContext(prevBrief) : '';

  let brief: Brief;

  try {
    const response = await withRetry(
      () =>
        client.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content:
                `Today is ${dateStr}.\n\n` +
                'Here is all available data from the connected sources:\n' +
                `<data>\n${dataPayload}\n</data>\n` +
                diffContext +
                '\n' +
                'Generate the morning brief JSON now. Return ONLY valid JSON matching the schema — no explanation, no code fences.',
            },
          ],
        }),
      'Claude API call',
    );

    logUsage(outputDir, model, 'brief', response.usage.input_tokens, response.usage.output_tokens);

    let { text } = response.content[0] as { type: 'text'; text: string };

    // Strip code fences if present
    if (text.startsWith('```')) {
      const lines = text.split('\n');
      if (lines[0].startsWith('```')) lines.shift();
      if (lines.at(-1)?.trim() === '```') lines.pop();
      text = lines.join('\n');
    }

    brief = JSON.parse(text) as Brief;
  } catch (e) {
    console.error(`  Brief generation failed: ${e}`);
    console.log('  Generating error brief with cached data...');
    return buildErrorBrief(e, connectorIssues, drainedErrors);
  }

  // Save memory for future briefs
  await saveMemory(client, model, dataPayload, outputDir);

  // Self-critique: review the brief for quality issues (uses Haiku, ~$0.001)
  const issues = await critiqueBrief(client, brief, dataPayload, outputDir);
  if (issues.length) {
    console.log(`  Self-critique: ${issues.length} issue(s) logged for future improvement.`);
  } else {
    console.log('  Self-critique: no issues found.');
  }

  // Auto-close: optionally close Todoist tasks proven resolved by other data sources
  if (config.auto_close_tasks) {
    console.log('  Checking for auto-closable tasks...');
    const recommendations = await detectResolvableTasks(client, dataPayload, outputDir);
    if (recommendations.length) {
      console.log(`  Found ${recommendations.length} task(s) to auto-close:`);
      const closed = await closeTodoistTasks(recommendations, config);
      saveAutoCloseLog(closed, outputDir);
      if (closed.length) {
        console.log(
          `  ✓ Auto-closed ${closed.length} task(s). Will be reported in tomorrow's brief.`,
        );
      }
    } else {
      console.log('  No tasks to auto-close.');
    }
  }

  return brief;
}

export function saveDataPayload(dataPayload: string, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const path = join(outputDir, `connector_data_${today}.json`);
  writeFileSync(path, dataPayload);
  return path;
}

export function saveBrief(brief: Brief, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const path = join(outputDir, `callsheet_${today}.json`);
  writeFileSync(path, JSON.stringify(brief, null, 2));
  return path;
}

export function printPdf(pdfPath: string, printer: string): void {
  execSync(`lp -d "${printer}" "${pdfPath}"`, { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Pipeline — reusable generation flow for CLI, scheduler, and web API
// ---------------------------------------------------------------------------

export interface PipelineResult {
  brief: Brief;
  jsonPath: string;
  pdfPath: string;
  dataPath: string;
}

export async function runPipeline(
  config: CallsheetConfig,
  options: { preview?: boolean } = {},
): Promise<PipelineResult> {
  // Fetch
  console.log('Fetching data...');
  const { results, issues: connectorIssues } = await fetchAll(config);

  if (results.length === 0) {
    throw new Error('No data fetched. Check your config and connector settings.');
  }

  if (connectorIssues.length) {
    console.log(`  ${connectorIssues.length} connector(s) had issues — will be noted in brief.`);
  }

  const dataPayload = buildDataPayload(results);

  // Save raw data
  const outputDir = config.output_dir ?? 'output';
  const dataPath = saveDataPayload(dataPayload, outputDir);
  console.log(`  Data: ${dataPath}`);

  // Generate
  console.log(`Generating brief via Claude (${config.model ?? 'claude-sonnet-4-20250514'})...`);
  let brief: Brief;
  try {
    brief = await generateBrief(config, dataPayload, connectorIssues);
  } catch (e) {
    // Safety net: if generateBrief throws despite its internal catch,
    // still produce an error brief rather than crashing the whole pipeline.
    console.error(`  Pipeline caught brief error: ${e}`);
    brief = buildErrorBrief(e, connectorIssues, runtimeErrors.drain());
  }

  const jsonPath = saveBrief(brief, outputDir);
  console.log(`  JSON: ${jsonPath}`);

  const pdfPath = await renderPdf(brief, outputDir);
  console.log(`  PDF:  ${pdfPath}`);

  // Print (unless preview mode)
  if (!options.preview) {
    const printer = config.printer ?? '';
    if (printer) {
      console.log(`Printing to ${printer}...`);
      printPdf(pdfPath, printer);
      console.log('Done.');
    } else {
      console.log("No printer configured. Set 'printer' in config.yaml to enable printing.");
    }
  }

  return { brief, jsonPath, pdfPath, dataPath };
}
