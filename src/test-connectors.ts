/**
 * Connector diagnostic tool.
 *
 * Validates config, environment variables, authentication, network
 * connectivity, and data fetching for each connector.
 *
 * Each connector owns its own `validate()` function — this file is just
 * the runner and presentation layer.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CallsheetConfig,
  ConnectorResult,
  Check,
} from "./types.js";
import { getRegistry } from "./connectors/index.js";
import { C, PASS, FAIL, WARN, INFO, SKIP } from "./test-icons.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Terminal formatting
// ---------------------------------------------------------------------------

function banner(text: string) {
  const width = 64;
  console.log(`\n${C.BOLD}${"\u2501".repeat(width)}${C.RESET}`);
  console.log(`${C.BOLD}  ${text}${C.RESET}`);
  console.log(`${C.BOLD}${"\u2501".repeat(width)}${C.RESET}`);
}

function section(text: string) {
  console.log(`\n  ${C.BOLD}${C.CYAN}\u25b8 ${text}${C.RESET}`);
}

function line(icon: string, msg: string, detail = "") {
  const d = detail ? `  ${C.DIM}${detail}${C.RESET}` : "";
  console.log(`    ${icon} ${msg}${d}`);
}

// ---------------------------------------------------------------------------
// Data inspection
// ---------------------------------------------------------------------------

function countItems(data: unknown): number {
  if (Array.isArray(data)) {
    return data.length + data.reduce((sum, item) => sum + countItems(item), 0);
  }
  if (data && typeof data === "object") {
    return Object.values(data).reduce(
      (sum: number, v) => sum + countItems(v),
      0,
    );
  }
  return 0;
}

function dataTree(
  data: unknown,
  depth = 0,
  maxDepth = 3,
): string[] {
  const lines: string[] = [];
  const indent = "      " + "  ".repeat(depth);

  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val)) {
        lines.push(
          `${indent}${C.CYAN}${key}${C.RESET}: list [${C.BOLD}${val.length}${C.RESET} items]`,
        );
        if (val.length && typeof val[0] === "object" && depth < maxDepth) {
          const keys = Object.keys(val[0] as object).join(", ");
          lines.push(`${indent}  keys: ${C.DIM}${keys}${C.RESET}`);
          let sample = JSON.stringify(val[0]);
          if (sample.length > 100) sample = sample.slice(0, 97) + "...";
          lines.push(`${indent}  [0]: ${C.DIM}${sample}${C.RESET}`);
          if (val.length > 2) {
            lines.push(
              `${indent}  ${C.DIM}... ${val.length - 1} more${C.RESET}`,
            );
          }
        }
      } else if (val && typeof val === "object") {
        lines.push(
          `${indent}${C.CYAN}${key}${C.RESET}: dict [${Object.keys(val).length} keys]`,
        );
        if (depth < maxDepth) lines.push(...dataTree(val, depth + 1, maxDepth));
      } else {
        let display = String(val);
        if (display.length > 80) display = display.slice(0, 77) + "...";
        lines.push(`${indent}${C.CYAN}${key}${C.RESET}: ${display}`);
      }
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

export async function runTests(
  config: CallsheetConfig,
  only?: string[],
): Promise<void> {
  banner("Callsheet connector diagnostics");

  // Phase 0: Global environment
  section("Global environment");

  // .env file
  if (existsSync(".env")) {
    const envLines = readFileSync(".env", "utf-8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="));
    const envKeys = envLines.map((l) => l.split("=")[0].trim());
    line(PASS, ".env file found", `${envLines.length} vars: ${envKeys.join(", ")}`);
  } else {
    line(WARN, ".env file not found", "Copy .env.example to .env");
  }

  // Anthropic key
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey) {
    const masked = apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
    line(PASS, "ANTHROPIC_API_KEY is set", masked);
    if (!apiKey.startsWith("sk-ant-")) {
      line(WARN, "Key doesn't start with sk-ant-", "Might be invalid");
    }
  } else {
    line(WARN, "ANTHROPIC_API_KEY is NOT set", "Needed for generation, not for --test");
  }

  line(INFO, `Model: ${config.model ?? "(not set)"}`, "");

  // Printer
  const printer = config.printer ?? "";
  if (printer) {
    line(PASS, `Printer configured: ${printer}`, "");
  } else {
    line(WARN, "No printer configured", "Use --preview or set 'printer'");
  }

  // Context
  const context = config.context ?? {};
  if (Object.keys(context).length) {
    const tokens = Math.floor(JSON.stringify(context).length / 4);
    line(PASS, `Household context: ${Object.keys(context).length} keys, ~${tokens} tokens`, "");
  } else {
    line(WARN, "No household context", "Add 'context:' to config.yaml");
  }

  // Prompt + existence check
  const promptPath = join(__dirname, "prompts", "system.md");
  if (existsSync(promptPath)) {
    const size = statSync(promptPath).size;
    line(PASS, `System prompt: ${promptPath}`, `${size.toLocaleString()} bytes`);
  } else {
    line(FAIL, `System prompt: MISSING`, promptPath);
  }

  // Phase 1: Connector inventory
  section("Connector inventory");

  const registry = getRegistry();
  const connectorConfigs = config.connectors ?? {};
  const allNames = [
    ...new Set([...registry.keys(), ...Object.keys(connectorConfigs)]),
  ].sort();

  for (const name of allNames) {
    const inConfig = name in connectorConfigs;
    const enabled = connectorConfigs[name]?.enabled ?? false;
    let status: string;
    if (enabled) status = `${C.GREEN}enabled${C.RESET}`;
    else if (inConfig) status = `${C.DIM}disabled${C.RESET}`;
    else status = `${C.DIM}not configured${C.RESET}`;

    if (!registry.has(name) && inConfig) {
      status += `  ${C.RED}(no connector class found!)${C.RESET}`;
    }

    line(enabled ? PASS : SKIP, `${name.padEnd(24)} ${status}`, "");
  }

  // Determine which connectors to test
  const testNames = only ??
    allNames.filter((n) => connectorConfigs[n]?.enabled);

  if (!testNames.length) {
    console.log(`\n  ${C.YELLOW}No connectors to test.${C.RESET}`);
    console.log("  Enable connectors in config.yaml or specify: --test todoist weather");
    return;
  }

  // Phase 2: Per-connector diagnostics
  type TestResult = { name: string; ok: boolean; result?: ConnectorResult; elapsed: number };
  const results: TestResult[] = [];

  for (const name of testNames) {
    banner(`Testing: ${name}`);
    const connConfig = connectorConfigs[name] ?? {};

    // Config validation
    section("Configuration");

    if (!Object.keys(connConfig).length) {
      line(WARN, "No config block in config.yaml", "Using defaults");
    } else {
      const enabled = connConfig.enabled ?? false;
      line(
        enabled ? PASS : WARN,
        `enabled: ${enabled}`,
        enabled ? "" : "Testing a disabled connector",
      );
    }

    const entry = registry.get(name);
    let checks: Check[] = [];
    if (entry?.validate) {
      checks = entry.validate(connConfig);
      for (const [icon, msg, detail] of checks) line(icon, msg, detail);
    } else if (!entry) {
      line(INFO, "No connector registered for this name", "");
    }

    const hasFatal = checks.some(([icon]) => icon === FAIL);

    // Instantiation
    section("Instantiation");

    if (!entry) {
      line(FAIL, `No connector registered for '${name}'`, "");
      results.push({ name, ok: false, elapsed: 0 });
      continue;
    }

    let instance;
    try {
      instance = entry.factory(connConfig);
      line(PASS, `Created ${name} connector`, "");
    } catch (e) {
      line(FAIL, `Failed to create instance: ${e}`, "");
      results.push({ name, ok: false, elapsed: 0 });
      continue;
    }

    if (hasFatal) {
      line(WARN, "Config has errors above \u2014 fetch will likely fail", "");
    }

    // Fetch
    section("Fetch");
    line(INFO, "Calling fetch()...", "");

    const start = performance.now();
    let result: ConnectorResult;
    try {
      result = await instance.fetch();
      const elapsed = (performance.now() - start) / 1000;
      line(PASS, `Fetch completed in ${elapsed.toFixed(2)}s`, "");

      // Result validation
      section("Result validation");
      line(PASS, `source: "${result.source}"`, "");
      line(PASS, `priorityHint: "${result.priorityHint}"`, "");

      if (result.description) {
        line(PASS, "description:", "");
        // Word-wrap description
        const words = result.description.split(" ");
        let curLine = "      ";
        for (const word of words) {
          if (curLine.length + word.length > 78) {
            console.log(`${C.DIM}${curLine}${C.RESET}`);
            curLine = "      " + word + " ";
          } else {
            curLine += word + " ";
          }
        }
        if (curLine.trim()) console.log(`${C.DIM}${curLine}${C.RESET}`);
      } else {
        line(WARN, "Empty description", "");
      }

      if (result.data && Object.keys(result.data).length) {
        line(PASS, `data: ${Object.keys(result.data).length} top-level key(s)`, "");
      } else {
        line(WARN, "data is empty", "");
      }

      // Data inspection
      section("Data contents");
      const items = countItems(result.data);
      line(INFO, `Total nested items: ${items}`, "");
      for (const l of dataTree(result.data)) console.log(l);

      // Token estimate
      section("Token estimate");
      const payload = JSON.stringify(
        {
          source: result.source,
          description: result.description,
          priority: result.priorityHint,
          data: result.data,
        },
        null,
        2,
      );
      const charCount = payload.length;
      const estTokens = Math.floor(charCount / 4);
      line(INFO, `JSON payload: ${charCount.toLocaleString()} chars \u2192 ~${estTokens.toLocaleString()} tokens`, "");

      if (estTokens > 4000) {
        line(WARN, `Very large payload (${estTokens.toLocaleString()} tokens)`, "Consider trimming");
      } else if (estTokens > 2000) {
        line(WARN, `Large payload (${estTokens.toLocaleString()} tokens)`, "Acceptable");
      } else {
        line(PASS, "Payload is compact", "");
      }

      results.push({ name, ok: true, result, elapsed });
    } catch (e) {
      const elapsed = (performance.now() - start) / 1000;
      line(FAIL, `Fetch failed after ${elapsed.toFixed(2)}s`, "");
      line(FAIL, `${(e as Error).constructor.name}: ${e}`, "");
      console.log(`${C.DIM}${(e as Error).stack ?? ""}${C.RESET}`);
      results.push({ name, ok: false, elapsed });
    }
  }

  // Phase 3: Summary
  banner("Summary");

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const totalItems = results
    .filter((r) => r.ok && r.result)
    .reduce((sum, r) => sum + countItems(r.result!.data), 0);
  const totalTime = results.reduce((sum, r) => sum + r.elapsed, 0);

  console.log(`\n  Connectors tested:  ${results.length}`);
  console.log(
    `  ${C.GREEN}Passed: ${passed}${C.RESET}` +
      (failed ? `   ${C.RED}Failed: ${failed}${C.RESET}` : ""),
  );
  console.log(`  Total data items:   ${totalItems}`);
  console.log(`  Total fetch time:   ${totalTime.toFixed(2)}s`);

  // Token budget
  const okResults = results.filter((r) => r.ok && r.result);
  if (okResults.length) {
    const combinedPayload = JSON.stringify(
      okResults.map((r) => ({
        source: r.result!.source,
        description: r.result!.description,
        priority: r.result!.priorityHint,
        data: r.result!.data,
      })),
      null,
      2,
    );
    const totalTokens = Math.floor(combinedPayload.length / 4);
    const promptTokens = existsSync(promptPath)
      ? Math.floor(statSync(promptPath).size / 4)
      : 500;
    const ctxTokens = Object.keys(context).length
      ? Math.floor(JSON.stringify(context).length / 4)
      : 0;
    const fullInput = totalTokens + promptTokens + ctxTokens;

    const costSonnet = (fullInput * 3 + 1500 * 15) / 1_000_000;
    const costOpus = (fullInput * 15 + 1500 * 75) / 1_000_000;

    console.log("\n  Token budget breakdown:");
    console.log(`    Connector data:   ~${totalTokens.toLocaleString()} tokens`);
    console.log(`    System prompt:    ~${promptTokens.toLocaleString()} tokens`);
    console.log(`    Household context:~${ctxTokens.toLocaleString()} tokens`);
    console.log(`    ${C.BOLD}Total input:      ~${fullInput.toLocaleString()} tokens${C.RESET}`);
    console.log("    Est. output:      ~1,500 tokens");
    console.log(
      `\n  Estimated cost per brief:` +
        `\n    Sonnet: ${C.GREEN}~$${costSonnet.toFixed(3)}${C.RESET}  (~$${(costSonnet * 30).toFixed(2)}/month)` +
        `\n    Opus:   ${C.CYAN}~$${costOpus.toFixed(3)}${C.RESET}  (~$${(costOpus * 30).toFixed(2)}/month)`,
    );
  }

  if (failed) {
    console.log(`\n  ${C.RED}Failed connectors:${C.RESET}`);
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`    ${FAIL} ${r.name}`);
    }
  }

  console.log();
}
