import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { trackManager, makeManager, fakeChild, baseTask, INVESTIGATED_TEXT, SOURCE_LOG, LUNA_MODEL, MINIMAX_MODEL, READING_CONFIG, CONTINUE_FLAG, SRCA_LOG, SRCB_LOG, DID_A, DID_B, mkdtempTracked, makeFakeExecutor } from "./tasks.test-helpers.js";

describe("summarize(): spawn shape, attachment, and snapshot content", () => {
  test("uses --pure and a private attachment", async () => {
    let captured;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: INVESTIGATED_TEXT } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      spawnFn: (command, args, options) => {
        captured = { command, args, options };
        return child;
      },
    });

    const summary = await mgr.summarize("source", { maxWords: 150 });
    assert.equal(captured.command, "opencode");
    assert.ok(captured.args.includes("--pure"));
    assert.equal(captured.args.includes("--auto"), false);
    assert.equal(captured.args.includes("--agent"), false);
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    assert.equal(fs.statSync(attachment).mode & 0o777, 0o600);
    assert.equal(captured.options.cwd, mgr.paths.SUMMARY_DIR);
    assert.equal(summary.summaryTask.status, "running");

    child.emit("exit", 0, null);
    assert.equal(fs.existsSync(attachment), false);
  });

  test("writes a previous_summary field into the snapshot attachment when previousActivity is given", async () => {
    let capturedSnapshot;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: INVESTIGATED_TEXT } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      spawnFn: (_command, args) => {
        const attachment = args[args.indexOf("-f") + 1];
        capturedSnapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
        return child;
      },
    });

    await mgr.summarize("source", { maxWords: 150, previousActivity: "Read the config file." });

    assert.equal(capturedSnapshot.previous_summary, "Read the config file.");
    child.emit("exit", 0, null);
  });

  test("omits previous_summary from the snapshot attachment when there is no prior activity", async () => {
    let capturedSnapshot;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: INVESTIGATED_TEXT } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      spawnFn: (_command, args) => {
        const attachment = args[args.indexOf("-f") + 1];
        capturedSnapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
        return child;
      },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal("previous_summary" in capturedSnapshot, false);
    child.emit("exit", 0, null);
  });

  test("includes truncated tool call input/output alongside text in the narration snapshot", async () => {
    let capturedSnapshot;
    const child = fakeChild();
    const log = [
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "Checking repo state" } }),
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status" }, output: "x".repeat(600) } },
      }),
      JSON.stringify({ type: "text", part: { messageID: "m2", text: "Now editing the file" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      spawnFn: (_command, args) => {
        const attachment = args[args.indexOf("-f") + 1];
        capturedSnapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
        return child;
      },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.match(capturedSnapshot.narration, /Checking repo state/);
    assert.match(capturedSnapshot.narration, /\[tool:bash] \{"command":"git status"} -> x+…\[truncated]/);
    assert.match(capturedSnapshot.narration, /Now editing the file/);
    child.emit("exit", 0, null);
  });

  test("does not spend a model call when no text has been observed", async () => {
    let spawned = false;
    const mgr = makeManager({
      tasksFixture: [baseTask({ id: "source" })],
      spawnFn: () => { spawned = true; return fakeChild(); },
    });
    const result = await mgr.summarize("source");
    assert.equal(result.summary, "no model text observed yet");
    assert.equal(spawned, false);
  });

  test("rejects an unavailable configured summary model before creating a task", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "progress" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      listModelsFn: () => LUNA_MODEL + "\n",
    });
    await assert.rejects(mgr.summarize("source"), /summary model is unavailable/);
    assert.equal(mgr.list().tasks.length, 1);
  });

  test("checkSummaryModelReady rejects when the configured summary model is unavailable", async () => {
    const mgr = makeManager({ listModelsFn: () => LUNA_MODEL + "\n" });
    await assert.rejects(mgr.checkSummaryModelReady(), /summary model is unavailable/);
  });
});

describe("summarize(): listModelsFn source-of-truth and oversized-log snapshot", () => {
  test("createTaskManager()'s real default listModelsFn validates against opencode's list, not the dispatch-default executor's (a default pi install must still find the default summary model)", async () => {
    // Bypasses makeManager deliberately -- it always injects its own
    // listModelsFn fallback, which would mask a regression back to either
    // the round-2 (defaultExecutor.listModelsFn) or round-3 pre-fix
    // (hardcoded `opencode models`) defaults. We want to prove the new
    // default is opencodeExecutor().listModelsFn regardless of the
    // configured dispatch-default executor.
    const stateDir = mkdtempTracked("axi-tasks-test-");
    let piListModelsCalled = false;
    const fakePi = makeFakeExecutor({
      listModelsFn: async () => {
        piListModelsCalled = true;
        // Whatever pi returns here is irrelevant: summaries always run
        // through opencode, so this list must NOT be used for the check.
        return MINIMAX_MODEL + "\n";
      },
    });
    const mgr = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      defaultExecutor: fakePi,
      // listModelsFn intentionally omitted -- exercising the real default.
    }));
    // On a host with opencode installed, the check will succeed (real
    // `opencode models` output includes the default summary model). On
    // a host without opencode, the check will fail with a "verify that
    // opencode is installed" error -- which is itself proof that the
    // check hit opencode, not pi. Either outcome is fine; what matters
    // is that pi's listModelsFn was never consulted.
    try {
      await mgr.checkSummaryModelReady();
    } catch (err) {
      // If opencode isn't installed, the error message must still point
      // at opencode -- that's what proves we routed through opencode.
      assert.match(/** @type {Error} */ (err).message, /verify that opencode is installed/, "the summary availability check must consult opencode's listModelsFn, not pi's");
    }
    assert.equal(piListModelsCalled, false, "fakePi.listModelsFn must not be used for the summary availability check (it would reject opencode-only summary models)");
  });

  test("an injected listModelsFn takes precedence over the opencode default (preserves the round-2 test seam)", async () => {
    // The round-2 fix made createTaskManager's `listModelsFn` option
    // defer to defaultExecutor's listModelsFn, and several tests rely
    // on being able to inject a custom listModelsFn. Verify that
    // explicit injection still works -- just that the new *default* (used
    // when no override is given) is opencode's, not pi's.
    const stateDir = mkdtempTracked("axi-tasks-test-");
    let injectedCalled = false;
    const fakePi = makeFakeExecutor({ listModelsFn: async () => MINIMAX_MODEL + "\n" });
    const mgr = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      defaultExecutor: fakePi,
      listModelsFn: async () => {
        injectedCalled = true;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
    }));
    await mgr.checkSummaryModelReady();
    assert.equal(injectedCalled, true, "explicit listModelsFn injection must take precedence over the opencode default");
  });

  test("summary --mode activity rejects when the summary model is unavailable, instead of masking the failure with local narration", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "progress" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      listModelsFn: () => LUNA_MODEL + "\n",
    });
    await assert.rejects(mgr.summarize("source", { mode: "activity", maxWords: 150 }), /summary model is unavailable/);
  });

  test("preserves head and tail narration around an oversized log omission marker", async () => {
    const child = fakeChild();
    let attachment;
    const events = [
      JSON.stringify({ type: "text", part: { messageID: "head", text: "HEAD_MARKER" } }),
      ...Array.from({ length: 160 }, (_, index) => JSON.stringify({
        type: "text",
        part: { messageID: `middle-${index}`, text: "x".repeat(700) },
      })),
      JSON.stringify({ type: "text", part: { messageID: "tail", text: "TAIL_MARKER" } }),
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: events },
      spawnFn: (_command, args) => {
        attachment = args[args.indexOf("-f") + 1];
        return child;
      },
    });
    await mgr.summarize("source");
    const snapshot = JSON.parse(fs.readFileSync(attachment, "utf8"));
    assert.match(snapshot.narration, /HEAD_MARKER/);
    assert.match(snapshot.narration, /TAIL_MARKER/);
    assert.match(snapshot.narration, /bytes omitted from source log/);
    child.emit("exit", 0, null);
  });
});

// DEFAULT_SUMMARY_MODEL is referenced by the trackManager(createTaskManager())'s default
// listModelsFn tests below; importing it for that purpose keeps the bare
// identifier in those call sites from tripping 'no-undef'.
import { DEFAULT_SUMMARY_MODEL } from "./tasks.js";

// Drives a single spawned summary child through its lifecycle (write a
// sessionID into its log so readSessionIdFromLog returns it, then fire the
// exit event). The default fakeChild never logs anything, so without this
// step the cache wouldn't get a session id to persist for the next call.
// Returns the summary task id (looked up by summaryOf.sourceTaskId) and the
// fakeChild handle so the caller can keep emitting further exits.
async function settleSummaryChildWithSessionId(mgr, summaryTaskId, sessionId, finalText = "current state") {
  mgr.flushPersist();
  const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
  const summary = persisted.find((task) => task.id === summaryTaskId);
  if (!summary) throw new Error(`no summary task ${summaryTaskId} persisted`);
  fs.writeFileSync(
    summary.logPath,
    [
      JSON.stringify({ sessionID: sessionId, type: "step_start" }),
      JSON.stringify({ type: "text", part: { messageID: "answer", text: finalText } }),
      JSON.stringify({ type: "step_finish", part: { messageID: "answer", reason: "stop" } }),
    ].join("\n")
  );
}

describe("summarize(): multi-call session continuity", () => {
  test("first summarize call spawns with no --continue/--session flags and writes the full bounded excerpt", async () => {
    let firstArgs;
    let firstSnapshot;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Inspect the daemon" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      spawnFn: (_command, args) => {
        firstArgs = args;
        firstSnapshot = JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1], "utf8"));
        return child;
      },
    });

    const started = await mgr.summarize("source", { maxWords: 150 });
    assert.ok(started.summaryTask);

    assert.equal(firstArgs.includes(CONTINUE_FLAG), false);
    assert.equal(firstArgs.includes("--session"), false);
    assert.match(firstSnapshot.narration, /Inspect the daemon/);
    assert.equal(firstSnapshot.narration_is_delta, undefined);

    await settleSummaryChildWithSessionId(mgr, started.summaryTask.id, "ses_first");
    child.emit("exit", 0, null);
  });

  test("second summarize call continues the prior session and sends only the narration delta (not the full bounded excerpt)", async () => {
    const children = [];
    const captures = [];
    const initialLog = JSON.stringify({ type: "text", part: { messageID: "m1", text: READING_CONFIG } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: initialLog },
      spawnFn: (_command, args) => {
        const child = fakeChild(5000 + children.length);
        children.push(child);
        captures.push({ args, attachment: args[args.indexOf("-f") + 1] });
        return child;
      },
    });

    // First call: no continuation flags, snapshot uses the full bounded excerpt.
    const firstStarted = await mgr.summarize("source", { maxWords: 150 });
    const firstSnapshot = JSON.parse(fs.readFileSync(captures[0].attachment, "utf8"));
    assert.equal(captures[0].args.includes(CONTINUE_FLAG), false);
    assert.equal(captures[0].args.includes("--session"), false);
    assert.match(firstSnapshot.narration, /Reading the config/);

    // Simulate the first summary task settling and handing its session id
    // back via the cache's setSummarySessionId path (startTask's exit handler
    // does this in production).
    await settleSummaryChildWithSessionId(mgr, firstStarted.summaryTask.id, "ses_first");
    children[0].emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    // Grow the source log; the second turn must see only the appended bytes.
    fs.appendFileSync(firstStarted.sourceTaskId && path.join(mgr.paths.LOG_DIR, `${firstStarted.sourceTaskId}.ndjson`), "");

    // Read the source task's persisted logPath and append new content so the
    // next summarize call sees a real delta.
    const persistedTasks = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const source = persistedTasks.find((t) => t.id === "source");
    fs.appendFileSync(source.logPath, JSON.stringify({ type: "text", part: { messageID: "m2", text: "New step completed" } }) + "\n");

    // Second call: must continue the prior session, send only the delta, and
    // include the previous summary so the model can stitch them together.
    const secondStarted = await mgr.summarize("source", { maxWords: 150, previousActivity: "Read the config." });
    const secondArgs = captures[1].args;
    const secondSnapshot = JSON.parse(fs.readFileSync(captures[1].attachment, "utf8"));

    assert.ok(secondStarted.summaryTask);
    assert.equal(secondArgs.includes(CONTINUE_FLAG), true);
    assert.ok(secondArgs.includes("--session"));
    const sessionIdx = secondArgs.indexOf("--session");
    assert.equal(secondArgs[sessionIdx + 1], "ses_first");
    // Delta-only: includes the newly appended narration, omits the old prefix.
    assert.match(secondSnapshot.narration, /New step completed/);
    assert.equal(secondSnapshot.narration.includes(READING_CONFIG), false);
    assert.equal(secondSnapshot.narration_is_delta, true);
    assert.equal(secondSnapshot.previous_summary, "Read the config.");

    // Clean up the spawned summary children.
    await settleSummaryChildWithSessionId(mgr, secondStarted.summaryTask.id, "ses_second", "delta-only result");
    children[1].emit("exit", 0, null);
  });
});

describe("summarize(): continue-fail-so-fresh retry", () => {
  test("continue-fails-so-fresh: summarizeActivity detects a session-id mismatch and retries fresh, leaving the cache clear of the stale id", async () => {
    const captures = [];
    const children = [];
    const initialLog = JSON.stringify({ type: "text", part: { messageID: "m1", text: READING_CONFIG } }) + "\n";
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: initialLog },
      spawnFn: (_command, args) => {
        captures.push({ args, attachment: args[args.indexOf("-f") + 1] });
        const child = fakeChild(7000 + captures.length);
        children.push(child);
        return child;
      },
    });

    // Seed the cache the same way startTask's exit handler would after a
    // prior successful summarize call: it stores the spawn's opencode
    // session id and the source-log watermark at summarize time. The watermark
    // is the byte size of the source log right now, so summarizeTask's
    // rotation check (`watermark > currentSize`) won't kick in and discard it.
    const sourceLogPath = path.join(fs.realpathSync(mgr.paths.LOG_DIR), SOURCE_LOG);
    const initialSize = fs.statSync(sourceLogPath).size;
    mgr.activityCache.setSummarySessionId("source", "ses_cached");
    mgr.activityCache.setLastSummarizedWatermark("source", initialSize);

    // Grow the source log so a delta exists for the next turn.
    const sourceTaskPersisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8")).find((t) => t.id === "source");
    const appendedLine = JSON.stringify({ type: "text", part: { messageID: "m2", text: "More work done" } }) + "\n";
    fs.appendFileSync(sourceTaskPersisted.logPath, appendedLine);

    // Kick off the activity path: summarizeActivity will spawn #1 with
    // --continue --session ses_cached, poll #1, see that the spawned child's
    // log carries no matching session id, and spawn #2 fresh.
    const refreshP = mgr.activityCache.refresh(
      { id: "source", status: "running", logPath: sourceTaskPersisted.logPath },
      { force: true, includeSummary: true }
    );

    // Wait for spawn #1 to land (synchronous inside summarizeTask).
    while (captures.length < 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(captures[0].args.includes(CONTINUE_FLAG));
    assert.ok(captures[0].args.includes("--session"));
    assert.equal(captures[0].args[captures[0].args.indexOf("--session") + 1], "ses_cached");
    // Spawn #1's snapshot is a delta (we have a prior watermark and growth).
    const firstSnapshot = JSON.parse(fs.readFileSync(captures[0].attachment, "utf8"));
    assert.equal(firstSnapshot.narration_is_delta, true);

    // Drive spawn #1's exit. The fakeChild's log is empty so its derived
    // session id is null -- which doesn't match ses_cached, triggering the
    // fallback path.
    children[0].emit("exit", 0, null);
    while (captures.length < 2) await new Promise((resolve) => setImmediate(resolve));

    // Spawn #2 is the fresh retry: no --continue, no --session, full bounded excerpt.
    const retryArgs = captures[1].args;
    assert.equal(retryArgs.includes(CONTINUE_FLAG), false);
    assert.equal(retryArgs.includes("--session"), false);
    const retrySnapshot = JSON.parse(fs.readFileSync(captures[1].attachment, "utf8"));
    assert.equal(retrySnapshot.narration_is_delta, undefined);
    assert.match(retrySnapshot.narration, /Reading the config/);
    assert.match(retrySnapshot.narration, /More work done/);

    // Drop a usable final message + sessionID into the retry's log so the
    // retry's session id survives into the cache for the next call.
    mgr.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const retries = persisted.filter((t) => t.summaryOf && t.summaryOf.sourceTaskId === "source");
    assert.equal(retries.length, 2, "expected two summary tasks to have been queued");
    fs.writeFileSync(
      retries[1].logPath,
      JSON.stringify({ sessionID: "ses_fresh_retry", type: "text", part: { messageID: "answer", text: "fresh retry output" } }) + "\n"
        + JSON.stringify({ type: "step_finish", part: { messageID: "answer", reason: "stop" } }) + "\n"
    );
    children[1].emit("exit", 0, null);

    const result = await refreshP;
    assert.equal(result.activity, "fresh retry output");
    // Cache ended up with the retry's session id (recorded by the exit
    // handler), not the stale ses_cached or the mismatched first attempt.
    assert.equal(mgr.activityCache.getSummarySessionId("source"), "ses_fresh_retry");
    assert.notEqual(mgr.activityCache.getLastSummarizedWatermark("source"), initialSize);
  });
});

describe("summarize(): exit handler persistence and concurrency reserve", () => {
  test("summarizeTask's exit handler persists the opencode session id and the source-log watermark to the activity cache for the next turn", async () => {
    const child = fakeChild();
    const initialLog = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigating issue" } }) + "\n";
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: initialLog },
      spawnFn: () => child,
    });

    const started = await mgr.summarize("source", { maxWords: 150 });
    // Pre-settlement: cache has nothing for this task.
    assert.equal(mgr.list().tasks.length, 2);

    await settleSummaryChildWithSessionId(mgr, started.summaryTask.id, "ses_real");
    child.emit("exit", 0, null);
    // Allow the exit handler's microtasks (persist, activity update, etc.) to drain.
    await new Promise((resolve) => setImmediate(resolve));

    // Exit handler should have stamped the summary task with the spawned
    // opencode session id read from its log, and persisted status=done to
    // tasks.json. The activity-cache side effects (next-turn --session lookup)
    // are exercised end-to-end by the second-call test above.
    mgr.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const summary = persisted.find((task) => task.id === started.summaryTask.id);
    assert.equal(summary.status, "done");
    assert.equal(summary.sessionId, "ses_real");
  });

  test("activity-refresh summary reserve retries briefly instead of dropping a second task's summary outright (regression for #134 review finding)", async () => {
    const children = [];
    const log1 = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Task one progress" } }) + "\n";
    const log2 = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Task two progress" } }) + "\n";
    const mgr = makeManager({
      maxConcurrentTasks: 2,
      tasksFixture: (logDir) => [
        baseTask({ id: "source1", logPath: path.join(logDir, "source1.ndjson") }),
        baseTask({ id: "source2", logPath: path.join(logDir, "source2.ndjson") }),
      ],
      logs: { "source1.ndjson": log1, "source2.ndjson": log2 },
      spawnFn: () => {
        const child = fakeChild(9000 + children.length);
        children.push(child);
        return child;
      },
    });
    const fixtures = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const source1 = fixtures.find((t) => t.id === "source1");
    const source2 = fixtures.find((t) => t.id === "source2");

    try {
      mock.timers.enable({ apis: ["setTimeout"] });

      // source1's forced activity refresh occupies the only summary reserve
      // slot (summaryConcurrencyLimit = 1 at maxConcurrentTasks = 2).
      const refresh1P = mgr.activityCache.refresh(source1, { force: true, includeSummary: true });
      while (children.length < 1) await new Promise((resolve) => setImmediate(resolve));
      mgr.flushPersist();
      const summary1Id = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"))
        .find((t) => t.summaryOf && t.summaryOf.sourceTaskId === "source1").id;

      // source2's refresh starts while the reserve is full. Before this fix,
      // the reserve check returned the "skipped" response immediately here.
      const refresh2P = mgr.activityCache.refresh(source2, { force: true, includeSummary: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(children.length, 1, "source2 must not spawn yet while the reserve is full");

      // Free the slot before the retry loop exhausts its attempts.
      await settleSummaryChildWithSessionId(mgr, summary1Id, "ses_source1", "source one summary");
      children[0].emit("exit", 0, null);
      assert.equal((await refresh1P).activity, "source one summary");

      // Advance past the retry delay so source2's loop re-checks and proceeds
      // now that the slot is free, instead of giving up.
      mock.timers.tick(500);
      while (children.length < 2) await new Promise((resolve) => setImmediate(resolve));

      mgr.flushPersist();
      const summary2Id = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"))
        .find((t) => t.summaryOf && t.summaryOf.sourceTaskId === "source2").id;
      await settleSummaryChildWithSessionId(mgr, summary2Id, "ses_source2", "source two summary");
      children[1].emit("exit", 0, null);

      const result2 = await refresh2P;
      assert.equal(result2.activity, "source two summary", "source2 must get a real summary, not the reserve-skip text");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("summarize(): per-caller-env listModels cache (Fix 1)", () => {
  test("summary cache keeps separate entries for caller envs with different provider keys (no cross-caller pollution)", async () => {
    // Fix 1: the old single-entry cache meant caller A's listModelsFn output
    // (the model list opencode exposed under A's API keys) would satisfy
    // caller B's availability check, even though B has different credentials
    // and a different visible model list. Two summarize() calls with
    // different provider keys must populate and read separate cache entries,
    // each rooted in its own env.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, SRCA_LOG) }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, SRCB_LOG) }),
      ],
      logs: {
        [SRCA_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_A } }) + "\n",
        [SRCB_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_B } }) + "\n",
      },
      listModelsFn: async (env) => {
        listModelsCalls++;
        // Env A sees model-A; env B does NOT (and vice versa). If the cache
        // ever cross-polluted, the second summarize would read the first
        // caller's cached output and the wrong model list would reach the
        // availability check for the other caller.
        if (env.OPENAI_API_KEY === "AAA") return `${DEFAULT_SUMMARY_MODEL}\nopenai/gpt-A-only\n`;
        if (env.OPENAI_API_KEY === "BBB") return `${DEFAULT_SUMMARY_MODEL}\nopenai/gpt-B-only\n`;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "AAA" } });
    assert.equal(listModelsCalls, 1, "first caller populates its own cache entry");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "BBB" } });
    assert.equal(listModelsCalls, 2, "second caller (different provider key) must populate a separate cache entry, not read the first caller's");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache shares an entry for identical caller envs (one listModelsFn call within the TTL)", async () => {
    // Fix 1: opposite of the cross-pollution case. Two callers with the
    // same provider-relevant env must share the cache entry -- otherwise
    // every dispatch would re-shell-out to `opencode models`, defeating
    // the original 5-minute memoization purpose.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, SRCA_LOG) }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, SRCB_LOG) }),
      ],
      logs: {
        [SRCA_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_A } }) + "\n",
        [SRCB_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_B } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", ANTHROPIC_API_KEY: "same" } });
    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", ANTHROPIC_API_KEY: "same" } });

    assert.equal(listModelsCalls, 1, "identical caller envs must share one cache entry");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache ignores cosmetic env differences that don't change which models a provider exposes (no per-call fragmentation)", async () => {
    // Fix 1: the fingerprint deliberately excludes high-churn unrelated
    // caller vars (PATH, LANG, USER, ...) so a caller changing cosmetic
    // vars doesn't trigger a fresh listModelsFn shell-out within the TTL.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, SRCA_LOG) }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, SRCB_LOG) }),
      ],
      logs: {
        [SRCA_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_A } }) + "\n",
        [SRCB_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_B } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", LANG: "en_US.UTF-8", USER: "alice" } });
    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", LANG: "C.UTF-8", USER: "bob" } });

    assert.equal(listModelsCalls, 1, "LANG/USER are not in the fingerprint -- cosmetic differences must not fragment the cache");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache separates entries across opencode catalog/auth overrides and provider base-URL overrides", async () => {
    // Review follow-up to fix 1: the original fingerprint covered
    // *_API_KEY / OPENCODE_CONFIG* / PI_CODING_AGENT_DIR only. But
    // OPENCODE_MODELS_URL / OPENCODE_MODELS_PATH point opencode at a
    // different model catalog, OPENCODE_AUTH_CONTENT carries inline auth
    // (the sibling of the already-covered OPENCODE_CONFIG_CONTENT), and
    // *_BASE_URL endpoint overrides change which catalog a provider
    // exposes (corporate proxies, self-hosted endpoints). Two callers
    // differing only in one of these must not share a cache entry.
    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, SRCA_LOG) }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, SRCB_LOG) }),
      ],
      logs: {
        [SRCA_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_A } }) + "\n",
        [SRCB_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_B } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", OPENCODE_MODELS_URL: "https://catalog-1" } });
    assert.equal(listModelsCalls, 1, "first caller populates");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", OPENCODE_MODELS_URL: "https://catalog-2" } });
    assert.equal(listModelsCalls, 2, "different OPENCODE_MODELS_URL must not share a cache entry");

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", OPENCODE_MODELS_PATH: "/models-1.json" } });
    assert.equal(listModelsCalls, 3, "OPENCODE_MODELS_PATH is in the fingerprint");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", OPENCODE_AUTH_CONTENT: '{"auth":"a"}' } });
    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same", OPENCODE_AUTH_CONTENT: '{"auth":"b"}' } });
    assert.equal(listModelsCalls, 5, "different OPENCODE_AUTH_CONTENT must not share a cache entry");

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same", OPENAI_BASE_URL: "https://proxy.internal" } });
    assert.equal(listModelsCalls, 6, "a *_BASE_URL endpoint override is in the fingerprint");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("summary cache TTL still expires per-key after 5 minutes (a stale entry must not be served indefinitely)", async (t) => {
    // Fix 1: re-keying on env does not break the existing 5-minute TTL.
    // After the TTL window elapses, the next call must re-shell-out for
    // the same env's model list (provider availability can change within
    // a TTL window -- e.g. an opencode auth.json swap or a new provider
    // registration). Mock Date.now to control TTL timing without
    // sleeping.
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    /** @type {() => void} */
    const restore = () => { Date.now = realNow; };
    t.after(restore);

    /** @type {Array<EventEmitter>} */
    const spawned = [];
    let listModelsCalls = 0;
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({ id: "srcA", status: "done", logPath: path.join(logDir, SRCA_LOG) }),
        baseTask({ id: "srcB", status: "done", logPath: path.join(logDir, SRCB_LOG) }),
      ],
      logs: {
        [SRCA_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_A } }) + "\n",
        [SRCB_LOG]: JSON.stringify({ type: "text", part: { messageID: "m1", text: DID_B } }) + "\n",
      },
      listModelsFn: async () => {
        listModelsCalls++;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
      spawnFn: () => {
        const child = fakeChild();
        spawned.push(child);
        return child;
      },
    });

    await mgr.summarize("srcA", { env: { OPENAI_API_KEY: "same" } });
    assert.equal(listModelsCalls, 1, "first call populates the cache");

    now += 5 * 60 * 1000 + 1; // past the 5-minute TTL window

    await mgr.summarize("srcB", { env: { OPENAI_API_KEY: "same" } });
    assert.equal(listModelsCalls, 2, "after TTL expiry, the same env's cache must repopulate");

    for (const child of spawned) child.emit("exit", 0, null);
  });

  test("concurrent summary availability checks for the same caller env coalesce into a single listModelsFn call (no interleaved writes)", async () => {
    // Fix 1: the old single-entry cache had a write race -- two concurrent
    // `modelsCache = ...` assignments could interleave (one wins the
    // expiresAt, the other the output), leaving an entry whose output
    // doesn't match its expiresAt. The new Map<key, entry> + inFlight
    // pattern serializes populates per-key: the second caller awaits the
    // first's populate promise and reads the same entry.
    /** @type {() => void} */
    let releaseListModels;
    const listModelsBlocking = new Promise((resolve) => { releaseListModels = () => resolve(undefined); });
    let listModelsCalls = 0;
    const mgr = makeManager({
      listModelsFn: async () => {
        listModelsCalls++;
        await listModelsBlocking;
        return `${DEFAULT_SUMMARY_MODEL}\n`;
      },
    });

    // Fire two concurrent checks for the same caller env (no env, so both
    // share the empty fingerprint). Before fix 1, both would race through
    // the `if (Date.now() >= modelsCache.expiresAt)` gate before either
    // populated the entry, leading to two concurrent shell-outs.
    const call1 = mgr.checkSummaryModelReady();
    const call2 = mgr.checkSummaryModelReady();
    releaseListModels();
    await Promise.all([call1, call2]);

    assert.equal(listModelsCalls, 1, "concurrent populate calls for the same fingerprint must coalesce, not race");
  });
});
