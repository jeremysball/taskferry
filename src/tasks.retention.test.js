import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager, sweepOrphanedOutputDirsFor } from "./tasks.js";
import { trackManager, fakeChild, AXI_TASKS_TEST_DIR, TASKS_STATE_FILE, mkdtempTracked } from "./tasks.test-helpers.js";

const DAY = 86_400_000;

/**
 * @param {string} id
 * @param {string} status
 * @param {number} ageDays
 */
function record(id, status, ageDays) {
  const started = new Date(Date.now() - ageDays * DAY).toISOString();
  return { id, status, startedAt: started, endedAt: started, directory: os.tmpdir(), prompt: "p", model: "m", executorId: "opencode" };
}

/**
 * @param {string} stateDir
 * @param {Array<any>} tasks
 */
function seed(stateDir, tasks) {
  fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), JSON.stringify(tasks, null, 2), { mode: 0o600 });
}

/**
 * @param {string} stateDir
 */
function readStore(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, TASKS_STATE_FILE), "utf8"));
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function manager(overrides = {}) {
  return trackManager(createTaskManager({
    sandboxEnabled: false,
    spawnFn: () => fakeChild(),
    killFn: () => {},
    ...overrides,
  }));
}

describe("boot-time retention sweep", () => {
  test("archives terminal tasks past the window and rewrites tasks.json", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [
      record("old-done", "done", 120),
      record("old-crashed", "crashed", 200),
      record("recent-done", "done", 2),
      record("live", "running", 400),
    ]);

    const mgr = manager({ stateDir, taskRetentionDays: 30 });
    mgr.close();

    const ids = readStore(stateDir).map((t) => t.id).sort();
    assert.deepEqual(ids, ["live", "recent-done"], "aged terminal tasks are gone, live and recent work stays");

    const archives = fs.readdirSync(path.join(stateDir, "archive"));
    assert.equal(archives.length, 1);
    const archived = fs.readFileSync(path.join(stateDir, "archive", archives[0]), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line).id).sort();
    assert.deepEqual(archived, ["old-crashed", "old-done"], "evicted records are archived, never dropped");
  });

  test("taskRetentionDays of 0 keeps everything and writes no archive", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("ancient", "done", 5000)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    mgr.close();

    assert.deepEqual(readStore(stateDir).map((t) => t.id), ["ancient"]);
    assert.equal(fs.existsSync(path.join(stateDir, "archive")), false);
  });

  test("leaves a malformed tasks.json untouched rather than overwriting it with an empty store", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const storePath = path.join(stateDir, TASKS_STATE_FILE);
    fs.writeFileSync(storePath, "{ not valid json");

    const mgr = manager({ stateDir, taskRetentionDays: 1 });
    mgr.close();

    assert.equal(fs.readFileSync(storePath, "utf8"), "{ not valid json");
    assert.equal(fs.existsSync(path.join(stateDir, "archive")), false);
  });

  test("a sweep failure at boot is logged and does not abort manager creation", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("old-done", "done", 120)]);
    // Force archiveEvictedTasks' mkdirSync to fail: a plain file sitting where
    // the archive directory needs to go raises ENOTDIR/EEXIST, standing in
    // for any real boot-time I/O fault (ENOSPC, a permissions change) the
    // sweep can hit.
    fs.writeFileSync(path.join(stateDir, "archive"), "not a directory");

    const errors = [];
    const restoreConsoleError = console.error;
    console.error = (msg) => errors.push(msg);
    let mgr;
    try {
      mgr = manager({ stateDir, taskRetentionDays: 30 });
    } finally {
      console.error = restoreConsoleError;
    }
    mgr.close();

    assert.ok(errors.some((msg) => msg.includes("retention sweep failed at boot")), "the failure is logged, not silent");
    // The eviction never completed, so the record it would have archived is
    // still exactly where it started rather than lost mid-sweep.
    assert.deepEqual(readStore(stateDir).map((t) => t.id), ["old-done"]);
  });
});

describe("prune()", () => {
  test("--dry-run reports the same counts without touching the store", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("old", "done", 90), record("new", "done", 1)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    const summary = mgr.prune({ keepDays: 30, dryRun: true });
    assert.deepEqual(summary, { keepDays: 30, scanned: 2, kept: 1, evicted: 1, dryRun: true });
    assert.equal(summary.archivePath, undefined);
    mgr.close();

    assert.deepEqual(readStore(stateDir).map((t) => t.id).sort(), ["new", "old"]);
    assert.equal(fs.existsSync(path.join(stateDir, "archive")), false);
  });

  test("an explicit keepDays overrides the configured window", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("d10", "done", 10), record("d40", "done", 40)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    const summary = mgr.prune({ keepDays: 20 });
    assert.equal(summary.evicted, 1);
    assert.ok(summary.archivePath, "a real prune reports where the records went");
    mgr.close();

    assert.deepEqual(readStore(stateDir).map((t) => t.id), ["d10"]);
  });

  test("is a no-op when nothing is old enough", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("fresh", "done", 1)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    const summary = mgr.prune({ keepDays: 30 });
    assert.equal(summary.evicted, 0);
    assert.equal(summary.archivePath, undefined);
    mgr.close();

    assert.deepEqual(readStore(stateDir).map((t) => t.id), ["fresh"]);
  });

  test("removes the output dirs of evicted tasks, keeps the rest", () => {
    // Companion cleanup for the eviction decision: without this the evicted
    // tasks' output dirs dangle until a restart, when the boot orphan sweep
    // deletes the younger ones by the configured window instead of this
    // prune's keepDays. Output dirs are created after the manager boots so
    // the boot sweep (retention disabled here) does not clear them first.
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("old", "done", 90), record("new", "done", 1)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    const outputs = path.join(stateDir, "outputs");
    fs.mkdirSync(path.join(outputs, "old"), { recursive: true });
    fs.mkdirSync(path.join(outputs, "new"), { recursive: true });

    const summary = mgr.prune({ keepDays: 30 });
    assert.equal(summary.evicted, 1);
    mgr.close();

    assert.equal(fs.existsSync(path.join(outputs, "old")), false, "evicted task's output dir is removed with the eviction");
    assert.equal(fs.existsSync(path.join(outputs, "new")), true, "kept task's output dir is untouched");
  });

  test("dry-run removes no output dirs", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("old", "done", 90)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    const outputs = path.join(stateDir, "outputs");
    fs.mkdirSync(path.join(outputs, "old"), { recursive: true });

    mgr.prune({ keepDays: 30, dryRun: true });
    mgr.close();

    assert.equal(fs.existsSync(path.join(outputs, "old")), true, "dry-run touches nothing on disk");
  });

  test("a keepDays shorter than the configured window leaves no orphan for the next boot's sweep to mishandle", () => {
    // The output-dir sweep at boot judges an orphan's age against the
    // *configured* retention window (see the sweep guard tests below), not
    // whatever keepDays a prune ran with. Before evictTasksFromStore tied
    // output-dir cleanup to the eviction itself, a task evicted by a
    // shorter-than-configured keepDays left its output dir behind for that
    // next boot, which would then judge it against the wrong (longer)
    // window. Evicting here removes the dir immediately, so there is
    // nothing left for a later, differently-windowed boot to get wrong.
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    seed(stateDir, [record("mid", "done", 5)]);

    const mgr = manager({ stateDir, taskRetentionDays: 0 });
    const outputs = path.join(stateDir, "outputs");
    fs.mkdirSync(path.join(outputs, "mid"), { recursive: true });

    // keepDays: 1 evicts the 5-day-old task even though the configured
    // 30-day window (used below) would not have.
    const summary = mgr.prune({ keepDays: 1 });
    assert.equal(summary.evicted, 1);
    mgr.close();
    assert.equal(fs.existsSync(path.join(outputs, "mid")), false, "the evicted task's output dir is already gone");

    // A later boot at the normal configured window finds nothing left to
    // sweep for this task; nothing resurrects the directory or crashes.
    const rebooted = manager({ stateDir, taskRetentionDays: 30 });
    rebooted.close();
    assert.equal(fs.existsSync(path.join(outputs, "mid")), false);
  });

  describe("output dir sweep guard", () => {
    /**
     * @param {number} ageDays
     * @param {number} retentionDays
     */
    function sweep(ageDays, retentionDays) {
      const removed = [];
      sweepOrphanedOutputDirsFor({
        OUTPUT_DIR_ROOT: "/outputs",
        tasks: new Map(),
        readdirFn: () => ["gone"],
        lstatFn: () => ({ mtimeMs: Date.now() - ageDays * DAY }),
        removeDirFn: (full) => removed.push(full),
        retentionDays,
      });
      return removed;
    }

    test("keeps an output dir older than the retention window", () => {
      // The dir of a task retention already evicted. Its id is absent from
      // tasks.json, which is exactly what an orphan looks like, so without
      // the guard every evicted task's deliverable would be rm -rf'd on the
      // next boot.
      assert.deepEqual(sweep(60, 30), []);
    });

    test("still removes recent crash debris", () => {
      assert.deepEqual(sweep(0, 30), ["/outputs/gone"]);
    });

    test("removes regardless of age when retention is disabled", () => {
      assert.deepEqual(sweep(600, 0), ["/outputs/gone"]);
    });
  });
});
