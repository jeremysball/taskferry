import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeDoctorStats } from "./doctor-stats.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function row({ id, status, model, hoursAgo, failureReason = null }) {
  return {
    id,
    status,
    model,
    startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    failureReason,
  };
}

describe("computeDoctorStats: status mix", () => {
  test("overall counts every row regardless of age", () => {
    const rows = [
      row({ id: "a", status: "done", model: "m1", hoursAgo: 1000 }),
      row({ id: "b", status: "crashed", model: "m1", hoursAgo: 1 }),
      row({ id: "c", status: "queued", model: "m2", hoursAgo: 0.1 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.deepEqual(stats.statusMix.overall, { queued: 1, running: 0, done: 1, crashed: 1, cancelled: 0, unknown: 0, total: 3 });
  });

  test("last24h and last7d filter by startedAt window, overall does not", () => {
    const rows = [
      row({ id: "old", status: "done", model: "m1", hoursAgo: 1000 }),
      row({ id: "recent", status: "done", model: "m1", hoursAgo: 12 }),
      row({ id: "week", status: "done", model: "m1", hoursAgo: 100 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.statusMix.overall.total, 3);
    assert.equal(stats.statusMix.last24h.total, 1);
    assert.equal(stats.statusMix.last7d.total, 2);
  });
});

describe("computeDoctorStats: byModel", () => {
  test("dispatches counts every status; rates are terminal-only", () => {
    const rows = [
      row({ id: "a", status: "done", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "crashed", model: "m1", hoursAgo: 1 }),
      row({ id: "c", status: "running", model: "m1", hoursAgo: 0.1 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    const m1 = stats.byModel.find((entry) => entry.model === "m1");
    assert.equal(m1.dispatches, 3);
    assert.equal(m1.done, 1);
    assert.equal(m1.crashed, 1);
    assert.equal(m1.doneRate, 0.5);
    assert.equal(m1.crashRate, 0.5);
  });

  test("doneRate and crashRate are null, not zero, when a model has no terminal tasks", () => {
    const rows = [row({ id: "a", status: "running", model: "m1", hoursAgo: 0.1 })];
    const stats = computeDoctorStats(rows, { now: NOW });
    const m1 = stats.byModel.find((entry) => entry.model === "m1");
    assert.equal(m1.doneRate, null);
    assert.equal(m1.crashRate, null);
  });

  test("dominantFailureReason picks the most common reason among this model's crashed tasks", () => {
    const rows = [
      row({ id: "a", status: "crashed", model: "m1", hoursAgo: 3, failureReason: "no_output_timeout" }),
      row({ id: "b", status: "crashed", model: "m1", hoursAgo: 2, failureReason: "no_output_timeout" }),
      row({ id: "c", status: "crashed", model: "m1", hoursAgo: 1, failureReason: "pi_rate_limited" }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    const m1 = stats.byModel.find((entry) => entry.model === "m1");
    assert.equal(m1.dominantFailureReason, "no_output_timeout");
  });

  test("dominantFailureReason is null when the model has no crashed tasks", () => {
    const rows = [row({ id: "a", status: "done", model: "m1", hoursAgo: 1 })];
    const stats = computeDoctorStats(rows, { now: NOW });
    const m1 = stats.byModel.find((entry) => entry.model === "m1");
    assert.equal(m1.dominantFailureReason, null);
  });

  test("byModel is sorted by dispatches desc", () => {
    const rows = [
      row({ id: "a", status: "done", model: "small", hoursAgo: 1 }),
      row({ id: "b", status: "done", model: "big", hoursAgo: 1 }),
      row({ id: "c", status: "done", model: "big", hoursAgo: 2 }),
      row({ id: "d", status: "done", model: "big", hoursAgo: 3 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.deepEqual(stats.byModel.map((entry) => entry.model), ["big", "small"]);
  });
});

describe("computeDoctorStats: failureReasons histogram", () => {
  test("sorted by count desc across all models, crashed tasks only", () => {
    const rows = [
      row({ id: "a", status: "crashed", model: "m1", hoursAgo: 1, failureReason: "no_output_timeout" }),
      row({ id: "b", status: "crashed", model: "m2", hoursAgo: 1, failureReason: "no_output_timeout" }),
      row({ id: "c", status: "crashed", model: "m1", hoursAgo: 1, failureReason: "pi_rate_limited" }),
      row({ id: "d", status: "done", model: "m1", hoursAgo: 1 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.deepEqual(stats.failureReasons, [
      { reason: "no_output_timeout", count: 2 },
      { reason: "pi_rate_limited", count: 1 },
    ]);
  });
});

describe("computeDoctorStats: unknownBacklog", () => {
  test("caps tasks at 20, newest first, but total reflects the true count", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: `u${i}`, status: "unknown", model: "m1", hoursAgo: i }));
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.unknownBacklog.total, 25);
    assert.equal(stats.unknownBacklog.tasks.length, 20);
    assert.equal(stats.unknownBacklog.tasks[0].id, "u0");
    assert.equal(stats.unknownBacklog.tasks[19].id, "u19");
  });
});

describe("computeDoctorStats: trend", () => {
  test("worsening when current 24h crash rate exceeds the previous 24h window", () => {
    const rows = [
      row({ id: "a", status: "crashed", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "crashed", model: "m1", hoursAgo: 2 }),
      row({ id: "c", status: "done", model: "m1", hoursAgo: 30 }),
      row({ id: "d", status: "done", model: "m1", hoursAgo: 31 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.trend.direction, "worsening");
  });

  test("improving when current 24h crash rate is lower than the previous 24h window", () => {
    const rows = [
      row({ id: "a", status: "done", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "crashed", model: "m1", hoursAgo: 30 }),
      row({ id: "c", status: "crashed", model: "m1", hoursAgo: 31 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.trend.direction, "improving");
  });

  test("flat when both windows have an identical crash rate", () => {
    const rows = [
      row({ id: "a", status: "crashed", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "done", model: "m1", hoursAgo: 2 }),
      row({ id: "c", status: "crashed", model: "m1", hoursAgo: 30 }),
      row({ id: "d", status: "done", model: "m1", hoursAgo: 31 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.trend.direction, "flat");
  });

  test("unknown when either window has zero terminal tasks", () => {
    const rows = [row({ id: "a", status: "crashed", model: "m1", hoursAgo: 1 })];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.trend.direction, "unknown");
    assert.equal(stats.trend.previous.terminal, 0);
  });
});
