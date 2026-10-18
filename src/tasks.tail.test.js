import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { makeManager, baseTask } from "./tasks.test-helpers.js";

function tailEvents(events, chars = 12000) {
  const mgr = makeManager({
    tasksFixture: (logDir) => [baseTask({ id: "tool-tail", status: "running", logPath: path.join(logDir, "tool-tail.ndjson") })],
    logs: { "tool-tail.ndjson": events.map((event) => JSON.stringify(event)).join("\n") },
  });
  return mgr.tail("tool-tail", { chars });
}

test("tool-only work is visible with quoted streams and an explicit exit code", () => {
  const result = tailEvents([
    {
      type: "tool_use",
      part: {
        type: "tool",
        tool: "shell",
        state: {
          status: "completed",
          input: { command: "npm test" },
          output: { stdout: 'tail "says" this\nnext\\line', stderr: 'warning: "example"', exitCode: 1 },
        },
      },
    },
  ]);
  assert.match(result.text, /\[TOOL\] shell ::/);
  assert.ok(result.text.includes('args={"command":"npm test"}'));
  assert.ok(result.text.includes(`stdout=${JSON.stringify('tail "says" this\nnext\\line')}`));
  assert.ok(result.text.includes(`stderr=${JSON.stringify('warning: "example"')}`));
  assert.match(result.text, /exit=1/);
});

test("tail includes narration and tool events in chronological order", () => {
  const result = tailEvents([
    { type: "text", part: { text: "Inspecting first" } },
    { type: "tool_use", part: { type: "tool", tool: "read", state: { input: { path: "src/main.js" }, output: "file contents" } } },
    { type: "text", part: { text: "Now testing" } },
    { type: "tool_use", part: { type: "tool", tool: "shell", state: { input: { command: "npm test" }, output: "118 tests passed", metadata: { exit: 0 } } } },
  ]);
  const positions = ["Inspecting first", "[TOOL] read", "Now testing", "[TOOL] shell"].map((text) => result.text.indexOf(text));
  assert.ok(positions.every((n) => n >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.match(result.text, /combined="118 tests passed"/);
  assert.match(result.text, /stdout=unavailable :: stderr=unavailable/);
  assert.match(result.text, /exit=0/);
});

test("stdout and stderr retain bounded suffixes, with more lines of stderr", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  const result = tailEvents([{ type: "tool_use", part: { type: "tool", tool: "shell", state: { input: {}, output: { stdout: lines.join("\n"), stderr: lines.join("\n") } } } }]);
  assert.match(result.text, /stdout="/);
  assert.match(result.text, /stderr="/);
  const stdout = JSON.parse(result.text.match(/stdout=("(?:\\.|[^"\\])*")/)[1]);
  const stderr = JSON.parse(result.text.match(/stderr=("(?:\\.|[^"\\])*")/)[1]);
  assert.ok(stdout.endsWith("line-39"));
  assert.ok(stderr.endsWith("line-39"));
  assert.ok(stdout.includes("[truncated]"));
  assert.ok(stderr.split("\n").length > stdout.split("\n").length);
  assert.ok(stderr.split("\n").length < 15);
});

test("tool heartbeats show running work, not an invented success", () => {
  const result = tailEvents([{ type: "tool_progress", part: { type: "tool-progress", tool: "bash", toolCallId: "call-1" } }]);
  assert.match(result.text, /\[TOOL\] bash ::/);
  assert.match(result.text, /state=running/);
  assert.match(result.text, /exit=unavailable/);
});

test("empty stdout, zero exit, tool errors and missing fields remain distinct", () => {
  const result = tailEvents([
    { type: "tool_use", part: { type: "tool", tool: "shell", state: { output: { stdout: "", exitCode: 0 } } } },
    { type: "tool_use", part: { type: "tool", tool: "read", state: { status: "error", error: 'missing "file"' } } },
  ]);
  assert.match(result.text, /stdout="" :: stderr=unavailable :: exit=0/);
  assert.ok(result.text.includes(`error=${JSON.stringify('missing "file"')}`));
  assert.match(result.text, /exit=unavailable :: state=error/);
});

test("partial records and non-tool events do not conceal valid tool activity", () => {
  const event = { type: "tool_use", part: { type: "tool", tool: "shell", state: { output: "visible output" } } };
  // A log window may contain noise or fragments around complete records.
  const mgr = makeManager({
    tasksFixture: (logDir) => [baseTask({ id: "partial", logPath: path.join(logDir, "partial.ndjson") })],
    logs: { "partial.ndjson": `not-json\n${JSON.stringify(event)}\n{"type":` },
  });
  assert.match(mgr.tail("partial").text, /combined="visible output"/);
});

test("tool output remains bounded and Unicode-safe under the overall chars limit", () => {
  const event = { type: "tool_use", part: { type: "tool", tool: "shell", state: { output: { stdout: "😀".repeat(10000), stderr: "😀".repeat(10000) } } } };
  const full = tailEvents([event]);
  assert.ok(full.text.length < 5000);
  assert.match(full.text, /\[truncated\]/);
  const short = tailEvents([event], 99);
  assert.equal(Array.from(short.text).length, 99);
  assert.equal(short.truncated, true);
  assert.ok(!short.text.includes("�"));
});
