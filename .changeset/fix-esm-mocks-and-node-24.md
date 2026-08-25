---
'callsheet': patch
---

Repair the two Jest suites that could not load, and move off EOL Node.

`test/core.test.ts` mocked `node:child_process` with only `execSync`, so it broke the
moment `printPdf` switched to `execFileSync`. The mock and its assertions now use the
argv form, plus a new case asserting that a printer name full of shell metacharacters
arrives as one literal argument.

`test/server.test.ts` mocked `../src/core.js` without `DEFAULT_MODEL`, which
`src/server.ts` imports. An ESM module mock has to supply every binding the importer
names or the import throws and the suite never runs. This one predates the change above.

Both suites were silently not running: 21 of 23 passing looked healthy while 194 tests
never executed. Now 23/23 and 568/568, with coverage at 96.73/85.36/96.67/97.96 against
the 95/84/95/95 gate.

Also moves the Dockerfile, CI and `engines.node` from Node 20, which is EOL and no
longer receives CVE fixes, to Node 24.
