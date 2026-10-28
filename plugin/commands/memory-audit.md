---
description: Audit this project's auto-memory for stale, broken and oversized notes (limitcast)
allowed-tools: Bash(npx -y limitcast@0.17.0 memory *), Read, Grep, Glob
---
Audit this project's Claude Code auto-memory. It is read-only until the user agrees to a change.

Mechanical sweep from limitcast:

!`npx -y limitcast@0.17.0 memory 2>&1 || true`

If the sweep says there is no auto-memory index, say so and stop. Otherwise read MEMORY.md and the topic files it lists, then check:

1. **Index cap.** Claude Code loads only the first 200 lines or 25 KB of MEMORY.md, so a note past that is never read. If the index is over or close, pick entries to shorten (one line, under about 150 characters, detail belongs in the topic file) or merge.
2. **Broken links.** For each one, look for the renamed file and propose the one-line fix.
3. **Unlinked files.** Before calling one an orphan, grep the memory folder and the project for references to it. Then propose either an index line or deletion, with the reason.
4. **Stale notes.** For a note that names a file, function, flag, command or URL, check it still exists. List the ones that don't, and any date or version that is now old.
5. **Contradictions.** Two notes that answer the same question differently: say which looks current and why.

Report two lists. Mechanical fixes (index lines, broken links) first, each with the exact edit. Then judgement calls (stale, contradictory, delete), each with the evidence. Offer to apply the mechanical ones; ask before anything else, and never delete a note unasked. For a file the sweep lists as oversized, point to `/limitcast:memory-split`.
