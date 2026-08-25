---
'callsheet': patch
---

Fix the Docker image producing an error brief instead of a real one, and harden two
input paths.

- `build` now copies `src/prompts` into `dist/`. `tsc` emits only `.js`, so the built
  image had no system prompt and `loadPrompt` threw outside the try block, rendering a
  generation-failure brief on every scheduled run. The local dev path reads from `src/`
  and was unaffected, which is why it went unnoticed.
- The `:date` routes validated nothing before interpolating the parameter into a
  filename. A percent-encoded traversal reached the handler and resolved outside the
  output directory; these routes are all date-keyed, so they now reject anything that
  is not `YYYY-MM-DD`. (The unencoded form never reached the handler — the URL layer
  normalises it first.)
- `printPdf` used `execSync` with the printer name interpolated into a shell string.
  The dashboard can rewrite config unauthenticated, making that a command-injection
  sink. It now uses `execFileSync`, which spawns no shell.
