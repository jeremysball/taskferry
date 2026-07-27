# Duration-String Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `--timeout` on `wait` and `advisor` accept a duration string (`30s`, `5m`, `1h`) in addition to a bare millisecond integer, via one shared `parseDuration` helper, replacing the old `--timeout-ms` flag name.

**Architecture:** A new pure-function helper (`parseDuration`) in `src/args.js` sits alongside the existing `parseNumber`, applied only to the `timeoutMs` option key. The flag name changes from `--timeout-ms` to `--timeout`; the internal option key (`timeoutMs`) and everything downstream of `parseArgs` (protocol, daemon, `tasks.js`) is untouched. The old name becomes a migration error, following the existing `migrationFlags` pattern already used for `--timeout_ms` → `--timeout-ms`.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), no new dependencies.

## Global Constraints

- Duration strings accept exactly one unit suffix (`s`, `m`, or `h`), lowercase only — no compounding (`1h30m`), no decimals, no whitespace, per the spec's non-goals.
- Bare non-negative integers stay valid and are interpreted as milliseconds — `--timeout 0` must keep working exactly as `--timeout-ms 0` does today (min 0, not min 1).
- `cancel --grace-ms` is explicitly out of scope and stays millisecond-only.
- The internal option key stays `timeoutMs` — no changes to `src/protocol.js`, `src/daemon.js`, or `src/tasks.js`.
- Every place `--timeout-ms` is mentioned in code, tests, or docs must be updated in the same plan (see spec's "Full rename blast radius"), not just the parser.

---

## File Structure

- **Modify `src/args.js`**: add `parseDuration`; wire it into the `timeoutMs` value-parsing branch (replacing `parseNumber` for that one key only); rename `--timeout-ms` → `--timeout` in `commandSpecs` (help text/examples for `wait` and `advisor`), the `values` map, `commandAllows` lists, and the `--summarize`-combination error message; add a `--timeout-ms` migration entry and collapse the existing `--timeout_ms` entry to point straight at `--timeout`.
- **Modify `src/args.test.js`**: update the one existing `--timeout-ms` reference to `--timeout`; add dedicated `parseDuration` coverage (valid suffixes, bare integer including `0`, and rejection cases) driven through `parseArgs` on `wait`; add a test asserting `--timeout-ms` now errors with the new migration message.
- **Modify `docs/cli-reference.md`**: rename `--timeout-ms` to `--timeout` in the `wait` and `advisor` sections (options table, prose, example command).
- **Modify `docs/sourcemap.md`**: rename the one `--timeout-ms` mention.
- **Modify `skills/using-taskferry/SKILL.md`** (canonical — do not edit the generated copies directly): rename its two `--timeout-ms` mentions.
- **Regenerate** `integrations/claude/skills/using-taskferry/SKILL.md` and `integrations/codex/skills/using-taskferry/SKILL.md` via `npm run skill:generate`, verified with `npm run skill:check`.

---

### Task 1: `parseDuration` helper with full unit coverage

**Files:**
- Modify: `src/args.js` (add `parseDuration` near the existing `parseNumber`, around `src/args.js:185-193`)
- Test: `src/args.test.js`

**Interfaces:**
- Produces: `parseDuration(value: string, flag: string): number` — a module-private function in `src/args.js` (not exported; consumed only inside `parseArgs`'s value-parsing branch in Task 2). Throws `UsageError` (imported from `./errors.js`, already imported in `src/args.js:2`) on anything that isn't a bare non-negative integer or `<digits><s|m|h>`. Returns milliseconds.

- [ ] **Step 1: Write the failing tests**

Add to `src/args.test.js` (near the top, after the existing imports — this drives the implementation directly since `parseDuration` isn't exported, so test it indirectly through `parseArgs(["wait", "id", "--timeout", ...])`, which Task 2 wires up; write this test now, expect it to fail until Task 2 lands, then come back and run it clean at the end of Task 2 too):

```javascript
test("wait --timeout accepts bare milliseconds and duration strings", () => {
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "0"]).options.timeoutMs, 0);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "10000"]).options.timeoutMs, 10000);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "30s"]).options.timeoutMs, 30_000);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "5m"]).options.timeoutMs, 300_000);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "1h"]).options.timeoutMs, 3_600_000);
});

test("wait --timeout rejects malformed duration strings", () => {
  const cases = ["-1", "1.5m", "5M", "1h30m", " 5m", "5m ", "5", "abc", ""];
  for (const value of cases) {
    assert.throws(() => parseArgs(["wait", "oc_1", "--timeout", value]), UsageError, `expected rejection for "${value}"`);
  }
});
```

Note: the `""` case is actually caught earlier by `requireValue`'s empty-value check (`src/args.js:197`/`202`), not by `parseDuration` itself — that's fine, it should still throw `UsageError` either way, which is all this test asserts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `--timeout` is not yet a recognized flag for `wait` (this task only adds the helper function; Task 2 wires it into the parser). The failure should be a `commandAllows`/"unknown flag --timeout" error, confirming nothing is wired yet.

- [ ] **Step 3: Implement `parseDuration`**

In `src/args.js`, immediately after the existing `parseNumber` function (`src/args.js:185-193`):

```javascript
const DURATION_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000 };

function parseDuration(value, flag) {
  const remediation = `Use ${flag} with milliseconds (e.g. 10000) or a duration string (e.g. 30s, 5m, 1h)`;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (!Number.isSafeInteger(ms)) throw new UsageError(`${flag} must be a safe integer number of milliseconds`, remediation);
    return ms;
  }
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new UsageError(`${flag} must be milliseconds or a duration like 30s, 5m, 1h`, remediation);
  const ms = Number(match[1]) * DURATION_UNITS_MS[match[2]];
  if (!Number.isSafeInteger(ms)) throw new UsageError(`${flag} is too large`, remediation);
  return ms;
}
```

This step alone doesn't make the Step 1 tests pass yet (nothing calls it), which is expected — Task 2 wires it in. Do not run the tests again until Task 2; this task's job is just to have the function exist and be correct in isolation. Confirm it compiles by running lint on this file only:

Run: `npx eslint src/args.js`
Expected: no new errors (an unused-function warning is expected and fine at this point — Task 2 removes it by using the function).

- [ ] **Step 4: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(args): add parseDuration helper for duration-string flag values"
```

---

### Task 2: Rename `--timeout-ms` to `--timeout` and wire in `parseDuration`

**Files:**
- Modify: `src/args.js`
- Modify: `src/args.test.js`

**Interfaces:**
- Consumes: `parseDuration(value, flag)` from Task 1.
- Produces: `wait` and `advisor` now accept `--timeout <value>` (option key `timeoutMs`, unchanged); `--timeout-ms` and `--timeout_ms` both error via `migrationFlags` pointing at `--timeout`.

- [ ] **Step 1: Update `commandSpecs` help text (`src/args.js:35-61`)**

Change the `wait` command's options entry:

```javascript
"--timeout <duration>": "maximum wait, e.g. 10000 (ms), 30s, 5m, 1h",
```

replacing the existing `"--timeout-ms <number>": "maximum wait in milliseconds",` line, and update its example:

```javascript
examples: ['taskferry wait <id>', 'taskferry wait <id> --timeout 10s --tail-chars 1000', 'taskferry wait <id> --summarize'],
```

Change the `advisor` command's options entry the same way:

```javascript
"--timeout <duration>": "maximum wait, e.g. 10000 (ms), 30s, 5m, 1h",
```

replacing its `"--timeout-ms <number>": "maximum wait in milliseconds",` line, and update its example:

```javascript
examples: [
  'taskferry advisor --prompt "How should I split this module?" --model openai/gpt-5.6-sol',
  'taskferry advisor --prompt "Review this design" --model zai/glm-5.2 --timeout 30s',
],
```

- [ ] **Step 2: Update the `migrationFlags` table (`src/args.js:300-307`)**

Replace:

```javascript
"--timeout_ms": "--timeout_ms was renamed; use --timeout-ms",
```

with:

```javascript
"--timeout_ms": "--timeout_ms was renamed; use --timeout",
"--timeout-ms": "--timeout-ms was renamed; use --timeout",
```

- [ ] **Step 3: Update the `values` map (`src/args.js:329-349`)**

Replace:

```javascript
"--timeout-ms": "timeoutMs",
```

with:

```javascript
"--timeout": "timeoutMs",
```

- [ ] **Step 4: Wire `parseDuration` into the value-parsing branch (`src/args.js:355-356`)**

Replace:

```javascript
if (["graceMs", "timeoutMs", "tailChars", "chars", "maxWords", "limit"].includes(key)) {
  value = parseNumber(value, name, key === "tailChars" || key === "chars" ? { min: 1, max: 65536 } : key === "maxWords" ? { min: 75, max: 300 } : { min: key === "limit" ? 1 : 0 });
}
```

with:

```javascript
if (key === "timeoutMs") {
  value = parseDuration(value, name);
} else if (["graceMs", "tailChars", "chars", "maxWords", "limit"].includes(key)) {
  value = parseNumber(value, name, key === "tailChars" || key === "chars" ? { min: 1, max: 65536 } : key === "maxWords" ? { min: 75, max: 300 } : { min: key === "limit" ? 1 : 0 });
}
```

- [ ] **Step 5: Update the `--summarize` combination error (`src/args.js:392-393`)**

Replace:

```javascript
if (command === "wait" && options.summarize && options.timeoutMs !== undefined) {
  throw usageError("--summarize cannot be combined with --timeout-ms", command);
}
```

with:

```javascript
if (command === "wait" && options.summarize && options.timeoutMs !== undefined) {
  throw usageError("--summarize cannot be combined with --timeout", command);
}
```

- [ ] **Step 6: Update `commandAllows` (`src/args.js:403-417`)**

Replace `wait: ["--timeout-ms", "--tail-chars"],` with `wait: ["--timeout", "--tail-chars"],` and replace `advisor: ["--prompt", "--model", "--directory", "--variant", "--session-id", "--timeout-ms", "--executor"],` with `advisor: ["--prompt", "--model", "--directory", "--variant", "--session-id", "--timeout", "--executor"],`.

- [ ] **Step 7: Update `src/args.test.js`'s existing `--timeout-ms` test**

The test at `src/args.test.js:187-197` (`"parses wait --summarize and rejects it combined with --timeout-ms or --tail-chars"`) currently ends with:

```javascript
assert.throws(() => parseArgs(["wait", "oc_1", "--summarize", "--timeout-ms", "5000"]), /--summarize cannot be combined with --timeout-ms/);
```

Change both to `--timeout`:

```javascript
assert.throws(() => parseArgs(["wait", "oc_1", "--summarize", "--timeout", "5000"]), /--summarize cannot be combined with --timeout/);
```

- [ ] **Step 8: Add the migration-error test**

Add to `src/args.test.js`:

```javascript
test("--timeout-ms and --timeout_ms both error with a migration message pointing at --timeout", () => {
  assert.throws(() => parseArgs(["wait", "oc_1", "--timeout-ms", "5000"]), /--timeout-ms was renamed; use --timeout/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--timeout_ms", "5000"]), /--timeout_ms was renamed; use --timeout/);
  assert.throws(() => parseArgs(["advisor", "--prompt", "p", "--model", "m", "--timeout-ms", "5000"]), /--timeout-ms was renamed; use --timeout/);
});
```

- [ ] **Step 9: Run the full test suite to verify everything passes**

Run: `node --test src/args.test.js`
Expected: PASS — including the Task 1 tests (`wait --timeout accepts bare milliseconds and duration strings`, `wait --timeout rejects malformed duration strings`), which now pass end-to-end since `--timeout` is wired up.

Also run the full unit suite to confirm no other file's tests reference the old flag name:

Run: `npm run test:unit`
Expected: PASS (536+ tests). If any test outside `args.test.js` fails on `--timeout-ms`, grep for it: `rg -n -- '--timeout-ms' src/*.test.js` and update it the same way as Step 7.

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: 0 errors (pre-existing warning count unchanged from before this task — do not introduce new ones).

- [ ] **Step 11: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(args): rename --timeout-ms to --timeout, accept duration strings"
```

---

### Task 3: Update docs and the canonical skill, regenerate generated copies

**Files:**
- Modify: `docs/cli-reference.md`
- Modify: `docs/sourcemap.md`
- Modify: `skills/using-taskferry/SKILL.md` (canonical — do not touch the generated copies by hand)
- Generate: `integrations/claude/skills/using-taskferry/SKILL.md`, `integrations/codex/skills/using-taskferry/SKILL.md` (via script, not manual edit)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure documentation).
- Produces: nothing consumed by later tasks — this is the final task in this plan.

- [ ] **Step 1: Update `docs/cli-reference.md`**

Four spots reference `--timeout-ms` for `wait`/`advisor` (verify current line numbers with `rg -n -- '--timeout-ms' docs/cli-reference.md` before editing, since earlier tasks may have shifted nothing here but it's good practice):
- Line ~84: `"Pass \`--timeout-ms\` to override the"` → `"Pass \`--timeout\` to override the"`
- Line ~91: `"| \`--timeout-ms <number>\` | Override the default timeout cap in milliseconds; omit to use the 15-minute default |"` → `"| \`--timeout <duration>\` | Override the default timeout cap — milliseconds or a duration string (30s, 5m, 1h); omit to use the 15-minute default |"`
- Line ~94: `"Cannot combine with \`--timeout-ms\` or \`--tail-chars\`."` → `"Cannot combine with \`--timeout\` or \`--tail-chars\`."`
- Line ~98: `"again to keep polling, or pass \`--timeout-ms\` for a longer cap. This"` → `"again to keep polling, or pass \`--timeout\` for a longer cap. This"`
- Line ~103: `"$ taskferry wait oc_mrn4ipkp_19450105 --timeout-ms 30000"` → `"$ taskferry wait oc_mrn4ipkp_19450105 --timeout 30s"`
- Line ~133 (in the `advisor` section): `"| \`--timeout-ms <number>\` | Early-return cap in milliseconds, same semantics as \`wait\`; omitting it does not block indefinitely — it falls back to a 45-second internal cap, after which the "still running" response below is returned |"` → same text with `--timeout <duration>` in place of `--timeout-ms <number>`.

- [ ] **Step 2: Update `docs/sourcemap.md`**

Verify with `rg -n -- '--timeout-ms' docs/sourcemap.md` (expected around lines 131-132) and replace both `--timeout-ms` mentions with `--timeout`.

- [ ] **Step 3: Update the canonical skill file**

Edit `skills/using-taskferry/SKILL.md` only (never `integrations/*/skills/using-taskferry/SKILL.md` directly — those are regenerated in Step 4). Verify with `rg -n -- '--timeout-ms' skills/using-taskferry/SKILL.md` (expected around lines 162 and 178) and replace both mentions with `--timeout`.

- [ ] **Step 4: Regenerate the generated skill copies**

Run: `npm run skill:generate`
Expected: exits 0, silently overwrites `integrations/claude/skills/using-taskferry/SKILL.md` and `integrations/codex/skills/using-taskferry/SKILL.md` with the canonical file's new content.

- [ ] **Step 5: Verify the generated copies are in sync**

Run: `npm run skill:check`
Expected: exits 0 with no output (this is the same check `taskferry dispatch` runs via `checkSkills()` before every dispatch — if this fails, dispatch itself would hard-fail for every user of this repo's checkout).

- [ ] **Step 6: Confirm no other `--timeout-ms` mentions were missed**

Run: `rg -n -- '--timeout-ms' --glob '!*.test.js' .`
Expected: no matches. (Test-file matches, if any remain, were already handled in Task 2, Step 7-8 — this is a final sweep across docs/skills specifically, run with the test-file glob excluded so it only flags documentation drift, not intentional test assertions about the migration error message.)

- [ ] **Step 7: Commit**

```bash
git add docs/cli-reference.md docs/sourcemap.md skills/using-taskferry/SKILL.md integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md
git commit -m "docs: update --timeout-ms references to --timeout, regenerate skill copies"
```

---

## Self-Review Notes

- **Spec coverage:** `parseDuration` (Task 1), the `--timeout` rename and full blast radius including `commandSpecs`, `migrationFlags`, `values` map, `commandAllows`, the `--summarize` error string, and `docs/cli-reference.md`/`docs/sourcemap.md`/`skills/using-taskferry/SKILL.md` (Tasks 2-3) are all covered. The spec's explicit non-goals (`--grace-ms` untouched, no compound durations) have no corresponding task, correctly.
- **Placeholder scan:** no TBD/TODO; every step has literal code or literal commands.
- **Type consistency:** `parseDuration(value, flag)` signature is identical between Task 1's definition and Task 2's call site (`parseDuration(value, name)` — `name` is the flag string variable already in scope at that point in `parseArgs`, matching the `flag` parameter name used in the function body).
