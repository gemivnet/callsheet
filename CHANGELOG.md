# callsheet

## 1.6.2

### Patch Changes

- 543fb0f: Fix the budget connector failing against a newer sync server, and make connector failures
  readable.

  The pinned client had fallen a minor version behind the server it talks to, and the mismatch
  surfaced only as a failed fetch listing database migrations the client did not recognise.

  The reason it went unnoticed for nine days is the more useful half: the connector test renderer
  interpolated the caught value straight into a template literal, so any non-`Error` throw
  printed as `[object Object]` with no message. Every other error path already routed through
  `formatUnknownError`; this one did not. It does now, and a non-`Error` throw no longer prints
  an empty stack line either.

## 1.6.1

### Patch Changes

- b9dcb9c: Make the homelab connector insist that overnight work is reported.

  The instruction it gave read "if something was fixed overnight, one line is enough", which a
  summariser reasonably treats as a ceiling rather than a floor — so a night with five repairs
  could be summarised as nothing at all. The point of surfacing a maintenance job in a brief is
  to tell the reader what was handled on their behalf, and silence there is indistinguishable
  from an idle night.

  The wording is now conditional on `action_taken`: when work was done it asks for at least one
  line, and when nothing changed it says so explicitly so the brief cannot imply otherwise.

## 1.6.0

### Minor Changes

- a2a98cb: Add a `homelab` connector for reporting overnight infrastructure status.

  It reads a JSON status document written by an external maintenance job and surfaces it only
  when there is something worth surfacing — a quiet night costs the brief nothing. Two
  properties make it useful rather than noisy: it treats a document that has stopped being
  updated as the interesting case, because a monitoring job that silently dies looks exactly
  like a clean night; and it maps severity onto `priorityHint` so routine status cannot crowd
  out the rest of the page.

  Deliberately generic: the path, label and staleness threshold all come from config, and no
  host, service or network detail lives in the connector itself.

## 1.5.3

### Patch Changes

- 01e75ee: Apply the self-critique to the brief being printed, and speak up when generation fails.

  Six months of output said the feedback loop was not converging. `critiqueBrief` already ran
  before `renderPdf`, so the system diagnosed today's brief, wrote the diagnosis down for
  tomorrow, logged "issue(s) logged for future improvement", and printed the flawed brief
  anyway. Across 111 critiques and 574 issues, **Duplication was 257 of them — 45%** — and the
  rate never moved from ~5 issues per brief between March and September, despite the feedback
  prompt correctly naming it as recurring on 7 of the last 7 days. The shape was consistent:
  171 of those 257 were the Executive Brief restating a section that already owned the topic.
  Warning the next writer does not fix the artifact in hand.

  `repairBrief` now runs between the critique and the render, on the two categories with an
  objective answer — Duplication and Factual accuracy. An item is either in two sections or it
  is not; a stated fact either matches the payload or it does not. Verbosity and grouping stay
  with the writer, because a second pass on a judgement call is as likely to damage a good
  brief as improve it. The repair fails closed: unparseable JSON, or a result with no sections,
  keeps the original. Repaired issues are recorded on the critique entry so tomorrow's prompt
  keeps counting the category — the writer still made the mistake — without citing specific
  examples the reader never saw.

  Failure is no longer silent. Between 2026-06-25 and 07-10 every brief was a GENERATION FAILED
  page because an Anthropic account had no credit; sixteen mornings printed, nothing raised.
  `notify_webhook` is an optional URL posted to as `{title, message}` on failure, in one short
  ASCII line so it survives an SMS gateway intact. It never throws — the alarm must not break
  the run it was watching.

  Two things made that outage harder to read than it should have been, both fixed. The error
  brief hardcoded `failed after ${MAX_RETRIES + 1} attempts`, so a non-retryable 400 that broke
  after a single attempt was reported as four — it looked like API flakiness rather than a
  billing wall. It now reports the real count and says plainly when an error is terminal.

  And `categorizeIssue` matched category prefixes exactly, so the variants the critique model
  actually emits — `Stale item` singular (22 issues), `Missing event`, `Date mismatch` — were
  dropped: 37 of 574 issues never counted toward the recurring-pattern threshold. Matching is
  now case- and plural-insensitive with a synonym map.

## 1.5.2

### Patch Changes

- ba65a52: Fix the Actual Budget connector after a server upgrade left the client behind.

  The sync server had moved several releases ahead of the `@actual-app/api`
  package, so the downloaded budget carried database migrations the client did
  not recognise and every run failed with "Database is out of sync with
  migrations". The connector has been silently absent from the brief for weeks.
  Pinning the client to the server's release line restores it.

- b9e3c30: Bind the headed-mode dashboard to loopback instead of all interfaces.

  The dashboard has no authentication on any route, and its `:date` handlers read and
  delete files under the output and credential directories. On `0.0.0.0` that surface was
  reachable from any host on the LAN. It is served through a reverse proxy, so this changes
  nothing for normal use.

- fd3b645: Repair the two Jest suites that could not load, and move off EOL Node.

  `test/core.test.ts` mocked `node:child_process` with only `execSync`, so it broke the
  moment `printPdf` switched to `execFileSync`. The mock and its assertions now use the
  argv form, plus a new case asserting that a printer name full of shell metacharacters
  arrives as one literal argument.

  `test/server.test.ts` mocked `../src/core.js` without `DEFAULT_MODEL`, which
  `src/server.ts` imports. An ESM module mock has to supply every binding the importer
  names or the import throws and the suite never runs. This one predates the change above.

  Both suites were silently not running: 21 of 23 passing looked healthy while 194 tests
  never executed. Now 23/23 and 568/568, with coverage at 96.73/85.36/96.67/97.96 against
  the 95/84/95/95 gate.

  Also moves the Dockerfile, CI and `engines.node` from Node 20, which is EOL and no
  longer receives CVE fixes, to Node 24.

- 2ec85ba: Fix the Docker image producing an error brief instead of a real one, and harden two
  input paths.
  - `build` now copies `src/prompts` into `dist/`. `tsc` emits only `.js`, so the built
    image had no system prompt and `loadPrompt` threw outside the try block, rendering a
    generation-failure brief on every scheduled run. The local dev path reads from `src/`
    and was unaffected, which is why it went unnoticed.
  - The `:date` routes validated nothing before interpolating the parameter into a
    filename. A percent-encoded traversal reached the handler and resolved outside the
    output directory; these routes are all date-keyed, so they now reject anything that
    is not `YYYY-MM-DD`. (The unencoded form never reached the handler — the URL layer
    normalises it first.)
  - `printPdf` used `execSync` with the printer name interpolated into a shell string.
    The dashboard can rewrite config unauthenticated, making that a command-injection
    sink. It now uses `execFileSync`, which spawns no shell.

- 6d3588f: Three fixes, all found by the repo's own rules rather than by a failure.

  Two committed strings broke the PII policy in this file's own CLAUDE.md. One named the
  specific language the user is learning; the other named a real vendor, twice, and was not
  a comment at all but prompt text sent to the model on every run. Both are now
  structural placeholders that teach the model the same thing.

  OAuth token files were written with the default 0644 into a directory created 0755.
  These hold Google refresh tokens for mail and calendar and sit where the dashboard can
  reach them; they are now 0600 in a 0700 directory. The existing test pinned the old call
  shape and failed, which is the test working as intended — its assertion now documents the
  modes as part of the contract.

  `actual_budget` replaced `console.log`/`warn`/`info` with no-ops process-wide before
  opening the `try` whose `finally` restores them, so a throw from `mkdirSync` or
  `api.init` silenced logging for the rest of the run. The `try` now opens before the swap.

- f4f2aa1: Vacation ranges were unenforceable on the deployment that actually ships briefs.

  `isOnVacation` was only consulted by `runGeneration` in the scheduler, which is reached
  solely through `entrypoint.ts` — the containerised `MODE=headed_docker` path. A host cron
  calling `yarn print` goes through `cli.ts`, which called `runPipeline` directly and never
  looked at the config. Setting a `vacation` range on that setup was a silent no-op: the
  brief printed every morning regardless, with nothing in the log to say why.

  The CLI now performs the same check before generating, so the config field means the same
  thing on both paths. `--force` generates anyway, which preserves the on-demand escape
  hatch the old docs promised via a flag rather than via the accident of which entrypoint
  you happened to use. `todayInTz` is exported so the skip message names the date it judged
  on — a skipped run should be legible in a cron log, not silent.

  The docs said "Manual runs still work", which was true as a description of the code and
  misleading as a description of the behaviour anyone would want. Corrected in both
  `SETUP_GUIDE.md` and `config.example.yaml`.

## 1.5.1

### Patch Changes

- 9f7d6d3: Bound how long the brief model reasons before writing.

  Left unset, effort defaults to full depth, and on a full day's payload the
  model spent an entire token budget thinking and returned no brief at all. The
  judgement calls in a brief are modest — what to include, how to phrase it — and
  the facts now arrive pre-computed, so it does not need to deliberate at that
  length.

- a60866c: Cite the count when the data provides one.

  The rule forbidding hand-counted figures was read as a preference for vague
  ones, so a brief said "logged multiple flight lessons" where the aggregate said
  three. The point was never to avoid numbers, only to avoid invented ones.

- 650977e: Run memory extraction on the cheap model.

  It was using whichever model writes the brief, and since it is sent the same
  full payload, it cost roughly as much per day as the brief itself. Summarising
  data that has already been read is what the small model is for.

- 9978acb: Default the brief to Sonnet.

  It is the better fit for a job that runs unattended every morning: the accuracy
  work moved counting and identifiers out of the model's hands, so the extra
  reasoning of a larger model buys less here than it costs. Opus remains a
  one-line change in config.

## 1.5.0

### Minor Changes

- 5ba2fbf: Read airports off the calendar instead of a list that goes stale.

  Aviation weather was fetched for whatever stations were configured once and
  never revisited, so the brief reported conditions for fields the household no
  longer flew from while the calendar plainly said where the flying was
  happening. The calendar connector now runs first when aviation weather is
  enabled, and any airport named in today's or the coming week's events is added
  to the weather request. Configured stations are still honoured — they're the
  home fields — and the behaviour can be turned off with `derive_stations:
false`.

  Identifiers are read literally from event text; `airport_aliases` maps place
  names to stations for fields whose events never spell out the identifier, and
  `activity_pattern` narrows the scan to events that actually imply flying.

  The hardcoded fallback that pointed the area forecast at one specific region
  when no ICAO station was configured is gone — the forecast is skipped instead.
  Validation now warns when a station looks like an IATA code, which returns no
  data rather than an error.

- b1fda2e: Make the brief accountable for the facts it states.

  A new `household` config section lists everyone the brief is about, including
  people who have no calendar, inbox or task list of their own. Previously the
  only people the brief knew were the ones with connector accounts, so a member
  without any was invisible and their events read as belonging to whoever's
  calendar carried them.

  The brief's date is now computed rather than written by the model, which had
  been pairing the right weekday with the next day's date on roughly one brief in
  six. A new top-level `timezone` setting anchors that date, the output
  filenames, the connector query windows and the scheduler to one zone, instead
  of filenames following UTC while the visible dates followed somewhere else.

  The prompt gains two rules: counts must be read from the structured
  per-person aggregates rather than tallied by hand, and airport or station
  identifiers must be copied from the payload rather than recalled. The
  self-critique gains a factual-accuracy category so a brief that reads well but
  states a wrong number is caught. Memory extraction no longer truncates
  mid-array — its output limit was too small, so most days' insights failed to
  parse and were silently dropped — and it no longer records counts, which go
  stale the day after they are written.

- aacbc77: Calendar events now carry per-person attribution and pre-computed counts.

  Each event lists the household member(s) whose calendar it came from, and an
  event appearing on two calendars is merged into one shared event that keeps
  both names rather than being deduplicated down to one person. The connector
  also emits an `aggregates` block with per-person totals for the recent, today
  and upcoming windows, plus optional per-category tallies driven by a new
  `event_categories` config option, so the brief cites counts instead of
  computing them.

  Alongside that: results are paginated (previously capped at one page, silently
  dropping events on busy calendars), per-calendar fetch failures are surfaced in
  the payload instead of only logged, query windows are bounded in the configured
  timezone rather than the process one, and `lookback_days` now defaults to 7 so
  past events are available on every run rather than only on the weekly review
  day.

### Patch Changes

- 25bdbc6: Give the brief enough token budget for models that reason before answering.

  Current models spend part of the response budget thinking, so the previous
  ceiling was consumed before the brief itself was written and every run ended
  in a truncated response.

- 1f51c34: Let the self-critique see the whole payload before it calls something wrong.

  The reviewer was shown a small slice of the day's data, so it reported
  anything past the cut as unsupported — and those false findings fed straight
  into the next day's prompt as faults to correct. It now receives the full
  payload, and is told that the recent and upcoming windows describe different
  periods, which was the other source of spurious findings.

- 987cb9b: Bump dev dependencies (eslint, prettier, jest, ts-jest, esbuild, @changesets/cli) and remove three redundant type assertions that the updated typescript-eslint now flags as unnecessary. Type-only change with no runtime effect.
- ea615ff: Refresh the model lineup and fix the usage pricing table.

  The shipped default was a model that has since been retired, and the setup
  script, web wizard and setup guide all still offered it. They now offer the
  current Sonnet and Opus.

  The pricing table priced Opus at three times its actual rate and had no entry
  for any current model, so an unrecognised model was silently billed at Sonnet
  rates. Rates are corrected, current models are listed, and an unlisted model is
  now estimated from its family with a note in the log rather than assumed.

- bf462b0: Upgrade the Anthropic SDK and stop mishandling unusual responses.

  The SDK was around eighteen months behind. Reading the response text assumed
  the first content block is always text and ignored `stop_reason` entirely, so
  a truncated or declined response surfaced as a JSON parse error — or, for the
  brief itself, as a generic "generation failed" page that said nothing about
  what actually went wrong. Text is now collected from all text blocks, and
  truncation and refusals are reported as themselves.

  The brief's output limit is also raised, since the previous ceiling was close
  enough to a long day's output to truncate it.

## 1.4.0

### Minor Changes

- 7754fce: Docker scheduled briefs can now print. The scheduler prints to the configured printer by default (set `PRINT_BRIEF=false` for UI-only deployments), the image bundles `cups-client` so `lp` can reach a CUPS server via `CUPS_SERVER`, and the build installs the toolchain needed to compile native modules (`better-sqlite3`) on alpine.

### Patch Changes

- 56dd858: Upgrade `@actual-app/api` to 26.5.2 so the budget connector stays in sync with newer Actual Budget server migrations (older client versions refuse to sync against an upgraded server).

## 1.3.0

### Minor Changes

- c6d7dca: Add vacation mode. Configure one or more `vacation` ranges in `config.yaml` (each with `start` / `end` as YYYY-MM-DD, inclusive on both ends, evaluated in your configured timezone) and the cron-driven scheduler will skip generation entirely on any date that falls inside a range. Manual CLI runs are unaffected, so on-demand briefs still work while you're away.

### Patch Changes

- 0eeaa2a: Fix CI test hang on Linux runners. The language connector test that exercised the `recordBriefPhrase` error path pointed `output_dir` at `/proc/invalid/...`; on macOS that errored fast, but on the GitHub Actions Ubuntu runner `mkdirSync({recursive:true})` against a `/proc` sub-path hung the worker indefinitely (the test job timed out at 47 minutes). Switch the failing path to a sub-path of a regular file so `mkdirSync` fails synchronously with `ENOTDIR` on every OS.

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

- Fix Jest hang on CI by closing the `startServer` listener in its test and dropping the `forceExit` workaround. `startServer` now returns the underlying `http.Server` so callers (and tests) can shut it down cleanly.
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
