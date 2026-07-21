import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { colorize, formatWatchEvent, leanStatus } from "./output.js";

function resumeHint(detail) {
  return leanStatus(detail).next;
}

describe("leanStatus crashed-resume hint", () => {
  const base = { id: "oc_1", status: "crashed", sessionId: "ses_1", directory: "/workspace/proj" };

  test("quotes a benign session id and directory in single quotes", () => {
    assert.equal(
      resumeHint(base),
      "Session 'ses_1' may be salvageable; resume with taskferry dispatch --session-id 'ses_1' --directory '/workspace/proj' --prompt \"<continuation prompt>\""
    );
  });

  test("quotes a session id containing a single quote literally", () => {
    const hint = resumeHint({ ...base, sessionId: "ses_'x", directory: "/workspace/proj" });
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
      type: "task.activity",
      taskId: "oc_1",
      directory: "/workspace/proj",
      status: "running",
      previousStatus: null,
      occurredAt: "2026-07-18T00:06:12.414Z",
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
      type: "task.state",
      taskId: "oc_1",
      directory: "/workspace/proj",
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
      type: "task.state",
      taskId: "oc_1",
      status: "crashed",
      previousStatus: "running",
      occurredAt: "2026-07-18T00:24:11.282Z",
    }, "toon");

    assert.match(line, /running -> crashed/);
  });

  test("collapses multi-line activity text to a single line", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "running",
      occurredAt: "2026-07-18T00:06:12.414Z",
      activity: "Line one.\nLine two.\r\nLine three.",
    }, "toon");

    assert.equal(line.split("\n").length, 1);
    assert.match(line, /Line one\. Line two\. Line three\./);
  });

  test("shows a distinct message for a task.activity event carrying an explicit summarize failure", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "running",
      occurredAt: "2026-07-18T00:06:12.414Z",
      summaryFailed: true,
      summaryError: "summary model is unavailable: opencode/hy3-free",
    }, "toon");

    assert.match(line, /oc_1/);
    assert.match(line, /running/);
    assert.match(line, /summary unavailable/);
    assert.match(line, /summary model is unavailable/);
    assert.equal(line.split("\n").length, 1);
  });
});

describe("formatWatchEvent claude-monitor format", () => {
  test("shows a distinct summary-unavailable marker when summaryFailed is true", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "running",
      summaryFailed: true,
      summaryError: "summary model is unavailable: opencode/hy3-free",
    }, "claude-monitor");

    assert.match(line, /Taskferry\(running · oc_1\)/);
    assert.match(line, /summary unavailable/);
    assert.match(line, /summary model is unavailable/);
  });

  test("uses 'unknown error' fallback when summaryFailed is true but summaryError is missing", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "running",
      summaryFailed: true,
    }, "claude-monitor");

    assert.match(line, /summary unavailable \(unknown error\)/);
  });

  test("renders activity text normally when summaryFailed is not set", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "running",
      activity: "Reading the config file.",
    }, "claude-monitor");

    assert.match(line, /Taskferry\(running · oc_1\)/);
    assert.match(line, /Reading the config file\./);
  });

  test("falls back to Task status when activity is missing and summaryFailed is not set", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "done",
    }, "claude-monitor");

    assert.match(line, /Taskferry\(done · oc_1\)/);
    assert.match(line, /Task done/);
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
      type: "task.state",
      taskId: "oc_1",
      status: "done",
      previousStatus: "running",
      occurredAt: "2026-07-18T00:24:11.282Z",
    }, "toon", true);

    assert.ok(line.includes("running -> \x1b[32mdone\x1b[0m"));
  });

  test("emits no ANSI codes when useColor is false (piped/non-TTY output)", () => {
    const line = formatWatchEvent({
      type: "task.state",
      taskId: "oc_1",
      status: "done",
      previousStatus: "running",
      occurredAt: "2026-07-18T00:24:11.282Z",
    }, "toon", false);

    assert.ok(!line.includes("\x1b["));
    assert.ok(line.includes("running -> done"));
  });

  test("emits no ANSI codes by default when useColor is omitted", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "crashed",
      occurredAt: "2026-07-18T00:24:11.282Z",
      activity: "boom",
    }, "toon");

    assert.ok(!line.includes("\x1b["));
  });

  test("never colors ndjson output even when useColor is true", () => {
    const line = formatWatchEvent({
      type: "task.state",
      taskId: "oc_1",
      status: "done",
      previousStatus: "running",
      occurredAt: "2026-07-18T00:24:11.282Z",
    }, "ndjson", true);

    assert.ok(!line.includes("\x1b["));
  });
});
