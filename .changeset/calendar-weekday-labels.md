---
'callsheet': patch
---

🐛 Pre-compute weekday/date/time labels for calendar events so the brief writer can't mis-derive them

Calendar events now carry `date` (YYYY-MM-DD), `dayOfWeek` (e.g. "Monday"), `timeLabel` ("7:30 AM" or null for all-day), and `whenLabel` ("today", "tomorrow", "Monday (in 4 days)") fields resolved in the configured timezone. The connector also emits the timezone and today's date alongside the events. This closes a prior bug where the LLM was labeling events with the wrong weekday (off by one) when deriving weekdays from raw ISO strings.
