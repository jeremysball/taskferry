### Task 3: Wire `pretty.js` into `writeToon()`, remove the dead marker-based coloring code

**Files:**
- Modify: `src/output.js`
- Modify: `src/output.test.js`

**Interfaces:**
- Consumes: `renderPretty(value)` from `src/pretty.js` (Task 2).
- Produces: `writeToon(value, io)`'s public signature and non-TTY behavior are unchanged; its TTY behavior now calls `renderPretty()` instead of the marker/encode path.

This task also deletes now-dead code: `markColorableFields`, `colorizeText`, `colorForMarkedToken`, `colorForTrendDirection`, `colorForPassFailToken`, the `ENUM_MARK`/`WARN_MARK`/`INFO_MARK`/`MARK_RE` constants, `ENUM_KEYS`/`WARN_KEYS`/`INFO_KEYS`, `isMarkableScalar`, `markStringArray`, `ANSI_BY_TREND_DIRECTION`, `ANSI_GRAY`, and `ANSI_DIM`. These existed only to patch color into TOON-encoded text after the fact; once `writeToon()`'s TTY branch no longer encodes-then-patches, nothing else in the codebase calls them (verified: `rg -n "colorForTrendDirection|colorForPassFailToken|markColorableFields|colorizeText" src --type js` after this task's edit should return zero hits outside `pretty.js`'s own, differently-named equivalents). `colorize`, `colorForStatus`, `ANSI_RESET`/`ANSI_GREEN`/`ANSI_RED`/`ANSI_YELLOW`, and `ANSI_BY_STATUS` all stay — `formatActivityLine()` (the `watch` command's coloring) still uses them directly.

- [ ] **Step 1: Write the failing test for the new TTY behavior**

`markColorableFields` and `colorizeText` aren't currently imported directly in
`src/output.test.js` (the existing import list is `colorize, errorValue,
formatWatchEvent, homeView, leanStatus, projectContext, projectDoctorStats,
projectList, writeToon`), so their removal from `output.js` in Step 3 needs no
import-line change on that account. This step does need to add `writeError`
to that import list, though — see the code block below.

Replace the entire `describe("writeToon status coloring", ...)` and
`describe("writeToon doctor coloring", ...)` blocks (they assert the old
marker-patched-TOON-text output, which no longer exists) with:

```js
describe("writeToon TTY output", () => {
  test("routes to the pretty renderer when stdout is a TTY", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ id: "a", status: "done" }, io);

    assert.ok(output().includes("\x1b[32mdone\x1b[39m"), output());
    assert.ok(!output().includes("status: "), output()); // no TOON `key: value` syntax
  });

  test("still writes plain TOON with no ANSI codes when stdout is not a TTY", () => {
    const { io, output } = fakeStdoutIo(false);
    writeToon({ id: "a", status: "done" }, io);

    assert.ok(!output().includes("\x1b["), output());
    assert.ok(output().includes("status: done"), output());
  });

  test("non-TTY output for a task list is byte-identical to the pre-existing TOON shape", () => {
    const { io, output } = fakeStdoutIo(false);
    writeToon({ tasks: [{ id: "a", status: "done" }, { id: "b", status: "crashed" }] }, io);

    assert.equal(output(), "tasks[2]{id,status}:\n  a,done\n  b,crashed\n\n");
  });

  test("writeError on a TTY falls through to the fallback renderer's bold labels (intentional -- see the spec's Error output section)", () => {
    const { io, output } = fakeStdoutIo(true);
    writeError(new Error("error: boom\nhelp: try again"), io);

    assert.ok(output().includes("boom"), output());
    assert.ok(output().includes("try again"), output());
    assert.ok(!output().includes("error: boom"), output()); // not raw TOON `key: value` syntax anymore
  });

  test("writeError on non-TTY is unchanged: plain TOON error:/help: lines", () => {
    const { io, output } = fakeStdoutIo(false);
    writeError(new Error("error: boom\nhelp: try again"), io);

    assert.ok(!output().includes("\x1b["), output());
    assert.ok(output().includes("error: boom") && output().includes("help: try again"), output());
  });
});
```

`writeError` isn't in this file's current import list — add it alongside `writeToon`:

```js
import { colorize, errorValue, formatWatchEvent, homeView, leanStatus, projectContext, projectDoctorStats, projectList, writeError, writeToon } from "./output.js";
```

(The third test's exact expected TOON string should be confirmed against this repo's actual `@toon-format/toon` output before treating it as fixed — run Step 2 below and adjust the literal to match whatever the real `encode()` output is; the goal is a byte-identical non-TTY snapshot, not a specific guessed string.)

- [ ] **Step 2: Run the tests to verify the new ones fail (and see the real non-TTY TOON string for the byte-identical test)**

Run: `node --test src/output.test.js`
Expected: the two `writeToon TTY output` "routes to the pretty renderer"/"still writes plain TOON" tests FAIL (still hitting the old marker-based code path, so the TTY one won't see `\x1b[32mdone\x1b[39m` and may see `\x1b[32mdone\x1b[0m` instead, or the old code's exact byte sequence — either way it won't match). Copy the actual printed non-TTY string from the third test's failure output (if it fails) into the test literal so it's a real captured value, not a guess.

- [ ] **Step 3: Delete the dead marker-based coloring code from `output.js`**

Remove these from `src/output.js` (lines given are from the file's current state before this task's edits; re-locate by content if line numbers have drifted from earlier commits in this same session):

- `ANSI_GRAY` (line 9) and `ANSI_DIM` (line 10) constants
- `ANSI_BY_TREND_DIRECTION` (line 34) and `colorForTrendDirection()` (lines 35-37)
- `colorForPassFailToken()` (lines 44-48)
- The entire comment block plus `ENUM_MARK`/`WARN_MARK`/`INFO_MARK`/`MARK_RE` (lines 50-70)
- `ENUM_KEYS`/`WARN_KEYS`/`INFO_KEYS` (lines 72-80)
- `isMarkableScalar()` (lines 82-84)
- `markStringArray()` (lines 86-88)
- `markColorableFields()` (lines 90-101)
- `colorForMarkedToken()` (lines 103-107)
- `colorizeText()` (lines 109-115)

- [ ] **Step 4: Replace `writeToon()` with the TTY-gated dispatch**

Change (originally at line 121-125):

```js
export function writeToon(value, io = process) {
  const useColor = Boolean(io.stdout.isTTY);
  const text = encode(useColor ? markColorableFields(value) : value);
  io.stdout.write(`${colorizeText(text, useColor)}\n`);
}
```

to:

```js
export function writeToon(value, io = process) {
  if (io.stdout.isTTY) {
    io.stdout.write(`${renderPretty(value)}\n`);
    return;
  }
  io.stdout.write(`${encode(value)}\n`);
}
```

Add the import at the top of the file, alongside the existing `encode` import:

```js
import { renderPretty } from "./pretty.js";
```

- [ ] **Step 5: Run the full `output.js` test suite and verify everything passes**

Run: `node --test src/output.test.js`
Expected: PASS, including every pre-existing non-TTY test (unchanged) and the new TTY tests from Step 1.

- [ ] **Step 6: Run the full unit test suite to catch any other test file that referenced the removed exports**

Run: `npm run test:unit`
Expected: PASS. If any other test file imports `markColorableFields`, `colorizeText`, `colorForTrendDirection`, or `colorForPassFailToken` from `output.js`, it will fail to import — confirm with `rg -n "colorForTrendDirection|colorForPassFailToken|markColorableFields|colorizeText" src --glob '*.js'` that no remaining reference exists outside `pretty.js`'s own differently-named functions, and delete/update any stray test that still references them.

- [ ] **Step 7: Commit**

```bash
git add src/output.js src/output.test.js
git commit -m "refactor(cli): route TTY output through the pretty renderer, drop dead marker-based coloring"
```

---

