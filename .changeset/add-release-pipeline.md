---
"callsheet": minor
---

Add release pipeline with changesets, Docker builds, and GHCR publishing. Migrate from npm to Yarn 4. Every commit to main publishes a preview Docker image; stable releases happen when changesets are consumed via `yarn release`.
