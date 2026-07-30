# Caller-Env Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rip out taskferry's key-slot provider-credential system (`TASKFERRY_KEY_SLOTS`, `TASKFERRY_PROVIDER_KEY_ENV`, `TASKFERRY_SUMMARY_KEY_SLOT`, `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`, `--key-slot`) and replace it with a simpler model: a live CLI command (`dispatch`, `advisor`, `summary` in report mode) forwards its own process environment to the daemon over the existing socket, which unions it on top of its own ambient environment — caller wins, except for a small fixed set of daemon-controlled plumbing vars and an operator-configured denylist — before spawning a worker or summary child. No more slot registries, no more "restart the daemon after exporting a new key."

**Architecture:** `src/commands.js`'s `runCommand()` already receives the caller's `process.env` as its `env` parameter; it starts forwarding that object as a new `env` RPC param on `task.dispatch`/`task.advisor`/`task.summary`. `src/protocol.js` validates `env` as an optional plain object of string values. `src/daemon.js`'s `invoke()` threads `params.env` through to the three affected manager calls (`task.dispatch` already forwards its whole `params` object as-is). Inside `src/tasks.js`, a single `sanitizedEnvironment(env)` function builds the final child environment in a fixed order — daemon's own ambient env, then the caller's env overlaid (minus a hardcoded excluded set of daemon-controlled plumbing vars), then an operator-configured `envDenylist` stripped last — and `dispatchEnvironment(env)`/`summaryEnvironment(env)` each add their own final, non-overridable step on top (`TASKFERRY_CHILD=1`; `summaryEnvironment` also strips the three `OPENCODE_CONFIG*` vars). A dispatch's `env` is captured once at `dispatch()`-call time and stored on its queued `DispatchLaunch`, not re-read at actual spawn time — the *caller's* portion of the environment reflects the moment the request was made, while the *daemon's own* ambient portion (`sanitizedEnvironment`'s `base`) is still read fresh at spawn time, exactly as today.

**Tech Stack:** Node.js (`node:test` for all test files, no framework), Unix-socket JSON-RPC daemon protocol.

## Global Constraints

- The approved spec's §6 (`src/executor.js:212`'s `.pi` → `.pi/agent` fallback fix) already shipped independently in PR #198 (`fix(executor): correct pi's real auth dir...`) — verified via `git log`/reading `src/executor.js` and `src/executor.test.js` directly. It is **not** a task in this plan; do not re-implement it.
- Every touched test file uses `node --test` conventions already established in this repo (`describe`/`test` from `node:test`, `assert/strict`) — no new test framework or helper library.
- No deprecation period and no opt-out flag for caller-env forwarding — this is a hard cutover, matching the approved spec's explicit non-goals.
- `docs/sourcemap.md` must be updated in the same set of changes per this repo's `CLAUDE.md` ("Keep the sourcemap up to date") — folded into Task 7.
- After any edit to `skills/using-taskferry/SKILL.md`, run `npm run skill:generate` and verify with `node scripts/generate-skill.js --check` before considering Task 7 done — the two `integrations/*/skills/using-taskferry/SKILL.md` copies are committed, not build output.
- Run `npm run test:unit` after every task; it must stay green before moving to the next task.

---

## Task 1: `envDenylist` config surface (additive, no behavior change yet)

**Files:**
- Modify: `src/tasks.js` (add `parseEnvDenylist`, add `envDenylist` option to `createTaskManager`)
- Modify: `src/config.js` (add `envDenylist` to `CONFIG_FIELD_TYPES`)
- Test: `src/tasks.test.js`, `src/config.test.js`

**Interfaces:**
- Produces: `export function parseEnvDenylist(spec: string|undefined): string[]` in `src/tasks.js` — same comma-separated flat-string grammar as the existing `parseAllowedDirs`. `createTaskManager({ envDenylist })` option, type `string[]`, default `parseEnvDenylist(process.env.TASKFERRY_ENV_DENYLIST ?? config.envDenylist)`. Not yet consumed anywhere (Task 2 wires it into the env-build pipeline) — this task only makes it constructible and configurable without erroring.

- [ ] **Step 1: Write the failing tests**

In `src/tasks.test.js`, add near the top (after the existing helper functions, before the first `describe`):

```js
describe("parseEnvDenylist()", () => {
  test("returns an empty array for an empty or undefined spec", () => {
    assert.deepEqual(parseEnvDenylist(undefined), []);
    assert.deepEqual(parseEnvDenylist(""), []);
  });

  test("splits, trims, and drops empty entries", () => {
    assert.deepEqual(parseEnvDenylist("FOO, BAR ,, BAZ"), ["FOO", "BAR", "BAZ"]);
  });
});
```

Add `parseEnvDenylist` to the existing `import { createTaskManager, isOutsideDirectory, DEFAULT_SUMMARY_MODEL, bucketFor } from "./tasks.js";` line at the top of the file.

In `src/config.test.js`, add after the existing `"rejects a wrong-typed allowedDirs value"` test:

```js
  test("accepts a valid envDenylist value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ envDenylist: "PI_CODING_AGENT_DIR,SOME_OTHER_VAR" }));
    assert.deepEqual(loadConfig({ configPath }), { envDenylist: "PI_CODING_AGENT_DIR,SOME_OTHER_VAR" });
  });

  test("rejects a wrong-typed envDenylist value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ envDenylist: ["SOME_VAR"] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "envDenylist".*must be a string.*\nhelp:/s);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.test.js src/config.test.js`
Expected: FAIL — `parseEnvDenylist is not defined` (tasks.test.js) and `unrecognized config key "envDenylist"` (config.test.js).

- [ ] **Step 3: Implement `parseEnvDenylist` and wire the config field**

In `src/tasks.js`, add directly after the existing `parseAllowedDirs` function (around line 379, right after its closing brace):

```js
/**
 * @param {string|undefined} spec
 * @returns {string[]}
 */
export function parseEnvDenylist(spec) {
  if (!spec) return [];
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
```

In `createTaskManager`'s JSDoc block, add after the existing `@param {string[]} [options.allowedDirs]` line:

```js
 * @param {string[]} [options.envDenylist] - env var names stripped from every spawned child's
 *   environment, applied last (after the caller-env union), regardless of whether the value
 *   came from the daemon's own ambient environment or the caller.
```

In the destructured options object, add directly after the existing `allowedDirs = parseAllowedDirs(...)` line:

```js
  envDenylist = parseEnvDenylist(process.env.TASKFERRY_ENV_DENYLIST ?? /** @type {string|undefined} */ (config.envDenylist)),
```

In `src/config.js`, add `envDenylist: "string",` to `CONFIG_FIELD_TYPES` directly after the existing `allowedDirs: "string",` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/tasks.test.js src/config.test.js`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS (no regressions — `envDenylist` isn't consumed yet, so nothing else changes behavior)

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js src/config.js src/tasks.test.js src/config.test.js
git commit -m "feat(config): add envDenylist config field and TASKFERRY_ENV_DENYLIST parsing"
```

---

## Task 2: Caller-env union pipeline + full key-slot rip-out (`src/tasks.js`, `src/config.js`)

This is the core of the feature. It replaces `environmentWithoutKeySlotSources()`/`dispatchEnvironment(keyEnvValue)`/`summaryEnvironment()` with `sanitizedEnvironment(env)`/`dispatchEnvironment(env)`/`summaryEnvironment(env)`, threads a caller-supplied `env` through `dispatch()`, `advisor()`, and `summarizeTask()`, and deletes every remaining key-slot code path (`parseKeySlots`, `resolveKeySlot`, `providerKeyEnvNameFor`, the key-slot `createTaskManager` options, the `keySlot` field on `Task`/`TaskSummary`/`ResultDetail`, and the "no credentials available" preflight, which has no replacement).

**Files:**
- Modify: `src/tasks.js`
- Modify: `src/config.js`
- Test: `src/tasks.test.js`, `src/config.test.js`

**Interfaces:**
- Consumes: `envDenylist: string[]` from Task 1's `createTaskManager` option.
- Produces: `dispatch({ ..., env })`, `advisor({ ..., env })`, `summarizeTask(taskId, { ..., env })`/`summarizeRequest(taskId, { ..., env })` all accept an optional `env: NodeJS.ProcessEnv` parameter (default: unset, meaning ambient-only). `DispatchLaunch.env` and `SummaryLaunch.env` are both `NodeJS.ProcessEnv` (the frozen-at-request-time environment), consumed by `startTask()`. These are the exact names Task 3 (protocol.js) and Task 4 (daemon.js) will thread the wire-level `env` param into.

- [ ] **Step 1: Write the failing tests**

In `src/tasks.test.js`, delete the entire `describe("key slots (summary tasks)", ...)` block (currently lines 3811-3875), the entire `describe("key slots (dispatch)", ...)` block (currently lines 3877-3986), and the entire `describe("credential preflight for the dispatched model's own provider (issue #63)", ...)` block (currently lines 3988-4037). Also update the `makeManager()` helper's parameter list — remove `keySlotsSpec, providerKeyEnvName, summaryKeySlot, summaryProviderKeyEnvName` from its destructured options and remove the four corresponding `...(x != null ? { x } : {})` spreads in its `createTaskManager({...})` call, and add `envDenylistSpec` in their place (destructured param plus `...(envDenylistSpec != null ? { envDenylist: parseEnvDenylist(envDenylistSpec) } : {})` in the `createTaskManager` call — import `parseEnvDenylist` alongside the other named imports from `./tasks.js`).

Also update the one surviving reference to the old field: in the `"a running child with no parseable log event past the deadline is stopped and marked crashed with failureReason"` test (currently around line 1573), change:

```js
    assert.deepEqual(mgr.result(dispatched.id, { fields: ["failureReason", "keySlot"] }), {
      taskId: dispatched.id,
      status: "crashed",
      failureReason: "no_output_timeout",
      keySlot: null,
    });
```

to:

```js
    assert.deepEqual(mgr.result(dispatched.id, { fields: ["failureReason"] }), {
      taskId: dispatched.id,
      status: "crashed",
      failureReason: "no_output_timeout",
    });
```

Now add the new caller-env test suite. Insert it where the deleted `describe` blocks were (end of file, before `describe("startTask() writes stdout through executor.normalizeLogEvent ...")`):

```js
describe("caller-env union (sanitizedEnvironment)", () => {
  test("a caller-supplied env value overlays the daemon's own ambient environment", (t) => {
    delete process.env.AXI_TEST_CALLER_VAR;
    t.after(() => delete process.env.AXI_TEST_CALLER_VAR);
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_CALLER_VAR: "from-caller" } });

    assert.equal(capturedOpts.env.AXI_TEST_CALLER_VAR, "from-caller");
  });

  test("caller env cannot override the fixed excluded set of daemon-controlled vars", (t) => {
    const excluded = ["PATH", "HOME", "TASKFERRY_STATE_DIR", "TASKFERRY_RUNTIME_DIR", "TASKFERRY_CACHE_DIR", "TASKFERRY_SOCKET_PATH"];
    for (const name of excluded) process.env[name] = `real-${name}`;
    t.after(() => { for (const name of excluded) delete process.env[name]; });
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

    const maliciousEnv = Object.fromEntries(excluded.map((name) => [name, `malicious-${name}`]));
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: maliciousEnv });

    for (const name of excluded) {
      assert.equal(capturedOpts.env[name], `real-${name}`, `${name} must keep the daemon's own ambient value`);
    }
  });

  test("a denylisted name is stripped even when the caller's env explicitly sets it", (t) => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "AXI_TEST_DENIED_VAR",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), env: { AXI_TEST_DENIED_VAR: "leaked-value" } });

    assert.equal("AXI_TEST_DENIED_VAR" in capturedOpts.env, false);
  });

  test("TASKFERRY_CHILD survives even when denylisted", (t) => {
    let capturedOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
      envDenylistSpec: "TASKFERRY_CHILD",
    });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.TASKFERRY_CHILD, "1");
  });

  test("omitting env behaves as ambient-only, same as before caller-env forwarding existed", (t) => {
    process.env.AXI_TEST_AMBIENT_ONLY = "ambient-value";
    t.after(() => delete process.env.AXI_TEST_AMBIENT_ONLY);
    let capturedOpts = null;
    const mgr = makeManager({ spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); } });

    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    assert.equal(capturedOpts.env.AXI_TEST_AMBIENT_ONLY, "ambient-value");
  });

  test("summaryEnvironment strips OPENCODE_CONFIG* even when the caller's env explicitly sets one", async (t) => {
    let capturedEnv = null;
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "src1", status: "done", logPath: path.join(logDir, "src1.ndjson") }) }],
      logs: { "src1.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "did the thing" } }) + "\n" },
      spawnFn: (cmd, args, opts) => { capturedEnv = opts.env; return fakeChild(); },
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    });

    await mgr.summarize("src1", { env: { OPENCODE_CONFIG: "malicious-config-path" } });

    assert.equal("OPENCODE_CONFIG" in capturedEnv, false);
  });

  test("a queued dispatch's stored env is the one captured at dispatch() time, not re-read later", async (t) => {
    delete process.env.AXI_TEST_LATE_AMBIENT;
    t.after(() => delete process.env.AXI_TEST_LATE_AMBIENT);
    const occupyingChild = fakeChild(9001);
    /** @type {any} */
    let secondCapturedOpts = null;
    let spawnCount = 0;
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      spawnFn: (cmd, args, opts) => {
        spawnCount++;
        if (spawnCount === 1) return occupyingChild;
        secondCapturedOpts = opts;
        return fakeChild(9002);
      },
    });

    // Occupy the only concurrency slot.
    mgr.dispatch({ prompt: "occupying task", directory: os.tmpdir() });
    // This one queues behind the slot, with its own env captured now.
    mgr.dispatch({ prompt: "queued task", directory: os.tmpdir(), env: { AXI_TEST_MARKER: "captured-at-dispatch-time" } });

    // Simulate ambient env changing while the second dispatch sits queued.
    process.env.AXI_TEST_LATE_AMBIENT = "set-after-queuing";

    // Release the first task so the queued one actually spawns.
    occupyingChild.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(secondCapturedOpts, "the queued task should have spawned");
    assert.equal(secondCapturedOpts.env.AXI_TEST_MARKER, "captured-at-dispatch-time", "caller env is frozen at dispatch() time");
    assert.equal(secondCapturedOpts.env.AXI_TEST_LATE_AMBIENT, "set-after-queuing", "the daemon's own ambient env is still read fresh at spawn time");
  });
});
```

In `src/config.test.js`, delete the `"keySlots reuses parseKeySlots's validation and error text"` and `"accepts a valid keySlots value"` tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.test.js src/config.test.js`
Expected: FAIL — `dispatch()` doesn't accept `env`, `summarize()`'s options don't thread `env` to the spawned child, `envDenylistSpec` isn't a recognized `makeManager` option yet (it is from Task 1's `envDenylist`, but the test helper needs updating — see Step 3), and the deleted key-slot tests are gone so no failures from those.

- [ ] **Step 3: Implement the caller-env union pipeline and remove the key-slot system**

In `src/tasks.js`:

1. Remove `@property {string|null} [keySlot]` from the `Task` typedef (currently line 49), the `TaskSummary` typedef (currently line 76), and the `ResultDetail` typedef (currently line 135).

2. Change the `DispatchLaunch` typedef's `@property {string|null} [keyEnvValue]` to `@property {NodeJS.ProcessEnv} [env]`. Change the `SummaryLaunch` typedef's `@property {string|null} [keyEnvValue]` line — delete it outright (that typedef already has `@property {NodeJS.ProcessEnv} env` a few lines above it; `keyEnvValue` there was always dead/unused).

3. Delete the `export function parseKeySlots(spec) {...}` function entirely (currently lines 352-369 — grep for the function name; exact line numbers drift as `main` moves).

4. In `createTaskManager`'s JSDoc block, remove the `@param {string} [options.keySlotsSpec]`, `@param {string|null} [options.providerKeyEnvName]`, `@param {string|null} [options.summaryKeySlot]`, `@param {string|null} [options.summaryProviderKeyEnvName]` lines.

5. In the destructured options object, remove:
```js
  keySlotsSpec = process.env.TASKFERRY_KEY_SLOTS ?? /** @type {string|undefined} */ (config.keySlots),
  providerKeyEnvName = process.env.TASKFERRY_PROVIDER_KEY_ENV || /** @type {string|undefined} */ (config.providerKeyEnv) || null,
  summaryKeySlot = process.env.TASKFERRY_SUMMARY_KEY_SLOT || /** @type {string|undefined} */ (config.summaryKeySlot) || null,
  summaryProviderKeyEnvName = process.env.TASKFERRY_SUMMARY_PROVIDER_KEY_ENV || /** @type {string|undefined} */ (config.summaryProviderKeyEnv) || null,
```

6. Remove `const keySlots = parseKeySlots(keySlotsSpec);` (currently line 557).

7. Replace `environmentWithoutKeySlotSources()`/`dispatchEnvironment(keyEnvValue)`/`summaryEnvironment()` (currently lines 580-634 — grep for the function names; exact line numbers drift as `main` moves) entirely with:

```js
  const CALLER_ENV_EXCLUDED = ["PATH", "HOME", "TASKFERRY_STATE_DIR", "TASKFERRY_RUNTIME_DIR", "TASKFERRY_CACHE_DIR", "TASKFERRY_SOCKET_PATH"];

  /**
   * Builds the final base environment for a spawned child: the daemon's own
   * ambient environment (read fresh at call time), overlaid with the
   * caller-supplied `env` (caller wins, except for CALLER_ENV_EXCLUDED --
   * daemon-controlled plumbing resolved once at the daemon's own startup),
   * with `envDenylist` stripped last regardless of which side the value
   * came from.
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {NodeJS.ProcessEnv}
   */
  function sanitizedEnvironment(env = {}) {
    const base = { ...process.env };
    const overlay = { ...env };
    for (const name of CALLER_ENV_EXCLUDED) delete overlay[name];
    const merged = { ...base, ...overlay };
    for (const name of envDenylist) delete merged[name];
    return merged;
  }

  /** @param {NodeJS.ProcessEnv} [env] */
  function dispatchEnvironment(env) {
    const result = sanitizedEnvironment(env);
    result.TASKFERRY_CHILD = "1";
    return result;
  }

  /** @param {NodeJS.ProcessEnv} [env] */
  function summaryEnvironment(env) {
    const result = sanitizedEnvironment(env);
    delete result.OPENCODE_CONFIG;
    delete result.OPENCODE_CONFIG_DIR;
    delete result.OPENCODE_CONFIG_CONTENT;
    result.TASKFERRY_CHILD = "1";
    return result;
  }
```

8. Delete `providerKeyEnvNameFor(model)` (currently lines 935-941) and `resolveKeySlot(keySlot)` (currently lines 946-960) entirely — grep for the function names; exact line numbers drift as `main` moves.

9. In `dispatch()`'s JSDoc, remove `@param {string|null} [params.keySlot]` and add `@param {NodeJS.ProcessEnv} [params.env]`.

10. In `dispatch()`'s destructured parameters (currently `function dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal = false, finalMarker = null, originSessionId, noSandbox = false, allowedDirs: dispatchAllowedDirs, executor: executorName }) {`), remove `keySlot` and add `env`:
```js
  function dispatch({ prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, allowedDirs: dispatchAllowedDirs, executor: executorName, env }) {
```

11. Remove `const resolvedKeySlot = resolveKeySlot(keySlot);` (currently line 1041).

12. Delete the entire credential preflight block (currently lines 1054-1065):
```js
    // Fail fast instead of letting a generic, opaque crash surface from deep
    // inside the spawned opencode child (issue #63). Only applies when this
    // dispatch's own provider is the one TASKFERRY_PROVIDER_KEY_ENV targets --
    // every other provider's credentials are opencode's own responsibility
    // (auth.json, ambient env) and outside taskferry's knowledge.
    if (providerKeyEnvName && providerKeyEnvNameFor(resolvedModel) === providerKeyEnvName) {
      const keyValue = resolvedKeySlot.keyEnvValue || process.env[providerKeyEnvName];
      if (!keyValue) {
        const provider = resolvedModel.slice(0, resolvedModel.indexOf("/"));
        throw new Error(`error: no credentials available for ${provider} (${providerKeyEnvName} is not set)\nhelp: export ${providerKeyEnvName} in the daemon's environment (then restart the daemon) or pass a key_slot that resolves to a value`);
      }
    }
```

13. In the `task` object literal inside `dispatch()`, remove the `keySlot: resolvedKeySlot.keySlot,` line.

14. In the `pendingLaunches.set(id, {...})` call inside `dispatch()`, replace `keyEnvValue: resolvedKeySlot.keyEnvValue` with `env`:
```js
    pendingLaunches.set(id, { prompt, directory: normalizedDirectory, model: resolvedModel, variant: task.variant, sessionId, env, noSandbox: noSandbox === true, allowedDirs: dispatchAllowedDirs, executor });
```

15. In `summarize(task)` (the `TaskSummary`-building function, not `summarizeTask`), remove `keySlot` from the destructured `task` fields and remove the `keySlot: keySlot ?? null,` line from its return object.

16. In `summarizeTask(taskId, options = {})`'s JSDoc, add `env?: NodeJS.ProcessEnv` to the options type. In its destructuring, add `env` alongside the existing options:
```js
    const { maxWords = 200, allowPromptFallback = false, previousActivity = null, respectConcurrencyReserve = false, env } = options;
```
(keep the existing `const { summarySessionId, lastSummarizedWatermark } = options;` line unchanged, just below it.)

17. In `summarizeTask()`, change `const env = summaryEnvironment();` (currently line 1438) to `const resolvedEnv = summaryEnvironment(env);` and update the one use immediately below it (`await summaryModelAvailable(activitySummaryModel, env);`) to use `resolvedEnv`. In the `pendingLaunches.set(id, { kind: "summary", ... env, ... })` call further down, change the bare `env,` to `env: resolvedEnv,` (this avoids a naming collision between the caller-supplied `env` parameter and the resolved spawn environment).

18. In `advisor({ prompt, directory, model, variant, sessionId, timeoutMs, executor } = {})`'s destructured parameters, add `env`:
```js
  async function advisor({ prompt, directory, model, variant, sessionId, timeoutMs, executor, env } = {}) {
```
and in its internal `dispatch({...})` call, add `env`:
```js
      dispatched = dispatch({ prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), model, variant, sessionId: resolved.sessionId, executor, env });
```

19. In `startTask()`, change `let spawnEnv = isSummary ? summaryLaunch.env : dispatchEnvironment(dispatchLaunch.keyEnvValue);` to:
```js
      let spawnEnv = isSummary ? summaryLaunch.env : dispatchEnvironment(dispatchLaunch.env);
```

20. In `result(taskId, ...)`, remove the `keySlot: task.keySlot ?? null,` line from the object passed to `projectResult(...)`.

In `src/config.js`:

21. Remove the `import { parseKeySlots } from "./tasks.js";` line.
22. Remove `keySlots: "string",`, `providerKeyEnv: "string",`, `summaryKeySlot: "string",`, `summaryProviderKeyEnv: "string",` from `CONFIG_FIELD_TYPES`.
23. Remove the `if (parsed.keySlots !== undefined) parseKeySlots(parsed.keySlots);` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/tasks.test.js src/config.test.js`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS — `src/protocol.js` still validates the (now-removed-from-`dispatch()`) `keySlot` param and still lists it in `RESULT_FIELDS`, and `src/args.js`/`src/commands.js` still reference `keySlot`, so those existing tests must still pass unchanged at this point (this task only touches `tasks.js`/`config.js`; Tasks 3, 5, and 6 catch up the rest of the stack). If any `protocol.js`/`args.js`/`commands.js` test now fails because it round-trips through `dispatch()` and asserts on the removed `keySlot` result field, that's expected churn resolved by Task 3/5/6 — confirm the *only* new failures are exactly those and no others, then proceed (do not fix them here).

- [ ] **Step 6: Commit**

```bash
git add src/tasks.js src/config.js src/tasks.test.js src/config.test.js
git commit -m "feat(tasks): replace key-slot system with caller-env union forwarding"
```

---

## Task 3: `src/protocol.js` — `env` param validation, drop `keySlot`

**Files:**
- Modify: `src/protocol.js`
- Test: `src/protocol.test.js`

**Interfaces:**
- Consumes: nothing from Task 2 directly (protocol.js has no import from tasks.js for this).
- Produces: `task.dispatch`, `task.advisor`, `task.summary` all accept an optional `env` param, validated as `isObject(value) && Object.values(value).every((entry) => typeof entry === "string")`. `task.dispatch` no longer accepts `keySlot`. `RESULT_FIELDS` no longer includes `"keySlot"`.

- [ ] **Step 1: Write the failing tests**

In `src/protocol.test.js`, add after the existing `"task.advisor rejects an invalid executor param"` test:

```js
  test("task.dispatch accepts an optional env object of string values", () => {
    const parsed = parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      env: { FOO: "bar", EMPTY: "" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar", EMPTY: "" });
  });

  test("task.dispatch rejects an env value with a non-string entry", () => {
    assert.throws(
      () => parseRequestLine(request("task.dispatch", {
        prompt: "hi",
        directory: "/tmp/project",
        env: { FOO: 42 },
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.dispatch no longer accepts keySlot", () => {
    assert.throws(
      () => parseRequestLine(request("task.dispatch", {
        prompt: "hi",
        directory: "/tmp/project",
        keySlot: "primary",
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.advisor accepts an optional env object", () => {
    const parsed = parseRequestLine(request("task.advisor", {
      prompt: "hi",
      directory: "/tmp/project",
      model: "m",
      env: { FOO: "bar" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar" });
  });

  test("task.summary accepts an optional env object", () => {
    const parsed = parseRequestLine(request("task.summary", {
      taskId: "oc_123",
      env: { FOO: "bar" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/protocol.test.js`
Expected: FAIL — `env` is rejected as an unrecognized param (`hasOnly` doesn't list it), and `keySlot` is still accepted.

- [ ] **Step 3: Implement**

In `src/protocol.js`'s `validParams()`:

1. `task.dispatch`: remove `"keySlot"` from the `hasOnly` array and remove the `&& optional(params.keySlot, isNonEmptyString)` line. Add `"env"` to the `hasOnly` array and add a new validation line:
```js
        && optional(params.env, (value) => isObject(value) && Object.values(value).every((entry) => typeof entry === "string"))
```

2. `task.advisor`: add `"env"` to its `hasOnly` array and add the same `optional(params.env, ...)` line as above.

3. `task.summary`: add `"env"` to its `hasOnly` array and add the same `optional(params.env, ...)` line as above.

4. Remove `"keySlot",` from the `RESULT_FIELDS` set.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/protocol.test.js`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, aside from any `commands.test.js`/`args.test.js` failures already expected from Task 2's step 5 note (still pending Tasks 5/6).

- [ ] **Step 6: Commit**

```bash
git add src/protocol.js src/protocol.test.js
git commit -m "feat(protocol): validate an optional env param, drop keySlot"
```

---

## Task 4: `src/daemon.js` — forward `params.env` on `task.summary`/`task.advisor`

**Files:**
- Modify: `src/daemon.js`
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: `params.env` (validated by Task 3's protocol.js), forwards it as the `env` field on the options object passed to `manager.summarize`/`manager.advisor` — matching the parameter name Task 2's `tasks.js` expects.
- Produces: no new exports; `invoke()`'s `task.summary` and `task.advisor` branches now pass `env` through. `task.dispatch` already forwards the whole `params` object (including `env`) with no change needed.

- [ ] **Step 1: Write the failing tests**

In `src/daemon.test.js`, add after the existing `"forwards an executor param on task.advisor to manager.advisor({ executor })"` test:

```js
  test("forwards an env param on task.summary to manager.summarize", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("summarize", "task.summary", { taskId: "t1", env: { FOO: "bar" } });

    const lastSummarizeCall = fake.calls.filter((call) => call[0] === "summarize").at(-1);
    assert.deepEqual(lastSummarizeCall, ["summarize", "t1", { env: { FOO: "bar" } }]);
  });

  test("forwards an env param on task.advisor to manager.advisor({ env })", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    await peer.request("advise", "task.advisor", { prompt: "hi", directory: paths.root, model: "m", env: { FOO: "bar" } });

    const lastAdvisorCall = fake.calls.filter((call) => call[0] === "advisor").at(-1);
    assert.deepEqual(lastAdvisorCall, ["advisor", { prompt: "hi", directory: paths.root, model: "m", env: { FOO: "bar" } }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/daemon.test.js`
Expected: FAIL — `manager.summarize`/`manager.advisor` are called without `env` in their options.

- [ ] **Step 3: Implement**

In `src/daemon.js`'s `invoke()`:

1. `task.summary` case, add `env` passthrough:
```js
    case "task.summary":
      return manager.summarize(params.taskId, {
        ...(params.maxWords === undefined ? {} : { maxWords: params.maxWords }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
        ...(params.env === undefined ? {} : { env: params.env }),
      });
```

2. `task.advisor` case, add `env` passthrough:
```js
    case "task.advisor":
      return manager.advisor({
        prompt: params.prompt,
        directory: params.directory,
        model: params.model,
        ...(params.variant !== undefined ? { variant: params.variant } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.executor !== undefined ? { executor: params.executor } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
```

`task.dispatch` needs no change — `return manager.dispatch(params);` already forwards the whole object, including `env`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, aside from any remaining `commands.test.js`/`args.test.js` failures pending Tasks 5/6.

- [ ] **Step 6: Commit**

```bash
git add src/daemon.js src/daemon.test.js
git commit -m "fix(daemon): forward the env RPC param on task.summary and task.advisor"
```

---

## Task 5: `src/commands.js` — send `env` on dispatch/advisor/summary, drop `keySlot`

**Files:**
- Modify: `src/commands.js`
- Test: `src/commands.test.js`

**Interfaces:**
- Consumes: `runCommand()`'s existing `env = process.env` parameter (no signature change needed — it already receives the caller's environment; this task starts actually using it).
- Produces: the `dispatch`, `advisor`, and `summary` RPC calls each include `env: env` in their params object. The `dispatch` case no longer includes `keySlot`.

- [ ] **Step 1: Write the failing tests**

In `src/commands.test.js`, add after the existing `"dispatch omits noSandbox from the RPC payload when not set"` test:

```js
test("dispatch forwards the caller's env to the RPC payload", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root, env: injectedEnv });
  assert.deepEqual(capturedParams.env, injectedEnv);
});

test("dispatch no longer forwards keySlot", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root, keySlot: "primary" }, { client, cwd: root });
  assert.equal("keySlot" in capturedParams, false);
});

test("advisor forwards the caller's env to the RPC payload", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { status: "done", message: "advice" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("advisor", { prompt: "hi", directory: root, model: "m" }, { client, cwd: root, env: injectedEnv });
  assert.deepEqual(capturedParams.env, injectedEnv);
});

test("summary forwards the caller's env to the RPC payload", async () => {
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { sourceTaskId: "t1", summary: "done" };
    },
  };
  const injectedEnv = { FOO: "bar" };
  await runCommand("summary", { taskId: "t1" }, { client, env: injectedEnv });
  assert.deepEqual(capturedParams.env, injectedEnv);
});
```

(Note: `dispatch` and `advisor`'s tests inject `env` via `runCommand`'s options bag, not `process.env`, matching the pattern already used for `env: {}` in the `doctor` tests in this same file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `capturedParams.env` is `undefined` in all three new forwarding tests; `keySlot` is still present when passed.

- [ ] **Step 3: Implement**

In `src/commands.js`'s `runCommand()`:

1. `dispatch` case: remove the `...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),` line, and add `env: env,` to the `client.request("task.dispatch", {...})` object (unconditional — `env` always has a value, since `runCommand`'s `env` parameter defaults to `process.env`).

2. `advisor` case: add `env: env,` to the `client.request("task.advisor", {...})` object.

3. `summary` case: add `env: env,` to the `client.request("task.summary", {...})` object (the one inside `if (options.wait) {...}` block is a `task.wait` call and is untouched; only the `task.summary` request further down gets `env`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/commands.test.js`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, aside from `args.test.js` failures pending Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/commands.js src/commands.test.js
git commit -m "feat(commands): forward the caller's env on dispatch/advisor/summary, drop keySlot"
```

---

## Task 6: `src/args.js` — remove `--key-slot` entirely

**Files:**
- Modify: `src/args.js`
- Test: `src/args.test.js`

**Interfaces:**
- Produces: `taskferry dispatch` no longer accepts `--key-slot`; `parseArgs("dispatch", ...)`'s default options object no longer has a `keySlot` key.

- [ ] **Step 1: Write the failing test**

In `src/args.test.js`, update the `"parses dispatch and applies its argument defaults"` test — remove the `keySlot: undefined,` line from the expected `options` object.

Add a new test after it:

```js
test("dispatch rejects --key-slot as an unknown flag", () => {
  assert.throws(
    () => parseArgs(["dispatch", "--prompt", "do it", "--key-slot", "primary"], { cwd: "/workspace/project" }),
    /unknown flag --key-slot for `dispatch`/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/args.test.js`
Expected: FAIL — the default-options test fails because `keySlot: undefined` is still present in the actual output; the new rejection test fails because `--key-slot` is still accepted.

- [ ] **Step 3: Implement**

In `src/args.js`:

1. Remove `"--key-slot <name>": "use a configured provider key slot",` from `commandSpecs.dispatch.options`.
2. Remove `keySlot: undefined,` from the `dispatch` case in `defaultOptions()`.
3. Remove `"--key-slot": "keySlot",` from the `values` map.
4. Remove `"--key-slot",` from the `dispatch` entry in `commandAllows()`'s `flags` map.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/args.test.js`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, no remaining failures anywhere in the suite.

- [ ] **Step 6: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(args): remove --key-slot flag"
```

---

## Task 7: Docs + skill regeneration

**Files:**
- Modify: `docs/security.md`, `docs/config.md`, `docs/sourcemap.md`, `docs/cli-reference.md`, `docs/troubleshooting.md`, `docs/migrating-from-mcp.md`, `docs/daemon.md`, `README.md`, `skills/using-taskferry/SKILL.md`
- Generated (do not hand-edit): `integrations/claude/skills/using-taskferry/SKILL.md`, `integrations/codex/skills/using-taskferry/SKILL.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Replace `docs/security.md`'s "Provider key slots" section**

Replace the entire section (currently lines 34-90, from `## Provider key slots` through the closing ` ``` ` of the "select the slot" example, up to but not including `## Activity summaries`) with:

```markdown
## Caller-env forwarding

By default, a dispatched task inherits the daemon's own process
environment, so it authenticates the same way the daemon does. On top of
that, `taskferry dispatch`, `taskferry advisor`, and `taskferry summary`
(report mode — the default) each forward the *calling* process's own
environment to the daemon over the same socket, which the daemon unions on
top of its own ambient environment before spawning — caller wins.

- The daemon and every caller run as the same local user over a `0600`
  socket (see "Filesystem and socket permissions" above) — there's no
  trust boundary being crossed by a live caller handing over its own
  environment, since a caller can already read the daemon's own ambient
  env via `/proc` and run arbitrary code via dispatch prompts.
- A fixed set of daemon-controlled plumbing variables can never be
  overridden by a caller's env, regardless of what it sets: `PATH`,
  `HOME`, `TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`,
  `TASKFERRY_CACHE_DIR`, `TASKFERRY_SOCKET_PATH`. These are resolved once
  at the daemon's own startup; letting a caller override any of them (most
  notably `TASKFERRY_SOCKET_PATH`) could misroute a nested `taskferry`
  call made from inside a dispatched worker.
- `TASKFERRY_ENV_DENYLIST` (or the `envDenylist` config field): a
  comma-separated list of env var names an operator wants permanently
  stripped from every spawned child, whether the value came from the
  daemon's own ambient environment or from a caller's forwarded env. This
  is the mechanism for permanently retiring a stale or unwanted variable
  (e.g. a leftover `PI_CODING_AGENT_DIR` in the daemon's own launch
  environment) without needing every caller to remember to unset it. It's
  also the mechanism for an operator who wants to block a specific caller
  env value from ever reaching a spawned child on principle — e.g.
  `LD_PRELOAD` or `LD_LIBRARY_PATH`, which aren't in the fixed excluded set
  above and would otherwise propagate from caller to child unmodified.
- No restart is needed to pick up a new key: exporting a fresh provider
  key in your own shell before running `taskferry dispatch` (or
  `advisor`/`summary`) is enough — the daemon sees it on that call, live,
  because the caller forwards its own environment on every such call.
- There is no per-call opt-out for this forwarding. A missing or invalid
  credential now surfaces as a failure from inside the spawned worker
  itself (classified by the same provider-failure-bucket parser that
  already handles `pi_authentication_failed` and similar), not as an
  upfront `dispatch` error.

```bash
export OPENCODE_GO_API_KEY="..."
taskferry dispatch --prompt "review this diff" --directory /repo
```

The exported key above is visible to `taskferry dispatch` because it's
forwarded from the calling shell's own environment on that call — no
daemon restart, no key-slot registry.
```

- [ ] **Step 2: Update `docs/config.md`**

In the fields table, replace:
```
| `keySlots` | `TASKFERRY_KEY_SLOTS` | string | (none) |
| `providerKeyEnv` | `TASKFERRY_PROVIDER_KEY_ENV` | string | (none) |
| `summaryKeySlot` | `TASKFERRY_SUMMARY_KEY_SLOT` | string | (none) |
| `summaryProviderKeyEnv` | `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` | string | (none) |
```
with:
```
| `envDenylist` | `TASKFERRY_ENV_DENYLIST` | string (comma-separated var names) | (none) |
```

Replace the trailing note:
```
`keySlots` uses the same `name:ENV_VAR_NAME` comma-separated grammar as
`TASKFERRY_KEY_SLOTS` — see `docs/security.md`.
```
with:
```
`envDenylist` uses the same comma-separated grammar as `allowedDirs` — a
flat list of env var names, always stripped from every spawned child
regardless of whether the value came from the daemon's own ambient
environment or a caller's forwarded env; see `docs/security.md`.
```

Also update the example JSON block near the top (currently ending with `"keySlots": "primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_2"`) to use `"envDenylist": "PI_CODING_AGENT_DIR"` instead.

- [ ] **Step 3: Update `docs/sourcemap.md`**

In the env var table, replace:
```
| `TASKFERRY_KEY_SLOTS` | — | yes | Named provider-key slot registry; see `docs/security.md` |
| `TASKFERRY_PROVIDER_KEY_ENV` | — | yes | Source env var a key slot copies from |
```
with:
```
| `TASKFERRY_ENV_DENYLIST` | — | yes | Comma-separated env var names always stripped from every spawned child; see `docs/security.md` |
```
and remove the `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` row entirely.

In the `tasks.js` row's responsibility text, replace `"key-slot env stripping"` with `"caller-env union"`.

- [ ] **Step 4: Update `docs/cli-reference.md`**

Remove the `--key-slot <name>` row from the dispatch flags table. Remove `keySlot` from the `--fields` comma-list in the `result` section. In the prose describing lean/full fields, remove the sentence `` `keySlot` echoes the `--key-slot` name the task was dispatched with, or `null`. ``.

Add a new row to the dispatch flags table (anywhere near the top, e.g. directly after the `--directory <path>` row):

```
| (no flag — always on) | `dispatch`, `advisor`, and `summary` (report mode) forward the calling shell's own environment to the daemon on every call, with no per-call opt-out; see [security.md](security.md#caller-env-forwarding) |
```

- [ ] **Step 5: Update `docs/troubleshooting.md`**

In the provider-failure `failureReason` section, change:
```
- `"rate_limited"`: transient. Retry later, or switch `--key-slot`/`--model`
  in the meantime (see [security.md](security.md#provider-key-slots)).
- `"payment_required"`: the account behind that key slot needs a billing
  fix. Switching `--key-slot` to a different account works around it; the
  original slot needs attention regardless.
- `"authentication_failed"`: the credential in that key slot is broken.
  Rotate it, or switch `--key-slot` to a working one.
```
to:
```
- `"rate_limited"`: transient. Retry later, or switch `--model` in the
  meantime.
- `"payment_required"`: the account behind that credential needs a
  billing fix.
- `"authentication_failed"`: the credential is broken. Rotate it, or
  export a different one before the next dispatch (see
  [security.md](security.md#caller-env-forwarding)).
```

Remove the `## error: key_slot "..." source variable ... is not set` section entirely (that error class no longer exists).

- [ ] **Step 6: Update `docs/migrating-from-mcp.md`**

Change `` `session_id` → `--session-id`, `key_slot` → `--key-slot`, `max_words` → `` to `` `session_id` → `--session-id`, `max_words` → `` (drop the `key_slot` mapping — there's no replacement flag to migrate to).

- [ ] **Step 7: Update `skills/using-taskferry/SKILL.md` (canonical copy)**

Change:
```
- Select the worker model, variant, and optional key slot explicitly when the task
  needs them: `taskferry dispatch --prompt - --directory "<worktree>" --model
  <provider/model> --variant <name> --key-slot <name> <<'PROMPT_EOF'` ... `PROMPT_EOF`.
- State the exact `provider/model` slug (and variant/key-slot, if set) being
  dispatched in your response to the user, not just in the shell command — the
  user shouldn't have to read the command to know what's running.
```
to:
```
- Select the worker model and variant explicitly when the task needs them:
  `taskferry dispatch --prompt - --directory "<worktree>" --model
  <provider/model> --variant <name> <<'PROMPT_EOF'` ... `PROMPT_EOF`.
- State the exact `provider/model` slug (and variant, if set) being
  dispatched in your response to the user, not just in the shell command — the
  user shouldn't have to read the command to know what's running. `dispatch`/
  `advisor`/`summary` (report mode) forward your own shell's environment to
  the daemon on every call, with no per-call opt-out — export a fresh
  provider key before dispatching and it's visible immediately, no daemon
  restart needed.
```

Change:
```
- **Provider-specific availability rules (time windows, key-slot limits,
  single-in-flight constraints) are account state and live outside this
```
to:
```
- **Provider-specific availability rules (time windows, credential limits,
  single-in-flight constraints) are account state and live outside this
```

- [ ] **Step 8: Update `docs/daemon.md`**

Replace:
```
The spawned daemon inherits the booter's environment, which in turn
inherits the original caller's environment. Any `TASKFERRY_*` variable
set when a command first triggers the auto-start takes effect for the
daemon's entire lifetime — including for other terminals and processes
that connect to the same socket afterward. Changing an env var (a new
key slot, a different `TASKFERRY_MAX_CONCURRENT_TASKS`) requires the
daemon to restart: stop it (see below) and let the next command start a
fresh one.
```
with:
```
The spawned daemon inherits the booter's environment, which in turn
inherits the original caller's environment. Any `TASKFERRY_*` variable
set when a command first triggers the auto-start takes effect for the
daemon's entire lifetime — including for other terminals and processes
that connect to the same socket afterward. Changing a daemon-level env
var (a different `TASKFERRY_MAX_CONCURRENT_TASKS`, `TASKFERRY_ENV_DENYLIST`,
etc.) requires the daemon to restart: stop it (see below) and let the next
command start a fresh one. A provider credential is different: `dispatch`/
`advisor`/`summary` (report mode) forward the *calling* shell's own
environment on every call, so exporting a fresh key before dispatching
takes effect immediately, with no restart — see
[security.md](security.md#caller-env-forwarding).
```

Replace:
```
  - `"rate_limited"`: rate limit, usage limit, `429`, too many requests, or
    a bare mention of `quota` with no billing-specific phrase nearby.
    Transient: retry later, or switch key slot in the meantime.
  - `"payment_required"`: `insufficient_quota`, `payment required`,
    `billing`, or a `402` status. The account behind that key slot needs a
    billing fix, not a retry.
  - `"authentication_failed"`: `unauthorized`, an invalid API key, or a
    `401` status. The credential in that key slot is broken and needs
    rotating.
```
with:
```
  - `"rate_limited"`: rate limit, usage limit, `429`, too many requests, or
    a bare mention of `quota` with no billing-specific phrase nearby.
    Transient: retry later.
  - `"payment_required"`: `insufficient_quota`, `payment required`,
    `billing`, or a `402` status. The account behind that credential needs
    a billing fix, not a retry.
  - `"authentication_failed"`: `unauthorized`, an invalid API key, or a
    `401` status. The credential is broken and needs rotating — export a
    working one before the next dispatch.
```

- [ ] **Step 9: Update `README.md`**

Change:
```
- [docs/security.md](docs/security.md): permissions, key slots, activity-summary privacy
```
to:
```
- [docs/security.md](docs/security.md): permissions, caller-env forwarding, activity-summary privacy
```

- [ ] **Step 10: Regenerate and verify the distributed skill copies**

Run: `npm run skill:generate`
Then run: `node scripts/generate-skill.js --check`
Expected: exits 0 with no drift reported.

- [ ] **Step 11: Run the full unit suite one more time**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add docs/security.md docs/config.md docs/sourcemap.md docs/cli-reference.md docs/troubleshooting.md docs/migrating-from-mcp.md docs/daemon.md README.md skills/using-taskferry/SKILL.md integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md
git commit -m "docs: replace provider key-slot docs with caller-env forwarding"
```

---

## Post-implementation

Once all 7 tasks are merged, per this repo's `CLAUDE.md`, move
`.superpowers/specs/2026-07-27-caller-env-key-management-design.md` (currently
only present on the unmerged `worktree-env-denylist` branch — bring it into
this branch's `.superpowers/specs/` first) into
`.superpowers/.completed/specs/` in the same PR, and delete the now-fully-
superseded `worktree-env-denylist` branch/worktree once its one commit's
content (the spec doc itself) has a home in this branch's history.
