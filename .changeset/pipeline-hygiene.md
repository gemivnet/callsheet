---
"callsheet": patch
---

Run hygiene:

- A connector that fails on two scheduled mornings running now sends one `WARN` to `notify_webhook` (failure streaks are tracked in `output/status.json`). A connector once failed for nine days with nothing but a line in each brief.
- Warnings raised after a brief was written (memory, review, auto-close, task coach) no longer leak into the next morning's "issues during this run" in a long-running container; each run's own warnings are recorded in its status entry instead.
- A manual or dashboard re-run no longer erases the morning's printed brief: the printed `callsheet_DATE` JSON and PDF, and the data behind them, are kept as `*.printed.*` before being overwritten.
- The dashboard's generate button now takes the same lock as scheduled runs, so a click during the morning run returns 409 instead of starting a second run on the same files.
