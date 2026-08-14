// taskferry#423 -- every dispatch gets a writable scratch dir, surfaced via
// TASKFERRY_OUTPUT_DIR in the sandbox and retrievable via `taskferry output`.
// The behavior is a per-task write surface the worker can rely on, NOT a
// changeset accept/reject path: anything written under TASKFERRY_OUTPUT_DIR
// stays on disk after settlement (clean, crash, cancel, or incomplete) so a
// worker whose final assistant message ended on a tool call can still leave
// the deliverable for `taskferry output` to surface.
//
// The tests below cover: the sandbox rw-bind, the env var, the prompt-block
// mention, retrieval for done/crashed/cancelled/incomplete states, and the
// listing/read caps enforced by listTaskOutputFiles/readTaskOutputFile.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeManager, fakeChild, baseTask, AXI_TASKS_TEST_DIR, mkdtempTracked } from "./tasks.test-helpers.js";
import { TASKFERRY_OUTPUT_DIR_ENV, ensureTaskOutputDir, listTaskOutputFiles, readTaskOutputFile, resolveTaskOutputDir, resolveOutputDirRoot, resolveInsideDir } from "./output-dir.js";

const TEST_PROMPT = "hi";
const TEST_DIRECTORY = "/tmp";
const DELIVERABLE_NAME = "deliverable.txt";
const DELIVERABLE_CONTENT = "the answer";

const captureSpawn = (overrides = {}) => {
  let captured = null;
  const next = overrides.spawnFn ?? ((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return fakeChild();
  });
  const mgr = makeManager({ spawnFn: next, ...overrides });
  return { mgr, captured: () => captured };
};

const captureSummary = (overrides = {}) => {
  let captured = null;
  const next = overrides.spawnFn ?? ((_cmd, _args, opts) => {
    captured = opts;
    return fakeChild();
  });
  const mgr = makeManager({ spawnFn: next, ...overrides });
  return { mgr, captured: () => captured };
};

describe("scratch output dir (taskferry#423)", () => {
  test("resolveTaskOutputDir returns stateDir/outputs/<id>", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const out = resolveTaskOutputDir(stateDir, "oc_abc_def");
    assert.equal(out, path.join(stateDir, "outputs", "oc_abc_def"));
  });

  test("resolveOutputDirRoot returns stateDir/outputs", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    assert.equal(resolveOutputDirRoot(stateDir), path.join(stateDir, "outputs"));
  });

  test("ensureTaskOutputDir creates the directory with mode 0o700", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const out = resolveTaskOutputDir(stateDir, "oc_perm");
    ensureTaskOutputDir(out);
    const stat = fs.statSync(out);
    assert.ok(stat.isDirectory());
    assert.equal(stat.mode & 0o777, 0o700);
  });

  test("dispatch creates the per-task outputDir on disk before launch", () => {
    const { mgr } = captureSpawn();
    const dispatched = mgr.dispatch({ prompt: "do the thing", directory: "/tmp" });
    const expectedDir = path.join(mgr.paths.STATE_DIR, "outputs", dispatched.id);
    assert.ok(fs.existsSync(expectedDir), `expected ${expectedDir} to exist on disk`);
    assert.equal(dispatched.outputDir, expectedDir);
    assert.ok(dispatched.outputDir?.endsWith(`/outputs/${dispatched.id}`));
  });

  test("dispatched task summary exposes outputDir", () => {
    const { mgr } = captureSpawn();
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    assert.ok(dispatched.outputDir);
    const status = mgr.status(dispatched.id);
    assert.equal(status.outputDir, dispatched.outputDir);
  });

  test("dispatch sets TASKFERRY_OUTPUT_DIR on the spawn env", () => {
    const { mgr, captured } = captureSpawn();
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    assert.equal(captured().opts.env[TASKFERRY_OUTPUT_DIR_ENV], dispatched.outputDir);
  });

  test("summary launches do NOT set TASKFERRY_OUTPUT_DIR", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "answer" } });
    const { mgr, captured } = captureSummary({
      tasksFixture: (logDir) => [baseTask({ id: "oc_src", logPath: path.join(logDir, "src.ndjson") })],
      logs: { "src.ndjson": log },
    });
    await mgr.summarize("oc_src", { maxWords: 150 });
    assert.equal(captured().env[TASKFERRY_OUTPUT_DIR_ENV], undefined, "summary children must not see the dispatch output dir");
  });

  test("bwrap dispatch args rw-bind the outputDir at the same path", () => {
    const { mgr, captured } = captureSpawn({
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    let bindPair = null;
    for (let i = 0; i + 2 < captured().args.length; i++) {
      if (captured().args[i] === "--bind" && captured().args[i + 1] === captured().args[i + 2] && captured().args[i + 1] === dispatched.outputDir) {
        bindPair = captured().args[i + 1];
        break;
      }
    }
    assert.ok(bindPair, `expected outputDir rw-bind, got: ${JSON.stringify(captured().args)}`);
  });

  test("dispatch prompt contains the outputDir path and the TASKFERRY_OUTPUT_DIR name", () => {
    const { mgr, captured } = captureSpawn();
    const dispatched = mgr.dispatch({ prompt: "user's original prompt", directory: "/tmp" });
    const trailing = captured().args.at(-1);
    assert.equal(typeof trailing, "string");
    assert.ok(trailing.startsWith("user's original prompt\n"), `expected user prompt at the head, got: ${JSON.stringify(trailing.slice(0, 80))}`);
    assert.ok(trailing.includes(dispatched.outputDir), "prompt block must name the output dir");
    assert.ok(trailing.includes(TASKFERRY_OUTPUT_DIR_ENV), "prompt block must name the env var");
  });
});

describe("scratch output dir retrieval (taskferry#423)", () => {
  test("taskferry output: lists files written under the scratch dir after a clean exit", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, DELIVERABLE_NAME), DELIVERABLE_CONTENT);
    fs.mkdirSync(path.join(dispatched.outputDir, "subdir"), { recursive: true });
    fs.writeFileSync(path.join(dispatched.outputDir, "subdir", "more.txt"), "more content");
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const listing = mgr.output(dispatched.id);
    assert.equal(listing.taskId, dispatched.id);
    assert.equal(listing.outputDir, dispatched.outputDir);
    assert.deepEqual(listing.files.map((f) => f.path).sort(), [DELIVERABLE_NAME, "subdir/more.txt"].sort());
    assert.equal(listing.truncated, false);
  });

  test("taskferry output: returns the bytes for a single file when --path is given", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, DELIVERABLE_NAME), DELIVERABLE_CONTENT);
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const result = mgr.output(dispatched.id, { path: DELIVERABLE_NAME });
    assert.equal(result.taskId, dispatched.id);
    assert.ok(result.file, "expected file field in result when --path is given");
    assert.equal(result.file.content, DELIVERABLE_CONTENT);
    assert.equal(result.file.size, DELIVERABLE_CONTENT.length);
    assert.equal(result.file.truncated, false);
  });

  test("taskferry output: still lists files after a crashed task", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, "partial.txt"), "wip");
    child.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    const listing = mgr.output(dispatched.id);
    assert.equal(listing.files.length, 1);
    assert.equal(listing.files[0].path, "partial.txt");
  });

  test("taskferry output: still lists files after a cancelled task", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, "toolcall.txt"), "left a tool call");
    mgr.cancel(dispatched.id);
    child.emit("exit", null, "SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    const listing = mgr.output(dispatched.id);
    assert.equal(listing.files[0].path, "toolcall.txt");
  });

  test("taskferry output: still lists files on a task the worker marked incomplete", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, "wip.txt"), "still working");
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    mgr.flushPersist();
    const taskRow = JSON.parse(fs.readFileSync(mgr.paths.TASKS_FILE, "utf8"));
    const idx = taskRow.findIndex((t) => t.id === dispatched.id);
    taskRow[idx].incomplete = true;
    fs.writeFileSync(mgr.paths.TASKS_FILE, JSON.stringify(taskRow));

    const listing = mgr.output(dispatched.id);
    assert.equal(listing.files[0].path, "wip.txt");
  });

  test("taskferry output: rejects a missing task id", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    assert.throws(() => mgr.output("oc_does_not_exist"), /unknown task id|no such task/i);
  });

  test("taskferry output: returns empty listing for a fresh empty dir", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    const listing = mgr.output(dispatched.id);
    assert.deepEqual(listing.files, []);
    assert.equal(listing.bytes, 0);
    assert.equal(listing.truncated, false);
  });

  test("taskferry output: rejects a path that escapes the output dir", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => mgr.output(dispatched.id, { path: "../../etc/passwd" }), /escapes/i);
  });

  test("listTaskOutputFiles caps at MAX_OUTPUT_LIST_ENTRIES and reports truncated", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-list-");
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    }
    const result = listTaskOutputFiles(dir);
    assert.equal(result.truncated, true);
    assert.ok(result.files.length <= 256, `expected at most 256 files, got ${result.files.length}`);
    assert.ok(result.total <= 256);
  });

  test("listTaskOutputFiles skips node_modules and .git subtrees", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-skip-");
    fs.writeFileSync(path.join(dir, "keep.txt"), "k");
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "drop.txt"), "d");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "d");
    const result = listTaskOutputFiles(dir);
    assert.deepEqual(result.files.map((f) => f.path), ["keep.txt"]);
  });

  test("readTaskOutputFile caps single-file reads at 1MB and reports truncated", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-big-");
    const big = "x".repeat(2 * 1024 * 1024);
    fs.writeFileSync(path.join(dir, "huge.txt"), big);
    const result = readTaskOutputFile(dir, "huge.txt");
    assert.equal(result.truncated, true);
    assert.equal(result.error, "too_large");
    assert.equal(result.content, null);
    assert.equal(result.size, big.length);
  });

  test("readTaskOutputFile reports size and content for small files", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-small-");
    fs.writeFileSync(path.join(dir, "ok.txt"), "small content");
    const result = readTaskOutputFile(dir, "ok.txt");
    assert.equal(result.truncated, false);
    assert.equal(result.size, "small content".length);
    assert.equal(result.content, "small content");
  });

  test("readTaskOutputFile rejects a path that escapes the dir", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-escape-");
    assert.throws(() => readTaskOutputFile(dir, "../outside.txt"), /escapes/i);
  });

  test("resolveInsideDir rejects absolute and traversal paths", () => {
    const base = "/tmp/outputs/oc_x";
    assert.throws(() => resolveInsideDir(base, "/etc/passwd"), /escapes/i);
    assert.throws(() => resolveInsideDir(base, "../outside"), /escapes/i);
    assert.equal(resolveInsideDir(base, "ok.txt"), path.join(base, "ok.txt"));
    assert.equal(resolveInsideDir(base, "subdir/ok.txt"), path.join(base, "subdir", "ok.txt"));
  });

  test("readTaskOutputFile rejects a symlink whose real target escapes the output dir (PR #474 review)", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-symlink-read-");
    const outside = mkdtempTracked(AXI_TASKS_TEST_DIR + "-symlink-target-");
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "not for the worker to read");
    fs.symlinkSync(secret, path.join(dir, "escape.txt"));
    assert.throws(() => readTaskOutputFile(dir, "escape.txt"), /escapes/i);
  });

  test("listTaskOutputFiles does not descend into a symlinked directory (PR #474 review)", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-symlink-list-");
    const outside = mkdtempTracked(AXI_TASKS_TEST_DIR + "-symlink-list-target-");
    fs.writeFileSync(path.join(outside, "outside.txt"), "should not be listed");
    fs.symlinkSync(outside, path.join(dir, "linked-dir"));
    fs.writeFileSync(path.join(dir, "keep.txt"), "k");
    const result = listTaskOutputFiles(dir);
    assert.deepEqual(result.files.map((f) => f.path), ["keep.txt"]);
  });

  test("listTaskOutputFiles does not loop on a self-referential symlinked directory (PR #474 review)", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-symlink-cycle-");
    fs.symlinkSync(dir, path.join(dir, "self"));
    fs.writeFileSync(path.join(dir, "keep.txt"), "k");
    const result = listTaskOutputFiles(dir);
    assert.deepEqual(result.files.map((f) => f.path), ["keep.txt"]);
  });

  test("listTaskOutputFiles stops before admitting a single file that would exceed MAX_OUTPUT_TOTAL_BYTES (PR #474 review)", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-oversize-");
    const oversized = "x".repeat(9 * 1024 * 1024); // > the 8 MiB total cap
    fs.writeFileSync(path.join(dir, "huge.bin"), oversized);
    const result = listTaskOutputFiles(dir);
    assert.equal(result.files.length, 0, "the oversized entry must not be admitted whole");
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, 0);
  });
});
