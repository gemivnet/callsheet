---
"callsheet": minor
---

Make connectors resilient to flaky upstreams and surface 52-week price
extremes automatically.

- Add `src/retry.ts`: shared exponential-backoff + jitter helper with a
  strict retriable-vs-terminal error taxonomy (5xx/408/429/aborts/timeouts/
  network errors retry; other 4xx don't). Replaces the silent
  `try { await fetch(...) } catch { return null }` pattern that used to drop
  whole connector payloads on a single upstream hiccup.
- Wire the helper into `aviation_weather`, `todoist`, `weather`,
  `market`, and `actual_budget` with tuned retry budgets per API.
- `market` now pulls a 1-year daily close series and emits
  `high52w` / `low52w` / `pctFromHigh52w` / `pctFromLow52w` plus boolean
  `atNear52wHigh` and `atNear52wLow` flags (within 0.5% of the trailing
  peak or trough). Connector description updated to tell the brief writer
  to always surface those flags — so an ATH can't be missed for a modest
  weekly change.
- `actual_budget` init and sync calls retry on transient failures and
  stringify non-Error rejections (`{reason: 'x'}`) via `JSON.stringify`
  so brief errors no longer read "[object Object]".
- `core.ts` gains `formatUnknownError` for the same purpose at the
  connector-issue boundary.
