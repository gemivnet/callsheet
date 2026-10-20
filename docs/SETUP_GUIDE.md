# Getting Started

A complete guide to setting up Callsheet — from first install to daily automated briefs.

---

## Deployment methods

Callsheet supports six ways to run. Pick the one that fits your setup.

| Method | Command | One-off | Scheduled | Dashboard | OAuth UI | Print | Docker | Best for |
|--------|---------|:-------:|:---------:|:---------:|:--------:|:-----:|:------:|----------|
| **Run local** | `yarn preview` | Yes | - | - | - | Yes | - | Quick test |
| **Manual cron** | `crontab -e` | - | Yes | - | - | Yes | - | Simple server |
| **setup.sh** | `bash setup.sh` | - | Yes | - | - | Yes | - | First-time setup |
| **Dashboard** | `yarn dashboard` | Yes | - | Yes | Yes | - | - | Development |
| **Docker headless** | `docker compose up` | - | Built-in | - | - | Yes | Yes | Headless server |
| **Docker headed** | `docker compose -f ... up` | Yes | Built-in | Yes | Yes | Yes | Yes | Full setup |

### Run local (simplest)

Run a single brief from the terminal. No server, no scheduler, no Docker.

```bash
yarn preview          # Generate PDF, don't print
yarn print            # Generate + print
```

### Manual cron

Same as run local, but scheduled with system cron. Build once, then add a cron job:

```bash
yarn build
crontab -e
```

```
30 6 * * * cd /path/to/callsheet && /usr/bin/node dist/cli.js >> output/cron.log 2>&1
```

Runs at 6:30 AM daily. Use absolute paths — cron doesn't have your shell's PATH.

### setup.sh (guided)

An interactive script that walks through dependencies, API keys, connectors, OAuth, printer discovery, and cron scheduling in one command.

> **Review before running.** Read through [`setup.sh`](../setup.sh) first to understand what it does.

```bash
less setup.sh     # Review first
bash setup.sh     # Then run
```

**Flags:** `--headless` (non-interactive), `--skip-deps` (skip system packages), `--skip-print` (skip printer setup).

### Dashboard (local development)

Builds the React SPA and starts Express on port 3000. Good for development and testing connectors.

```bash
yarn dashboard        # Build web + start server
```

Open `http://localhost:3000`. You can view briefs, test connectors, trigger generation, manage config, and run Google OAuth flows from the browser.

### Docker headless

Runs the scheduler in a container with no UI. Generates briefs on a cron schedule.

```bash
docker compose up -d
```

Configure schedule and timezone via environment variables in `docker-compose.yml`.

### Docker headed

Everything in Docker headless, plus the web dashboard on port 3000.

```bash
docker compose -f docker-compose.yml -f docker-compose.headed.yml up -d
```

Open `http://localhost:3000` to access the dashboard.

---

## Prerequisites

- **Node.js 20+** — check with `node --version`. Install via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org). (Not needed for Docker methods.)
- **Yarn** — this project uses Yarn 4 (Berry). Corepack handles this: `corepack enable`. (Not needed for Docker methods.)
- **Docker** — only for Docker methods. Install from [docker.com](https://docker.com).
- **A printer** (optional) — any CUPS-compatible printer. You can use `--preview` mode or the dashboard without one.
- **An Anthropic API key** — sign up at [console.anthropic.com](https://console.anthropic.com) and add credits ($5 is enough for months of daily briefs).

---

## Step 1: Clone and install

```bash
git clone https://github.com/gemivnet/callsheet.git
cd callsheet
yarn install
```

No system dependencies needed — PDF rendering uses `@react-pdf/renderer` (pure JS, no Chromium, no WeasyPrint).

**Docker users:** Skip `yarn install`. The Dockerfile handles dependencies.

## Step 2: Create your config files

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

| File | What goes here |
|------|---------------|
| `.env` | Secrets: API keys, tokens. Never committed to git. |
| `config.yaml` | Everything else: which connectors are on, household context, printer name. |

## Step 3: Add your Anthropic API key

Open `.env` and paste your key:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

This is the only secret every setup needs. The rest depend on which connectors you enable.

### Choosing a model

In `config.yaml`, set the `model` field:

```yaml
# The default: the most capable model, and the best at connecting dots across
# sources (roughly $0.60-1.25/day for the brief, depending on how much calendar,
# email and task data the household has; it reasons at more length than the
# others, so output is a bigger share of its cost)
model: claude-fable-5-1

# Close behind for well under half the brief's cost
model: claude-opus-5-5

# Fast and capable, the cheapest model that writes a good brief
model: claude-sonnet-5-5
```

The quality difference shows most in the Executive Brief section, where Claude connects dots across data sources. If the bill matters more than that last step, Opus 5.5 or Sonnet 5.5 write a good brief for much less.

The housekeeping passes (living context, memory, fact check, auto-close) always run on Claude Opus 5.5, whichever model writes the brief. Between them they read more than twice the brief's input, so they are a large share of the bill; see [Understanding costs](#understanding-costs). On models that support it, every request opts into Anthropic's server-side refusal fallback, so a request a safety classifier declines is retried on a fallback model instead of producing an error page or a skipped pass.

---

## Step 4: Enable connectors

Start simple. You don't need all connectors on day one. Pick 1-2 to start.

### Suggested starting order

1. **Weather** — zero auth, instant gratification
2. **Todoist** — quick API token, shows tasks immediately
3. **Google Calendar** — OAuth flow, but high value
4. **Gmail** — reuses the same Google credentials
5. **Market** — zero auth, nice-to-have, includes related news per ticker
6. **Actual Budget** — if you use Actual Budget for finances
7. **Home Assistant** — if you run HA
8. **Aviation Weather** — if you fly

---

### Weather (no auth required)

The fastest way to verify the system works end-to-end.

1. Find your coordinates (search "lat lon" + your city, or use Google Maps > right-click > copy coordinates).
2. Edit `config.yaml`:

```yaml
connectors:
  weather:
    enabled: true
    location: "Denver, CO"
    lat: 39.7392
    lon: -104.9903
```

3. Test it:

```bash
yarn tsx src/cli.ts --test weather
```

You should see a green checkmark for Fetch, plus a data tree showing temperature, wind, and forecast periods.

> **Note:** The NWS API only covers US locations. For international weather, you'd need to write a connector using a different API (OpenWeatherMap, etc.).

### Todoist

1. Go to [Todoist Settings > Integrations > Developer](https://todoist.com/app/settings/integrations/developer) and copy your API token.
2. Add it to `.env`:

```
TODOIST_TOKEN_1=your_token_here
```

3. Edit `config.yaml`:

```yaml
connectors:
  todoist:
    enabled: true
    accounts:
      - name: Your Name
        token_env: TODOIST_TOKEN_1
```

For multi-person households, add more accounts with separate tokens:

```yaml
    accounts:
      - name: Alex
        token_env: TODOIST_TOKEN_ALEX
      - name: Jordan
        token_env: TODOIST_TOKEN_JORDAN
```

4. Test:

```bash
yarn tsx src/cli.ts --test todoist
```

### Google Calendar

This requires a one-time OAuth setup. It takes about 5 minutes.

**Create Google Cloud credentials:**

1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (or use an existing one).
3. Go to **APIs & Services > Library**, search for **Google Calendar API**, and enable it.
4. Go to **APIs & Services > Credentials > Create Credentials > OAuth Client ID**.
5. Application type: **Desktop app**. Name it whatever you want.
6. Download the JSON file and save it as `secrets/credentials.json`:

```bash
mkdir -p secrets
mv ~/Downloads/client_secret_*.json secrets/credentials.json
```

**Run the auth flow:**

From the CLI:

```bash
yarn auth:gcal
```

Or from the dashboard: Navigate to **Connectors > Google Calendar > Authorize**. The OAuth flow opens in a popup window.

> **"This app isn't verified" warning:** This is normal for personal projects. Click "Advanced" > "Go to (your app name)" to continue.

**Configure which calendars to pull:**

```yaml
connectors:
  google_calendar:
    enabled: true
    credentials_dir: secrets
    credentials_file: credentials.json
    lookahead_days: 7
    lookback_days: 7
    accounts:
      - name: Person 1
        calendar_ids:
          - primary
      - name: Person 2
        calendar_ids:
          - primary
```

`primary` is that account's main calendar. To add shared or subscribed calendars, find their IDs in Google Calendar web > Settings > click the calendar > "Integrate calendar" > Calendar ID.

Each account needs its own OAuth token (`yarn auth:gcal <name>`). The `name` is what the brief calls that person, so match it to the corresponding entry in `household`.

The calendar works out who each event is for: an event whose title starts with a household member's name ("Name: Practice") belongs to that member, even when it sits on someone else's calendar — list everyone under `household` (see Step 5). Multi-day all-day events carry their real last day (Google's end date is exclusive), overlapping events are reported per person as `conflicts`, and each person's free stretches today (between `day_start_hour` and `day_end_hour`, default 8 and 21) are what the task coach uses to suggest when to do a task. `exclude_patterns` drops events that are on a calendar for reference only:

```yaml
    exclude_patterns: ["schedule reference", "not attending"]
```

Health appointments never reach the writer as written. An event whose title names a clinician, a credential, a specialty, a procedure or a place of care, or whose location is a clinic or hospital, arrives as "Private appointment" with `health: true` and no place or notes, so the page shows "Appointment" with the person and the time. A visit to the vet is left alone. Practices the built-in medical vocabulary cannot recognise (a clinic known only by its brand name) go in `private_patterns`, as case-insensitive text fragments:

```yaml
    private_patterns: ["brightside"]
```

`lookback_days` controls how much history is available for the week-in-review and for the per-person event counts. `event_categories` optionally labels recurring kinds of event so the brief can cite a count rather than tallying by hand:

```yaml
    event_categories:
      - { label: Lessons, pattern: "lesson" }
```

### Gmail

Uses the same Google Cloud project as Calendar.

1. In [Google Cloud Console](https://console.cloud.google.com), go to **APIs & Services > Library**, search for **Gmail API**, and enable it.
2. You don't need new credentials — the same `secrets/credentials.json` works.

**Run the auth flow:**

```bash
yarn auth:gmail
```

Or use the dashboard: **Connectors > Gmail > Authorize**.

**Configure:**

```yaml
connectors:
  gmail:
    enabled: true
    credentials_dir: secrets
    credentials_file: credentials.json
    query: "newer_than:2d -category:promotions -category:social"
    max_messages: 40
    accounts:
      - name: Person 1
      - name: Person 2
```

The `query` field uses [Gmail search syntax](https://support.google.com/mail/answer/7190). When a query matches more than `max_messages`, the brief is told the window was cut off; raise the limit for a busy inbox.

Each email carries its thread state: `lastFromUs` is true when the household sent the latest message in the conversation, so the brief never turns an email you have already answered into a "reply to" task. One-time codes in subjects and snippets are redacted before anything is sent to the model or saved.

**Useful query patterns:**

```yaml
# Everything from the last day (minimal)
query: "newer_than:1d"

# Skip promotions, social, and newsletters
query: "newer_than:2d -category:promotions -category:social -label:newsletter"

# Only unread
query: "newer_than:2d is:unread -category:promotions -category:social"
```

### Market

No auth needed. Uses Yahoo Finance.

```yaml
connectors:
  market:
    enabled: true
    symbols:
      - VTSAX    # Vanguard Total Stock Market
      - VTI      # Same as VTSAX but ETF
```

Add whatever tickers matter to you. A symbol is mentioned only when its weekly move reaches `move_threshold_pct` (default 3) either way, or on the day it first reaches a 52-week high or low; being near a high on its own is not news. Each ticker also pulls recent news headlines, and carries the trading day its price is from, so a Friday move is not reported again on Monday.

### Actual Budget

For self-hosted [Actual Budget](https://actualbudget.org/) users. Pulls recent transactions, spending by category, and flags categories over budget.

1. Find your **Sync ID** in Actual Budget: Settings > Show advanced settings > Sync ID.
2. Add your server password to `.env`:

```
ACTUAL_BUDGET_PASSWORD=your_server_password
```

3. Configure in `config.yaml`:

```yaml
connectors:
  actual_budget:
    enabled: true
    server_url: https://budget.your-server.com/budget
    password_env: ACTUAL_BUDGET_PASSWORD
    sync_id: "your-sync-id-here"
    lookback_days: 7
```

If you use end-to-end encryption, also add:

```yaml
    budget_password_env: ACTUAL_BUDGET_E2E_PASSWORD
```

### Home Assistant

Requires a long-lived access token from your HA instance.

1. In Home Assistant: Profile > Security > Long-Lived Access Tokens > Create Token.
2. Add to `.env`:

```
HA_TOKEN=your_long_lived_token
```

3. Configure:

```yaml
connectors:
  home_assistant:
    enabled: true
    url: http://homeassistant.local:8123
    token_env: HA_TOKEN
    entities: []    # empty = scan all sensors
```

With `entities: []`, the connector pulls all sensor states. This can produce a large payload (~18K tokens). To reduce it, list specific entities:

```yaml
    entities:
      - sensor.front_door_lock
      - sensor.garage_door
      - sensor.indoor_temperature
      - sensor.washer_status
```

### Aviation Weather

For pilots. Pulls METAR and TAF data from aviationweather.gov.

```yaml
connectors:
  aviation_weather:
    enabled: true
    stations:
      - KDEN    # Denver International
      - KBJC    # Rocky Mountain Metro
```

Use [ICAO airport codes](https://www.world-airport-codes.com/).

---

## Step 5: Describe the household

### Who lives here

List everyone the brief is about in `household` — including people who have no
calendar, inbox or task list of their own:

```yaml
household:
  - name: Person 1
    role: self
  - name: Person 2
    role: partner
  - name: Person 3
    role: guest
    notes: Staying with us this year; has no accounts of their own.
```

This matters more than it looks. Without an entry, the only people the brief
knows about are the ones with connector accounts, so anyone else is invisible —
their events get read as belonging to whoever's calendar happens to carry them.

`name` should match the corresponding `accounts[].name` under each connector.
Where they differ, link them explicitly:

```yaml
  - name: Person 1
    calendar_account: p1-personal
    todoist_account: p1
```

### What to know about them

The `context` block is free-form and gets injected into Claude's prompt so it
can make connections.

```yaml
context:
  people: "Alex (32) and Jordan (30)."

  work: >
    Alex is a nurse, 3x12hr shifts (Mon/Wed/Fri this month).
    Jordan is a remote software engineer.

  health: >
    Jordan has ADHD — keep brief scannable, flag inbox buildup.

  hobbies: >
    Alex is training for a marathon (Oct 12, 2026).
    Jordan is learning piano.

  travel: >
    Family trip to Japan, June 1-14, 2026. Flag packing
    reminders when under 7 days.
```

**What to include:** Names, ages, roles, work schedules, health/accessibility needs, key dates with absolute dates, recurring patterns, preferences.

**What not to include:** Anything that changes daily (connectors handle that), passwords (use `.env`), excessively long text (counts toward input tokens).

---

## Step 6: Test everything

**From the CLI:**

```bash
# Test all enabled connectors
yarn tsx src/cli.ts --test

# Test specific connectors
yarn tsx src/cli.ts --test weather todoist

# See the exact JSON payload Claude will receive
yarn tsx src/cli.ts --show-data

# List all registered connectors
yarn tsx src/cli.ts --list-connectors
```

**From the dashboard:** Navigate to any connector's detail page to see live validation checks, config summary, and auth status.

**What to look for:**

| In the output | What it means |
|---|---|
| Green checkmarks on Fetch | Connector is working |
| Red X on Fetch | API error — check credentials, config, or network |
| "Very large payload" warning | Consider trimming that connector's data |
| Total input tokens | Your cost driver. Under 10K is good. Over 20K, trim something. |

---

## Step 7: Generate your first brief

**CLI:**

```bash
yarn preview
```

**Dashboard:** Click "Generate Now" on the Dashboard page, then view the result in the Briefs section.

This fetches all data, sends it to Claude, generates a PDF, and saves it to `output/`. Review the PDF.

**Things to check on the first brief:**

- Are the right sections showing up?
- Is Claude making useful observations in the Executive Brief?
- Are tasks attributed to the right person?
- Is anything missing or noisy?

**Tuning points:**

| What to change | Where |
|---|---|
| Which data Claude sees | `config.yaml` connectors |
| How Claude interprets data | Connector `description` field in source code |
| What Claude generates | `src/prompts/system.md` |

---

## Step 8: Set up your printer (optional)

Find your CUPS printer name:

```bash
lpstat -p -d
```

Add it to `config.yaml`:

```yaml
printer: "Your_Printer_Name"
```

Test a full print run:

```bash
yarn print
```

---

## How the brief improves over time

Three mechanisms carry information from one day into the next, and one checks
each brief before it prints. All of them live under `output/` and none need
setting up.

### Memory

After each brief, Claude extracts the open loops worth carrying forward — a
delivery in transit, a bill or form with a due date, an appointment mentioned
only in email, a reply being waited on — into
`output/memory/memory_YYYY-MM-DD.json`. Each fact carries an `until` date and is
dropped after it, and only the last seven calendar days are ever loaded. Counts,
the language phrase, markets and weather are never remembered.

Memory is not treated as evidence: the prompt tells Claude to take facts only
from today's live data and to use memory just to follow an item across days.

### Review before printing

Every brief is checked before it is rendered:

- **Duplication is removed in code.** An Executive Brief item whose words are
  mostly one task's or email's words is that item again, and is dropped.
- **Facts are checked against the data.** The housekeeping model looks for statements
  the data contradicts, and must quote the wrong words, quote the data that
  contradicts them, and give the replacement. A correction is applied — as an
  exact string replacement — only when both quotes are found where they should
  be. The language line and the task coach's sections are never touched.

What the review did is written to `output/feedback/review_YYYY-MM-DD.json` for
you to read; it is not fed back to the writer. To check an existing brief
against the data it was written from:

```bash
yarn review              # today's brief
yarn review 2026-08-22   # a specific date
```

### Your own feedback

Put plain-language notes about what you want in `feedback_notes` in
`config.yaml` (or in a `feedback.md` beside the process — copy
`feedback.example.md`). They are given to the writer every morning until you
remove them:

```yaml
feedback_notes: |
  - Group tasks by theme instead of listing randomly
  - Don't mention weather unless it affects outdoor plans
```

---

## Task coach

The task coach turns the task list into a plan for the day. Turn it on and
tune it in `config.yaml`:

```yaml
task_coach:
  enabled: true
  focus_per_person: 3   # tasks per person to put in Today's Focus
  max_decide: 3         # stuck tasks to make a call on each day
  capture: true         # add actions found in email/calendar to Todoist
  max_captures: 3
  capture_label: callsheet
  schedule_focus: true  # set undated, non-recurring focus picks to due today
```

Each morning Claude returns, alongside the brief:

- **focus** — the few tasks per person that matter most today, with a time slot
  taken from that person's free time (the calendar connector computes it);
- **decide** — for tasks that are not moving (overdue for a week or more,
  rescheduled three times, in an inbox for two weeks, untouched for two months,
  or picked as a focus three times without being done), one recommendation:
  schedule, first step, hand off, or drop;
- **capture** — actions found in email or the calendar that are not tasks yet;
- **capture prompts** — a question or two that jogs memory for tasks nobody
  wrote down.

Callsheet checks the plan against your Todoist data — a pick must be a real
task of that person's, a decision must be about a stuck task — and then adds
the captures to the person's Todoist inbox under `capture_label`, sets undated
focus picks to today, and prints it all with yesterday's score. A capture is
skipped when an open task already says much the same thing, and is never
re-added once made, even if you delete it. Nothing is ever deleted, closed or
rewritten (closing is `auto_close_tasks`' job, and it needs proof), and nothing
is written on a dashboard preview. The coach keeps its records in
`output/tasks/`.

To keep a project that an automation fills (say, one a monitoring job writes
tasks into) from crowding the page, summarise it instead of listing it:

```yaml
connectors:
  todoist:
    collapse_projects: [Automation]
```

---

## Other configuration

| Key | Default | What it does |
| --- | --- | --- |
| `timezone` | `TZ` env, then system | IANA zone for the brief's date, filenames, connector windows and the scheduler. Set it explicitly. |
| `auto_close_tasks` | `false` | Closes Todoist tasks that an email or transaction proves are done. Each closure must quote its evidence, which is checked before anything is touched; at most three per run, and only on real runs: a preview never closes anything. Closures are logged and reported in the next brief. |
| `task_coach` | off | Focus picks, stuck-task decisions and captures — see [Task coach](#task-coach). |
| `weekly_review_day` | off | Day name or `0`-`6` for a short week-in-review section at the top of that day's brief, and a Housekeeping list of stale `context` entries. |
| `vacation` | none | Date ranges where brief generation is skipped, inclusive on both ends. Honoured by both the in-container scheduler and the CLI. Pass `--force` to generate anyway. |
| `notify_webhook` | none | URL posted to as `{title, message}` when a brief can't be written, isn't printed, gets stuck in the print queue, or a connector fails two scheduled mornings running. One short ASCII line, so it survives an SMS gateway. |
| `heartbeat_url` | none | Fetched after every scheduled run that produced and printed a brief — e.g. a healthchecks.io check, as a dead-man's switch for runs that never start. |
| `feedback_notes` | none | Your own notes to the writer (see [Your own feedback](#your-own-feedback)). |
| `living_context` | off | Learn household changes from the data, with evidence (see [Living context](#living-context)). |
| `connector_timeout_ms` | `60000` | Per-connector deadline. A connector that hangs past this is abandoned and noted in the brief. |

```yaml
timezone: America/New_York
auto_close_tasks: true
weekly_review_day: saturday
notify_webhook: http://relay.example.com/notify
heartbeat_url: https://hc-ping.com/<your-check-uuid>
vacation:
  - { start: "2026-07-01", end: "2026-07-14" }
```

### Context that expires

`context` entries are prose about the household. Plans change, so an entry can
carry the last day it is true:

```yaml
context:
  people: Two adults, a teenager and a dog.
  trip:
    text: Away July 1-14 — the house is empty, pause deliveries.
    until: "2026-07-14"
```

An expired entry is left out. A prose entry whose dates have all passed (for
example "trip May 7-25, 2026" in August) is still given to the writer but
marked as history, and the weekly review day lists it under Housekeeping so
you can update it.

### Living context

Prose goes stale in ways no date can predict — a job ends, an exam is
passed, a trip is booked. Turn on the living context and callsheet keeps up
with it from the data:

```yaml
living_context:
  enabled: true
  ignore: []        # text fragments; a learned fact containing one is vetoed
```

Each real run, the housekeeping model compares your context with the morning's data and
proposes changes: a fact the data establishes ("accepted an offer at …", "trip
booked for Dec 3-8"), retiring a fact it learned earlier that has stopped
being true, or flagging a `context` entry the data contradicts. Every proposal
must quote the email, event or task behind it, and the quote is checked against
the data before anything is kept; at most three facts change per run. Learned
facts are given to the writer as recent changes that take precedence over the
older context, carry an expiry (the trip's last day, otherwise 60 days), and
live in `output/context/living.json`.

Your `config.yaml` is never edited. What changed is printed under Housekeeping
on the day it changed — "Learned: …", "No longer true: …", "Update the "work"
context in config.yaml" — so you can see what callsheet now believes, and a
flagged entry stays on the weekly Housekeeping list until you edit it. If it
learned something wrong, add a fragment of it to `ignore`.

### Delivery status

Every run is recorded in `output/status.json`: when it ran, what started it,
whether the brief was written, and how printing went. `GET /api/status`
answers `503` when the household did not get its brief — the last scheduled run
produced an error page or failed to print, or a run that was due never happened
— and `200` otherwise (`degraded` when a print job sat in the queue). Point an
uptime monitor at it. `GET /api/health` is a liveness check only, so an image
updater never rolls back a working container because the printer is out of
paper.

---

## Docker reference

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `headless_docker` | `headless_docker` or `headed_docker` |
| `CRON_SCHEDULE` | `30 6 * * *` | Cron expression for brief generation |
| `TZ` | `UTC` | Timezone for scheduling (set to your local zone, e.g. `America/Denver`) |
| `CONFIG_PATH` | `config.yaml` | Path to config file inside container |
| `OUTPUT_DIR` | `output` | Path to output directory inside container |
| `PORT` | `3000` | Dashboard port (headed mode only) |
| `PRINT_BRIEF` | `true` | Set to `false` to generate without printing |
| `CUPS_SERVER` | none | Where `lp` finds CUPS, e.g. `/run/cups/cups.sock` or `host:631` |
| `CATCHUP_HOURS` | `6` | How long after a missed scheduled time a brief is still produced late; `0` disables catch-up |

### Volumes

| Mount | Purpose |
|-------|---------|
| `./config.yaml:/app/config.yaml:ro` | Your configuration |
| `./output:/app/output` | Brief output, memory, usage data, logs |
| `./secrets:/app/secrets` | OAuth tokens and API credentials (writable: token refreshes persist) |
| `/run/cups:/run/cups:ro` | The host's CUPS directory, for printing through the host — mount the **directory**, not `cups.sock` |

Mount the CUPS directory rather than the socket file. A single-file bind mount
binds the file's inode, and CUPS recreates its socket whenever it restarts (on
many distributions, every night when its logs rotate): the container keeps the
dead socket and every print fails with "The printer or class does not exist",
about a printer that is idle on the host.

### Building

```bash
docker compose build                  # Headless
docker compose -f docker-compose.yml -f docker-compose.headed.yml build  # Headed
```

---

## Troubleshooting

### "Config not found"
You need a `config.yaml` in the project root. Copy from the example: `cp config.example.yaml config.yaml`

### "ANTHROPIC_API_KEY not set"
Add your key to `.env`. Make sure there are no spaces around the `=` sign.

### "Credit balance too low"
Your Anthropic account needs credits. Go to [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing) to add funds. $5 covers hundreds of briefs.

### Google OAuth "This app isn't verified"
Normal for personal projects. Click "Advanced" > "Go to (app name)".

### Google OAuth "redirect_uri_mismatch"
The auth flow uses a local server on port 3000. Make sure nothing else is using that port. If running remotely over SSH, set up port forwarding.

### Todoist returning 410 Gone
The Todoist REST API v2 has been deprecated. Callsheet uses the current `/api/v1/` endpoint. Make sure you're on the latest version.

### Aviation weather timeout
The aviationweather.gov API can be slow (30s timeout). If it persists, check [aviationweather.gov](https://aviationweather.gov) directly.

### Home Assistant "Very large payload"
With `entities: []`, all sensors are pulled. Filter to specific entities to keep the payload under ~4K tokens.

### PDF is too dense / text is cut off
Claude is generating too much content. Trim connectors, tighten the prompt in `src/prompts/system.md`, or reduce `max_messages` for Gmail.

### Brief is too sparse
Add more household context in `config.yaml`. If you moved the brief to a cheaper model, switching back to Fable 5.1 gives richer analysis.

---

## Understanding costs

Every brief makes five Claude API calls: the brief itself, plus four housekeeping passes on Opus 5.5 (living context review, memory extraction, fact check, auto-close). The dashboard tracks costs in the **Usage** page.

Run `--test` to see your specific token breakdown:

```
Token budget breakdown:
  Connector data:   ~5,000 tokens
  System prompt:    ~1,200 tokens
  Household context:~900 tokens
  Total input:      ~7,100 tokens
  Est. output:      ~1,500 tokens
```

Each housekeeping pass reads most of the day's data again, so together they
send about two and a half times the brief's input, on Opus 5.5 whichever model
writes the brief.

Rough monthly costs at one brief/day, including those passes:

| Brief input tokens | Fable 5.1 | Opus 5.5 | Sonnet 5.5 |
|---|---|---|---|
| ~20K (light) | ~$26 | ~$12 | ~$10 |
| ~50K (typical) | ~$44 | ~$24 | ~$21 |
| ~85K (busy) | ~$65 | ~$39 | ~$33 |

The biggest cost lever is connector data volume. Home Assistant with all sensors can easily be 15K+ tokens. Filter to specific entities to keep costs down.
