## Task 3: Provider-scoped queue data model and option-resolution wiring

**Files:**
- Modify: `src/tasks.js` — `initManagerMaps()` (~line 3587), `initManagerSchedulers()` (~line 3610), `initManagerLimits()` (~line 3483), `resolveTaskManagerOptions()` (~line 3411) and its helpers, `queueDispatchLaunch()` (~line 1879), `cancelTask()` (~line 5812), the `incRunning`/`decRunning` call sites (~lines 1134, 1341) and their wiring definition (~line 3808), and the JSDoc typedefs at ~lines 623-624, 1700-1706, 1909-1925.
- Modify: `src/tasks.test-helpers.js:229-273` (`buildManagerOptions`)

**Interfaces:**
- Produces: `providerOf(model: string): string`; `ProviderQueue` typedef `{launchQueue: string[], launchTimes: number[], runningCount: number}`; `ctx.maps.providerQueues: Map<string, ProviderQueue>` (replaces `ctx.maps.launchQueue`); `ctx.limits.providerLimits: Map<string, {concurrencyLimit: number, dispatchLimit: number}>`.
- Consumes: `parseProviderLimitsEnv` (Task 2), `validateProviderLimits`-validated `config.providerLimits` (Task 1).

This task is a structural rename/refactor across many call sites — nothing new is independently testable mid-way, so its test cycle is "the full existing suite stays green" rather than a single new unit test. Task 4 adds the new behavioral tests once the drain algorithm itself is rewritten.

- [ ] **Step 1: Confirm the baseline is green**

Run: `npm test src/tasks.dispatch.test.js src/tasks.checkgate.test.js src/tasks.js`
Expected: PASS (establishes the "before" state so a later regression is attributable to this task, not pre-existing).

- [ ] **Step 2: Add `providerOf()` and the `ProviderQueue` typedef**

In `src/tasks.js`, near `parseProviderLimitsEnv` (added in Task 2), add:

```js
/**
 * @typedef {{launchQueue: string[], launchTimes: number[], runningCount: number}} ProviderQueue
 */

/**
 * Derives a task's provider key from its `model` string
 * ("provider/model"), used to route scheduler state per-provider (design
 * spec §1). Falls back to the whole string when there's no "/" -- every
 * real dispatch always sets a "provider/model"-shaped model, so this is
 * defensive only.
 * @param {string} model
 * @returns {string}
 */
function providerOf(model) {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}

/**
 * The zero-limit sentinel used when a provider has no `providerLimits`
 * entry: both axes unbounded, so only the global ceiling applies to it.
 * @type {{concurrencyLimit: number, dispatchLimit: number}}
 */
const UNLIMITED_PROVIDER = { concurrencyLimit: Infinity, dispatchLimit: Infinity };
```

- [ ] **Step 3: Add config→Map normalization and the option-resolution helper**

Add, right after `providerOf`/`UNLIMITED_PROVIDER`:

```js
/**
 * Converts `config.json`'s validated `providerLimits` object (per Task 1's
 * `validateProviderLimits`) into the `Map<string, {concurrencyLimit,
 * dispatchLimit}>` shape the scheduler reads. An omitted per-provider key
 * means unlimited for that axis (`Infinity`), not zero.
 * @param {Record<string, {maxConcurrentTasks?: number, maxDispatchesPerWindow?: number}>|undefined} configValue
 * @returns {Map<string, {concurrencyLimit: number, dispatchLimit: number}>}
 */
function providerLimitsFromConfig(configValue) {
  const map = new Map();
  if (!configValue) return map;
  for (const [provider, limits] of Object.entries(configValue)) {
    map.set(provider, {
      concurrencyLimit: limits.maxConcurrentTasks ?? Infinity,
      dispatchLimit: limits.maxDispatchesPerWindow ?? Infinity,
    });
  }
  return map;
}

/**
 * Resolves `providerLimits` via the same caller -> env -> config -> default
 * chain every other option uses, with one difference: setting the env var
 * replaces the config file's entire map wholesale (same semantics
 * `TASKFERRY_ENV_FILE=""` already uses for `envFile` -- "explicit empty
 * overrides, doesn't fall through"), never merged key-by-key.
 * @param {Record<string, any>} rawOptions
 */
function resolveProviderLimitsOption(rawOptions) {
  if (rawOptions.providerLimits !== undefined) return { providerLimits: rawOptions.providerLimits };
  if (process.env.TASKFERRY_PROVIDER_LIMITS !== undefined) {
    return { providerLimits: parseProviderLimitsEnv(process.env.TASKFERRY_PROVIDER_LIMITS) };
  }
  const config = rawOptions.config || {};
  return { providerLimits: providerLimitsFromConfig(/** @type {any} */ (config.providerLimits)) };
}
```

- [ ] **Step 4: Wire `resolveProviderLimitsOption` into `resolveTaskManagerOptions`**

Modify `resolveTaskManagerOptions` (~line 3411-3420):

```js
function resolveTaskManagerOptions(rawOptions = {}) {
  return {
    ...resolveCoreOptions(rawOptions),
    ...resolveTimeoutOptions(rawOptions),
    ...resolveToggleOptions(rawOptions),
    ...resolveStringOptions(rawOptions),
    ...resolveEnvFileOptions(rawOptions),
    ...resolveFilesystemOptions(rawOptions),
    ...resolveProviderLimitsOption(rawOptions),
  };
}
```

- [ ] **Step 5: Expose `providerLimits` on `ctx.limits`**

Modify `initManagerLimits` (~line 3483-3505) — add one line to the returned object, right after `concurrencyLimit`:

```js
    concurrencyLimit: positiveInteger(opts.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS),
    providerLimits: opts.providerLimits,
```

- [ ] **Step 6: Replace `launchQueue`/`launchTimes` with `providerQueues` in `initManagerMaps`**

Modify `initManagerMaps` (~line 3587-3604):

```js
function initManagerMaps() {
  return {
    tasks: new Map(),
    escalationTimers: new Map(),
    runningWatchers: new Map(),
    runningWatcherState: new Map(),
    waiters: new Map(),
    advisorSessions: new Map(),
    pendingLaunches: new Map(),
    providerQueues: new Map(),
    launchTimes: [],
    modelsCache: new Map(),
    modelsCacheInFlight: new Map(),
    activitySubscriptions: new Map(),
    logHasEventCache: new Set(),
    gateChildren: new Map(),
  };
}
```

(`launchQueue: []` is removed; `launchTimes: []` is retained as the *global* ledger; `providerQueues: new Map()` is new.)

- [ ] **Step 7: Update `initManagerSchedulers`**

Modify (~line 3607-3624; the JSDoc `@param` types change too):

```js
/**
 * @param {{launchTimer: NodeJS.Timeout|null, runningCount: number, eventSequence: number, activitySummarySubscriptions: number, lastLaunchAt: number}} state
 * @param {{launchTimes: number[], providerQueues: Map<string, ProviderQueue>}} maps
 */
function initManagerSchedulers(state, maps) {
  return {
    // Getter/setter pair lets the module-level launch helpers
    // read/write `launchTimer` and `runningCount` (the factory's own
    // `let` bindings) without closing over the factory, while
    // `launchTimes`/`providerQueues` are shared by reference.
    launchScheduler: {
      launchTimes: maps.launchTimes,
      providerQueues: maps.providerQueues,
      get runningCount() { return state.runningCount; },
      get launchTimer() { return state.launchTimer; },
      set launchTimer(v) { state.launchTimer = v; },
      get lastLaunchAt() { return state.lastLaunchAt; },
      set lastLaunchAt(v) { state.lastLaunchAt = v; },
      // Round-robin cursor into providerQueues' iteration order, advanced
      // by the drain algorithm so a heavy provider's backlog doesn't
      // starve a lighter one's when the global ceiling binds (design
      // spec §3). Plain mutable property: this object is created once
      // per manager and lives for the daemon's lifetime, so it needs no
      // getter/setter indirection the way `state`'s `let` bindings do.
      cursor: 0,
    },
```

Leave the rest of the function (the `activityScheduleState` block that follows) untouched.

- [ ] **Step 8: Route `queueDispatchLaunch` through provider buckets**

Modify `queueDispatchLaunch` (~line 1879-1898):

```js
/**
 * @param {{tasks: Map<string, Task>, persistTask: (taskId: string) => void, pendingLaunches: Map<string, LaunchSpec>, providerQueues: Map<string, ProviderQueue>, launchQueuedTasks: () => void}} ctx
 * @param {{id: string, task: Task, prompt: string, sessionId: string|undefined, env: NodeJS.ProcessEnv|undefined, noSandbox: boolean, noOverlay: boolean, allowedDirs: string[]|undefined, executor: import("./executor.js").WorkerExecutor, role: "dispatch"|"advisor"}} params
 */
function queueDispatchLaunch(ctx, { id, task, prompt, sessionId, env, noSandbox, noOverlay, allowedDirs, executor, role }) {
  ctx.tasks.set(id, task);
  ctx.persistTask(task.id);
  const capturedEnv = env === undefined ? undefined : { ...env };
  ctx.pendingLaunches.set(id, {
    prompt,
    sessionId,
    allowedDirs,
    executor,
    role,
    directory: task.directory,
    model: task.model,
    variant: task.variant,
    env: capturedEnv,
    noSandbox: noSandbox === true,
    noOverlay: noOverlay === true,
  });
  const provider = providerOf(task.model);
  let providerQueue = ctx.providerQueues.get(provider);
  if (!providerQueue) {
    providerQueue = { launchQueue: [], launchTimes: [], runningCount: 0 };
    ctx.providerQueues.set(provider, providerQueue);
  }
  providerQueue.launchQueue.push(id);
  ctx.launchQueuedTasks();
}
```

Update the `DispatchContext` typedef (~line 1700-1706), changing `@property {string[]} launchQueue` to `@property {Map<string, ProviderQueue>} providerQueues`. Do the same for the `SummarizeTaskContext`-shaped typedef at ~line 1909-1925 (its `@property {string[]} launchQueue` line, ~1923).

- [ ] **Step 9: Update the two wiring call sites that build `queueDispatchLaunch`'s ctx**

Both are single-line object literals inside `createTaskManager`'s returned API. Find and update each (`rg -n "launchQueue: ctx.maps.launchQueue" src/tasks.js` to confirm exactly two hits before and zero after):

At ~line 3799 (`summarizeTask:` wiring), change the substring:
```
pendingLaunches: ctx.maps.pendingLaunches, launchQueue: ctx.maps.launchQueue, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(),
```
to:
```
pendingLaunches: ctx.maps.pendingLaunches, providerQueues: ctx.maps.providerQueues, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(),
```

At ~line 3895 (`dispatch:` wiring), change the same substring the same way:
```
pendingLaunches: ctx.maps.pendingLaunches, launchQueue: ctx.maps.launchQueue, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks() }),
```
to:
```
pendingLaunches: ctx.maps.pendingLaunches, providerQueues: ctx.maps.providerQueues, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks() }),
```

- [ ] **Step 10: Route `cancelTask` through the task's own provider bucket**

Update the `cancelTask` JSDoc `ctx` type (~line 5809), changing `launchScheduler: {launchQueue: string[], launchTimer: NodeJS.Timeout|null}` to `launchScheduler: {providerQueues: Map<string, ProviderQueue>, launchTimer: NodeJS.Timeout|null}`.

Modify the queued-cancel branch (~line 5816-5832):

```js
  if (task.status === "queued") {
    const providerQueue = ctx.launchScheduler.providerQueues.get(providerOf(task.model));
    if (providerQueue) {
      const index = providerQueue.launchQueue.indexOf(taskId);
      if (index !== -1) providerQueue.launchQueue.splice(index, 1);
    }
    const launch = ctx.pendingLaunches.get(taskId);
    ctx.pendingLaunches.delete(taskId);
    if (launch?.snapshotPath) removeFileIfPresent(launch.snapshotPath);
    task.status = "cancelled";
    task.endedAt = new Date().toISOString();
    ctx.persistTask(task.id);
    void ctx.scheduleActivity(task, { force: true }).then(() => ctx.activityCache.evictTask(task.id));
    ctx.logHasEventCache.delete(task.logPath);
    ctx.settleWaiters(taskId);
    const anyQueued = [...ctx.launchScheduler.providerQueues.values()].some((q) => q.launchQueue.length);
    if (!anyQueued && ctx.launchScheduler.launchTimer) {
      clearTimeout(ctx.launchScheduler.launchTimer);
      ctx.launchScheduler.launchTimer = null;
    }
    return { ...summarize(task), note: "queued task cancelled before launch" };
  }
```

- [ ] **Step 11: Update the `cancel:` wiring's `launchScheduler` getter**

At ~line 3856, change the substring:
```
launchScheduler: { get launchQueue() { return ctx.maps.launchQueue; }, get launchTimer() { return ctx.state.launchTimer; }, set launchTimer(value) { ctx.state.launchTimer = value; } },
```
to:
```
launchScheduler: { get providerQueues() { return ctx.maps.providerQueues; }, get launchTimer() { return ctx.state.launchTimer; }, set launchTimer(value) { ctx.state.launchTimer = value; } },
```

- [ ] **Step 12: Make `incRunning`/`decRunning` provider-aware**

Update the JSDoc typedef at ~line 623-624:
```js
 * @property {(task: Task) => void} decRunning
 * @property {(task: Task) => void} incRunning
```

Update the two call sites. At ~line 1134 (inside the child-settle finally-block):
```js
    ctx.decRunning(task);
```
At ~line 1341 (inside `startTaskFor`, right after `task.pid = child.pid ?? null;`):
```js
    ctx.incRunning(task);
```

Update the wiring definition at ~line 3808 (the `startTask:` object literal). Change this substring:
```
decRunning: () => { ctx.state.runningCount--; }, incRunning: () => { ctx.state.runningCount++; },
```
to:
```
decRunning: (task) => { ctx.state.runningCount--; const q = ctx.maps.providerQueues.get(providerOf(task.model)); if (q) q.runningCount--; }, incRunning: (task) => { ctx.state.runningCount++; const q = ctx.maps.providerQueues.get(providerOf(task.model)); if (q) q.runningCount++; },
```

- [ ] **Step 13: Add a `providerLimits` passthrough to the test helper**

Modify `src/tasks.test-helpers.js`'s `buildManagerOptions` (~line 265, right after the `allowedDirs` passthrough line):

```js
    ...passthroughIfSet({ providerLimits: options.providerLimits }, "providerLimits", "providerLimits"),
```

- [ ] **Step 14: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS. Every existing scheduler test still passes because with zero `providerLimits` entries configured, every provider bucket's own limits resolve to `UNLIMITED_PROVIDER` (Task 4 wires this default in), so behavior is identical to today's FIFO-over-one-queue scheduler for the single-provider case every existing test exercises.

Note: this step will only fully pass once Task 4's drain-algorithm rewrite lands — `drainLaunchQueue`/`scheduleNextLaunch`/`runLaunchQueuedTasks` still reference `sched.launchQueue` (now undefined) until that task rewires them. If you're executing this plan task-by-task, expect this step to fail here and pass again after Task 4; note that in the task's completion report rather than treating it as a blocker specific to this task's own changes.

- [ ] **Step 15: Commit**

```bash
git add src/tasks.js src/tasks.test-helpers.js
git commit -m "refactor(tasks): route scheduler state through per-provider queues"
```

---

