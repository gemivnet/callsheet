# Writing a connector

Connectors are how Callsheet gets data. Each connector fetches from one source — an API, a local file, a database, whatever — and returns structured data that Claude interprets.

## Minimal example

Create a file in `src/connectors/`:

```typescript
// src/connectors/my-source.ts

import type { Connector, ConnectorConfig, ConnectorResult } from "../types.js";

export function create(config: ConnectorConfig): Connector {
  return {
    name: "my_source",           // must match config.yaml key
    description: "My Source — one-line description",

    async fetch(): Promise<ConnectorResult> {
      const apiKey = process.env[config.token_env as string] ?? "";
      const data = { items: ["thing 1", "thing 2"] };

      return {
        source: "my_source",
        description:
          "Tell Claude what this data is and how to use it. " +
          "Be specific about what's worth surfacing vs. ignoring.",
        data,
        priorityHint: "normal",  // "high", "normal", or "low"
      };
    },
  };
}
```

Then register it in `src/connectors/index.ts`:

```typescript
import { create as createMySource } from "./my-source.js";

// Add to the registry map:
["my_source", { factory: createMySource }],
```

If your connector has a config validator (recommended), export a `validate` function too:

```typescript
export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  checks.push(config.some_field ? ['✅', 'Field set', ''] : ['❌', 'Field missing', 'Add some_field to config']);
  return checks;
}
```

Then register it as `{ factory: createMySource, validate: validateMySource }`.

And add a config block in `config.yaml`:

```yaml
connectors:
  my_source:
    enabled: true
    token_env: MY_SOURCE_TOKEN
```

## ConnectorResult fields

| Field | Type | Purpose |
|-------|------|---------|
| `source` | string | Identifier matching your connector name |
| `description` | string | **Critical.** This is injected into Claude's prompt. Tell Claude what the data is, what to look for, and what to ignore. The better this is, the better the brief. |
| `data` | object | JSON-serializable data. Keep it lean — this counts toward Claude's input tokens. |
| `priorityHint` | string | `"high"` = always include, `"normal"` = include if relevant, `"low"` = mention only if noteworthy |

## The description field matters most

Claude sees your `description` as context for interpreting the raw data. Good descriptions produce good briefs. Compare:

**Bad:** `"Weather data for Denver."`

**Good:** `"Weather forecast for Denver. Mention if rain affects outdoor plans on the calendar. If a flight lesson is scheduled, flag low ceilings or high winds. Otherwise just a one-line summary."`

The description is your instructions to Claude for this specific data source. Be opinionated about what matters.

## Tips

- **Keep data lean.** Every byte is an input token. Truncate descriptions, skip fields you don't need, summarize where possible. A connector returning 500 lines of JSON will blow the token budget.
- **Use `config`** for anything configurable — API URLs, entity IDs, query strings. It's the connector's block from `config.yaml`.
- **Use env vars for secrets.** Reference them via `config.token_env` and `process.env`. Never put tokens in config.yaml.
- **Throw on failure.** The orchestrator catches errors, logs, and skips. Other connectors still run.
- **Test with `--show-data`.** Run `npx tsx src/cli.ts --show-data` to see what Claude will receive without making an API call.

## Google OAuth connectors

If your connector needs Google OAuth:

1. Reuse the same `credentials.json` — one Google Cloud project can have multiple scopes.
2. Store your token as `token_<name>.json` in the secrets dir.
3. Export an `authFromConfig()` function so users can run `callsheet --auth your_connector`.
4. Register it in `index.ts` with `auth`, `authScopes`, `authTokenPrefix`, and `authLabel` fields — this enables both CLI and web dashboard OAuth flows.
5. Add the required scope to your connector — tokens are per-scope.

See `google-calendar.ts` and `gmail.ts` for reference implementations.

## Connector ideas

Some connectors the community might want:

- **Slack** — unread DM count, channel highlights
- **GitHub** — open PRs, review requests, CI failures
- **Fitbit / Apple Health** — sleep score, step count, weight
- **Anki** — cards due, streak count
- **Radarr/Sonarr** — upcoming media releases
- **Pi-hole** — blocked query count, top domains (anomaly detection)
- **CalDAV** — for non-Google calendar users
- **Notion** — database items, page updates
- **Actual Budget** — already built-in as the `actual_budget` connector
- **OpenAQ / AirNow** — air quality index
- **Tides** — for coastal households
- **Garbage/recycling schedule** — from local municipality calendar
