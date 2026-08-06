import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeDoctorStats } from "./doctor-stats.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function row({ id, status, model, hoursAgo, failureReason = null }) {
  return {
    startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    id,
    status,
    model,
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
    assert.deepEqual(stats.statusMix.overall, { queued: 1, running: 0, done: 1, crashed: 1, cancelled: 0, unknown: 0, other: 0, total: 3 });
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

  test("a row with an unrecognized status lands in the 'other' bucket, and the displayed counts always sum to total", () => {
    // Regression: statusMixFor used to increment `total` unconditionally but
    // only bucket named statuses, so a future/unknown status (e.g. a new
    // "interrupted" or "superseded" value added in a later release that
    // this code doesn't know about) inflated `total` past the sum of the
    // displayed counts. The `other` bucket catches the unknown values so
    // the invariant -- `sum(buckets) === total` -- holds regardless.
    const rows = [
      row({ id: "a", status: "done", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "interrupted", model: "m1", hoursAgo: 1 }),
      row({ id: "c", status: "superseded", model: "m1", hoursAgo: 1 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.statusMix.overall.done, 1);
    assert.equal(stats.statusMix.overall.other, 2);
    assert.equal(stats.statusMix.overall.total, 3);
    const sum = stats.statusMix.overall.queued + stats.statusMix.overall.running + stats.statusMix.overall.done + stats.statusMix.overall.crashed + stats.statusMix.overall.cancelled + stats.statusMix.overall.unknown + stats.statusMix.overall.other;
    assert.equal(sum, stats.statusMix.overall.total);
  });
});

describe("computeDoctorStats: byModel", () => {
  test("dispatches counts every status; rates are settled-only (done+crashed)", () => {
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

  test("doneRate and crashRate are null, not zero, when a model has no settled tasks", () => {
    const rows = [row({ id: "a", status: "running", model: "m1", hoursAgo: 0.1 })];
    const stats = computeDoctorStats(rows, { now: NOW });
    const m1 = stats.byModel.find((entry) => entry.model === "m1");
    assert.equal(m1.doneRate, null);
    assert.equal(m1.crashRate, null);
  });

  test("cancelled and unknown tasks are excluded from doneRate/crashRate's denominator", () => {
    const rows = [
      row({ id: "a", status: "crashed", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "unknown", model: "m1", hoursAgo: 2 }),
      row({ id: "c", status: "unknown", model: "m1", hoursAgo: 3 }),
      row({ id: "d", status: "unknown", model: "m1", hoursAgo: 4 }),
      row({ id: "e", status: "unknown", model: "m1", hoursAgo: 5 }),
      row({ id: "f", status: "unknown", model: "m1", hoursAgo: 6 }),
      row({ id: "g", status: "unknown", model: "m1", hoursAgo: 7 }),
      row({ id: "h", status: "unknown", model: "m1", hoursAgo: 8 }),
      row({ id: "i", status: "unknown", model: "m1", hoursAgo: 9 }),
      row({ id: "j", status: "cancelled", model: "m1", hoursAgo: 10 }),
    ];
    const stats = computeDoctorStats(rows, { now: NOW });
    const m1 = stats.byModel.find((entry) => entry.model === "m1");
    // 1 crashed out of 1 settled (done+crashed) task -- not diluted to 1/10
    // by the 8 unknown + 1 cancelled tasks sitting alongside it.
    assert.equal(m1.crashRate, 1);
    assert.equal(m1.unknown, 8);
    assert.equal(m1.cancelled, 1);
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

  test("a row with a missing model no longer crashes the entire daemon-wide task.stats aggregation", () => {
    // Regression: a single persisted record whose `model` field is missing
    // (legacy record, partial write, schema drift) used to throw TypeError
    // out of `localeCompare` inside the tie-break sort, which now runs on
    // the daemon's request thread -- so one bad record would fail
    // `doctor --stats` for every caller, not just the CLI invocation that
    // touched it. The missing-model row must group under an empty-string key
    // and sort last (not crash), and the rest of the aggregation must stay
    // intact.
    const rows = [
      row({ id: "a", status: "done", model: "m1", hoursAgo: 1 }),
      row({ id: "b", status: "done", model: "m2", hoursAgo: 1 }),
    ];
    const noModelRow = /** @type {DoctorStatsRow} */ ({
      id: "c",
      status: "done",
      model: null,
      startedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      failureReason: null,
    });
    const stats = computeDoctorStats([rows[0], rows[1], noModelRow], { now: NOW });
    // All three rows survive the aggregation; the missing-model one sits in
    // its own bucket at the tail of the byModel sort (empty string sorts
    // last, after the named models).
    assert.equal(stats.byModel.length, 3);
    const models = stats.byModel.map((entry) => entry.model);
    assert.ok(models.includes("m1"));
    assert.ok(models.includes("m2"));
    assert.equal(models[models.length - 1], "", "missing-model row must sort last, not first");
    const unknownBucket = stats.byModel.find((entry) => entry.model === "");
    assert.equal(unknownBucket.dispatches, 1);
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

  test("unknown when either window has zero settled tasks", () => {
    const rows = [row({ id: "a", status: "crashed", model: "m1", hoursAgo: 1 })];
    const stats = computeDoctorStats(rows, { now: NOW });
    assert.equal(stats.trend.direction, "unknown");
    assert.equal(stats.trend.previous.settled, 0);
  });
});
