---
"callsheet": minor
---

Add `garbage_recycling` connector. Pure config-driven (no API), supports both weekly schedules (`weekly: thursday`) and biweekly schedules anchored to a known pickup date (`biweekly: { day: tuesday, anchor: "2026-04-21" }`). Surfaces today's and tomorrow's pickups so the brief can flag "bins out tonight" without you having to remember the alternating recycling week.
