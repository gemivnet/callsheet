# CLAUDE.md — Codebase Instructions

These instructions apply to all work on this repository.

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

- **CI** (`ci.yml`) — runs lint + tests on every push to main
- **Release** (`release.yml`) — builds Docker image, pushes to GHCR. Preview builds per commit, stable on version bump.

## Key Patterns

- Connectors return `ConnectorResult` with `source`, `description`, `data`, `priorityHint`
- `core.ts` orchestrates: fetch all → build payload → Claude generates brief → save memory → self-critique
- Multi-account support for Google connectors (calendar, gmail) and Todoist
- Memory system persists 7 days of insights between briefs
- The user commits directly to main — no PRs, no branches
