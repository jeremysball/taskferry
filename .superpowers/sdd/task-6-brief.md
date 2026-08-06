### Task 6: `dispatch()` resolves the requested executor; `summarizeTask()` stays opencode-only

**Files:**
- Modify: `src/tasks.js` (`dispatch()` at line 924, `summarizeTask()` at line 1241)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `resolveExecutor` (Task 1/2), `Task.executorId`/`DispatchLaunch.executor`/`SummaryLaunch.executor` (Task 5).
- Produces: `dispatch({..., executor})` accepting an optional `executor` param (a name string, `"opencode"|"pi"`, matching the CLI/RPC layer added in Task 8); `task.executorId` set on every dispatched task; `pendingLaunches` entries carrying the resolved `WorkerExecutor` object.

- [ ] **Step 1: Write a failing test for executor selection in `dispatch()`**

```js
test("dispatch() with executor: \"pi\" resolves piExecutor and stamps task.executorId", () => {
  const manager = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
  const dispatched = manager.dispatch({ prompt: "hi", directory: process.cwd(), executor: "pi" });
  const status = manager.status(dispatched.id);
  assert.equal(status.executorId, "pi");
});

test("dispatch() with no executor defaults to opencode", () => {
  const manager = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
  const dispatched = manager.dispatch({ prompt: "hi", directory: process.cwd() });
  const status = manager.status(dispatched.id);
  assert.equal(status.executorId, "opencode");
});

test("dispatch() with an unknown executor name throws", () => {
  const manager = makeManager({ spawnFn: () => { throw new Error("not reached in this test"); } });
  assert.throws(() => manager.dispatch({ prompt: "hi", directory: process.cwd(), executor: "bogus" }), /unknown executor: bogus/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `dispatch()` doesn't accept `executor` yet, `status.executorId` is `undefined`.

- [ ] **Step 3: Update `dispatch()`**

Change the function signature and body (line 924 onward):

```js
  /**
   * @param {object} params
   * @param {string} params.prompt
   * @param {string} params.directory
   * @param {string} [params.model]
   * @param {string} [params.variant]
   * @param {string|undefined} [params.sessionId]
   * @param {string|undefined} [params.originSessionId]
   * @param {string|null} [params.keySlot]
   * @param {boolean} [params.internal]
   * @param {string|null} [params.finalMarker]
   * @param {boolean} [params.noSandbox]
   * @param {string[]} [params.allowedDirs]
   * @param {string} [params.executor] - "opencode" | "pi", defaults to defaultExecutor
   * @returns {TaskSummary & {next: string}}
   */
  function dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal = false, finalMarker = null, originSessionId, noSandbox = false, allowedDirs: dispatchAllowedDirs, executor: executorName }) {
    ensureStateLoaded();
    const executor = executorName === undefined ? defaultExecutor : resolveExecutor(executorName);
    if (!prompt || typeof prompt !== "string") {
      throw new Error("error: prompt is required\nhelp: taskferry dispatch requires a non-empty prompt string");
    }
```

Resolve `executor` *before* the other validation so an unknown executor name fails fast, same posture as the existing directory/prompt checks.

Then, where the model default is picked (was `const resolvedModel = model || priorSessionTask?.model || "openai/gpt-5.6-luna";`):

```js
    const usingDefaultModel = !model;
    const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;
```

And in the `Task` object construction, add `executorId: executor.id,` (place it next to `model:` for readability):

```js
    const task = {
      id,
      status: "queued",
      directory: normalizedDirectory,
      model: resolvedModel,
      executorId: executor.id,
      variant: usingDefaultModel ? "high" : variant || null,
      // ...rest unchanged...
```

And where `pendingLaunches.set` is called, add `executor`:

```js
    pendingLaunches.set(id, { prompt, directory: normalizedDirectory, model: resolvedModel, variant: task.variant, sessionId, keyEnvValue: resolvedKeySlot.keyEnvValue, noSandbox: noSandbox === true, allowedDirs: dispatchAllowedDirs, executor });
```

- [ ] **Step 4: Update `summarizeTask()` to stamp `executorId: "opencode"` explicitly**

At the `Task` object construction inside `summarizeTask` (line ~1339), add `executorId: "opencode",`:

```js
    const task = {
      id,
      status: "queued",
      directory: fs.realpathSync(SUMMARY_DIR),
      model: activitySummaryModel,
      executorId: "opencode", // summaries stay opencode-only in this issue -- see plan Verified Findings #10
      variant: null,
      // ...rest unchanged...
```

And at `pendingLaunches.set` for the summary launch, add the resolved opencode executor:

```js
    pendingLaunches.set(id, {
      kind: "summary",
      model: activitySummaryModel,
      snapshotPath,
      env,
      executor: opencodeExecutor(),
      ...(resolvedSummarySessionId ? { summarySessionId: resolvedSummarySessionId } : {}),
    });
```

This requires importing `opencodeExecutor` alongside `resolveExecutor` at the top of `src/tasks.js`:

```js
import { resolveExecutor, opencodeExecutor } from "./executor.js";
```

- [ ] **Step 5: Update `advisor()` to forward an optional `executor`**

```js
  async function advisor({ prompt, directory, model, variant, sessionId, timeoutMs, executor } = {}) {
    ensureStateLoaded();
    if (!model || typeof model !== "string") {
      throw new Error("error: model is required\nhelp: taskferry advisor requires a provider/model string, e.g. \"openai/gpt-5.6-sol\"");
    }
    const resolved = resolveAdvisorSession(sessionId);
    let dispatched;
    try {
      dispatched = dispatch({ prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), model, variant, sessionId: resolved.sessionId, executor });
    } catch (err) {
      throw new Error(errMessage(err).replaceAll("taskferry dispatch", "taskferry advisor"), { cause: err });
    }
```

- [ ] **Step 6: Run tests**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): resolve requested executor in dispatch()/advisor(); keep summaries opencode-only"
```

---

