---
"callsheet": patch
---

Memory between briefs is now date-bounded and dated. It used to load the seven newest memory files however old they were, so after a vacation or a run of failed saves the writer was shown notes from weeks earlier as "recent"; it now loads only the last seven calendar days and skips today's own file on a re-run. Each remembered fact carries an `until` date (requested through structured output) and is dropped after it, and memory is no longer extracted from the language, market, weather or garbage sources — the language connector's data describes a theme, and the extractor had been inventing a phrase from it that never appeared in the brief. Memory files are kept for 60 days for later reading instead of being pruned to seven.
