---
'callsheet': patch
---

Apply the self-critique to the brief being printed, and speak up when generation fails.

Six months of output said the feedback loop was not converging. `critiqueBrief` already ran
before `renderPdf`, so the system diagnosed today's brief, wrote the diagnosis down for
tomorrow, logged "issue(s) logged for future improvement", and printed the flawed brief
anyway. Across 111 critiques and 574 issues, **Duplication was 257 of them — 45%** — and the
rate never moved from ~5 issues per brief between March and September, despite the feedback
prompt correctly naming it as recurring on 7 of the last 7 days. The shape was consistent:
171 of those 257 were the Executive Brief restating a section that already owned the topic.
Warning the next writer does not fix the artifact in hand.

`repairBrief` now runs between the critique and the render, on the two categories with an
objective answer — Duplication and Factual accuracy. An item is either in two sections or it
is not; a stated fact either matches the payload or it does not. Verbosity and grouping stay
with the writer, because a second pass on a judgement call is as likely to damage a good
brief as improve it. The repair fails closed: unparseable JSON, or a result with no sections,
keeps the original. Repaired issues are recorded on the critique entry so tomorrow's prompt
keeps counting the category — the writer still made the mistake — without citing specific
examples the reader never saw.

Failure is no longer silent. Between 2026-06-25 and 07-10 every brief was a GENERATION FAILED
page because an Anthropic account had no credit; sixteen mornings printed, nothing raised.
`notify_webhook` is an optional URL posted to as `{title, message}` on failure, in one short
ASCII line so it survives an SMS gateway intact. It never throws — the alarm must not break
the run it was watching.

Two things made that outage harder to read than it should have been, both fixed. The error
brief hardcoded `failed after ${MAX_RETRIES + 1} attempts`, so a non-retryable 400 that broke
after a single attempt was reported as four — it looked like API flakiness rather than a
billing wall. It now reports the real count and says plainly when an error is terminal.

And `categorizeIssue` matched category prefixes exactly, so the variants the critique model
actually emits — `Stale item` singular (22 issues), `Missing event`, `Date mismatch` — were
dropped: 37 of 574 issues never counted toward the recurring-pattern threshold. Matching is
now case- and plural-insensitive with a synonym map.
