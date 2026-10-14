---
"callsheet": patch
---

Auto-close can now actually close a task. It used to send the model the first 8,000 characters of the day's data, which is part of the calendar, so it never saw a Todoist task alongside an email or transaction that could prove it done and never closed anything. It now builds its input from the open tasks plus the day's emails and budget transactions, asks for structured output, and verifies every recommendation in code before acting: the task must exist and must not be recurring, and the quoted evidence must appear verbatim in the email or transaction cited. At most three tasks are closed per run, and each closure records the evidence that justified it.
