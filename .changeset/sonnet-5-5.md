---
"callsheet": minor
---

The brief is now written by Claude Sonnet 5.5 by default (`claude-sonnet-5-5`), and the housekeeping passes — memory, self-critique and auto-close — run on Claude Haiku 5.5, which costs about a tenth of what Haiku 4.5 did. Those passes now have room to think before answering (a larger output budget at low effort) so their JSON is not truncated. On models that support it, the brief request opts into Anthropic's server-side refusal fallback (`fallbacks: "default"`).

Usage costs are corrected: Sonnet 5 had been priced at $3/$15 per million tokens instead of $2/$10, overstating every month since the switch by half. Usage summaries and the dashboard now re-price stored entries from their token counts, so the correction applies to past months too. Adds pricing for the 5.5 generation and Fable 5.1. Upgrades `@anthropic-ai/sdk` to 0.133.0.
