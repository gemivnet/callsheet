---
'callsheet': minor
---

Add vacation mode. Configure one or more `vacation` ranges in `config.yaml` (each with `start` / `end` as YYYY-MM-DD, inclusive on both ends, evaluated in your configured timezone) and the cron-driven scheduler will skip generation entirely on any date that falls inside a range. Manual CLI runs are unaffected, so on-demand briefs still work while you're away.
