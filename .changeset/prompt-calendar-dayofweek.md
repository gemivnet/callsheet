---
'callsheet': patch
---

🐛 Strengthen system prompt so the brief writer uses pre-computed calendar fields

A prior change pre-computed `dayOfWeek` / `date` / `whenLabel` on each calendar event, but the brief writer was still occasionally deriving the weekday from raw ISO strings and getting it wrong. The system prompt now explicitly tells it to use those fields verbatim and never derive weekdays itself. Also teaches it how to surface the `language` connector's phrase inside the Executive Brief.
