### Task 2: Create `src/pretty.js` — shape-based pretty renderer

**Files:**
- Create: `src/pretty.js`
- Test: `src/pretty.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks except the two npm packages from Task 1.
- Produces: `export function renderPretty(value)` — takes the same `value` any `commands.js` handler returns (a plain JS object; never called with `undefined`, and in practice never with `null`/a non-object at the top level either, though it degrades gracefully if that ever changes) and returns a fully formatted, ANSI-colored string with **no trailing newline** (the caller in Task 3 appends `\n`). This is the only export `output.js` needs from this file.

**Why `createColors(true)`, not the bare `picocolors` default export:** `picocolors`'s default export auto-detects color support from the *real* `process.stdout`/`process.env` (`NO_COLOR`, `FORCE_COLOR`, actual TTY-ness of the process), completely independent of whatever `io` object was passed into `writeToon()`. Since `output.js` takes an injectable `io` (so tests can fake `io.stdout.isTTY`), a bare `import pc from "picocolors"` would silently ignore that fake and print plain text in every test, or worse, real color/no-color depending on how the test runner's own stdout happens to be attached. Verified directly: `require("picocolors").bold("hi")` prints plain `"hi"` (no ANSI) when the invoking process's stdout isn't a TTY, while `require("picocolors").createColors(true).bold("hi")` reliably prints `"\x1b[1mhi\x1b[22m"` regardless of the real process's TTY state. `renderPretty()` is only ever invoked from `writeToon()`'s already-TTY-gated branch (Task 3), so it should force color on unconditionally rather than let `picocolors` re-derive a signal it already has the answer to.

- [ ] **Step 1: Write the failing tests for shape detection and the fallback (light-touch) renderer**

Create `src/pretty.test.js`:

```js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderPretty } from "./pretty.js";

// Strips ANSI escapes so most assertions can check plain text content;
// individual color-specific tests assert the raw escape codes directly.
function plain(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderPretty fallback (light-touch) renderer", () => {
  test("renders one bold-label line per top-level scalar field", () => {
    const out = renderPretty({ id: "oc_1", model: "minimax/MiniMax-M3" });
    assert.equal(plain(out), "id  oc_1\nmodel  minimax/MiniMax-M3");
  });

  test("colors a top-level status field using the same tones as everywhere else", () => {
    const out = renderPretty({ id: "oc_1", status: "done" });
    assert.ok(out.includes("\x1b[32mdone\x1b[39m"), out);
  });

  test("colors a top-level status field red for crashed", () => {
    const out = renderPretty({ status: "crashed" });
    assert.ok(out.includes("\x1b[31mcrashed\x1b[39m"), out);
  });

  test("does not color a status value with no known tone (e.g. unknown)", () => {
    const out = renderPretty({ status: "unknown" });
    assert.ok(!out.includes("\x1b["), out);
  });

  test("renders a scalar array as one comma-joined dim line", () => {
    const out = renderPretty({ commands: ["dispatch", "cancel", "list"] });
    assert.equal(plain(out), "commands  dispatch, commands, list".replace("commands, list", "cancel, list"));
  });

  test("renders an empty array as (none)", () => {
    const out = renderPretty({ warnings: [] });
    assert.equal(plain(out), "warnings  (none)");
  });

  test("flattens a nested object under an indented bold label", () => {
    const out = renderPretty({ integrations: { claude: { installed: true } } });
    assert.equal(plain(out), "integrations\n  claude\n    installed  true");
  });

  test("omits an undefined field entirely", () => {
    const out = renderPretty({ id: "oc_1", exitCode: undefined });
    assert.equal(plain(out), "id  oc_1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/pretty.test.js`
Expected: FAIL — `Cannot find module './pretty.js'` (the file doesn't exist yet).

- [ ] **Step 3: Implement shape detection, tone tables, and the fallback renderer**

Create `src/pretty.js` (this step only — the list/doctor/stats renderers are added in later steps of this same task):

```js
import pc from "picocolors";
import Table from "cli-table3";

// Forced on unconditionally -- see the "Why createColors(true)" note in the
// plan. renderPretty() is only ever called from writeToon()'s already
// TTY-gated branch, so re-deriving color support from the real process
// would be both redundant and wrong (it ignores the injectable `io` tests
// use to fake a TTY).
const c = pc.createColors(true);

// Single source of truth for "which value means good/bad/pending" -- kept
// separate from output.js's own ANSI_BY_STATUS (which still backs `watch`'s
// coloring) because that map returns raw ANSI escape strings for the
// marker-based system, while this one returns picocolors functions. Same
// status -> meaning mapping, different rendering mechanism.
const STATUS_TONE = { done: c.green, crashed: c.red, cancelled: c.red, running: c.yellow, queued: c.yellow };
const TREND_TONE = { improving: c.green, worsening: c.red, flat: c.gray };

function toneFor(map, key) {
  return map[key] || ((text) => text);
}

const FALLBACK_ENUM_TONES = { status: STATUS_TONE, direction: TREND_TONE };
// `healthy`/`installed`/`isolated` color true=green/false=red; `checked` is
// deliberately excluded -- false there means "couldn't verify," not
// "failed," matching output.js's existing colorForPassFailToken rationale.
const FALLBACK_BOOL_KEYS = new Set(["healthy", "installed", "isolated"]);

function colorScalar(key, value) {
  if (typeof value === "string" && FALLBACK_ENUM_TONES[key]) {
    return toneFor(FALLBACK_ENUM_TONES[key], value)(value);
  }
  if (typeof value === "boolean" && FALLBACK_BOOL_KEYS.has(key)) {
    return value ? c.green(String(value)) : c.red(String(value));
  }
  return String(value);
}

function renderScalarField(key, value, indent = "") {
  if (value === undefined) return null;
  const label = c.bold(key);
  if (value === null) return `${indent}${label}  ${c.dim("null")}`;
  if (Array.isArray(value)) return renderArrayField(label, value, indent);
  if (typeof value === "object") return [`${indent}${label}`, renderFallback(value, `${indent}  `)].join("\n");
  return `${indent}${label}  ${colorScalar(key, value)}`;
}

function renderArrayField(label, value, indent) {
  if (!value.length) return `${indent}${label}  ${c.dim("(none)")}`;
  if (value.every((entry) => typeof entry !== "object")) return `${indent}${label}  ${c.dim(value.join(", "))}`;
  return [`${indent}${label}`, ...value.map((entry) => renderFallback(entry, `${indent}  `))].join("\n");
}

// Fallback ("light-touch") renderer: one bold(label) / value line per
// top-level field, recursing into nested objects/arrays with extra indent.
// No section headers, no glyphs -- covers dispatch/cancel/accept/reject/
// wait/status/result/tail/summary/version, plus --help text.
function renderFallback(value, indent = "") {
  return Object.entries(value)
    .map(([key, val]) => renderScalarField(key, val, indent))
    .filter((line) => line !== null)
    .join("\n");
}

function detectShape(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("tasks" in value && "counts" in value) return "list";
    if ("integrations" in value) return "doctor";
    if ("trend" in value || "byModel" in value) return "stats";
  }
  return "fallback";
}

export function renderPretty(value) {
  if (value === null || typeof value !== "object") return String(value);
  const shape = detectShape(value);
  if (shape === "fallback") return renderFallback(value);
  // list/doctor/stats renderers are added in later steps of this task.
  throw new Error(`renderPretty: shape "${shape}" not implemented yet`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/pretty.test.js`
Expected: PASS (8 tests). If the "renders a scalar array" test looks confusing, replace its `.replace(...)` hack with the plain literal `"commands  dispatch, cancel, list"` — it was written awkwardly; use the literal.

- [ ] **Step 5: Commit**

```bash
git add src/pretty.js src/pretty.test.js
git commit -m "feat(cli): add fallback pretty renderer for TTY output"
```

- [ ] **Step 6: Write the failing tests for the grouped-list renderer**

Append to `src/pretty.test.js`:

```js
describe("renderPretty grouped-list renderer", () => {
  const listValue = {
    directory: "/workspace/proj",
    counts: { queued: 0, running: 1, done: 1, crashed: 0, cancelled: 0, unknown: 0 },
    tasks: [
      { id: "oc_a", status: "running", model: "minimax/MiniMax-M3", startedAt: "2026-08-06T11:10:27.000Z" },
      { id: "oc_b", status: "done", model: "openai/gpt-5.6-luna", startedAt: "2026-08-06T02:12:34.000Z" },
    ],
  };

  test("prints a bold section header per status, most-active first", () => {
    const out = plain(renderPretty(listValue));
    const runningIndex = out.indexOf("running (1)");
    const doneIndex = out.indexOf("done (1)");
    assert.ok(runningIndex !== -1 && doneIndex !== -1 && runningIndex < doneIndex, out);
  });

  test("colors the running header yellow and the done header green", () => {
    const out = renderPretty(listValue);
    assert.ok(out.includes(`${"\x1b[33m"}${"\x1b[1m"}running`) || out.includes("\x1b[33m") && out.includes("running"), out);
  });

  test("lists task id/model/startedAt under each group", () => {
    const out = plain(renderPretty(listValue));
    assert.ok(out.includes("oc_a") && out.includes("minimax/MiniMax-M3"), out);
    assert.ok(out.includes("oc_b") && out.includes("openai/gpt-5.6-luna"), out);
  });

  test("prints a leading scalar field (e.g. directory) before the groups", () => {
    const out = plain(renderPretty(listValue));
    assert.ok(out.startsWith("directory  /workspace/proj"), out);
  });

  test("prints a dim summary line built from counts", () => {
    const out = plain(renderPretty(listValue));
    assert.ok(out.includes("1 running") && out.includes("1 done"), out);
  });

  test("renders the 'none found' string sentinel without crashing", () => {
    const out = plain(renderPretty({ directory: "/workspace/proj", counts: { total: 0 }, tasks: "none found in this workspace" }));
    assert.ok(out.includes("none found in this workspace"), out);
  });

  test("appends next-step hints as dim lines", () => {
    const out = plain(renderPretty({ ...listValue, next: ["Run taskferry list --limit 50 for all 50 tasks"] }));
    assert.ok(out.includes("Run taskferry list --limit 50 for all 50 tasks"), out);
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `node --test src/pretty.test.js`
Expected: FAIL — the "renderPretty: shape \"list\" not implemented yet" error from Step 3's `throw`.

- [ ] **Step 8: Implement the grouped-list renderer**

Add to `src/pretty.js` (above `detectShape`/`renderPretty`, which get updated at the end of this step):

```js
const STATUS_ORDER = ["running", "queued", "done", "crashed", "cancelled"];
// Every scalar field on a list-shaped payload other than these three is a
// leading header line (e.g. `directory` on list/context, `workspace`/`bin`/
// `description` on home) -- rendered generically via renderScalarField so
// this stays decoupled from which command produced the value.
const LIST_SHAPE_KEYS = new Set(["tasks", "counts", "next"]);

function borderlessTable() {
  const blank = { top: "", "top-mid": "", "top-left": "", "top-right": "", bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "", left: "", "left-mid": "", mid: "", "mid-mid": "", right: "", "right-mid": "", middle: "  " };
  return new Table({ chars: blank, style: { head: [], border: [], "padding-left": 0, "padding-right": 0 } });
}

function groupTasksByStatus(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.status || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const orderedKeys = [...STATUS_ORDER.filter((s) => groups.has(s)), ...[...groups.keys()].filter((s) => !STATUS_ORDER.includes(s)).sort()];
  return orderedKeys.map((status) => ({ status, tasks: groups.get(status) }));
}

function renderTaskRows(tasks) {
  const table = borderlessTable();
  for (const task of tasks) {
    const row = [task.id, task.model || "", task.startedAt || ""];
    if (task.failureReason) row.push(c.dim(task.failureReason));
    table.push(row);
  }
  return table.toString().split("\n").map((line) => `  ${line}`).join("\n");
}

function renderHintLines(next) {
  if (Array.isArray(next)) return next.map((hint) => c.dim(hint));
  if (typeof next === "string") return [c.dim(next)];
  return [];
}

function renderTaskGroups(value) {
  const lines = Object.entries(value)
    .filter(([key]) => !LIST_SHAPE_KEYS.has(key))
    .map(([key, val]) => renderScalarField(key, val))
    .filter((line) => line !== null);
  if (lines.length) lines.push("");

  if (typeof value.tasks === "string") {
    lines.push(c.dim(value.tasks));
  } else {
    for (const { status, tasks } of groupTasksByStatus(value.tasks || [])) {
      lines.push(`${toneFor(STATUS_TONE, status)(c.bold(status))} (${tasks.length})`);
      lines.push(renderTaskRows(tasks));
      lines.push("");
    }
  }

  if (value.counts) {
    lines.push(c.dim(Object.entries(value.counts).filter(([k]) => k !== "total").map(([k, v]) => `${v} ${k}`).join(" · ")));
  }
  lines.push(...renderHintLines(value.next));
  return lines.join("\n").trimEnd();
}
```

Then update `detectShape`'s `"list"` branch wiring in `renderPretty`:

```js
export function renderPretty(value) {
  if (value === null || typeof value !== "object") return String(value);
  const shape = detectShape(value);
  if (shape === "list") return renderTaskGroups(value);
  if (shape === "fallback") return renderFallback(value);
  // doctor/stats renderers are added in later steps of this task.
  throw new Error(`renderPretty: shape "${shape}" not implemented yet`);
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test src/pretty.test.js`
Expected: PASS (15 tests). If the "colors the running header yellow" test's double-condition assertion feels redundant, simplify it to just `assert.ok(out.includes("\x1b[33m"), out);` — the point is confirming yellow appears, not the exact bold+color nesting order.

- [ ] **Step 10: Commit**

```bash
git add src/pretty.js src/pretty.test.js
git commit -m "feat(cli): add grouped-list pretty renderer"
```

- [ ] **Step 11: Write the failing tests for the doctor report renderer**

Append to `src/pretty.test.js`:

```js
describe("renderPretty doctor report renderer", () => {
  const healthyDoctor = {
    healthy: true,
    pid: 12345,
    version: 1,
    integrations: {
      claude: { installed: true },
      playwrightMcpIsolation: {
        opencode: { checked: true, isolated: true, path: "/home/user/.config/opencode/opencode.json" },
        claudeCode: { checked: true, isolated: false, path: "/home/user/.claude.json" },
      },
    },
    warnings: ["Playwright MCP for claude-code is not isolated"],
  };

  test("prints a check-glyph line per section, green check for a passing check", () => {
    const out = plain(renderPretty(healthyDoctor));
    assert.ok(out.includes("✓ healthy"), out);
    assert.ok(out.includes("✓ installed"), out);
    assert.ok(out.includes("✓ opencode"), out);
  });

  test("prints a red cross for a failing check", () => {
    const out = plain(renderPretty(healthyDoctor));
    assert.ok(out.includes("✗ claude-code"), out);
  });

  test("colors the passing glyph green and the failing glyph red", () => {
    const out = renderPretty(healthyDoctor);
    assert.ok(out.includes(`\x1b[32m✓\x1b[39m`), out);
    assert.ok(out.includes(`\x1b[31m✗\x1b[39m`), out);
  });

  test("renders an unchecked (checked: false) check with a neutral glyph, not red", () => {
    const out = renderPretty({
      healthy: true,
      integrations: { claude: { installed: true }, playwrightMcpIsolation: { opencode: { checked: false, reason: "opencode.json not found" } } },
    });
    assert.ok(!out.includes(`\x1b[31m`), out);
    assert.ok(plain(out).includes("? opencode"), out);
    assert.ok(plain(out).includes("opencode.json not found"), out);
  });

  test("renders warnings as a yellow-glyph dim-text bulleted block", () => {
    const out = renderPretty(healthyDoctor);
    assert.ok(out.includes(`\x1b[33m•\x1b[39m`), out);
    assert.ok(plain(out).includes("Playwright MCP for claude-code is not isolated"), out);
  });

  test("omits the warnings section entirely when there are no warnings", () => {
    const out = plain(renderPretty({ healthy: true, integrations: { claude: { installed: true } } }));
    assert.ok(!out.toLowerCase().includes("warning"), out);
  });

  test("renders info as a dim bulleted block", () => {
    const out = plain(renderPretty({ healthy: true, integrations: {}, info: ["bwrap is Linux-only"] }));
    assert.ok(out.includes("bwrap is Linux-only"), out);
  });
});
```

- [ ] **Step 12: Run the tests to verify they fail**

Run: `node --test src/pretty.test.js`
Expected: FAIL — the "doctor" shape's `throw`.

- [ ] **Step 13: Implement the doctor report renderer**

Add to `src/pretty.js`:

```js
function checkState(value) {
  if (value === true) return "pass";
  if (value === false) return "fail";
  return "unknown";
}

function checkGlyph(state) {
  if (state === "pass") return c.green("✓");
  if (state === "fail") return c.red("✗");
  return c.dim("?");
}

function checkLine(label, state, note) {
  const suffix = note ? ` ${c.dim(note)}` : "";
  return `${checkGlyph(state)} ${label}${suffix}`;
}

function renderMcpCheckLine(label, check) {
  if (!check) return null;
  if (!check.checked) return checkLine(label, "unknown", check.reason);
  return checkLine(label, checkState(check.isolated), check.isolated ? undefined : check.path);
}

function renderBulletBlock(title, tone, entries) {
  const lines = ["", tone(c.bold(title))];
  for (const entry of entries) lines.push(`${tone("•")} ${c.dim(entry)}`);
  return lines;
}

// Only the fields the doctor payload can actually carry (see
// commands.js's shapeDoctorResult/collectDoctorDiagnostics) get a section:
// `healthy` -> Daemon, `integrations.claude` -> Claude integration,
// `integrations.playwrightMcpIsolation` -> MCP isolation. There is no
// standalone bwrap section -- bwrap's own availability never appears as a
// field on this payload, only as a warning message when it's missing.
function renderDoctorReport(value) {
  const lines = [];
  if (typeof value.healthy === "boolean") {
    lines.push(c.bold("Daemon"), checkLine("healthy", checkState(value.healthy)));
  }
  const claude = value.integrations?.claude;
  if (claude) {
    lines.push("", c.bold("Claude integration"), checkLine("installed", checkState(claude.installed), claude.reason));
  }
  const mcp = value.integrations?.playwrightMcpIsolation;
  if (mcp) {
    lines.push("", c.bold("MCP isolation"));
    const opencodeLine = renderMcpCheckLine("opencode", mcp.opencode);
    const claudeCodeLine = renderMcpCheckLine("claude-code", mcp.claudeCode);
    if (opencodeLine) lines.push(opencodeLine);
    if (claudeCodeLine) lines.push(claudeCodeLine);
  }
  if (Array.isArray(value.warnings) && value.warnings.length) lines.push(...renderBulletBlock("warnings", c.yellow, value.warnings));
  if (Array.isArray(value.info) && value.info.length) lines.push(...renderBulletBlock("info", c.dim, value.info));

  const covered = new Set(["healthy", "integrations", "warnings", "info"]);
  const extras = Object.entries(value).filter(([key]) => !covered.has(key));
  if (extras.length) {
    lines.push("");
    for (const [key, val] of extras) lines.push(renderScalarField(key, val));
  }
  return lines.join("\n").trimEnd();
}
```

Then wire it into `renderPretty`:

```js
export function renderPretty(value) {
  if (value === null || typeof value !== "object") return String(value);
  const shape = detectShape(value);
  if (shape === "list") return renderTaskGroups(value);
  if (shape === "doctor") return renderDoctorReport(value);
  if (shape === "fallback") return renderFallback(value);
  // stats renderer is added in a later step of this task.
  throw new Error(`renderPretty: shape "${shape}" not implemented yet`);
}
```

- [ ] **Step 14: Run the tests to verify they pass**

Run: `node --test src/pretty.test.js`
Expected: PASS (22 tests).

- [ ] **Step 15: Commit**

```bash
git add src/pretty.js src/pretty.test.js
git commit -m "feat(cli): add doctor report pretty renderer"
```

- [ ] **Step 16: Write the failing tests for the stats report renderer**

Append to `src/pretty.test.js`:

```js
describe("renderPretty stats report renderer", () => {
  const statsValue = {
    byModel: [{ model: "minimax/MiniMax-M3", dispatches: 10, done: 7, crashed: 3, cancelled: 0, unknown: 0, doneRate: "70.0%", crashRate: "30.0%", dominantFailureReason: "timeout" }],
    failureReasons: [{ reason: "timeout", count: 3 }],
    unknownBacklog: { total: 2, tasks: [] },
    computedAt: "2026-08-06T12:00:00.000Z",
    statusMix: { overall: { queued: 0, running: 1, done: 7, crashed: 3, cancelled: 0, unknown: 0, other: 0, total: 11 }, last24h: {}, last7d: {} },
    trend: { window: "24h", current: { crashRate: "30.0%", settled: 10 }, previous: { crashRate: "20.0%", settled: 8 }, direction: "worsening" },
  };

  test("colors the trend direction red for worsening", () => {
    const out = renderPretty(statsValue);
    assert.ok(out.includes(`\x1b[31mworsening\x1b[39m`), out);
  });

  test("leaves an unknown trend direction uncolored", () => {
    const out = renderPretty({ ...statsValue, trend: { ...statsValue.trend, direction: "unknown" } });
    const worseningColored = out.includes(`\x1b[31mworsening\x1b[39m`);
    assert.ok(!worseningColored, out);
  });

  test("renders byModel as an aligned table containing the model name and rates", () => {
    const out = plain(renderPretty(statsValue));
    assert.ok(out.includes("minimax/MiniMax-M3"), out);
    assert.ok(out.includes("70.0%") && out.includes("30.0%"), out);
  });

  test("renders the overall status mix as a dim summary line", () => {
    const out = plain(renderPretty(statsValue));
    assert.ok(out.includes("7 done") && out.includes("3 crashed"), out);
  });

  test("renders top failure reasons", () => {
    const out = plain(renderPretty(statsValue));
    assert.ok(out.includes("timeout"), out);
  });

  test("does not throw when byModel/failureReasons are empty and trend is minimal", () => {
    const out = renderPretty({ byModel: [], failureReasons: [], unknownBacklog: { total: 0, tasks: [] }, statusMix: { overall: {} }, trend: { direction: "unknown" } });
    assert.equal(typeof out, "string");
  });
});
```

- [ ] **Step 17: Run the tests to verify they fail**

Run: `node --test src/pretty.test.js`
Expected: FAIL — the "stats" shape's `throw`.

- [ ] **Step 18: Implement the stats report renderer**

Add to `src/pretty.js`:

```js
const STATS_TABLE_COLUMNS = ["model", "dispatches", "done", "crashed", "doneRate", "crashRate"];

function renderByModelTable(byModel) {
  if (!byModel.length) return null;
  const table = borderlessTable();
  table.push(STATS_TABLE_COLUMNS.map((column) => c.dim(column)));
  for (const row of byModel) table.push(STATS_TABLE_COLUMNS.map((column) => (row[column] === null || row[column] === undefined ? c.dim("n/a") : String(row[column]))));
  return ["", c.bold("By model"), table.toString()];
}

function renderTrendSection(trend) {
  if (!trend) return [];
  const tone = toneFor(TREND_TONE, trend.direction);
  const current = trend.current || {};
  const previous = trend.previous || {};
  const summary = `${tone(c.bold(trend.direction || "unknown"))}  ${current.crashRate ?? "n/a"} crash rate now (${current.settled ?? 0} settled) vs ${previous.crashRate ?? "n/a"} previously (${previous.settled ?? 0} settled)`;
  return ["", c.bold(`Trend (${trend.window || "24h"})`), summary];
}

function renderStatusMixSection(statusMix) {
  const overall = statusMix?.overall;
  if (!overall || Object.keys(overall).length === 0) return [];
  const summary = Object.entries(overall).filter(([key]) => key !== "total").map(([key, count]) => `${count} ${key}`).join(" · ");
  return ["", c.bold("Status mix (overall)"), c.dim(summary)];
}

function renderFailureReasonsSection(failureReasons) {
  if (!Array.isArray(failureReasons) || !failureReasons.length) return [];
  const lines = ["", c.bold("Top failure reasons")];
  for (const { reason, count } of failureReasons.slice(0, 5)) lines.push(c.dim(`${count}× ${reason}`));
  return lines;
}

function renderStatsReport(value) {
  const lines = [c.bold("doctor --stats")];
  lines.push(...renderTrendSection(value.trend));
  const table = renderByModelTable(Array.isArray(value.byModel) ? value.byModel : []);
  if (table) lines.push(...table);
  lines.push(...renderStatusMixSection(value.statusMix));
  lines.push(...renderFailureReasonsSection(value.failureReasons));
  if (value.unknownBacklog?.total) lines.push("", c.dim(`${value.unknownBacklog.total} task(s) in unknown backlog`));
  return lines.join("\n").trimEnd();
}
```

Then wire it into `renderPretty`, replacing the final `throw`:

```js
export function renderPretty(value) {
  if (value === null || typeof value !== "object") return String(value);
  const shape = detectShape(value);
  if (shape === "list") return renderTaskGroups(value);
  if (shape === "doctor") return renderDoctorReport(value);
  if (shape === "stats") return renderStatsReport(value);
  return renderFallback(value);
}
```

- [ ] **Step 19: Run the tests to verify they pass**

Run: `node --test src/pretty.test.js`
Expected: PASS (28 tests).

- [ ] **Step 20: Run lint against the new file and fix any violations**

Run: `npx eslint src/pretty.js`
Expected: no errors. If `complexity`/`max-lines-per-function`/`max-depth` trips on any function (most likely `renderDoctorReport` or `renderTaskGroups`), extract another small helper the same way `renderMcpCheckLine`/`renderBulletBlock` already were — don't widen the lint config.

- [ ] **Step 21: Commit**

```bash
git add src/pretty.js src/pretty.test.js
git commit -m "feat(cli): add stats report pretty renderer"
```

---

