---
"callsheet": patch
---

Aviation weather now classifies flight categories correctly. The connector read API fields that do not exist (`fltcat`, `ceil`), so every METAR came through with no category ("Current: unknown") and every TAF was judged on visibility alone — a low overcast with good visibility was reported as VFR. Ceilings are now taken from the `clouds` array (lowest broken/overcast layer, or vertical visibility), visibility strings such as `"10+"`, `"6+"` and `"1 1/2"` are parsed, the FAA thresholds are applied (they were one category too lenient), and an unknown element is never treated as VFR. TEMPO/PROB/BECMG groups inherit the prevailing elements they do not restate, and low-level wind shear is decoded.

The PIREP search is anchored on the first ICAO station, since the endpoint rejects FAA-only identifiers with HTTP 400 and PIREPs had silently read as "0 recent" for weeks. Products that fail to fetch are listed as unavailable in the payload, and fields with no METAR or TAF of their own are named so the brief does not borrow another station's weather without saying so.
