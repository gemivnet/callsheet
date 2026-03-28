---
"callsheet": patch
---

Fix cron reliability: catch async crashes from @actual-app/api, add retry with backoff for Claude API calls, and generate error briefs when all retries fail
