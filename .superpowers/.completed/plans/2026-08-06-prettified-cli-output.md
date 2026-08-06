# Prettified CLI output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `taskferry`'s stdout is a real terminal, replace today's thin ANSI-on-TOON color overlay with genuinely restructured output (bold section labels, grouped task lists, pass/fail glyphs, aligned columns). A non-TTY consumer (pipe, script, this agent's own harness calls) keeps getting exactly today's plain TOON text, unchanged.

**Architecture:** `src/output.js`'s `writeToon()` stays the single entry point every command's result flows through. Its TTY branch is replaced: instead of TOON-encoding the value and then patching colored spans into the resulting text via invisible Unicode markers, it calls a new renderer (`src/pretty.js`) that operates directly on the JS value and produces the final formatted string itself — no TOON encoding involved on that path at all. The renderer picks one of four layouts based on the shape of the value (does it have `tasks`+`counts`? an `integrations` key? a `trend`/`byModel` key? none of those?), matching the existing codebase's precedent of keying behavior off field shape rather than which command produced it.

**Tech Stack:** Node.js (ESM, `"type": "module"`), `node:test` for tests, `picocolors` (new dependency, color), `cli-table3` (new dependency, borderless column alignment only).

## Global Constraints

- Non-TTY output must remain byte-identical to today's TOON encode — verified by keeping every existing non-TTY test in `output.test.js` passing unchanged.
- No new CLI flag (`--pretty`/`--plain`) — TTY detection (`Boolean(io.stdout.isTTY)`) is the only signal, matching today's existing gating.
- `formatWatchEvent()` / `formatActivityLine()` (the `watch` command's live-event coloring) are untouched by this plan — they keep using the existing `ANSI_*` constants and `colorForStatus()` exactly as today; do not route them through `pretty.js`.
- Stay within this repo's lint limits (`eslint.config.js`): `complexity` ≤ 15, `max-depth` ≤ 4, `max-lines-per-function` ≤ 80 (excluding blank/comment lines), `max-lines` ≤ 400 per file. If a renderer function grows past these, extract a helper — don't disable the rule.
- Commit messages use Conventional Commits format (`<type>(<scope>): <description>`, imperative mood).
- Use `rg`/`fd` for search, never `grep`/`find`, if any step needs to search the codebase.

---

### Task 1: Add `picocolors` and `cli-table3` dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `picocolors` (`import pc from "picocolors"`, then `const colors = pc.createColors(true)` — see Task 2 for why the factory form is required, not the bare default export) and `cli-table3` (`import Table from "cli-table3"`) available for `src/pretty.js` to import in Task 2.

- [ ] **Step 1: Add the two dependencies with exact pinned versions**

Edit the `"dependencies"` block in `package.json`:

```json
  "dependencies": {
    "@toon-format/toon": "^2.3.0",
    "cli-table3": "^0.6.5",
    "picocolors": "^1.1.1"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `package-lock.json` updates to include `cli-table3` and `picocolors` with no errors.

- [ ] **Step 3: Verify both import cleanly under this repo's ESM setup**

Run: `node -e "import('cli-table3').then(m => console.log(typeof m.default)); import('picocolors').then(m => console.log(typeof m.default.createColors))"`
Expected: prints `function` twice (the `Table` class constructor, and the `createColors` factory function).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add picocolors and cli-table3 dependencies"
```

---

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

### Task 3: Wire `pretty.js` into `writeToon()`, remove the dead marker-based coloring code

**Files:**
- Modify: `src/output.js`
- Modify: `src/output.test.js`

**Interfaces:**
- Consumes: `renderPretty(value)` from `src/pretty.js` (Task 2).
- Produces: `writeToon(value, io)`'s public signature and non-TTY behavior are unchanged; its TTY behavior now calls `renderPretty()` instead of the marker/encode path.

This task also deletes now-dead code: `markColorableFields`, `colorizeText`, `colorForMarkedToken`, `colorForTrendDirection`, `colorForPassFailToken`, the `ENUM_MARK`/`WARN_MARK`/`INFO_MARK`/`MARK_RE` constants, `ENUM_KEYS`/`WARN_KEYS`/`INFO_KEYS`, `isMarkableScalar`, `markStringArray`, `ANSI_BY_TREND_DIRECTION`, `ANSI_GRAY`, and `ANSI_DIM`. These existed only to patch color into TOON-encoded text after the fact; once `writeToon()`'s TTY branch no longer encodes-then-patches, nothing else in the codebase calls them (verified: `rg -n "colorForTrendDirection|colorForPassFailToken|markColorableFields|colorizeText" src --type js` after this task's edit should return zero hits outside `pretty.js`'s own, differently-named equivalents). `colorize`, `colorForStatus`, `ANSI_RESET`/`ANSI_GREEN`/`ANSI_RED`/`ANSI_YELLOW`, and `ANSI_BY_STATUS` all stay — `formatActivityLine()` (the `watch` command's coloring) still uses them directly.

- [ ] **Step 1: Write the failing test for the new TTY behavior**

`markColorableFields` and `colorizeText` aren't currently imported directly in
`src/output.test.js` (the existing import list is `colorize, errorValue,
formatWatchEvent, homeView, leanStatus, projectContext, projectDoctorStats,
projectList, writeToon`), so their removal from `output.js` in Step 3 needs no
import-line change on that account. This step does need to add `writeError`
to that import list, though — see the code block below.

Replace the entire `describe("writeToon status coloring", ...)` and
`describe("writeToon doctor coloring", ...)` blocks (they assert the old
marker-patched-TOON-text output, which no longer exists) with:

```js
describe("writeToon TTY output", () => {
  test("routes to the pretty renderer when stdout is a TTY", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ id: "a", status: "done" }, io);

    assert.ok(output().includes("\x1b[32mdone\x1b[39m"), output());
    assert.ok(!output().includes("status: "), output()); // no TOON `key: value` syntax
  });

  test("still writes plain TOON with no ANSI codes when stdout is not a TTY", () => {
    const { io, output } = fakeStdoutIo(false);
    writeToon({ id: "a", status: "done" }, io);

    assert.ok(!output().includes("\x1b["), output());
    assert.ok(output().includes("status: done"), output());
  });

  test("non-TTY output for a task list is byte-identical to the pre-existing TOON shape", () => {
    const { io, output } = fakeStdoutIo(false);
    writeToon({ tasks: [{ id: "a", status: "done" }, { id: "b", status: "crashed" }] }, io);

    assert.equal(output(), "tasks[2]{id,status}:\n  a,done\n  b,crashed\n\n");
  });

  test("writeError on a TTY falls through to the fallback renderer's bold labels (intentional -- see the spec's Error output section)", () => {
    const { io, output } = fakeStdoutIo(true);
    writeError(new Error("error: boom\nhelp: try again"), io);

    assert.ok(output().includes("boom"), output());
    assert.ok(output().includes("try again"), output());
    assert.ok(!output().includes("error: boom"), output()); // not raw TOON `key: value` syntax anymore
  });

  test("writeError on non-TTY is unchanged: plain TOON error:/help: lines", () => {
    const { io, output } = fakeStdoutIo(false);
    writeError(new Error("error: boom\nhelp: try again"), io);

    assert.ok(!output().includes("\x1b["), output());
    assert.ok(output().includes("error: boom") && output().includes("help: try again"), output());
  });
});
```

`writeError` isn't in this file's current import list — add it alongside `writeToon`:

```js
import { colorize, errorValue, formatWatchEvent, homeView, leanStatus, projectContext, projectDoctorStats, projectList, writeError, writeToon } from "./output.js";
```

(The third test's exact expected TOON string should be confirmed against this repo's actual `@toon-format/toon` output before treating it as fixed — run Step 2 below and adjust the literal to match whatever the real `encode()` output is; the goal is a byte-identical non-TTY snapshot, not a specific guessed string.)

- [ ] **Step 2: Run the tests to verify the new ones fail (and see the real non-TTY TOON string for the byte-identical test)**

Run: `node --test src/output.test.js`
Expected: the two `writeToon TTY output` "routes to the pretty renderer"/"still writes plain TOON" tests FAIL (still hitting the old marker-based code path, so the TTY one won't see `\x1b[32mdone\x1b[39m` and may see `\x1b[32mdone\x1b[0m` instead, or the old code's exact byte sequence — either way it won't match). Copy the actual printed non-TTY string from the third test's failure output (if it fails) into the test literal so it's a real captured value, not a guess.

- [ ] **Step 3: Delete the dead marker-based coloring code from `output.js`**

Remove these from `src/output.js` (lines given are from the file's current state before this task's edits; re-locate by content if line numbers have drifted from earlier commits in this same session):

- `ANSI_GRAY` (line 9) and `ANSI_DIM` (line 10) constants
- `ANSI_BY_TREND_DIRECTION` (line 34) and `colorForTrendDirection()` (lines 35-37)
- `colorForPassFailToken()` (lines 44-48)
- The entire comment block plus `ENUM_MARK`/`WARN_MARK`/`INFO_MARK`/`MARK_RE` (lines 50-70)
- `ENUM_KEYS`/`WARN_KEYS`/`INFO_KEYS` (lines 72-80)
- `isMarkableScalar()` (lines 82-84)
- `markStringArray()` (lines 86-88)
- `markColorableFields()` (lines 90-101)
- `colorForMarkedToken()` (lines 103-107)
- `colorizeText()` (lines 109-115)

- [ ] **Step 4: Replace `writeToon()` with the TTY-gated dispatch**

Change (originally at line 121-125):

```js
export function writeToon(value, io = process) {
  const useColor = Boolean(io.stdout.isTTY);
  const text = encode(useColor ? markColorableFields(value) : value);
  io.stdout.write(`${colorizeText(text, useColor)}\n`);
}
```

to:

```js
export function writeToon(value, io = process) {
  if (io.stdout.isTTY) {
    io.stdout.write(`${renderPretty(value)}\n`);
    return;
  }
  io.stdout.write(`${encode(value)}\n`);
}
```

Add the import at the top of the file, alongside the existing `encode` import:

```js
import { renderPretty } from "./pretty.js";
```

- [ ] **Step 5: Run the full `output.js` test suite and verify everything passes**

Run: `node --test src/output.test.js`
Expected: PASS, including every pre-existing non-TTY test (unchanged) and the new TTY tests from Step 1.

- [ ] **Step 6: Run the full unit test suite to catch any other test file that referenced the removed exports**

Run: `npm run test:unit`
Expected: PASS. If any other test file imports `markColorableFields`, `colorizeText`, `colorForTrendDirection`, or `colorForPassFailToken` from `output.js`, it will fail to import — confirm with `rg -n "colorForTrendDirection|colorForPassFailToken|markColorableFields|colorizeText" src --glob '*.js'` that no remaining reference exists outside `pretty.js`'s own differently-named functions, and delete/update any stray test that still references them.

- [ ] **Step 7: Commit**

```bash
git add src/output.js src/output.test.js
git commit -m "refactor(cli): route TTY output through the pretty renderer, drop dead marker-based coloring"
```

---

### Task 4: Update `docs/sourcemap.md`

**Files:**
- Modify: `docs/sourcemap.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by later tasks.

Per this project's own `CLAUDE.md` ("Keep the sourcemap up to date"), a behavior change and a new file both require a sourcemap update in the same PR.

- [ ] **Step 1: Add a row for the new file**

In the file-by-file table (the row currently starting `| `output.js` | 419 | ...`), add a new row directly after it:

```markdown
| `pretty.js` | ~330 | TTY-only "minimal accent" renderer used by `output.js`'s `writeToon()`: shape-detects a command's return value (`tasks`+`counts` -> grouped-list, `integrations` -> doctor report, `trend`/`byModel` -> stats report, else -> one-line-per-field fallback) and renders it directly with `picocolors`, with `cli-table3` (borders blanked out) used only for column alignment inside the list/stats renderers. Never touches the non-TTY path -- that's still plain `@toon-format/toon` `encode()`, unchanged. |
```

(Confirm the actual line count of the finished `src/pretty.js` with `wc -l src/pretty.js` and use the real number instead of `~330`.)

- [ ] **Step 2: Update the `output.js` row's description**

Replace the existing `output.js` row's TOON-coloring sentence (the one starting "TOON coloring (`writeToon`/`markColorableFields`/`colorizeText`) marks values with one of three invisible Unicode markers...") with:

```markdown
`writeToon()`'s TTY branch delegates entirely to `pretty.js`'s `renderPretty()` (see that row); its non-TTY branch is still a plain `@toon-format/toon` `encode()` call, byte-identical to before this changed. `colorize()`/`colorForStatus()`/`ANSI_BY_STATUS` remain here and are used only by `formatWatchEvent()`/`formatActivityLine()` (the `watch` command's own, separate TTY-gated coloring, untouched by the `pretty.js` renderer).
```

- [ ] **Step 3: Update the top-of-file call-chain summary line if present**

Find the line near the top of `docs/sourcemap.md` that currently reads `-> output.js     TOON formatting, lean field projection, MCP-era hint` (or similar) and extend it to mention the new split, e.g.:

```
-> output.js     lean field projection, TOON encode (non-TTY) / pretty.js render (TTY)
-> pretty.js     shape-based "minimal accent" renderer for a real terminal
```

- [ ] **Step 4: Commit**

```bash
git add docs/sourcemap.md
git commit -m "docs(sourcemap): document pretty.js and the writeToon TTY/non-TTY split"
```

---

### Task 5: Full verification pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full check script**

Run: `npm run check`
Expected: PASS (syntax check on every tracked `.js` file, `eslint .`, `tsc --noEmit`). Fix any lint/type error surfaced here before proceeding — do not skip or silence.

- [ ] **Step 2: Run the full unit test suite one more time**

Run: `npm run test:unit`
Expected: PASS, 0 failures.

- [ ] **Step 3: Manually verify real TTY output for at least `doctor` and `list`**

These run against the live daemon this session already has running, so use a workspace/task set that actually exists rather than inventing one. From a real interactive terminal (not through a piped agent tool call, which is non-TTY and would just show the unchanged plain path):

```bash
node src/cli.js doctor
node src/cli.js list
node src/cli.js doctor --stats
node src/cli.js dispatch --help
```

Expected: `doctor` shows bold section labels and green/red glyphs; `list` shows grouped, colored status headers with aligned columns underneath; `doctor --stats` shows a trend line and an aligned by-model table; `--help` output still reads correctly under the fallback renderer (bold labels, comma-joined `commands`/`options`/`examples` lines).

If this session has no real TTY available to it, ask the user to run these four commands themselves and confirm the output looks right — do not claim this step is done without either running it in a real terminal or getting that confirmation.

- [ ] **Step 4: Confirm non-TTY output is unaffected by piping the same commands**

```bash
node src/cli.js doctor | cat
node src/cli.js list | cat
```

Expected: plain TOON text, no ANSI escapes, identical in shape to what these commands printed before this plan's changes.

- [ ] **Step 5: Report results**

Summarize: lint/typecheck status, unit test count and pass/fail, and what the manual TTY check showed (or who confirmed it, if delegated to the user).
