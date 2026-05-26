---
"callsheet": minor
---

Docker scheduled briefs can now print. The scheduler prints to the configured printer by default (set `PRINT_BRIEF=false` for UI-only deployments), the image bundles `cups-client` so `lp` can reach a CUPS server via `CUPS_SERVER`, and the build installs the toolchain needed to compile native modules (`better-sqlite3`) on alpine.
