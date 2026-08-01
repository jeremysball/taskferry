const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} iso */
function toMs(iso) {
  return Date.parse(iso);
}

function emptyStatusMix() {
  return { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0, total: 0 };
}

/** @param {Array<{status: string}>} rows */
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
 * @param {Array<{status: string}>} rows
 */
function settledCounts(rows) {
  const counts = { done: 0, crashed: 0, cancelled: 0, unknown: 0 };
  for (const row of rows) {
    if (counts[row.status] != null) counts[row.status]++;
  }
  const settled = counts.done + counts.crashed;
  return { ...counts, settled };
}

/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null}
 */
function rateOrNull(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** @param {Array<{status: string, failureReason: string|null}>} rows */
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
 * @param {Array<{id: string, status: string, model: string, startedAt: string, failureReason: string|null}>} rows
 * @param {{now?: number}} [options]
 */
export function computeDoctorStats(rows, { now = Date.now() } = {}) {
  const last24h = rows.filter((row) => toMs(row.startedAt) >= now - DAY_MS);
  const last7d = rows.filter((row) => toMs(row.startedAt) >= now - 7 * DAY_MS);

  const byModelMap = new Map();
  for (const row of rows) {
    if (!byModelMap.has(row.model)) byModelMap.set(row.model, []);
    byModelMap.get(row.model).push(row);
  }
  const byModel = [...byModelMap.entries()]
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

  const reasonTally = new Map();
  for (const row of rows) {
    if (row.status !== "crashed" || !row.failureReason) continue;
    reasonTally.set(row.failureReason, (reasonTally.get(row.failureReason) ?? 0) + 1);
  }
  const failureReasons = [...reasonTally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const unknownRows = rows
    .filter((row) => row.status === "unknown")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  const unknownBacklog = {
    total: unknownRows.length,
    tasks: unknownRows.slice(0, 20).map(({ id, model, startedAt }) => ({ id, model, startedAt })),
  };

  const previousWindow = rows.filter((row) => toMs(row.startedAt) >= now - 2 * DAY_MS && toMs(row.startedAt) < now - DAY_MS);
  const currentSettled = settledCounts(last24h);
  const previousSettled = settledCounts(previousWindow);
  const currentCrashRate = rateOrNull(currentSettled.crashed, currentSettled.settled);
  const previousCrashRate = rateOrNull(previousSettled.crashed, previousSettled.settled);
  let direction = "unknown";
  if (currentSettled.settled > 0 && previousSettled.settled > 0) {
    direction = currentCrashRate > previousCrashRate ? "worsening" : currentCrashRate < previousCrashRate ? "improving" : "flat";
  }

  return {
    computedAt: new Date(now).toISOString(),
    statusMix: {
      overall: statusMixFor(rows),
      last24h: statusMixFor(last24h),
      last7d: statusMixFor(last7d),
    },
    byModel,
    failureReasons,
    unknownBacklog,
    trend: {
      window: "24h",
      current: { crashRate: currentCrashRate, settled: currentSettled.settled },
      previous: { crashRate: previousCrashRate, settled: previousSettled.settled },
      direction,
    },
  };
}
