---
"callsheet": patch
---

The budget connector no longer counts transfers between the household's own accounts as spending or income (both legs used to count, producing totals like a six-figure "week of spending" and a credit-line draw reported as income), and it now says how fresh its data is: the summary carries the latest transaction date, the days since it, and a `stale` flag, and when the newest transaction is more than three days old the brief is told the bank import has probably stopped rather than reporting "$0 spent" as fact. A category spent exactly to its budget is no longer flagged as over budget, and the brief sees the 60 most recent transactions instead of 30.
