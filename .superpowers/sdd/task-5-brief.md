### Task 5: `Task`/`DispatchLaunch`/`SummaryLaunch` gain `executorId`/`executor`; `createTaskManager` gains an `executor` factory option

**Files:**
- Modify: `src/tasks.js` (typedefs near the top, `createTaskManager`'s options destructuring at line 405)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `resolveExecutor`, `opencodeExecutor` from `src/executor.js` (Tasks 1-2).
- Produces: `createTaskManager({..., executor = resolveExecutor(undefined)})`; a `task.executorId` field read/written everywhere a `Task` is constructed.

- [ ] **Step 1: Import the executor module and add the manager-level option**

At the top of `src/tasks.js`, add:

```js
import { resolveExecutor } from "./executor.js";
```

In `createTaskManager`'s destructured options (currently starting at line 405), add one new option alongside the existing `listModelsFn`/`verifySummaryAgentFn` defaults:

```js
export function createTaskManager({
  spawnFn = spawn,
  killFn = (pid, signal) => process.kill(pid, signal),
  listModelsFn = async (env) => (await execFileAsync("opencode", ["models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env })).stdout,
  verifySummaryAgentFn = async (env) => { /* ...unchanged... */ },
  defaultExecutor = resolveExecutor(undefined),
  // ...rest unchanged...
```

`defaultExecutor` (not `executor`) to make it unambiguous this is the *fallback* used when a dispatch doesn't request one — `resolveExecutor(params.executor)` (Task 6) is what actually picks per-dispatch. Tests inject an override the same way they already override `listModelsFn`: pass `defaultExecutor: resolveExecutor("pi")` (or a hand-built fake `WorkerExecutor`) into `createTaskManager`.

- [ ] **Step 2: Add `executorId` to the `Task` typedef and `executor` to the launch typedefs**

```js
/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} status
 * @property {string} directory
 * @property {string} model
 * @property {string|null} variant
 * @property {string|null} sessionId
 * @property {string|null} originSessionId
 * @property {number|null} pid
 * @property {string} startedAt
 * @property {string|null} endedAt
 * @property {number|null} exitCode
 * @property {NodeJS.Signals|null} signal
 * @property {string} logPath
 * @property {string} promptPreview
 * @property {number|null} promptTotalChars
 * @property {string|null} spawnError
 * @property {boolean} cancelRequested
 * @property {boolean} internal
 * @property {string|null} [failureReason]
 * @property {string|null} [failureDetail]
 * @property {string|null} [keySlot]
 * @property {SummaryOf} [summaryOf]
 * @property {boolean} [incomplete]
 * @property {string|null} [finalMarker]
 * @property {"opencode"|"pi"} [executorId]
 */
```

```js
/**
 * @typedef {object} DispatchLaunch
 * @property {string} prompt
 * @property {string} directory
 * @property {string} model
 * @property {string|null} variant
 * @property {string|null|undefined} [sessionId]
 * @property {string|null} [keyEnvValue]
 * @property {boolean} [noSandbox]
 * @property {string[]} [allowedDirs]
 * @property {import("./executor.js").WorkerExecutor} executor
 * @property {undefined} [kind]
 * @property {undefined} [snapshotPath]
 */

/**
 * @typedef {object} SummaryLaunch
 * @property {"summary"} kind
 * @property {string} model
 * @property {string} snapshotPath
 * @property {NodeJS.ProcessEnv} env
 * @property {string|null} [keyEnvValue]
 * @property {string} [summarySessionId]
 * @property {import("./executor.js").WorkerExecutor} executor
 */
```

- [ ] **Step 3: `loadPersisted` defaults a missing `executorId` to `"opencode"`**

Find the function that reads `tasks.json` into the in-memory `tasks` Map at manager construction (search `src/tasks.js` for `function loadPersisted` or the equivalent — it runs synchronously inside `createTaskManager` per the existing `tasks.test.js` comment at line 12-14 about `loadPersisted()` running in the constructor). Wherever it does `tasks.set(t.id, t)` for each record read from disk, ensure the record gets a default:

```js
for (const t of parsed) {
  if (t.executorId === undefined) t.executorId = "opencode";
  tasks.set(t.id, t);
}
```

Locate the exact existing loop by reading the function first (`rg -n "function loadPersisted" src/tasks.js`) — do not guess its current shape; add the one-line default inside whatever iteration already exists there, preserving every other line unchanged.

- [ ] **Step 4: Write a test for the read-time default**

```js
test("a persisted task with no executorId defaults to \"opencode\" on load", () => {
  const manager = makeManager({
    tasksFixture: (logDir) => [{
      id: "oc_legacy", status: "done", directory: "/tmp", model: "openai/gpt-5.6-luna", variant: "high",
      sessionId: null, originSessionId: null, pid: null, startedAt: "2026-07-13T10:00:00.000Z",
      endedAt: "2026-07-13T10:01:00.000Z", exitCode: 0, signal: null, logPath: path.join(logDir, "oc_legacy.ndjson"),
      promptPreview: "legacy task", promptTotalChars: null, spawnError: null, cancelRequested: false, internal: false,
      // no executorId field -- simulates a record persisted before this change shipped
    }],
  });
  const status = manager.status("oc_legacy");
  assert.equal(status.executorId, "opencode");
});
```

If `status()`/the summarize-row function doesn't currently surface `executorId` in its output, add it — check `summarizeTask`/`summarizeRow` (whatever `src/tasks.js` calls the function that trims a `Task` down to a `TaskSummary`/status row) and add `executorId: task.executorId` to its returned object, plus add `executorId` to the `TaskSummary` typedef alongside `Task`'s.

- [ ] **Step 5: Run tests**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): add executorId to Task, defaultExecutor option to createTaskManager"
```

---

