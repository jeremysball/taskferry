import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { collectSessionResult } from "./opencode-worker.js";

const SESSION = "ses_test";
const execFileAsync = promisify(execFile);
const WORKER = fileURLToPath(new URL("./opencode-worker.js", import.meta.url));
const STREAMED_ANSWER = "Streamed answer";
const STANDALONE = "--standalone";
function assistant(id, text, input = 10, output = 2, cost = 0.1) {
  return { id, cost, type: "assistant", time: { created: 1, completed: 2 }, content: [{ type: "text", text }], finish: "stop", tokens: { input, output, reasoning: 1, cache: { read: 3, write: 4 } } };
}

test("collects authoritative text and accounting in turn order, including compaction usage", async () => {
  const pages = [
    { data: [{ id: "idle", type: "idle", outcome: "succeeded" }, assistant("m2", "Final", 20), { id: "c1", type: "compaction", tokens: { input: 5, output: 1 }, cost: 0.02 }], cursor: { next: "page2" } },
    { data: [assistant("m1", "Working"), { id: "user", type: "user" }], cursor: { next: null } },
  ];
  const routes = [];
  const result = await collectSessionResult(SESSION, null, async (route) => { routes.push(route); return pages.shift(); });
  assert.ok(result, "must return a finalized session result");
  assert.equal(result.type, "taskferry_session_result");
  assert.equal(result.sessionID, SESSION);
  assert.deepEqual(result.events.filter(e => e.type === "text").map(e => e.part.text), ["Working", "Final"]);
  assert.deepEqual(result.events.filter(e => e.type === "step_finish").map(e => e.part.tokens.input), [10, 5, 20]);
  assert.match(routes[1], /cursor=page2/);
});

test("resume stops at the pre-run message boundary, never charging earlier turns", async () => {
  const result = await collectSessionResult(SESSION, "previous-idle", async () => ({
    data: [assistant("new", "New answer", 7), { id: "previous-idle", type: "idle" }, assistant("old", "Old answer", 999)], cursor: { next: "unused" },
  }));
  assert.ok(result, "must return only the resumed turn");
  assert.deepEqual(result.events.filter(e => e.type === "text").map(e => e.part.text), ["New answer"]);
  assert.deepEqual(result.events.filter(e => e.type === "step_finish").map(e => e.part.tokens.input), [7]);
});

test("a session-recorded failure produces an error even without a streamed error", async () => {
  const result = await collectSessionResult(SESSION, null, async () => ({
    data: [{ id: "idle", type: "idle", outcome: "failed", error: { type: "provider.failed", message: "Invalid API key" } }], cursor: { next: null },
  }));
  assert.ok(result, "must return the recorded error");
  assert.deepEqual(result.events.map(e => e.type), ["error"]);
  assert.equal(result.events[0].error.data.message, "Invalid API key");
  assert.equal(result.failed, true);
});

test("a successful terminal idle supersedes earlier recovered compaction errors", async () => {
  const result = await collectSessionResult(SESSION, null, async () => ({
    data: [
      { id: "idle", type: "idle", outcome: "succeeded" },
      assistant("recovered", "Recovered answer"),
      { id: "compaction", type: "compaction", error: { type: "compaction.failed", message: "Retried later" } },
    ], cursor: { next: null },
  }));
  assert.equal(result.failed, false);
  assert.equal(result.events.find(e => e.type === "text").part.text, "Recovered answer");
});

test("unavailable API or missing resume boundary fails explicitly instead of using old usage", async () => {
  await assert.rejects(collectSessionResult(SESSION, null, async () => { throw new Error("API unavailable"); }), /API unavailable/);
  await assert.rejects(collectSessionResult(SESSION, "missing", async () => ({ data: [assistant("old", "Old")], cursor: { next: null } })), /boundary/);
});

function workerFixture(t, mode = "success") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-opencode-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = path.join(root, "calls.ndjson");
  const state = path.join(root, "ran");
  const current = assistant("new", "Stored answer", 7);
  const old = assistant("old", "Previous turn", 999);
  fs.writeFileSync(path.join(root, "opencode"), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'run') {
  if (${JSON.stringify(mode)} === 'boot-failure') { console.error('Unable to load config'); process.exit(7); }
  if (${JSON.stringify(mode)} === 'empty-success') process.exit(0);
  fs.writeFileSync(${JSON.stringify(state)}, 'ran');
  console.log(JSON.stringify({type:'text', sessionID:'ses_test', part:{messageID:'new',text:'Streamed answer'}}));
  process.exit(0);
}
if (${JSON.stringify(mode)} === 'api-failure') { console.error('Session store unavailable'); process.exit(5); }
const before = !fs.existsSync(${JSON.stringify(state)});
const idle = { id:'previous-idle', type:'idle', outcome:'succeeded' };
const current = ${JSON.stringify(current)};
const old = ${JSON.stringify(old)};
const recovered = [ {id:'final-idle', type:'idle', outcome:'succeeded'}, current, {id:'c1',type:'compaction',error:{type:'compaction.failed',message:'Retried later'}} ];
const data = before ? [idle] : (${JSON.stringify(mode)} === 'recovered' ? recovered : [current, idle, old]);
console.log(JSON.stringify({data,cursor:{next:null}}));
`, { mode: 0o755 });
  return { root, calls, env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` } };
}

test("worker keeps live stdout but reads finalized session messages before exiting", async (t) => {
  const fixture = workerFixture(t);
  const { stdout } = await execFileAsync(process.execPath, [WORKER, "run", STANDALONE], { env: fixture.env });
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events[0].part.text, STREAMED_ANSWER);
  assert.equal(events[1].type, "taskferry_session_result");
  assert.equal(events[1].events.find(e => e.type === "text").part.text, "Previous turn");
  assert.equal(events[1].events.filter(e => e.type === "step_finish").length, 2);
  const calls = fs.readFileSync(fixture.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls[0], ["run", STANDALONE]);
  assert.deepEqual(calls[1].slice(0, 3), ["api", STANDALONE, "get"]);
});

test("worker captures the resume watermark before launching, excluding existing usage", async (t) => {
  const fixture = workerFixture(t);
  const { stdout } = await execFileAsync(process.execPath, [WORKER, "run", "--session", SESSION], { env: fixture.env });
  const snapshot = stdout.trim().split("\n").map(line => JSON.parse(line)).find(e => e.type === "taskferry_session_result");
  assert.deepEqual(snapshot.events.filter(e => e.type === "step_finish").map(e => e.part.tokens.input), [7]);
  const calls = fs.readFileSync(fixture.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.match(calls[0][3], /limit=1$/);
  assert.equal(calls[1][0], "run");
  assert.equal(calls[2][0], "api");
});

test("worker does not emit a recovered historical error as a terminal error", async (t) => {
  const fixture = workerFixture(t, "recovered");
  const { stdout } = await execFileAsync(process.execPath, [WORKER, "run"], { env: fixture.env });
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.some(e => e.type === "error"), false);
  assert.equal(events.find(e => e.type === "taskferry_session_result").failed, false);
});

test("worker preserves startup exit status and raw stderr when no session exists", async (t) => {
  const fixture = workerFixture(t, "boot-failure");
  await assert.rejects(execFileAsync(process.execPath, [WORKER, "run"], { env: fixture.env }), error => {
    assert.equal(error.code, 7);
    assert.match(error.stderr, /Unable to load config/);
    assert.equal(fs.readFileSync(fixture.calls, "utf8").trim().split("\n").length, 1);
    return true;
  });
});

test("session API failure is explicit and cannot turn a successful run into a complete result", async (t) => {
  const fixture = workerFixture(t, "api-failure");
  await assert.rejects(execFileAsync(process.execPath, [WORKER, "run"], { env: fixture.env }), error => {
    assert.equal(error.code, 1);
    const events = error.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events[0].part.text, STREAMED_ANSWER);
    assert.equal(events.at(-1).error.name, "OpenCodeSessionResultError");
    assert.match(events.at(-1).error.data.message, /Session store unavailable/);
    return true;
  });
});

test("successful process exit without a session is not a finalized result", async (t) => {
  const fixture = workerFixture(t, "empty-success");
  await assert.rejects(execFileAsync(process.execPath, [WORKER, "run"], { env: fixture.env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /session ID/i);
    return true;
  });
});
