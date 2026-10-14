---
"callsheet": minor
---

New task coach (`task_coach.enabled: true`) turns the brief's task list into a plan for the day. Alongside the brief, the writer now returns a structured plan, which code checks against the real Todoist data, carries out, and prints:

- **Today's Focus** — up to three tasks per person (`focus_per_person`), each with a time slot from that person's free time and a short reason, printed right after the Executive Brief with yesterday's score ("Yesterday: 2 of 3 focus tasks done"). Undated, non-recurring focus picks are set to due today in Todoist so they show on phones (`schedule_focus`).
- **Stuck — Decide Today** — tasks that are not moving (long overdue, rescheduled again and again, sitting in an inbox for weeks, picked as a focus repeatedly) each get one recommendation: schedule, first step, hand off, or drop. A task decided on is not asked about again for a week.
- **Added to Todoist** — actions found in email or the calendar that were not tasks yet (bills, forms, RSVPs, replies someone is waiting on) are added to the person's Todoist inbox under a label (`capture_label`, default `callsheet`), with the due date the source states. Captures are de-duplicated against open tasks and never re-added once made, even if deleted (`max_captures`, `capture`).
- **Capture** — up to two short prompts that jog memory for tasks nobody has written down.

The coach never deletes, closes or rewrites a task. It writes to Todoist only on real runs, never on dashboard previews, and keeps its records (a ledger and each day's focus picks) under `output/tasks/`. On the weekly review day the writer also gets the week's coach numbers. The brief itself is now requested with a JSON schema (structured output), so its response always parses.
