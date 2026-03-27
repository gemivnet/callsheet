# Releasing Callsheet

This document explains the release pipeline, versioning methodology, and how to cut a stable release.

## Overview

Callsheet uses **[Changesets](https://github.com/changesets/changesets)** for versioning and **GitHub Actions** for automated builds. Every commit to `main` triggers a build pipeline that publishes a Docker image to GitHub Container Registry (GHCR).

There are two types of releases:

| Type | When | Docker Tag | GitHub Release |
|------|------|------------|----------------|
| **Preview** | Every commit to `main` | `1.0.0-preview.abc1234` | No |
| **Stable** | After `yarn release` + push | `1.1.0` + `latest` | Yes |

## How It Works

```
Developer makes changes
  → runs `yarn changeset` to describe the change
  → commits code + changeset file
  → pushes to main
  → CI/CD: lint + test → build Docker → publish preview to GHCR

When ready for stable release:
  → runs `yarn release` (automated: version bump → commit → push)
  → CI/CD: lint + test → build Docker → publish stable + latest to GHCR + GitHub Release
```

## Versioning (Semver)

Callsheet follows **strict semantic versioning**:

| Bump | When to use | Examples |
|------|-------------|---------|
| **MAJOR** (`x.0.0`) | Breaking changes | Config format change, removed connector, CLI flag rename |
| **MINOR** (`0.x.0`) | New features | New connector, new CLI flag, new capability |
| **PATCH** (`0.0.x`) | Everything else | Bug fix, refactor, dependency update, docs, config tweak |

## Step-by-Step: Making Changes

### 1. Write your code

Make your changes in `src/`, update tests, update docs.

### 2. Create a changeset

```bash
yarn changeset
```

This interactive prompt asks:
- **Which packages?** → Select `callsheet` (only option)
- **Bump type?** → `major`, `minor`, or `patch`
- **Summary?** → One-line description of the change

This creates a file like `.changeset/fuzzy-cats-dance.md`:

```markdown
---
"callsheet": minor
---

Add Radarr/Sonarr connector for media tracking
```

### 3. Commit and push

```bash
git add -A
git commit -m "✨ Add Radarr/Sonarr connector"
git push
```

The pre-commit hook will verify a changeset exists if `src/` files changed.

### 4. CI runs automatically

- **CI/CD pipeline** → lint + test + coverage → if passing → builds Docker image → pushes preview to GHCR

You can pull and test the preview:

```bash
docker pull ghcr.io/gemivnet/callsheet:preview
```

## Step-by-Step: Cutting a Stable Release

When you've accumulated changes and want to publish a stable version:

### 1. Run `yarn release`

```bash
yarn release
```

This single command handles everything:
1. Reads all pending `.changeset/*.md` files
2. Determines the version bump (highest wins — if any changeset says `minor`, the bump is at least `minor`)
3. Bumps `version` in `package.json`
4. Writes entries to `CHANGELOG.md`
5. Deletes the consumed `.changeset/*.md` files
6. Shows the diff for review
7. Asks for confirmation
8. Commits and pushes

### 2. Pipeline handles the rest

The CI/CD pipeline detects that `CHANGELOG.md` was modified and:
- Runs lint + tests (gates the release)
- Builds Docker image
- Pushes `1.1.0` + `latest` tags to GHCR
- Creates a **GitHub Release** with auto-generated release notes

## Docker Images

All images are published to `ghcr.io/gemivnet/callsheet`.

| Tag | Description |
|-----|-------------|
| `latest` | Most recent stable release |
| `1.1.0` | Specific stable version |
| `preview` | Most recent preview build (overwritten each commit) |
| `1.0.0-preview.abc1234` | Specific preview build (immutable) |

### Pulling images

```bash
# Latest stable
docker pull ghcr.io/gemivnet/callsheet:latest

# Specific version
docker pull ghcr.io/gemivnet/callsheet:1.1.0

# Latest preview
docker pull ghcr.io/gemivnet/callsheet:preview
```

## Multiple Changesets

You can accumulate multiple changesets before releasing. Each commit adds a changeset, and `yarn release` aggregates them all:

```
commit 1: yarn changeset → patch "Fix weather connector timeout"
commit 2: yarn changeset → minor "Add Radarr connector"
commit 3: yarn changeset → patch "Update dependencies"

yarn release → bumps to next minor (highest wins)
             → CHANGELOG.md lists all three changes
```

## Skipping Changesets

The pre-commit hook only requires a changeset when `src/` files change. These don't need changesets:
- Documentation-only changes
- CI/workflow changes
- Test-only changes
- Config file changes (`.github/`, `.changeset/`, etc.)

To bypass the hook in an emergency:

```bash
git commit --no-verify -m "🔧 Fix CI config"
```

## Troubleshooting

### "No changeset found" error on commit

Run `yarn changeset`, create the changeset file, then `git add .changeset/` and retry.

### Preview build failed

Check the Actions tab on GitHub. Common issues:
- Docker build failure (check Dockerfile)
- Yarn install failure (run `yarn install` locally to update lockfile)

### Wrong version bumped

If `yarn release` bumped the wrong version, you can edit `package.json` manually before committing. Or delete the changeset files and recreate them with the correct bump type.
