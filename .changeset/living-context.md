---
"callsheet": minor
---

New living context (`living_context.enabled: true`) keeps the household context current from the data. Each real run, a cheap model compares the context with the morning's data and proposes changes — a fact the data establishes, retiring a learned fact that is no longer true, or flagging a `context` entry the data contradicts. Every proposal must quote its source, the quote is verified against the data, and at most three facts change per run. Learned facts are given to the writer as recent changes, expire on their own, and are stored in `output/context/living.json`; `config.yaml` is never edited. Changes are printed under Housekeeping on the day they happen, flagged entries stay on the weekly Housekeeping list until edited, and `living_context.ignore` vetoes anything learned wrongly.
