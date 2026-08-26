---
'callsheet': patch
---

Three fixes, all found by the repo's own rules rather than by a failure.

Two committed strings broke the PII policy in this file's own CLAUDE.md. One named the
specific language the user is learning; the other named a real vendor, twice, and was not
a comment at all but prompt text sent to the model on every run. Both are now
structural placeholders that teach the model the same thing.

OAuth token files were written with the default 0644 into a directory created 0755.
These hold Google refresh tokens for mail and calendar and sit where the dashboard can
reach them; they are now 0600 in a 0700 directory. The existing test pinned the old call
shape and failed, which is the test working as intended — its assertion now documents the
modes as part of the contract.

`actual_budget` replaced `console.log`/`warn`/`info` with no-ops process-wide before
opening the `try` whose `finally` restores them, so a throw from `mkdirSync` or
`api.init` silenced logging for the rest of the run. The `try` now opens before the swap.
