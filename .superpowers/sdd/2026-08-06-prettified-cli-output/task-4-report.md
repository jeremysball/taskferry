### Task 4: Update `docs/sourcemap.md`

**Status:** DONE

**Note on Steps 1-2:** Task 3's implementer (`alibaba-tknplan/qwen3.7-plus`)
already updated `docs/sourcemap.md`'s file-by-file table as part of its own
task, ahead of this task's dispatch — adding the `pretty.js` row (line 74),
updating the `output.js` row's description to describe the TTY/non-TTY
split (line 73), and adding a `pretty.test.js` row (line 75) the brief
didn't explicitly request but which follows the same table convention.
That content was already covered by Task 3's own task review (the diff
touched `docs/sourcemap.md`; the reviewer raised no findings against it).
Verified directly (`rg -n "pretty.js|output.js|writeToon" docs/sourcemap.md`)
before doing any further edit here, rather than assuming Steps 1-2 were
still open.

**Steps completed by this task:**

- **Step 1 (add `pretty.js` row):** already done by Task 3 — verified
  present, not re-done.
- **Step 2 (`output.js` row description):** already done by Task 3 —
  verified present, not re-done.
- **Step 3 (top-of-file call-chain summary line):** the only step still
  open. `docs/sourcemap.md`'s call-chain diagram still had the old,
  pre-split `-> output.js     TOON formatting, lean field projection,
  MCP-era hint` line and no `pretty.js` entry. Replaced with:
  ```
  -> output.js     lean field projection, TOON encode (non-TTY) / pretty.js
                    render (TTY), MCP-era hint migration
                    (taskferry_dispatch -> taskferry dispatch)
    -> pretty.js   shape-based "minimal accent" renderer for a real
                    terminal
  ```
- **Step 4 (commit):** `docs(sourcemap): document pretty.js and the
  writeToon TTY/non-TTY split` (commit `e4bcc16`).

**Verification:** Read the surrounding 30 lines of the call chain block
after the edit to confirm indentation and wrapping stayed consistent with
the rest of the diagram (all other entries use the same two/four-space
step-in convention).

**Concerns:** None. This is a documentation-only change; no code, tests,
or lint are affected.
