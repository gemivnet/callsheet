---
"callsheet": patch
---

Fix the budget connector failing against a newer sync server, and make connector failures
readable.

The pinned client had fallen a minor version behind the server it talks to, and the mismatch
surfaced only as a failed fetch listing database migrations the client did not recognise.

The reason it went unnoticed for nine days is the more useful half: the connector test renderer
interpolated the caught value straight into a template literal, so any non-`Error` throw
printed as `[object Object]` with no message. Every other error path already routed through
`formatUnknownError`; this one did not. It does now, and a non-`Error` throw no longer prints
an empty stack line either.
