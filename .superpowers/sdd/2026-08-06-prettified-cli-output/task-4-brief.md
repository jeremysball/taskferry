### Task 4: Update `docs/sourcemap.md`

**Files:**
- Modify: `docs/sourcemap.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by later tasks.

Per this project's own `CLAUDE.md` ("Keep the sourcemap up to date"), a behavior change and a new file both require a sourcemap update in the same PR.

- [ ] **Step 1: Add a row for the new file**

In the file-by-file table (the row currently starting `| `output.js` | 419 | ...`), add a new row directly after it:

```markdown
| `pretty.js` | ~330 | TTY-only "minimal accent" renderer used by `output.js`'s `writeToon()`: shape-detects a command's return value (`tasks`+`counts` -> grouped-list, `integrations` -> doctor report, `trend`/`byModel` -> stats report, else -> one-line-per-field fallback) and renders it directly with `picocolors`, with `cli-table3` (borders blanked out) used only for column alignment inside the list/stats renderers. Never touches the non-TTY path -- that's still plain `@toon-format/toon` `encode()`, unchanged. |
```

(Confirm the actual line count of the finished `src/pretty.js` with `wc -l src/pretty.js` and use the real number instead of `~330`.)

- [ ] **Step 2: Update the `output.js` row's description**

Replace the existing `output.js` row's TOON-coloring sentence (the one starting "TOON coloring (`writeToon`/`markColorableFields`/`colorizeText`) marks values with one of three invisible Unicode markers...") with:

```markdown
`writeToon()`'s TTY branch delegates entirely to `pretty.js`'s `renderPretty()` (see that row); its non-TTY branch is still a plain `@toon-format/toon` `encode()` call, byte-identical to before this changed. `colorize()`/`colorForStatus()`/`ANSI_BY_STATUS` remain here and are used only by `formatWatchEvent()`/`formatActivityLine()` (the `watch` command's own, separate TTY-gated coloring, untouched by the `pretty.js` renderer).
```

- [ ] **Step 3: Update the top-of-file call-chain summary line if present**

Find the line near the top of `docs/sourcemap.md` that currently reads `-> output.js     TOON formatting, lean field projection, MCP-era hint` (or similar) and extend it to mention the new split, e.g.:

```
-> output.js     lean field projection, TOON encode (non-TTY) / pretty.js render (TTY)
-> pretty.js     shape-based "minimal accent" renderer for a real terminal
```

- [ ] **Step 4: Commit**

```bash
git add docs/sourcemap.md
git commit -m "docs(sourcemap): document pretty.js and the writeToon TTY/non-TTY split"
```

---

