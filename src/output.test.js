import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { colorize, errorValue, formatWatchEvent, homeView, leanStatus, projectContext, projectDoctorStats, projectList, writeToon } from "./output.js";

const TASK_ACTIVITY = "task.activity";
const TASK_STATE = "task.state";
const WORKSPACE_PROJ = "/workspace/proj";
const OCCURRED_AT_MID = "2026-07-18T00:06:12.414Z";
const OCCURRED_AT_LATE = "2026-07-18T00:24:11.282Z";
const WORKSPACE_EXAMPLE = "/workspace/example";
const TASKFERRY_BIN = "/bin/taskferry";
const TASK_MODEL_SOL = "openai/gpt-5.6-sol";
const TASK_STARTED_AT_EXAMPLE = "2026-08-01T00:00:00.000Z";
const REVEAL_HINT_805 = "Run taskferry list --limit 805 for all 805 tasks";

function fakeCappedTasks(totalCount) {
  return Array.from({ length: totalCount }, (_, i) => ({
    id: `task-${i}`,
    status: "done",
    model: TASK_MODEL_SOL,
    startedAt: TASK_STARTED_AT_EXAMPLE,
  }));
}

function fakeStdoutIo(isTTY) {
  let stdout = "";
  return { io: { stdout: { isTTY, write: (chunk) => { stdout += chunk; } } }, output: () => stdout };
}

function resumeHint(detail) {
  return leanStatus(detail).next;
}

describe("leanStatus crashed-resume hint", () => {
  const base = { id: "oc_1", status: "crashed", sessionId: "ses_1", directory: WORKSPACE_PROJ };

  test("quotes a benign session id and directory in single quotes", () => {
    assert.equal(
      resumeHint(base),
      "Session 'ses_1' may be salvageable; resume with taskferry dispatch --session-id 'ses_1' --directory '/workspace/proj' --prompt \"<continuation prompt>\""
    );
  });

  test("quotes a session id containing a single quote literally", () => {
    const hint = resumeHint({ ...base, sessionId: "ses_'x", directory: WORKSPACE_PROJ });
    assert.ok(hint.includes("--session-id 'ses_'\\''x'"));
    assert.ok(!hint.includes("ses_x"));
  });

  test("quotes a directory containing $(...) literally, not executed", () => {
    const dir = "/workspace/$(touch pwned)";
    const hint = resumeHint({ ...base, directory: dir });
    assert.match(hint, /--directory '\/workspace\/\$\(touch pwned\)'/);
    assert.ok(hint.includes(dir));
  });

  test("quotes a session id containing backticks literally, not executed", () => {
    const sid = "ses_`whoami`";
    const hint = resumeHint({ ...base, sessionId: sid });
    assert.match(hint, /--session-id 'ses_`whoami`'/);
    assert.ok(hint.includes(sid));
  });
});

describe("formatWatchEvent toon format for activity/state events", () => {
  test("collapses a task.activity event to one line, dropping protocol plumbing", () => {
    const line = formatWatchEvent({
      sequence: 138,
      type: TASK_ACTIVITY,
      taskId: "oc_1",
      directory: WORKSPACE_PROJ,
      status: "running",
      previousStatus: null,
      occurredAt: OCCURRED_AT_MID,
      activity: "Reading the config file.",
      outputWatermark: 67276,
    }, "toon");

    assert.doesNotMatch(line, /sequence/);
    assert.doesNotMatch(line, /outputWatermark/);
    assert.doesNotMatch(line, /directory/);
    assert.match(line, /oc_1/);
    assert.match(line, /running/);
    assert.match(line, /Reading the config file\./);
    assert.equal(line.split("\n").length, 1);
  });

  test("collapses a task.state event to a status transition, omitting a null previousStatus", () => {
    const line = formatWatchEvent({
      sequence: 89,
      type: TASK_STATE,
      taskId: "oc_1",
      directory: WORKSPACE_PROJ,
      status: "running",
      previousStatus: null,
      occurredAt: "2026-07-18T00:05:00.000Z",
      activity: null,
      outputWatermark: null,
    }, "toon");

    assert.match(line, /oc_1/);
    assert.match(line, /running/);
    assert.doesNotMatch(line, /null/);
  });

  test("shows a status transition when previousStatus differs from status", () => {
    const line = formatWatchEvent({
      type: TASK_STATE,
      taskId: "oc_1",
      status: "crashed",
      previousStatus: "running",
      occurredAt: OCCURRED_AT_LATE,
    }, "toon");

    assert.match(line, /running -> crashed/);
  });

  test("collapses multi-line activity text to a single line", () => {
    const line = formatWatchEvent({
      type: TASK_ACTIVITY,
      taskId: "oc_1",
      status: "running",
      occurredAt: OCCURRED_AT_MID,
      activity: "Line one.\nLine two.\r\nLine three.",
    }, "toon");

    assert.equal(line.split("\n").length, 1);
    assert.match(line, /Line one\. Line two\. Line three\./);
  });

  test("shows a distinct message for a task.activity event carrying an explicit summarize failure", () => {
    const line = formatWatchEvent({
      type: TASK_ACTIVITY,
      taskId: "oc_1",
      status: "running",
      occurredAt: OCCURRED_AT_MID,
      summaryFailed: true,
      summaryError: "summary model is unavailable: opencode/mimo-v2.5-free",
    }, "toon");

    assert.match(line, /oc_1/);
    assert.match(line, /running/);
    assert.match(line, /summary unavailable/);
    assert.match(line, /summary model is unavailable/);
    assert.equal(line.split("\n").length, 1);
  });
});

describe("errorValue", () => {
  test("preserves the boot-failure detail line from connectClient's timeout error", () => {
    // Shape mirrors the three-line error connectClient() throws when a
    // booter writes a daemon-boot.err diagnostic before its health-check
    // timeout: an `error:` line, a `daemon boot failed: ...` detail line
    // (no recognized prefix), and a `help:` line.
    const error = new Error(
      "error: taskferry daemon did not become ready within 5000ms: connect ECONNREFUSED\n"
      + "daemon boot failed: error: could not parse /fake/config.json: bad json\n"
      + "help: check /fake/runtime permissions and daemon startup diagnostics, then retry"
    );

    const { error: message, help } = errorValue(error);

    assert.match(message, /taskferry daemon did not become ready within 5000ms/);
    assert.match(message, /daemon boot failed: error: could not parse \/fake\/config\.json: bad json/);
    assert.match(help, /check \/fake\/runtime permissions/);
  });

  test("round-trips a plain two-line error:/help: message unchanged", () => {
    // Regression guard: the existing simple case (no middle detail line)
    // must still produce just the stripped `error:` line as the message and
    // the stripped `help:` line as the help.
    const error = new Error(
      "error: unknown task id: oc_99\n"
      + "help: run taskferry list to see valid task ids"
    );

    const { error: message, help } = errorValue(error);

    assert.equal(message, "unknown task id: oc_99");
    assert.equal(help, "run taskferry list to see valid task ids");
  });

  test("preserves multiple detail lines in their original order", () => {
    const error = new Error(
      "error: first problem\n"
      + "detail: middle context A\n"
      + "detail: middle context B\n"
      + "help: last hint"
    );

    const { error: message, help } = errorValue(error);

    assert.match(message, /first problem[\s\S]*middle context A[\s\S]*middle context B/);
    assert.equal(help, "last hint");
  });

  test("falls back to the first line when no error:/help: prefix is present", () => {
    const error = new Error("something went wrong");

    const { error: message } = errorValue(error);

    assert.equal(message, "something went wrong");
  });

  test("uses error.help when the error object has a string help property", () => {
    const error = new Error("error: boom\nhelp: ignored");
    error.help = "prefer this hint";

    const { help } = errorValue(error);

    assert.equal(help, "prefer this hint");
  });
});

describe("colorize", () => {
  test("wraps text in the color code and a reset when enabled", () => {
    assert.equal(colorize("done", "\x1b[32m", true), "\x1b[32mdone\x1b[0m");
  });

  test("returns text unchanged when not enabled, e.g. output is piped or redirected", () => {
    assert.equal(colorize("done", "\x1b[32m", false), "done");
  });

  test("returns text unchanged when there is no code for this status", () => {
    assert.equal(colorize("unknown", null, true), "unknown");
  });
});

describe("formatWatchEvent color (TTY-gated)", () => {
  test("colors a done status when useColor is true", () => {
    const line = formatWatchEvent({
      type: TASK_STATE,
      taskId: "oc_1",
      status: "done",
      previousStatus: "running",
      occurredAt: OCCURRED_AT_LATE,
    }, "toon", true);

    assert.ok(line.includes("running -> \x1b[32mdone\x1b[0m"));
  });

  test("emits no ANSI codes when useColor is false (piped/non-TTY output)", () => {
    const line = formatWatchEvent({
      type: TASK_STATE,
      taskId: "oc_1",
      status: "done",
      previousStatus: "running",
      occurredAt: OCCURRED_AT_LATE,
    }, "toon", false);

    assert.ok(!line.includes("\x1b["));
    assert.ok(line.includes("running -> done"));
  });

  test("emits no ANSI codes by default when useColor is omitted", () => {
    const line = formatWatchEvent({
      type: TASK_ACTIVITY,
      taskId: "oc_1",
      status: "crashed",
      occurredAt: OCCURRED_AT_LATE,
      activity: "boom",
    }, "toon");

    assert.ok(!line.includes("\x1b["));
  });

  test("never colors ndjson output even when useColor is true", () => {
    const line = formatWatchEvent({
      type: TASK_STATE,
      taskId: "oc_1",
      status: "done",
      previousStatus: "running",
      occurredAt: OCCURRED_AT_LATE,
    }, "ndjson", true);

    assert.ok(!line.includes("\x1b["));
  });
});

test("leanStatus surfaces a pending changesetStatus without --full", () => {
  const detail = { id: "t1", status: "done", startedAt: "2026-07-29T00:00:00.000Z", exitCode: 0, signal: null, role: "dispatch", changesetStatus: "pending" };
  const lean = leanStatus(detail);
  assert.equal(lean.changesetStatus, "pending");
});

test("leanStatus omits changesetStatus when it's already resolved", () => {
  const detail = { id: "t1", status: "done", startedAt: "2026-07-29T00:00:00.000Z", exitCode: 0, signal: null, role: "dispatch", changesetStatus: "accepted" };
  const lean = leanStatus(detail);
  assert.equal(lean.changesetStatus, undefined);
});

describe("leanStatus --full overlayDirs trimming", () => {
  const OVERLAY_ROOT = "/run/user/1000/taskferry/overlay/taskferry-cow-t1";
  const OVERLAY_TMP_ROOT = "/run/user/1000/taskferry/overlay";

  test("keeps only root/tmpRoot, dropping the per-git-subpath upper/work/rwBinds internals", () => {
    const detail = {
      id: "t1",
      status: "running",
      overlayDirs: {
        root: OVERLAY_ROOT,
        tmpRoot: OVERLAY_TMP_ROOT,
        upperDir: `${OVERLAY_ROOT}/upper/main`,
        workDir: `${OVERLAY_ROOT}/work/main`,
        rwBinds: [{ path: "/repo/.git", upperDir: `${OVERLAY_ROOT}/upper/extra/git-abc123`, workDir: `${OVERLAY_ROOT}/work/extra/git-abc123` }],
        rwFileBinds: [{ path: "/repo/.git/packed-refs", bindSrc: `${OVERLAY_ROOT}/files/packed-refs-abc123` }],
      },
    };
    const lean = leanStatus(detail, { full: true });
    assert.deepEqual(lean.overlayDirs, { root: OVERLAY_ROOT, tmpRoot: OVERLAY_TMP_ROOT });
  });

  test("leaves detail untouched when there is no overlay", () => {
    const detail = { id: "t1", status: "done", overlayDirs: null };
    const lean = leanStatus(detail, { full: true });
    assert.equal(lean.overlayDirs, null);
  });

  test("non-full status never surfaces overlayDirs at all", () => {
    const detail = { id: "t1", status: "running", overlayDirs: { root: OVERLAY_ROOT, tmpRoot: OVERLAY_TMP_ROOT, upperDir: "x", workDir: "y", rwBinds: [], rwFileBinds: [] } };
    const lean = leanStatus(detail);
    assert.equal("overlayDirs" in lean, false);
  });
});

describe("writeToon status coloring", () => {
  test("colors a status field in the nested (non-uniform) task layout when stdout is a TTY", () => {
    const { io, output } = fakeStdoutIo(true);
    // Mixed key sets across rows (one has failureReason, one doesn't) forces
    // toon's expanded `status: x` line layout instead of the tabular one.
    writeToon({ tasks: [{ id: "a", status: "crashed", failureReason: "boom" }, { id: "b", status: "done" }] }, io);

    assert.ok(output().includes("status: \x1b[31mcrashed\x1b[0m"));
    assert.ok(output().includes("status: \x1b[32mdone\x1b[0m"));
  });

  test("colors a status field in the tabular (uniform) task layout when stdout is a TTY", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ tasks: [{ id: "a", status: "done" }, { id: "b", status: "running" }] }, io);

    assert.ok(output().includes("a,\x1b[32mdone\x1b[0m"));
    assert.ok(output().includes("b,\x1b[33mrunning\x1b[0m"));
  });

  test("leaves plain, unmarked status text when stdout is not a TTY (piped/redirected)", () => {
    const { io, output } = fakeStdoutIo(false);
    writeToon({ tasks: [{ id: "a", status: "done" }, { id: "b", status: "crashed" }] }, io);

    assert.ok(!output().includes("\x1b["));
    assert.ok(output().includes("a,done"));
    assert.ok(output().includes("b,crashed"));
  });

  test("does not color a status value with no known color mapping (e.g. unknown)", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ id: "a", status: "unknown" }, io);

    assert.ok(!output().includes("\x1b["));
    assert.ok(output().includes("status: unknown"));
  });
});

describe("writeToon doctor coloring", () => {
  test("colors healthy/installed/isolated true green and false red", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ healthy: true, integrations: { claude: { installed: false }, playwrightMcpIsolation: { opencode: { isolated: true } } } }, io);

    assert.ok(output().includes("healthy: \x1b[32mtrue\x1b[0m"));
    assert.ok(output().includes("installed: \x1b[31mfalse\x1b[0m"));
    assert.ok(output().includes("isolated: \x1b[32mtrue\x1b[0m"));
  });

  test("leaves `checked` uncolored -- false there means unverified, not failed", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ checked: false }, io);

    assert.ok(!output().includes("\x1b["));
    assert.ok(output().includes("checked: false"));
  });

  test("colors trend.direction improving green and worsening red, leaves unknown uncolored", () => {
    const { io: ioImproving, output: outputImproving } = fakeStdoutIo(true);
    writeToon({ direction: "improving" }, ioImproving);
    assert.ok(outputImproving().includes("direction: \x1b[32mimproving\x1b[0m"));

    const { io: ioWorsening, output: outputWorsening } = fakeStdoutIo(true);
    writeToon({ direction: "worsening" }, ioWorsening);
    assert.ok(outputWorsening().includes("direction: \x1b[31mworsening\x1b[0m"));

    const { io: ioUnknown, output: outputUnknown } = fakeStdoutIo(true);
    writeToon({ direction: "unknown" }, ioUnknown);
    assert.ok(!outputUnknown().includes("\x1b["));
  });

  test("colors warnings yellow and info dim, without swallowing the text itself", () => {
    const { io, output } = fakeStdoutIo(true);
    writeToon({ warnings: ["bwrap is not installed"], info: ["sandboxing unavailable on this platform"] }, io);

    assert.ok(output().includes("\x1b[33mbwrap is not installed\x1b[0m"));
    assert.ok(output().includes("\x1b[2msandboxing unavailable on this platform\x1b[0m"));
  });

  test("no ANSI escapes anywhere when stdout is not a TTY, even with warnings/booleans/direction present", () => {
    const { io, output } = fakeStdoutIo(false);
    writeToon({ healthy: true, direction: "worsening", warnings: ["bwrap missing"] }, io);

    assert.ok(!output().includes("\x1b["));
    assert.ok(output().includes("healthy: true"));
    assert.ok(output().includes("direction: worsening"));
    assert.ok(output().includes("bwrap missing"));
  });
});

describe("projectDoctorStats", () => {
  function stats(overrides = {}) {
    return {
      byModel: [{ model: "m1", dispatches: 2, done: 1, crashed: 1, doneRate: 0.5, crashRate: 0.5 }],
      failureReasons: [],
      unknownBacklog: { total: 0, tasks: [] },
      computedAt: TASK_STARTED_AT_EXAMPLE,
      statusMix: { overall: {}, last24h: {}, last7d: {} },
      trend: { window: "24h", current: { crashRate: 0.25 }, previous: { crashRate: null }, direction: "flat" },
      ...overrides,
    };
  }

  test("formats byModel and trend rates as one-decimal percentages", () => {
    const result = projectDoctorStats(stats());
    assert.equal(result.byModel[0].doneRate, "50.0%");
    assert.equal(result.byModel[0].crashRate, "50.0%");
    assert.equal(result.trend.current.crashRate, "25.0%");
  });

  test("leaves a null rate (no settled tasks) as null instead of formatting it", () => {
    const result = projectDoctorStats(stats());
    assert.equal(result.trend.previous.crashRate, null);
  });
});

function fakeCappedListValue(totalCount) {
  return {
    directory: WORKSPACE_EXAMPLE,
    counts: { queued: 0, running: 0, done: totalCount, crashed: 0, cancelled: 0, unknown: 0 },
    tasks: fakeCappedTasks(totalCount),
  };
}

describe("projectList default row cap", () => {
  test("caps to 30 rows by default when the total exceeds 30", () => {
    const result = projectList(fakeCappedListValue(805));
    assert.equal(result.tasks.length, 30);
  });

  test("does not cap when the total is at or under 30", () => {
    const result = projectList(fakeCappedListValue(12));
    assert.equal(result.tasks.length, 12);
  });

  test("an explicit --limit still overrides the default", () => {
    const result = projectList(fakeCappedListValue(805), { limit: 5 });
    assert.equal(result.tasks.length, 5);
  });

  test("adds a reveal-hint next[] when rows are truncated", () => {
    const result = projectList(fakeCappedListValue(805));
    assert.deepEqual(result.next, [REVEAL_HINT_805]);
  });

  test("omits next[] when nothing was truncated", () => {
    const result = projectList(fakeCappedListValue(12));
    assert.equal(result.next, undefined);
  });

  test("omits next[] when an explicit --limit already covers the full total", () => {
    const result = projectList(fakeCappedListValue(12), { limit: 100 });
    assert.equal(result.next, undefined);
  });
});

describe("projectContext default row cap (SessionStart hook payload)", () => {
  test("caps to 10 rows by default when the total exceeds 10", () => {
    const result = projectContext(fakeCappedListValue(805));
    assert.equal(result.tasks.length, 10);
  });

  test("does not cap when the total is at or under 10", () => {
    const result = projectContext(fakeCappedListValue(4));
    assert.equal(result.tasks.length, 4);
  });

  test("adds a reveal-hint next[] when rows are truncated", () => {
    const result = projectContext(fakeCappedListValue(805));
    assert.deepEqual(result.next, [REVEAL_HINT_805]);
  });

  test("omits next[] when nothing was truncated", () => {
    const result = projectContext(fakeCappedListValue(4));
    assert.equal(result.next, undefined);
  });

  test("an explicit limit override still works (used only by tests, not by the CLI)", () => {
    const result = projectContext(fakeCappedListValue(805), { limit: 2 });
    assert.equal(result.tasks.length, 2);
  });
});

describe("homeView default row cap", () => {
  function fakeHomeValue(totalCount) {
    return {
      counts: { queued: 0, running: 0, done: totalCount, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: fakeCappedTasks(totalCount),
    };
  }
  const homeOpts = { executablePath: TASKFERRY_BIN, workspace: WORKSPACE_EXAMPLE };

  test("caps to 30 rows by default when the total exceeds 30", () => {
    const result = homeView(fakeHomeValue(805), homeOpts);
    assert.equal(result.tasks.length, 30);
  });

  test("does not cap when the total is at or under 30", () => {
    const result = homeView(fakeHomeValue(12), homeOpts);
    assert.equal(result.tasks.length, 12);
  });

  test("appends a reveal-hint to the existing non-empty next[] when rows are truncated", () => {
    const result = homeView(fakeHomeValue(805), homeOpts);
    assert.equal(result.next.length, 4);
    assert.equal(result.next[3], REVEAL_HINT_805);
  });

  test("does not append a reveal-hint when nothing was truncated", () => {
    const result = homeView(fakeHomeValue(12), homeOpts);
    assert.equal(result.next.length, 3);
  });

  test("passes through a non-array tasks value (e.g. projectList's 'none found' string) unchanged, instead of coercing it to an empty array", () => {
    const value = { counts: { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 }, tasks: "none found in this workspace" };
    const result = homeView(value, homeOpts);
    assert.equal(result.tasks, "none found in this workspace");
  });
});
