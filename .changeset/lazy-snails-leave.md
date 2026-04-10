---
"callsheet": patch
---

Extract `stripJsonCodeFences` helper in core.ts. Replaces 4 copy-pasted regex sites that strip Markdown code fences from Claude responses, with a single tested utility.
