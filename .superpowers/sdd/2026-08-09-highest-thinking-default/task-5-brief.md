## Task 5: `--model` required on a fresh dispatch; delete `executor.defaultModel`

**Files:**
- Modify: `src/executor.js:80` (typedef), `:214` (pi), `:320` (opencode)
- Modify: `src/tasks.js:2108-2119` (`buildDispatchTask`)
- Modify: `src/executor.test.js:31` (delete the assertion)
- Modify test fixtures: `src/tasks.executor.test.js` (11 occurrences), `src/tasks.failure.test.js` (3), `src/tasks.summarize.test.js` (2), `src/tasks.dispatch.test.js` (1, plus the tests below)
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildDispatchTask()` throws `error: --model is required` / `error: no task found for session id "..." to inherit a model from` instead of silently falling back. `WorkerExecutor` no longer has a `defaultModel` field.

- [ ] **Step 1: Write the failing tests**

Replace the two tests in `src/tasks.dispatch.test.js` that assert the old fallback behavior:

```js
  test("dispatch without --model and without a resolvable --session-id throws", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(
      () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" }),
      /error: --model is required\nhelp: name the model/
    );
  });

  test("an unrecognized --session-id with no --model throws, naming the session id", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(
      () => mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_never_seen", executor: "opencode" }),
      /error: no task found for session id "ses_never_seen" to inherit a model from\nhelp:/
    );
  });
```

Delete the test named `"defaults to openai/gpt-5.6-luna --variant high when no model is given"` and the test named `"an unrecognized --session-id with no --model still falls back to the hardcoded default"` (superseded by the two above).

Update the `fakePi` fixture object at `src/tasks.dispatch.test.js:89` (the "reuses that exact instance" test) to delete its `defaultModel: "fake-pi/marker-model",` line — that test's assertions never depend on `defaultModel`, only on `buildSpawnArgs`'s `--fake-pi-marker` sentinel, so this is a pure fixture trim, not a behavior change.

- [ ] **Step 2: Run the new/changed tests to verify they fail**

Run: `npm test -- --test-name-pattern "model is required|no task found for session id"`
Expected: FAIL — `buildDispatchTask` still silently falls back.

- [ ] **Step 3: Delete `defaultModel` from the executor typedef and both implementations**

In `src/executor.js`, remove `@property {string} defaultModel` from the `WorkerExecutor` typedef (line 80), and remove the `defaultModel: "minimax/MiniMax-M2.7",` line (pi, ~214) and `defaultModel: "openai/gpt-5.6-luna",` line (opencode, ~320).

In `src/executor.test.js`, delete the line `assert.equal(ex.defaultModel, PI_MODEL);` from the `"exposes pi identity and defaults"` test — leave the other three assertions in that test (`id`, `taskIdPrefix`, `errorBucketPrefix`) as-is.

- [ ] **Step 4: Make `buildDispatchTask` throw instead of falling back**

In `src/tasks.js`, replace the body of `buildDispatchTask` (lines 2108-2119):

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass, parentTaskId = null }) {
  if (!model && !priorSessionTask && sessionId) {
    throw new Error(`error: no task found for session id "${sessionId}" to inherit a model from\nhelp: pass --model explicitly, or check the session id with taskferry list`);
  }
  if (!model && !priorSessionTask) {
    throw new Error(`error: --model is required\nhelp: name the model, e.g. --model provider/model (opencode models or pi --list-models lists what's available); to resume an existing session and inherit its model, pass --session-id instead`);
  }
  const resolvedModel = model || priorSessionTask.model;
  return {
    id,
    directory,
    logPath,
    role,
    status: "queued",
    model: resolvedModel,
    executorId: executor.id,
    variant: null, // set by Task 6 (resolveVariant wiring); this task only removes the model fallback
    sessionId: sessionId || null,
    originSessionId: originSessionId || null,
    pid: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    promptPreview: prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt,
    promptTotalChars: prompt.length > 200 ? prompt.length : null,
    spawnError: null,
    cancelRequested: false,
    internal: internal === true,
    failureReason: null,
    failureDetail: null,
    incomplete: false,
    finalMarker: finalMarker == null ? null : finalMarker,
```

(Leave every field after `finalMarker` untouched — only the model-resolution preamble and the `variant` line change in this step. Task 6 replaces the `variant: null` placeholder with the real `resolveVariant()` call once the cache-reading `ctx` is threaded in.)

Note the `!model && !priorSessionTask && sessionId` check must come first: a `--session-id` that matches nothing is a more specific, more useful error than the generic "--model is required," and both share the "neither model nor priorSessionTask" precondition.

- [ ] **Step 5: Trim `defaultModel` out of every test fixture**

Run `rg -n "defaultModel" src/*.test.js` and delete every remaining `defaultModel: ...,` line it reports (`tasks.executor.test.js`, `tasks.failure.test.js`, `tasks.summarize.test.js`). These are fake-executor object literals passed as `defaultExecutor` to `makeManager()`; none of the assertions in those files reference `.defaultModel`, so removing the field is a pure trim — confirm with `rg -n "\.defaultModel" src/*.test.js` returning no hits afterward.

- [ ] **Step 6: Run the full dispatch, executor, and failure test files**

Run: `npm test src/tasks.dispatch.test.js src/executor.test.js src/tasks.executor.test.js src/tasks.failure.test.js src/tasks.summarize.test.js`
Expected: PASS, all tests. If any test besides the ones already updated in Step 1 still asserts a fallback model or the hardcoded `"high"` variant, fix that test now rather than leaving it red for Task 6 — the `variant: null` placeholder from Step 4 means any such test currently expects a non-null variant will fail here, which is expected and resolved in Task 6.

- [ ] **Step 7: Commit**

```bash
git add src/executor.js src/executor.test.js src/tasks.js src/tasks.dispatch.test.js src/tasks.executor.test.js src/tasks.failure.test.js src/tasks.summarize.test.js
git commit -m "feat(cli)!: require --model on a fresh dispatch, drop executor.defaultModel

BREAKING CHANGE: dispatching without --model and without a --session-id
that resolves to a prior task now errors with '--model is required'
instead of silently falling back to a hardcoded per-executor default
model. Pass --model explicitly, or resume via --session-id to inherit
a prior task's model."
```

---

