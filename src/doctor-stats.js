const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} DoctorStatsRow
 * @property {string} id
 * @property {string} status
 * @property {string} model
 * @property {string} startedAt
 * @property {string|null} failureReason
 */

/** @param {string} iso */
function toMs(iso) {
  return Date.parse(iso);
}

/** @returns {Record<string, number>} */
function emptyStatusMix() {
  return { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0, total: 0 };
}

/** @param {DoctorStatsRow[]} rows */
function statusMixFor(rows) {
  const mix = emptyStatusMix();
  for (const row of rows) {
    if (mix[row.status] != null) mix[row.status]++;
    mix.total++;
  }
  return mix;
}

/**
 * Per-status counts plus `settled`: done+crashed only. Rates (`doneRate`,
 * `crashRate`, the trend) are computed against `settled`, not every
 * terminal-ish status -- `cancelled` was a deliberate stop, not a run
 * outcome, and `unknown` means "we lost track after a daemon restart," not
 * "this task succeeded." Folding either into the denominator dilutes the
 * reported crash rate: 8 unknown + 2 crashed would otherwise read as a 20%
 * crash rate instead of the true 100% of tasks whose outcome we do know.
 * @param {DoctorStatsRow[]} rows
 * @returns {{done: number, crashed: number, cancelled: number, unknown: number, settled: number}}
 */
function settledCounts(rows) {
  /** @type {Record<string, number>} */
  const counts = { done: 0, crashed: 0, cancelled: 0, unknown: 0 };
  for (const row of rows) {
    if (counts[row.status] != null) counts[row.status]++;
  }
  const settled = counts.done + counts.crashed;
  // Rebuilt as a named literal, not `{...counts, settled}`: spreading the
  // Record<string, number>-typed `counts` loses its individual property
  // names for type-checking purposes, so every caller below would otherwise
  // see only `settled` and none of the per-status counts.
  return { done: counts.done, crashed: counts.crashed, cancelled: counts.cancelled, unknown: counts.unknown, settled };
}

/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null}
 */
function rateOrNull(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** @param {DoctorStatsRow[]} rows */
function dominantReason(rows) {
  const tally = new Map();
  for (const row of rows) {
    if (row.status !== "crashed" || !row.failureReason) continue;
    tally.set(row.failureReason, (tally.get(row.failureReason) ?? 0) + 1);
  }
  if (tally.size === 0) return null;
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * @param {DoctorStatsRow} a
 * @param {DoctorStatsRow} b
 */
function compareStartedAtDesc(a, b) {
  if (a.startedAt < b.startedAt) return 1;
  if (a.startedAt > b.startedAt) return -1;
  return 0;
}

/** @param {DoctorStatsRow[]} rows */
function computeByModel(rows) {
  /** @type {Map<string, DoctorStatsRow[]>} */
  const byModelMap = new Map();
  for (const row of rows) {
    if (!byModelMap.has(row.model)) byModelMap.set(row.model, []);
    // The has() check above guarantees a Map entry exists, but TS can't see
    // that get() and set() are correlated -- non-null assert instead of
    // widening every consumer below to `| undefined`.
    const modelRows = /** @type {DoctorStatsRow[]} */ (byModelMap.get(row.model));
    modelRows.push(row);
  }
  return [...byModelMap.entries()]
    .map(([model, modelRows]) => {
      const t = settledCounts(modelRows);
      return {
        model,
        dispatches: modelRows.length,
        done: t.done,
        crashed: t.crashed,
        cancelled: t.cancelled,
        unknown: t.unknown,
        doneRate: rateOrNull(t.done, t.settled),
        crashRate: rateOrNull(t.crashed, t.settled),
        dominantFailureReason: dominantReason(modelRows),
      };
    })
    .sort((a, b) => b.dispatches - a.dispatches || a.model.localeCompare(b.model));
}

/** @param {DoctorStatsRow[]} rows */
function computeFailureReasons(rows) {
  const reasonTally = new Map();
  for (const row of rows) {
    if (row.status !== "crashed" || !row.failureReason) continue;
    reasonTally.set(row.failureReason, (reasonTally.get(row.failureReason) ?? 0) + 1);
  }
  return [...reasonTally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** @param {DoctorStatsRow[]} rows */
function computeUnknownBacklog(rows) {
  const unknownRows = rows
    .filter((row) => row.status === "unknown")
    .sort((a, b) => compareStartedAtDesc(a, b));
  return {
    total: unknownRows.length,
    tasks: unknownRows.slice(0, 20).map(({ id, model, startedAt }) => ({ id, model, startedAt })),
  };
}

/**
 * @param {DoctorStatsRow[]} rows
 * @param {DoctorStatsRow[]} last24h
 * @param {number} now
 */
function computeTrend(rows, last24h, now) {
  const previousWindow = rows.filter((row) => toMs(row.startedAt) >= now - 2 * DAY_MS && toMs(row.startedAt) < now - DAY_MS);
  const currentSettled = settledCounts(last24h);
  const previousSettled = settledCounts(previousWindow);
  const currentCrashRate = rateOrNull(currentSettled.crashed, currentSettled.settled);
  const previousCrashRate = rateOrNull(previousSettled.crashed, previousSettled.settled);
  let direction = "unknown";
  // The settled>0 checks alone guarantee rateOrNull returned a number for
  // both sides (it only returns null when its denominator is 0), but TS
  // can't correlate that with a separate variable -- the explicit
  // !== null checks re-narrow for the comparisons below.
  if (currentSettled.settled > 0 && previousSettled.settled > 0 && currentCrashRate !== null && previousCrashRate !== null) {
    if (currentCrashRate > previousCrashRate) {
      direction = "worsening";
    } else if (currentCrashRate < previousCrashRate) {
      direction = "improving";
    } else {
      direction = "flat";
    }
  }
  return {
    window: "24h",
    current: { crashRate: currentCrashRate, settled: currentSettled.settled },
    previous: { crashRate: previousCrashRate, settled: previousSettled.settled },
    direction,
  };
}

/**
 * @param {DoctorStatsRow[]} rows
 * @param {{now?: number}} [options]
 */
export function computeDoctorStats(rows, { now = Date.now() } = {}) {
  const last24h = rows.filter((row) => toMs(row.startedAt) >= now - DAY_MS);
  const last7d = rows.filter((row) => toMs(row.startedAt) >= now - 7 * DAY_MS);

  return {
    byModel: computeByModel(rows),
    failureReasons: computeFailureReasons(rows),
    unknownBacklog: computeUnknownBacklog(rows),
    computedAt: new Date(now).toISOString(),
    statusMix: {
      overall: statusMixFor(rows),
      last24h: statusMixFor(last24h),
      last7d: statusMixFor(last7d),
    },
    trend: computeTrend(rows, last24h, now),
  };
}
