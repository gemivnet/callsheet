---
'callsheet': patch
---

Vacation ranges were unenforceable on the deployment that actually ships briefs.

`isOnVacation` was only consulted by `runGeneration` in the scheduler, which is reached
solely through `entrypoint.ts` — the containerised `MODE=headed_docker` path. A host cron
calling `yarn print` goes through `cli.ts`, which called `runPipeline` directly and never
looked at the config. Setting a `vacation` range on that setup was a silent no-op: the
brief printed every morning regardless, with nothing in the log to say why.

The CLI now performs the same check before generating, so the config field means the same
thing on both paths. `--force` generates anyway, which preserves the on-demand escape
hatch the old docs promised via a flag rather than via the accident of which entrypoint
you happened to use. `todayInTz` is exported so the skip message names the date it judged
on — a skipped run should be legible in a cron log, not silent.

The docs said "Manual runs still work", which was true as a description of the code and
misleading as a description of the behaviour anyone would want. Corrected in both
`SETUP_GUIDE.md` and `config.example.yaml`.
