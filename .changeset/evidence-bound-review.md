---
"callsheet": minor
---

The pre-print review no longer makes briefs worse. The free-text self-critique and the model "repair" pass that applied its claims verbatim are gone: an audit of six months of output found under half of the critique's findings were real (many concluded in their own words that the brief was correct) and the repair pass applied them anyway — moving times, stretching date spans, and deleting the language line. In their place:

- Executive Brief items that merely restate one task, email or event are removed deterministically, in code.
- A fact check on Haiku 5.5 must return the exact words from the brief, the exact data that contradicts them, and the replacement. Both quotes are verified before anything changes, and the correction is applied as an exact string replacement in the one field that holds it. The language-practice line is never touched.
- What the review did is written to `feedback/review_DATE.json` for people to read. Review findings are no longer fed into the next morning's prompt; the "recurring problems" banner never changed the writer's behaviour.

New optional `feedback_notes` in config passes the household's own notes to the writer (same purpose as `feedback.md`, which a container deployment never saw). `--review DATE` now checks a brief against that day's saved data rather than against fresh data.
