# taskferry_advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `taskferry_wait` to `taskferry_poll`, then add `taskferry_advisor` — a blocking "ask a bigger model" tool with session-recency (TTL) tracking so it never silently resumes a stale, cache-cold conversation.

**Architecture:** `taskferry_advisor` is a thin composition of existing `tasks.js` machinery (`dispatch` + `poll` + `result`) — no new subprocess-spawning or log-parsing code. A new in-memory `Map<sessionId, lastUsedAt>` inside the task manager tracks advisor session recency; a resolved-stale-or-unknown session silently starts a fresh opencode session instead of erroring, and the response tells the caller via `session_reset`/`previous_session_id`.

**Tech Stack:** Node.js (ES modules), `node --test` + `node:assert/strict` for unit tests, `@modelcontextprotocol/sdk` for the MCP server, `zod` for input schemas, `@toon-format/toon` for response encoding.

## Global Constraints

- Every MCP tool response is TOON-encoded via the existing `toon()` helper in `src/server.js` — new tools must return through it, not raw JSON.
- Tool descriptions follow the existing AXI-style pattern: explain what the tool does, when to call it, and what to call next (`next`/`note` hints), matching the register calls already in `src/server.js`.
- Error messages follow the existing `error: ...\nhelp: ...` two-line format used throughout `tasks.js`.
- `timeout_ms`/blocking calls are capped at 45000ms (`MAX_WAIT_MS` in `tasks.js`) — this is enforced once, inside `poll()` (formerly `wait()`); do not re-implement the cap elsewhere.
- Advisor session TTL default is 30 minutes (`1800000`), overridable via `TASKFERRY_ADVISOR_SESSION_TTL_MS`, read the same way `TASKFERRY_SUMMARY_MODEL` is read today (module-level env var with a fallback default).
- The session-recency registry is in-memory only, process-lifetime, not persisted to `TASKS_FILE` or disk — a taskferry restart means every session_id is "unknown," which resolves identically to "expired."
- No model-strength pairing/enforcement — the caller picks the advisor model; `taskferry_advisor`'s `model` param is required with no default (unlike `taskferry_dispatch`'s `model`, which defaults to `openai/gpt-5.6-luna`).

---

## File Structure

- **Modify `src/tasks.js`**: rename `wait()` → `poll()`; add `advisorSessionTtlMs` option to `createTaskManager()`; add the session-recency registry (`advisorSessions` Map) and two small helpers (`resolveAdvisorSession`, `touchAdvisorSession`); add the `advisor()` function; update every `taskferry_wait` string reference to `taskferry_poll`; export `poll` and `advisor` from the returned object instead of `wait`.
- **Modify `src/server.js`**: rename the `taskferry_wait` tool registration to `taskferry_poll` (same description content, `taskferry_wait` mentions elsewhere updated to `taskferry_poll`); add a new `taskferry_advisor` tool registration.
- **Modify `src/tasks.test.js`**: rename the `wait()` describe block and all `mgr.wait(...)` calls to `mgr.poll(...)`; add a new `describe("advisor()", ...)` block and a new `describe("advisor() session TTL", ...)` block.
- **Modify `src/server.test.js`**: no rename needed here (it doesn't reference `taskferry_wait`), but add a light assertion that `taskferry_advisor` is registered.
- **Rename `src/wait-smoke-test.js` → `src/poll-smoke-test.js`**: update tool name string and log text.
- **Modify `package.json`**: `test:integration` script references `src/wait-smoke-test.js` → `src/poll-smoke-test.js`.
- **Modify `README.md`**: rename the `taskferry_wait` section to `taskferry_poll`; add a new `taskferry_advisor` section; update the "Why polling and waiting" prose and the integration-test list.
- **Modify `SUMMARY_AND_TAIL_SPEC.md`**: update all `taskferry_wait` mentions to `taskferry_poll`.

---

### Task 1: Rename `taskferry_wait` to `taskferry_poll`

**Files:**
- Modify: `src/tasks.js:16` (comment), `src/tasks.js:108` (comment), `src/tasks.js:231-232`, `src/tasks.js:377`, `src/tasks.js:556` (comment), `src/tasks.js:599-633` (function `wait` → `poll`), `src/tasks.js:741`, `src/tasks.js:857` (return object)
- Modify: `src/server.js:71-97` (tool registration), `src/server.js:22`, `src/server.js:120`
- Modify: `src/tasks.test.js:412-457` (describe block + calls), plus any other `mgr.wait(` calls
- Rename: `src/wait-smoke-test.js` → `src/poll-smoke-test.js`
- Modify: `package.json:9` (`test:integration` script)
- Modify: `README.md:71-81`, `README.md:181`, `README.md:349`
- Modify: `SUMMARY_AND_TAIL_SPEC.md:10,18,47,57,107,198`
- Test: `src/tasks.test.js`, `src/server.test.js`

**Interfaces:**
- Produces: `tasks.js` exports `poll(taskId, { timeoutMs, tailChars })` from `createTaskManager()`'s returned object (same signature and return shape `wait()` had). `server.js` registers MCP tool `taskferry_poll` with the same input schema `taskferry_wait` had (`task_id`, `timeout_ms?`, `tail_chars?`).

- [ ] **Step 1: Rename the function and its internal references in `src/tasks.js`**

Change line 599 from:
```js
  function wait(taskId, { timeoutMs = MAX_WAIT_MS, tailChars } = {}) {
```
to:
```js
  function poll(taskId, { timeoutMs = MAX_WAIT_MS, tailChars } = {}) {
```

Change the comment at line 16 from:
```js
// Cap the internal wait below that so a long task returns a clean
```
to:
```js
// Cap the internal poll below that so a long task returns a clean
```

Change the comment at lines 108-110 from:
```js
  // Pending taskferry_wait callbacks, keyed by task id. Lets a single MCP tool
  // call block until the child's exit event fires (or a timeout elapses)
  // instead of the caller round-tripping taskferry_status in a loop. Not
```
to:
```js
  // Pending taskferry_poll callbacks, keyed by task id. Lets a single MCP tool
  // call block until the child's exit event fires (or a timeout elapses)
  // instead of the caller round-tripping taskferry_status in a loop. Not
```

Change lines 230-232 from:
```js
      next: task.status === "queued"
        ? `Task is queued; run taskferry_wait or taskferry_status with task_id "${id}" to check when it starts`
        : `Run taskferry_wait or taskferry_status with task_id "${id}" to check progress`,
```
to:
```js
      next: task.status === "queued"
        ? `Task is queued; run taskferry_poll or taskferry_status with task_id "${id}" to check when it starts`
        : `Run taskferry_poll or taskferry_status with task_id "${id}" to check progress`,
```

Change line 377 from:
```js
      next: `Run taskferry_wait with task_id "${id}", then taskferry_result with task_id "${id}"`,
```
to:
```js
      next: `Run taskferry_poll with task_id "${id}", then taskferry_result with task_id "${id}"`,
```

Change the comment at line 556 from:
```js
  // that's just slow, without waiting out a full taskferry_wait timeout.
```
to:
```js
  // that's just slow, without waiting out a full taskferry_poll timeout.
```

Change line 741 from:
```js
        help: `Run taskferry_wait with task_id "${taskId}" to wait for task output`,
```
to:
```js
        help: `Run taskferry_poll with task_id "${taskId}" to wait for task output`,
```

Change line 857 from:
```js
  return { dispatch, cancel, status, wait, list, result, tail, summarize: summarizeTask, paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE } };
```
to:
```js
  return { dispatch, cancel, status, poll, list, result, tail, summarize: summarizeTask, paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE } };
```

- [ ] **Step 2: Rename the MCP tool in `src/server.js`**

Change line 22 (the `taskferry_dispatch` description) from:
```js
      "Queue an `opencode run` for background execution as a directly-spawned child process (no tmux, no shared visibility into the orchestration layer) and return a task_id immediately. The server starts at most two tasks in each rolling five-second window by default. After dispatching, call taskferry_wait to block until the task finishes or times out; if it times out, call taskferry_tail to read the latest output and report the task's current status to the user. Once the task is done, call taskferry_result to fetch the final result.",
```
to:
```js
      "Queue an `opencode run` for background execution as a directly-spawned child process (no tmux, no shared visibility into the orchestration layer) and return a task_id immediately. The server starts at most two tasks in each rolling five-second window by default. After dispatching, call taskferry_poll to block until the task finishes or times out; if it times out, call taskferry_tail to read the latest output and report the task's current status to the user. Once the task is done, call taskferry_result to fetch the final result.",
```

Change lines 70-97 (the whole `taskferry_wait` tool registration) from:
```js
server.registerTool(
  "taskferry_wait",
  {
    title: "Block until a taskferry task finishes",
    description:
      "Block on a queued or running task until it exits (or a timeout) and return its status once settled. The closest analog to the built-in Agent tool's auto-resume behavior available over plain MCP request/response, without a poll loop. Capped internally at 45s so the call returns cleanly instead of hitting Claude Code's own MCP tool-call timeout; if status is still queued or running when it returns, call taskferry_wait again. Pass tail_chars to get the trailing narration when the task is still running after the timeout; then call taskferry_tail to read more and report the task's current progress to the user. Always inform the user of the task's status after calling this tool.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds to block. Capped at 45000 regardless of what's passed. Defaults to 45000."),
      tail_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When the wait times out and the task is still running, return this many trailing narration characters. Use this to report progress to the user while the task continues."),
    },
  },
  async ({ task_id, timeout_ms, tail_chars }) => {
    const s = await tasks.wait(task_id, {
      ...(timeout_ms != null ? { timeoutMs: timeout_ms } : {}),
      ...(tail_chars != null ? { tailChars: tail_chars } : {}),
    });
    return toon(s);
  }
);
```
to:
```js
server.registerTool(
  "taskferry_poll",
  {
    title: "Block until a taskferry task finishes",
    description:
      "Block on a queued or running task until it exits (or a timeout) and return its status once settled. The closest analog to the built-in Agent tool's auto-resume behavior available over plain MCP request/response, without a poll loop. Capped internally at 45s so the call returns cleanly instead of hitting Claude Code's own MCP tool-call timeout; if status is still queued or running when it returns, call taskferry_poll again. Pass tail_chars to get the trailing narration when the task is still running after the timeout; then call taskferry_tail to read more and report the task's current progress to the user. Always inform the user of the task's status after calling this tool.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds to block. Capped at 45000 regardless of what's passed. Defaults to 45000."),
      tail_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When the poll times out and the task is still running, return this many trailing narration characters. Use this to report progress to the user while the task continues."),
    },
  },
  async ({ task_id, timeout_ms, tail_chars }) => {
    const s = await tasks.poll(task_id, {
      ...(timeout_ms != null ? { timeoutMs: timeout_ms } : {}),
      ...(tail_chars != null ? { tailChars: tail_chars } : {}),
    });
    return toon(s);
  }
);
```

Change line 120 (the `taskferry_tail` description) from:
```js
      "Return the last requested Unicode code points of the most recent parsed text event for a task. Reads locally and never sends task content to a model. Use this after taskferry_wait times out to check what the task is doing, then report its progress to the user.",
```
to:
```js
      "Return the last requested Unicode code points of the most recent parsed text event for a task. Reads locally and never sends task content to a model. Use this after taskferry_poll times out to check what the task is doing, then report its progress to the user.",
```

- [ ] **Step 3: Rename the test block and calls in `src/tasks.test.js`**

Change the `describe("wait()", ...)` block (lines 412-457) header from:
```js
describe("wait()", () => {
```
to:
```js
describe("poll()", () => {
```

Within that block, replace every `mgr.wait(` call with `mgr.poll(`. There are 4 occurrences (lines ~415, 425, 436, 451):
```js
    const settled = await mgr.poll("t1", { timeoutMs: 50 });
```
```js
    const waitPromise = mgr.poll(dispatched.id, { timeoutMs: 5000 });
```
```js
    const settled = await mgr.poll(dispatched.id, { timeoutMs: 20 });
```
```js
    const settled = await mgr.poll(dispatched.id, { timeoutMs: 20, tailChars: 6 });
```

Also update the "waits for a queued task to settle instead of returning immediately" test inside `describe("dispatch queue", ...)` (around line 260):
```js
    const waiting = mgr.wait(queued.id, { timeoutMs: 100 });
```
to:
```js
    const waiting = mgr.poll(queued.id, { timeoutMs: 100 });
```

And the "unknown task_id" shared-error-path test (around line 352-354):
```js
  test("wait() throws synchronously (not a rejected promise) for an unknown id", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.wait("nope"), /error: unknown task_id: nope/);
  });
```
to:
```js
  test("poll() throws synchronously (not a rejected promise) for an unknown id", () => {
    const mgr = makeManager();
    assert.throws(() => mgr.poll("nope"), /error: unknown task_id: nope/);
  });
```

Run `rg -n "mgr\.wait\(" src/tasks.test.js` after editing to confirm zero remaining matches before moving on.

- [ ] **Step 4: Rename and update the smoke test file**

Rename `src/wait-smoke-test.js` to `src/poll-smoke-test.js` (`git mv src/wait-smoke-test.js src/poll-smoke-test.js`), then update its contents: every `name: "taskferry_wait"` → `name: "taskferry_poll"`, the `Client` name `"wait-smoke-test"` → `"poll-smoke-test"`, `console.log` case labels `taskferry_wait` → `taskferry_poll`, and the final pass/fail messages `WAIT SMOKE TEST PASSED`/`FAILED` → `POLL SMOKE TEST PASSED`/`FAILED`.

- [ ] **Step 5: Update `package.json`'s integration test script**

Change:
```json
    "test:integration": "node src/smoke-test.js && node src/cancel-smoke-test.js && node src/wait-smoke-test.js"
```
to:
```json
    "test:integration": "node src/smoke-test.js && node src/cancel-smoke-test.js && node src/poll-smoke-test.js"
```

- [ ] **Step 6: Update `README.md`**

Change the section header at line 71 from:
```
### `taskferry_wait(task_id, timeout_ms?, tail_chars?)`
```
to:
```
### `taskferry_poll(task_id, timeout_ms?, tail_chars?)`
```

Change line 181 from:
```
`taskferry_wait` is the practical middle ground: one blocking call that
```
to:
```
`taskferry_poll` is the practical middle ground: one blocking call that
```

Change line 349 from:
```
node src/wait-smoke-test.js     # taskferry_wait resolving early and hitting its cap
```
to:
```
node src/poll-smoke-test.js     # taskferry_poll resolving early and hitting its cap
```

- [ ] **Step 7: Update `SUMMARY_AND_TAIL_SPEC.md`**

Replace every remaining `taskferry_wait` with `taskferry_poll` (lines 10, 18, 47, 57, 107, 198 per the current grep — re-grep first since line numbers may drift after earlier edits in this doc):
```bash
rg -n "taskferry_wait" SUMMARY_AND_TAIL_SPEC.md
```
Edit each match in place, e.g. line 10:
```
The tools complement existing interfaces. `taskferry_status` remains the source of lifecycle state, `taskferry_poll` remains the blocking lifecycle primitive, and `taskferry_result` remains the full completed-task result.
```

- [ ] **Step 8: Run the unit test suite**

Run: `npm run test:unit`
Expected: PASS, zero references to `taskferry_wait` or `mgr.wait(` remain in test output or failures.

- [ ] **Step 9: Verify no stray `taskferry_wait` references remain**

Run: `rg -n "taskferry_wait|mgr\.wait\(" .`
Expected: no output (empty).

- [ ] **Step 10: Commit**

```bash
git add src/tasks.js src/server.js src/tasks.test.js src/poll-smoke-test.js package.json README.md SUMMARY_AND_TAIL_SPEC.md
git rm src/wait-smoke-test.js 2>/dev/null || true
git commit -m "refactor(taskferry): rename taskferry_wait to taskferry_poll"
```
(If `git mv` was used in Step 4, `src/wait-smoke-test.js` is already staged as a rename — the `git rm` above is a no-op fallback in case `git mv` wasn't available; skip it if `git status` already shows the rename cleanly.)

---

### Task 2: Advisor session TTL registry in `tasks.js`

**Files:**
- Modify: `src/tasks.js` (add `advisorSessionTtlMs` option, `advisorSessions` Map, `resolveAdvisorSession`, `touchAdvisorSession`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: two functions inside the `createTaskManager()` closure that `advisor()` (Task 3) will call directly in the same file:
  - `resolveAdvisorSession(sessionId)` → `{ sessionId: string | undefined, reset: boolean, previousSessionId: string | undefined }`. Given a caller-supplied `sessionId` (may be `undefined`/`null`), returns the id to actually dispatch with (`undefined` if starting fresh), whether a reset happened, and the original id if it did.
  - `touchAdvisorSession(sessionId)` → `void`. Records/refreshes `lastUsedAt` for a session id. No-op if `sessionId` is falsy.
  - `createTaskManager()` gains an `advisorSessionTtlMs` option (default `DEFAULT_ADVISOR_SESSION_TTL_MS`, itself `positiveInteger(Number(process.env.TASKFERRY_ADVISOR_SESSION_TTL_MS), 30 * 60 * 1000)`), mirroring the existing `maxDispatchesPerWindow`/`dispatchWindowMs` pattern.
  - This task also adds **temporary** test-only hooks (`__resolveAdvisorSessionForTest`, `__touchAdvisorSessionForTest`) to the return object solely so the TTL logic can be unit-tested before `advisor()` exists to exercise it indirectly. Task 3 deletes both hooks once `advisor()`'s own tests supersede them — they must not remain in the final `return` statement.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.test.js`, after the `describe("poll()", ...)` block (so it lands near related session/timing tests):

```js
describe("advisor() session TTL resolution", () => {
  test("a session used within the TTL passes through unchanged", () => {
    const mgr = makeManager({ advisorSessionTtlMs: 1000 });
    mgr.__touchAdvisorSessionForTest("ses_fresh");
    const resolved = mgr.__resolveAdvisorSessionForTest("ses_fresh");
    assert.deepEqual(resolved, { sessionId: "ses_fresh", reset: false, previousSessionId: undefined });
  });

  test("a session past the TTL resets to a fresh dispatch", async () => {
    const mgr = makeManager({ advisorSessionTtlMs: 10 });
    mgr.__touchAdvisorSessionForTest("ses_stale");
    await new Promise((r) => setTimeout(r, 20));
    const resolved = mgr.__resolveAdvisorSessionForTest("ses_stale");
    assert.deepEqual(resolved, { sessionId: undefined, reset: true, previousSessionId: "ses_stale" });
  });

  test("a session id never seen before resolves identically to an expired one", () => {
    const mgr = makeManager({ advisorSessionTtlMs: 1000 });
    const resolved = mgr.__resolveAdvisorSessionForTest("ses_never_tracked");
    assert.deepEqual(resolved, { sessionId: undefined, reset: true, previousSessionId: "ses_never_tracked" });
  });

  test("no session_id at all resolves with no reset (there was nothing to resume)", () => {
    const mgr = makeManager({ advisorSessionTtlMs: 1000 });
    const resolved = mgr.__resolveAdvisorSessionForTest(undefined);
    assert.deepEqual(resolved, { sessionId: undefined, reset: false, previousSessionId: undefined });
  });

  test("touching a session refreshes its TTL window", async () => {
    const mgr = makeManager({ advisorSessionTtlMs: 30 });
    mgr.__touchAdvisorSessionForTest("ses_active");
    await new Promise((r) => setTimeout(r, 20));
    mgr.__touchAdvisorSessionForTest("ses_active"); // refresh before the 30ms TTL elapses
    await new Promise((r) => setTimeout(r, 20));
    // 40ms since the refresh-touch, but only 20ms since the second touch < 30ms TTL
    const resolved = mgr.__resolveAdvisorSessionForTest("ses_active");
    assert.equal(resolved.reset, false);
  });
});
```

Note: `__resolveAdvisorSessionForTest`/`__touchAdvisorSessionForTest` are temporary test-only hooks added to the manager's return object in Step 3 below, purely so this task's TTL logic can be unit-tested in isolation before Task 3 wires it into `advisor()`. Task 3 deletes both the hooks and this whole `describe` block, replacing it with fuller `advisor()`-level tests that exercise the same TTL logic end-to-end — don't treat this block as permanent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `mgr.__resolveAdvisorSessionForTest is not a function` (or similar) for each new test.

- [ ] **Step 3: Implement the TTL registry in `src/tasks.js`**

Add near the top of the file, alongside the other module-level constants (after `const SUMMARY_MODEL = ...` around line 21):

```js
const DEFAULT_ADVISOR_SESSION_TTL_MS = positiveInteger(
  Number(process.env.TASKFERRY_ADVISOR_SESSION_TTL_MS),
  30 * 60 * 1000
);
```

(`positiveInteger` is defined above this point already, at line 38 in the current file — if constant ordering matters, place this new constant after the `positiveInteger` function definition, same as `DEFAULT_MAX_DISPATCHES_PER_WINDOW` already does.)

Add `advisorSessionTtlMs` to the `createTaskManager()` options destructuring (next to `maxDispatchesPerWindow`/`dispatchWindowMs`):

```js
export function createTaskManager({
  spawnFn = spawn,
  killFn = (pid, signal) => process.kill(pid, signal),
  listModelsFn = async () => (await execFileAsync("opencode", ["models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS })).stdout,
  verifySummaryAgentFn = async (env) => {
    const { stdout, stderr } = await execFileAsync(
      "opencode",
      ["debug", "agent", SUMMARY_AGENT, "--pure", "--tool", "bash", "--params", JSON.stringify({ command: "true" })],
      { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env }
    );
    if (!/disabled|denied/i.test(`${stdout}\n${stderr}`)) {
      throw new Error("summary agent allowed bash");
    }
  },
  stateDir = DEFAULT_STATE_DIR,
  maxDispatchesPerWindow = DEFAULT_MAX_DISPATCHES_PER_WINDOW,
  dispatchWindowMs = DEFAULT_DISPATCH_WINDOW_MS,
  advisorSessionTtlMs = DEFAULT_ADVISOR_SESSION_TTL_MS,
} = {}) {
```

Add the resolved TTL and the registry near the other `const dispatchLimit = ...` line:

```js
  const advisorTtl = positiveInteger(advisorSessionTtlMs, DEFAULT_ADVISOR_SESSION_TTL_MS);
```

Add the registry Map near the other in-memory Maps (`tasks`, `escalationTimers`, `waiters`, `pendingLaunches`):

```js
  // Advisor session recency, keyed by opencode session id. Process-lifetime
  // only, same as `tasks` and `waiters` -- a taskferry restart means every
  // session id is "unknown," which resolveAdvisorSession() treats identically
  // to "expired" rather than special-casing it. Prevents taskferry_advisor
  // from silently resuming a conversation whose prompt cache has gone cold.
  const advisorSessions = new Map();
```

Add the two helper functions near `noSuchTask` (logically grouped with other small session-adjacent helpers):

```js
  function resolveAdvisorSession(sessionId) {
    if (!sessionId) return { sessionId: undefined, reset: false, previousSessionId: undefined };
    const lastUsedAt = advisorSessions.get(sessionId);
    if (lastUsedAt != null && Date.now() - lastUsedAt <= advisorTtl) {
      return { sessionId, reset: false, previousSessionId: undefined };
    }
    return { sessionId: undefined, reset: true, previousSessionId: sessionId };
  }

  function touchAdvisorSession(sessionId) {
    if (sessionId) advisorSessions.set(sessionId, Date.now());
  }
```

Add temporary test-only hooks to the returned object (Step 5's `return` statement in Task 1 already changed `wait` to `poll`; extend it further here):

```js
  return {
    dispatch,
    cancel,
    status,
    poll,
    list,
    result,
    tail,
    summarize: summarizeTask,
    paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE },
    __resolveAdvisorSessionForTest: resolveAdvisorSession,
    __touchAdvisorSessionForTest: touchAdvisorSession,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS for all 5 new tests in `describe("advisor() session TTL resolution", ...)`.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(taskferry): add advisor session TTL registry"
```

---

### Task 3: `advisor()` function in `tasks.js`

**Files:**
- Modify: `src/tasks.js` (add `advisor()`, export it, remove the two `__*ForTest` hooks now that `advisor()` exercises the same logic through its own public behavior)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `dispatch({ prompt, directory, model, variant, sessionId })` (existing, `tasks.js:185`), `poll(taskId, { timeoutMs, tailChars })` (Task 1, renamed from `wait`), `result(taskId, { fields })` (existing, `tasks.js:761`), `resolveAdvisorSession(sessionId)` / `touchAdvisorSession(sessionId)` (Task 2).
- Produces: `async function advisor({ prompt, directory, model, variant, session_id, timeout_ms })` returning one of:
  - Running/timed-out: `{ status: "running", task_id, session_id, session_reset, previous_session_id?, note }`
  - Done: `{ status: "done", task_id, session_id, session_reset, previous_session_id?, message, tokens, cost }`
  - Crashed/cancelled: `{ status: "crashed" | "cancelled", task_id, session_id, session_reset, previous_session_id?, message, exitCode, signal, spawnError }`

  Exported from `createTaskManager()`'s return object as `advisor`.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.test.js`, replacing the temporary `describe("advisor() session TTL resolution", ...)` block from Task 2 with a merged, fuller set (the TTL-only tests from Task 2 stay conceptually but now exercise `advisor()` directly instead of the `__*ForTest` hooks):

```js
describe("advisor()", () => {
  test("requires a model", async () => {
    const mgr = makeManager();
    await assert.rejects(
      () => mgr.advisor({ prompt: "hi", directory: os.tmpdir() }),
      /error: model is required/
    );
  });

  test("dispatches with the given model/variant and resolves inline once the task finishes", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => {
        captured = args;
        return child;
      },
    });

    const advisorPromise = mgr.advisor({
      prompt: "how should I shard this counter?",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      variant: "max",
      timeout_ms: 5000,
    });

    assert.deepEqual(captured, [
      "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", "openai/gpt-5.6-sol", "--variant", "max", "--", "how should I shard this counter?",
    ]);

    // Simulate opencode writing its result log, then exiting.
    const dispatched = mgr.list().tasks[0];
    fs.writeFileSync(
      dispatched.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "Shard by key, sum on read." } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { total: 50 }, cost: 0.002 } }),
        JSON.stringify({ sessionID: "ses_new" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "done");
    assert.equal(advised.message, "Shard by key, sum on read.");
    assert.deepEqual(advised.tokens, { total: 50 });
    assert.equal(advised.cost, 0.002);
    assert.equal(advised.session_id, "ses_new");
    assert.equal(advised.session_reset, false);
    assert.equal("previous_session_id" in advised, false);
  });

  test("returns status: running with a task_id and session_id when the timeout elapses first", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });

    const advisorPromise = mgr.advisor({
      prompt: "long question",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      timeout_ms: 20,
    });
    const dispatched = mgr.list().tasks[0];
    fs.writeFileSync(dispatched.logPath, JSON.stringify({ sessionID: "ses_midrun" }));

    const advised = await advisorPromise;
    assert.equal(advised.status, "running");
    assert.equal(advised.task_id, dispatched.id);
    assert.equal(advised.session_id, "ses_midrun");
    assert.match(advised.note, /taskferry_poll or taskferry_advisor again with session_id/);
  });

  test("a fresh session_id within the TTL is passed through to dispatch (--continue --session)", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      advisorSessionTtlMs: 60000,
      spawnFn: (cmd, args) => {
        captured = args;
        return child;
      },
    });

    // First call establishes ses_live in the registry via its own result.
    const firstPromise = mgr.advisor({ prompt: "q1", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const firstTask = mgr.list().tasks[0];
    fs.writeFileSync(
      firstTask.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "answer one" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_live" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);
    const first = await firstPromise;
    assert.equal(first.session_id, "ses_live");

    // Second call resumes ses_live -- still fresh, no reset.
    const secondPromise = mgr.advisor({
      prompt: "q2 follow-up",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      session_id: "ses_live",
    });
    assert.equal(captured.includes("--continue"), true);
    assert.equal(captured[captured.indexOf("--session") + 1], "ses_live");

    const secondTask = mgr.list().tasks[0];
    fs.writeFileSync(
      secondTask.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m2", text: "answer two" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m2", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_live" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);
    const second = await secondPromise;
    assert.equal(second.session_reset, false);
    assert.equal(second.session_id, "ses_live");
  });

  test("an expired session_id starts fresh and reports session_reset", async () => {
    const child = fakeChild();
    let captured = null;
    const mgr = makeManager({
      advisorSessionTtlMs: 10,
      spawnFn: (cmd, args) => {
        captured = args;
        return child;
      },
    });

    const advisorPromise = mgr.advisor({
      prompt: "resuming after a nap",
      directory: os.tmpdir(),
      model: "openai/gpt-5.6-sol",
      session_id: "ses_long_gone",
    });

    assert.equal(captured.includes("--continue"), false);

    const dispatched = mgr.list().tasks[0];
    fs.writeFileSync(
      dispatched.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "starting fresh" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_brand_new" }),
      ].join("\n")
    );
    child.emit("exit", 0, null);

    const advised = await advisorPromise;
    assert.equal(advised.session_reset, true);
    assert.equal(advised.previous_session_id, "ses_long_gone");
    assert.equal(advised.session_id, "ses_brand_new");
  });

  test("a crashed advisor task surfaces exitCode/spawnError, not a thrown error", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });

    const advisorPromise = mgr.advisor({ prompt: "hi", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    child.emit("exit", 1, null);

    const advised = await advisorPromise;
    assert.equal(advised.status, "crashed");
    assert.equal(advised.exitCode, 1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `mgr.advisor is not a function`.

- [ ] **Step 3: Implement `advisor()` in `src/tasks.js`**

Remove the two temporary hooks added in Task 2 (`__resolveAdvisorSessionForTest`, `__touchAdvisorSessionForTest`) from the return object — `advisor()`'s own tests now cover that logic end-to-end. Add the `advisor` function itself near `poll`, and add it (not the two removed hooks) to the return object:

```js
  async function advisor({ prompt, directory, model, variant, session_id, timeout_ms } = {}) {
    ensureStateLoaded();
    if (!model || typeof model !== "string") {
      throw new Error("error: model is required\nhelp: taskferry_advisor requires a provider/model string, e.g. \"openai/gpt-5.6-sol\"");
    }
    const resolved = resolveAdvisorSession(session_id);
    const dispatched = dispatch({ prompt, directory, model, variant, sessionId: resolved.sessionId });
    const settled = await poll(dispatched.id, timeout_ms != null ? { timeoutMs: timeout_ms } : {});

    const resetFields = resolved.reset ? { previous_session_id: resolved.previousSessionId } : {};

    if (settled.status === "running" || settled.status === "queued") {
      if (settled.sessionId) touchAdvisorSession(settled.sessionId);
      return {
        status: "running",
        task_id: dispatched.id,
        session_id: settled.sessionId ?? null,
        session_reset: resolved.reset,
        ...resetFields,
        note: `still running — call taskferry_poll or taskferry_advisor again with session_id "${settled.sessionId ?? dispatched.id}" to continue`,
      };
    }

    const detail = result(dispatched.id, { fields: ["message", "sessionId", "tokens", "cost", "exitCode", "signal", "spawnError"] });
    if (detail.sessionId) touchAdvisorSession(detail.sessionId);

    return {
      status: detail.status,
      task_id: dispatched.id,
      session_id: detail.sessionId ?? null,
      session_reset: resolved.reset,
      ...resetFields,
      message: detail.message,
      ...(detail.status === "done" ? { tokens: detail.tokens, cost: detail.cost } : {}),
      ...(detail.status !== "done" ? { exitCode: detail.exitCode, signal: detail.signal, spawnError: detail.spawnError } : {}),
    };
  }
```

Update the return statement to:

```js
  return {
    dispatch,
    cancel,
    status,
    poll,
    list,
    result,
    tail,
    summarize: summarizeTask,
    advisor,
    paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE },
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS for all tests in `describe("advisor()", ...)`.

- [ ] **Step 5: Run the full unit suite to confirm nothing else broke**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(taskferry): add advisor() — blocking dispatch+poll+result with session TTL"
```

---

### Task 4: `taskferry_advisor` MCP tool in `server.js`

**Files:**
- Modify: `src/server.js` (add tool registration)
- Modify: `src/server.test.js` (registration assertion)
- Modify: `README.md` (new tool section)
- Test: `src/server.test.js`

**Interfaces:**
- Consumes: `tasks.advisor({ prompt, directory, model, variant, session_id, timeout_ms })` (Task 3).
- Produces: MCP tool `taskferry_advisor(prompt, directory, model, variant?, session_id?, timeout_ms?)`, TOON-encoded response matching `advisor()`'s return shape.

- [ ] **Step 1: Write the failing test**

Add to `src/server.test.js`, inside the existing `test("registers summary and tail tools with schemas and returns projected TOON data", ...)` (extend the existing single integration test rather than spinning up a second full server-process test, consistent with how that test already checks multiple tools in one client session):

```js
    assert.equal(byName.has("taskferry_advisor"), true);
    assert.equal(byName.get("taskferry_advisor").inputSchema.properties.model.type, "string");
    assert.equal(byName.get("taskferry_advisor").inputSchema.required.includes("model"), true);
    assert.equal(byName.get("taskferry_advisor").inputSchema.required.includes("prompt"), true);
    assert.equal(byName.get("taskferry_advisor").inputSchema.required.includes("directory"), true);
```

(Insert this block right after the existing `assert.equal(byName.get("taskferry_result")...)` line, before the `taskferry_tail` call.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/server.test.js`
Expected: FAIL — `byName.has("taskferry_advisor")` is `false`, or `byName.get("taskferry_advisor")` is `undefined` (TypeError reading `.inputSchema`).

- [ ] **Step 3: Register the tool in `src/server.js`**

Add after the `taskferry_poll` registration (renamed in Task 1) and before `taskferry_status`:

```js
server.registerTool(
  "taskferry_advisor",
  {
    title: "Ask a bigger model for help, blocking",
    description:
      "Consult a different model mid-task and block until it answers — the same dispatch+poll+result machinery as taskferry_dispatch, glued into one call so the answer comes back inline instead of requiring a separate poll. Use this the way a weaker model consults a stronger one for planning or hard debugging help, not for open-ended background work (use taskferry_dispatch for that). Capped at 45s like taskferry_poll; if it times out, the response includes status: \"running\" plus a task_id and session_id — call taskferry_poll or taskferry_advisor again with that session_id to continue. Pass session_id to continue a prior advisor exchange; if that session has gone stale (idle past the configured TTL) or is unrecognized, a fresh session starts automatically and the response's session_reset is true with previous_session_id set, rather than erroring — never keep piling onto a conversation that's lost cache recency.",
    inputSchema: {
      prompt: z.string().describe("Self-contained question/context for the advisor — taskferry has no access to the caller's own conversation, so include whatever context the advisor needs."),
      directory: z
        .string()
        .describe("Absolute path to the working directory opencode should run in (--dir)."),
      model: z
        .string()
        .describe("provider/model string for the advisor, e.g. 'openai/gpt-5.6-sol' or 'zai/glm-5.2'. Required — unlike taskferry_dispatch, there is no default advisor model."),
      variant: z
        .string()
        .optional()
        .describe("Model variant/reasoning effort (e.g. high, max, minimal) for the advisor model."),
      session_id: z
        .string()
        .optional()
        .describe("Continue a prior advisor exchange. Silently starts a fresh session instead of erroring if this session has expired or is unrecognized — check session_reset in the response."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds to block. Capped at 45000 regardless of what's passed. Defaults to 45000."),
    },
  },
  async ({ prompt, directory, model, variant, session_id, timeout_ms }) => {
    const a = await tasks.advisor({
      prompt,
      directory,
      model,
      variant,
      session_id,
      ...(timeout_ms != null ? { timeout_ms } : {}),
    });
    return toon(a);
  }
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/server.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Add the README section**

Insert a new `### \`taskferry_advisor(...)\`` section in `README.md` right after the `taskferry_poll` section (which ends around line 81, before `### \`taskferry_cancel\``):

```markdown
### `taskferry_advisor(prompt, directory, model, variant?, session_id?, timeout_ms?)`

A blocking "ask a bigger model" call: dispatches like `taskferry_dispatch`,
then polls internally and returns the answer inline instead of requiring a
separate `taskferry_poll` round-trip. Use it the way a weaker model consults
a stronger one for planning or hard-debugging help mid-task — not for
open-ended background work (use `taskferry_dispatch` for that).

- `model` is required, with no default (unlike `taskferry_dispatch`) — the
  caller picks the advisor.
- Capped at 45000ms like `taskferry_poll`. If it times out before the
  advisor answers, the response is `status: "running"` plus `task_id` and
  `session_id` — call `taskferry_poll` or `taskferry_advisor` again (with
  that `session_id`) to continue.
- `session_id` resumes a prior advisor exchange. If that session has gone
  idle past `TASKFERRY_ADVISOR_SESSION_TTL_MS` (default 30 minutes) or is
  unrecognized (e.g. a typo, or from before a server restart), a fresh
  session starts automatically instead of erroring — the response's
  `session_reset` is `true` and `previous_session_id` holds the id that
  wasn't reused. This avoids ever silently resuming a conversation whose
  prompt cache has gone cold.
```

- [ ] **Step 7: Commit**

```bash
git add src/server.js src/server.test.js README.md
git commit -m "feat(taskferry): register taskferry_advisor MCP tool"
```

---

## Post-implementation notes

- `src/poll-smoke-test.js` and a new manual advisor smoke check are integration tests that spawn real `opencode` processes with real tokens/cost — they are not run automatically as part of this plan's steps (consistent with how `test:integration` already isn't part of `npm test`). After merging, consider running `npm run test:integration` by hand once to confirm the renamed poll smoke test still passes end-to-end; a dedicated `advisor-smoke-test.js` was intentionally left out of scope here (not requested, and the unit tests in Task 3 already exercise the real composition logic against a fake `spawnFn`).
