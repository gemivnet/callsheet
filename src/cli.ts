#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import { loadConfig, fetchAll, buildDataPayload, critiqueBrief, runPipeline } from './core.js';
import { getRegistry } from './connectors/index.js';

program
  .name('callsheet')
  .description('AI-generated daily printed briefs')
  .option('--config <path>', 'Config file path', 'config.yaml')
  .option('--preview', 'Generate PDF without printing')
  .option('--auth <connector>', 'Run OAuth setup for a connector')
  .option('--show-data', 'Dump raw data and exit')
  .option('--list-connectors', 'List available connectors')
  .option('--test [connectors...]', 'Test connectors')
  .option('--review [date]', 'Review a brief for quality issues (default: today)');

program.parse();

const opts = program.opts<{
  config: string;
  preview?: boolean;
  auth?: string;
  showData?: boolean;
  listConnectors?: boolean;
  test?: string[] | true;
  review?: string | true;
}>();

async function main() {
  // --- List connectors ---
  if (opts.listConnectors) {
    const registry = getRegistry();
    console.log('Available connectors:\n');
    for (const [name] of [...registry].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${name}`);
    }
    return;
  }

  const config = loadConfig(opts.config);

  // --- Auth mode ---
  if (opts.auth) {
    const credsDir = config.credentials_dir ?? 'secrets';
    const [connectorName, accountName] = opts.auth.includes(':')
      ? [opts.auth.split(':')[0], opts.auth.split(':')[1]]
      : [opts.auth, undefined];

    const registry = getRegistry();
    const entry = registry.get(connectorName);

    if (!entry?.auth) {
      const authable = [...registry].filter(([, e]) => e.auth).map(([name]) => name);
      console.error(
        `Unknown or non-auth connector: ${connectorName}\n` +
          `Connectors with auth: ${authable.join(', ')}\n` +
          `Use: --auth <connector> or --auth <connector>:<account_name>`,
      );
      process.exit(1);
    }

    const connConfig = config.connectors?.[connectorName] ?? {};
    await entry.auth(credsDir, connConfig, accountName);
    return;
  }

  // --- Test mode ---
  if (opts.test !== undefined) {
    const { runTests } = await import('./test-connectors.js');
    const only = Array.isArray(opts.test) && opts.test.length > 0 ? opts.test : undefined;
    await runTests(config, only);
    return;
  }

  // --- Review mode ---
  if (opts.review !== undefined) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) {
      console.error('ERROR: ANTHROPIC_API_KEY not set.');
      process.exit(1);
    }

    const outputDir = config.output_dir ?? 'output';
    const dateStr =
      typeof opts.review === 'string' ? opts.review : new Date().toISOString().slice(0, 10);

    const briefPath = join(outputDir, `callsheet_${dateStr}.json`);
    if (!existsSync(briefPath)) {
      console.error(`No brief found for ${dateStr} at ${briefPath}`);
      console.error(
        "Usage: --review         (review today's brief)\n" +
          '       --review 2026-03-20  (review a specific date)',
      );
      process.exit(1);
    }

    const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
    console.log(`Reviewing brief for ${dateStr}...`);

    // Fetch fresh data so the critique can compare against it
    console.log('Fetching current data for comparison...');
    const { results } = await fetchAll(config);
    const dataPayload = buildDataPayload(results);

    const client = new Anthropic({ apiKey });
    const issues = await critiqueBrief(client, brief, dataPayload, outputDir);

    if (issues.length === 0) {
      console.log('\n\u2705 No issues found — brief looks good.');
    } else {
      console.log(`\n\u26a0\ufe0f  ${issues.length} issue(s) found:\n`);
      for (const issue of issues) {
        console.log(`  \u2022 ${issue}`);
      }
      console.log("\nThese have been saved and will be fed into tomorrow's prompt.");
    }
    return;
  }

  // --- Show data mode ---
  if (opts.showData) {
    const { results } = await fetchAll(config);
    console.log(buildDataPayload(results));
    return;
  }

  // --- Generate + save + render + print ---
  await runPipeline(config, { preview: opts.preview });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
