---
'callsheet': patch
---

Fix CI test hang on Linux runners. The language connector test that exercised the `recordBriefPhrase` error path pointed `output_dir` at `/proc/invalid/...`; on macOS that errored fast, but on the GitHub Actions Ubuntu runner `mkdirSync({recursive:true})` against a `/proc` sub-path hung the worker indefinitely (the test job timed out at 47 minutes). Switch the failing path to a sub-path of a regular file so `mkdirSync` fails synchronously with `ENOTDIR` on every OS.
