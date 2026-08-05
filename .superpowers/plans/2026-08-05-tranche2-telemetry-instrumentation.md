# Tranche 2 Telemetry Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give taskferry the two persisted signals the LiveBench-first model-selection telemetry needs — a validated `--class` tag on `dispatch`/`advisor`, and a parsed `finalStatus` outcome field for reviewer/advisor/researcher classes — without touching or renaming any existing field.

**Architecture:** Both signals are plain additive fields on the existing `Task` record, validated the same way `--executor` already is (a shared allow-list module, a CLI coercer, a protocol-layer predicate). `finalStatus` is parsed from the worker's final message text at settlement time, alongside (not instead of) the existing `finalMarker`/`incomplete` check. Changeset acceptance (the other half of "outcome") needs no new field — telemetry aggregation, which lives outside this repo in the `choosing-a-model` skill, reads the existing `changesetStatus` field directly for implementer/fixer classes.

**Tech Stack:** Node.js, `node:test` + `node:assert/strict`, no new dependencies.

## Global Constraints

- Never repurpose or rename the existing `finalMarker` field (the stored `--require-final-marker` regex source, used only as a match/no-match gate) — the new parsed marker value is a distinct field, `finalStatus`.
- Do not add a new `outcome` field — implementer/fixer changeset acceptance is already `task.changesetStatus`; telemetry reads that directly.
- `class` is a reserved word for JS variable/parameter declarations (not for object property keys). Every destructure of a `class` field must use an alias, e.g. `const { class: taskClass } = params`.
- Run `npm run skill:generate` after any `src/command-specs.js` change and commit the regenerated file in the same commit — it is the canonical→generated split described in this repo's global instructions.
- Follow this repo's existing conventions exactly: `node:test`/`node:assert/strict`, Conventional Commits messages, one task = one commit (or a tight sequence of commits) ending in a full `npm test` run.

---

### Task 1: `--class` task-classification tag

**Files:**
- Create: `src/task-classes.js`
- Modify: `src/args.js`
- Modify: `src/protocol.js`
- Modify: `src/tasks.js`
- Modify: `src/commands.js`
- Modify: `src/command-specs.js`
- Test: `src/args.test.js`
- Test: `src/protocol.test.js`
- Test: `src/commands.test.js`
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: nothing from other tasks (this task is the class-tag source of truth).
- Produces: `TASK_CLASSES` (readonly `string[]`) exported from `src/task-classes.js`, imported by both `src/args.js` and `src/protocol.js`. A `task.class` field (`string|null`) on every dispatched `Task`, set from `params.class` at dispatch time, surfaced in `summarize()` output when non-null. Task 2 does not depend on this — it can be implemented independently.

- [ ] **Step 1: Write `src/task-classes.js` with the canonical class list**

```js
// Canonical task-class list, validated against by `--class` on dispatch and
// advisor. Mirrors the class -> axis mapping table documented in the
// choosing-a-model skill (~/.claude/skills/choosing-a-model) -- taskferry
// has no import path to that skill's markdown, so this list must be kept in
// sync by hand if the skill's table changes.
export const TASK_CLASSES = /** @type {readonly string[]} */ ([
  "implementer",
  "transcription",
  "fixer",
  "task-reviewer",
  "final-reviewer",
  "advisor-statistical",
  "advisor-design",
  "architecture",
  "code-review-finder",
  "code-review-verifier",
  "researcher",
]);
```

- [ ] **Step 2: Add `--class` to `src/args.js`**

Add the import near the top, alongside the existing `KNOWN_EXECUTORS` import:

```js
import { KNOWN_EXECUTORS } from "./executor.js";
import { TASK_CLASSES } from "./task-classes.js";
```

Add a coercer next to `coerceExecutor` (same file, same pattern):

```js
function coerceClass(value, name) {
  if (!TASK_CLASSES.includes(value)) throw new UsageError(`${name} must be one of ${TASK_CLASSES.join(", ")}`, `Use --class with one of: ${TASK_CLASSES.join(", ")}`);
  return value;
}
```

Add the flag to the `FLAGS` table, directly after the `"--executor"` line:

```js
  "--class": { allow: ["dispatch", "advisor"], key: "class", coerce: coerceClass },
```

- [ ] **Step 3: Write the args.js tests**

In `src/args.test.js`, add near the existing executor tests:

```js
test("dispatch accepts a known --class value", () => {
  const { options } = parseArgs(["dispatch", "--prompt", "x", "--class", "implementer"], { cwd: CWD });
  assert.equal(options.class, "implementer");
});

test("dispatch rejects an unknown --class value", () => {
  assert.throws(
    () => parseArgs(["dispatch", "--prompt", "x", "--class", "bogus"], { cwd: CWD }),
    /--class must be one of/
  );
});

test("advisor accepts a known --class value", () => {
  const { options } = parseArgs(["advisor", "--model", "m", "--class", "advisor-design"]);
  assert.equal(options.class, "advisor-design");
});

test("advisor rejects an unknown --class value", () => {
  assert.throws(
    () => parseArgs(["advisor", "--model", "m", "--class", "bogus"]),
    /--class must be one of/
  );
});
```

Also update the existing exact-match defaults assertion (it does `assert.deepEqual` against the full options object, so a new FLAGS entry breaks it until updated):

```js
test("parses dispatch and applies its argument defaults", () => {
  assert.deepEqual(parseArgs(["dispatch", "--prompt", "do it"], { cwd: CWD }), {
    command: "dispatch",
    options: {
      prompt: "do it",
      directory: CWD,
      model: void 0,
      variant: void 0,
      sessionId: void 0,
      finalMarker: void 0,
      noSandbox: false,
      noOverlay: false,
      allowedDirs: void 0,
      executor: void 0,
      class: void 0,
    },
    help: false,
  });
});
```

- [ ] **Step 4: Run the args tests to see the new ones fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `--class` is not yet a recognized flag (`unknown flag --class`), and the defaults deepEqual fails on the missing `class` key.

- [ ] **Step 5: Run the args tests to see them pass**

Run: `node --test src/args.test.js`
Expected: PASS, all tests green (Step 2's edit already lands the fix — this step is the verification checkpoint, not a further code change).

- [ ] **Step 6: Add `class` to the `task.dispatch`/`task.advisor` protocol schema**

In `src/protocol.js`, add the import next to `KNOWN_EXECUTORS`:

```js
import { KNOWN_EXECUTORS } from "./executor.js";
import { TASK_CLASSES } from "./task-classes.js";
```

Add a validator next to `isKnownExecutor`:

```js
/** @param {unknown} value @returns {value is string} */
function isKnownClass(value) {
  return typeof value === "string" && TASK_CLASSES.includes(value);
}
```

In `METHOD_PARAMS["task.dispatch"].optional`, add `["class", isKnownClass],` (anywhere in that array, e.g. right after `["executor", isKnownExecutor],`).

In `METHOD_PARAMS["task.advisor"].optional`, add the same `["class", isKnownClass],` entry.

Add `"class"` to the `RESULT_FIELDS` set (so `taskferry result --fields class` is selectable), right after `"finalMarker"`.

- [ ] **Step 7: Write the protocol.js tests**

In `src/protocol.test.js`, find the existing `task.dispatch`/`task.advisor` param-validation `describe` blocks and add:

```js
test("task.dispatch accepts a known class value", () => {
  const error = parseRequestLine(request(METHOD.dispatch, { prompt: "p", directory: TEST_DIR, class: "implementer" }));
  assert.equal(error, null);
});

test("task.dispatch rejects an unknown class value", () => {
  const error = parseRequestLine(request(METHOD.dispatch, { prompt: "p", directory: TEST_DIR, class: "bogus" }));
  assert.ok(error instanceof ProtocolError);
});

test("task.advisor accepts a known class value", () => {
  const error = parseRequestLine(request(METHOD.advisor, { prompt: "p", directory: TEST_DIR, model: "m", class: "advisor-design" }));
  assert.equal(error, null);
});
```

Check `parseRequestLine`'s actual return shape first (some existing test in the same file already asserts success/failure on `task.dispatch` — match that exact pattern instead of guessing; the snippet above is illustrative of intent, not a literal copy-paste if the real helper returns something other than `null` on success).

- [ ] **Step 8: Run the protocol tests to see the new ones fail, then pass**

Run: `node --test src/protocol.test.js`
Expected: FAIL first (unknown `class` param rejected as an unrecognized key, since it isn't in the schema yet — but Step 6 already landed the schema change, so run this after Step 6 and expect PASS directly; if it fails, Step 6's edit is incomplete).

- [ ] **Step 9: Persist `class` on the task record in `src/tasks.js`**

Update `buildDispatchTask`'s JSDoc `@param` typedef to add `class?: string|null` to the params type, and its destructure + return:

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass }) {
```

Add to the returned object, right after `finalMarker: finalMarker == null ? null : finalMarker,`:

```js
    class: taskClass == null ? null : taskClass,
```

Update `dispatchTask`'s JSDoc `@param` to add `class?: string|null`, its destructure (alias required — `class` is reserved):

```js
function dispatchTask(params, ctx) {
  const { prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, executor: executorName, env, role = "dispatch", class: taskClass = null } = params;
```

and pass it through to `buildDispatchTask`:

```js
  const task = buildDispatchTask({ id, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, directory: normalizedDirectory, class: taskClass });
```

Update `dispatchAdvisorTask`'s JSDoc `@param` to add `class?: string|null`, its destructure, and forward it into `ctx.dispatch`:

```js
function dispatchAdvisorTask(ctx, params) {
  const { prompt, directory, model, variant, sessionId, executor, env, class: taskClass } = params;
  try {
    return ctx.dispatch({ model, variant, sessionId, executor, env, prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), role: "advisor", class: taskClass });
  } catch (err) {
    throw new Error(ctx.errMessage(err).replaceAll("taskferry dispatch", "taskferry advisor"), { cause: err });
  }
}
```

Also update the `AdvisorContext.dispatch` JSDoc `@property` signature (same file, just above `dispatchAdvisorTask`) to add `class?: string|null` to its params type, matching the pattern already used for `variant`/`sessionId`.

- [ ] **Step 10: Surface `class` in the task summary**

In `summarizeOptionalFields(task)`, destructure `class: taskClass` from `task` (alias required) and add it to the returned spread, right after the `finalMarker` line:

```js
function summarizeOptionalFields(task) {
  const { promptTotalChars, incomplete, finalMarker, executorId, class: taskClass } = task;
  return {
    ...(promptTotalChars != null ? { promptTotalChars } : {}),
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(incomplete === true ? { incomplete: true } : {}),
    ...(finalMarker != null ? { finalMarker } : {}),
    ...(taskClass != null ? { class: taskClass } : {}),
    ...(executorId != null ? { executorId } : {}),
    ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
    ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
  };
}
```

- [ ] **Step 11: Write the tasks.js persistence/summary tests**

In `src/tasks.dispatch.test.js`, add (matching the file's existing `makeManager`/`mgr.dispatch` style — check an existing test in this file for the exact manager setup helper before writing, since the helper name may differ slightly from `tasks.watchdog.test.js`'s):

```js
test("dispatch persists the class tag and surfaces it in the summary", () => {
  const mgr = makeManager({ spawnFn: () => fakeChild() });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), class: "implementer" });
  assert.equal(dispatched.class, "implementer");
  const status = mgr.status(dispatched.id);
  assert.equal(status.class, "implementer");
});

test("dispatch without a class tag omits it from the summary", () => {
  const mgr = makeManager({ spawnFn: () => fakeChild() });
  const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
  assert.equal("class" in dispatched, false);
});
```

- [ ] **Step 12: Run the full tasks.js unit suite**

Run: `node --test src/tasks.dispatch.test.js`
Expected: PASS.

- [ ] **Step 13: Forward `class` through the CLI layer in `src/commands.js`**

Add `"class"` to `DISPATCH_PASSTHROUGH_KEYS`:

```js
const DISPATCH_PASSTHROUGH_KEYS = ["model", "variant", "sessionId", "finalMarker", "noSandbox", "noOverlay", "allowedDirs", "executor", "class"];
```

In `runAdvisor`, add class forwarding to the `task.advisor` request body, right after the `executor` line:

```js
  return client.request("task.advisor", {
    env,
    prompt: assembledPrompt,
    directory,
    model: options.model,
    ...(isSet(options.variant) && { variant: options.variant }),
    ...(isSet(options.sessionId) && { sessionId: options.sessionId }),
    ...(isSet(options.timeoutMs) && { timeoutMs: options.timeoutMs }),
    ...(isSet(options.executor) && { executor: options.executor }),
    ...(isSet(options.class) && { class: options.class }),
  });
```

- [ ] **Step 14: Write the commands.js forwarding tests**

In `src/commands.test.js`, add next to the existing `noSandbox` forwarding tests:

```js
test("dispatch forwards class to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = { request: async (_method, params) => { capturedParams = params; return { id: "oc_1" }; } };
  await runCommand("dispatch", { prompt: "hi", directory: root, class: "implementer" }, { client, cwd: root, checkSkills: () => {} });
  assert.equal(capturedParams.class, "implementer");
});

test("dispatch omits class from the RPC payload when not set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let capturedParams;
  const client = { request: async (_method, params) => { capturedParams = params; return { id: "oc_1" }; } };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, checkSkills: () => {} });
  assert.equal("class" in capturedParams, false);
});

test("advisor forwards class to the RPC payload when set", async () => {
  const root = mkTmpRoot(TASKFERRY_TEST_TMP_PREFIX);
  let captured;
  const client = { request: async (method, params) => { captured = { method, params }; return { status: "done", message: "advice" }; } };
  await runCommand("advisor", { prompt: "hi", directory: root, model: "m", class: "advisor-design" }, { client, cwd: root, env: {} });
  assert.equal(captured.params.class, "advisor-design");
});
```

- [ ] **Step 15: Run the commands.js tests**

Run: `node --test src/commands.test.js`
Expected: PASS.

- [ ] **Step 16: Document `--class` in `src/command-specs.js`**

Add `"--class <name>"` to the dispatch entry's `options` object, right after `"--executor <opencode|pi>"`:

```js
"--class <name>": "optional task-class tag for telemetry: implementer, transcription, fixer, task-reviewer, final-reviewer, advisor-statistical, advisor-design, architecture, code-review-finder, code-review-verifier, researcher"
```

Add the same key/value to the advisor entry's `options` object, right after `"--executor <opencode|pi>"`.

Add one example to the dispatch entry's `examples` array:

```js
'taskferry dispatch --prompt "Fix the failing tests" --class implementer',
```

- [ ] **Step 17: Regenerate the distributed skill file**

Run: `npm run skill:generate`
Expected: exits 0 and rewrites the generated `SKILL.md` (check `git status` for which file changed — it is the canonical→generated split this repo already uses).

- [ ] **Step 18: Run the full test suite**

Run: `npm test`
Expected: all 889+ tests pass (the new ones from Steps 3, 7, 11, 14 included), 0 failures.

- [ ] **Step 19: Commit**

```bash
git add src/task-classes.js src/args.js src/args.test.js src/protocol.js src/protocol.test.js src/tasks.js src/tasks.dispatch.test.js src/commands.js src/commands.test.js src/command-specs.js SKILL.md
git commit -m "feat(dispatch): add --class task-classification tag

A validated --class option on dispatch and advisor, persisted per task
and surfaced in the summary, per Tranche 2 of the LiveBench-first
model-selection spec. TASK_CLASSES is a hand-maintained mirror of the
choosing-a-model skill's class-to-axis table -- no import path exists
between the two repos."
```

(Adjust the `git add` file list to whatever the generated skill file's actual path is, found in Step 17.)

---

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
