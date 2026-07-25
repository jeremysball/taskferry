# Daemon Boot Detached Subprocess Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the CLI process that triggers daemon auto-start from itself holding `daemon-start.lock` for the whole multi-second boot window, so a caller killed mid-boot (e.g. the statusline's `timeout 1 taskferry list`) can never orphan the lock or livelock other callers.

**Architecture:** `ensureDaemonStarted` (lock-acquire → ready-check → spawn → poll-until-ready, all as one unit) keeps its exact current implementation and contract — it's correct, it just currently runs inline in whichever process calls `connectClient`. Move *where* it runs: a new `startDaemonBooter` becomes `connectClient`'s default auto-start hook. It fires a detached, unref'd subprocess (client.js re-invoking itself, the same pattern `spawnDaemon` already uses for `daemon.js`) that runs `ensureDaemonStarted` in a process immune to the caller's own lifetime, then returns immediately. The original caller never touches the lock — it relies on `connectClient`'s existing lock-free `openClient` retry loop to notice when the daemon becomes reachable. A boot failure (e.g. a bad config) is written to a small file under `runtimeDir` by the detached subprocess and surfaced by `connectClient`'s timeout error, so diagnosability isn't lost by moving the failure out-of-process.

**Tech Stack:** Node.js (`node:child_process`, `node:fs`, `node:test`), existing `src/client.js` / `src/state-lock.js` / `src/paths.js`.

## Global Constraints

- Conventional Commits for every commit message (`fix(...)`, `test(...)`, etc.) — imperative mood.
- Every task ends green on `npm test` and `npm run lint` before committing.
- Don't touch `ensureDaemonStarted`'s own implementation or its existing direct unit tests in `src/daemon.test.js` (lines ~755-803) — they test the lock/spawn/poll contract directly and must keep passing unmodified, since that logic is being relocated, not rewritten.
- Follow the existing project convention (seen in `daemon.js`'s own `if (process.argv[1] === ...)` main-guard) of **not** unit-testing a self-execution subprocess entry point by actually spawning it — verify that branch manually instead, the same way `daemon.js`'s main() is handled today.

---

## Task 1: Add `startDaemonBooter` — a fire-and-forget spawn of a detached boot subprocess

**Files:**
- Modify: `src/client.js`
- Test: `src/daemon.test.js` (inside the existing `describe("multiplexed daemon client", ...)` block, near the other `ensureDaemonStarted`/`connectClient` tests around line 730)

**Interfaces:**
- Consumes: `resolveStateDir`, `resolveRuntimeDir` (`src/paths.js`, already imported), `errCode` (`src/errors.js`, not yet imported in `client.js`).
- Produces: `export async function startDaemonBooter({ env, stateDir, runtimeDir, socketPath, spawnBooterFn })` — later tasks pass this as `connectClient`'s default `ensureDaemonFn` and read/write its companion error file.

- [ ] **Step 1: Write the failing tests**

Add near the top of `src/daemon.test.js`, update the import line:

```js
import { connectClient, ensureDaemonStarted, startDaemonBooter } from "./client.js";
```

Add these two tests inside `describe("multiplexed daemon client", ...)`, right before the `"auto-starts after an initial connection failure and retries"` test (~line 732):

```js
  test("startDaemonBooter fires the injected spawn function once and returns without waiting on it", async (t) => {
    const paths = temporaryPaths(t);
    const spawnCalls = [];
    await startDaemonBooter({
      ...paths,
      spawnBooterFn: (args) => spawnCalls.push(args),
    });

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(Object.keys(spawnCalls[0]).sort(), ["env", "runtimeDir", "socketPath", "stateDir"]);
    assert.equal(spawnCalls[0].socketPath, paths.socketPath);
  });

  test("startDaemonBooter clears a stale boot-error file before spawning", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const errorPath = path.join(paths.runtimeDir, "daemon-boot.err");
    fs.writeFileSync(errorPath, "stale failure from a previous boot attempt");

    await startDaemonBooter({ ...paths, spawnBooterFn: () => {} });

    assert.equal(fs.existsSync(errorPath), false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /workspace/taskferry node --test src/daemon.test.js`
Expected: FAIL — `startDaemonBooter is not a function` (not exported yet).

- [ ] **Step 3: Implement `startDaemonBooter` in `src/client.js`**

Add the import (alongside the existing `paths.js` import, line 11):

```js
import { errCode } from "./errors.js";
```

Add a `CLIENT_ENTRY` constant right after `DAEMON_ENTRY` (line 13) — client.js will re-invoke itself the same way `spawnDaemon` re-invokes `daemon.js`:

```js
const CLIENT_ENTRY = fileURLToPath(import.meta.url);
```

Add a `bootErrorPath` helper and `spawnDaemonBooter` + `startDaemonBooter` right after the existing `spawnDaemon` function (after line 55, before `export function ensureDaemonStarted`):

```js
function bootErrorPath(runtimeDir) {
  return path.join(runtimeDir, "daemon-boot.err");
}

function spawnDaemonBooter({ env, stateDir, runtimeDir, socketPath }) {
  const child = spawn(process.execPath, [CLIENT_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: {
      ...env,
      TASKFERRY_STATE_DIR: stateDir,
      TASKFERRY_RUNTIME_DIR: runtimeDir,
      TASKFERRY_SOCKET_PATH: socketPath,
    },
  });
  child.unref();
  return child;
}

// Fires a detached, unref'd subprocess to run ensureDaemonStarted's
// lock-acquire/spawn/poll sequence and returns immediately, without waiting
// on it. The subprocess isn't tied to this process's lifetime, so a caller
// with a short external timeout (e.g. a 1s-refresh statusline) can be killed
// mid-boot without ever having held daemon-start.lock itself.
export async function startDaemonBooter({
  env = process.env,
  stateDir = resolveStateDir(env),
  runtimeDir = resolveRuntimeDir({ env, stateDir }),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, "daemon.sock"),
  spawnBooterFn = spawnDaemonBooter,
} = {}) {
  try {
    fs.unlinkSync(bootErrorPath(runtimeDir));
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  spawnBooterFn({ env, stateDir, runtimeDir, socketPath });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /workspace/taskferry node --test src/daemon.test.js`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add src/client.js src/daemon.test.js
git commit -m "feat(client): add startDaemonBooter, a fire-and-forget daemon-boot spawn"
```

---

## Task 2: Wire `connectClient`'s default auto-start to `startDaemonBooter`

**Files:**
- Modify: `src/client.js`
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: `startDaemonBooter` from Task 1.
- Produces: `connectClient`'s default `ensureDaemonFn` is now `startDaemonBooter` instead of `ensureDaemonStarted`. `connectClient`'s existing `...startupOptions` passthrough (already present, line 267/283) means a caller can still inject `spawnBooterFn` the same way tests already inject `withLockFn`/`spawnDaemonFn` for `ensureDaemonStarted`.

- [ ] **Step 1: Write the failing test**

Add this test in `src/daemon.test.js`, right after the existing `"auto-starts after an initial connection failure and retries"` test (~line 753):

```js
  test("default auto-start fires a detached booter and does not block on its own boot completing", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const fake = fakeManagerFactory();
    let daemon;
    let spawnCalls = 0;
    const client = await connectClient({
      socketPath: paths.socketPath,
      stateDir: paths.stateDir,
      runtimeDir: paths.runtimeDir,
      retryDelayMs: 5,
      startupTimeoutMs: 500,
      spawnBooterFn: () => {
        spawnCalls++;
        // Stands in for the detached subprocess: starts the real daemon
        // well after connectClient's own auto-start call has returned, to
        // prove connectClient isn't blocked waiting on it in-process.
        setTimeout(() => {
          startDaemon({ ...paths, taskManagerFactory: fake.factory }).then((started) => { daemon = started; });
        }, 30);
      },
    });
    t.after(() => client.close());
    t.after(() => daemon?.close());

    assert.equal(spawnCalls, 1);
    assert.equal((await client.request("system.health")).healthy, true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix /workspace/taskferry node --test src/daemon.test.js`
Expected: FAIL — times out / rejects, because `connectClient` still defaults to `ensureDaemonStarted`, which calls the real `spawnDaemon` (spawning an actual `daemon.js` process) rather than the injected `spawnBooterFn`.

- [ ] **Step 3: Implement the wiring**

In `src/client.js`, `connectClient`'s options (currently lines 251-267): change the default `ensureDaemonFn` from `ensureDaemonStarted` to `startDaemonBooter`:

```js
  ensureDaemonFn = startDaemonBooter,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix /workspace/taskferry node --test src/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all pass — in particular the pre-existing `"reports bounded startup failures with actionable help"` test (which overrides `ensureDaemonFn: () => {}` directly and doesn't depend on the default) and the `ensureDaemonStarted`-specific lock tests (which call it directly, bypassing `connectClient` entirely).

- [ ] **Step 6: Commit**

```bash
git add src/client.js src/daemon.test.js
git commit -m "fix(client): auto-start via a detached booter instead of blocking inline"
```

---

## Task 3: Surface a booter's boot failure through connectClient's timeout error

**Files:**
- Modify: `src/client.js`
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: `bootErrorPath` (private helper from Task 1).
- Produces: when `client.js` is executed directly as the booter subprocess and `ensureDaemonStarted()` throws, it writes the error's message to `bootErrorPath(runtimeDir)` and exits with `process.exitCode = 1`. `connectClient`'s final timeout error reads that file (best-effort) and includes its contents.

- [ ] **Step 1: Write the failing test**

Add this test in `src/daemon.test.js`, right after the existing `"reports bounded startup failures with actionable help"` test (~line 818):

```js
  test("includes a boot-error file's contents in the timeout error", async (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.runtimeDir, "daemon-boot.err"),
      "error: could not parse /fake/config.json: bad json\nhelp: fix it"
    );

    await assert.rejects(
      () => connectClient({
        socketPath: paths.socketPath,
        stateDir: paths.stateDir,
        runtimeDir: paths.runtimeDir,
        startupTimeoutMs: 20,
        retryDelayMs: 5,
        ensureDaemonFn: () => {},
      }),
      /daemon boot failed: error: could not parse \/fake\/config\.json/
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix /workspace/taskferry node --test src/daemon.test.js`
Expected: FAIL — the thrown error doesn't yet mention "daemon boot failed".

- [ ] **Step 3: Implement the read side in `connectClient`**

In `src/client.js`, replace the final `throw new Error(...)` block of `connectClient` (currently):

```js
  throw new Error(
    `error: taskferry daemon did not become ready within ${startupTimeoutMs}ms: ${lastError?.message || "connection failed"}\n`
    + `help: check ${runtimeDir} permissions and daemon startup diagnostics, then retry`
  );
}
```

with:

```js
  let bootError;
  try {
    bootError = fs.readFileSync(bootErrorPath(runtimeDir), "utf8").trim();
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  throw new Error(
    `error: taskferry daemon did not become ready within ${startupTimeoutMs}ms: ${lastError?.message || "connection failed"}\n`
    + (bootError ? `daemon boot failed: ${bootError}\n` : "")
    + `help: check ${runtimeDir} permissions and daemon startup diagnostics, then retry`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix /workspace/taskferry node --test src/daemon.test.js`
Expected: PASS

- [ ] **Step 5: Implement the write side — the self-execution (booter) branch**

At the very bottom of `src/client.js` (after the `connectClient` function, end of file), add:

```js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureDaemonStarted();
  } catch (err) {
    const bootEnv = process.env;
    const bootStateDir = resolveStateDir(bootEnv);
    const bootRuntimeDir = resolveRuntimeDir({ env: bootEnv, stateDir: bootStateDir });
    try {
      fs.mkdirSync(bootRuntimeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(bootErrorPath(bootRuntimeDir), err instanceof Error ? err.message : String(err));
    } catch {
      // Best-effort diagnostics only — connectClient's own generic timeout
      // error still surfaces to the user even if this write fails.
    }
    process.exitCode = 1;
  }
}
```

This branch only runs when `client.js` is executed directly as a process entry point (mirrors the existing `daemon.js` main-guard at the bottom of that file) — importing `client.js` as a module, which is what every test and every other caller does, never triggers it.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass — this branch isn't hit by the test suite (nothing spawns `client.js` as its own process here), matching how `daemon.js`'s own main-guard is handled.

- [ ] **Step 7: Manually verify the self-execution branch end-to-end**

This is the one piece the automated suite can't reach (same reason `daemon.js`'s main-guard isn't unit-tested either) — verify it by hand:

```bash
cd /workspace/taskferry
tmp=$(mktemp -d)
XDG_STATE_HOME="$tmp/state" XDG_RUNTIME_DIR="$tmp/run" XDG_CONFIG_HOME="$tmp/config-missing-parent-so-loadConfig-still-succeeds" \
  node src/client.js &
sleep 1
cat "$tmp/run/taskferry/daemon.sock" 2>/dev/null; ls "$tmp/run/taskferry/"
kill %1 2>/dev/null
rm -rf "$tmp"
```

Expected: `daemon.sock` exists in the runtime dir and no `daemon-boot.err` file is present (successful boot). Then repeat pointing `XDG_CONFIG_HOME` at a directory containing a genuinely malformed `taskferry` config file, and confirm `daemon-boot.err` is written with the config-parse error message and the process exits non-zero.

- [ ] **Step 8: Commit**

```bash
git add src/client.js src/daemon.test.js
git commit -m "fix(client): surface a detached booter's failure through the timeout error"
```

---

## Task 4: Re-document `TASKFERRY_AUTO_START` as a general opt-out, and stop the statusline from needing it

**Files:**
- Modify: `src/client.js`
- Modify: `src/tf-sl.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces: `connectClient`'s `TASKFERRY_AUTO_START=0` opt-out stays exactly as-is (same env var, same default expression) — it's a genuinely useful escape hatch for any caller that wants "never spawn a daemon from this invocation, fail fast instead" independent of the livelock bug. Only its *justification* changes (general-purpose opt-out, not a lock-livelock workaround), and the statusline stops needing to set it, since Task 2 moved lock-holding out of the statusline's process entirely.

**Note:** this env var was never committed/shipped — it only exists as an uncommitted working-tree change from the session that diagnosed this bug (confirmed via `git log -S"TASKFERRY_AUTO_START" --all`, no hits). This task reframes that in-progress change rather than reverting shipped behavior.

- [ ] **Step 1: Re-document `connectClient`'s `autoStart` default in `src/client.js`**

Replace the existing comment (kept for context — this is what's currently in the working tree):

```js
  // Callers that poll on a tight cadence with a short external timeout (e.g.
  // a 1s-refresh statusline segment) should opt out via TASKFERRY_AUTO_START=0:
  // an interrupted auto-start still holds the daemon-start lock for the full
  // boot+ready-poll window, so many such pollers racing concurrently can
  // livelock the lock instead of ever letting one attempt finish.
  autoStart = env.TASKFERRY_AUTO_START !== "0",
```

with:

```js
  // General-purpose escape hatch: a caller can set TASKFERRY_AUTO_START=0 to
  // fail fast on a missing daemon instead of spawning one (e.g. a script that
  // should never have side effects). Not needed for lock safety — the
  // detached booter (startDaemonBooter, above) never blocks the caller on
  // the lock regardless of autoStart, so a short-timeout poller no longer
  // has to opt out just to avoid the old inline-boot livelock.
  autoStart = env.TASKFERRY_AUTO_START !== "0",
```

- [ ] **Step 2: Stop the statusline from opting out, since it no longer needs to**

In `src/tf-sl.sh`, remove these lines (currently right after `if command -v taskferry >/dev/null 2>&1 && [ -n "$cwd" ]; then`):

```bash
  # Never let this 1s-cadence poll auto-start the daemon: an attempt killed
  # mid-boot by the `timeout 1` below still leaves the daemon-start lock held
  # for its full window, and enough concurrent statuslines doing that can
  # livelock the lock so the daemon never finishes starting. Skip the segment
  # instead and let a normal (unhurried) taskferry invocation start it.
  export TASKFERRY_AUTO_START=0
```

so the statusline's `taskferry list` call goes back to using the default (auto-start on), safely now that Tasks 1-3 mean it never holds the lock itself.

- [ ] **Step 3: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: all pass, 0 lint errors (there's no existing test asserting `TASKFERRY_AUTO_START` behavior, so nothing else needs updating).

- [ ] **Step 4: Commit**

```bash
git add src/client.js src/tf-sl.sh
git commit -m "docs(client): reframe TASKFERRY_AUTO_START as a general opt-out"
```
