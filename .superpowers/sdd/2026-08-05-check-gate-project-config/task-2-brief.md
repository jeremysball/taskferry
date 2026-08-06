## Task 2: Task schema + RPC/CLI wiring for the new fields

**Files:**
- Modify: `src/tasks.js` (Task/TaskSummary/ResultDetail typedefs near line 40-165; `buildDispatchTask` ~1670; `dispatchTask` ~4913; `summarizeOptionalFields` ~2444; `computeResultDetail` ~1486; the `accept`/`dispatch`/`advisor` manager-API bindings ~3399/3491)
- Modify: `src/protocol.js` (`RESULT_FIELDS`; `METHOD_PARAMS["task.dispatch"]`, `["task.advisor"]`, `["task.accept"]`)
- Modify: `src/args.js` (`FLAGS`, `DEFAULT_OPTIONS.accept`)
- Modify: `src/command-specs.js` (dispatch/advisor/accept option docs)
- Modify: `src/commands.js` (`DISPATCH_PASSTHROUGH_KEYS`, `runAccept`)
- Modify: `src/daemon.js` (`invokeHandlers["task.accept"]`)

This task adds every new field and every new flag end-to-end, following the exact same wiring pattern the existing `--class`/`class` field already uses (confirmed at `src/args.js:211`, `src/commands.js:149,290`, `src/tasks.js:1671,1700,2445,4918`). No gate behavior yet — Task 5/6 add that. This task is independently testable: the fields round-trip through dispatch/status/result with default (empty) values, and `--parent-task`/`--force` parse and forward correctly.

**Interfaces:**
- Produces: `Task.checkStatus: "none"|"running"|"passed"|"failed"|"timeout"|"interrupted"`, `Task.checkCommand: string|null`, `Task.checkExitCode: number|null`, `Task.checkOutputTail: string|null`, `Task.checkStartedAt: string|null`, `Task.checkEndedAt: string|null`, `Task.checkOverride: boolean`, `Task.projectConfigWarning: string|null`, `Task.parentTaskId: string|null`, `Task.checkGatePid: number|null` (set by Task 5's gate runner, cleared when the gate settles). `buildDispatchTask(params)` accepts `parentTaskId` in its params object. `acceptTaskChangeset(taskId, { force }, ctx)` — note the added second positional options argument (was `acceptTaskChangeset(taskId, ctx)`; every caller must update). Task 5's gate runner and Task 6's accept-gating both consume these fields by name — do not rename any of them once this task lands.

- [ ] **Step 1: Extend the Task/TaskSummary typedefs**

In `src/tasks.js`, in the `Task` typedef block (ends `* @property {string|null} [changesetError]` around line 61), add:

```js
 * @property {string|null} [parentTaskId]
 * @property {"none"|"running"|"passed"|"failed"|"timeout"|"interrupted"} [checkStatus]
 * @property {string|null} [checkCommand]
 * @property {number|null} [checkExitCode]
 * @property {string|null} [checkOutputTail]
 * @property {string|null} [checkStartedAt]
 * @property {string|null} [checkEndedAt]
 * @property {boolean} [checkOverride]
 * @property {string|null} [projectConfigWarning]
 * @property {number|null} [checkGatePid]
```

(`checkGatePid` is the OS pid of the bwrap child (process-group leader — Task 5 spawns it `detached: true`) currently running the gate. Persisted alongside `checkStatus: "running"` for the in-flight gate, and also used by Task 7's restart-recovery sweep to best-effort group-kill a crash-orphaned gate on daemon boot. The live accept/reject kill-and-wait path (Task 6) does NOT read this field directly, though — it goes through `ctx.env.killGateAndWait(taskId)` (Task 5), which resolves the actual tracked `ChildProcess` from `ctx.gateChildren` so it can wait on a real `"exit"` event, not just fire a signal at a pid and hope. Cleared alongside `checkStatus` in `startCheckGate`'s `settle()` and `error` handlers.)

Make the identical addition to the `TaskSummary` typedef block (ends the same way, around line 95), and add the always-surfaced subset to `ResultDetail` (ends `* @property {string|null} [changesetError]` around line 163):

```js
 * @property {string|null} [parentTaskId]
 * @property {"none"|"running"|"passed"|"failed"|"timeout"|"interrupted"} [checkStatus]
 * @property {string|null} [checkCommand]
 * @property {number|null} [checkExitCode]
 * @property {string|null} [checkOutputTail]
 * @property {string|null} [checkStartedAt]
 * @property {string|null} [checkEndedAt]
 * @property {boolean} [checkOverride]
 * @property {string|null} [projectConfigWarning]
```

- [ ] **Step 2: Thread the fields through `buildDispatchTask`**

In `src/tasks.js`, `buildDispatchTask`'s params typedef (the `@param` line directly above it, ~line 1667) gains `parentTaskId?: string|null` at the end, and its destructuring signature:

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass, parentTaskId = null }) {
```

and its return object gains, right after the existing `changesetError: null,` line:

```js
    parentTaskId: parentTaskId == null ? null : parentTaskId,
    checkStatus: "none",
    checkCommand: null,
    checkExitCode: null,
    checkOutputTail: null,
    checkStartedAt: null,
    checkEndedAt: null,
    checkOverride: false,
    projectConfigWarning: null,
    checkGatePid: null,
```

- [ ] **Step 3: Thread `parentTaskId` through `dispatchTask`**

In `src/tasks.js`, `dispatchTask`'s `@param` typedef (~line 4913) gains `parentTaskId?: string|null` at the end of the params object type. Its destructuring line gains `parentTaskId = null`:

```js
function dispatchTask(params, ctx) {
  const { prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, executor: executorName, env, role = "dispatch", class: taskClass = null, parentTaskId = null } = params;
```

and its `buildDispatchTask({...})` call gains `parentTaskId` alongside the existing `class: taskClass`:

```js
  const task = buildDispatchTask({ id, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, directory: normalizedDirectory, class: taskClass, parentTaskId });
```

(`dispatchAdvisorTask` at ~line 2130 and `runAdvisor` at ~line 2255 both call into `ctx.dispatch({...})`/pass params straight through to the same `dispatchTask` — extend their destructuring/forwarding the same way: add `parentTaskId` to `dispatchAdvisorTask`'s `{ prompt, directory, model, variant, sessionId, executor, env, class: taskClass }` destructure and its `ctx.dispatch({...})` call, and to `runAdvisor`'s equivalent destructure/forward.)

- [ ] **Step 4: Surface the new fields in `summarize()` and `computeResultDetail()`**

In `src/tasks.js`, `summarizeOptionalFields` (~line 2444):

```js
function summarizeOptionalFields(task) {
  const { promptTotalChars, incomplete, finalMarker, finalStatus, executorId, class: taskClass, checkStatus, parentTaskId, projectConfigWarning } = task;
  return {
    ...(promptTotalChars != null ? { promptTotalChars } : {}),
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(incomplete === true ? { incomplete: true } : {}),
    ...(finalMarker != null ? { finalMarker } : {}),
    ...(finalStatus != null ? { finalStatus } : {}),
    ...(taskClass != null ? { class: taskClass } : {}),
    ...(executorId != null ? { executorId } : {}),
    ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
    ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
    ...(parentTaskId != null ? { parentTaskId } : {}),
    ...(projectConfigWarning != null ? { projectConfigWarning } : {}),
    ...(checkStatus != null && checkStatus !== "none"
      ? {
          checkStatus,
          checkCommand: task.checkCommand,
          checkExitCode: task.checkExitCode,
          checkStartedAt: task.checkStartedAt,
          checkEndedAt: task.checkEndedAt,
          ...(task.checkOverride ? { checkOverride: true } : {}),
        }
      : {}),
  };
}
```

(`checkOutputTail` is deliberately left out of the lean summary — it can be large, same reasoning as why `diff`/full `narration` are gated behind explicit fields/`--full` rather than always included.)

In `computeResultDetail` (~line 1486), add right after the existing `...(task.class != null ? { class: task.class } : {}),` line:

```js
    ...(task.parentTaskId != null ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.projectConfigWarning != null ? { projectConfigWarning: task.projectConfigWarning } : {}),
    ...(task.checkStatus != null && task.checkStatus !== "none"
      ? {
          checkStatus: task.checkStatus,
          checkCommand: task.checkCommand,
          checkExitCode: task.checkExitCode,
          checkStartedAt: task.checkStartedAt,
          checkEndedAt: task.checkEndedAt,
          ...(task.checkOverride ? { checkOverride: true } : {}),
          ...((fields == null || fields.includes("checkOutputTail")) && task.checkOutputTail != null ? { checkOutputTail: task.checkOutputTail } : {}),
        }
      : {}),
```

- [ ] **Step 5: Add the new fields to `RESULT_FIELDS` and the RPC param schemas**

In `src/protocol.js`, add to the `RESULT_FIELDS` set (after `"changesetError"`):

```js
  "checkStatus",
  "checkCommand",
  "checkExitCode",
  "checkOutputTail",
  "checkStartedAt",
  "checkEndedAt",
  "checkOverride",
  "parentTaskId",
  "projectConfigWarning",
```

In `METHOD_PARAMS["task.dispatch"].optional`, add `["parentTaskId", isNonEmptyString],` (alongside the existing `["class", isNonEmptyString]`). Make the identical addition to `METHOD_PARAMS["task.advisor"].optional`. In `METHOD_PARAMS["task.accept"].optional`, add `["force", isBoolean]` (it's currently `optional: []`).

- [ ] **Step 6: Add `--parent-task` and `--force` to the CLI arg parser**

In `src/args.js`'s `FLAGS` table, add (near `--class`):

```js
  "--parent-task": { allow: ["dispatch", "advisor"], key: "parentTaskId" },
```

and near `--no-overlay`:

```js
  "--force": { allow: ["accept"], bool: true },
```

Change `DEFAULT_OPTIONS.accept` from `() => ({ taskId: void 0 })` to:

```js
  accept: () => ({ taskId: void 0, ...flagDefaultsFor("accept") }),
```

- [ ] **Step 7: Document the new flags in `command-specs.js`**

In `src/command-specs.js`'s `dispatch.options`, add after `"--class <name>": ...`:

```js
      "--parent-task <id>": "tag this dispatch as fixing/retrying an earlier task; persisted as parentTaskId, and echoed by that task's check-gate failure message",
```

and one new dispatch example: `'taskferry dispatch --prompt "Fix: check gate failed" --parent-task oc_msgabc12'`. Make the identical `--parent-task <id>` addition to `advisor.options`. The design's §6 only asks for `--parent-task` on `dispatch` (the gate's suggested fix-forward command is itself a `taskferry dispatch ... --parent-task ...`), but exposing it on `advisor` too is a deliberate, useful extra: a review-fix round that uses the advisor role to read the failing task's output and re-prompt a new dispatch can tag itself with `--parent-task` and the link survives into the dashboard, which is exactly the cross-role lineage metric the spec's "retry chains" telemetry section wants. (Documenting this as intentional rather than silent out-of-scope overshoot.)

In `accept`, change `options: {}` to:

```js
    options: { "--force": "apply the changeset even though its check gate failed, timed out, is still running, or was interrupted by a daemon restart; records checkOverride: true" },
```

and add an example: `'taskferry accept <id> --force'`.

- [ ] **Step 8: Forward `parentTaskId`/`force` through `commands.js`**

In `src/commands.js`, add `"parentTaskId"` to `DISPATCH_PASSTHROUGH_KEYS` (line 149). Change `runAccept`:

```js
async function runAccept(options, { client }) {
  const accepted = await client.request("task.accept", { taskId: options.taskId, ...(options.force === true && { force: true }) });
  warnIfCleanupFailed("changeset applied", accepted);
  return accepted;
}
```

(Task 6 extends `runAccept` further, once `acceptTaskChangeset`'s return value carries `checkStatus`, to warn on an accept where the repo declared no check command at all — see Task 6 Step 4.)

- [ ] **Step 9: Forward `force` from `daemon.js` and update the manager-API `accept` binding**

In `src/daemon.js`'s `invokeHandlers`, change:

```js
  "task.accept": (manager, params) => manager.accept(params.taskId, { force: params.force === true }),
```

In `src/tasks.js`, change every `accept:` binding that currently reads `accept: (taskId) => acceptTaskChangeset(taskId, {...})` (the `ctx.helpers.accept`-style closure ~line 3399, and the public API's `accept: (taskId) => ctx.helpers.accept(taskId)` ~line 3491) to thread a second `options` argument through:

```js
    accept: (taskId, options) => acceptTaskChangeset(taskId, options, { ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(), tasks: ctx.maps.tasks, existsFn: ctx.opts.existsFn, hasLiveOverlay: (task) => ctx.helpers.hasLiveOverlay(task), stateDir: ctx.opts.stateDir, runtimeDir: ctx.opts.runtimeDir, sandboxDenylist: ctx.opts.sandboxDenylist, runOverlayCommandFn: ctx.opts.runOverlayCommandFn, overlaySleepFn: ctx.opts.overlaySleepFn, persistTask: (taskId2) => ctx.helpers.persistTask(taskId2), releaseOverlay: (task) => ctx.env.releaseOverlay(task), killGateAndWait: (taskId2) => ctx.env.killGateAndWait(taskId2), noSuchTask }),
```

(`killGateAndWait` is threaded here — even though Task 2 doesn't consume it — so Task 6 Step 4's in-flight-gate kill handshake can `await ctx.killGateAndWait(taskId)` without Task 6 having to re-edit the factory binding. `killGateAndWait` itself is defined and exposed on `ctx.env` in Task 5 Step 5; Task 6 only adds the matching typedef entry to `acceptTaskChangeset`/`rejectTaskChangeset` and makes both functions `async` so the await has somewhere to land — see Task 6 Step 4's "review fix" note. Note this makes `acceptTaskChangeset` return a `Promise`, which is why the `accept:` binding above and the RPC handler both need no further change: `src/daemon-server.js:131` already does `await invoke(...)` generically for every method.)

```js
    accept: (taskId, options) => ctx.helpers.accept(taskId, options),
```

And update the `reject:` factory binding at the same scope (~line 3404) to thread `killGateAndWait` through. `rejectTaskChangeset`'s signature stays `rejectTaskChangeset(taskId, ctx)` (no `force` needed — `reject` is always allowed regardless of `checkStatus` per the design's §4), but the `ctx` object needs `killGateAndWait` so Task 6's in-flight-gate kill-and-wait handshake can fire without Task 6 having to re-edit the binding:

```js
    reject: (taskId) => rejectTaskChangeset(taskId, { ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(), tasks: ctx.maps.tasks, persistTask: (taskId) => ctx.helpers.persistTask(taskId), releaseOverlay: (task) => ctx.env.releaseOverlay(task), killGateAndWait: (taskId2) => ctx.env.killGateAndWait(taskId2), noSuchTask }),
```

The public-API `reject: (taskId) => ctx.helpers.reject(taskId)` binding at ~line 3496 needs no changes — it just delegates to the helpers closure above.

And update `acceptTaskChangeset`'s own signature at `src/tasks.js:4536` from `function acceptTaskChangeset(taskId, ctx)` to `function acceptTaskChangeset(taskId, { force = false } = {}, ctx)` so the new positional `options` parameter (the `force` flag) lands in the function body — and is simply unused until Task 6 starts consuming it. This is the literal plumbing the caller bindings demand; threading a new positional `options` through every caller while leaving the function's own signature at the old 2-arg shape would land `options` in the `ctx` slot of `acceptTaskChangeset`, and `ctx.ensureStateLoaded()` would throw on every accept (`undefined` is not callable). The signature change must land atomically with the caller-binding changes in this step, so the unit suite run below proves the plumbing is correct as its own commit before any gating behavior builds on top. (Task 6 does not touch this signature declaration — it only adds the `validateAcceptable` `force` branch, the `buildCheckGateFailureMessage` helper, and `checkOverride` recording on top of the `{ force = false }` parameter Task 2 already landed.)

- [ ] **Step 9b: Surface `checkStatus` (when not `"none"`) and `projectConfigWarning` (when set) in `leanStatus`**

Without this, plain `taskferry status <id>` (no `--full`) reports nothing useful about a gate that just started or a parse error — the design requires `checkStatus: running` visible from gate start (per the design's §2 "checkStatus ... is visible from the moment the gate starts"), and Task 6's "check gate still running" error message points the user at `taskferry status <id>` for progress, which currently shows nothing (`leanStatus` in `src/output.js:144-169` is an allow-list projection that omits both fields entirely). Add this alongside the existing `changesetStatus`/`changesetError` project in the same function:

```js
  if (detail.checkStatus && detail.checkStatus !== "none") {
    lean.checkStatus = detail.checkStatus;
    lean.checkCommand = detail.checkCommand;
    lean.checkExitCode = detail.checkExitCode;
    lean.checkStartedAt = detail.checkStartedAt;
    lean.checkEndedAt = detail.checkEndedAt;
    if (detail.checkOverride) lean.checkOverride = true;
  }
  if (detail.projectConfigWarning) lean.projectConfigWarning = detail.projectConfigWarning;
```

(Place these right after the existing `if (detail.changesetError) lean.changesetError = detail.changesetError;` line, matching that line's exact pattern. `checkOutputTail` is intentionally left out of the lean projection — same large-payload reasoning as `Task 4` Step 4's `summarizeOptionalFields` / `Task 2` Step 4 below — it stays available via `taskferry result <id> --fields checkOutputTail` / `--full`.) Add a matching case to `src/output.test.js` (or wherever `leanStatus`'s existing tests live) verifying both: a task with `checkStatus: "running"` and a tasks with `projectConfigWarning` set both surface on the lean projection, and a task with `checkStatus: "none"` (the default) does not.

- [ ] **Step 10: Run the full suite and commit**

This task changes the *signature* of `acceptTaskChangeset` (Step 9 below), so the unit tests that exercise the accept path — `src/tasks.lifecycle.test.js`, `src/tasks.changeset.test.js`, `src/tasks.persist.test.js`, `src/commands.test.js`, `src/cli.test.js`, `src/daemon.test.js` — must run alongside the dispatch/args/protocol tests, not be deferred to Task 6. Running the narrowed subset here would land a signature change without proving it doesn't break the accept path, and Task 6's own "is anything in accept's plumbing broken?" check would then be running against the same broken build.

Run: `npm run test:unit`
Expected: PASS (every existing test, plus all of this task's new cases — the new fields default to neutral values, every new param is optional, and the `acceptTaskChangeset(taskId, { force = false } = {}, ctx)` signature accepts either old-style `acceptTaskChangeset(taskId, ctx)` callsites OR new-style `acceptTaskChangeset(taskId, options, ctx)` callsites, because the optional options object has a default of `{}`).

```bash
git add -A
git commit -m "feat(tasks): add check-gate/parentTaskId schema and CLI/RPC wiring"
```

---

