# callsheet

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
