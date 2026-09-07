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
# Fast and cheap (~$0.02-0.04/day)
model: claude-sonnet-5

# Deeper reasoning, better cross-referencing (~$0.15-0.20/day)
model: claude-opus-5
```

Start with Sonnet. Switch to Opus after you've dialed in your connectors and context — the quality difference is noticeable in the Executive Brief section, where Claude connects dots across data sources.

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
    max_messages: 25
    accounts:
      - name: Person 1
      - name: Person 2
```

The `query` field uses [Gmail search syntax](https://support.google.com/mail/answer/7190).

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

Add whatever tickers matter to you. Claude only mentions market data if there's a notable move (>2% weekly change by default). Each ticker also pulls recent news headlines.

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
printer: "Brother_MFC_L8900CDW_series"
```

Test a full print run:

```bash
yarn print
```

---

## How the brief improves over time

Three mechanisms feed information from one day's brief into the next. All of
them live under `output/` and none need setting up.

### Memory

After each brief, Claude extracts a handful of facts worth carrying forward —
ongoing situations, things to follow up on — into
`output/memory/memory_YYYY-MM-DD.json`. The last seven days are injected into
the next prompt; older files are pruned automatically. Counts and tallies are
deliberately excluded, since they are only true on the day they were computed.

Memory is not treated as truth: the prompt tells Claude to prefer today's live
connector data wherever the two disagree.

### Self-critique

A second, cheaper pass reviews each finished brief against the raw data it was
built from and writes what it finds to `output/feedback/critique_*.json`. It
checks for factual errors first — a number that does not match the data, an
identifier that appears nowhere in it — then for duplication, grouping,
verbosity and stale items. When the same category recurs on three or more days
out of seven, it is surfaced to the next brief as a recurring pattern.

This runs after the brief is written, so it improves tomorrow rather than
today.

### Your own feedback

Create `feedback.md` in the project root (copy `feedback.example.md`) and write
plain-language notes about what to change. They are injected into every prompt
until you delete them:

```markdown
## Active feedback

- Group tasks by theme instead of listing randomly
- Don't mention weather unless it affects outdoor plans
```

To re-run the critique against an existing brief without generating a new one:

```bash
yarn review              # yesterday's brief
yarn review 2026-08-22   # a specific date
```

---

## Other configuration

| Key | Default | What it does |
| --- | --- | --- |
| `timezone` | `TZ` env, then system | IANA zone for the brief's date, filenames, connector windows and the scheduler. Set it explicitly. |
| `auto_close_tasks` | `false` | Lets Claude close Todoist tasks that other sources prove are done. Closures are logged and reported in the next brief. |
| `weekly_review_day` | off | Day name or `0`-`6` for a short week-in-review section at the top of that day's brief. |
| `vacation` | none | Date ranges where brief generation is skipped, inclusive on both ends. Honoured by both the in-container scheduler and the CLI. Pass `--force` to generate anyway. |
| `connector_timeout_ms` | `60000` | Per-connector deadline. A connector that hangs past this is abandoned and noted in the brief. |

```yaml
timezone: America/New_York
auto_close_tasks: true
weekly_review_day: saturday
vacation:
  - { start: "2026-07-01", end: "2026-07-14" }
```

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

### Volumes

| Mount | Purpose |
|-------|---------|
| `./config.yaml:/app/config.yaml:ro` | Your configuration |
| `./output:/app/output` | Brief output, memory, usage data, logs |
| `./secrets:/app/secrets:ro` | OAuth tokens and API credentials |

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
Add more household context in `config.yaml`. Consider switching from Sonnet to Opus for richer analysis.

---

## Understanding costs

Every brief makes 3 Claude API calls (generation, memory extraction, self-critique). The dashboard tracks costs in the **Usage** page.

Run `--test` to see your specific token breakdown:

```
Token budget breakdown:
  Connector data:   ~5,000 tokens
  System prompt:    ~1,200 tokens
  Household context:~900 tokens
  Total input:      ~7,100 tokens
  Est. output:      ~1,500 tokens
```

Memory extraction and self-critique always run on Haiku and add roughly $0.03
per brief regardless of which model writes it.

Rough monthly costs at one brief/day, including those two passes:

| Input tokens | Sonnet 5/month | Opus 5/month |
|---|---|---|
| ~5K (minimal) | ~$1.50 | ~$2.00 |
| ~10K (typical) | ~$2.30 | ~$3.30 |
| ~20K (heavy) | ~$3.50 | ~$5.50 |

The biggest cost lever is connector data volume. Home Assistant with all sensors can easily be 15K+ tokens. Filter to specific entities to keep costs down.
