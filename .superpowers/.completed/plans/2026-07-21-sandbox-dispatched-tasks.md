# Bwrap Sandboxing for Dispatched Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap every dispatched OpenCode child (and its summary children) in a `bwrap` filesystem sandbox by default, denying access to taskferry's own state dir and standard credential locations, with fail-fast behavior on Linux when `bwrap` is missing and full opt-outs via `--no-sandbox` / `TASKFERRY_DISABLE_SANDBOX`.

**Architecture:** A new pure-function module `src/sandbox.js` builds the `bwrap` argv and checks binary availability; `src/tasks.js`'s single `startTask()` spawn call site conditionally swaps `spawnFn("opencode", args, ...)` for `spawnFn("bwrap", bwrapArgs.concat(["--", "opencode", ...args]), ...)`. A cached `requireBwrap()` closure checks availability once per daemon lifetime. `sandboxEnabled` and per-dispatch `noSandbox` control activation; `src/daemon.js` gains a small fix to actually thread `runtimeDir` into the task manager (currently missing despite being resolved locally).

**Tech Stack:** Node.js (`node:child_process` spawnSync via injected `runCommand`), `node:test` + `node:assert/strict`, bubblewrap (`bwrap`) as an external Linux-only binary.

## Global Constraints

- Sandboxing is on by default on Linux; on macOS it is a no-op (bwrap is Linux-only) with no error.
- Deny-list is fixed in v1, no config override: `TASKFERRY_STATE_DIR`, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`.
- On Linux, if sandboxing is enabled and `bwrap` is missing, dispatch must fail loudly (task ends up `crashed` with a matching `spawnError`) — never a silent unsandboxed fallback.
- Two opt-outs, both required: `TASKFERRY_DISABLE_SANDBOX=1`/`"true"` (daemon-wide) and `--no-sandbox` (per-dispatch CLI flag).
- `bwrap` availability is checked once per daemon lifetime (cached), not per-dispatch.
- No new test may depend on a real `bwrap` binary being installed on the host running the tests — all `createTaskManager`/`sandbox.js` tests must inject `checkBwrapAvailableFn`/`runCommand`.
- Existing tests must not break: `makeManager()`'s default must keep `sandboxEnabled: false` so ~150 pre-existing tests asserting `captured.cmd === "opencode"` keep passing unless they explicitly opt in.

---

### Task 1: `src/sandbox.js` pure-function module

**Files:**
- Create: `src/sandbox.js`
- Create: `src/sandbox.test.js`
- Modify: `package.json:13` (add `src/sandbox.test.js` to `test:unit`)

**Interfaces:**
- Produces: `platformSupportsSandbox(platform = process.platform): boolean`, `defaultRunCommand(command: string, args: string[]): {status: number|null, stdout: string, stderr: string, error?: object}`, `checkBwrapAvailable(runCommand = defaultRunCommand): {checked: true, available: boolean, reason?: string}`, `buildBwrapArgs({directory: string, stateDir: string, runtimeDir: string, homeDir: string, denyList?: string[]}): string[]` — all consumed by Task 2's `src/tasks.js` changes.

- [ ] **Step 1: Write the failing tests**

Create `src/sandbox.test.js`:

```javascript
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildBwrapArgs, checkBwrapAvailable, platformSupportsSandbox } from "./sandbox.js";

describe("platformSupportsSandbox()", () => {
  test("is true on linux", () => {
    assert.equal(platformSupportsSandbox("linux"), true);
  });

  test("is false on darwin", () => {
    assert.equal(platformSupportsSandbox("darwin"), false);
  });

  test("is false on win32", () => {
    assert.equal(platformSupportsSandbox("win32"), false);
  });

  test("defaults to process.platform when no argument is given", () => {
    assert.equal(platformSupportsSandbox(), process.platform === "linux");
  });
});

describe("checkBwrapAvailable()", () => {
  test("reports available when the probe exits 0", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "bwrap");
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    };
    assert.deepEqual(checkBwrapAvailable(runCommand), { checked: true, available: true });
  });

  test("reports unavailable with an ENOENT-derived reason when the binary is missing", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.checked, true);
    assert.equal(result.available, false);
    assert.match(result.reason, /bwrap not found/);
  });

  test("reports unavailable with the spawn error message for a non-ENOENT error", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "EACCES", message: "spawnSync bwrap EACCES" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /EACCES/);
  });

  test("reports unavailable when the probe exits non-zero with no spawn error", () => {
    const runCommand = () => ({ status: 1, stdout: "", stderr: "boom", error: undefined });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /status 1/);
  });
});

describe("buildBwrapArgs()", () => {
  test("orders ro-bind, then deny-list tmpfs, then read-write binds, then standard flags", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
    });

    assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.equal(args[3], "--tmpfs");

    const deniedPaths = [
      "/home/user/.local/state/taskferry",
      path.join("/home/user", ".ssh"),
      path.join("/home/user", ".aws"),
      path.join("/home/user", ".config", "gcloud"),
      path.join("/home/user", ".config", "gh"),
      path.join("/home/user", ".gnupg"),
    ];
    for (const denied of deniedPaths) {
      const index = args.indexOf(denied);
      assert.notEqual(index, -1, `expected ${denied} to be tmpfs-denied`);
      assert.equal(args[index - 1], "--tmpfs");
    }

    // The state dir's tmpfs deny must come before the runtime dir's read-write
    // bind, since runtimeDir is nested under stateDir in the default layout
    // and bwrap applies rules in argument order.
    const stateDirTmpfsIndex = args.indexOf("/home/user/.local/state/taskferry");
    const runtimeDirBindIndex = args.indexOf("/home/user/.local/state/taskferry/run");
    assert.ok(stateDirTmpfsIndex < runtimeDirBindIndex);
    assert.equal(args[runtimeDirBindIndex - 1], "/home/user/.local/state/taskferry/run");
    assert.equal(args[runtimeDirBindIndex - 2], "--bind");

    const directoryBindIndex = args.indexOf("/workspace/my-repo");
    assert.equal(args[directoryBindIndex - 1], "/workspace/my-repo");
    assert.equal(args[directoryBindIndex - 2], "--bind");

    assert.deepEqual(args.slice(-9), [
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--unshare-all", "--share-net", "--die-with-parent",
    ]);
  });

  test("accepts an injected denyList override", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: ["/only/this/path"],
    });
    assert.equal(args[3], "--tmpfs");
    assert.equal(args[4], "/only/this/path");
    assert.equal(args.indexOf("/home/user/.ssh"), -1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/sandbox.test.js`
Expected: FAIL with `Cannot find module './sandbox.js'` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/sandbox.js`:

```javascript
import { spawnSync } from "node:child_process";
import path from "node:path";

export function platformSupportsSandbox(platform = process.platform) {
  return platform === "linux";
}

export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  if (result.error) {
    return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

export function checkBwrapAvailable(runCommand = defaultRunCommand) {
  const result = runCommand("bwrap", ["--version"]);
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason: result.error.code === "ENOENT" ? "bwrap not found" : `bwrap --version failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { checked: true, available: false, reason: `bwrap --version exited with status ${result.status}` };
  }
  return { checked: true, available: true };
}

function defaultDenyList(homeDir, stateDir) {
  return [
    stateDir,
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".config", "gh"),
    path.join(homeDir, ".gnupg"),
  ];
}

export function buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList = defaultDenyList(homeDir, stateDir) }) {
  const args = ["--ro-bind", "/", "/"];
  for (const denied of denyList) {
    args.push("--tmpfs", denied);
  }
  args.push("--bind", directory, directory);
  args.push("--bind", runtimeDir, runtimeDir);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--unshare-all", "--share-net", "--die-with-parent");
  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/sandbox.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Add the new test file to `package.json`'s `test:unit` script**

In `package.json:13`, change:

```
"test:unit": "env -u TASKFERRY_CHILD node --test src/tasks.test.js src/events.test.js src/protocol.test.js src/state-lock.test.js src/daemon.test.js src/args.test.js src/cli.test.js src/commands.test.js src/integrations.test.js src/opencode-plugin.test.js src/activity.test.js src/output.test.js src/setup.test.js src/config.test.js",
```

to (append `src/sandbox.test.js` at the end):

```
"test:unit": "env -u TASKFERRY_CHILD node --test src/tasks.test.js src/events.test.js src/protocol.test.js src/state-lock.test.js src/daemon.test.js src/args.test.js src/cli.test.js src/commands.test.js src/integrations.test.js src/opencode-plugin.test.js src/activity.test.js src/output.test.js src/setup.test.js src/config.test.js src/sandbox.test.js",
```

- [ ] **Step 6: Run the full unit suite to confirm nothing else broke**

Run: `npm run test:unit`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
git add src/sandbox.js src/sandbox.test.js package.json
git commit -m "feat(sandbox): add pure bwrap-argv and availability-check module"
```

---

### Task 2: Wire bwrap into task spawning (`tasks.js`, `daemon.js`)

**Files:**
- Modify: `src/tasks.js:1-13` (imports), `src/tasks.js:89-99` (`DispatchLaunch` typedef), `src/tasks.js:358-428` (`createTaskManager` params), `src/tasks.js:787` (`dispatch()`), `src/tasks.js:846` (pending-launch storage), `src/tasks.js:1283-1296` (`startTask()` spawn call)
- Modify: `src/tasks.test.js:16-47` (`makeManager()` helper), new `describe("bwrap sandboxing", ...)` block
- Modify: `src/daemon.js:281`
- Modify: `src/daemon.test.js:24-87` (`fakeManagerFactory`), new test

**Interfaces:**
- Consumes: `platformSupportsSandbox`, `checkBwrapAvailable`, `buildBwrapArgs` from `src/sandbox.js` (Task 1).
- Produces: `createTaskManager({..., platform, sandboxEnabled, checkBwrapAvailableFn, runtimeDir, ...})`; `dispatch({..., noSandbox})`; `DispatchLaunch.noSandbox: boolean`. Task 3 (`args.js`/`commands.js`) relies on the RPC payload's `noSandbox` field reaching `dispatch()` unchanged, and on `createTaskManager`'s `sandboxEnabled`/`checkBwrapAvailableFn` names for Task 4's `doctor`/config wiring.

- [ ] **Step 1: Write the failing tests in `src/tasks.test.js`**

First, extend `makeManager()` (`src/tasks.test.js:16-46`) to accept and forward the new options, with `sandboxEnabled` defaulting to `false` so every pre-existing test is unaffected:

```javascript
function makeManager({ tasksFixture = [], logs = {}, spawnFn, killFn, listModelsFn, verifySummaryAgentFn, maxDispatchesPerWindow, dispatchWindowMs, advisorSessionTtlMs, maxConcurrentTasks, noOutputTimeoutMs, postOutputNoOutputTimeoutMs, watchdogPollMs, maxWaitMs, keySlotsSpec, providerKeyEnvName, summaryKeySlot, summaryProviderKeyEnvName, sandboxEnabled = false, checkBwrapAvailableFn, runtimeDir, platform, onEvent } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-test-"));
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const fixtureTasks = typeof tasksFixture === "function" ? tasksFixture(logDir) : tasksFixture;
  fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify(fixtureTasks, null, 2));
  for (const [name, content] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logDir, name), content);
  }

  return createTaskManager({
    stateDir,
    spawnFn: spawnFn ?? (() => { throw new Error("spawnFn was not injected for this test"); }),
    killFn: killFn ?? (() => { throw new Error("killFn was not injected for this test"); }),
    listModelsFn: listModelsFn ?? (() => "opencode/hy3-free\n"),
    verifySummaryAgentFn: verifySummaryAgentFn ?? (async () => {}),
    sandboxEnabled,
    ...(checkBwrapAvailableFn != null ? { checkBwrapAvailableFn } : {}),
    ...(runtimeDir != null ? { runtimeDir } : {}),
    ...(platform != null ? { platform } : {}),
    ...(onEvent != null ? { onEvent } : {}),
    ...(maxDispatchesPerWindow != null ? { maxDispatchesPerWindow } : {}),
    ...(dispatchWindowMs != null ? { dispatchWindowMs } : {}),
    ...(advisorSessionTtlMs != null ? { advisorSessionTtlMs } : {}),
    ...(maxConcurrentTasks != null ? { maxConcurrentTasks } : {}),
    ...(noOutputTimeoutMs != null ? { noOutputTimeoutMs } : {}),
    ...(postOutputNoOutputTimeoutMs != null ? { postOutputNoOutputTimeoutMs } : {}),
    ...(watchdogPollMs != null ? { watchdogPollMs } : {}),
    ...(maxWaitMs != null ? { maxWaitMs } : {}),
    ...(keySlotsSpec != null ? { keySlotsSpec } : {}),
    ...(providerKeyEnvName != null ? { providerKeyEnvName } : {}),
    ...(summaryKeySlot != null ? { summaryKeySlot } : {}),
    ...(summaryProviderKeyEnvName != null ? { summaryProviderKeyEnvName } : {}),
  });
}
```

Then add a new `describe` block anywhere after the `fakeChild()` helper (e.g. right after the `describe("dispatch() lifecycle, ...")` block ends, `src/tasks.test.js:204`):

```javascript
describe("bwrap sandboxing", () => {
  test("wraps the spawn command in bwrap when sandboxing is enabled and available", () => {
    let captured = null;
    const runtimeDir = path.join(os.tmpdir(), "axi-tasks-runtime");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      runtimeDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: "opencode-go/minimax-m3", variant: "max" });

    assert.equal(captured.cmd, "bwrap");
    assert.deepEqual(captured.args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.equal(captured.args[3], "--tmpfs");
    assert.ok(captured.args.includes(mgr.paths.STATE_DIR));
    const bindIndex = captured.args.indexOf("--bind");
    assert.equal(captured.args[bindIndex + 1], os.tmpdir());
    assert.ok(captured.args.includes(runtimeDir));
    assert.deepEqual(captured.args.slice(-14), [
      "--", "opencode", "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", "opencode-go/minimax-m3", "--variant", "max", "--", "hello",
    ]);
    assert.equal(captured.opts.cwd, os.tmpdir());
  });

  test("falls through to the unwrapped opencode command when --no-sandbox is set on a dispatch", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called when --no-sandbox is set"); },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), noSandbox: true });

    assert.equal(captured.cmd, "opencode");
  });

  test("falls through to the unwrapped opencode command when sandboxEnabled is false", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: false,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called when sandboxEnabled is false"); },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.cmd, "opencode");
  });

  test("falls through to the unwrapped opencode command on a non-Linux platform without probing bwrap", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called on a non-Linux platform"); },
      platform: "darwin",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.cmd, "opencode");
  });

  test("crashes the task with a matching spawnError when bwrap is required but unavailable", () => {
    const mgr = makeManager({
      spawnFn: () => { throw new Error("spawnFn should not be called when bwrap is unavailable"); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: false, reason: "bwrap not found" }),
      platform: "linux",
    });

    const dispatched = mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const status = mgr.status(dispatched.id);

    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /bwrap is required for sandboxing but was not found/);
  });

  test("checks bwrap availability only once across multiple dispatches", () => {
    let calls = 0;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { calls++; return { checked: true, available: true }; },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "two", directory: os.tmpdir() });

    assert.equal(calls, 1);
  });

  test("wraps a summary launch's spawn in bwrap too, binding SUMMARY_DIR", async () => {
    let captured;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      spawnFn: (command, args, options) => { captured = { command, args, options }; return child; },
      verifySummaryAgentFn: async () => {},
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal(captured.command, "bwrap");
    assert.ok(captured.args.includes("--agent"));
    assert.equal(captured.options.cwd, mgr.paths.SUMMARY_DIR);
    const bindIndex = captured.args.indexOf("--bind");
    assert.equal(captured.args[bindIndex + 1], mgr.paths.SUMMARY_DIR);

    child.emit("exit", 0, null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `captured.cmd` is `"opencode"` instead of `"bwrap"` in the first test; the "crashes the task" test fails because nothing currently throws; other assertions error since `sandboxEnabled`/`checkBwrapAvailableFn`/`platform`/`runtimeDir` aren't yet accepted options (they're silently ignored by the current `createTaskManager`, so behavior doesn't change).

- [ ] **Step 3: Implement in `src/tasks.js`**

Add imports at the top (`src/tasks.js:1-13`), inserting after the existing `node:util` import:

```javascript
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTaskEvents } from "./events.js";
import { createActivityCache, readActivitySnapshot, readDeltaNarration, DEFAULT_SUMMARIZER_TIMEOUT_MS } from "./activity.js";
import { withFileLock } from "./state-lock.js";
import { resolveStateDir } from "./paths.js";
import { RESULT_FIELDS } from "./protocol.js";
import { formatToolEventForNarration } from "./narration-format.js";
import { errCode } from "./errors.js";
import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";
import { buildBwrapArgs, checkBwrapAvailable, platformSupportsSandbox } from "./sandbox.js";
```

(This adds `import os from "node:os";` and the new `./sandbox.js` import; every other line is unchanged.)

Extend the `DispatchLaunch` typedef (`src/tasks.js:89-99`):

```javascript
/**
 * @typedef {object} DispatchLaunch
 * @property {string} prompt
 * @property {string} directory
 * @property {string} model
 * @property {string|null} variant
 * @property {string|null|undefined} [sessionId]
 * @property {string|null} [keyEnvValue]
 * @property {boolean} [noSandbox]
 * @property {undefined} [kind]
 * @property {undefined} [snapshotPath]
 */
```

Add new `createTaskManager` params (`src/tasks.js:358-428`), inserting immediately before the trailing `onEvent,` (line 427):

```javascript
  platform = process.platform,
  sandboxEnabled = process.env.TASKFERRY_DISABLE_SANDBOX !== undefined
    ? !["1", "true"].includes(process.env.TASKFERRY_DISABLE_SANDBOX)
    : (/** @type {boolean|undefined} */ (config.sandboxEnabled) ?? true),
  checkBwrapAvailableFn = checkBwrapAvailable,
  runtimeDir = path.join(stateDir, "run"),
  onEvent,
```

Add the cached availability closure right after `taskEvents` is created (`src/tasks.js:445-448`, immediately before `function environmentWithoutKeySlotSources() {`):

```javascript
  let bwrapAvailable = null;
  function requireBwrap() {
    if (bwrapAvailable == null) {
      bwrapAvailable = checkBwrapAvailableFn();
    }
    if (!bwrapAvailable.available) {
      throw new Error(
        "error: bwrap is required for sandboxing but was not found\n" +
        "help: install bubblewrap (e.g. apt install bubblewrap) or opt out with --no-sandbox or TASKFERRY_DISABLE_SANDBOX=1"
      );
    }
  }
```

Update `dispatch()`'s signature and pending-launch storage (`src/tasks.js:787` and `:846`):

```javascript
  function dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal = false, finalMarker = null, originSessionId, noSandbox = false }) {
```

```javascript
    pendingLaunches.set(id, { prompt, directory: normalizedDirectory, model: resolvedModel, variant: task.variant, sessionId, keyEnvValue: resolvedKeySlot.keyEnvValue, noSandbox: noSandbox === true });
```

Update `startTask()`'s spawn call (`src/tasks.js:1283-1296`), replacing:

```javascript
    let logFd;
    let child;
    try {
      logFd = fs.openSync(task.logPath, "a", 0o600);
      fs.chmodSync(task.logPath, 0o600);
      // No tmux: the child has no shared session to introspect. It is its own
      // process group so cancellation can stop any subprocesses it creates.
      const spawnEnv = isSummary ? summaryLaunch.env : dispatchEnvironment(dispatchLaunch.keyEnvValue);
      child = spawnFn("opencode", args, {
        cwd: isSummary ? SUMMARY_DIR : dispatchLaunch.directory,
        stdio: ["ignore", logFd, logFd],
        detached: true,
        env: spawnEnv,
      });
```

with:

```javascript
    let logFd;
    let child;
    try {
      logFd = fs.openSync(task.logPath, "a", 0o600);
      fs.chmodSync(task.logPath, 0o600);
      const spawnEnv = isSummary ? summaryLaunch.env : dispatchEnvironment(dispatchLaunch.keyEnvValue);
      const launchDirectory = isSummary ? SUMMARY_DIR : dispatchLaunch.directory;
      const noSandbox = !isSummary && dispatchLaunch.noSandbox === true;
      let spawnCommand = "opencode";
      let spawnArgs = args;
      if (sandboxEnabled && !noSandbox && platformSupportsSandbox(platform)) {
        requireBwrap();
        spawnCommand = "bwrap";
        spawnArgs = buildBwrapArgs({ directory: launchDirectory, stateDir, runtimeDir, homeDir: os.homedir() }).concat(["--", "opencode", ...args]);
      }
      // No tmux: the child has no shared session to introspect. It is its own
      // process group so cancellation can stop any subprocesses it creates.
      child = spawnFn(spawnCommand, spawnArgs, {
        cwd: launchDirectory,
        stdio: ["ignore", logFd, logFd],
        detached: true,
        env: spawnEnv,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, all tests green (including the new `describe("bwrap sandboxing", ...)` block).

- [ ] **Step 5: Write the failing `daemon.js`/`daemon.test.js` test**

In `src/daemon.test.js`, extend `fakeManagerFactory` (`:24-87`) to capture the options it was constructed with:

```javascript
function fakeManagerFactory(tasks = [], { checkSummaryModelReady } = {}) {
  let onEvent;
  let capturedOptions;
  const calls = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const manager = {
    // ... (unchanged: dispatch, cancel, status, poll, list, result, tail, summarize, advisor, checkSummaryModelReady)
  };

  return {
    factory(options) {
      capturedOptions = options;
      onEvent = options.onEvent;
      return manager;
    },
    calls,
    emit(event) {
      onEvent(event);
    },
    get options() {
      return capturedOptions;
    },
  };
}
```

(Only the `let capturedOptions;` declaration, the `capturedOptions = options;` line inside `factory`, and the new `get options()` accessor on the returned object are additions — the `manager` object body and every existing method are unchanged.)

Add a new test near the other `startDaemon({...paths, taskManagerFactory: fake.factory})` tests (e.g. right after "creates protected runtime/socket paths and serves ordinary requests", `src/daemon.test.js:149-167`):

```javascript
  test("passes runtimeDir through to the task manager factory", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory();
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());

    assert.equal(fake.options.runtimeDir, paths.runtimeDir);
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test src/daemon.test.js`
Expected: FAIL — `fake.options.runtimeDir` is `undefined` (not yet threaded through).

- [ ] **Step 7: Fix `src/daemon.js:281`**

Change:

```javascript
  const manager = taskManagerFactory({ ...taskManagerOptions, stateDir, onEvent });
```

to:

```javascript
  const manager = taskManagerFactory({ ...taskManagerOptions, stateDir, runtimeDir, onEvent });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test src/daemon.test.js`
Expected: PASS, all tests green.

- [ ] **Step 9: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, no failures.

- [ ] **Step 10: Commit**

```bash
git add src/tasks.js src/tasks.test.js src/daemon.js src/daemon.test.js
git commit -m "feat(tasks): sandbox dispatched and summary children in bwrap by default"
```

---

### Task 3: `--no-sandbox` CLI flag end-to-end

**Files:**
- Modify: `src/args.js:3-21` (`commandSpecs.dispatch`), `src/args.js:228-259` (`defaultOptions`), `src/args.js:312-325` (boolean flag handling)
- Modify: `src/args.test.js:20-34` (dispatch defaults test), new parse test
- Modify: `src/commands.js:61-73` (dispatch RPC payload)
- Modify: `src/commands.test.js` (new dispatch tests)

**Interfaces:**
- Consumes: none new (uses existing `parseArgs`/`runCommand` shapes).
- Produces: `parseArgs(["dispatch", ..., "--no-sandbox"]).options.noSandbox: boolean`; `runCommand("dispatch", {..., noSandbox}, ...)` forwards `noSandbox` into the `task.dispatch` RPC payload, matching Task 2's `dispatch({..., noSandbox})`.

- [ ] **Step 1: Write the failing tests in `src/args.test.js`**

Update the existing defaults test (`src/args.test.js:20-34`):

```javascript
test("parses dispatch and applies its argument defaults", () => {
  assert.deepEqual(parseArgs(["dispatch", "--prompt", "do it"], { cwd: "/workspace/project" }), {
    command: "dispatch",
    options: {
      prompt: "do it",
      directory: "/workspace/project",
      model: undefined,
      variant: undefined,
      sessionId: undefined,
      keySlot: undefined,
      finalMarker: undefined,
      noSandbox: false,
    },
    help: false,
  });
});
```

Add a new test near the existing `--require-final-marker` tests (`src/args.test.js:219` area):

```javascript
test("parses dispatch --no-sandbox", () => {
  assert.equal(parseArgs(["dispatch", "--prompt", "x", "--no-sandbox"]).options.noSandbox, true);
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--no-sandbox=1"]), /--no-sandbox does not take a value/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--no-sandbox"]), /unknown flag --no-sandbox/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/args.test.js`
Expected: FAIL — the defaults test fails on a missing `noSandbox` key; the new test fails because `--no-sandbox` is an unrecognized flag for every command.

- [ ] **Step 3: Implement in `src/args.js`**

Add the new option and example to `commandSpecs.dispatch` (`src/args.js:4-20`):

```javascript
  dispatch: {
    usage: "taskferry dispatch --prompt <text> [options]",
    description: "Queue a background OpenCode run.",
    options: {
      "--prompt <text>": "required",
      "--directory <path>": "defaults to the current workspace",
      "--model <id>": "use the default model when omitted",
      "--variant <name>": "optional model reasoning variant",
      "--session-id <id>": "resume an existing OpenCode session",
      "--key-slot <name>": "use a configured provider key slot",
      "--require-final-marker <regex>": "flag the task as incomplete if the final message doesn't match this pattern (case-sensitive, standard JS RegExp semantics)",
      "--no-sandbox": "run this dispatch without the bwrap filesystem sandbox (default: sandboxed on Linux)",
    },
    examples: [
      'taskferry dispatch --prompt "Fix the failing tests"',
      'taskferry dispatch --prompt "Review this change" --model openai/gpt-5.6-sol',
      'taskferry dispatch --prompt "Investigate" --require-final-marker "^Status: (DONE|DONE_WITH_CONCERNS|BLOCKED)$"',
      'taskferry dispatch --prompt "Run one-off shell tooling" --no-sandbox',
    ],
  },
```

Add the default (`src/args.js:230-231`):

```javascript
    case "dispatch":
      return { prompt: undefined, directory: cwd, model: undefined, variant: undefined, sessionId: undefined, keySlot: undefined, finalMarker: undefined, noSandbox: false };
```

Add `--no-sandbox` to the boolean-flag map and introduce the key-override lookup (`src/args.js:312-325`):

```javascript
    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
      "--no-sandbox": ["dispatch"],
    };
    const booleanKeyOverrides = { "--no-sandbox": "noSandbox" };
    if (booleanCommands[name]) {
      if (!booleanCommands[name].includes(command)) throw usageError(`unknown flag ${name} for \`${command}\``, command);
      if (inlineValue !== undefined) throw usageError(`${name} does not take a value`, command);
      const key = booleanKeyOverrides[name] ?? name.slice(2);
      setOption(options, key, true, command, seen);
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/args.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Write the failing tests in `src/commands.test.js`**

Add new tests near the existing `originSessionId` dispatch tests (`src/commands.test.js:527-564` area):

```javascript
test("dispatch forwards noSandbox to the RPC payload when set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root, noSandbox: true }, { client, cwd: root });
  assert.equal(capturedParams.noSandbox, true);
});

test("dispatch omits noSandbox from the RPC payload when not set", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedParams;
  const client = {
    request: async (method, params) => {
      capturedParams = params;
      return { id: "oc_1" };
    },
  };
  await runCommand("dispatch", { prompt: "hi", directory: root }, { client, cwd: root });
  assert.equal("noSandbox" in capturedParams, false);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `capturedParams.noSandbox` is `undefined` in the first test (not yet threaded).

- [ ] **Step 7: Implement in `src/commands.js`**

Update the `dispatch` case (`src/commands.js:61-73`):

```javascript
    case "dispatch": {
      const directory = normalizeDirectory(options.directory || cwd);
      return client.request("task.dispatch", {
        prompt: options.prompt,
        directory,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),
        ...(options.finalMarker === undefined ? {} : { finalMarker: options.finalMarker }),
        ...(options.noSandbox === undefined ? {} : { noSandbox: options.noSandbox }),
        ...(process.env.CLAUDE_CODE_SESSION_ID ? { originSessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      });
    }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test src/commands.test.js`
Expected: PASS, all tests green.

- [ ] **Step 9: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, no failures.

- [ ] **Step 10: Commit**

```bash
git add src/args.js src/args.test.js src/commands.js src/commands.test.js
git commit -m "feat(cli): add --no-sandbox to dispatch, threaded through to the RPC payload"
```

---

### Task 4: `doctor` bwrap check + `sandboxEnabled` config field

**Files:**
- Modify: `src/commands.js:1-14` (imports), `src/commands.js:52` (`runCommand` options), `src/commands.js:167-188` (`doctor` case)
- Modify: `src/commands.test.js:415-438` and `:566-588` (fix 2 breaking mocks), new tests
- Modify: `src/config.js:6-21` (`CONFIG_FIELD_TYPES`)
- Modify: `src/config.test.js` (new tests)

**Interfaces:**
- Consumes: `checkBwrapAvailable` from `src/sandbox.js` (Task 1).
- Produces: `runCommand("doctor", options, {..., platform})` gains a `platform` option (default `process.platform`); `doctor`'s result gains an optional top-level `info: string[]` array alongside the existing `warnings: string[]`. `CONFIG_FIELD_TYPES.sandboxEnabled: "boolean"` makes `sandboxEnabled` a recognized `taskferry` config key, matching Task 2's `createTaskManager({... config.sandboxEnabled ...})` read.

- [ ] **Step 1: Fix the two breaking doctor mocks in `src/commands.test.js`**

These two existing tests have `runShellCommand` mocks that assume every call is the `claude` probe; once `doctor` also probes `bwrap`, they'd break without this fix (a bwrap-probe running on Linux would either fail the `command === "claude"` assertion, or spuriously add a second warning). Update them now, before adding the doctor bwrap check, so the test suite stays green at every commit.

Change "doctor warns when the claude plugin is not installed" (`src/commands.test.js:415-438`):

```javascript
test("doctor warns when the claude plugin is not installed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command, args) => {
    if (command === "bwrap") return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    assert.equal(command, "claude");
    assert.deepEqual(args, ["plugin", "list", "--json"]);
    return { status: 0, stdout: JSON.stringify([{ id: "superpowers@claude-plugins-official" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.deepEqual(result.integrations, {
    claude: { installed: false },
    playwrightMcpIsolation: { opencode: { checked: false, reason: "no opencode config with a playwright MCP entry found" }, claudeCode: { checked: false, reason: "~/.claude.json not found" } },
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /claude-monitor notifications won't fire/);
  assert.match(result.warnings[0], /taskferry setup/);
});
```

Change "doctor reports a distinct reason when claude exits with a non-ENOENT spawn error" (`src/commands.test.js:566-588`):

```javascript
test("doctor reports a distinct reason when claude exits with a non-ENOENT spawn error", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    if (command === "bwrap") return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    return { status: null, stdout: "", stderr: "", error: { code: "EACCES", message: "spawnSync claude EACCES" } };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.deepEqual(result.integrations, {
    claude: { installed: false, reason: "claude plugin list failed: spawnSync claude EACCES" },
    playwrightMcpIsolation: { opencode: { checked: false, reason: "no opencode config with a playwright MCP entry found" }, claudeCode: { checked: false, reason: "~/.claude.json not found" } },
  });
  assert.equal(result.warnings.length, 1);
});
```

- [ ] **Step 2: Run tests to confirm these two still pass unmodified-behavior-wise**

Run: `node --test src/commands.test.js`
Expected: PASS (no bwrap check exists yet, so the `command === "bwrap"` branch is simply never taken — these are refactors, not yet behavior changes).

- [ ] **Step 3: Write the new failing doctor tests**

Add these three tests near the other `doctor` tests in `src/commands.test.js` (e.g. after "doctor reports the claude plugin as not installed when the claude CLI is missing", `:464-481`):

```javascript
test("doctor warns when bwrap is not installed on Linux", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    if (command === "bwrap") return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
    return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand, platform: "linux" });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bwrap is not installed/);
  assert.match(result.warnings[0], /TASKFERRY_DISABLE_SANDBOX/);
  assert.equal(result.info, undefined);
});

test("doctor has no sandbox warning or info when bwrap is installed on Linux", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    if (command === "bwrap") return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand, platform: "linux" });

  assert.equal(result.warnings, undefined);
  assert.equal(result.info, undefined);
});

test("doctor adds an informational note instead of a bwrap check on non-Linux platforms", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = fakeClient();
  client.request = async (method) => {
    if (method === "system.health") return { healthy: true, pid: 1 };
    throw new Error(`unexpected request: ${method}`);
  };
  const runShellCommand = (command) => {
    assert.notEqual(command, "bwrap");
    return { status: 0, stdout: JSON.stringify([{ id: "taskferry@taskferry" }]), stderr: "", error: undefined };
  };

  const result = await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand, platform: "darwin" });

  assert.equal(result.warnings, undefined);
  assert.equal(result.info.length, 1);
  assert.match(result.info[0], /only available on Linux/);
});
```

- [ ] **Step 4: Run tests to verify the new ones fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `runCommand` doesn't accept a `platform` option yet and `doctor` never calls `checkBwrapAvailable`, so `result.warnings`/`result.info` don't match any of the three new expectations.

- [ ] **Step 5: Implement in `src/commands.js`**

Add the import (`src/commands.js:13-14`):

```javascript
import { defaultRunCommand as defaultShellRunner, pluginInstalled } from "./setup.js";
import { checkClaudeCodePlaywrightIsolation, checkOpencodePlaywrightIsolation } from "./mcp-isolation.js";
import { checkBwrapAvailable } from "./sandbox.js";
```

Add `platform` to `runCommand`'s destructured options (`src/commands.js:52`):

```javascript
export async function runCommand(command, options, { client, io = process, signal, executablePath, cwd = process.cwd(), homeDirectory = os.homedir(), env = process.env, runShellCommand = defaultShellRunner, platform = process.platform } = {}) {
```

Update the `doctor` case (`src/commands.js:167-188`):

```javascript
    case "doctor": {
      const health = await client.request("system.health", {});
      const claude = checkClaudeIntegration(runShellCommand);
      const opencodeMCP = checkOpencodePlaywrightIsolation(homeDirectory, env);
      const claudeCodeMCP = checkClaudeCodePlaywrightIsolation(homeDirectory);
      const bwrap = platform === "linux" ? checkBwrapAvailable(runShellCommand) : null;
      const warnings = [];
      const info = [];
      if (!claude.installed) {
        warnings.push(`Claude plugin not installed (${claude.reason || "not found in claude plugin list"}): claude-monitor notifications won't fire. Run taskferry setup to install it.`);
      }
      if (opencodeMCP.checked && !opencodeMCP.isolated) {
        warnings.push(`Playwright MCP for opencode is not isolated (${opencodeMCP.path}): concurrent dispatches sharing one browser profile crash with SIGKILL. Run taskferry setup to fix, or add --isolated to its command manually.`);
      }
      if (claudeCodeMCP.checked && !claudeCodeMCP.isolated) {
        warnings.push(`Playwright MCP for Claude Code is not isolated${claudeCodeMCP.path ? ` (${claudeCodeMCP.path})` : ""}: concurrent dispatches sharing one browser profile crash with SIGKILL. Run taskferry setup to fix${claudeCodeMCP.reason && !claudeCodeMCP.path ? `, or ${claudeCodeMCP.reason.toLowerCase()}` : ""}.`);
      }
      if (bwrap && !bwrap.available) {
        warnings.push(`Filesystem sandboxing is unavailable: bwrap is not installed (${bwrap.reason}). Dispatched tasks run without confinement. Install bubblewrap (e.g. apt install bubblewrap), or opt out explicitly with TASKFERRY_DISABLE_SANDBOX=1.`);
      }
      if (platform !== "linux") {
        info.push("Filesystem sandboxing (bwrap) is only available on Linux; dispatched tasks on this platform run unconfined.");
      }
      return {
        ...health,
        ...(options.full ? { cliVersion: "2.0.0", protocolVersion: 1 } : {}),
        integrations: { claude, playwrightMcpIsolation: { opencode: opencodeMCP, claudeCode: claudeCodeMCP } },
        ...(warnings.length ? { warnings } : {}),
        ...(info.length ? { info } : {}),
      };
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test src/commands.test.js`
Expected: PASS, all tests green (including the other 6 pre-existing `doctor` tests, whose lenient `() => ({status: 0, ...})` mocks now also answer the `bwrap` probe with `status: 0`, which reads as available and adds no new warning).

- [ ] **Step 7: Write the failing config tests in `src/config.test.js`**

Add these tests inside the existing `describe("loadConfig()", ...)` block:

```javascript
  test("accepts a valid sandboxEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ sandboxEnabled: false }));
    assert.deepEqual(loadConfig({ configPath }), { sandboxEnabled: false });
  });

  test("rejects a wrong-typed sandboxEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ sandboxEnabled: "false" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "sandboxEnabled".*must be a boolean.*\nhelp:/s);
  });
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `node --test src/config.test.js`
Expected: FAIL — `sandboxEnabled` is an unrecognized config key.

- [ ] **Step 9: Implement in `src/config.js`**

Add the field type (`src/config.js:6-21`):

```javascript
const CONFIG_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  dispatchWindowMs: "number",
  noOutputTimeoutMs: "number",
  postOutputNoOutputTimeoutMs: "number",
  summaryModel: "string",
  activitySummariesEnabled: "boolean",
  summarizerTimeoutMs: "number",
  activityMaxWords: "number",
  advisorSessionTtlMs: "number",
  keySlots: "string",
  providerKeyEnv: "string",
  summaryKeySlot: "string",
  summaryProviderKeyEnv: "string",
  sandboxEnabled: "boolean",
};
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `node --test src/config.test.js`
Expected: PASS, all tests green.

- [ ] **Step 11: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS, no failures.

- [ ] **Step 12: Commit**

```bash
git add src/commands.js src/commands.test.js src/config.js src/config.test.js
git commit -m "feat(doctor): warn on missing bwrap and add sandboxEnabled config field"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/security.md` (new section after the existing `TASKFERRY_CHILD` section, `:122-130`)
- Modify: `docs/cli-reference.md:47-55` (dispatch flag table)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing consumed by other tasks; this is the terminal task.

- [ ] **Step 1: Add the new section to `docs/security.md`**

After the existing `## \`TASKFERRY_CHILD\`` section (ends at `docs/security.md:130`), append:

```markdown

## Filesystem sandboxing (bubblewrap)

Every dispatched OpenCode child, and every summary child, runs wrapped in
[`bwrap`](https://github.com/containers/bubblewrap) by default on Linux:

- **Mount layout.** A full read-only bind of `/` (`--ro-bind / /`) so the
  sandboxed process can read normal system libraries, binaries, and
  OpenCode's own config without a hand-maintained whitelist, with the
  following paths overlaid as empty (`--tmpfs`) on top of that read-only
  view:
  - `TASKFERRY_STATE_DIR` (every task's NDJSON logs, including other tasks'
    prompt/tool output)
  - `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`
- **Read-write access** is then re-granted only for the task's own working
  directory and `TASKFERRY_RUNTIME_DIR` (needed so a nested/recursive
  dispatch from inside the sandbox can still reach the daemon socket at
  `<runtimeDir>/daemon.sock`).
- **Deny-list is fixed** in this version — no config override. It covers
  taskferry's own state dir plus the standard credential locations; a
  config override can be added later if a real need surfaces.
- **Fail-fast on Linux.** If sandboxing is enabled (the default) and `bwrap`
  is not installed, dispatch fails immediately with a `crashed` task and a
  matching `spawnError` — there is no silent unsandboxed fallback on the
  platform where sandboxing is expected to work.
- **macOS.** `bwrap` is Linux-only; on macOS dispatch runs exactly as it did
  before this feature, with no wrapping, no availability check, and no
  error. `taskferry doctor` surfaces this as an informational note, not a
  warning.
- **Opt out**, if you need a dispatch to see the whole filesystem (e.g. it
  legitimately needs `~/.ssh` or another denied path): pass `--no-sandbox`
  on a single `taskferry dispatch` call, or set
  `TASKFERRY_DISABLE_SANDBOX=1` (or `"true"`) on the daemon to disable
  sandboxing for every dispatch it serves. `sandboxEnabled` is also a
  `taskferry` config field, following the usual precedence (CLI flag > env
  var > config file > default).
```

- [ ] **Step 2: Add the new flag row to `docs/cli-reference.md`**

In the `taskferry dispatch` flag table (`docs/cli-reference.md:47-55`), add a row after `--require-final-marker`:

```markdown
| Flag | Notes |
|---|---|
| `--prompt <text>` | Required |
| `--directory <path>` | Defaults to the current workspace; must be an absolute, existing directory |
| `--model <id>` | `provider/model`, e.g. `opencode-go/minimax-m3`. Run `opencode models` to list installed models. Defaults to `openai/gpt-5.6-luna` at variant `high` |
| `--variant <name>` | Reasoning-effort override (`high`, `max`, `minimal`, ...), applied only alongside `--model` |
| `--session-id <id>` | Resume an existing OpenCode session (`--continue --session <id>`) instead of starting fresh; get session ids from a prior `result` or `status --full` |
| `--key-slot <name>` | Use a configured provider-key slot instead of the daemon's ambient key; see [security.md](security.md) |
| `--require-final-marker <regex>` | Fail the task if the final message doesn't match this pattern (case-sensitive, standard JS RegExp semantics). Sets `incomplete: true` on the settled task when the final message is empty (after trimming) or doesn't match. Patterns that don't compile as a standard JS RegExp reject the dispatch up front with a usage error. Useful for enforcing a report-format contract like `^Status: (DONE\|DONE_WITH_CONCERNS\|BLOCKED\|NEEDS_CONTEXT)$` on the last line of model output. |
| `--no-sandbox` | Run this dispatch without the bwrap filesystem sandbox (default: sandboxed on Linux, no-op on macOS); see [security.md](security.md) |
```

- [ ] **Step 3: Commit**

```bash
git add docs/security.md docs/cli-reference.md
git commit -m "docs: document bwrap filesystem sandboxing and --no-sandbox"
```

---

## Self-Review

**Spec coverage:**
- Module `src/sandbox.js` with all three exported functions → Task 1. ✓
- Interception point `startTask()`, single spawn call site → Task 2. ✓
- `requireBwrap()` cached availability check → Task 2. ✓
- Activation/opt-out (`TASKFERRY_DISABLE_SANDBOX`, `--no-sandbox`, `sandboxEnabled` config field) → Tasks 2, 3, 4. ✓
- Platform handling (macOS no-op, doctor informational note) → Tasks 2, 4. ✓
- Doctor/setup integration (warning on Linux, info on macOS, no auto-repair) → Task 4. ✓
- Cancellation — spec states no change needed (verified); no plan task required. ✓
- Testing approach (injected `runCommand`/`checkBwrapAvailableFn`, no real `bwrap` needed) → Tasks 1, 2. ✓
- Documentation (`docs/security.md` new section) → Task 5. ✓
- Files touched table — every listed file is covered: `src/sandbox.js`/`.test.js` (Task 1), `src/tasks.js`/`.test.js` (Task 2), `src/args.js`/`.test.js` (Task 3), `src/commands.js`/`.test.js` (Tasks 3 & 4), plus this plan's own corrections: `src/daemon.js`/`.test.js` (Task 2, fixing the spec's incorrect claim that `runtimeDir` plumbing already existed), `src/config.js`/`.test.js` (Task 4), `docs/cli-reference.md` (Task 5, not in the spec's table but required by the `--no-sandbox` flag's existence).

**Placeholder scan:** No "TBD"/"implement later"/"similar to Task N" patterns; every test step has complete, runnable code; every code step shows the exact diff or full file content.

**Type/signature consistency:** `noSandbox` is `boolean` throughout — `DispatchLaunch.noSandbox` (Task 2) → `dispatch({noSandbox = false})` (Task 2) → CLI `options.noSandbox` (Task 3) → RPC payload `noSandbox` (Task 3). `sandboxEnabled` is `boolean` throughout — `createTaskManager({sandboxEnabled})` (Task 2) → `CONFIG_FIELD_TYPES.sandboxEnabled: "boolean"` (Task 4). `checkBwrapAvailableFn` always returns `{checked: true, available: boolean, reason?: string}` — defined in Task 1, consumed identically in Task 2's `requireBwrap()` and Task 4's `doctor` case. `platform` defaults to `process.platform` consistently in `createTaskManager` (Task 2) and `runCommand` (Task 4).
