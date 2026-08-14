import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createActivityCache, buildLocalActivity, snapshotNarration, activityCacheKey, readDeltaNarration } from "./activity.js";
import { runCli } from "./cli.js";
import { parseRequestLine } from "./protocol.js";
import { createTaskManager, DEFAULT_SUMMARY_MODEL } from "./tasks.js";
import { createWorkspaceRootResolver, resolveWorkspaceRoot } from "./paths.js";
import { syncActivitySubscriptions } from "./daemon-server.js";
import { trackManager, fakeChild, mkdtempTracked } from "./tasks.test-helpers.js";

const TASK_ACTIVITY = "task.activity";
const TASK_STATE = "task.state";
const ACTIVITY_DIR_PREFIX = "taskferry-activity-test-";

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

  test("includes truncated tool call input/output alongside text", () => {
    const raw = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "Checking repo state" } }),
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status" }, output: "x".repeat(600) } },
      }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "Now editing the file" } }),
    ].join("\n");

    const snapshot = snapshotNarration(raw, { maxBytes: Buffer.byteLength(raw), maxChars: 4000 });

    assert.match(snapshot.text, /Checking repo state/);
    assert.match(snapshot.text, /\[tool:bash] \{"command":"git status"} -> x+…\[truncated]/);
    assert.match(snapshot.text, /Now editing the file/);
  });

  test("uses a sanitized dispatch prompt as local activity before model output exists", () => {
    assert.equal(
      buildLocalActivity({ status: "running", prompt: "Inspect\n\u001b[31mthe server\u001b[0m" }),
      "Inspect the server"
    );
  });

  test("readDeltaNarration returns only the narration appended since fromOffset", async () => {
    const logDir = mkdtempTracked("taskferry-delta-snap-");
    const logPath = path.join(logDir, "log.ndjson");
    const first = JSON.stringify({ type: "text", part: { messageID: "first", text: "Earlier narration" } });
    fs.writeFileSync(logPath, `${first}\n`);
    const firstSize = Buffer.byteLength(`${first}\n`);
    const snapshotBefore = readDeltaNarration(logPath, 0);
    assert.match(snapshotBefore.narration, /Earlier narration/);
    assert.equal(snapshotBefore.outputWatermark, firstSize);
    assert.equal(snapshotBefore.sourceLogBytes, firstSize);

    const appended = JSON.stringify({ type: "text", part: { messageID: "second", text: "Later narration only" } });
    fs.appendFileSync(logPath, `${appended}\n`);
    const finalSize = Buffer.byteLength(`${first}\n${appended}\n`);

    const deltaOnly = readDeltaNarration(logPath, firstSize);
    assert.equal(deltaOnly.narration.includes("Earlier narration"), false);
    assert.match(deltaOnly.narration, /Later narration only/);
    assert.equal(deltaOnly.outputWatermark, finalSize);
    assert.equal(deltaOnly.sourceLogBytes, finalSize);
    assert.equal(deltaOnly.inputBytes, Buffer.byteLength(`${appended}\n`));

    const noNewBytes = readDeltaNarration(logPath, finalSize);
    assert.equal(noNewBytes.narration, "");
    assert.equal(noNewBytes.outputWatermark, finalSize);
    assert.equal(noNewBytes.inputBytes, 0);
  });
});

describe("task activity events", () => {
  test("emits state transitions immediately and activity enrichment afterward", async (t) => {
    const stateDir = mkdtempTracked(ACTIVITY_DIR_PREFIX);
    const child = fakeChild();
    const events = [];
    const manager = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => child,
      killFn: () => {},
      activitySummariesEnabled: false,
      summarizerTimeoutMs: 0,
      onEvent: (event) => events.push(event),
    }));
    t.after(() => manager.close());

    const task = manager.dispatch({ prompt: "Check the server", directory: os.tmpdir() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.slice(0, 2).map((event) => [event.type, event.status]), [
      [TASK_STATE, "queued"],
      [TASK_STATE, "running"],
    ]);
    assert.equal(events[2].type, TASK_ACTIVITY);
    assert.equal(events[2].activityVariants["false"].activity, "Check the server");

    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.at(-2).type, TASK_STATE);
    assert.equal(events.at(-2).status, "done");
    assert.equal(events.at(-1).type, TASK_ACTIVITY);
    assert.deepEqual(events.map((event) => event.sequence), events.map((event) => event.sequence).sort((a, b) => a - b));
    assert.equal(task.status, "running");
  });

  test("unions a `watch --all` (null-keyed) activitySubscriptions bucket with a task's own directory bucket (taskferry#315)", async (t) => {
    const stateDir = mkdtempTracked(ACTIVITY_DIR_PREFIX);
    const child = fakeChild();
    const events = [];
    const manager = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => child,
      killFn: () => {},
      activitySummariesEnabled: false,
      summarizerTimeoutMs: 0,
      onEvent: (event) => events.push(event),
    }));
    t.after(() => manager.close());

    const directory = os.tmpdir();
    // daemon-server.js's syncActivitySubscriptions() groups a `watch --all`
    // subscription under the null key regardless of any task's own
    // directory; a directory-scoped subscription for an unrelated directory
    // is included too, to prove the union doesn't accidentally match on it.
    manager.setActivitySubscriptions(new Map([
      [null, new Set([false])],
      ["/some/other/unrelated/directory", new Set([true])],
    ]));

    manager.dispatch({ prompt: "Watch the fleet", directory });
    await new Promise((resolve) => setImmediate(resolve));

    const activityEvent = events.find((event) => event.type === TASK_ACTIVITY);
    assert.ok(activityEvent, "the null-keyed --all bucket must still trigger activity scheduling for a task in a directory it didn't explicitly subscribe to");
    assert.deepEqual(Object.keys(activityEvent.activityVariants), ["false"], "only the --all bucket's variant applies; the unrelated directory's variant must not leak in");
  });

  test("resolves a task's directory to its workspace root before the activitySubscriptions lookup, so a root-scoped watch subscriber still receives task.activity for a linked worktree (taskferry#335)", async (t) => {
    const stateDir = mkdtempTracked(ACTIVITY_DIR_PREFIX);
    const child = fakeChild();
    const events = [];
    const repoRoot = "/repo/root";
    const worktreeDir = os.tmpdir();
    // Simulates a task dispatched into a linked worktree whose git workspace
    // root is the repo root a `watch` subscriber scoped to -- the two
    // directory strings are literally different, only resolveWorkspaceRootFn
    // ties them together, the same way daemon.js's real resolver does via
    // `git rev-parse --git-common-dir`.
    const resolveWorkspaceRootFn = createWorkspaceRootResolver({
      runCommand: (_command, args) => ({
        status: args[1] === worktreeDir || args[1] === repoRoot ? 0 : 1,
        stdout: args[1] === worktreeDir || args[1] === repoRoot ? `${repoRoot}/.git\n` : "",
        stderr: "",
      }),
    });
    const manager = trackManager(createTaskManager({
      stateDir,
      resolveWorkspaceRootFn,
      sandboxEnabled: false,
      spawnFn: () => child,
      killFn: () => {},
      activitySummariesEnabled: false,
      summarizerTimeoutMs: 0,
      onEvent: (event) => events.push(event),
    }));
    t.after(() => manager.close());

    syncActivitySubscriptions(manager, new Map([
      ["repo", { directory: repoRoot, summaries: false }],
      ["unrelated", { directory: "/some/other/unrelated/directory", summaries: true }],
    ]), resolveWorkspaceRootFn);

    manager.dispatch({ prompt: "Watch the fleet", directory: worktreeDir });
    await new Promise((resolve) => setImmediate(resolve));

    const activityEvent = events.find((event) => event.type === TASK_ACTIVITY);
    assert.ok(activityEvent, "a root-scoped watch subscriber must still receive task.activity for a task dispatched into a linked worktree, not have the event silently dropped");
    assert.deepEqual(Object.keys(activityEvent.activityVariants), ["false"], "must resolve the task's directory to its workspace root and find the repoRoot-keyed subscription's real variant, not the literal-directory decoy's");
  });

  test("refreshes running activity only after 4096 more log bytes", async (t) => {
    const stateDir = mkdtempTracked(ACTIVITY_DIR_PREFIX);
    const child = fakeChild();
    const events = [];
    const manager = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => child,
      killFn: () => {},
      activitySummariesEnabled: false,
      summarizerTimeoutMs: 0,
      noOutputTimeoutMs: 500,
      watchdogPollMs: 5,
      onEvent: (event) => events.push(event),
    }));
    t.after(() => manager.close());

    const task = manager.dispatch({ prompt: "Watch output", directory: os.tmpdir() });
    await new Promise((resolve) => setImmediate(resolve));
    const before = events.filter((event) => event.type === TASK_ACTIVITY).length;
    fs.appendFileSync(task.logPath, "x".repeat(4095));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.filter((event) => event.type === TASK_ACTIVITY).length, before);

    fs.appendFileSync(task.logPath, "x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.filter((event) => event.type === TASK_ACTIVITY).length, before + 1);
    child.emit("exit", 0, null);
  });

  test("publishes one internal summary result without exposing the summary job", async (t) => {
    const stateDir = mkdtempTracked(ACTIVITY_DIR_PREFIX);
    const children = [];
    const events = [];
    const manager = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: (_command, args) => {
        const child = fakeChild(5000 + children.length);
        children.push({ child, summary: args.includes("--pure") });
        return child;
      },
      killFn: () => {},
      activitySummariesEnabled: true,
      summarizerTimeoutMs: 0,
      // The default 3s global lowerdir stagger (taskferry#318) would
      // otherwise queue the internal summary launch behind the source
      // dispatch instead of letting both launch immediately.
      lowerdirStaggerMs: 0,
      onEvent: (event) => events.push(event),
      listModelsFn: () => `${DEFAULT_SUMMARY_MODEL}\n`,
    }));
    t.after(() => manager.close());
    manager.setActivitySummarySubscriptions(1);

    const source = manager.dispatch({ prompt: "Inspect the daemon", directory: os.tmpdir() });
    await new Promise((resolve) => setImmediate(resolve));
    manager.flushPersist();
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

    const activity = events.find((event) => event.type === TASK_ACTIVITY && event.taskId === source.id);
    assert.equal(activity.activityVariants["true"].activity, "Inspecting the daemon configuration.");
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
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "Checking the daemon", outputWatermark: 10 }),
      summarize: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { text: "Checking the daemon configuration", sessionId: null };
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
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "same output", outputWatermark: 20 }),
      summarize: async () => {
        calls++;
        return { text: "same summary", sessionId: null };
      },
    });

    await cache.refresh(task, { force: true });
    const cached = await cache.refresh(task, { force: true });

    assert.equal(calls, 1);
    assert.equal(cached.cached, true);
  });

  test("propagates the secondary model's failure instead of falling back to local activity", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "Ran\n\u001b[2mtests\u001b[0m", outputWatermark: 30 }),
      summarize: async () => { throw new Error("provider unavailable"); },
    });

    await assert.rejects(cache.refresh(task, { force: true }), /provider unavailable/);
  });

  test("passes the previous successful summary to the next summarize call, so the model can report only the delta", async () => {
    const seenPreviousActivity = [];
    let watermark = 10;
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "growing narration", outputWatermark: watermark }),
      summarize: async ({ previousActivity }) => {
        seenPreviousActivity.push(previousActivity);
        return { text: `summary at watermark ${watermark}`, sessionId: null };
      },
    });

    await cache.refresh(task, { force: true });
    watermark = 20;
    await cache.refresh(task, { force: true });
    watermark = 30;
    await cache.refresh(task, { force: true });

    assert.deepEqual(seenPreviousActivity, [null, "summary at watermark 10", "summary at watermark 20"]);
  });

  test("can disable secondary model calls for fallback-only operation", async () => {
    let calls = 0;
    const cache = createActivityCache({
      summariesEnabled: false,
      snapshot: () => ({ text: "local\nactivity", outputWatermark: 40 }),
      summarize: async () => { calls++; return { text: "must not be used", sessionId: null }; },
    });

    const result = await cache.refresh(task, { force: true });

    assert.equal(calls, 0);
    assert.equal(result.activity, "local activity");
  });

  test("first summarize call has no prior summary session id or watermark; subsequent calls carry both through", async () => {
    const seenInputs = [];
    let watermark = 100;
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "narration", outputWatermark: watermark }),
      summarize: async ({ previousSessionId, lastSummarizedWatermark }) => {
        seenInputs.push({ previousSessionId, lastSummarizedWatermark });
        return { text: "summary", sessionId: watermark === 100 ? null : "ses_existing" };
      },
    });

    // First call: nothing on file, the summarize callback sees the empty-state
    // defaults (null session id and 0 watermark) so the spawner launches fresh.
    await cache.refresh(task, { force: true });

    // Simulate the spawned summary child settling and the daemon handing its
    // opencode session id back to the cache (normally that path lives in
    // startTask's exit handler in tasks.js -- here we exercise just the
    // cache's storage half).
    cache.setSummarySessionId(task.id, "ses_first");
    cache.setLastSummarizedWatermark(task.id, 100);

    watermark = 250;
    await cache.refresh(task, { force: true });
    cache.setSummarySessionId(task.id, "ses_second");
    cache.setLastSummarizedWatermark(task.id, 250);

    watermark = 500;
    await cache.refresh(task, { force: true });

    assert.deepEqual(seenInputs, [
      { previousSessionId: null, lastSummarizedWatermark: 0 },
      { previousSessionId: "ses_first", lastSummarizedWatermark: 100 },
      { previousSessionId: "ses_second", lastSummarizedWatermark: 250 },
    ]);
  });

  test("stores the opencode session id returned from summarize so the next turn can resume the same conversation", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "snap", outputWatermark: 10 }),
      summarize: async () => ({ text: "summary text", sessionId: "ses_abc" }),
    });

    await cache.refresh(task, { force: true });

    assert.equal(cache.getSummarySessionId(task.id), "ses_abc");
    assert.equal(cache.getLastSummarizedWatermark(task.id), 10);
  });

  test("does not store a session id or watermark when summarize returns empty text", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "snap", outputWatermark: 10 }),
      summarize: async () => ({ text: "   \n\t  ", sessionId: "ses_should_not_persist" }),
    });

    await assert.rejects(cache.refresh(task, { force: true }));
    assert.equal(cache.getSummarySessionId(task.id), null);
    assert.equal(cache.getLastSummarizedWatermark(task.id), 0);
  });

  test("clears the stored session id and watermark after a thrown summarize failure so the next call retries fresh", async () => {
    let shouldThrow = true;
    let watermark = 10;
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "snap", outputWatermark: watermark }),
      summarize: async () => {
        if (shouldThrow) throw new Error("provider 503");
        return { text: "fresh summary", sessionId: "ses_fresh" };
      },
    });

    // A thrown summarize failure now propagates out of refresh() instead of
    // being masked; confirm the failure path still leaves the session and
    // watermark caches empty so the next call retries fresh.
    await assert.rejects(cache.refresh(task, { force: true }), /provider 503/);
    assert.equal(cache.getSummarySessionId(task.id), null);
    assert.equal(cache.getLastSummarizedWatermark(task.id), 0);

    // Bump the snapshot watermark so the next refresh isn't a cache hit on
    // a stale entry (a failed refresh is never cached, so this bump is only
    // needed to produce genuinely new content for the successful retry).
    shouldThrow = false;
    watermark = 20;
    const result = await cache.refresh(task, { force: true });

    assert.equal(result.activity, "fresh summary");
    assert.equal(cache.getSummarySessionId(task.id), "ses_fresh");
    assert.equal(cache.getLastSummarizedWatermark(task.id), 20);
  });

  test("clearSummaryState wipes both session id and watermark so the next call starts as if no summary had happened", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "snap", outputWatermark: 10 }),
      summarize: async () => ({ text: "summary", sessionId: "ses_x" }),
    });

    await cache.refresh(task, { force: true });
    assert.equal(cache.getSummarySessionId(task.id), "ses_x");

    cache.clearSummaryState(task.id);

    assert.equal(cache.getSummarySessionId(task.id), null);
    assert.equal(cache.getLastSummarizedWatermark(task.id), 0);
  });

  test("passes --summaries through watch and keeps output to one line", async () => {
    let stdout = "";
    const calls = [];
    const controller = new AbortController();
    const client = {
      subscribe: async (params, onEvent) => {
        calls.push(params);
        onEvent({ type: TASK_ACTIVITY, taskId: "oc_ab12", status: "running", activity: "Verifying the server\nwith new env vars via Playwright" });
        controller.abort();
      },
      close() {},
    };

    const result = await runCli(["watch", "--format", "toon", "--summaries"], {
      io: { stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} } },
      signal: controller.signal,
      connectClient: async () => client,
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, [{ directory: resolveWorkspaceRoot(fs.realpathSync(process.cwd())), summaries: true }]);
    assert.equal(stdout.split("\n").length, 2);
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
