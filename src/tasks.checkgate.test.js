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

function dispatchAndSettleWithChanges({ directory, spawns, cacheDir, sandboxEnabled = true }) {
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => {
      const child = spawns.length === 0 ? fakeChild() : fakeGateChild();
      spawns.push({ cmd, args, opts, child });
      return child;
    },
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
    cacheDir,
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

  test("the gate's bwrap re-binds the worker's per-task uv cache/tool dirs and re-points the env at them (taskferry#426)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-uv-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), "check = \"uv run pytest\"\n");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-uv-cache-"));
    const spawns = [];
    const { dispatched } = dispatchAndSettleWithChanges({ spawns, directory, cacheDir });
    const uvCacheDir = path.join(cacheDir, "uv-cache", dispatched.id);
    const uvToolsDir = path.join(cacheDir, "uv-tools", dispatched.id);
    // The worker's bwrap argv carried the same dirs (assessed on spawn[0]).
    const [worker, gate] = spawns;
    for (const dir of [uvCacheDir, uvToolsDir]) {
      const gateBind = gate.args.indexOf(dir);
      assert.notEqual(gateBind, -1, `expected gate bwrap to bind ${dir}`);
      assert.equal(gate.args[gateBind - 1], "--bind");
      const workerBind = worker.args.indexOf(dir);
      assert.notEqual(workerBind, -1, `expected worker bwrap to bind ${dir}`);
      assert.equal(worker.args[workerBind - 1], "--bind");
    }
    assert.equal(gate.opts.env.UV_CACHE_DIR, uvCacheDir);
    assert.equal(gate.opts.env.UV_TOOL_DIR, uvToolsDir);
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

  test("a failed gate with a trailing newline captures the last 40 real lines, not 39 lines plus a trailing blank", () => {
    // Regression: lastLines(text) used to `text.split("\n").slice(-n)`, which
    // counts the final empty string after a trailing "\n" as a line -- so 45
    // real lines + "\n" returned 39 lines + a trailing "" instead of all 40
    // of lines 5..44. Real child-process output always ends with "\n", so
    // the bug dropped one real line off every failing gate's tail.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-trailing-newline-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") + "\n";
    spawns[1].child.stdout.emit("data", Buffer.from(lines));
    spawns[1].child.emit("exit", 1, null);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    assert.equal(detail.checkOutputTail.split("\n").length, 40);
    assert.ok(detail.checkOutputTail.startsWith("line 5"), `expected the 40-line tail to start at "line 5", got: ${JSON.stringify(detail.checkOutputTail.slice(0, 40))}`);
    assert.ok(detail.checkOutputTail.endsWith("line 44"), `expected the tail to include the last real line "line 44", got: ${JSON.stringify(detail.checkOutputTail.slice(-40))}`);
    assert.ok(!detail.checkOutputTail.endsWith("\n"), `expected no trailing blank line, got a tail ending with newline`);
  });

  test("a chatty gate emitting 4-byte UTF-8 output is capped by real byte count, not UTF-16 code units", () => {
    // Regression: appendBoundedOutput measured by String.length (UTF-16 code
    // units). A 4-byte UTF-8 char like 🎉 is 2 UTF-16 units, so a check
    // command spamming emoji could grow to ~2x the intended 256 KiB byte
    // budget before the cap engaged. Verify the byte count of the resulting
    // checkOutputTail stays under CHECK_GATE_OUTPUT_CAP_BYTES, and that the
    // string is still valid (the byte-level cut may land mid-codepoint; the
    // tolerant UTF-8 decoder must not throw).
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-utf8-cap-"));
    fs.writeFileSync(path.join(directory, TASKFERRY_CONFIG_FILENAME), FAKE_GATE_CONFIG);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ spawns, directory });
    // Each 🎉 is 4 UTF-8 bytes / 2 UTF-16 code units. 70000 * 4 = 280000
    // bytes, comfortably over the 256 KiB cap. Emit in chunks to exercise
    // the append path too, not just the trim path.
    const emoji = "🎉";
    const chunk = emoji.repeat(1000);
    for (let i = 0; i < 70; i++) spawns[1].child.stdout.emit("data", Buffer.from(chunk, "utf8"));
    spawns[1].child.emit("exit", 1, null);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    const bytes = Buffer.byteLength(detail.checkOutputTail, "utf8");
    // Cap is enforced on real UTF-8 bytes, not on String.length (which
    // would let the tail grow to ~512 KiB before tripping).
    assert.ok(bytes <= 256 * 1024, `expected at most 256 KiB of UTF-8 bytes, got ${bytes}`);
    // The byte-level cut can land mid-codepoint; Buffer.toString("utf8") on
    // a Buffer.from(..., "utf8") with a multi-byte cut uses the tolerant
    // replacement decoder by default -- a non-throwing result here proves
    // the round-trip is well-formed as a JS string.
    assert.equal(typeof detail.checkOutputTail, "string");
    // The cap trimmed the front, so the tail must still be entirely emoji
    // (or the Unicode replacement char at a mid-codepoint byte-cut). Use
    // the `u` flag so `🎉` (a 2-code-unit surrogate pair) is matched as one
    // codepoint and `$` anchors correctly at the string's last codepoint.
    assert.match(detail.checkOutputTail, /^[🎉\uFFFD]*$/u);
  });
});