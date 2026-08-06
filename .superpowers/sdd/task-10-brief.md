### Task 10: End-to-end smoke test against a real `pi` process

**Files:**
- Create: `src/executor.smoke.test.js` (or add a clearly-marked block to `src/tasks.test.js` — pick whichever this repo's existing smoke/integration tests already do; check `rg -n "requires.*real|skip.*CI|process.env.CI" src/*.test.js` for the established pattern first)

**Interfaces:**
- Consumes: the full `piExecutor()` implementation (Tasks 1-3) end to end through a real `createTaskManager` with the real `spawn`.

- [ ] **Step 1: Write a gated smoke test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";

function piInstalled() {
  try {
    execFileSync("pi", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("live pi dispatch: real spawn, real event stream, real session continuation", { skip: !piInstalled() || !process.env.TASKFERRY_SMOKE_TEST_PROVIDER }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-tasks-smoke-"));
  fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "tasks.json"), "[]");
  const manager = createTaskManager({ stateDir, sandboxEnabled: false });
  const model = process.env.TASKFERRY_SMOKE_TEST_PROVIDER; // e.g. "minimax/MiniMax-M2.7"
  const dispatched = manager.dispatch({ prompt: "Reply with exactly: PONG", directory: process.cwd(), model, executor: "pi" });
  const settled = await manager.poll(dispatched.id, { timeoutMs: 60000 });
  assert.equal(settled.status, "done");
  const result = manager.result(dispatched.id, { fields: ["message", "sessionId"] });
  assert.ok(result.message.includes("PONG"));
  assert.ok(result.sessionId);

  // Confirm session continuation round-trips through the real pi binary.
  const continued = manager.dispatch({ prompt: "Reply with exactly: PONG2", directory: process.cwd(), model, executor: "pi", sessionId: result.sessionId });
  const settled2 = await manager.poll(continued.id, { timeoutMs: 60000 });
  assert.equal(settled2.status, "done");
});
```

This test is opt-in (`TASKFERRY_SMOKE_TEST_PROVIDER` unset ⇒ skipped) since it costs real API calls and requires real credentials — it is not part of the default `node --test` run, matching how a live-process test should be gated in this repo (confirm this pattern against any existing live-provider test before finalizing, per the "check the established pattern first" note above).

- [ ] **Step 2: Run it manually once, with credentials, to confirm it actually passes**

Run:
```bash
export PI_CODING_AGENT_DIR=$(mktemp -d)  # or your real pi config dir, if you want auth.json picked up
export TASKFERRY_SMOKE_TEST_PROVIDER="minimax/MiniMax-M2.7"
node --test src/executor.smoke.test.js
```
Expected: PASS (requires a real minimax API key reachable the same way the verification dispatches in this plan's research phase reached it — check `reference_secrets_env_chain` in memory, or however this repo's `pi` gets credentials, if the test fails with an auth error rather than an assertion failure).

- [ ] **Step 3: Commit**

```bash
git add src/executor.smoke.test.js
git commit -m "test(executor): add opt-in live smoke test for real pi dispatch and session continuation"
```

---

## Self-Review

**1. Spec coverage:**
- Architecture / write-time normalization → Task 7. ✓
- `WorkerExecutor` interface, `resolveExecutor` → Task 1. ✓
- `opencodeExecutor()` pure extraction → Task 1. ✓
- `piExecutor()` full implementation (spawn args, listModels, normalizeLogEvent, sandboxAuthFile) → Tasks 2-3. ✓
- CLI/RPC wiring (args.js, commands.js, protocol.js, daemon.js) → Task 8, including the daemon.js `task.advisor` gap the spec missed (Verified Finding #11). ✓
- Data model change (`Task.executorId`, default-on-load) → Task 5. ✓
- Error handling (`classifyProviderFailure` prefix threading) → Tasks 4 and 7 (Step 6 finishes the wiring once `task.executorId` exists). ✓
- Testing (executor.test.js, tasks.test.js additions, live smoke test) → Tasks 1-3, 6-7, 9, 10. ✓
- Deliberately deferred items (plugin registry, per-executor config namespace, `taskferry doctor` executor check, pi tool-isolation mechanism, raw-log side-channel) → none of these appear as tasks, matching the spec's explicit "out of scope" list. ✓
- Open questions from the spec (list-models format, auth.json path, session-continuation flags) → all three resolved with live evidence in "Verified findings" #6, #7, #9, and encoded directly into Tasks 2-3's implementations/tests rather than left as runtime TODOs. ✓

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" instances. Two spots intentionally show a value that gets replaced within the same task (Task 2 Step 1's `sandboxAuthFile` body, replaced in Step 2; Task 7 Step 1's sketch, replaced by the concrete version immediately below it) — both are explicit "replace this in the next step" scaffolding for review-diff clarity, not unfinished work, and both are followed by the real implementation in the same task before any commit step.

**3. Type/signature consistency:**
- `classifyProviderFailure(lines, errorBucketPrefix)` — consistent from its Task 4 definition through both Task 4 and Task 7 call sites.
- `WorkerExecutor.buildSpawnArgs(ctx: SpawnLaunchContext)` — consistent shape used in Task 1/2 factories and Task 7's `startTask` call site (all fields Task 7 passes — `isSummary`, `model`, `variant`, `launchDirectory`, `promptFilePath`, `snapshotPath`, `prompt`, `sessionId` — match the typedef added in Task 1).
- `WorkerExecutor.sandboxAuthFile({homeDir, runtimeDir, spawnEnv, existsFn}) → {extraRoBind, sandboxedDataHome}` — consistent across Task 1 (typedef + opencode impl), Task 2 (pi impl), Task 7 (call site).
- `WorkerExecutor.binaryName` — flagged mid-plan (Task 7 Step 4) as a real gap in the Task 1 draft typedef and immediately patched into both the typedef and both factories before being relied on, rather than left inconsistent.
- `DispatchLaunch.executor`/`SummaryLaunch.executor` — added in Task 5, populated in Task 6's `dispatch()`/`summarizeTask()`, consumed in Task 7's `startTask()`. Consistent.
- `defaultExecutor` (manager-level option) vs. `executor` (per-dispatch param name in `dispatch()`/CLI/RPC) — deliberately different names to distinguish "fallback used when a dispatch doesn't specify one" from "the specific executor this dispatch requested"; used consistently under those two distinct names throughout Tasks 5, 6, 8, 9.
