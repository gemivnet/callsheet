#!/usr/bin/env bash
set -euo pipefail

# Automated release script for callsheet
# Usage: yarn release
#
# This script:
# 1. Consumes pending changesets and bumps the version
# 2. Shows the diff for review
# 3. Commits and pushes — CI/CD handles the rest

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# Ensure we're on main
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo -e "${RED}Error: Must be on main branch (currently on $BRANCH)${NC}"
  exit 1
fi

# Ensure working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${RED}Error: Working tree is dirty. Commit or stash changes first.${NC}"
  exit 1
fi

# Check for pending changesets
CHANGESETS=$(find .changeset -name '*.md' ! -name 'README.md' 2>/dev/null | head -1)
if [ -z "$CHANGESETS" ]; then
  echo -e "${RED}Error: No pending changesets found.${NC}"
  echo -e "Run ${BOLD}yarn changeset${NC} to create one first."
  exit 1
fi

OLD_VERSION=$(node -p "require('./package.json').version")

# Run changeset version (bumps package.json, writes CHANGELOG.md, deletes changesets)
npx changeset version

NEW_VERSION=$(node -p "require('./package.json').version")

echo ""
echo -e "${GREEN}${BOLD}Version bump: ${OLD_VERSION} → ${NEW_VERSION}${NC}"
echo ""
echo -e "${YELLOW}Changes:${NC}"
git diff --stat
echo ""

# Confirm
read -p "Commit and push v${NEW_VERSION}? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}Aborted. Changes are staged but not committed.${NC}"
  echo -e "To undo: ${BOLD}git checkout -- .${NC}"
  exit 0
fi

# Commit and push
git add -A
git commit -m "$(printf '📦 Release v%s' "$NEW_VERSION")"
git push

echo ""
echo -e "${GREEN}${BOLD}v${NEW_VERSION} pushed!${NC} CI/CD will:"
echo -e "  • Run lint + tests"
echo -e "  • Build Docker image → ${BOLD}ghcr.io/gemivnet/callsheet:${NEW_VERSION}${NC} + ${BOLD}latest${NC}"
echo -e "  • Create GitHub Release ${BOLD}v${NEW_VERSION}${NC}"
