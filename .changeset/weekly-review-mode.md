---
"callsheet": minor
---

Add Week in Review mode. Configure `weekly_review_day` (a day name like
`saturday` or a number 0-6) and on that day the brief is replaced by a
retrospective covering the trailing 7 days, generated from a separate
`src/prompts/weekly.md` system prompt with sections for The Week,
Accomplishments, By the Numbers, Open Items, Notable, and Looking Ahead.
The Google Calendar connector now supports `lookback_days` for fetching
past events, and is automatically bumped to a 7-day lookback on review
days so the retrospective has data to draw on.
