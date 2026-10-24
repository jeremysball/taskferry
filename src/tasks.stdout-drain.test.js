import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createTaskManager } from "./tasks.js";
import { makeManager, fakeChild, trackManager, mkdtempTracked, preserveEnvVars, waitFor } from "./tasks.test-helpers.js";

// A child whose stdout is a real stream, so `exit` and the remaining stdout
// chunks can be ordered the way a busy event loop orders them. The default
// fakeChild() stdout is a bare EventEmitter that never ends.
function pipedChild(pid) {
  const child = fakeChild(pid);
  child.stdout = new PassThrough();
  return child;
}

const FIRST_FINAL = "first-task-final-line";
const SECOND_LINE = "second-task-own-line";
const STRAGGLER = "straggler-after-settlement";
const TAIL = "tail-without-newline";
const TASK_NEVER_SETTLED = "task never settled";
const GRACE_MS = 40;

function readLog(task) {
  return fs.readFileSync(task.logPath, "utf8");
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

describe("settlement waits for the child's stdout to drain", () => {
  test("an exited child stays running until its stdout ends, then settles", async () => {
    const child = pipedChild(7001);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.emit("exit", 0, null);
    assert.equal(mgr.status(task.id).status, "running");

    child.stdout.end(`${FIRST_FINAL}\n`);
    await waitFor(() => mgr.status(task.id).status === "done", "task never settled after stdout ended");
    assert.equal(countOf(readLog(task), FIRST_FINAL), 1);
  });

  test("output read after the exit event lands in the exited task's own log and not in the next task's", async () => {
    const first = pipedChild(7011);
    const second = pipedChild(7012);
    const spawned = [first, second];
    const mgr = makeManager({ spawnFn: () => spawned.shift(), killFn: () => {}, maxConcurrentTasks: 1 });
    const a = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const b = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });

    first.emit("exit", 0, null);
    first.stdout.end(`${FIRST_FINAL}\n`);
    await waitFor(() => mgr.status(b.id).status === "running", "the queued task never launched");

    second.stdout.end(`${SECOND_LINE}\n`);
    second.emit("exit", 0, null);
    await waitFor(() => mgr.status(b.id).status === "done", "the second task never settled");

    const logA = readLog(a);
    const logB = readLog(b);
    assert.equal(countOf(logA, FIRST_FINAL), 1);
    assert.equal(countOf(logB, SECOND_LINE), 1);
    assert.equal(countOf(logB, FIRST_FINAL), 0);
  });

  test("a stdout that closes without ending settles the exit", async () => {
    const child = pipedChild(7021);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: 60000 });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.emit("exit", 0, null);
    assert.equal(mgr.status(task.id).status, "running");
    child.stdout.destroy();
    await waitFor(() => mgr.status(task.id).status === "done", "destroying stdout did not settle the exit");
  });

  test("a bare EventEmitter stdout has no end to wait for, so exit settles at once", () => {
    const child = fakeChild(7031);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    assert.equal(mgr.status(task.id).status, "running");
    child.emit("exit", 0, null);
    assert.equal(mgr.status(task.id).status, "done");
  });

  test("a second exit event while the first is pending does not settle early", async () => {
    const child = pipedChild(7041);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: 60000 });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.emit("exit", 0, null);
    child.emit("exit", 1, null);
    assert.equal(mgr.status(task.id).status, "running");
    child.stdout.end(`${FIRST_FINAL}\n`);
    await waitFor(() => mgr.status(task.id).status === "done", "task never settled after stdout ended");
    assert.equal(mgr.status(task.id).exitCode, 0);
  });
});

describe("a stdout that never ends", () => {
  test("settles after the drain grace, flushes the partial tail, stops reading, and says so", async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
    const child = pipedChild(7101);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: GRACE_MS });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.stdout.write(TAIL);
    child.emit("exit", 0, null);
    assert.equal(mgr.status(task.id).status, "running");

    await waitFor(() => mgr.status(task.id).status === "done", "the drain grace never settled the task");
    assert.equal(child.stdout.destroyed, true);
    assert.equal(countOf(readLog(task), TAIL), 1);
    assert.match(errors.join("\n"), new RegExp(`task ${task.id} stdout was still open ${GRACE_MS}ms after the child exited`));
  });

  test("the watchdog does not fail a clean exit during the drain window", async (t) => {
    t.mock.method(console, "error", () => {});
    const child = pipedChild(7112);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      stdoutDrainGraceMs: 400,
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(mgr.status(task.id).status, "running");
    assert.equal(mgr.status(task.id).failureReason, null);

    child.stdout.end();
    await waitFor(() => mgr.status(task.id).status === "done", "the clean exit settled as crashed");
    assert.equal(mgr.status(task.id).failureReason, null);
  });

  test("a clean drain prints no grace message", async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
    const child = pipedChild(7111);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: GRACE_MS });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.emit("exit", 0, null);
    child.stdout.end(`${FIRST_FINAL}\n`);
    await waitFor(() => mgr.status(task.id).status === "done", TASK_NEVER_SETTLED);
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    assert.equal(errors.filter((line) => line.includes("stdout was still open")).length, 0);
  });
});

describe("cancelling and closing during the drain window", () => {
  test("cancel settles the recorded exit instead of overwriting it with cancelled", async () => {
    const child = pipedChild(7121);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: 60000 });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.stdout.write(`${FIRST_FINAL}\n`);
    child.emit("exit", 0, null);
    const cancelled = mgr.cancel(task.id);
    assert.match(cancelled.note, /already exited/);
    assert.equal(mgr.status(task.id).status, "done");
    assert.equal(countOf(readLog(task), FIRST_FINAL), 1);
  });

  test("close settles a pending drain before persisting, so a restart never sees a dead pid as running", async () => {
    const child = pipedChild(7122);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: 60000 });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.stdout.write(`${FIRST_FINAL}\n`);
    child.emit("exit", 0, null);
    assert.equal(mgr.status(task.id).status, "running");
    mgr.close();
    assert.equal(mgr.status(task.id).status, "done");
    assert.equal(countOf(readLog(task), FIRST_FINAL), 1);
  });
});

describe("stdout decoding across chunk boundaries", () => {
  test("a multi-byte character split between two chunks is not replaced with U+FFFD", async () => {
    const child = pipedChild(7131);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: 60000 });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.stdout.write(Buffer.from([0xf0, 0x9f]));
    child.stdout.write(Buffer.from([0x98, 0x80, 0x21, 0x0a]));
    child.emit("exit", 0, null);
    child.stdout.end();

    await waitFor(() => mgr.status(task.id).status === "done", TASK_NEVER_SETTLED);
    const log = readLog(task);
    assert.equal(countOf(log, "\u{1F600}!"), 1);
    assert.equal(countOf(log, "\uFFFD"), 0);
  });
});

describe("a log write that fails", () => {
  test("is recorded on the task without turning a clean exit into a crash", async (t) => {
    const realWriteSync = fs.writeSync;
    t.mock.method(fs, "writeSync", (fd, data, ...rest) => {
      if (typeof data === "string" && data.includes(FIRST_FINAL)) throw new Error("ENOSPC");
      return realWriteSync(fd, data, ...rest);
    });
    t.mock.method(console, "error", () => {});
    const child = pipedChild(7141);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {}, stdoutDrainGraceMs: 60000 });
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir() });

    child.stdout.write(`${FIRST_FINAL}\n`);
    child.emit("exit", 0, null);
    child.stdout.end();

    await waitFor(() => mgr.status(task.id).status === "done", TASK_NEVER_SETTLED);
    const status = mgr.status(task.id);
    assert.equal(status.failureReason, "log_write_failed");
    assert.match(status.failureDetail, /could not write this task's log/);
  });
});

describe("a real child process", () => {
  test("a pipe-holding descendant cannot leak its late output into the next task's log", async () => {
    const script = `printf 'final-line\\n'; (sleep 0.15; printf 'straggler-line\\n') & exit 0`;
    const mgr = makeManager({
      spawnFn: (_cmd, _args, opts) => spawn("sh", ["-c", script], { ...opts, stdio: ["ignore", "pipe", opts.stdio[2]] }),
      killFn: process.kill.bind(process),
      stdoutDrainGraceMs: GRACE_MS,
      maxConcurrentTasks: 1,
    });
    const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });

    await waitFor(() => mgr.status(first.id).status === "done", "the first real child never settled");
    await waitFor(() => mgr.status(second.id).status === "done", "the second real child never settled");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const logA = readLog(first);
    const logB = readLog(second);
    assert.equal(countOf(logA, "final-line"), 1);
    assert.equal(countOf(logA, "straggler-line"), 0);
    assert.equal(countOf(logB, "final-line"), 1);
    assert.equal(countOf(logB, "straggler-line"), 0);
  });
});

describe("a write after settlement", () => {
  test("is dropped, so it cannot reach the next task's log through a reused fd", async () => {
    const first = pipedChild(7201);
    const second = pipedChild(7202);
    const spawned = [first, second];
    const mgr = makeManager({ spawnFn: () => spawned.shift(), killFn: () => {}, maxConcurrentTasks: 1 });
    const a = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const b = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });

    first.stdout.end(`${FIRST_FINAL}\n`);
    await waitFor(() => first.stdout.readableEnded, "first stdout never ended");
    first.emit("exit", 0, null);
    assert.equal(mgr.status(a.id).status, "done");
    assert.equal(mgr.status(b.id).status, "running");

    second.stdout.emit("data", Buffer.from(`${SECOND_LINE}\n`));
    first.stdout.emit("data", Buffer.from(`${STRAGGLER}\n`));

    const logB = readLog(b);
    assert.equal(countOf(logB, SECOND_LINE), 1);
    assert.equal(countOf(logB, STRAGGLER), 0);
    assert.equal(countOf(readLog(a), STRAGGLER), 0);
    second.stdout.end();
    second.emit("exit", 0, null);
  });
});

describe("stdoutDrainGraceMs resolution", () => {
  function managerWith(t, { option, env, config }) {
    t.mock.method(console, "error", () => {});
    const child = pipedChild(7301);
    preserveEnvVars(t, ["TASKFERRY_STDOUT_DRAIN_GRACE_MS"]);
    if (env === undefined) delete process.env.TASKFERRY_STDOUT_DRAIN_GRACE_MS;
    else process.env.TASKFERRY_STDOUT_DRAIN_GRACE_MS = env;
    const mgr = trackManager(createTaskManager({
      config,
      stateDir: mkdtempTracked("axi-drain-grace-"),
      sandboxEnabled: false,
      spawnFn: () => child,
      killFn: () => {},
      stdoutDrainGraceMs: option,
    }));
    t.after(() => child.stdout.destroy());
    return { mgr, child };
  }

  // A resolved grace of 40ms settles inside the wait below; the 5000ms default
  // and the 60000ms decoys do not.
  async function settlesQuickly(mgr, child) {
    const task = mgr.dispatch({ prompt: "p", directory: os.tmpdir(), model: "m" });
    child.emit("exit", 0, null);
    await waitFor(() => mgr.status(task.id).status === "done", "the resolved grace was not the 40ms one", 1500);
    return mgr.status(task.id).status;
  }

  test("the option wins over the env var", async (t) => {
    const { mgr, child } = managerWith(t, { option: GRACE_MS, env: "60000", config: { stdoutDrainGraceMs: 60000 } });
    assert.equal(await settlesQuickly(mgr, child), "done");
  });

  test("the env var wins over the config key", async (t) => {
    const { mgr, child } = managerWith(t, { env: String(GRACE_MS), config: { stdoutDrainGraceMs: 60000 } });
    assert.equal(await settlesQuickly(mgr, child), "done");
  });

  test("the config key is used when the env var is unset", async (t) => {
    const { mgr, child } = managerWith(t, { config: { stdoutDrainGraceMs: GRACE_MS } });
    assert.equal(await settlesQuickly(mgr, child), "done");
  });
});
