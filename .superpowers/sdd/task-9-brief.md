### Task 9: Test harness updates — `fakeChild().stdout`, `makeManager()`'s `defaultExecutor` passthrough

**Files:**
- Modify: `src/tasks.test.js`

**Interfaces:**
- Produces: `fakeChild()` returns an object with a `.stdout` `EventEmitter`; `makeManager({defaultExecutor})` forwards that option to `createTaskManager`.

**Note:** if you're implementing tasks in strict numeric order, Task 7's Step 1 test depends on both changes in this task — land this task's two small edits before Task 7's tests, or reorder Task 7 Step 1/Step 2 to come after this task. The dependency is one-directional (Task 9 doesn't need anything from Task 7), so doing Task 9 first is safe and arguably simpler.

- [ ] **Step 1: Add `stdout` to `fakeChild()`**

```js
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  return child;
}
```

- [ ] **Step 2: Add `defaultExecutor` passthrough to `makeManager()`**

```js
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, verifySummaryAgentFn, defaultExecutor, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs, maxConcurrentTasks, noOutputTimeoutMs, postOutputNoOutputTimeoutMs, watchdogPollMs, maxWaitMs, keySlotsSpec, providerKeyEnvName, summaryKeySlot, summaryProviderKeyEnvName, sandboxEnabled = false, checkBwrapAvailableFn, existsFn, runtimeDir, platform, onEvent, allowedDirs, resolveGitCommonDirFn } = {}) {
  // ...unchanged setup...
  return createTaskManager({
    stateDir,
    spawnFn: spawnFn ?? (() => { throw new Error("spawnFn was not injected for this test"); }),
    killFn: killFn ?? (() => { throw new Error("killFn was not injected for this test"); }),
    listModelsFn: listModelsFn ?? (() => "opencode/hy3-free\n"),
    verifySummaryAgentFn: verifySummaryAgentFn ?? (async () => {}),
    sandboxEnabled,
    ...(defaultExecutor != null ? { defaultExecutor } : {}),
    ...(checkBwrapAvailableFn != null ? { checkBwrapAvailableFn } : {}),
    // ...rest unchanged...
```

- [ ] **Step 3: Run the full suite**

Run: `node --test src/tasks.test.js`
Expected: PASS — this is a pure additive change to test infrastructure; every pre-existing test that constructs a `fakeChild()`/`makeManager()` without touching `stdout`/`defaultExecutor` is unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/tasks.test.js
git commit -m "test(tasks): add fakeChild().stdout and makeManager({defaultExecutor}) for executor testing"
```

---

