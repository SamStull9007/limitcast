---
description: Split an oversized auto-memory file into a short hub plus topic files (limitcast)
argument-hint: [memory file]
allowed-tools: Bash(npx -y --package=https://github.com/SamStull9007/limitcast/releases/download/v0.16.0/limitcast-0.16.0.tgz limitcast memory *), Read, Grep, Glob
---
Split an oversized or mixed-topic auto-memory file into a short hub plus topic files, so a task that needs one fact reads one small file. Target: $ARGUMENTS (if blank, pick from the sweep below).

Mechanical sweep from limitcast:

!`npx -y --package=https://github.com/SamStull9007/limitcast/releases/download/v0.16.0/limitcast-0.16.0.tgz limitcast memory 2>&1 || true`

If the sweep says there is no auto-memory index, say so and stop.

**Is it worth it?** A good candidate is long and mixes two or more topics a task would only need one of at a time, for example a standing rule followed by a long dated history. A long file that is one continuous procedure is a bad candidate: splitting it turns one read into two. A file only modestly over the line, or a piece that would land under about 40 lines, is not worth the extra file. If the file fails this, say why and stop, even when the user named it.

**Propose, then wait.** Read the file and show a table of contents: what stays in the hub, what goes to each `<hub>_<topic>.md`, the line count of each, and for each moved section the trigger that means "open this". Grep the memory folder for what cites the file, and say whether any common task would now need the hub and a sub-file together (that is a net loss: redraw the boundary or don't split). Write nothing until the user agrees.

**Split.** Write the sub-files first with their own frontmatter, carrying text over verbatim, never summarized. Rewrite the hub under the same filename and frontmatter so nothing that points at it breaks; it must still answer "what is the current rule" alone, with each moved section replaced by a short pointer that says when to open the sub-file. Check the line and byte counts of hub plus sub-files against the original, since a large unexplained drop means text was lost.

**Check.** Grep every note that cited the old file for the specific thing it cited, and repoint it only if that text moved. Update the index line in MEMORY.md (keep it one line). Confirm every sub-file is reachable from the hub, every pointer names its trigger, and no sub-file's content is repeated in the hub.

Report what moved where, before and after counts, how many citations were checked and how many repointed, and the new index line.
