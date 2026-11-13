---
'callsheet': minor
---

Weather connector: optional `source_url` points it at a local weather service that merges several sources. It is tried first with a short timeout; any failure or empty answer falls back to the direct NWS calls, so the setting can only add a source. A hub that could not check alerts is reported as "alerts unavailable", never as "no alerts".
