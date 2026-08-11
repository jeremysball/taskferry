## Task 6: Wire `resolveVariant()` and the variants cache into `dispatchTask`

**Files:**
- Modify: `src/tasks.js` (`resolveStringOptions` ~3715, `buildDispatchTask` line touched in Task 5, `dispatchTask` ~6224-6247, `bootstrapManagerContext` ~4516)
- Modify: `src/tasks.test-helpers.js` (`buildManagerOptions`, ~245)
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: `resolveVariant()` (Task 2), `readVariantsCache()` (Task 4).
- Produces: a fresh dispatch (or advisor call) with no explicit `--variant` now requests the resolved-highest level; the task record's `variant` field reflects what was actually requested (`"max"` for pi, a ranked opencode key, or `null`).

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.dispatch.test.js`:

```js
  test("omitted --variant on pi requests max (highest), by default", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "pi" });
    assert.ok(captured.includes("--thinking"));
    assert.equal(captured[captured.indexOf("--thinking") + 1], "max");
  });

  test("omitted --variant on opencode resolves the model's ranked-highest cached variant", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      opencodeVariantsTable: new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.deepEqual(captured.slice(captured.indexOf("-m")), ["-m", LUNA_MODEL, "--variant", "max", "--", "hi"]);
  });

  test("omitted --variant on opencode with no cache entry for the model sends no flag", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, opencodeVariantsTable: new Map() });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured.includes("--variant"), false);
  });

  test("explicit --variant is never reinterpreted, even against a cached table", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      opencodeVariantsTable: new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, variant: "low", executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "low");
  });

  test("a resumed session with no --variant inherits the resumed task's own variant, not a fresh highest", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); } });
    mgr.dispatch({ prompt: "first", directory: os.tmpdir(), model: MIMIMAX_MODEL, variant: "low", sessionId: "ses_v", executor: "opencode" });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_v", executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "low");
  });

  test("a configured defaultVariant of a concrete level is requested verbatim when --variant is omitted", () => {
    let captured = null;
    const mgr = makeManager({ spawnFn: (_cmd, args) => { captured = args; return fakeChild(); }, defaultVariant: "medium" });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "pi" });
    assert.equal(captured[captured.indexOf("--thinking") + 1], "medium");
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "highest|ranked-highest|reinterpreted|inherits the resumed"`
Expected: FAIL — `opencodeVariantsTable`/`defaultVariant` are not recognized test options yet, and `buildDispatchTask` still sets `variant: null` unconditionally (from Task 5's placeholder).

- [ ] **Step 3: Add `defaultVariant` to `resolveStringOptions`**

In `src/tasks.js`, extend `resolveStringOptions` (~line 3715):

```js
function resolveStringOptions(rawOptions) {
  const config = rawOptions.config || {};
  return {
    activitySummaryModel: rawOptions.activitySummaryModel ?? process.env.TASKFERRY_SUMMARY_MODEL ?? config.summaryModel ?? DEFAULT_SUMMARY_MODEL,
    defaultVariant: rawOptions.defaultVariant ?? process.env.TASKFERRY_DEFAULT_VARIANT ?? config.defaultVariant ?? "highest",
  };
}
```

- [ ] **Step 4: Add a test-only `opencodeVariantsTable` seam and thread `defaultVariant` through `buildManagerOptions`**

In `src/tasks.test-helpers.js`, add two lines inside `buildManagerOptions()` (near the `defaultExecutor` passthrough at line 245):

```js
    ...passthroughIfSet({ defaultVariant: options.defaultVariant }, "defaultVariant", "defaultVariant"),
    ...passthroughIfSet({ opencodeVariantsTable: options.opencodeVariantsTable }, "opencodeVariantsTable", "opencodeVariantsTable"),
```

`opencodeVariantsTable` is a test-only injection seam (a real daemon reads this from `readVariantsCache()` instead — see Step 6): when set, `createTaskManager()` treats it as the resolved table directly, bypassing the file entirely. Wire this into `resolveCoreOptions()` in `src/tasks.js` (same function that already resolves `defaultExecutor`, `listModelsFn`, etc.):

```js
function resolveCoreOptions(rawOptions) {
  const config = rawOptions.config || {};
  return {
    spawnFn: rawOptions.spawnFn ?? spawn,
    killFn: rawOptions.killFn ?? /** @type {(pid: number, signal: NodeJS.Signals) => void} */ ((pid, signal) => process.kill(pid, signal)),
    stateDir: rawOptions.stateDir ?? DEFAULT_STATE_DIR,
    defaultExecutor: rawOptions.defaultExecutor ?? resolveExecutor(process.env.TASKFERRY_DEFAULT_EXECUTOR || config.defaultExecutor),
    listModelsFn: rawOptions.listModelsFn ?? opencodeExecutor().listModelsFn,
    // Test-only direct injection of the resolved opencode variants table,
    // bypassing readVariantsCache()/the cache file entirely. A real
    // manager passes undefined here and resolves the table per-dispatch
    // from disk instead (see dispatchTask's ctx.readOpencodeVariants).
    opencodeVariantsTable: rawOptions.opencodeVariantsTable,
    platform: rawOptions.platform ?? process.platform,
    onEvent: rawOptions.onEvent,
    config,
  };
}
```

- [ ] **Step 5: Replace the `variant: null` placeholder in `buildDispatchTask` with the real resolution**

Add a new parameter to `buildDispatchTask`'s destructured params: `resolveOpencodeVariants` (a function `(model: string) => string[]`, always present — see Step 6 for what the real one does), then replace this task's earlier `variant: null` placeholder:

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass, parentTaskId = null, defaultVariant, resolveOpencodeVariants }) {
  if (!model && !priorSessionTask && sessionId) {
    throw new Error(`error: no task found for session id "${sessionId}" to inherit a model from\nhelp: pass --model explicitly, or check the session id with taskferry list`);
  }
  if (!model && !priorSessionTask) {
    throw new Error(`error: --model is required\nhelp: name the model, e.g. --model provider/model (opencode models or pi --list-models lists what's available); to resume an existing session and inherit its model, pass --session-id instead`);
  }
  const resolvedModel = model || priorSessionTask.model;
  // Precedence: explicit --variant > resumed session's own variant > the
  // configured defaultVariant sentinel/level. Only the third case ever
  // needs resolveVariant() -- an explicit or inherited value is already
  // concrete and passes straight through resolveVariant() as a no-op.
  const requestedVariant = variant || priorSessionTask?.variant || defaultVariant;
  const resolvedVariant = resolveVariant({
    executorId: executor.id,
    requested: requestedVariant,
    opencodeVariants: executor.id === "opencode" ? resolveOpencodeVariants(resolvedModel) : undefined,
  });
  return {
    id,
    directory,
    logPath,
    role,
    status: "queued",
    model: resolvedModel,
    executorId: executor.id,
    variant: resolvedVariant,
    sessionId: sessionId || null,
```

Add `import { resolveVariant } from "./variants.js";` to `src/tasks.js`'s import block.

- [ ] **Step 6: Thread `defaultVariant` and a variants-table reader through `dispatchTask`/`ctx`**

In `src/tasks.js`, update `dispatchTask`'s `ctx` typedef and body (~line 6224-6247) to accept and pass through `defaultVariant` and `resolveOpencodeVariants`:

```js
 * @param {{ensureStateLoaded: () => void, tasks: Map<string, Task>, defaultExecutor: import("./executor.js").WorkerExecutor, LOG_DIR: string, persistTask: (taskId: string) => void, pendingLaunches: Map<string, LaunchSpec>, providerQueues: Map<string, ProviderQueue>, launchQueuedTasks: () => void, defaultVariant: string, resolveOpencodeVariants: (model: string) => string[]}} ctx
 */
function dispatchTask(params, ctx) {
  const { prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, rwBind: dispatchRwBind, roBind: dispatchRoBind, executor: executorName, env, role = "dispatch", class: taskClass = null, parentTaskId = null } = params;
  const effectiveRwBind = [...new Set([...(dispatchRwBind ?? []), ...(dispatchAllowedDirs ?? [])])];
  ctx.ensureStateLoaded();
  const priorSessionTask = resolvePriorSessionTask(ctx.tasks, sessionId, executorName);
  const executor = resolveDispatchExecutor(priorSessionTask, executorName, ctx.defaultExecutor);
  validateDispatchParameters({ prompt, directory });
  validateDispatchFinalMarker(finalMarker);
  const normalizedDirectory = resolveDispatchDirectory(directory);
  const projectConfig = loadProjectConfig(normalizedDirectory);
  const dispatchPrompt = role === "dispatch" && !noOverlay && projectConfig.check
    ? `${prompt}${verificationPromptBlock(projectConfig.check)}`
    : prompt;
  const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const logPath = path.join(ctx.LOG_DIR, `${id}.ndjson`);
  const task = buildDispatchTask({ id, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, parentTaskId, class: taskClass, prompt: dispatchPrompt, directory: normalizedDirectory, defaultVariant: ctx.defaultVariant, resolveOpencodeVariants: ctx.resolveOpencodeVariants });
```

Then update the `ctx.dispatch` wiring where `dispatchTask` is invoked (search for the line building this ctx object — the one shown earlier at `ctx.dispatch: (params) => dispatchTask(params, { ... })`), adding two fields:

```js
    dispatch: (params) => dispatchTask(params, { ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(), tasks: ctx.maps.tasks, defaultExecutor: ctx.opts.defaultExecutor, LOG_DIR: ctx.paths.LOG_DIR, persistTask: (taskId) => ctx.helpers.persistTask(taskId), pendingLaunches: ctx.maps.pendingLaunches, providerQueues: ctx.maps.providerQueues, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(), defaultVariant: ctx.opts.defaultVariant, resolveOpencodeVariants: ctx.helpers.resolveOpencodeVariants }),
```

Find the same call site used by `dispatchAdvisorTask` (advisor funnels through `dispatch()`, per the spec — confirm this is the same `ctx.dispatch` reference, not a separate one, by checking `dispatchAdvisorTask`'s body around `src/tasks.js:2583`) and apply the identical two-field addition if it builds its own separate ctx object rather than reusing `ctx.dispatch`.

- [ ] **Step 7: Add `ctx.helpers.resolveOpencodeVariants`, backed by `opencodeVariantsTable` (tests) or `readVariantsCache()` (real)**

In `src/tasks.js`, in the function that builds `ctx.helpers` (search for where other `ctx.helpers.X` closures like `sweepOrphanedPromptFiles` are defined), add:

```js
  resolveOpencodeVariants: (model) => {
    if (opts.opencodeVariantsTable) return opts.opencodeVariantsTable.get(model) ?? [];
    const table = readVariantsCache({ cacheDir: opts.cacheDir, env: process.env });
    return table?.get(model) ?? [];
  },
```

Add `import { readVariantsCache } from "./variants-cache.js";` to `src/tasks.js`'s import block. This closure is what Task 3's real daemon path calls; Task 6's tests use the `opencodeVariantsTable` short-circuit exclusively, so no test in this task touches `readVariantsCache()` or the filesystem.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test src/tasks.dispatch.test.js`
Expected: PASS, all tests (existing + the 6 new ones from Step 1).

- [ ] **Step 9: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS. Pay particular attention to any test in `tasks.executor.test.js`/`tasks.advisor.test.js` asserting a specific `--thinking`/`--variant` argv shape with no explicit `variant` passed to `dispatch()` — those now resolve through `defaultVariant: "highest"` and will need an explicit `variant:` in the test's `dispatch()` call (pi tests) or an `opencodeVariantsTable` fixture (opencode tests) if they don't already pass one.

- [ ] **Step 10: Commit**

```bash
git add src/tasks.js src/tasks.test-helpers.js src/tasks.dispatch.test.js
git commit -m "feat(cli): default an omitted --variant to the model's highest supported level"
```

---

