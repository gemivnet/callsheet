---
'callsheet': patch
---

Bind the headed-mode dashboard to loopback instead of all interfaces.

The dashboard has no authentication on any route, and its `:date` handlers read and
delete files under the output and credential directories. On `0.0.0.0` that surface was
reachable from any host on the LAN. It is served through a reverse proxy, so this changes
nothing for normal use.
