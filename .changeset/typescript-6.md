---
"callsheet": patch
---

Builds with TypeScript 6. TypeScript 6 no longer loads every installed `@types` package by default, so the compiler config now names `node` explicitly. Pull requests now run the full build as well as lint and tests, so a change that breaks the compile is caught before it reaches main, and the test-report step moves to dorny/test-reporter 3 (Node 24 runtime). Verified with the production build, the CLI loading from `dist/`, lint, format and all 839 tests.
