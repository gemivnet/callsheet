---
"callsheet": minor
---

Add a `homelab` connector for reporting overnight infrastructure status.

It reads a JSON status document written by an external maintenance job and surfaces it only
when there is something worth surfacing — a quiet night costs the brief nothing. Two
properties make it useful rather than noisy: it treats a document that has stopped being
updated as the interesting case, because a monitoring job that silently dies looks exactly
like a clean night; and it maps severity onto `priorityHint` so routine status cannot crowd
out the rest of the page.

Deliberately generic: the path, label and staleness threshold all come from config, and no
host, service or network detail lives in the connector itself.
