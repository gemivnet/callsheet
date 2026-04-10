---
"callsheet": patch
---

Fix a TypeScript narrowing error in the garbage_recycling validate path so a
schedule object with neither `weekly` nor `biweekly` reports a clean
"missing 'weekly' or 'biweekly'" check instead of failing to compile.
