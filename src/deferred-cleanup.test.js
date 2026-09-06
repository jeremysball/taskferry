// Deferred file cleanup: paths registered against a task and reaped when the
// ferry settles, rather than when its child process exits. The distinction is
// the whole feature -- see src/deferred-cleanup.js for why child exit is too
// early and an in-process closure is too fragile.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeferredCleanupReapable, registerDeferredCleanup, runDeferredCleanup } from "./deferred-cleanup.js";
import { createTaskManager, sweepDeferredCleanupFor, sweepOrphanedUvDirsFor } from "./tasks.js";
import { makeManager, fakeChild, trackManager, mkdtempTracked, AXI_TASKS_TEST_DIR, AXI_TASKS_CACHE_DIR } from "./tasks.test-helpers.js";

const A = "/tmp/deferred-a";
const FAKE_CACHE = "/tmp/fake-cache-uv";
const SETTLED = "settled";
const UNKNOWN = "unknown";
const OTHER_DAEMON = "other-daemon";
const B = "/tmp/deferred-b";

describe("registerDeferredCleanup", () => {
  test("creates the list lazily and dedupes repeat registrations", () => {
    const task = {};
    registerDeferredCleanup(task, A, B);
    registerDeferredCleanup(task, A);
    assert.deepEqual(task.deferredCleanup, [A, B]);
  });

  test("rejects a relative path rather than storing something rm -rf will resolve against cwd", () => {
    const task = {};
    assert.throws(() => registerDeferredCleanup(task, "relative/dir"), /must be absolute/);
    assert.equal(task.deferredCleanup, undefined);
  });
});

describe("runDeferredCleanup", () => {
  test("removes every registered path and clears the list", () => {
    const removed = [];
    const task = {};
    registerDeferredCleanup(task, A, B);
    const result = runDeferredCleanup(task, { rmFn: (target) => removed.push(target) });
    assert.deepEqual(removed, [A, B]);
    assert.deepEqual(result.removed, [A, B]);
    assert.equal(task.deferredCleanup, undefined);
  });

  test("keeps a failed path on the list so a later drain retries it", () => {
    const task = {};
    registerDeferredCleanup(task, A, B);
    const result = runDeferredCleanup(task, {
      rmFn: (target) => { if (target === A) throw new Error("EBUSY: device or resource busy"); },
    });
    assert.deepEqual(task.deferredCleanup, [A]);
    assert.deepEqual(result.removed, [B]);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /EBUSY/);

    // The retry succeeds and the list empties.
    runDeferredCleanup(task, { rmFn: () => {} });
    assert.equal(task.deferredCleanup, undefined);
  });

  test("counts an already-missing path as removed", () => {
    const task = {};
    registerDeferredCleanup(task, A);
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    const result = runDeferredCleanup(task, { rmFn: () => { throw enoent; } });
    assert.deepEqual(result.removed, [A]);
    assert.equal(task.deferredCleanup, undefined);
  });

  test("drops a malformed entry instead of retrying it forever", () => {
    // tasks.json is a plain file an operator can hand-edit, and this function
    // calls rm -rf on what it finds there.
    const task = { deferredCleanup: ["not/absolute", 42] };
    const result = runDeferredCleanup(task, { rmFn: () => { throw new Error("must not be called"); } });
    assert.equal(result.removed.length, 0);
    assert.equal(result.failed.length, 2);
    assert.equal(task.deferredCleanup, undefined);
  });

  test("is a no-op on a task that never registered anything", () => {
    const task = { id: "t1" };
    const result = runDeferredCleanup(task, { rmFn: () => { throw new Error("must not be called"); } });
    assert.deepEqual(result, { removed: [], failed: [] });
    assert.equal("deferredCleanup" in task, false);
  });
});

describe("isDeferredCleanupReapable", () => {
  test("a pending changeset is never reapable: its overlay is live and its gate is re-runnable", () => {
    assert.equal(isDeferredCleanupReapable({ status: "done", changesetStatus: "pending" }), false);
  });

  test("a running or queued task is never reapable", () => {
    assert.equal(isDeferredCleanupReapable({ status: "running" }), false);
    assert.equal(isDeferredCleanupReapable({ status: "queued" }), false);
  });

  test("a settled task with a resolved changeset is reapable", () => {
    for (const status of ["done", "crashed", "cancelled"]) {
      for (const changesetStatus of ["none", "accepted", "rejected", undefined]) {
        assert.equal(isDeferredCleanupReapable({ status, changesetStatus }), true, `${status}/${changesetStatus}`);
      }
    }
  });
});

describe("sweepDeferredCleanupFor", () => {
  test("drains settled tasks a killed daemon never got to, and leaves pending ones alone", () => {
    const removed = [];
    const persisted = [];
    const tasks = new Map([
      ["settled", { id: "settled", status: "done", changesetStatus: "accepted", deferredCleanup: ["/tmp/settled"] }],
      ["pending", { id: "pending", status: "done", changesetStatus: "pending", deferredCleanup: ["/tmp/pending"] }],
      ["running", { id: "running", status: "running", deferredCleanup: ["/tmp/running"] }],
      ["empty", { id: "empty", status: "done" }],
    ]);
    // The real drain runs against the filesystem; point it at paths that do
    // not exist so rmSync's force flag makes it a no-op, and record intent
    // through persistTask instead.
    sweepDeferredCleanupFor({ tasks, persistTask: (id) => persisted.push(id) });
    assert.deepEqual(persisted, ["settled"]);
    assert.equal(tasks.get("settled").deferredCleanup, undefined);
    assert.deepEqual(tasks.get("pending").deferredCleanup, ["/tmp/pending"]);
    assert.deepEqual(tasks.get("running").deferredCleanup, ["/tmp/running"]);
    assert.equal(removed.length, 0);
  });
});

describe("sweepOrphanedUvDirsFor", () => {
  test("reclaims settled and unknown ids, keeps live tasks and another daemon's ids", () => {
    const entries = {
      "uv-cache": [SETTLED, "pending", "running", UNKNOWN, OTHER_DAEMON, ".", ".."],
      "uv-tools": [SETTLED, UNKNOWN],
    };
    const tasks = new Map([
      [SETTLED, { id: SETTLED, status: "done", changesetStatus: "accepted" }],
      ["pending", { id: "pending", status: "done", changesetStatus: "pending" }],
      ["running", { id: "running", status: "running" }],
    ]);
    // taskferry#515: an id this daemon's map has never seen but tasks.json
    // records belongs to a different, live daemon.
    const persistedTasks = new Map([[OTHER_DAEMON, { id: OTHER_DAEMON }]]);
    const removed = [];
    sweepOrphanedUvDirsFor({
      tasks,
      persistedTasks,
      cacheDir: FAKE_CACHE,
      readdirFn: (dir) => entries[path.basename(dir)] ?? [],
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    assert.deepEqual(removed.sort(), [
      "uv-cache/settled",
      "uv-cache/unknown",
      "uv-tools/settled",
      "uv-tools/unknown",
    ]);
  });

  test("a missing bucket directory is not an error", () => {
    assert.doesNotThrow(() => sweepOrphanedUvDirsFor({
      cacheDir: path.join(os.tmpdir(), "axi-no-such-cache-dir"),
      tasks: new Map(),
      persistedTasks: new Map(),
      readdirFn: (dir) => fs.readdirSync(dir),
    }));
  });
});

describe("uv dirs are registered on dispatch and reaped at settlement", () => {
  test("a sandboxed dispatch registers both uv dirs and removes them when the child settles", () => {
    let child = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const mgr = makeManager({
      spawnFn: () => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      // No overlay: extractChangesetForTask returns early for a task with no
      // overlayDirs, so nothing on the accept/reject path ever runs and the
      // child-settlement drain is the only one that fires.
      overlayEnabled: false,
      resolveGitCommonDirFn: () => null,
      cacheDir,
    });

    const dispatched = mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const uvCacheDir = path.join(cacheDir, "uv-cache", dispatched.id);
    const uvToolsDir = path.join(cacheDir, "uv-tools", dispatched.id);
    assert.equal(fs.existsSync(uvCacheDir), true);
    assert.equal(fs.existsSync(uvToolsDir), true);

    child.emit("exit", 0, null);

    assert.equal(fs.existsSync(uvCacheDir), false, "uv cache dir should be reaped at settlement");
    assert.equal(fs.existsSync(uvToolsDir), false, "uv tools dir should be reaped at settlement");
  });

  test("the boot sweep reclaims uv dirs left by tasks that predate the deferred list", () => {
    // The 30G case: 1106 per-task uv-cache dirs whose tasks settled long ago
    // and whose records carry no deferredCleanup at all, because they were
    // dispatched before the mechanism existed.
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-uv-boot-");
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR + "-boot-");
    const settledId = `oc_uv_settled_${process.pid}`;
    const pendingId = `oc_uv_pending_${process.pid}`;
    for (const bucket of ["uv-cache", "uv-tools"]) {
      for (const id of [settledId, pendingId, `oc_uv_unknown_${process.pid}`]) {
        fs.mkdirSync(path.join(cacheDir, bucket, id), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, bucket, id, "wheel.bin"), "x");
      }
    }
    fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify([
      { id: settledId, status: "done", changesetStatus: "accepted" },
      { id: pendingId, status: "done", changesetStatus: "pending" },
    ]));

    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_TEST_DIR + "-uv-boot-overlay-"),
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
    }), { autoModel: false });
    mgr.list();

    assert.equal(fs.existsSync(path.join(cacheDir, "uv-cache", settledId)), false);
    assert.equal(fs.existsSync(path.join(cacheDir, "uv-tools", settledId)), false);
    assert.equal(fs.existsSync(path.join(cacheDir, "uv-cache", `oc_uv_unknown_${process.pid}`)), false);
    assert.equal(fs.existsSync(path.join(cacheDir, "uv-cache", pendingId)), true, "a pending changeset still owns its uv dirs");
    mgr.close();
  });
});
