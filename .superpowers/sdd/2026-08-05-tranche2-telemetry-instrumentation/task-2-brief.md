### Task 2: `finalStatus` — parsed closing Status: marker

**Files:**
- Modify: `src/tasks.js`
- Modify: `src/protocol.js`
- Test: `src/tasks.watchdog.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 — independent.
- Produces: `task.finalStatus` (`string|null`), one of `"DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT" | null`, persisted on every task and surfaced in `summarize()` output when non-null. Distinct from `task.finalMarker` (the existing `--require-final-marker` regex source) and from `task.status` (the task lifecycle state).

- [ ] **Step 1: Initialize `finalStatus` on new tasks**

In `src/tasks.js`, in `buildDispatchTask`'s returned object, add right after `finalMarker: finalMarker == null ? null : finalMarker,`:

```js
    finalStatus: null,
```

- [ ] **Step 2: Parse the closing Status: marker at settlement**

In `evaluateOutputCompleteness(task)` (same file), add the parse right after the existing `finalMarker` regex-gate block, still inside the function, using the final `message` text already extracted:

```js
const STATUS_MARKER_RE = /^Status:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\s*$/m;

function evaluateOutputCompleteness(task) {
  const message = extractFinalMessage(task.logPath);
  if (!message.trim()) {
    task.incomplete = true;
    return;
  }
  if (task.finalMarker) {
    try {
      if (!new RegExp(task.finalMarker).test(message)) task.incomplete = true;
    } catch {
      task.incomplete = true;
    }
  }
  const statusMatch = message.match(STATUS_MARKER_RE);
  if (statusMatch) task.finalStatus = statusMatch[1];
}
```

(`STATUS_MARKER_RE` is a module-level `const`, declared once above the function — do not redeclare it inside the function body on every call.)

- [ ] **Step 3: Surface `finalStatus` in the task summary**

In `summarizeOptionalFields(task)`, destructure `finalStatus` from `task` alongside the existing fields and add it to the returned spread, right after the `finalMarker` line (and, if Task 1 already landed, right before or after the `class` line — order between the two doesn't matter):

```js
function summarizeOptionalFields(task) {
  const { promptTotalChars, incomplete, finalMarker, finalStatus, executorId } = task;
  return {
    ...(promptTotalChars != null ? { promptTotalChars } : {}),
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(incomplete === true ? { incomplete: true } : {}),
    ...(finalMarker != null ? { finalMarker } : {}),
    ...(finalStatus != null ? { finalStatus } : {}),
    ...(executorId != null ? { executorId } : {}),
    ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
    ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
  };
}
```

- [ ] **Step 4: Add `finalStatus` to the result-fields allow-list**

In `src/protocol.js`, add `"finalStatus"` to the `RESULT_FIELDS` set, right after `"finalMarker"`.

- [ ] **Step 5: Write the settlement-parsing tests**

In `src/tasks.watchdog.test.js`, add a new `describe` block near the existing `--require-final-marker` gating block (reuse `writeLog`, `makeManager`, `fakeChild` already imported/defined in this file):

```js
describe("finalStatus: parsed closing Status: marker at settlement", () => {
  test("a message ending in Status: DONE persists finalStatus", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "All done.\nStatus: DONE" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.finalStatus, "DONE");
  });

  test("DONE_WITH_CONCERNS is captured whole, not truncated to DONE", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Mostly done.\nStatus: DONE_WITH_CONCERNS" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal(settled.finalStatus, "DONE_WITH_CONCERNS");
  });

  test("BLOCKED and NEEDS_CONTEXT are both recognized", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Stuck.\nStatus: BLOCKED" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    assert.equal(mgr.status(dispatched.id).finalStatus, "BLOCKED");
  });

  test("a message with no Status: line leaves finalStatus unset", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Just some prose, no marker." } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal("finalStatus" in settled, false);
  });

  test("finalStatus is independent of --require-final-marker: parsed even when no gate is set", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Status: NEEDS_CONTEXT" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    const settled = mgr.status(dispatched.id);
    assert.equal("finalMarker" in settled, false);
    assert.equal(settled.finalStatus, "NEEDS_CONTEXT");
  });

  test("finalStatus survives a daemon restart via tasks.json", () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    writeLog(dispatched.logPath, [
      { type: "text", part: { messageID: "m1", text: "Status: DONE" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop" } },
    ]);
    child.emit("exit", 0, null);
    mgr.status(dispatched.id);
    const reloaded = mgr.reloadFromDisk ? mgr.reloadFromDisk() : mgr; // match whatever restart-simulation helper the existing "survives a daemon restart" test in this file actually uses
    assert.equal(reloaded.status(dispatched.id).finalStatus, "DONE");
  });
});
```

The last test's restart-simulation mechanism is a placeholder for "match the existing pattern" — before writing it, read the existing `"incomplete and finalMarker survive a daemon restart via tasks.json"` test in this same file (already read once during planning; it is a few lines below the `--require-final-marker` block) and copy its exact restart mechanism (it reconstructs a manager from the persisted `tasks.json`, not a `reloadFromDisk()` method) rather than the placeholder call shown above.

- [ ] **Step 6: Run the watchdog tests**

Run: `node --test src/tasks.watchdog.test.js`
Expected: PASS, including all 6 new `finalStatus` tests.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js src/protocol.js src/tasks.watchdog.test.js
git commit -m "feat(dispatch): parse the closing Status: marker into finalStatus

Persists the worker-written closing Status: DONE|DONE_WITH_CONCERNS|
BLOCKED|NEEDS_CONTEXT marker as a new finalStatus field at settlement,
independent of --require-final-marker. Distinct from the existing
finalMarker field (the stored regex source used only as a match/no-
match gate), per Tranche 2 of the LiveBench-first model-selection
spec."
```

---

## Self-Review Notes

- **Spec coverage:** Item 1 (class tag) → Task 1. Item 2 (outcome signal) → changeset-acceptance half needs no code (already `changesetStatus`, documented in the spec edit made before this plan); final-marker half → Task 2. Item 3 (backfill stance) is a no-op by construction — old tasks simply have `class: null` / `finalStatus: null`, nothing to build. Item 4 (grain / aggregation) lives in the `choosing-a-model` skill, out of scope for this repo.
- **Placeholder scan:** Task 2 Step 5's last test contains one explicit, flagged placeholder (the restart mechanism) with an explicit instruction to replace it by reading the neighboring existing test before writing — left in deliberately because the exact helper name wasn't re-verified during planning; every other step has concrete, complete code.
- **Type consistency:** `class` is aliased to `taskClass` consistently at every destructure site (`dispatchTask`, `dispatchAdvisorTask`, `summarizeOptionalFields`, `buildDispatchTask`'s params). `finalStatus` uses the same literal name everywhere (no alias needed — not a reserved word).
