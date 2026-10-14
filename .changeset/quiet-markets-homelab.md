---
"callsheet": minor
---

Two connectors no longer order items onto the page. The market connector told the brief to "ALWAYS" call out any symbol near its 52-week high, which put the same line in the Executive Brief for days at a time and overrode the household's own threshold. It now flags `newlyNear52wHigh` / `newlyNear52wLow` (reached since the previous close), reports `priceAsOf` so a Friday move is not re-reported on Monday, and uses one configurable threshold, `move_threshold_pct` (default 3%), for when a weekly move is worth mentioning — when nothing qualifies, the brief is told to leave markets out. The homelab connector no longer insists that overnight work be reported "in at least one line"; routine upkeep is not news, and only items that touch daily life (food safety, locks, leaks, internet, cameras, power) belong in the Executive Brief or Tasks.
