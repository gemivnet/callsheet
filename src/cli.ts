#!/usr/bin/env node
import "dotenv/config";
import { program } from "commander";
import {
  loadConfig,
  fetchAll,
  buildDataPayload,
  generateBrief,
  saveBrief,
  printPdf,
} from "./core.js";
import { getRegistry } from "./connectors/index.js";
import { renderPdf } from "./render.js";

program
  .name("callsheet")
  .description("AI-generated daily printed briefs")
  .option("--config <path>", "Config file path", "config.yaml")
  .option("--preview", "Generate PDF without printing")
  .option("--auth <connector>", "Run OAuth setup for a connector")
  .option("--show-data", "Dump raw data and exit")
  .option("--list-connectors", "List available connectors")
  .option("--test [connectors...]", "Test connectors");

program.parse();

const opts = program.opts<{
  config: string;
  preview?: boolean;
  auth?: string;
  showData?: boolean;
  listConnectors?: boolean;
  test?: string[] | true;
}>();

async function main() {
  // --- List connectors ---
  if (opts.listConnectors) {
    const registry = getRegistry();
    console.log("Available connectors:\n");
    for (const [name] of [...registry].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      console.log(`  ${name}`);
    }
    return;
  }

  const config = loadConfig(opts.config);

  // --- Auth mode ---
  if (opts.auth) {
    const credsDir = config.credentials_dir ?? "secrets";
    if (opts.auth === "google_calendar" || opts.auth.startsWith("google_calendar:")) {
      const { auth } = await import("./connectors/google-calendar.js");
      const accountName = opts.auth.includes(":")
        ? opts.auth.split(":")[1]
        : undefined;
      const gcalConfig = config.connectors?.google_calendar;
      const accounts = (gcalConfig?.accounts as Array<{ name: string; credentials_file?: string }>) ?? [];
      const matchedAcct = accountName
        ? accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase())
        : undefined;
      const credsFile = matchedAcct?.credentials_file
        ?? (gcalConfig?.credentials_file as string)
        ?? undefined;
      await auth(credsDir, accountName, credsFile);
    } else if (opts.auth === "gmail" || opts.auth.startsWith("gmail:")) {
      const { auth } = await import("./connectors/gmail.js");
      const accountName = opts.auth.includes(":")
        ? opts.auth.split(":")[1]
        : undefined;
      // Look up per-account credentials_file from config
      const gmailConfig = config.connectors?.gmail;
      const accounts = (gmailConfig?.accounts as Array<{ name: string; credentials_file?: string }>) ?? [];
      const matchedAcct = accountName
        ? accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase())
        : undefined;
      const credsFile = matchedAcct?.credentials_file;
      await auth(credsDir, accountName, credsFile);
    } else {
      console.error(
        `Unknown auth target: ${opts.auth}. Options: google_calendar, google_calendar:<account_name>, gmail, gmail:<account_name>`,
      );
      process.exit(1);
    }
    return;
  }

  // --- Test mode ---
  if (opts.test !== undefined) {
    const { runTests } = await import("./test-connectors.js");
    const only =
      Array.isArray(opts.test) && opts.test.length > 0
        ? opts.test
        : undefined;
    await runTests(config, only);
    return;
  }

  // --- Fetch ---
  console.log("Fetching data...");
  const results = await fetchAll(config);

  if (results.length === 0) {
    console.error(
      "No data fetched. Check your config and connector settings.",
    );
    process.exit(1);
  }

  const dataPayload = buildDataPayload(results);

  if (opts.showData) {
    console.log(dataPayload);
    return;
  }

  // --- Generate ---
  const outputDir = config.output_dir ?? "output";
  const model = config.model ?? "claude-sonnet-4-20250514";

  console.log(`Generating brief via Claude (${model})...`);
  const brief = await generateBrief(config, dataPayload);

  const jsonPath = saveBrief(brief, outputDir);
  console.log(`  JSON: ${jsonPath}`);

  const pdfPath = await renderPdf(brief, outputDir);
  console.log(`  PDF:  ${pdfPath}`);

  if (opts.preview) {
    console.log("Preview mode \u2014 not printing.");
    return;
  }

  // --- Print ---
  const printer = config.printer ?? "";
  if (!printer) {
    console.log(
      "No printer configured. Use --preview or set 'printer' in config.yaml.",
    );
    process.exit(1);
  }

  console.log(`Printing to ${printer}...`);
  printPdf(pdfPath, printer);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
