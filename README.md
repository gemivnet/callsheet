![CI](https://github.com/gemivnet/callsheet/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/gemivnet/callsheet/graph/badge.svg)](https://codecov.io/gh/gemivnet/callsheet)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)
![License](https://img.shields.io/github/license/gemivnet/callsheet)
![Last Commit](https://img.shields.io/github/last-commit/gemivnet/callsheet)

# Callsheet

**Your household's daily brief — fetched, prioritized, and printed by AI.**

In the film industry, a *call sheet* is the single page that tells everyone on set where to be, what's happening, and what to prepare for. This is that, but for your home.

Think of it as a Presidential Daily Brief for home life. Callsheet pulls data from your calendar, tasks, email, weather, budget, and other sources — feeds it all to Claude — and Claude decides what actually matters today. The result is a single printed page on the counter every morning. Not everything that's happening. Just what you need to know.

It's opinionated by design. Claude acts as an analyst, not a formatter — connecting dots across sources ("your flight lesson is at 9 AM but the ceiling drops to 1200 by then"), filtering noise (routine emails, unremarkable weather), and surfacing what needs action now. Quiet days get short briefs. Busy days get dense ones.

Built for ADHD households, busy couples, and anyone who's tired of context-switching between twelve apps before coffee.

<p align="center">
  <img src="docs/example-brief.png" alt="Example callsheet brief" width="600" />
</p>

---

## How it works

```
cron (6:30 AM) or web dashboard trigger
  → callsheet
    → connectors fetch data (calendar, tasks, email, weather, ...)
    → Claude reads everything, decides what matters
    → outputs structured JSON brief
    → @react-pdf/renderer renders to PDF
    → CUPS sends to your printer (or view in dashboard)
```

**Claude is the analyst.** It doesn't format your data into a template — it makes judgment calls. Flight lesson on the calendar + TAF showing ceiling dropping to 1200 at lesson time = *"Ceiling forecast MVFR at 9 AM — confirm with your CFI."* Billing email from Phone plan yesterday + no renewal task = *"Renew Phone plan today before auto-suspend."* Fourteen items building up in someone's inbox = *"Process inbox tonight?"* Unremarkable weather on a day with no outdoor plans? Not mentioned.

## What the brief looks like

A single-page PDF — every item earns its spot:

- **Executive Brief** — Claude's cross-referenced intelligence: conflicts, weather impacts, email signals, deadline countdowns, budget alerts, logistics
- **Today's schedule** — calendar events with locations and travel time context
- **Tasks** — prioritized by what's urgent *today*, not Todoist order. Checkboxes you mark with a pen
- **Email highlights** — only actionable emails, not a list of everything received
- **Upcoming** — things this week that need preparation, collapsed where repetitive

Sections adapt to the day. Quiet Tuesday? Half-page brief. Packed Thursday before a trip? Dense and focused. Claude doesn't manufacture importance to fill space.

**Memory across days:** After each brief, Claude extracts key insights and saves them. The next day's brief tracks deliveries, follows up on deadlines, and avoids repeating stale observations.

**Brief diff:** Yesterday's brief is summarized as context so Claude highlights what's new or changed.

## Getting started

See the **[Getting Started Guide](docs/SETUP_GUIDE.md)** for full setup instructions covering all deployment methods, connector configuration, and troubleshooting.

## Connectors

Connectors are pluggable data sources. Enable them in `config.yaml`, test with `--test`.

| Connector | What it does | Auth |
|-----------|-------------|------|
| `google_calendar` | Today's events + 7-day lookahead | Google OAuth |
| `todoist` | Tasks, inbox, upcoming (multi-account) | API token |
| `gmail` | Scans recent emails for actionable signals | Google OAuth |
| `weather` | Today's forecast via NWS | None (free) |
| `aviation_weather` | METAR/TAF for nearby airports | None (free) |
| `home_assistant` | Smart home sensor states + anomalies | HA token |
| `market` | Stock/fund daily snapshot + news | None (free) |
| `actual_budget` | Recent transactions, spending, budget alerts | Server password |

### Writing your own

Create a file in `src/connectors/`, export a `create` factory function, and register it in `src/connectors/index.ts`. See [docs/CONNECTORS.md](docs/CONNECTORS.md).

## Customization

### Three things you tune

| File | What it does |
|------|-------------|
| `config.yaml` | Which connectors are on, accounts, API settings |
| `src/prompts/system.md` | Claude's instructions — sections, tone, what to flag |
| `config.yaml > context:` | Household info so Claude makes smarter connections |

### Household context

The `context:` block in your config gets injected into Claude's prompt:

```yaml
context:
  people: "Alex and Jordan"
  adhd: "Jordan has ADHD — keep it scannable, flag inbox buildup"
  work: "Alex is a nurse, 3x12hr shifts. Jordan is remote."
  hobbies: "Both learning pottery. Alex runs marathons."
  bills: "Phone plan bills monthly, needs manual renewal next day"
  travel: "Family trip to Japan, June 1-14. Flag packing under 7 days."
  deadlines: "Jordan's thesis due April 30. Bar exam July 2026."
```

### The prompt

`src/prompts/system.md` controls what Claude generates. Want a word-of-the-day? Add a section. Want Claude to ignore market data unless it drops 5%? Change the threshold.

### The PDF layout

`src/render.tsx` controls the visual design using React components and `@react-pdf/renderer`. Modify the `StyleSheet.create()` styles to change fonts, spacing, colors, or page size.

## Architecture

```
callsheet/
├── src/
│   ├── cli.ts                     # CLI entry point
│   ├── core.ts                    # Orchestrator: fetch → Claude → PDF → print
│   ├── server.ts                  # Express API server
│   ├── scheduler.ts               # node-cron wrapper for Docker modes
│   ├── entrypoint.ts              # Docker MODE dispatcher
│   ├── usage.ts                   # API cost tracking
│   ├── render.tsx                 # React PDF components + styling
│   ├── test-connectors.ts        # Connector test runner
│   ├── types.ts                   # Shared TypeScript interfaces
│   ├── connectors/
│   │   ├── index.ts               # Registry + loader
│   │   ├── google-auth.ts
│   │   ├── google-calendar.ts
│   │   ├── todoist.ts
│   │   ├── gmail.ts
│   │   ├── weather.ts
│   │   ├── aviation-weather.ts
│   │   ├── market.ts
│   │   ├── home-assistant.ts
│   │   └── actual-budget.ts
│   └── prompts/
│       └── system.md              # Claude's instructions (tune this!)
├── web/
│   ├── build.mjs                  # esbuild bundler
│   ├── public/index.html
│   └── src/
│       ├── App.tsx                # SPA shell with sidebar nav
│       ├── pages/                 # Dashboard, Briefs, Connectors, etc.
│       └── styles.css
├── docs/
│   └── CONNECTORS.md              # How to write connectors
├── docker-compose.yml             # Headless mode (cron only)
├── docker-compose.headed.yml      # Override: adds dashboard on port 3000
├── Dockerfile
├── config.example.yaml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

## Cost

At ~2K input + ~1.5K output tokens per brief:

| Model | Per brief | Per month |
|-------|-----------|-----------|
| Sonnet | ~$0.02 | ~$0.60 |
| Opus | ~$0.15 | ~$4.50 |

## Why this exists

### Why print?

A physical page on the counter gets looked at. An app in a notification drawer doesn't. For ADHD, the brief is ambient, visible, and requires zero activation energy — it's just *there*.

### Why AI, not a template?

A template gives you a formatted list of your data — a dashboard. Claude gives you *"Your flight lesson is at 9 but the TAF shows ceiling dropping to 1200 by then — call your CFI."* The difference is judgment. A template shows you everything. An analyst shows you what matters. Callsheet is an analyst.

### Why connectors, not just APIs?

Every household is different. The connector pattern means you write a TypeScript file, export a factory, register it, and it works. But this isn't meant to be a catch-all — more connectors doesn't mean a better brief. Add sources that give Claude meaningful signal. Skip sources that add noise.

### Can I use this without a printer?

Yes. `--preview` saves the PDF. Email it, display it on a tablet, show it on a dashboard — whatever works.

## Contributing

PRs welcome — especially new connectors. See [docs/CONNECTORS.md](docs/CONNECTORS.md).

Some ideas: Slack, GitHub, Fitbit, Anki, Radarr/Sonarr, Notion, CalDAV, garbage/recycling schedules, Withings, Oura Ring, air quality.

## License

[AGPL-3.0](LICENSE) — free to use, modify, and distribute, but derivative works (including network use) must remain open source.
