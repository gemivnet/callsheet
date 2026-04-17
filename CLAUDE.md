# CLAUDE.md — Codebase Instructions

These instructions apply to all work on this repository.

## 🔒 NO PII IN THE REPO — CRITICAL

This repo is a **personal intelligence brief**. It ingests calendar events, emails, financial transactions, medical appointments, travel plans, location data, and hobbies. That is exactly the kind of data that must never leak into anything checked into git — this file included.

**Never commit any of the following, anywhere — source, configs, examples, comments, JSDoc, test fixtures, commit messages, changesets, PR descriptions, or this CLAUDE.md itself:**

- Real personal names (first, last, nicknames) — not the user's, not family members', not friends', not colleagues'
- Real email addresses (the user's, household members', contacts')
- Real addresses, specific city/state, coordinates, home lat/lon
- Real phone numbers, account numbers, confirmation codes, tracking numbers
- Real vendor / merchant names tied to the user (their bank, airline, doctor, stores)
- Real dollar amounts from actual transactions
- Specific medical terms, procedure names, appointment types, conditions, medication names
- Specific travel destinations or dates tied to the user
- The specific language(s) the user is personally learning (their config overrides the repo default; treat the default as a neutral placeholder)
- Specific hobbies / activities the user does (e.g. don't name a sport, instrument, or recreational activity they happen to do — describe features structurally instead)
- Employer names, project codenames, client names, school names
- Any personalized filename (e.g. per-user config variants) — refer only to `config.yaml` and `config.example.yaml` in docs

**The hard rule:** every committed file must be **generic enough to share with a stranger on the internet**. If a stranger could read it and learn one specific non-public thing about the real user, it's PII — rewrite or remove it. **This policy file itself must obey its own rules** — do not cite real PII as "bad examples" here; use hypothetical placeholders only.

### How to write about real incidents without leaking PII

When describing a bug that was discovered in the user's live data, describe the bug **structurally**, never by the concrete data.

Hypothetical illustration (these are fabricated, not from any real session):

- ❌ "Fixed weekday labeling on Monday's <specific-procedure-from-calendar>"
- ✅ "Fixed off-by-one weekday labeling on calendar events"

- ❌ "<specific-language> word-of-the-day repeated for 3 days"
- ✅ "Phrase-of-the-day repeated for 3 days"

- ❌ "<specific-hobby> vocab on <specific-activity> days"
- ✅ "Contextual vocab tied to today's events"

- ❌ "Travel vocab as <named-destination> trip approaches"
- ✅ "Travel vocab as a trip approaches"

### Sample configs and examples

`config.example.yaml`, JSDoc examples, test fixtures, README snippets:

- Use **generic placeholders**: `"Your City, ST"`, `"Person 1"`, `"Partner"`, `test@example.com`, `shared@example.com`
- For language examples, pick a neutral common language (Spanish, French) — never mirror the user's actual target language
- For travel examples, pick a neutral destination — never mirror the user's actual plans
- For medical examples, don't use specific procedures — say "appointment" or "annual check-up"
- Never copy values from the user's real `config.yaml` into `config.example.yaml`

### Changesets

Changesets ship to the public `CHANGELOG.md` on every release. Treat every changeset as public documentation:

- Describe what the code change does, not what user data triggered it
- Use hypothetical or structural examples, never real ones from the user's dataset
- If you find yourself writing "e.g. labeling X as Y" where X/Y came from their actual brief, rewrite it

### Commit messages

Same rules as changesets — they're on the public git history forever. `git log` on this repo is public once pushed. Never include:

- Specific calendar entry names, email subjects, merchant names, amounts
- Specific medical / travel / financial / hobby details that prompted the fix
- The user's real name, email, or any direct identifier

### Memory files

The files under `~/.claude/projects/.../memory/` are **your** context — they can contain real user data, that's their purpose. **None of that leaves the memory directory.** When writing commits, changesets, code, docs, or this CLAUDE.md, pretend the memory context doesn't exist.

### Pre-push self-audit

Before every `git push`, scan the staged/outgoing diff + commit messages against the PII terms you currently hold in memory:

```
git log origin/main..HEAD --format="%B" -p | grep -iE "<pattern built from current in-memory PII terms>"
```

If anything matches, stop and rewrite. Do not build the pattern into this file — it is itself committed.

**If you realize PII already landed in a pushed commit**, immediately: (1) create a backup branch, (2) `git reset --hard` to before the bad commit, (3) rebuild the commits with the PII scrubbed, (4) force-push. The user has explicitly authorized rewriting git history for PII cleanup — do it without asking.

## Commit Style

- **Always use gitmoji prefixes** on commit messages (e.g. `🧪 Add tests`, `🐛 Fix bug`, `📦 Add dependency`)
- Common gitmojis: 🐛 bug fix, ✨ new feature, 🧪 tests, 📝 docs, 🔧 config, 📦 deps, 🚀 deploy, ♻️ refactor, 🧹 cleanup, 💄 UI/style, 🔒 security, ⬆️ upgrade, 🏗️ architecture
- Commit and push each individual change immediately — don't batch multiple changes into one commit

## Changesets

Every commit that changes source code (`src/`) **must** include a changeset file. Run `yarn changeset` before committing.

Versioning follows **strict semver**:
- **MAJOR** — breaking changes (API changes, config format changes, removed features)
- **MINOR** — new features (new connectors, new CLI flags, new capabilities)
- **PATCH** — bug fixes, dependency updates, refactoring, config tweaks, anything that isn't a new feature

To cut a stable release: `yarn release` (runs `changeset version`), then commit and push the version bump.

## Documentation

This project must be **thoroughly documented**. When making changes:
- Update the README.md if user-facing behavior changes
- Update relevant docs in `docs/` if connector APIs, setup steps, or architecture changes
- Add JSDoc comments to new exported functions
- Keep the inline code comments meaningful — explain *why*, not *what*

## Testing

- **Always write and update tests** when changing code in `src/`
- Tests live in `test/` mirroring the `src/` structure
- Run tests: `yarn test` (requires 4GB heap due to ts-jest + ESM + googleapis)
- Jest + ts-jest with ESM mode (`--experimental-vm-modules`)
- Mock external APIs (Google, Anthropic, fetch) — never make real API calls in tests
- Target: 70%+ line coverage

## Project Structure

- `src/` — TypeScript source (ESM, NodeNext module resolution)
- `src/connectors/` — pluggable data sources, each exports `create()` and `validate()`
- `src/prompts/` — Claude system prompt
- `test/` — Jest tests
- `fonts/` — Inter font files for PDF rendering
- `.changeset/` — pending changesets for next release

## Package Manager

This project uses **Yarn 4** (Berry) with `node-modules` linker. Do not use npm.

## Workflows

- **CI/CD** (`ci.yml`) — single unified pipeline on every push to main: lint → test → release. The release job only runs if lint and test pass. Preview builds per commit, stable on version bump.

## Key Patterns

- Connectors return `ConnectorResult` with `source`, `description`, `data`, `priorityHint`
- `core.ts` orchestrates: fetch all → build payload → Claude generates brief → save memory → self-critique
- Multi-account support for Google connectors (calendar, gmail) and Todoist
- Memory system persists 7 days of insights between briefs
- The user commits directly to main — no PRs, no branches
