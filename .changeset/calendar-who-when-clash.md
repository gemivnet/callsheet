---
"callsheet": minor
---

The calendar connector now works out who an event is for, how long it lasts, and what clashes, so the brief stops guessing:

- An event whose title starts with a household member's name ("Name: Practice") is attributed to that member, with `onCalendarOf` naming whose calendar holds it. Events of a member with no calendar of their own used to be credited to whichever parent's calendar carried them. The household roster now reaches every connector, along with the household timezone.
- Multi-day all-day events carry `lastDay`, `spanLabel` and, while running, `dayOfSpan`. Google's end date is exclusive, and passing it through had briefs announcing that a Friday-to-Sunday trip ran through Monday.
- Timed events carry `endTimeLabel`, and the payload gains `conflicts` (overlapping events for the same person, from their times) and `free_time_today` (each person's open stretches, between `day_start_hour` and `day_end_hour`, default 8 and 21).
- New `exclude_patterns` option drops reference-only events (matched against title and description) before anything else sees them.
