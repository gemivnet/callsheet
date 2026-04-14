---
"callsheet": patch
---

Two parser reliability fixes observed in the past week of production briefs:

- `stripJsonCodeFences` now tolerates leading/trailing commentary around the fenced block. Previously the anchored regex failed whenever Haiku added a trailing sentence after ```` ```json\n[]\n``` ````, which silently broke auto-close task detection every day.
- `aviation_weather` treats a 200 with an empty body as a legitimate nothing-to-report response (common for quiet PIREP/CWA windows) rather than logging `Unexpected end of JSON input`. Truly unparseable bodies still log a distinct warning.
