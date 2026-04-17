import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface UsageEntry {
  timestamp: string;
  model: string;
  purpose: 'brief' | 'memory' | 'critique' | 'auto_close';
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface MonthlyUsage {
  month: string;
  entries: UsageEntry[];
}

/** Model pricing per million tokens (as of 2026) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

function getDefaultPricing(): { input: number; output: number } {
  return { input: 3, output: 15 }; // Default to Sonnet pricing
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? getDefaultPricing();
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function getUsageDir(outputDir: string): string {
  return join(outputDir, 'usage');
}

function getMonthlyFilePath(outputDir: string, month?: string): string {
  const m = month ?? new Date().toISOString().slice(0, 7); // YYYY-MM
  return join(getUsageDir(outputDir), `usage_${m}.json`);
}

/**
 * Log a single API call's usage. Appends to the monthly usage file.
 */
export function logUsage(
  outputDir: string,
  model: string,
  purpose: UsageEntry['purpose'],
  inputTokens: number,
  outputTokens: number,
): void {
  const usageDir = getUsageDir(outputDir);
  mkdirSync(usageDir, { recursive: true });

  const entry: UsageEntry = {
    timestamp: new Date().toISOString(),
    model,
    purpose,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: calculateCost(model, inputTokens, outputTokens),
  };

  const filePath = getMonthlyFilePath(outputDir);
  let monthly: MonthlyUsage;

  try {
    if (existsSync(filePath)) {
      monthly = JSON.parse(readFileSync(filePath, 'utf-8')) as MonthlyUsage;
    } else {
      monthly = { month: new Date().toISOString().slice(0, 7), entries: [] };
    }
  } catch {
    monthly = { month: new Date().toISOString().slice(0, 7), entries: [] };
  }

  monthly.entries.push(entry);
  writeFileSync(filePath, JSON.stringify(monthly, null, 2));
}

/**
 * Get usage data for a given month (defaults to current month).
 */
export function getMonthlyUsageData(outputDir: string, month?: string): MonthlyUsage {
  const filePath = getMonthlyFilePath(outputDir, month);
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as MonthlyUsage;
    }
  } catch {
    /* ignore */
  }
  return { month: month ?? new Date().toISOString().slice(0, 7), entries: [] };
}

/**
 * Get a summary of usage for a given month.
 */
export function getUsageSummary(outputDir: string, month?: string) {
  const data = getMonthlyUsageData(outputDir, month);
  const totalCost = data.entries.reduce((sum, e) => sum + e.cost_usd, 0);
  const totalInput = data.entries.reduce((sum, e) => sum + e.input_tokens, 0);
  const totalOutput = data.entries.reduce((sum, e) => sum + e.output_tokens, 0);
  const briefCount = data.entries.filter((e) => e.purpose === 'brief').length;

  const byModel: Record<string, { calls: number; cost: number }> = {};
  for (const entry of data.entries) {
    if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, cost: 0 };
    byModel[entry.model].calls++;
    byModel[entry.model].cost += entry.cost_usd;
  }

  return {
    month: data.month,
    total_cost_usd: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    brief_count: briefCount,
    total_api_calls: data.entries.length,
    by_model: byModel,
  };
}
