import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { makeManager, fakeChild } from "./tasks.test-helpers.js";

// A bwrap-shaped fake child with separate stdout/stderr streams and a real
// pid, distinct from fakeChild() (which only wires stdout) -- the gate reads
// both streams, so tests need both to exist as EventEmitters.
function fakeGateChild(pid = 9000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function dispatchAndSettleWithChanges({ directory, spawns, sandboxEnabled = true }) {
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => { const child = spawns.length === 0 ? fakeChild() : fakeGateChild(); spawns.push({ cmd, args, opts, child }); return child; },
    // buildManagerOptions() defaults overlayEnabled to false -- without this,
    // task.overlayDirs never gets set, startCheckGate's `!task.overlayDirs`
    // guard always no-ops, and every test below would see only one spawn.
    overlayEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    // Without this injection, the manager probes bwrap's overlay support at
    // startup against the host -- which fails in this CI sandbox (no real
    // bwrap), so requireOverlayCapability() throws and the dispatch never
    // gets far enough for the gate to be a thing. Injecting "supported"
    // mirrors tasks.changeset.test.js's existing convention.
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    runOverlayCommandFn: (command, args) => {
      // Simulate a real changeset: `git diff` (or the sh -c wrapper extraction
      // uses) reports non-empty output so extraction sets changesetStatus to
      // "pending" and startCheckGate() gets a chance to run.
      if (command === "bwrap") return { status: 0, stdout: FAKE_GATE_DIFF, stderr: "" };
      // resolvePreDispatchHead() (src/changeset.js) probes `git -C <dir>
      // rev-parse HEAD` through this same fn -- without a non-empty stdout
      // preDispatchHead stays null, isGitTarget in extractChangesetForTaskRecord
      // is false, and the hasChanges branch the gate is wired into never
      // runs. The post-extraction assertNoHeadDrift() re-check fires the same
      // probe again with the same shape; one branch handles both.
      if (args?.[0] === "-C") return { status: 0, stdout: FAKE_PRE_DISPATCH_HEAD, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    sandboxEnabled,
  });
  const dispatched = mgr.dispatch({ model: FAKE_GATE_MODEL, executor: "opencode", prompt: "hello", directory });
  spawns[0].child.emit("exit", 0, null); // settles the worker; extraction + startCheckGate run synchronously off this
  return { mgr, dispatched };
}
const FAKE_PRE_DISPATCH_HEAD = "abc123\n";
const FAKE_GATE_DIFF = "diff --git a/f b/f\n+changed\n";
const FAKE_GATE_MODEL = "opencode-go/minimax-m3";
const FAKE_GATE_CONFIG = `check = "npm test"\n`;
const TASKFERRY_CONFIG_FILENAME = ".taskferry.toml";

describe("startCheckGate", () => {
  test("no .taskferry.toml: checkStatus stays 'none', no second spawn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-none-"));
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    assert.equal(spawns.length, 1); // only the worker spawn, no gate spawn
    assert.equal(mgr.status(dispatched.id).checkStatus, undefined); // "none" is never surfaced
  });

  test("a declared check command spawns a second bwrap invocation over the same overlay after extraction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-spawn-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].cmd, "bwrap");
    assert.ok(spawns[1].args.includes("npm test"));
    assert.equal(mgr.status(dispatched.id).checkStatus, "running");
  });

  test("exit 0 settles checkStatus 'passed' with exit code recorded", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-pass-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    spawns[1].child.stdout.emit("data", Buffer.from("all good\n"));
    spawns[1].child.emit("exit", 0, null);
    const status = mgr.status(dispatched.id);
    assert.equal(status.checkStatus, "passed");
    assert.equal(status.checkExitCode, 0);
  });

  test("nonzero exit settles checkStatus 'failed' and captures the last 40 lines of combined output", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-fail-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    spawns[1].child.stdout.emit("data", Buffer.from(lines));
    spawns[1].child.emit("exit", 1, null);
    const status = mgr.status(dispatched.id);
    assert.equal(status.checkStatus, "failed");
    assert.equal(status.checkExitCode, 1);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    assert.equal(detail.checkOutputTail.split("\n").length, 40);
    assert.ok(detail.checkOutputTail.startsWith("line 10"));
  });

  test("a timed-out gate is killed and settles checkStatus 'timeout'", { concurrency: false }, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-timeout-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), `check = "npm test"\ncheck_timeout_seconds = 5\n`);
    const spawns = [];
    const signals = [];
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { const child = spawns.length === 0 ? fakeChild() : fakeGateChild(); spawns.push({ cmd, args, opts, child }); return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      // buildManagerOptions() only forwards `killFn` to createTaskManager,
      // not a `sendSignal` option -- the internal `sendSignal` binding wraps
      // sendSignalToProcess(pid, signal, { killFn: ctx.opts.killFn }), so the
      // fake must be injected at that seam or it's silently ignored and the
      // real default killFn (which throws) fires instead.
      killFn: (pid, signal) => signals.push({ pid, signal }),
      runOverlayCommandFn: (command, args) => {
        if (command === "bwrap") return { status: 0, stdout: FAKE_GATE_DIFF, stderr: "" };
        if (args?.[0] === "-C") return { status: 0, stdout: FAKE_PRE_DISPATCH_HEAD, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
const dispatched = mgr.dispatch({ model: FAKE_GATE_MODEL, executor: "opencode", prompt: "hello", directory });
    spawns[0].child.emit("exit", 0, null);
    t.mock.timers.tick(5000);
    assert.ok(signals.some((s) => s.signal === "SIGTERM"));
    // sendSignalToProcess tries the process-group form first (negative pid) --
    // this only reaches the sandboxed workload at all because the gate is
    // spawned `detached: true` (Step 3). A positive-pid-only signal here
    // would mean the fix regressed back to killing just the bwrap monitor.
    assert.ok(signals.some((s) => s.signal === "SIGTERM" && s.pid < 0), `expected a process-group SIGTERM (negative pid), got ${JSON.stringify(signals)}`);
    assert.ok(spawns[1].opts.detached === true, "gate child must be spawned detached so group-kill can reach it");
    spawns[1].child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).checkStatus, "timeout");
  });
});