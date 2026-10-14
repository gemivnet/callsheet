---
"callsheet": minor
---

Gmail now tells the brief who spoke last in each conversation. Every email carries its `threadId`, the number of messages in the thread, and `lastFromUs` — true when the household sent the latest message, so the brief stops printing "reply to…" tasks for emails already answered (and "still hasn't replied" about a reply in the same data). Messages the household sent are marked `sent`, and recipients (`to`) are included.

Each email also carries its local date, time and a relative day in the household timezone, since the raw Date headers mix offsets. Snippets and subjects have HTML entities decoded, and one-time codes are redacted before anything reaches the model, the saved data or the page. When a query matches more mail than `max_messages`, the account is flagged `truncated` and the brief is told the window was cut off; the default limit rises from 25 to 40.
