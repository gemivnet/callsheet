# Setup Guide

A step-by-step walkthrough for getting Callsheet running from scratch. Assumes you're comfortable with a terminal but haven't necessarily set up API keys or OAuth flows before.

---

## Prerequisites

- **Node.js 20+** — check with `node --version`. Install via [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org).
- **A printer** (optional) — any CUPS-compatible printer works. You can use `--preview` mode without one.
- **An Anthropic API key** — sign up at [console.anthropic.com](https://console.anthropic.com) and add credits ($5 is enough for months of daily briefs).

## Step 1: Clone and install

```bash
git clone https://github.com/gemivnet/callsheet.git
cd callsheet
npm install
```

## Step 2: Create your config files

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

You now have two files to edit:

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
model: claude-sonnet-4-20250514

# Deeper reasoning, better cross-referencing (~$0.15-0.20/day)
model: claude-opus-4-6
```

Start with Sonnet. Switch to Opus after you've dialed in your connectors and context — the quality difference is noticeable in the Executive Brief section, where Claude connects dots across data sources.

## Step 4: Enable connectors

Start simple. You don't need all seven connectors on day one. Pick 1-2 to start:

### Suggested starting order

1. **Weather** — zero auth, instant gratification
2. **Todoist** — quick API token, shows tasks immediately
3. **Google Calendar** — OAuth flow, but high value
4. **Gmail** — reuses the same Google credentials
5. **Market** — zero auth, nice-to-have, includes related news per ticker
6. **Actual Budget** — if you use Actual Budget for finances
7. **Home Assistant** — if you run HA
8. **Aviation Weather** — if you fly

### Weather (no auth required)

The fastest way to verify the system works end-to-end.

1. Find your coordinates (search "lat lon" + your city, or use Google Maps → right-click → copy coordinates).
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
npx tsx src/cli.ts --test weather
```

You should see a green checkmark for Fetch, plus a data tree showing temperature, wind, and forecast periods. If this works, your setup is correct.

> **Note:** The NWS API only covers US locations. For international weather, you'd need to write a connector using a different API (OpenWeatherMap, etc.).

### Todoist

1. Go to [Todoist Settings → Integrations → Developer](https://todoist.com/app/settings/integrations/developer) and copy your API token.
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
npx tsx src/cli.ts --test todoist
```

The output shows tasks grouped by `today` (due today + overdue), `inbox` (unprocessed items), `upcoming` (next 7 days), and `backlog` (no due date, across all projects).

### Google Calendar

This requires a one-time OAuth setup. It takes about 5 minutes.

**Create Google Cloud credentials:**

1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (or use an existing one).
3. Go to **APIs & Services → Library**, search for **Google Calendar API**, and enable it.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth Client ID**.
5. Application type: **Desktop app**. Name it whatever you want.
6. Download the JSON file and save it as `secrets/credentials.json`:

```bash
mkdir -p secrets
# Move your downloaded file:
mv ~/Downloads/client_secret_*.json secrets/credentials.json
```

**Run the auth flow:**

```bash
npx tsx src/cli.ts --auth google_calendar
```

This opens a browser window. Sign in, grant calendar read access, and the token is saved automatically to `secrets/token_calendar.json`.

> **"This app isn't verified" warning:** This is normal for personal projects. Click "Advanced" → "Go to (your app name)" to continue. Google shows this for any OAuth app that hasn't gone through their review process.

**Configure which calendars to pull:**

```yaml
connectors:
  google_calendar:
    enabled: true
    credentials_dir: secrets
    calendar_ids:
      - primary
    lookahead_days: 7
```

`primary` is your main calendar. To add shared or subscribed calendars, you need their calendar IDs. The easiest way to find them:

- **Google Calendar web** → Settings → click the calendar → "Integrate calendar" → Calendar ID
- Or check what's available in your account by looking at your Google Calendar settings

Common calendar IDs:
- `primary` — your main calendar
- `en.usa#holiday@group.v.calendar.google.com` — US holidays
- Shared calendars look like `c_abc123@group.calendar.google.com`

Test:

```bash
npx tsx src/cli.ts --test google_calendar
```

### Gmail

Uses the same Google Cloud project as Calendar.

1. In [Google Cloud Console](https://console.cloud.google.com), go to **APIs & Services → Library**, search for **Gmail API**, and enable it.
2. You don't need new credentials — the same `secrets/credentials.json` works.

**Run the auth flow:**

```bash
npx tsx src/cli.ts --auth gmail
```

**Configure:**

```yaml
connectors:
  gmail:
    enabled: true
    credentials_dir: secrets
    query: "newer_than:2d -category:promotions -category:social"
    max_messages: 25
```

The `query` field uses [Gmail search syntax](https://support.google.com/mail/answer/7190). The default filters out promotions and social tabs and only looks at the last 2 days.

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

Add whatever tickers matter to you. Claude only mentions market data if there's a notable move (>2% weekly change by default), so this is low-noise. Each ticker also pulls recent news headlines — Claude will surface anything significant.

### Actual Budget

For self-hosted [Actual Budget](https://actualbudget.org/) users. Pulls recent transactions, spending by category, and flags categories that are over or on pace to exceed their monthly budget.

**Important:** Actual Budget uses an NPM package (`@actual-app/api`), not a REST API. It's already included as a dependency.

1. Find your **Sync ID** in Actual Budget: Settings → Show advanced settings → Sync ID.
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

4. Test:

```bash
npx tsx src/cli.ts --test actual_budget
```

The output shows recent transactions, spending by category, and any **budget alerts** — categories where spending has exceeded the monthly budget or is on pace to exceed it. Claude surfaces these in the Executive Brief when they're significant.

### Home Assistant

Requires a long-lived access token from your HA instance.

1. In Home Assistant: Profile → Security → Long-Lived Access Tokens → Create Token.
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

With `entities: []`, the connector pulls all sensor states. This can produce a large payload (~18K tokens if you have hundreds of devices). To reduce it, list specific entities:

```yaml
    entities:
      - sensor.front_door_lock
      - sensor.garage_door
      - sensor.indoor_temperature
      - sensor.washer_status
```

**Tip:** Run `--test home_assistant` and look at the "Token estimate" section. If it says "Very large payload", consider filtering to specific entities.

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

Use [ICAO airport codes](https://www.world-airport-codes.com/). Pick your home airport and training airports.

## Step 5: Add household context

The `context` block in `config.yaml` is what makes Callsheet genuinely useful instead of just a formatted data dump. This gets injected into Claude's prompt so it can make connections.

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

**What to include:**

- Names, ages, roles — helps Claude personalize
- Work schedules — "In Office" calendar events get flagged as commute days
- Health/accessibility needs — ADHD, medication reminders, etc.
- Key dates with absolute dates — Claude calculates countdowns automatically
- Recurring patterns — "Tello bills monthly, needs manual renewal next day"
- Preferences — "Skip market unless weekly swing > 3%"

**What not to include:**

- Anything that changes daily (that's what connectors are for)
- Passwords or tokens (use `.env`)
- Excessively long text (this counts toward input tokens)

## Step 6: Test everything

Run the full diagnostic:

```bash
npx tsx src/cli.ts --test
```

This tests every enabled connector and shows:
- Whether config and credentials are valid
- Whether each API responds
- What data comes back (with a tree view)
- Token estimates per connector and overall
- Estimated cost per brief

**What to look for:**

| In the output | What it means |
|---|---|
| Green checkmarks on Fetch | Connector is working |
| Red X on Fetch | API error — check credentials, config, or network |
| "Very large payload" warning | Consider trimming that connector's data |
| Total input tokens | Your cost driver. Under 10K is good. Over 20K, trim something. |

**Other useful commands:**

```bash
# Test specific connectors only
npx tsx src/cli.ts --test weather todoist

# See the exact JSON payload Claude will receive
npx tsx src/cli.ts --show-data

# List all registered connectors
npx tsx src/cli.ts --list-connectors
```

## Step 7: Generate your first brief

```bash
npx tsx src/cli.ts --preview
```

This fetches all data, sends it to Claude, generates a PDF, and saves it to `output/` without printing. Open the PDF and review it.

**Things to check on the first brief:**

- Are the right sections showing up?
- Is Claude making useful observations in the Executive Brief section?
- Are tasks attributed to the right person?
- Is anything missing that should be there?
- Is anything showing up that's noise?

If something's off, the three tuning points are:

| What to change | Where |
|---|---|
| Which data Claude sees | `config.yaml` connectors |
| How Claude interprets data | Connector `description` field in source code |
| What Claude generates | `src/prompts/system.md` |

## Step 8: Set up your printer

Find your CUPS printer name:

```bash
lpstat -p -d
```

This lists all printers. The name is the first field (e.g., `Brother_MFC_L8900CDW_series`). Add it to `config.yaml`:

```yaml
printer: "Brother_MFC_L8900CDW_series"
```

Test a full print run:

```bash
npx tsx src/cli.ts
```

## Step 9: Schedule with cron

Build for production:

```bash
npm run build
```

Set up a daily cron job:

```bash
crontab -e
```

Add a line like:

```
30 6 * * * cd /path/to/callsheet && /usr/bin/node dist/cli.js >> output/cron.log 2>&1
```

This runs at 6:30 AM every day. Adjust the time to whenever you want your brief ready.

**Tips for cron:**

- Use absolute paths — cron doesn't have your shell's PATH.
- The `>> output/cron.log 2>&1` part captures output for debugging.
- Make sure your `.env` file is in the project root (it's loaded relative to the working directory).
- If your printer is a network printer, make sure the machine running cron can reach it.

## Troubleshooting

### "Config not found"
You need a `config.yaml` in the project root. Copy from the example: `cp config.example.yaml config.yaml`

### "ANTHROPIC_API_KEY not set"
Add your key to `.env`. Make sure there are no spaces around the `=` sign.

### "Credit balance too low"
Your Anthropic account needs credits. Go to [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing) to add funds. $5 covers hundreds of briefs.

### Google OAuth "This app isn't verified"
Normal for personal projects. Click "Advanced" → "Go to (app name)".

### Google OAuth "redirect_uri_mismatch"
The auth flow starts a local server on port 3000. Make sure nothing else is using that port. If you're running remotely (SSH), you'll need to set up port forwarding.

### Todoist returning 410 Gone
The Todoist REST API v2 has been deprecated. Callsheet uses the current `/api/v1/` endpoint. If you see this error, make sure you're on the latest version of the code.

### Aviation weather timeout
The aviationweather.gov API can be slow. The timeout is set to 30 seconds. If it still times out, the API may be having issues — check [aviationweather.gov](https://aviationweather.gov) directly.

### Home Assistant "Very large payload"
With `entities: []`, the connector pulls all sensors. If you have a large HA installation, specify the entities you care about to keep the payload under ~4K tokens.

### PDF is too dense / text is cut off
Claude is generating too much content for one page. Options:
- Trim connectors (fewer data sources = shorter brief)
- Edit `src/prompts/system.md` to be stricter about brevity
- Reduce `max_messages` for Gmail, or narrow the query

### Brief is too sparse
Add more household context in `config.yaml`. The more Claude knows about your life, the better it connects dots. Also consider switching from Sonnet to Opus for richer analysis.

## Understanding costs

Every brief makes one Claude API call. Cost depends on input tokens (your data) + output tokens (the brief).

Run `--test` to see your specific breakdown:

```
Token budget breakdown:
  Connector data:   ~5,000 tokens
  System prompt:    ~1,200 tokens
  Household context:~900 tokens
  Total input:      ~7,100 tokens
  Est. output:      ~1,500 tokens
```

Rough monthly costs at one brief/day:

| Input tokens | Sonnet/month | Opus/month |
|---|---|---|
| ~5K (minimal) | ~$0.60 | ~$4.50 |
| ~10K (typical) | ~$1.50 | ~$8.00 |
| ~20K (heavy) | ~$3.00 | ~$15.00 |

The biggest cost lever is connector data volume. Home Assistant with all sensors can easily be 15K+ tokens on its own. Filter to specific entities if you want to keep costs down.
