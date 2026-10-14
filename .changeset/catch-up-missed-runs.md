---
"callsheet": minor
---

The scheduler now produces a brief late instead of skipping the day. When node-cron reports a missed execution (a paused host, a blocked event loop), when the container starts after the scheduled time, or when a 15-minute watchdog finds no scheduled run recorded for today, it runs a catch-up within a configurable window (`CATCHUP_HOURS`, default 6; `0` disables). Catch-up is idempotent: a scheduled run records itself in `output/status.json`, and vacation days are respected.

New `GET /api/status` reports whether the household actually got its brief: `503` when the last scheduled run produced an error page or failed to print, or when a due run never happened (90 minutes after the scheduled time); `200` with `degraded` when a print job sat in the queue. Point an uptime monitor at it. `/api/health` remains a liveness check.
