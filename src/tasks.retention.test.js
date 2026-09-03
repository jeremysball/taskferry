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
