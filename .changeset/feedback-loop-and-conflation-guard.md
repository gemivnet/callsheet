---
"callsheet": minor
---

Two improvements to fight recurring brief quality issues surfaced in a week of production critiques:

- **Feedback loop surfaces RECURRING problems, not just raw examples.** `buildFeedbackContext` now classifies self-critique issues by category (Duplication, Verbosity, Missing data, Poor grouping, Stale items) and counts distinct days each category appears on. Any category hitting 3+ of the last 7 critique days gets a prominent "RECURRING quality problems" section with a specific remedy — not just a list of past gripes. Recent specific examples are still shown as anchors.
- **System prompt: anti-conflation guardrail.** Added an explicit rule that shared sender, service, or vendor is NOT a semantic link. Prevents merging unrelated items from the same sender into one bullet when the underlying threads aren't actually connected.
