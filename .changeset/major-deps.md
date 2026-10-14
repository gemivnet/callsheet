---
"callsheet": patch
---

Upgrades commander to 15, dotenv to 18, js-yaml to 5 and suncalc to 2. js-yaml 5 and suncalc 2 no longer have a default export and now ship their own types, so they are imported as namespaces and the separate `@types` packages are dropped. Verified by building the production output and loading the CLI, server, core and sun/moon modules from it, and by round-tripping the household config through the new YAML parser.
