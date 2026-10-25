import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { makeManager, fakeChild, baseTask, makeFakeExecutor, mkdtempTracked, MIMIMAX_MODEL } from "./tasks.test-helpers.js";

const CONTINUATION = "Finish the original assignment.";
const CONTEXT_DIR = "resume-context";
const MANIFEST_FILE = "manifest.json";
const REQUEST_C17 = "Verify C17.";
const REQUEST_FILE = "request-1.txt";
const NEXT_CANDIDATE = "C17 is finished. Check C21 next.";

test("session resume preserves the full recorded assignment after its temporary prompt file is removed", () => {
  const launches = [];
  const mgr = makeManager({
    spawnFn: (_cmd, args) => {
      const child = fakeChild();
      launches.push({ args, child });
      return child;
    },
  });
  const originalPrompt = `Verify the assigned candidates.\n${"diff context\n".repeat(10000)}\nCandidates: C17, C21. Return verdicts.json.`;
  const first = mgr.dispatch({ prompt: originalPrompt, directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_recovery", executor: "opencode" });
  const promptFile = path.join(mgr.paths.STATE_DIR, "prompts", `${first.id}.prompt.txt`);
  assert.equal(fs.existsSync(promptFile), true);
  launches[0].child.emit("exit", 0, null);
  assert.equal(fs.existsSync(promptFile), false);
  const priorOutputFiles = fs.readdirSync(mgr.output(first.id).outputDir);
  const resumed = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_recovery", executor: "opencode" });
  assert.deepEqual(fs.readdirSync(mgr.output(first.id).outputDir), priorOutputFiles, "resume must not add internal cache files to earlier deliverables");
  const output = mgr.output(resumed.id);
  const manifestFile = "resume-context/manifest.json";
  assert.ok(output.files.some((file) => file.path === manifestFile), "a resumed task must carry a persistent request manifest");
  const contextDir = path.join(output.outputDir, CONTEXT_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(contextDir, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.sessionId, "ses_recovery");
  assert.equal(manifest.requests.length, 1);
  assert.equal(manifest.requests[0].taskId, first.id);
  assert.equal(manifest.requests[0].complete, true);
  assert.equal(fs.readFileSync(path.join(contextDir, manifest.requests[0].file), "utf8"), originalPrompt);
  const inlinePrompt = launches[1].args.at(-1);
  assert.ok(inlinePrompt.startsWith(CONTINUATION));
  assert.ok(inlinePrompt.includes(path.join(contextDir, MANIFEST_FILE)));
  assert.equal(inlinePrompt.includes("diff context"), false);
  assert.equal(mgr.result(resumed.id, { fields: ["prompt"] }).prompt, CONTINUATION);
  launches[1].child.emit("exit", 0, null);
});

test("repeated resume after manager reload restores only the original assignment, not continuation history", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child });
  const sessionId = "ses_repeated";
  const first = mgr.dispatch({ sessionId, prompt: "Verify C17 and C21; return verdicts.json.", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "opencode" });
  child.emit("exit", 0, null);
  mgr.dispatch({ sessionId, prompt: NEXT_CANDIDATE, directory: os.tmpdir(), executor: "opencode" });
  child.emit("exit", 0, null);
  mgr.flushPersist();
  const reloadedChild = fakeChild();
  const reloaded = makeManager({ stateDir: mgr._stateDir, spawnFn: () => reloadedChild });
  const third = reloaded.dispatch({ sessionId, prompt: CONTINUATION, directory: os.tmpdir(), executor: "opencode" });
  const contextDir = path.join(reloaded.output(third.id).outputDir, CONTEXT_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(contextDir, MANIFEST_FILE), "utf8"));
  assert.deepEqual(manifest.requests.map((request) => request.taskId), [first.id]);
  assert.deepEqual(fs.readdirSync(contextDir).sort(), [MANIFEST_FILE, REQUEST_FILE].sort(), "the packet must not grow a request file for every continuation");
  assert.deepEqual(manifest.requests.map((request) => fs.readFileSync(path.join(contextDir, request.file), "utf8")), [
    "Verify C17 and C21; return verdicts.json.",
  ]);
  reloadedChild.emit("exit", 0, null);
});

test("resume context includes only the same session, executor, and directory, excluding internal tasks", () => {
  const directory = os.tmpdir();
  const sessionId = "ses_scoped";
  const child = fakeChild();
  const included = baseTask({ directory, sessionId, id: "included", executorId: "opencode", originalPrompt: REQUEST_C17 });
  const mgr = makeManager({ spawnFn: () => child, tasksFixture: [
    included,
    { ...included, id: "other-session", sessionId: "ses_other", originalPrompt: "OTHER SESSION" },
    { ...included, id: "other-executor", executorId: "pi", originalPrompt: "OTHER EXECUTOR" },
    { ...included, id: "other-directory", directory: mkdtempTracked("resume-other-"), originalPrompt: "OTHER DIRECTORY" },
    { ...included, id: "internal-summary", internal: true, originalPrompt: "INTERNAL SUMMARY" },
  ] });
  const resumed = mgr.dispatch({ directory, sessionId, prompt: CONTINUATION, executor: "opencode" });
  const contextDir = path.join(mgr.output(resumed.id).outputDir, CONTEXT_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(contextDir, MANIFEST_FILE), "utf8"));
  assert.deepEqual(manifest.requests.map((request) => request.taskId), ["included"]);
  assert.equal(fs.readFileSync(path.join(contextDir, manifest.requests[0].file), "utf8"), REQUEST_C17);
  child.emit("exit", 0, null);
});

test("returning to a directory recovers its requests even when the newest session task is elsewhere", () => {
  const child = fakeChild();
  const directory = os.tmpdir();
  const sessionId = "ses_return";
  const included = baseTask({ directory, sessionId, id: "local-request", executorId: "opencode", originalPrompt: REQUEST_C17, startedAt: "2026-01-01T00:00:00.000Z" });
  const mgr = makeManager({ spawnFn: () => child, tasksFixture: [
    included,
    { ...included, id: "newer-elsewhere", directory: mkdtempTracked("resume-away-"), originalPrompt: "OTHER DIRECTORY", startedAt: "2026-01-02T00:00:00.000Z" },
  ] });
  const resumed = mgr.dispatch({ directory, sessionId, prompt: CONTINUATION, executor: "opencode" });
  const manifest = JSON.parse(fs.readFileSync(path.join(mgr.output(resumed.id).outputDir, CONTEXT_DIR, MANIFEST_FILE), "utf8"));
  assert.deepEqual(manifest.requests.map((request) => request.taskId), [included.id]);
  assert.equal(manifest.previousTaskId, included.id);
  child.emit("exit", 0, null);
});

test("a surviving continuation is not certified as the original assignment after history pruning", () => {
  const launches = [];
  const child = fakeChild();
  const mgr = makeManager({
    spawnFn: (_cmd, args) => { launches.push(args); return child; },
    tasksFixture: [baseTask({ directory: os.tmpdir(), sessionId: "ses_pruned", originalPrompt: NEXT_CANDIDATE })],
  });
  const resumed = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_pruned", executor: "opencode" });
  const contextDir = path.join(mgr.output(resumed.id).outputDir, CONTEXT_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(contextDir, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.requests[0].complete, true);
  assert.equal(fs.readFileSync(path.join(contextDir, REQUEST_FILE), "utf8"), NEXT_CANDIDATE);
  assert.ok(launches[0].at(-1).includes("Text completeness does not prove this is the original assignment; earlier requests may have been pruned."));
  child.emit("exit", 0, null);
});

test("a retained pre-upgrade original ending with an ellipsis is complete", () => {
  const child = fakeChild();
  const prompt = "Check the output\u2026";
  const mgr = makeManager({ spawnFn: () => child, tasksFixture: [baseTask({
    directory: os.tmpdir(), sessionId: "ses_old_ellipsis", originalPrompt: prompt, promptPreview: prompt,
  })] });
  const resumed = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_old_ellipsis", executor: "opencode" });
  const manifest = JSON.parse(fs.readFileSync(path.join(mgr.output(resumed.id).outputDir, CONTEXT_DIR, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.requests[0].complete, true);
  child.emit("exit", 0, null);
});

test("resume packets isolate request edits and survive eviction of older output directories", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child, maxDispatchesPerWindow: 4 });
  const directory = os.tmpdir();
  const sessionId = "ses_independent";
  const first = mgr.dispatch({ directory, sessionId, prompt: REQUEST_C17, model: MIMIMAX_MODEL, executor: "opencode" });
  child.emit("exit", 0, null);
  const second = mgr.dispatch({ directory, sessionId, prompt: "Verify C21 next.", executor: "opencode" });
  child.emit("exit", 0, null);
  const third = mgr.dispatch({ directory, sessionId, prompt: CONTINUATION, executor: "opencode" });
  child.emit("exit", 0, null);
  const oldRequest = path.join(mgr.output(second.id).outputDir, CONTEXT_DIR, REQUEST_FILE);
  const newRequest = path.join(mgr.output(third.id).outputDir, CONTEXT_DIR, REQUEST_FILE);
  fs.writeFileSync(oldRequest, "A worker changed its packet.");
  assert.equal(fs.readFileSync(newRequest, "utf8"), REQUEST_C17, "editing one packet must not change another packet's assignment");
  const fourth = mgr.dispatch({ directory, sessionId, prompt: CONTINUATION, executor: "opencode" });
  child.emit("exit", 0, null);
  assert.equal(fs.readFileSync(path.join(mgr.output(fourth.id).outputDir, CONTEXT_DIR, REQUEST_FILE), "utf8"), REQUEST_C17, "a modified earlier packet must not replace retained request text");
  fs.rmSync(mgr.output(first.id).outputDir, { recursive: true });
  fs.rmSync(mgr.output(second.id).outputDir, { recursive: true });
  assert.equal(fs.readFileSync(newRequest, "utf8"), REQUEST_C17);
});

test("unrelated worker output cannot block recovery from retained request text", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempTracked("resume-cache-fifo-");
  const sourceDir = path.join(root, "prior");
  const outputDir = path.join(root, "next");
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(outputDir);
  const fifo = spawnSync("mkfifo", [path.join(sourceDir, "recorded-request.txt")], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    const { writeResumeContext } = await import(process.argv[2]);
    writeResumeContext([{ id: "prior", startedAt: "2026-01-01", originalPrompt: "Request" }], process.argv[1]);
    assert.equal(fs.readFileSync(path.join(process.argv[1], "resume-context", "request-1.txt"), "utf8"), "Request");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, outputDir, new URL("./resume-context.js", import.meta.url).href], { encoding: "utf8", timeout: 2000 });
  assert.equal(child.status, 0, `the cache probe must fail fast rather than hang: ${child.error ?? child.stderr}`);
});

test("legacy truncated previews are explicitly marked incomplete instead of claimed as recovered assignments", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child, tasksFixture: [baseTask({
    directory: os.tmpdir(),
    sessionId: "ses_legacy",
    promptPreview: "x".repeat(200) + "\u2026",
    promptTotalChars: 120000,
  })] });
  const resumed = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_legacy", executor: "opencode" });
  const contextDir = path.join(mgr.output(resumed.id).outputDir, CONTEXT_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(contextDir, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.requests.length, 1);
  assert.equal(manifest.requests[0].complete, false);
  assert.equal(fs.readFileSync(path.join(contextDir, manifest.requests[0].file), "utf8"), "x".repeat(200) + "\u2026");
  child.emit("exit", 0, null);
});

test("legacy prompts without length metadata stay partial after persistence and reload", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child, tasksFixture: [baseTask({
    directory: os.tmpdir(),
    sessionId: "ses_legacy_unknown",
    promptPreview: "Only the beginning is recorded",
  })] });
  mgr.flushPersist();
  const reloaded = makeManager({ stateDir: mgr._stateDir, spawnFn: () => child });
  const resumed = reloaded.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_legacy_unknown", executor: "opencode" });
  const manifest = JSON.parse(fs.readFileSync(path.join(reloaded.output(resumed.id).outputDir, CONTEXT_DIR, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.requests[0].complete, false, "a backfilled preview is not evidence that the full assignment survived");
  child.emit("exit", 0, null);
});

test("a complete short request ending with an ellipsis is not mistaken for a truncated preview", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child });
  mgr.dispatch({ prompt: "Check the output\u2026", directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_ellipsis", executor: "opencode" });
  child.emit("exit", 0, null);
  const resumed = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_ellipsis", executor: "opencode" });
  const manifest = JSON.parse(fs.readFileSync(path.join(mgr.output(resumed.id).outputDir, CONTEXT_DIR, MANIFEST_FILE), "utf8"));
  assert.equal(manifest.requests[0].complete, true);
  child.emit("exit", 0, null);
});

test("fresh and unknown sessions do not claim recovered context", () => {
  const child = fakeChild();
  const mgr = makeManager({ spawnFn: () => child, maxDispatchesPerWindow: 4 });
  mgr.dispatch({ prompt: "Known assignment.", directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_known", executor: "opencode" });
  child.emit("exit", 0, null);
  const known = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), sessionId: "ses_known", executor: "opencode" });
  assert.equal(mgr.output(known.id).files.length, 2);
  child.emit("exit", 0, null);
  const fresh = mgr.dispatch({ prompt: "Fresh assignment.", directory: os.tmpdir(), model: MIMIMAX_MODEL, executor: "opencode" });
  assert.equal(fresh.status, "running", "the fixture must launch each child before emitting its exit");
  assert.equal(mgr.output(fresh.id).files.length, 0);
  child.emit("exit", 0, null);
  const unknown = mgr.dispatch({ prompt: CONTINUATION, directory: os.tmpdir(), model: MIMIMAX_MODEL, sessionId: "ses_unknown", executor: "opencode" });
  assert.equal(unknown.status, "running", "the fixture must not leave a delayed launch after teardown");
  assert.equal(mgr.output(unknown.id).files.length, 0);
  child.emit("exit", 0, null);
});

test("a real sandboxed child can read a resumed assignment without access to the task ledger", { skip: process.platform !== "linux" }, async (t) => {
  const directory = mkdtempTracked("resume-sandbox-project-");
  const socketPath = path.join(mkdtempTracked("resume-socket-"), "daemon.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    const contextDir = path.join(process.env.TASKFERRY_OUTPUT_DIR, "resume-context");
    const manifest = JSON.parse(fs.readFileSync(path.join(contextDir, "manifest.json"), "utf8"));
    const request = fs.readFileSync(path.join(contextDir, manifest.requests[0].file), "utf8");
    const ledgerVisible = fs.existsSync(path.resolve(process.env.TASKFERRY_OUTPUT_DIR, "..", "..", "tasks.json"));
    fs.writeFileSync(path.join(process.env.TASKFERRY_OUTPUT_DIR, "sandbox-check.json"), JSON.stringify({ request, ledgerVisible, taskId: manifest.requests[0].taskId }));
  `;
  const executor = makeFakeExecutor({ binaryName: process.execPath, buildSpawnArgs: () => ["--input-type=module", "-e", script] });
  const mgr = makeManager({
    runtimeDir: path.dirname(socketPath),
    sandboxEnabled: true,
    defaultExecutor: executor,
    spawnFn: spawn,
    tasksFixture: [baseTask({ directory, id: "sandbox-original", sessionId: "ses_real", executorId: "pi", originalPrompt: "Verify C17 and C21." })],
  });
  assert.equal(fs.existsSync(path.join(mgr.paths.STATE_DIR, "tasks.json")), true);
  const resumed = mgr.dispatch({ directory, prompt: CONTINUATION, sessionId: "ses_real" });
  const settled = await mgr.poll(resumed.id, { timeoutMs: 10000 });
  assert.equal(settled.status, "done", fs.readFileSync(settled.logPath, "utf8"));
  const check = mgr.output(resumed.id, { path: "sandbox-check.json" });
  assert.deepEqual(JSON.parse(check.file.content), { request: "Verify C17 and C21.", ledgerVisible: false, taskId: "sandbox-original" });
});
