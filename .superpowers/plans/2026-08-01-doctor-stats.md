# doctor --stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `taskferry doctor --stats`, a point-in-time report over persisted task history (status mix, per-model breakdown, failure-reason histogram, unknown backlog, 24h crash-rate trend), computed client-side from the existing `task.list` RPC.

**Architecture:** A new pure function `computeDoctorStats(rows, { now })` in `src/doctor-stats.js` takes the same row shape `task.list` already returns (`id`, `status`, `model`, `startedAt`, `failureReason`) and returns the full stats object — no daemon changes, no stored aggregates. `src/args.js` gains a `--stats` boolean flag scoped to `doctor`, mutually exclusive with `--full`. `src/commands.js`'s `case "doctor"` branches on `options.stats`: if set, it skips the existing environment-check `Promise.allSettled` block entirely, calls `client.request("task.list", {})`, and returns `computeDoctorStats(listed.tasks)` directly.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, existing `client.request` RPC pattern.

## Global Constraints

- No new daemon RPC — `computeDoctorStats` only ever consumes what `task.list` already returns.
- `doctor --stats` and plain `doctor` never mix output in one call; every existing `doctor` test must keep passing unmodified.
- Recompute from live data on every invocation — no cached/stored aggregate state.
- `doneRate`/`crashRate` denominators are terminal-only (`done + crashed + cancelled + unknown`); `byModel[].dispatches` counts every status including queued/running.
- Any rate with a zero denominator is `null`, never `0` and never silently omitted.
- `unknownBacklog.tasks` capped at 20 entries (newest first); `unknownBacklog.total` is always the true uncapped count.
- `trend.direction` is `"unknown"` whenever either 24h window has zero terminal tasks — never guess `"flat"` for a no-data window.

---

### Task 1: `computeDoctorStats()` pure function

**Files:**
- Create: `src/doctor-stats.js`
- Test: `src/doctor-stats.test.js`

**Interfaces:**
- Produces: `export function computeDoctorStats(rows, { now = Date.now() } = {})` returning:
  ```js
  {
    computedAt: string,        // ISO timestamp of `now`
    statusMix: {
      overall: { queued, running, done, crashed, cancelled, unknown, total },
      last24h: { ...same shape... },
      last7d:  { ...same shape... },
    },
    byModel: [
      { model, dispatches, done, crashed, cancelled, unknown, doneRate, crashRate, dominantFailureReason }
    ],
    failureReasons: [ { reason, count } ],
    unknownBacklog: { total, tasks: [ { id, model, startedAt } ] },
    trend: {
      window: "24h",
      current: { crashRate, terminal },
      previous: { crashRate, terminal },
      direction: "improving" | "worsening" | "flat" | "unknown",
    },
  }
  ```
  `rows` is an array of `{ id, status, model, startedAt, failureReason }` (the exact shape `task.list`'s `summarizeRow()` in `src/tasks.js` already produces).

- [ ] **Step 1: Write the failing tests**

Create `src/doctor-stats.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/doctor-stats.test.js`
Expected: FAIL — `Cannot find module './doctor-stats.js'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/doctor-stats.js`:

```js
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

/** @param {Array<{status: string}>} rows */
function terminalCounts(rows) {
  const counts = { done: 0, crashed: 0, cancelled: 0, unknown: 0 };
  for (const row of rows) {
    if (counts[row.status] != null) counts[row.status]++;
  }
  const terminal = counts.done + counts.crashed + counts.cancelled + counts.unknown;
  return { ...counts, terminal };
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
      const t = terminalCounts(modelRows);
      return {
        model,
        dispatches: modelRows.length,
        done: t.done,
        crashed: t.crashed,
        cancelled: t.cancelled,
        unknown: t.unknown,
        doneRate: rateOrNull(t.done, t.terminal),
        crashRate: rateOrNull(t.crashed, t.terminal),
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
  const currentTerminal = terminalCounts(last24h);
  const previousTerminal = terminalCounts(previousWindow);
  const currentCrashRate = rateOrNull(currentTerminal.crashed, currentTerminal.terminal);
  const previousCrashRate = rateOrNull(previousTerminal.crashed, previousTerminal.terminal);
  let direction = "unknown";
  if (currentTerminal.terminal > 0 && previousTerminal.terminal > 0) {
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
      current: { crashRate: currentCrashRate, terminal: currentTerminal.terminal },
      previous: { crashRate: previousCrashRate, terminal: previousTerminal.terminal },
      direction,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/doctor-stats.test.js`
Expected: all tests PASS (13 tests across 5 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/doctor-stats.js src/doctor-stats.test.js
git commit -m "feat(doctor): add computeDoctorStats() pure aggregation function"
```

---

### Task 2: Wire `--stats` into `src/args.js`

**Files:**
- Modify: `src/args.js` (doctor command spec ~line 140-145, `defaultOptions()` ~line 298-299, `booleanCommands` map ~line 374, validation block ~line 449-470)
- Test: `src/args.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `parseArgs(["doctor", "--stats"])` returns `options.stats === true`; `parseArgs(["doctor", "--stats", "--full"])` throws a `UsageError`.

- [ ] **Step 1: Write the failing tests**

Add to `src/args.test.js` (find the existing `doctor` test block and add alongside it):

```js
test("doctor --stats sets options.stats", () => {
  const parsed = parseArgs(["doctor", "--stats"]);
  assert.equal(parsed.options.stats, true);
});

test("doctor with no --stats defaults options.stats to false", () => {
  const parsed = parseArgs(["doctor"]);
  assert.equal(parsed.options.stats, false);
});

test("doctor --stats --full is rejected", () => {
  assert.throws(
    () => parseArgs(["doctor", "--stats", "--full"]),
    (err) => err instanceof UsageError && /--stats cannot be combined with --full/.test(err.message)
  );
});

test("doctor --full --stats is rejected regardless of flag order", () => {
  assert.throws(
    () => parseArgs(["doctor", "--full", "--stats"]),
    (err) => err instanceof UsageError && /--stats cannot be combined with --full/.test(err.message)
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `doctor --stats` is an unrecognized flag (`unknown flag --stats for \`doctor\``), and `options.stats` is `undefined` rather than `false`.

- [ ] **Step 3: Add `--stats` to the doctor command spec**

In `src/args.js`, update the `doctor` entry in `commandSpecs` (around line 140):

```js
  doctor: {
    usage: "taskferry doctor [--full] [--stats]",
    description: "Check daemon health and installation details, or report aggregate task-history stats.",
    options: {
      "--full": "include complete health details",
      "--stats": "report aggregate task-history stats instead of environment checks (mutually exclusive with --full)",
    },
    examples: ['taskferry doctor', 'taskferry doctor --full', 'taskferry doctor --stats'],
  },
```

- [ ] **Step 4: Default `stats: false` in `defaultOptions()`**

Update the `"doctor"` case in `defaultOptions()` (around line 298):

```js
    case "doctor":
      return { full: false, stats: false };
```

- [ ] **Step 5: Register `--stats` as a boolean flag scoped to `doctor`**

In the `booleanCommands` map (around line 374), add a new entry:

```js
    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
      "--summarize-context": ["advisor"],
      "--no-sandbox": ["dispatch"],
      "--no-overlay": ["dispatch"], // advisor deliberately excluded -- review finding #5
      "--diff": ["result"],
      "--stats": ["doctor"],
    };
```

- [ ] **Step 6: Reject `--stats` combined with `--full`**

Add a new check alongside the existing `result --diff`/`--full` mutual-exclusion block (around line 461, right after the `--diff`/`--full` check):

```js
    if (command === "doctor" && options.stats && options.full) {
      throw usageError("--stats cannot be combined with --full", command);
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test src/args.test.js`
Expected: all tests PASS, including the 4 new ones.

- [ ] **Step 8: Run the full test suite to confirm nothing else broke**

Run: `node --test src/args.test.js src/commands.test.js src/cli.test.js`
Expected: all PASS — the existing `doctor`/`doctor --full` tests are unaffected since `stats` simply defaults to `false`.

- [ ] **Step 9: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(args): add --stats flag to doctor, mutually exclusive with --full"
```

---

### Task 3: Wire `doctor --stats` into `src/commands.js`

**Files:**
- Modify: `src/commands.js` (`case "doctor"`, currently starting around line 404; add the `computeDoctorStats` import at the top)
- Test: `src/commands.test.js`

**Interfaces:**
- Consumes: `computeDoctorStats(rows, { now })` from `./doctor-stats.js` (Task 1); `options.stats` from `src/args.js` (Task 2).
- Produces: `runCommand("doctor", { stats: true }, { client, ... })` resolves to exactly `computeDoctorStats(listedRows)`'s return value (no `integrations`/`warnings`/`info` wrapper).

- [ ] **Step 1: Write the failing test**

Add to `src/commands.test.js`, near the existing `doctor` tests:

```js
test("doctor --stats calls task.list and returns computeDoctorStats() output, skipping env checks", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-stats-home-"));
  let calledMethod;
  const client = {
    request: async (method, params) => {
      calledMethod = method;
      assert.deepEqual(params, {});
      return {
        counts: { queued: 0, running: 0, done: 1, crashed: 1, cancelled: 0, unknown: 0 },
        tasks: [
          { id: "a", status: "done", model: "m1", startedAt: "2026-08-01T10:00:00.000Z", failureReason: null },
          { id: "b", status: "crashed", model: "m1", startedAt: "2026-08-01T11:00:00.000Z", failureReason: "no_output_timeout" },
        ],
      };
    },
  };
  const runShellCommand = async () => ({ stdout: "", stderr: "", code: 0 });

  const result = await runCommand("doctor", { stats: true }, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.equal(calledMethod, "task.list");
  assert.ok(Array.isArray(result.byModel));
  assert.equal(result.byModel[0].model, "m1");
  assert.equal(result.byModel[0].dispatches, 2);
  assert.equal(result.integrations, undefined);
  assert.equal(result.warnings, undefined);
});

test("doctor without --stats does not call task.list", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-stats-home-"));
  const calledMethods = [];
  const client = {
    request: async (method) => {
      calledMethods.push(method);
      return { healthy: true, pid: 1, version: 1 };
    },
  };
  const runShellCommand = async () => ({ stdout: "", stderr: "", code: 0 });

  await runCommand("doctor", {}, { client, homeDirectory: home, env: {}, runShellCommand });

  assert.ok(!calledMethods.includes("task.list"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — plain `doctor` (no `--stats` handling yet) still runs the env-check path regardless of `options.stats`, so the first test's assertions on `result.byModel` fail (`result.byModel` is `undefined`).

- [ ] **Step 3: Import `computeDoctorStats` and branch in `case "doctor"`**

Add the import near the top of `src/commands.js`, alongside the other local imports:

```js
import { computeDoctorStats } from "./doctor-stats.js";
```

Replace the start of `case "doctor":` (the block currently beginning around line 404) so it branches before running the existing `Promise.allSettled` checks:

```js
    case "doctor": {
      if (options.stats) {
        const listed = await client.request("task.list", {});
        return computeDoctorStats(listed.tasks);
      }
      const checks = await Promise.allSettled([
        client.request("system.health", {}),
        checkClaudeIntegration(runShellCommand),
        checkOpencodePlaywrightIsolation(homeDirectory, env),
        checkClaudeCodePlaywrightIsolation(homeDirectory),
        platform === "linux" ? checkBwrapAvailableAsync(runShellCommand) : Promise.resolve(null),
      ]);
      // ...rest of the existing block is unchanged
```

Leave everything below the `Promise.allSettled` call exactly as it is today.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/commands.test.js`
Expected: all tests PASS, including the existing `doctor` env-check tests (they never set `options.stats`, so they still hit the unchanged path) and the 2 new ones.

- [ ] **Step 5: Run the full suite**

Run: `npm run check`
Expected: lint, typecheck, and all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands.js src/commands.test.js
git commit -m "feat(commands): wire doctor --stats to computeDoctorStats() via task.list"
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/sourcemap.md`
- Modify: `docs/cli-reference.md`
- Modify: `skills/using-taskferry/SKILL.md` (canonical; regenerate the two `integrations/*` copies, don't hand-edit them)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a `src/doctor-stats.js` row to `docs/sourcemap.md`**

Find the file-by-file table (the row list starting around line 44) and insert a new row alphabetically near `commands.js`:

```markdown
| `doctor-stats.js` | 90 | `computeDoctorStats(rows, { now })`: pure aggregation over `task.list` rows into `doctor --stats`'s report (status mix overall/24h/7d, per-model dispatch/rate/dominant-failure-reason breakdown, failure-reason histogram, capped unknown backlog, 24h-vs-prior-24h crash-rate trend). No daemon/CLI imports — reusable by future work (e.g. taskferry#234's per-model streak tracking) against the same row shape. |
```

(Adjust the line count to the file's actual `wc -l src/doctor-stats.js` output before committing.)

Update the existing `commands.js` row (around line 45) to append one sentence:

```
`doctor --stats` skips the environment-check `Promise.allSettled` block entirely, calls `task.list` directly, and returns `computeDoctorStats()`'s output unwrapped (no `integrations`/`warnings`/`info`).
```

- [ ] **Step 2: Document `--stats` in `docs/cli-reference.md`**

Update the `## taskferry doctor [--full]` heading (line 317) to `## taskferry doctor [--full] [--stats]`, and add a paragraph after the existing warnings/info paragraph:

```markdown
`--stats` replaces the environment checks entirely with an aggregate report
over persisted task history: status mix (`overall`/`last24h`/`last7d`), a
per-model breakdown (dispatch count, done/crash rate, dominant failure
reason), a failure-reason histogram, the unknown-status backlog (capped at
20 entries, newest first), and a 24h-vs-prior-24h crash-rate trend.
Recomputed from `task.list` on every call — nothing is cached. Cannot be
combined with `--full`.
```

- [ ] **Step 3: Mention `--stats` in the canonical SKILL.md**

In `skills/using-taskferry/SKILL.md`, update the existing `doctor --full` mention (around line 514):

```
Use `taskferry cancel <id>` for work that should stop; it sends SIGTERM and
escalates to SIGKILL after a grace period (default 5000ms, override with
`--grace-ms <number>` for a worker that needs longer to unwind, e.g. mid
long-running command). Use `taskferry list` or `taskferry context --format toon`
to inspect workspace-scoped state, `taskferry doctor --full` if something
about the daemon itself seems wrong (dead socket, stale process, health check
failing) before assuming a task-level problem, and `taskferry doctor --stats`
for an aggregate report over task history (status mix, per-model crash rates,
failure-reason histogram, unknown backlog, crash-rate trend) instead of
hand-computing it from `taskferry list --all`. The CLI emits structured data,
errors, and help as TOON on stdout, keeps diagnostics on stderr, and uses exit
codes to distinguish success, operational failure, and usage errors.
```

- [ ] **Step 4: Regenerate the integration copies and verify**

Run: `npm run skill:generate && npm run skill:check`
Expected: `skill:generate` exits 0 silently; `skill:check` exits 0 with no "stale generated skill copies" error. Confirm both copies picked up the change:

```bash
rg -n "doctor --stats" integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md
```

Expected: one match in each file.

- [ ] **Step 5: Commit**

```bash
git add docs/sourcemap.md docs/cli-reference.md skills/using-taskferry/SKILL.md integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md
git commit -m "docs(doctor): document --stats in sourcemap, cli-reference, and using-taskferry SKILL.md"
```
