---
"callsheet": minor
---

Run connector fetches in parallel with per-connector deadlines. Previously each connector ran sequentially, so the daily brief took as long as the sum of all connector latencies (~10–30s). Now they run via `Promise.allSettled` and total fetch time is ~max instead of ~sum (typically 3–6× faster). Each fetch is wrapped in a configurable deadline (`connector_timeout_ms`, default 60s) so a single hanging connector can no longer stall the brief — it gets surfaced as an issue and the rest still complete. Result ordering is preserved.
