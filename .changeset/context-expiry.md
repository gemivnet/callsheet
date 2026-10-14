---
"callsheet": minor
---

Household context now knows when it has gone out of date. A `context` entry can be written as `{ text, until }` and is left out after its `until` date. For plain prose entries, callsheet reads the dates they mention (ISO dates, "May 7, 2026", ranges like "May 7-25, 2026", and "June 2026"): when every one has passed, the entry is still given to the writer but marked as history, so it stops counting down to finished plans, and a note is logged. On the weekly review day the brief also prints a short Housekeeping section listing the context entries to update or remove in config.yaml.
