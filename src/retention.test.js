import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_TASK_RETENTION_DAYS, archiveEvictedTasks, partitionByRetention, taskAgeAnchor } from "./retention.js";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const EPOCH_2020 = "2020-01-01T00:00:00.000Z";
const EPOCH_2026 = "2026-01-01T00:00:00.000Z";
const DAY = 86_400_000;

/**
 * @param {object} overrides
 */
function task(overrides) {
  return { id: "t", status: "done", startedAt: new Date(NOW).toISOString(), ...overrides };
}

test("taskAgeAnchor prefers endedAt over startedAt", () => {
  const anchor = taskAgeAnchor({ startedAt: EPOCH_2026, endedAt: "2026-06-01T00:00:00.000Z" });
  assert.equal(anchor, Date.parse("2026-06-01T00:00:00.000Z"));
});

test("taskAgeAnchor falls back to startedAt and rejects unparseable values", () => {
  assert.equal(taskAgeAnchor({ startedAt: EPOCH_2026 }), Date.parse(EPOCH_2026));
  assert.equal(taskAgeAnchor({ startedAt: "not a date" }), undefined);
  assert.equal(taskAgeAnchor({}), undefined);
});

test("keepDays of 0 disables the sweep", () => {
  const tasks = [task({ id: "ancient", startedAt: EPOCH_2020 })];
  const { kept, evicted } = partitionByRetention(tasks, { keepDays: 0, now: NOW });
  assert.equal(kept.length, 1);
  assert.equal(evicted.length, 0);
});

test("evicts terminal tasks past the window and keeps ones inside it", () => {
  const tasks = [
    task({ id: "old-done", status: "done", startedAt: new Date(NOW - 40 * DAY).toISOString() }),
    task({ id: "old-crashed", status: "crashed", startedAt: new Date(NOW - 40 * DAY).toISOString() }),
    task({ id: "old-cancelled", status: "cancelled", startedAt: new Date(NOW - 40 * DAY).toISOString() }),
    task({ id: "old-unknown", status: "unknown", startedAt: new Date(NOW - 40 * DAY).toISOString() }),
    task({ id: "recent", status: "done", startedAt: new Date(NOW - 3 * DAY).toISOString() }),
  ];
  const { kept, evicted } = partitionByRetention(tasks, { keepDays: 30, now: NOW });
  assert.deepEqual(evicted.map((t) => t.id).sort(), ["old-cancelled", "old-crashed", "old-done", "old-unknown"]);
  assert.deepEqual(kept.map((t) => t.id), ["recent"]);
});

test("never evicts live work regardless of age", () => {
  const tasks = [
    task({ id: "stuck-running", status: "running", startedAt: EPOCH_2020 }),
    task({ id: "stuck-queued", status: "queued", startedAt: EPOCH_2020 }),
  ];
  const { kept, evicted } = partitionByRetention(tasks, { keepDays: 30, now: NOW });
  assert.equal(evicted.length, 0);
  assert.equal(kept.length, 2);
});

test("keeps a terminal task carrying no parseable timestamp", () => {
  const tasks = [{ id: "undateable", status: "done" }];
  const { kept, evicted } = partitionByRetention(tasks, { keepDays: 30, now: NOW });
  assert.equal(evicted.length, 0);
  assert.equal(kept.length, 1);
});

test("ages a long-running task from endedAt, not startedAt", () => {
  const tasks = [task({ id: "long", status: "done", startedAt: new Date(NOW - 90 * DAY).toISOString(), endedAt: new Date(NOW - 2 * DAY).toISOString() })];
  const { kept, evicted } = partitionByRetention(tasks, { keepDays: 30, now: NOW });
  assert.equal(evicted.length, 0);
  assert.equal(kept.length, 1);
});

test("archiveEvictedTasks writes NDJSON and returns undefined for an empty set", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(archiveEvictedTasks(dir, []), undefined);
  assert.equal(fs.existsSync(path.join(dir, "archive")), false);

  const evicted = [task({ id: "a" }), task({ id: "b" })];
  const target = archiveEvictedTasks(dir, evicted, { now: new Date(NOW) });
  assert.ok(target);
  const lines = fs.readFileSync(/** @type {string} */ (target), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), ["a", "b"]);
  assert.equal(fs.statSync(/** @type {string} */ (target)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(dir, "archive")), [path.basename(/** @type {string} */ (target))]);
});

test("the default retention window is a positive number of days", () => {
  assert.ok(Number.isInteger(DEFAULT_TASK_RETENTION_DAYS) && DEFAULT_TASK_RETENTION_DAYS > 0);
});
