import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderPretty } from "./pretty.js";

const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const MODEL_MINIMAX = "minimax/MiniMax-M3";
function plain(text) {
  return text.replace(ANSI_RE, "");
}

describe("renderPretty fallback (light-touch) renderer", () => {
  test("renders one bold-label line per top-level scalar field", () => {
    const out = renderPretty({ id: "oc_1", model: MODEL_MINIMAX });
    assert.equal(plain(out), `id  oc_1\nmodel  ${MODEL_MINIMAX}`);
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
    assert.ok(!out.includes("\x1b[3"), out);
  });

  test("renders a scalar array as one comma-joined dim line", () => {
    const out = renderPretty({ commands: ["dispatch", "cancel", "list"] });
    assert.equal(plain(out), "commands  dispatch, cancel, list");
  });

  test("renders an empty array as (none)", () => {
    const out = renderPretty({ warnings: [] });
    assert.equal(plain(out), "warnings  (none)");
  });

  test("flattens a nested object under an indented bold label", () => {
    const out = renderPretty({ metadata: { claude: { installed: true } } });
    assert.equal(plain(out), "metadata\n  claude\n    installed  true");
  });

  test("omits an undefined field entirely", () => {
    const out = renderPretty({ id: "oc_1", exitCode: void 0 });
    assert.equal(plain(out), "id  oc_1");
  });
});

describe("renderPretty grouped-list renderer", () => {
  const listValue = {
    directory: "/workspace/proj",
    counts: { queued: 0, running: 1, done: 1, crashed: 0, cancelled: 0, unknown: 0 },
    tasks: [
      { id: "oc_a", status: "running", model: MODEL_MINIMAX, startedAt: "2026-08-06T11:10:27.000Z" },
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
    assert.ok(out.includes("\x1b[33m"), out);
  });

  test("lists task id/model/startedAt under each group", () => {
    const out = plain(renderPretty(listValue));
    assert.ok(out.includes("oc_a") && out.includes(MODEL_MINIMAX), out);
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

describe("renderPretty stats report renderer", () => {
  const statsValue = {
    byModel: [{ model: MODEL_MINIMAX, dispatches: 10, done: 7, crashed: 3, cancelled: 0, unknown: 0, doneRate: "70.0%", crashRate: "30.0%", dominantFailureReason: "timeout" }],
    failureReasons: [{ reason: "timeout", count: 3 }],
    unknownBacklog: { total: 2, tasks: [] },
    computedAt: "2026-08-06T12:00:00.000Z",
    statusMix: { overall: { queued: 0, running: 1, done: 7, crashed: 3, cancelled: 0, unknown: 0, other: 0, total: 11 }, last24h: {}, last7d: {} },
    trend: { window: "24h", current: { crashRate: "30.0%", settled: 10 }, previous: { crashRate: "20.0%", settled: 8 }, direction: "worsening" },
  };

  test("colors the trend direction red for worsening", () => {
    const out = renderPretty(statsValue);
    assert.ok(out.includes(`\x1b[31m\x1b[1mworsening\x1b[22m\x1b[39m`), out);
  });

  test("leaves an unknown trend direction uncolored", () => {
    const out = renderPretty({ ...statsValue, trend: { ...statsValue.trend, direction: "unknown" } });
    const worseningColored = out.includes(`\x1b[31mworsening\x1b[39m`);
    assert.ok(!worseningColored, out);
  });

  test("renders byModel as an aligned table containing the model name and rates", () => {
    const out = plain(renderPretty(statsValue));
    assert.ok(out.includes(MODEL_MINIMAX), out);
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
