---
'callsheet-brief': minor
---

✨ Add language connector with 30-day phrase history so the brief's word-of-the-day never repeats

The language word-of-the-day used to live in `extras:` and relied on the 7-day shared memory bucket for anti-repeat — which didn't work because phrases were never persisted as structured data. The new `language` connector:

- Keeps its own phrase history file (`<output_dir>/language_history.json`) with a configurable retention window (default 30 days).
- Feeds the full past-phrase list to the brief writer so it can dodge repeats deterministically.
- Provides a rotating theme cue and level guidance, plus instructions to mine today's connector data for contextual vocab.
- Parses the emitted phrase out of the brief after generation and appends it to history.

Rendered as the last item in the Executive Brief section — not its own section — matching the original extras-based UX.

Configure via `connectors.language` with `target_language`, `label_prefix`, `level`, and `history_days`.
