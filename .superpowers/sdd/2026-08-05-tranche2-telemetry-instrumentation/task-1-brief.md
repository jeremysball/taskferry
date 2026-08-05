### Task 1: `--class` task-classification tag

**Files:**
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
- Consumes: nothing from other tasks.
- Produces: a `task.class` field (`string|null`) on every dispatched `Task`, set verbatim from `params.class` at dispatch time (any non-empty string, no allow-list), surfaced in `summarize()` output when non-null. Task 2 does not depend on this — it can be implemented independently.

**Design note:** `--class` is deliberately unvalidated against any fixed list. taskferry is a general-purpose dispatch tool; the specific 11-class taxonomy that motivates this field lives in the choosing-a-model skill, outside this repo, and must not be hardcoded here. Treat `--class` exactly like `--variant`/`--session-id`: a plain string flag, non-empty-string-checked at the protocol boundary, nothing more.

- [ ] **Step 1: Add `--class` to `src/args.js`**

No new coercer function is needed — mirror the existing `"--variant"`/`"--session-id"` entries, which pass the raw string through untouched. Add the flag to the `FLAGS` table, directly after the `"--executor"` line:

```js
  "--class": { allow: ["dispatch", "advisor"], key: "class" },
```

- [ ] **Step 2: Write the args.js tests**

In `src/args.test.js`, add near the existing `--variant`/`--session-id` tests:

```js
test("dispatch accepts an arbitrary --class value", () => {
  const { options } = parseArgs(["dispatch", "--prompt", "x", "--class", "implementer"], { cwd: CWD });
  assert.equal(options.class, "implementer");
});

test("advisor accepts an arbitrary --class value", () => {
  const { options } = parseArgs(["advisor", "--model", "m", "--class", "advisor-design"]);
  assert.equal(options.class, "advisor-design");
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

- [ ] **Step 3: Run the args tests to see the new ones fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `--class` is not yet a recognized flag (`unknown flag --class`), and the defaults deepEqual fails on the missing `class` key.

- [ ] **Step 4: Run the args tests to see them pass**

Run: `node --test src/args.test.js`
Expected: PASS, all tests green (Step 1's edit already lands the fix — this step is the verification checkpoint, not a further code change).

- [ ] **Step 5: Add `class` to the `task.dispatch`/`task.advisor` protocol schema**

In `src/protocol.js`, no new validator function or import is needed — reuse the existing `isNonEmptyString` predicate, the same one already used for `["variant", isNonEmptyString]` and `["sessionId", isNonEmptyString]`.

In `METHOD_PARAMS["task.dispatch"].optional`, add `["class", isNonEmptyString],` (anywhere in that array, e.g. right after `["executor", isKnownExecutor],`).

In `METHOD_PARAMS["task.advisor"].optional`, add the same `["class", isNonEmptyString],` entry.

Add `"class"` to the `RESULT_FIELDS` set (so `taskferry result --fields class` is selectable), right after `"finalMarker"`.

- [ ] **Step 6: Write the protocol.js tests**

In `src/protocol.test.js`, find the existing `task.dispatch`/`task.advisor` param-validation `describe` blocks and add:

```js
test("task.dispatch accepts an arbitrary class value", () => {
  const error = parseRequestLine(request(METHOD.dispatch, { prompt: "p", directory: TEST_DIR, class: "implementer" }));
  assert.equal(error, null);
});

test("task.dispatch rejects an empty class value", () => {
  const error = parseRequestLine(request(METHOD.dispatch, { prompt: "p", directory: TEST_DIR, class: "" }));
  assert.ok(error instanceof ProtocolError);
});

test("task.advisor accepts an arbitrary class value", () => {
  const error = parseRequestLine(request(METHOD.advisor, { prompt: "p", directory: TEST_DIR, model: "m", class: "advisor-design" }));
  assert.equal(error, null);
});
```

Check `parseRequestLine`'s actual return shape first (some existing test in the same file already asserts success/failure on `task.dispatch` — match that exact pattern instead of guessing; the snippet above is illustrative of intent, not a literal copy-paste if the real helper returns something other than `null` on success).

- [ ] **Step 7: Run the protocol tests to see the new ones fail, then pass**

Run: `node --test src/protocol.test.js`
Expected: FAIL first (unrecognized `class` param, since it isn't in the schema yet — but Step 5 already landed the schema change, so run this after Step 5 and expect PASS directly; if it fails, Step 5's edit is incomplete).

- [ ] **Step 8: Persist `class` on the task record in `src/tasks.js`**

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

- [ ] **Step 9: Surface `class` in the task summary**

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

- [ ] **Step 10: Write the tasks.js persistence/summary tests**

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

- [ ] **Step 11: Run the full tasks.js unit suite**

Run: `node --test src/tasks.dispatch.test.js`
Expected: PASS.

- [ ] **Step 12: Forward `class` through the CLI layer in `src/commands.js`**

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

- [ ] **Step 13: Write the commands.js forwarding tests**

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

- [ ] **Step 14: Run the commands.js tests**

Run: `node --test src/commands.test.js`
Expected: PASS.

- [ ] **Step 15: Document `--class` in `src/command-specs.js`**

Add `"--class <name>"` to the dispatch entry's `options` object, right after `"--executor <opencode|pi>"`. Describe it as a free-text tag, not an enumerated list — taskferry does not enforce which values are valid:

```js
"--class <name>": "optional free-text task-class tag for external telemetry consumers; taskferry does not validate against a fixed list"
```

Add the same key/value to the advisor entry's `options` object, right after `"--executor <opencode|pi>"`.

Add one example to the dispatch entry's `examples` array:

```js
'taskferry dispatch --prompt "Fix the failing tests" --class implementer',
```

- [ ] **Step 16: Regenerate the distributed skill file**

Run: `npm run skill:generate`
Expected: exits 0 and rewrites the generated `SKILL.md` (check `git status` for which file changed — it is the canonical→generated split this repo already uses).

- [ ] **Step 17: Run the full test suite**

Run: `npm test`
Expected: all 889+ tests pass (the new ones from Steps 2, 6, 10, 13 included), 0 failures.

- [ ] **Step 18: Commit**

```bash
git add src/args.js src/args.test.js src/protocol.js src/protocol.test.js src/tasks.js src/tasks.dispatch.test.js src/commands.js src/commands.test.js src/command-specs.js SKILL.md
git commit -m "feat(dispatch): add --class task-classification tag

A freeform, unvalidated --class option on dispatch and advisor,
persisted per task and surfaced in the summary, per Tranche 2 of the
LiveBench-first model-selection spec. Deliberately not validated
against a fixed list -- the specific taxonomy that motivates this
field belongs to the choosing-a-model skill outside this repo, not to
taskferry itself."
```

(Adjust the `git add` file list to whatever the generated skill file's actual path is, found in Step 16.)

---

