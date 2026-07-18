import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createActivityCache, buildLocalActivity, snapshotNarration, activityCacheKey } from "./activity.js";
import { runCli } from "./cli.js";
import { parseRequestLine } from "./protocol.js";
import { createTaskManager } from "./tasks.js";

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  return child;
}

describe("activity snapshots", () => {
  test("keeps bounded narration Unicode-safe when the byte limit cuts through an emoji", () => {
    const first = JSON.stringify({ type: "text", part: { messageID: "m1", text: "before 😀😀😀 after" } });
    const raw = [
      first,
      JSON.stringify({ type: "text", part: { messageID: "middle", text: "x".repeat(300) } }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "later" } }),
    ].join("\n");

    const snapshot = snapshotNarration(raw, { maxBytes: Buffer.byteLength(first) * 2 + 1, maxChars: 64 });

    assert.equal(snapshot.text.includes("�"), false);
    assert.ok(Array.from(snapshot.text).length <= 64);
    assert.match(snapshot.text, /before/);
    assert.equal(snapshot.outputWatermark, Buffer.byteLength(raw));
  });

  test("uses a sanitized dispatch prompt as local activity before model output exists", () => {
    assert.equal(
      buildLocalActivity({ status: "running", prompt: "Inspect\n\u001b[31mthe server\u001b[0m" }),
      "Inspect the server"
    );
  });
});

describe("task activity events", () => {
  test("emits state transitions immediately and activity enrichment afterward", async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-activity-test-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const child = fakeChild();
    const events = [];
    const manager = createTaskManager({
      stateDir,
      spawnFn: () => child,
      killFn: () => {},
      activitySummariesEnabled: false,
      activityMinIntervalMs: 0,
      onEvent: (event) => events.push(event),
    });

    const task = manager.dispatch({ prompt: "Check the server", directory: os.tmpdir() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.slice(0, 2).map((event) => [event.type, event.status]), [
      ["task.state", "queued"],
      ["task.state", "running"],
    ]);
    assert.equal(events[2].type, "task.activity");
    assert.equal(events[2].activity, "Check the server");

    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.at(-2).type, "task.state");
    assert.equal(events.at(-2).status, "done");
    assert.equal(events.at(-1).type, "task.activity");
    assert.deepEqual(events.map((event) => event.sequence), events.map((event) => event.sequence).sort((a, b) => a - b));
    assert.equal(task.status, "running");
  });

  test("refreshes running activity only after 4096 more log bytes", async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-activity-test-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const child = fakeChild();
    const events = [];
    const manager = createTaskManager({
      stateDir,
      spawnFn: () => child,
      killFn: () => {},
      activitySummariesEnabled: false,
      activityMinIntervalMs: 0,
      noOutputTimeoutMs: 500,
      watchdogPollMs: 5,
      onEvent: (event) => events.push(event),
    });

    const task = manager.dispatch({ prompt: "Watch output", directory: os.tmpdir() });
    await new Promise((resolve) => setImmediate(resolve));
    const before = events.filter((event) => event.type === "task.activity").length;
    fs.appendFileSync(task.logPath, "x".repeat(4095));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.filter((event) => event.type === "task.activity").length, before);

    fs.appendFileSync(task.logPath, "x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.filter((event) => event.type === "task.activity").length, before + 1);
    child.emit("exit", 0, null);
  });

  test("publishes one internal summary result without exposing the summary job", async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-activity-test-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const children = [];
    const events = [];
    const manager = createTaskManager({
      stateDir,
      spawnFn: (_command, args) => {
        const child = fakeChild(5000 + children.length);
        children.push({ child, summary: args.includes("--agent") });
        return child;
      },
      killFn: () => {},
      activitySummariesEnabled: true,
      activityMinIntervalMs: 0,
      onEvent: (event) => events.push(event),
      listModelsFn: () => "opencode/hy3-free\n",
      verifySummaryAgentFn: async () => {},
    });
    manager.setActivitySummarySubscriptions(1);

    const source = manager.dispatch({ prompt: "Inspect the daemon", directory: os.tmpdir() });
    await new Promise((resolve) => setImmediate(resolve));
    const persisted = JSON.parse(fs.readFileSync(manager.paths.TASKS_FILE, "utf8"));
    const summary = persisted.find((task) => task.summaryOf);
    assert.ok(summary);
    assert.equal(events.some((event) => event.taskId === summary.id), false);

    fs.writeFileSync(
      summary.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "summary", text: "Inspecting the daemon configuration." } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "summary", reason: "stop" } }),
      ].join("\n")
    );
    children.find((entry) => entry.summary).child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const activity = events.find((event) => event.type === "task.activity" && event.taskId === source.id);
    assert.equal(activity.activity, "Inspecting the daemon configuration.");
    assert.equal(events.some((event) => event.taskId === summary.id), false);
    manager.setActivitySummarySubscriptions(0);
    children.find((entry) => !entry.summary).child.emit("exit", 0, null);
  });
});

describe("activity summary cache", () => {
  const task = { id: "oc_1", status: "running", promptPreview: "Check the daemon" };

  test("shares one in-flight summary request for concurrent subscribers", async () => {
    let calls = 0;
    const cache = createActivityCache({
      summariesEnabled: true,
      minIntervalMs: 0,
      snapshot: () => ({ text: "Checking the daemon", outputWatermark: 10 }),
      summarize: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "Checking the daemon configuration";
      },
    });

    const [first, second] = await Promise.all([
      cache.refresh(task, { force: true }),
      cache.refresh(task, { force: true }),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(first, second);
    assert.equal(first.activity, "Checking the daemon configuration");
  });

  test("returns cached activity for the same task watermark", async () => {
    let calls = 0;
    const cache = createActivityCache({
      summariesEnabled: true,
      minIntervalMs: 0,
      snapshot: () => ({ text: "same output", outputWatermark: 20 }),
      summarize: async () => {
        calls++;
        return "same summary";
      },
    });

    await cache.refresh(task, { force: true });
    const cached = await cache.refresh(task, { force: true });

    assert.equal(calls, 1);
    assert.equal(cached.cached, true);
  });

  test("falls back to sanitized local activity when the secondary model fails", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      minIntervalMs: 0,
      snapshot: () => ({ text: "Ran\n\u001b[2mtests\u001b[0m", outputWatermark: 30 }),
      summarize: async () => { throw new Error("provider unavailable"); },
    });

    const result = await cache.refresh(task, { force: true });

    assert.equal(result.activity, "Ran tests");
    assert.equal(result.summaryFailed, true);
    assert.equal(result.activity.includes("\n"), false);
  });

  test("can disable secondary model calls for fallback-only operation", async () => {
    let calls = 0;
    const cache = createActivityCache({
      summariesEnabled: false,
      snapshot: () => ({ text: "local\nactivity", outputWatermark: 40 }),
      summarize: async () => { calls++; return "must not be used"; },
    });

    const result = await cache.refresh(task, { force: true });

    assert.equal(calls, 0);
    assert.equal(result.activity, "local activity");
    assert.equal(result.summaryFailed, false);
  });

  test("passes --summaries through watch and keeps Claude monitor output to one line", async () => {
    let stdout = "";
    const calls = [];
    const controller = new AbortController();
    const client = {
      subscribe: async (params, onEvent) => {
        calls.push(params);
        onEvent({ type: "task.activity", taskId: "oc_ab12", status: "running", activity: "Verifying the server\nwith new env vars via Playwright" });
        controller.abort();
      },
      close() {},
    };

    const result = await runCli(["watch", "--format", "claude-monitor", "--summaries"], {
      io: { stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} } },
      signal: controller.signal,
      connectClient: async () => client,
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, [{ directory: fs.realpathSync(process.cwd()), summaries: true }]);
    assert.equal(stdout, "Taskferry(running · oc_ab12): Verifying the server with new env vars via Playwright\n");
  });

  test("accepts the activity subscription parameter at the daemon protocol boundary", () => {
    const request = parseRequestLine(JSON.stringify({
      version: 1,
      id: "subscribe",
      method: "event.subscribe",
      params: { directory: "/tmp", summaries: true },
    }));

    assert.equal(request.params.summaries, true);
  });

  test("activityCacheKey differs by includeSummary so on/off requests don't share a cache entry", () => {
    const task = { id: "oc_1", status: "running" };
    const withSummary = activityCacheKey(task, 4096, "test/model", 24, true);
    const withoutSummary = activityCacheKey(task, 4096, "test/model", 24, false);

    assert.notEqual(withSummary, withoutSummary);
  });
});
