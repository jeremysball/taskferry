import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { makeManager, fakeChild, preserveEnvVars, captureStderr } from "./tasks.test-helpers.js";

const WIDE_OPEN = {
  maxConcurrentTasks: 10,
  maxDispatchesPerWindow: 10,
  dispatchWindowMs: 60000,
  lowerdirStaggerMs: 0,
};

/** @param {number[]} children */
function recordingSpawn(children) {
  return () => {
    const child = fakeChild(9700 + children.length);
    children.push(child);
    return child;
  };
}

/** @param {number} percent */
function usage(percent) {
  return { percent, limitBytes: 1, availableBytes: 1, cgroupLimited: false };
}

/** @param {import("node:test").TestContext} t */
function clearMemoryAdmissionEnv(t) {
  preserveEnvVars(t, ["TASKFERRY_MEMORY_ADMISSION_PERCENT"]);
  delete process.env.TASKFERRY_MEMORY_ADMISSION_PERCENT;
}

describe("memory admission gate", () => {
  test("queues new launches at the default 85% threshold and recovers automatically after memory falls", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    clearMemoryAdmissionEnv(t);
    try {
      const children = [];
      let percent = 84;
      const mgr = makeManager({
        ...WIDE_OPEN,
        readMemoryUsageFn: () => usage(percent),
        spawnFn: recordingSpawn(children),
      });

      const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
      assert.equal(mgr.status(first.id).status, "running", "84% is below the default 85% threshold");
      assert.equal(children.length, 1);

      percent = 85;
      const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
      assert.equal(mgr.status(second.id).status, "queued", "85% is at the threshold and must queue");
      assert.equal(children.length, 1, "a blocked launch must not spawn a child");

      percent = 40;
      t.mock.timers.tick(1000);
      assert.equal(mgr.status(second.id).status, "running", "the memory poll must retry and launch once usage falls");
      assert.equal(children.length, 2);

      children[0].emit("exit", 0, null);
      children[1].emit("exit", 0, null);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("honors a configured threshold instead of the 85% default", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const children = [];
      let percent = 50;
      const mgr = makeManager({
        ...WIDE_OPEN,
        memoryAdmissionPercent: 50,
        readMemoryUsageFn: () => usage(percent),
        spawnFn: recordingSpawn(children),
      });

      const queued = mgr.dispatch({ prompt: "queued", directory: os.tmpdir() });
      assert.equal(mgr.status(queued.id).status, "queued", "the configured 50% threshold binds before the default 85%");

      percent = 49;
      t.mock.timers.tick(1000);
      assert.equal(mgr.status(queued.id).status, "running");
      children[0].emit("exit", 0, null);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("reads the threshold from config when no option or env override is set", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    clearMemoryAdmissionEnv(t);
    try {
      const children = [];
      const mgr = makeManager({
        ...WIDE_OPEN,
        config: { memoryAdmissionPercent: 60 },
        readMemoryUsageFn: () => usage(60),
        spawnFn: recordingSpawn(children),
      });
      const queued = mgr.dispatch({ prompt: "queued", directory: os.tmpdir() });
      assert.equal(mgr.status(queued.id).status, "queued", "config memoryAdmissionPercent: 60 must be used");
      assert.equal(children.length, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("never stops an already-running worker when memory crosses the threshold", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    clearMemoryAdmissionEnv(t);
    try {
      const children = [];
      let percent = 10;
      const mgr = makeManager({
        ...WIDE_OPEN,
        readMemoryUsageFn: () => usage(percent),
        spawnFn: recordingSpawn(children),
      });
      const running = mgr.dispatch({ prompt: "running", directory: os.tmpdir() });
      assert.equal(mgr.status(running.id).status, "running");

      percent = 99;
      const queued = mgr.dispatch({ prompt: "queued", directory: os.tmpdir() });
      assert.equal(mgr.status(running.id).status, "running", "the existing worker keeps running");
      assert.equal(mgr.status(queued.id).status, "queued");
      assert.equal(children.length, 1, "only the new launch is withheld");

      children[0].emit("exit", 0, null);
      assert.equal(mgr.status(queued.id).status, "queued", "a freed slot does not bypass a still-high memory reading");

      percent = 10;
      t.mock.timers.tick(1000);
      assert.equal(mgr.status(queued.id).status, "running");
      children[1].emit("exit", 0, null);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("preserves FIFO ordering when blocked launches resume", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    clearMemoryAdmissionEnv(t);
    try {
      const children = [];
      let percent = 99;
      const mgr = makeManager({
        ...WIDE_OPEN,
        maxConcurrentTasks: 2,
        readMemoryUsageFn: () => usage(percent),
        spawnFn: recordingSpawn(children),
      });
      const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
      const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
      const third = mgr.dispatch({ prompt: "third", directory: os.tmpdir() });
      assert.deepEqual(
        [first, second, third].map((d) => mgr.status(d.id).status),
        ["queued", "queued", "queued"]
      );
      assert.equal(children.length, 0);

      percent = 10;
      t.mock.timers.tick(1000);
      assert.deepEqual(
        [first, second, third].map((d) => mgr.status(d.id).status),
        ["running", "running", "queued"],
        "memory recovery must reuse the existing FIFO queue and concurrency cap"
      );

      children[0].emit("exit", 0, null);
      assert.equal(mgr.status(third.id).status, "running", "the third launch follows after a slot frees");
      children[1].emit("exit", 0, null);
      children[2].emit("exit", 0, null);
    } finally {
      t.mock.timers.reset();
    }
  });

  test("cancelling a queued task while memory-blocked leaves the surviving queue intact", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    clearMemoryAdmissionEnv(t);
    try {
      const children = [];
      let percent = 99;
      const mgr = makeManager({
        ...WIDE_OPEN,
        readMemoryUsageFn: () => usage(percent),
        spawnFn: recordingSpawn(children),
      });
      const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
      const cancelled = mgr.dispatch({ prompt: "cancel me", directory: os.tmpdir() });
      assert.equal(mgr.status(cancelled.id).status, "queued");

      assert.equal(mgr.cancel(cancelled.id).status, "cancelled");
      assert.equal(mgr.status(first.id).status, "queued", "cancelling one queued task must not launch another while blocked");

      percent = 10;
      t.mock.timers.tick(1000);
      assert.equal(mgr.status(first.id).status, "running");
      assert.equal(mgr.status(cancelled.id).status, "cancelled");
      assert.equal(children.length, 1);
      children[0].emit("exit", 0, null);
    } finally {
      t.mock.timers.reset();
    }
  });

});

describe("memory admission gate failure handling", () => {
  test("fails open when the metric read throws, so queued work is not stranded", () => {
    const children = [];
    const mgr = makeManager({
      ...WIDE_OPEN,
      readMemoryUsageFn: () => { throw new Error("metric unavailable"); },
      spawnFn: recordingSpawn(children),
    });
    const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
    assert.equal(mgr.status(first.id).status, "running", "a broken metric must not block the first launch");
    assert.equal(mgr.status(second.id).status, "running", "a broken metric must not block subsequent launches");
    children[0].emit("exit", 0, null);
    children[1].emit("exit", 0, null);
  });

  test("warns at most once per minute on a persistent metric failure", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    clearMemoryAdmissionEnv(t);
    try {
      const children = [];
      const stderr = captureStderr(() => {
        const mgr = makeManager({
          ...WIDE_OPEN,
          maxConcurrentTasks: 1,
          readMemoryUsageFn: () => { throw new Error("metric unavailable"); },
          spawnFn: recordingSpawn(children),
        });
        mgr.dispatch({ prompt: "first", directory: os.tmpdir() });
        mgr.dispatch({ prompt: "second", directory: os.tmpdir() });
        t.mock.timers.tick(1000);
        t.mock.timers.tick(59_000);
        children[0].emit("exit", 0, null);
      });
      assert.equal(stderr.match(/memory admission metric read failed/g)?.length, 2, "one warning at first failure and one after 60s, not one per poll");
    } finally {
      t.mock.timers.reset();
    }
  });

  test("TASKFERRY_MEMORY_ADMISSION_PERCENT overrides the config-file threshold", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    preserveEnvVars(t, ["TASKFERRY_MEMORY_ADMISSION_PERCENT"]);
    process.env.TASKFERRY_MEMORY_ADMISSION_PERCENT = "30";
    try {
      const children = [];
      const mgr = makeManager({
        ...WIDE_OPEN,
        config: { memoryAdmissionPercent: 90 },
        readMemoryUsageFn: () => usage(30),
        spawnFn: recordingSpawn(children),
      });
      const queued = mgr.dispatch({ prompt: "queued", directory: os.tmpdir() });
      assert.equal(mgr.status(queued.id).status, "queued", "the env override (30) wins over config (90)");
      assert.equal(children.length, 0);
    } finally {
      t.mock.timers.reset();
    }
  });
});
