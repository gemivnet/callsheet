import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import yaml from "js-yaml";
import type { CallsheetConfig, ConnectorResult, Brief } from "./types.js";
import { loadConnectors } from "./connectors/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(configPath: string): CallsheetConfig {
  try {
    return yaml.load(readFileSync(configPath, "utf-8")) as CallsheetConfig;
  } catch {
    console.error(`ERROR: Config not found: ${configPath}`);
    console.error(
      "Copy config.example.yaml to config.yaml and edit it.",
    );
    process.exit(1);
  }
}

export async function fetchAll(
  config: CallsheetConfig,
): Promise<ConnectorResult[]> {
  const connectors = loadConnectors(config as Record<string, unknown>);
  const results: ConnectorResult[] = [];

  for (const conn of connectors) {
    try {
      console.log(`  Fetching ${conn.name}...`);
      const result = await conn.fetch();
      results.push(result);
      console.log(`  \u2713 ${conn.name}`);
    } catch (e) {
      console.log(`  \u2717 ${conn.name}: ${e}`);
    }
  }

  return results;
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

const MEMORY_DIR = "memory";
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
    .filter((f) => f.startsWith("memory_") && f.endsWith(".json"))
    .sort()
    .slice(-MAX_MEMORY_DAYS);

  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(join(memDir, f), "utf-8")) as DailyMemory;
    } catch {
      return { date: f, insights: [] };
    }
  });
}

function buildMemoryContext(memories: DailyMemory[]): string {
  if (!memories.length) return "";

  let ctx = "\n\n## Memory from previous briefs\n\n";
  ctx += "You have access to notes from your previous briefs. Use these to:\n";
  ctx += "- Track ongoing situations (packages in transit, bills coming due, project progress)\n";
  ctx += "- Avoid repeating the same insight if nothing has changed\n";
  ctx += "- Notice trends or follow up on previous observations\n\n";
  ctx += "**IMPORTANT:** If a memorized item (e.g. a task, reminder, or action item) no longer appears in today's fresh connector data, ";
  ctx += "treat it as RESOLVED and do NOT include it in the brief. ";
  ctx += "Memories are hints, not truth — today's live data always takes precedence. ";
  ctx += "Only surface a memorized item if it is corroborated by current data.\n\n";

  for (const mem of memories) {
    ctx += `### ${mem.date}\n`;
    for (const insight of mem.insights) {
      ctx += `- ${insight}\n`;
    }
    ctx += "\n";
  }

  return ctx;
}

async function generateMemoryInsights(
  client: Anthropic,
  model: string,
  brief: Brief,
  dataPayload: string,
): Promise<string[]> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system:
        "You extract key facts worth remembering for tomorrow's brief. " +
        "Return a JSON array of 3-8 short strings. Focus on: " +
        "ongoing situations (deliveries, upcoming deadlines, bills due soon), " +
        "notable patterns (spending spikes, inbox growth), " +
        "things to follow up on tomorrow. " +
        "IMPORTANT: Only memorize items that are backed by TODAY's live connector data. " +
        "Do NOT re-memorize tasks, reminders, or action items from previous memory notes " +
        "unless they still appear in today's raw data. If a task was in yesterday's memory " +
        "but is absent from today's task list, it was completed — do not carry it forward. " +
        "Skip routine/static info. Be concise. Return ONLY the JSON array.",
      messages: [
        {
          role: "user",
          content:
            `Today's brief:\n${JSON.stringify(brief, null, 2)}\n\n` +
            `Raw data summary (key sources):\n${dataPayload.slice(0, 4000)}`,
        },
      ],
    });

    let text = (response.content[0] as { type: "text"; text: string }).text.trim();
    // Strip code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }
    return JSON.parse(text) as string[];
  } catch (e) {
    console.log(`  Warning: Memory generation failed: ${e}`);
    return [];
  }
}

export async function saveMemory(
  client: Anthropic,
  model: string,
  brief: Brief,
  dataPayload: string,
  outputDir: string,
): Promise<void> {
  const memDir = getMemoryDir(outputDir);
  mkdirSync(memDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const insights = await generateMemoryInsights(client, model, brief, dataPayload);

  if (insights.length) {
    const memory: DailyMemory = { date: today, insights };
    writeFileSync(
      join(memDir, `memory_${today}.json`),
      JSON.stringify(memory, null, 2),
    );
    console.log(`  Saved ${insights.length} memory insights for tomorrow.`);
  }

  // Prune old memories
  if (existsSync(memDir)) {
    const files = readdirSync(memDir)
      .filter((f) => f.startsWith("memory_") && f.endsWith(".json"))
      .sort();
    while (files.length > MAX_MEMORY_DAYS) {
      const old = files.shift()!;
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(join(memDir, old));
      } catch { /* ignore */ }
    }
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
        brief: JSON.parse(readFileSync(briefPath, "utf-8")) as Brief,
        label: "yesterday",
      };
    }
  } catch { /* ignore */ }
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
  let ctx = "\n\n<previous_brief>\n";
  ctx += `Summary of ${prev.label}'s brief. Use it to:\n`;
  ctx += "- Highlight what's NEW or CHANGED\n";
  ctx += "- Follow up on items still relevant\n";
  ctx += "- Avoid repeating identical insights\n";
  ctx += "- Note resolved items (tasks done, events passed)\n\n";
  for (const [heading, items] of Object.entries(summary)) {
    ctx += `${heading}:\n`;
    for (const item of items) {
      ctx += `  - ${item}\n`;
    }
  }
  ctx += "</previous_brief>\n";
  return ctx;
}

// ---------------------------------------------------------------------------

function loadPrompt(config: CallsheetConfig): string {
  const promptPath = join(__dirname, "prompts", "system.md");
  let prompt: string;
  try {
    prompt = readFileSync(promptPath, "utf-8");
  } catch {
    console.error(`ERROR: System prompt not found: ${promptPath}`);
    process.exit(1);
  }

  const context = config.context ?? {};
  if (Object.keys(context).length > 0) {
    prompt += "\n\n## Household context\n\n";
    prompt +=
      "Use this information to make smarter observations and connections:\n\n";
    for (const [key, value] of Object.entries(context)) {
      prompt += `- **${key}**: ${value}\n`;
    }
  }

  // Inject extras (fun recurring items)
  const extras = config.extras ?? [];
  if (extras.length > 0) {
    prompt += "\n\n## Extras\n\n";
    prompt += "The user has configured these recurring items for the Executive Brief:\n\n";
    for (const extra of extras) {
      prompt += `### ${extra.name}\n${extra.instruction}\n\n`;
    }
  }

  // Load memory from previous briefs
  const outputDir = config.output_dir ?? "output";
  const memories = loadRecentMemories(outputDir);
  prompt += buildMemoryContext(memories);

  return prompt;
}

export async function generateBrief(
  config: CallsheetConfig,
  dataPayload: string,
): Promise<Brief> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY not set.");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const model = config.model ?? "claude-sonnet-4-20250514";
  const systemPrompt = loadPrompt(config);

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Load previous brief for diff context
  const outputDir = config.output_dir ?? "output";
  const prevBrief = loadPreviousBrief(outputDir);
  const diffContext = prevBrief ? buildDiffContext(prevBrief) : "";

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content:
          `Today is ${dateStr}.\n\n` +
          "Here is all available data from the connected sources:\n" +
          `<data>\n${dataPayload}\n</data>\n` +
          diffContext + "\n" +
          "Generate the morning brief JSON now. Return ONLY valid JSON matching the schema — no explanation, no code fences.",
      },
    ],
  });

  let text = (response.content[0] as { type: "text"; text: string }).text;

  // Strip code fences if present
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.at(-1)?.trim() === "```") lines.pop();
    text = lines.join("\n");
  }

  const brief = JSON.parse(text) as Brief;

  // Save memory for future briefs
  await saveMemory(client, model, brief, dataPayload, outputDir);

  return brief;
}

export function saveBrief(brief: Brief, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const path = join(outputDir, `callsheet_${today}.json`);
  writeFileSync(path, JSON.stringify(brief, null, 2));
  return path;
}

export function printPdf(pdfPath: string, printer: string): void {
  execSync(`lp -d "${printer}" "${pdfPath}"`, { stdio: "inherit" });
}
