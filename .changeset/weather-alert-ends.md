---
"callsheet": patch
---

Weather alerts now report when the hazard ends (`ends`) as well as when the alert message expires (`messageExpires`), and the brief is told the difference. The connector used to pass only the message's expiry, which briefs read as the end of the hazard — lifting a heat warning hours early and placing a morning activity "clear of the window" inside it. Alert times are formatted in the household timezone, a failed alert fetch is flagged rather than reading as "no alerts", and the description notes that forecast winds are in mph while aviation weather uses knots.
