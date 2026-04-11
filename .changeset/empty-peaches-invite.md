---
'callsheet': minor
---

aviation_weather: expand to full preflight briefing.

The connector used to return only METAR + TAF. It now fetches — in parallel,
with graceful per-endpoint degradation — station info, PIREPs, SIGMETs,
AIRMETs, G-AIRMETs (SIERRA/TANGO/ZULU), CWAs, and the local NWS Area
Forecast Discussion, plus a computed density altitude report per station.

Hazard polygons (SIGMET/AIRMET/G-AIRMET/CWA) are filtered to anything that
contains or lies within 100 nm of a configured station, so the prompt
payload stays tight. G-AIRMET forecast hours for the same hazard/product
over the same stations are collapsed into a single report with a
`forecastHours: [0, 3, 6, 9, 12]` array instead of five near-duplicates.

New optional config fields: `wfo` (override the Area Forecast Discussion
office), `pirep_radius_nm`, `pirep_age_hours`.
