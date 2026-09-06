import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeHousekeeping, overlayPointerIsStale, pendingChangesetIsApplicable } from "./housekeeping.js";

const GONE = "/run/user/1000/taskferry/overlay/taskferry-cow-gone";
const LIVE = "/run/user/1000/taskferry/overlay/taskferry-cow-live";
const PATCH = "/home/u/.local/state/taskferry/diffs/a.patch";
const CACHE_DIR = "/home/u/.cache/taskferry";
const TASKS_FILE = "/home/u/.local/state/taskferry/tasks.json";

/** @param {string[]} present */
function existsIn(present) {
  const set = new Set(present);
  return (/** @type {string} */ p) => set.has(p);
}

function overlayTask({ status = "done", root = GONE }) {
  return { status, overlayDirs: { root, tmpRoot: "/run/user/1000/taskferry/overlay" } };
}

describe("overlayPointerIsStale", () => {
  test("a settled task pointing at a directory that is gone is stale", () => {
    assert.equal(overlayPointerIsStale(overlayTask({}), existsIn([LIVE])), true);
  });

  test("a settled task pointing at a directory that exists is not stale", () => {
    assert.equal(overlayPointerIsStale(overlayTask({ root: LIVE }), existsIn([LIVE])), false);
  });

  test("a task with no overlay pointer is never stale", () => {
    assert.equal(overlayPointerIsStale({ status: "done", overlayDirs: null }, existsIn([])), false);
  });

  test("running and queued tasks are exempt: the record is persisted before the child spawns", () => {
    assert.equal(overlayPointerIsStale(overlayTask({ status: "running" }), existsIn([])), false);
    assert.equal(overlayPointerIsStale(overlayTask({ status: "queued" }), existsIn([])), false);
  });
});

describe("pendingChangesetIsApplicable", () => {
  test("a pending changeset with a surviving patch stays applicable after the overlay is gone", () => {
    const task = { changesetStatus: "pending", diffPath: PATCH, overlayDirs: { root: GONE, tmpRoot: "/t" } };
    assert.equal(pendingChangesetIsApplicable(task, existsIn([PATCH])), true);
  });

  test("a pending changeset whose extraction never produced a patch is unresolvable", () => {
    assert.equal(pendingChangesetIsApplicable({ changesetStatus: "pending", diffPath: null }, existsIn([])), false);
  });

  test("a pending changeset whose patch file was removed is unresolvable", () => {
    assert.equal(pendingChangesetIsApplicable({ changesetStatus: "pending", diffPath: PATCH }, existsIn([])), false);
  });

  test("a non-pending changeset is not counted at all", () => {
    assert.equal(pendingChangesetIsApplicable({ changesetStatus: "accepted", diffPath: PATCH }, existsIn([PATCH])), false);
  });
});

describe("computeHousekeeping", () => {
  const tasks = [
    overlayTask({}),
    overlayTask({ root: LIVE }),
    { status: "done", changesetStatus: "pending", diffPath: PATCH },
    { status: "crashed", changesetStatus: "pending", diffPath: null },
    { status: "done" },
  ];
  const ctx = {
    tasks,
    cacheDir: CACHE_DIR,
    tasksFile: TASKS_FILE,
    existsFn: existsIn([LIVE, PATCH]),
    readdirFn: (/** @type {string} */ p) => (p.endsWith("uv-cache") ? ["a", "b", "c"] : ["a"]),
    statFn: () => ({ size: 4096 }),
  };

  test("splits recorded overlay pointers into live and stale", () => {
    const report = computeHousekeeping(ctx);
    assert.deepEqual(report.overlays, { recorded: 2, stale: 1, live: 1 });
  });

  test("splits pending changesets into applicable and unresolvable", () => {
    const report = computeHousekeeping(ctx);
    assert.deepEqual(report.changesets, { pending: 2, applicable: 1, unresolvable: 1 });
  });

  test("reports the task store's record count and byte size", () => {
    const report = computeHousekeeping(ctx);
    assert.deepEqual(report.taskStore, { records: 5, bytes: 4096 });
  });

  test("counts one entry per per-task cache bucket", () => {
    const report = computeHousekeeping(ctx);
    assert.deepEqual(report.perTaskCacheDirs, { "uv-cache": 3, "uv-tools": 1 });
  });

  test("an absent cache bucket counts zero rather than throwing", () => {
    const report = computeHousekeeping({
      ...ctx,
      readdirFn: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    assert.deepEqual(report.perTaskCacheDirs, { "uv-cache": 0, "uv-tools": 0 });
  });

  test("an unreadable task store reports a null size rather than throwing", () => {
    const report = computeHousekeeping({
      ...ctx,
      statFn: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    assert.equal(report.taskStore.bytes, null);
  });
});
