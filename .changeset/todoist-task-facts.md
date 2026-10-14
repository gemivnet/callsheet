---
"callsheet": minor
---

The Todoist connector now hands the brief the facts about each task that it used to get wrong when left to work them out:

- `priority` is the label the app shows (`p1` most urgent … `p4` no priority). The raw API number counts the other way, and briefs had been printing the lowest-priority tasks as "priority 1".
- `daysOverdue`, `ageDays` (days since created), `postponedCount` (times rescheduled), `dueWeekday`, `dueTime`, `labels` and `deadline`, all in the household timezone. "Today" was computed in UTC, and a task due today at a set time was filed under upcoming.
- A per-person `summary` of counts to quote instead of tallying lists.
- A task in a shared project is listed once — under its assignee when it has one, with `sharedWith` naming the others — instead of once per account, which had doubled backlog counts.
- `recently_completed` records who finished each task, and a failure to fetch it is reported rather than reading as "nothing done".

New `collapse_projects` option: tasks in the named projects (for example one that an automation fills) are summarised as a count, with any p1 item still shown, instead of crowding the household's own tasks off the page.
