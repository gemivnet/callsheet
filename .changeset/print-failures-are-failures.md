---
"callsheet": minor
---

A brief that is written but never printed is now a failed run, and says so. Printing retries a failed `lp` submission, then watches the CUPS job until it completes; a job that cannot be submitted sends a `CRIT` alert to `notify_webhook`, and one that sits in the queue for five minutes sends a `WARN`. Print errors no longer abort the run as "Generation failed", and a dead CUPS socket is reported as one instead of as the misleading "printer or class does not exist".

Every run is recorded in `output/status.json` (date, trigger, whether the brief was written, how printing went, connector issues), and `GET /api/health` now includes the last run while staying a pure liveness check. New optional `heartbeat_url` is fetched after each good scheduled run, for a dead-man's switch such as healthchecks.io. The dashboard's generate endpoint and the PDF path now use the household timezone for "today".
