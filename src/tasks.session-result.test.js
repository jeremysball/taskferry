import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { makeManager, baseTask, fakeChild, waitForCaptured } from "./tasks.test-helpers.js";

const API_ANSWER = "Authoritative answer";
const SESSION_RESULT_TYPE = "taskferry_session_result";
const LIVE_PARTIAL = "Live partial";
test("session API snapshot replaces streamed text and usage without double counting", () => {
  const log = [
    { type: "text", part: { messageID: "m1", text: "Partial stream" } },
    { type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { input: 100 }, cost: 1 } },
    { type: SESSION_RESULT_TYPE, sessionID: "ses_api", events: [
      { type: "text", part: { messageID: "m1", text: API_ANSWER } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { input: 120, output: 4 }, cost: 1.2 } },
    ] },
  ].map(event => JSON.stringify(event)).join("\n");
  const mgr = makeManager({
    tasksFixture: (logDir) => [baseTask({ id: "api-result", status: "done", logPath: path.join(logDir, "api.ndjson") })],
    logs: { "api.ndjson": log },
  });
  const result = mgr.result("api-result");
  assert.equal(result.message, API_ANSWER);
  assert.equal(result.narration, API_ANSWER);
  assert.deepEqual(result.tokens, { input: 120, output: 4 });
  assert.equal(result.cost, 1.2);
  assert.equal(result.sessionId, "ses_api");
});

for (const authoritativeSnapshot of [false, true]) {
  test(`${authoritativeSnapshot ? "session-recorded" : "API-finalization"} failure cannot be overridden by streamed stop/crash recovery`, () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const task = mgr.dispatch({ prompt: "test", directory: os.tmpdir(), executor: "opencode" });
    const completed = [
      { type: "text", part: { messageID: "m1", text: "Earlier stopped answer" } },
      { type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { input: 7 } } },
    ];
    const error = { type: "error", error: { name: authoritativeSnapshot ? "provider.failed" : "OpenCodeSessionResultError", data: { message: "Authoritative failure" } } };
    const events = authoritativeSnapshot ? [{ type: SESSION_RESULT_TYPE, sessionID: "ses_failure", failed: true, events: [...completed, error] }, error] : [...completed, error];
    fs.writeFileSync(mgr.status(task.id).logPath, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    child.emit("exit", 1, null);
    assert.equal(mgr.result(task.id).status, "crashed");
    assert.equal(mgr.result(task.id).exitCode, 1);
  });
}

test("summary follows canonical text order even when the live stream missed a middle message", async () => {
  let snapshot;
  const child = fakeChild();
  const texts = ["First canonical ".repeat(4000), "Middle canonical ".repeat(4000), "Final canonical answer"];
  const textEvents = texts.map((text, i) => ({ type: "text", part: { messageID: `m${i}`, text } }));
  const log = [{ type: "text", part: { messageID: "m0", text: "Partial first" } }, textEvents[2], { type: SESSION_RESULT_TYPE, events: textEvents }].map(e => JSON.stringify(e)).join("\n");
  const mgr = makeManager({
    tasksFixture: (logDir) => [baseTask({ id: "ordering", status: "done", logPath: path.join(logDir, "ordering.ndjson") })],
    logs: { "ordering.ndjson": log },
    spawnFn: (_command, args) => { snapshot = JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1], "utf8")); return child; },
  });
  await mgr.summarize("ordering");
  await waitForCaptured(() => snapshot);
  assert.match(snapshot.narration, /Final canonical answer$/);
  child.emit("exit", 0, null);
});

test("a recovered historical error cannot override a successful terminal session outcome", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child });
  const task = mgr.dispatch({ prompt: "test", directory: os.tmpdir(), executor: "opencode" });
  const snapshot = { type: SESSION_RESULT_TYPE, failed: false, events: [
    { type: "error", error: { name: "compaction.failed", data: { message: "Retried later" } } },
    { type: "text", part: { messageID: "m1", text: "Recovered answer" } },
    { type: "step_finish", part: { messageID: "m1", reason: "stop", tokens: { input: 7 } } },
  ] };
  fs.writeFileSync(mgr.status(task.id).logPath, JSON.stringify(snapshot) + "\n");
  child.emit("exit", 1, null);
  assert.equal(mgr.result(task.id).status, "done");
});

test("oversized snapshot tail projects only the final message, not earlier narration", () => {
  const log = JSON.stringify({ type: SESSION_RESULT_TYPE, events: [
    { type: "text", part: { messageID: "m1", text: "x".repeat(1200000) } },
    { type: "text", part: { messageID: "m2", text: "Done" } },
    { type: "step_finish", part: { messageID: "m2", reason: "stop" } },
  ] });
  const mgr = makeManager({
    tasksFixture: (logDir) => [baseTask({ id: "final-tail", status: "done", logPath: path.join(logDir, "final-tail.ndjson") })],
    logs: { "final-tail.ndjson": log },
  });
  const tail = mgr.tail("final-tail", { chars: 50 });
  assert.equal(tail.text, "Done");
  assert.equal(tail.textTotalChars, 4);
  assert.equal(tail.truncated, false);
});

test("tail uses finalized session text, including snapshots larger than its tail window", () => {
  for (const text of [API_ANSWER, "Large final ".repeat(100000) + "canonical ending"]) {
    const log = [
      { type: "text", part: { messageID: "m1", text: LIVE_PARTIAL } },
      { type: SESSION_RESULT_TYPE, events: [{ type: "text", part: { messageID: "m1", text } }] },
    ].map(e => JSON.stringify(e)).join("\n") + "\n";
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "tail-result", status: "done", logPath: path.join(logDir, "tail.ndjson") })],
      logs: { "tail.ndjson": log },
    });
    assert.equal(mgr.tail("tail-result", { chars: 100 }).text, [...text].slice(-100).join(""));
  }
});

for (const answer of [API_ANSWER, "Long canonical narrative ".repeat(10000) + "canonical final ending"]) {
test(`summary input uses ${answer.length > 100 ? "oversized" : "short"} session text once while retaining streamed tool activity`, async () => {
  let snapshot;
  const child = fakeChild();
  const log = [
    { type: "text", part: { messageID: "m1", text: LIVE_PARTIAL } },
    { type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status" }, output: "clean" } } },
    { type: SESSION_RESULT_TYPE, events: [{ type: "text", part: { messageID: "m1", text: answer } }] },
  ].map(e => JSON.stringify(e)).join("\n") + "\n";
  const mgr = makeManager({
    tasksFixture: (logDir) => [baseTask({ id: "source", status: "done", logPath: path.join(logDir, "source.ndjson") })],
    logs: { "source.ndjson": log },
    spawnFn: (_command, args) => { snapshot = JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1], "utf8")); return child; },
  });
  await mgr.summarize("source");
  await waitForCaptured(() => snapshot);
  assert.equal(snapshot.narration.includes(LIVE_PARTIAL), false);
  if (answer.length < 100) {
    assert.equal(snapshot.narration.split(API_ANSWER).length - 1, 1);
    assert.match(snapshot.narration, /\[tool:bash]/);
  } else {
    assert.match(snapshot.narration, /canonical final ending/);
    assert.ok(Buffer.byteLength(snapshot.narration) <= 96 * 1024);
  }
  child.emit("exit", 0, null);
});
}
