# callsheet

## 1.2.0

### Minor Changes

- 19f3d38: Add `garbage_recycling` connector. Pure config-driven (no API), supports both weekly schedules (`weekly: thursday`) and biweekly schedules anchored to a known pickup date (`biweekly: { day: tuesday, anchor: "2026-04-21" }`). Surfaces today's and tomorrow's pickups so the brief can flag "bins out tonight" without you having to remember the alternating recycling week.
- 5695ddb: aviation_weather: expand to full preflight briefing.

  The connector used to return only METAR + TAF. It now fetches — in parallel,
  with graceful per-endpoint degradation — station info, PIREPs, SIGMETs,
  AIRMETs, G-AIRMETs (SIERRA/TANGO/ZULU), CWAs, and the local NWS Area
  Forecast Discussion, plus a computed density altitude report per station.

  Hazard polygons (SIGMET/AIRMET/G-AIRMET/CWA) are filtered to anything that
  contains or lies within 100 nm of a configured station, so the prompt
  payload stays tight. G-AIRMET forecast hours for the same hazard/product
  over the same stations are collapsed into a single report with a
  `forecastHours: [0, 3, 6, 9, 12]` array instead of five near-duplicates.

  New optional config fields: `wfo` (override the Area Forecast Discussion
  office), `pirep_radius_nm`, `pirep_age_hours`.

- e5387ee: Two improvements to fight recurring brief quality issues surfaced in a week of production critiques:
  - **Feedback loop surfaces RECURRING problems, not just raw examples.** `buildFeedbackContext` now classifies self-critique issues by category (Duplication, Verbosity, Missing data, Poor grouping, Stale items) and counts distinct days each category appears on. Any category hitting 3+ of the last 7 critique days gets a prominent "RECURRING quality problems" section with a specific remedy — not just a list of past gripes. Recent specific examples are still shown as anchors.
  - **System prompt: anti-conflation guardrail.** Added an explicit rule that shared sender, service, or vendor is NOT a semantic link. Prevents merging unrelated items from the same sender into one bullet when the underlying threads aren't actually connected.

- 3212e7b: ✨ Add language connector with 30-day phrase history so the brief's word-of-the-day never repeats

  The language word-of-the-day used to live in `extras:` and relied on the 7-day shared memory bucket for anti-repeat — which didn't work because phrases were never persisted as structured data. The new `language` connector:
  - Keeps its own phrase history file (`<output_dir>/language_history.json`) with a configurable retention window (default 30 days).
  - Feeds the full past-phrase list to the brief writer so it can dodge repeats deterministically.
  - Provides a rotating theme cue and level guidance, plus instructions to mine today's connector data for contextual vocab.
  - Parses the emitted phrase out of the brief after generation and appends it to history.

  Rendered as the last item in the Executive Brief section — not its own section — matching the original extras-based UX.

  Configure via `connectors.language` with `target_language`, `label_prefix`, `level`, and `history_days`.

- 3679545: Run connector fetches in parallel with per-connector deadlines. Previously each connector ran sequentially, so the daily brief took as long as the sum of all connector latencies (~10–30s). Now they run via `Promise.allSettled` and total fetch time is ~max instead of ~sum (typically 3–6× faster). Each fetch is wrapped in a configurable deadline (`connector_timeout_ms`, default 60s) so a single hanging connector can no longer stall the brief — it gets surfaced as an issue and the rest still complete. Result ordering is preserved.
- 6fa4443: Make connectors resilient to flaky upstreams and surface 52-week price
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

- 6109b83: Add a `sun_moon` connector that reports sunrise, sunset, solar noon, civil
  dawn/dusk, daylight hours, and moon phase/illumination/rise/set for a
  configured lat/lon. Pure local computation via `suncalc` — no API calls,
  never fails. Useful for VFR night currency boundary (end of civil twilight +
  1h), household-side sun timing (walks, golf), and moon-phase awareness for
  night flying or stargazing.
- 2ab8835: Add Week in Review mode. Configure `weekly_review_day` (a day name like
  `saturday` or a number 0-6) and on that day the brief is replaced by a
  retrospective covering the trailing 7 days, generated from a separate
  `src/prompts/weekly.md` system prompt with sections for The Week,
  Accomplishments, By the Numbers, Open Items, Notable, and Looking Ahead.
  The Google Calendar connector now supports `lookback_days` for fetching
  past events, and is automatically bumped to a 7-day lookback on review
  days so the retrospective has data to draw on.

### Patch Changes

- ab69530: Boost test coverage from 70% to 80%+ with new core.ts and runPipeline tests
- f5c43ce: Upgrade default brief model to Claude Opus 4.7 and register its pricing ($15 input / $75 output per M tokens) alongside the older Opus 4.x IDs in the usage tracker so cost accounting stays accurate across model rollovers.
- 37669ae: 🐛 Pre-compute weekday/date/time labels for calendar events so the brief writer can't mis-derive them

  Calendar events now carry `date` (YYYY-MM-DD), `dayOfWeek` (e.g. "Monday"), `timeLabel` ("7:30 AM" or null for all-day), and `whenLabel` ("today", "tomorrow", "Monday (in 4 days)") fields resolved in the configured timezone. The connector also emits the timezone and today's date alongside the events. This closes a prior bug where the LLM was labeling events with the wrong weekday (off by one) when deriving weekdays from raw ISO strings.

- a6b981b: Enforce 95% test coverage threshold and boost coverage to 99%+ lines across all files
- 4aec9f9: Forbid compound topic mashing in Executive Brief items. Each bullet now covers exactly one subject — no more cramming unrelated facts into one bullet just because they share a person, source, or rough timeframe.
- 0a12fcd: Fix actual_budget connector ENOENT on volatile /tmp: mkdir -p the cache dir before init, so the connector keeps working after the OS clears /tmp
- 8a2a2b7: Fix two cron crash vectors: actual-budget background task race condition and unhandled API errors in pipeline
- 62694f0: Two parser reliability fixes observed in the past week of production briefs:
  - `stripJsonCodeFences` now tolerates leading/trailing commentary around the fenced block. Previously the anchored regex failed whenever Haiku added a trailing sentence after ` ```json\n[]\n``` `, which silently broke auto-close task detection every day.
  - `aviation_weather` treats a 200 with an empty body as a legitimate nothing-to-report response (common for quiet PIREP/CWA windows) rather than logging `Unexpected end of JSON input`. Truly unparseable bodies still log a distinct warning.

- a7c0953: Fix prettier formatting in core.ts
- e540617: Fix a TypeScript narrowing error in the garbage_recycling validate path so a
  schedule object with neither `weekly` nor `biweekly` reports a clean
  "missing 'weekly' or 'biweekly'" check instead of failing to compile.
- 259986d: Tighten two system prompt rules: clarify that the "one topic per item" rule allows multiple actions on the _same_ subject (e.g. "garage the car, salt the steps" is one snow-prep topic), and add concrete examples to the dollar-amount hallucination guard so order numbers, tracking IDs, and confirmation codes are clearly distinguished from real money.
- d71273b: Extract `stripJsonCodeFences` helper in core.ts. Replaces 4 copy-pasted regex sites that strip Markdown code fences from Claude responses, with a single tested utility.
- 5953f28: 🐛 Strengthen system prompt so the brief writer uses pre-computed calendar fields

  A prior change pre-computed `dayOfWeek` / `date` / `whenLabel` on each calendar event, but the brief writer was still occasionally deriving the weekday from raw ISO strings and getting it wrong. The system prompt now explicitly tells it to use those fields verbatim and never derive weekdays itself. Also teaches it how to surface the `language` connector's phrase inside the Executive Brief.

- 4aec9f9: Add hallucination guard: forbid extracting dollar amounts from email free-text. Order numbers, tracking IDs, and confirmation codes are no longer mistaken for paid amounts.
- 24c313c: Scrub personal data from tracked files. Replaces real names, vendor names, and trip destinations in prompt examples, README, config example, mock brief, and test fixtures with generic placeholders.
- 4aec9f9: Email Highlights now skips resolved/no-action threads. "Thanks, fixed it" follow-ups no longer take up space in the brief.
- a4d9087: Fix cron reliability: catch async crashes from @actual-app/api, add retry with backoff for Claude API calls, and generate error briefs when all retries fail
- 61524d5: Week in Review: switch from full-brief replacement to a small supplemental blurb.

  Previously, on `weekly_review_day` the entire daily brief was replaced with a
  dedicated Week in Review retrospective. That turned out to be way too much —
  a 7-day retrospective crowding out the actually useful daily content.

  Now the daily brief runs as usual and is prepended with a compact Week in
  Review section (2–4 sentences, ~60 words) as the first section of the brief.
  The dedicated weekly prompt file has been removed. The calendar lookback is
  still auto-bumped to 7 days on review days so the blurb has past events to
  reference.

- 2946efe: Actual Budget connector now emits `weekOverWeekByCategory` for trend-based spending insights, and the system prompt steers Claude away from raw "X% over budget" framing toward week-over-week anomalies and unusually large transactions.

## 1.1.0

### Minor Changes

- a52115b: Add Docker entrypoint with MODE switching: headless_local (CLI), headless_docker (scheduler), headed_docker (scheduler + Next.js).
- da4e169: Add node-cron scheduler for Docker headless mode with generation mutex and configurable cron schedule.
- 77119bf: Add configuration setup wizard for first-time dashboard users
- d8b3e1a: Add API usage tracking: logs token counts, model, and cost for every Anthropic API call to output/usage/.
- e830fdf: Add web dashboard: Express API server with React SPA frontend. Includes pages for briefs, connectors, memory, config, usage, and logs.
- dcb26a3: Add connector detail page with OAuth flow and status checks from dashboard
- 4fec0b7: Update Dockerfile for three deployment modes and add docker-compose files

### Patch Changes

- 4a607e0: Add unit tests for server, scheduler, usage, and entrypoint modules
- 32788e4: Fix Express 5 wildcard route and update core tests for refactored API
- f80b172: Refactor: extract reusable runPipeline() from CLI, replace process.exit() with thrown errors in core.ts for server compatibility.
- f748f68: Unify CI and Release into single CI/CD pipeline — release only runs after lint and tests pass. Add automated release script.

## 1.0.0

### Major Changes

- Initial 1.0.0 release. Full CI/CD pipeline with GitHub Actions, Jest test suite (135+ tests), Docker builds with GHCR publishing, Codecov coverage reporting, and changesets for versioning.
