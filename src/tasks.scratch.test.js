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
import { execFileSync } from "node:child_process";
import { makeManager, fakeChild, baseTask, trackManager, AXI_TASKS_TEST_DIR, mkdtempTracked } from "./tasks.test-helpers.js";
import { TASKFERRY_OUTPUT_DIR_ENV, ensureTaskOutputDir, listTaskOutputFiles, readTaskOutputFile, resolveTaskOutputDir, resolveOutputDirRoot, resolveInsideDir, MAX_SAFE_OUTPUT_FILE_BYTES } from "./output-dir.js";
import { createTaskManager, sweepOrphanedOutputDirsFor, MAX_SAFE_OUTPUT_FILE_BYTES as TASK_SAFE, assertListingResponseFits, assertOutputResponseFits, BUDGET_CHECK_ID } from "./tasks.js";
import { MAX_BUFFER_BYTES } from "./daemon-server.js";
import { encodeMessage, successResponse } from "./protocol.js";

const TEST_PROMPT = "hi";
const TEST_DIRECTORY = "/tmp";
const DELIVERABLE_NAME = "deliverable.txt";
const DELIVERABLE_CONTENT = "the answer";
const OUTSIDE_FILE_CONTENT = "should not be listed";
const PROC_SELF_FD = "/proc/self/fd";

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

  test("ensureTaskOutputDir refuses a symlink in the task-dir position", () => {
    const parent = mkdtempTracked(AXI_TASKS_TEST_DIR + "-ensure-symlink-");
    const outside = mkdtempTracked(AXI_TASKS_TEST_DIR + "-ensure-target-");
    const out = path.join(parent, "task");
    // eslint-disable-next-line sonarjs/file-permissions -- a non-700 target proves chmod did not follow the symlink
    fs.chmodSync(outside, 0o755);
    fs.symlinkSync(outside, out);

    assert.throws(() => ensureTaskOutputDir(out), /symlink/i);
    assert.equal(fs.lstatSync(out).isSymbolicLink(), true);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o755, "the symlink target must not be chmod-ed");
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

  test("dispatch prompt varies with noSandbox: noSandbox omits 'inside the sandbox'", () => {
    const { mgr: mgrDefault, captured: capturedDefault } = captureSpawn();
    mgrDefault.dispatch({ prompt: "test", directory: "/tmp" });
    const promptDefault = capturedDefault().args.at(-1);

    const { mgr: mgrNoSandbox, captured: capturedNoSandbox } = captureSpawn();
    mgrNoSandbox.dispatch({ prompt: "test", directory: "/tmp", noSandbox: true });
    const promptNoSandbox = capturedNoSandbox().args.at(-1);

    assert.ok(typeof promptDefault === "string", "default prompt must be a string");
    assert.ok(typeof promptNoSandbox === "string", "noSandbox prompt must be a string");
    assert.ok(promptDefault.includes("inside the sandbox"), "default prompt should contain 'inside the sandbox'");
    assert.ok(!promptNoSandbox.includes("inside the sandbox"), "noSandbox prompt must not contain 'inside the sandbox'");
    assert.ok(promptDefault.includes(TASKFERRY_OUTPUT_DIR_ENV), "default prompt must name the env var");
    assert.ok(promptNoSandbox.includes(TASKFERRY_OUTPUT_DIR_ENV), "noSandbox prompt must name the env var");
    assert.notEqual(promptDefault, promptNoSandbox, "prompts should differ between sandbox and noSandbox");
  });
});

describe("scratch output dir result --fields outputDir (regression: #514)", () => {
  test("result --fields outputDir returns the correct output dir path", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const result = mgr.result(dispatched.id, { fields: ["outputDir"] });
    assert.equal(result.outputDir, dispatched.outputDir);
  });

  test("result without --fields also includes outputDir", async () => {
    const child = fakeChild();
    const mgr = makeManager({ spawnFn: () => child });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const result = mgr.result(dispatched.id);
    assert.equal(result.outputDir, dispatched.outputDir);
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
    fs.writeFileSync(path.join(outside, "outside.txt"), OUTSIDE_FILE_CONTENT);
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

describe("scratch output dir walk caps (PR #482 review)", () => {
  test("listTaskOutputFiles caps the walk at MAX_OUTPUT_LIST_DIRS and marks truncated", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-dirs-");
    // More sibling directories than the cap, with one file each.
    for (let i = 0; i < 300; i++) {
      fs.mkdirSync(path.join(dir, `d${i}`));
      fs.writeFileSync(path.join(dir, `d${i}`, "f.txt"), "x");
    }
    const result = listTaskOutputFiles(dir);
    assert.equal(result.truncated, true);
    assert.ok(result.files.length < 300, `expected at most ${300} files (capped by dir count), got ${result.files.length}`);
    assert.ok(result.files.length > 0, "the walk should have started before hitting the cap");
  });

  test("listTaskOutputFiles caps the walk at MAX_OUTPUT_LIST_DEPTH and marks truncated", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-depth-");
    // Build a deep chain of empty nested directories past the depth cap.
    let cur = dir;
    for (let i = 0; i < 50; i++) {
      cur = path.join(cur, `lvl${i}`);
      fs.mkdirSync(cur);
    }
    fs.writeFileSync(path.join(cur, "deep.txt"), "x");
    const result = listTaskOutputFiles(dir);
    assert.equal(result.truncated, true, "deep nested trees must truncate rather than walking the daemon's request thread to exhaustion");
    assert.equal(result.files.length, 0, "the deep file is past the depth cap and must not be listed");
  });

  test("readTaskOutputFile caps the read at MAX_OUTPUT_FILE_BYTES when the file grows past the cap between fstat and read", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-grow-read-");
    const target = path.join(dir, "grow.txt");
    // Start small so the real fstat would let the read proceed past the
    // pre-read size check (we then grow the file inside the readSync mock
    // to simulate the worker extending the file after we already passed
    // fstat, between fstat and read).
    fs.writeFileSync(target, "tiny seed");

    const cap = 512 * 1024;
    const originalFstatSync = fs.fstatSync;
    const originalReadSync = fs.readSync;
    let readCalls = 0;
    fs.fstatSync = (...args) => {
      const stat = originalFstatSync(...args);
      // Lie about size so the pre-read check passes. Mirror the real
      // Stats surface so isFile() keeps reporting true.
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 12 });
    };
    fs.readSync = (...args) => {
      readCalls++;
      // Grow the file on disk past the cap before the read completes, so
      // the bounded read actually reads past the cap.
      const oversize = Buffer.alloc(cap + 1, "x");
      fs.writeFileSync(target, oversize);
      return originalReadSync(...args);
    };
    try {
      const result = readTaskOutputFile(dir, "grow.txt");
      assert.equal(readCalls, 1, "the read must happen exactly once (the bounded read, not the open's read)");
      assert.equal(result.truncated, true, "a file that grew past the cap between fstat and read must surface as too_large");
      assert.equal(result.error, "too_large");
      assert.equal(result.content, null);
    } finally {
      fs.fstatSync = originalFstatSync;
      fs.readSync = originalReadSync;
    }
  });
});

describe("scratch output dir security regressions", () => {
  test("readTaskOutputFile does not block on a worker-created FIFO with no writer (PR #482 review)", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-fifo-read-");
    const target = path.join(dir, "wedge.fifo");
    // node has no mkfifoSync; execFileSync("mkfifo", [target]) creates
    // a real FIFO on the host. With no writer attached, a plain
    // fs.openSync(target, "r") would block the daemon's request thread
    // forever; the O_NONBLOCK open path must surface this as not_a_file
    // (via ENXIO) instead.
    execFileSync("mkfifo", [target]);
    const result = readTaskOutputFile(dir, "wedge.fifo");
    assert.equal(result.error, "not_a_file");
    assert.equal(result.truncated, false);
    assert.equal(result.content, null);
  });

  test("readTaskOutputFile does not follow a symlink swapped immediately before the read", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-toctou-read-");
    const outside = mkdtempTracked(AXI_TASKS_TEST_DIR + "-toctou-target-");
    const target = path.join(dir, DELIVERABLE_NAME);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(target, "safe content");
    fs.writeFileSync(secret, "outside secret");

    const originalReadSync = fs.readSync;
    let readArgument;
    fs.readSync = (...args) => {
      [readArgument] = args;
      fs.unlinkSync(target);
      fs.symlinkSync(secret, target);
      return originalReadSync(...args);
    };
    try {
      const result = readTaskOutputFile(dir, DELIVERABLE_NAME);
      assert.equal(typeof readArgument, "number", "the read must use the opened file descriptor");
      assert.equal(result.content, "safe content", "a post-check symlink swap must not redirect the read");
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  test("listTaskOutputFiles ignores a symlinked root output directory", () => {
    const parent = mkdtempTracked(AXI_TASKS_TEST_DIR + "-root-symlink-");
    const outside = mkdtempTracked(AXI_TASKS_TEST_DIR + "-root-target-");
    const dir = path.join(parent, "task");
    fs.mkdirSync(path.join(outside, "nested"));
    fs.writeFileSync(path.join(outside, "outside.txt"), OUTSIDE_FILE_CONTENT);
    fs.writeFileSync(path.join(outside, "nested", "also-outside.txt"), OUTSIDE_FILE_CONTENT);
    fs.symlinkSync(outside, dir);

    const result = listTaskOutputFiles(dir);
    assert.deepEqual(result.files, []);
    assert.equal(result.bytes, 0);
    assert.equal(result.truncated, false);
  });

  test("listTaskOutputFiles skips an entry that vanishes between readdir and stat (PR #482 review)", () => {
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-vanish-");
    fs.writeFileSync(path.join(dir, "keep.txt"), "k");
    fs.writeFileSync(path.join(dir, "ghost.txt"), "g");
    const originalStatSync = fs.statSync;
    fs.statSync = (...args) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p.endsWith("/ghost.txt")) {
        const err = new Error("ENOENT: no such file or directory");
        err.code = "ENOENT";
        throw err;
      }
      return originalStatSync(...args);
    };
    try {
      const result = listTaskOutputFiles(dir);
      assert.deepEqual(result.files.map((f) => f.path), ["keep.txt"], "only the surviving entry must be listed");
      assert.equal(result.bytes, 1);
      assert.equal(result.truncated, false);
    } finally {
      fs.statSync = originalStatSync;
    }
  });
});

describe("output-dir fd leak (taskferry#509)", () => {
  test("listTaskOutputFiles does not leak a directory fd when readdir throws mid-walk", (t) => {
    if (process.platform !== "linux") {
      t.skip("only meaningful on linux where /proc/self/fd is available");
      return;
    }
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-fd-leak-");
    fs.mkdirSync(path.join(dir, "subdir"), { recursive: true });
    fs.writeFileSync(path.join(dir, "keep.txt"), "k");
    fs.writeFileSync(path.join(dir, "subdir", "inner.txt"), "x");

    const countFds = () => fs.readdirSync(PROC_SELF_FD).length;

    const originalReaddirSync = fs.readdirSync;
    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    let opens = 0;
    let closes = 0;
    fs.openSync = (...args) => { opens++; return originalOpenSync(...args); };
    fs.closeSync = (...args) => { closes++; return originalCloseSync(...args); };
    let walkCalls = 0;
    fs.readdirSync = new Proxy(originalReaddirSync, {
      apply(target, thisArg, args) {
        const [readdirPath] = args;
        const p = String(readdirPath);
        if (p === PROC_SELF_FD) return target.apply(thisArg, args);
        if (/^\/proc\/self\/fd\/\d+$/.test(p)) {
          walkCalls++;
          // Let root succeed, subdir throw EACCES — the exact window where
          // the popped fd would previously have leaked without a try/finally.
          if (walkCalls === 2) {
            const err = new Error(`EACCES: permission denied, scandir '${p}'`);
            err.code = "EACCES";
            throw err;
          }
        }
        return target.apply(thisArg, args);
      },
    });

    const fdsBefore = countFds();
    try {
      assert.throws(() => listTaskOutputFiles(dir), (err) => err.code === "EACCES");
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
    const fdsAfterSingle = countFds();
    // After one failed listing the fd count must not have grown and every
    // open must have been paired with a close.
    assert.equal(fdsAfterSingle, fdsBefore, "a single throwing walk must not leak an fd");
    assert.equal(opens, closes, `expected balanced open/close but got ${opens} opens vs ${closes} closes`);

    // Re-install the same failing mock to prove the leak does not accumulate
    // across repeated output listings (the daemon path that would reach EMFILE).
    walkCalls = 0;
    opens = 0;
    closes = 0;
    fs.readdirSync = new Proxy(originalReaddirSync, {
      apply(target, thisArg, args) {
        const [readdirPath] = args;
        const p = String(readdirPath);
        if (p === PROC_SELF_FD) return target.apply(thisArg, args);
        if (/^\/proc\/self\/fd\/\d+$/.test(p)) {
          walkCalls++;
          if (walkCalls % 2 === 0) {
            const err = new Error(`EACCES: permission denied, scandir '${p}'`);
            err.code = "EACCES";
            throw err;
          }
        }
        return target.apply(thisArg, args);
      },
    });
    const fdsBeforeLoop = countFds();
    try {
      for (let i = 0; i < 10; i++) {
        assert.throws(() => listTaskOutputFiles(dir), (err) => err.code === "EACCES");
      }
    } finally {
      fs.readdirSync = originalReaddirSync;
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
    }
    const fdsAfterLoop = countFds();
    assert.equal(fdsAfterLoop, fdsBeforeLoop, "repeated throwing walks must not accumulate leaked fds");
  });

  test("listTaskOutputFiles does not leak the popped directory fd when a file-stat throws mid-iteration", (t) => {
    if (process.platform !== "linux") {
      t.skip("only meaningful on linux where /proc/self/fd is available");
      return;
    }
    const dir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-fd-leak-stat-");
    fs.mkdirSync(path.join(dir, "subdir"), { recursive: true });
    // Throwing file lives under subdir so the walk must pop a non-root fd
    // (the subdir) before the stat throws — otherwise `current.fd === rootFd`
    // and the outer `finally` in listTaskOutputFiles would mask the leak.
    fs.writeFileSync(path.join(dir, "subdir", "keep.txt"), "k");

    const countFds = () => fs.readdirSync(PROC_SELF_FD).length;
    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    let opens = 0;
    let closes = 0;
    fs.openSync = (...args) => { opens++; return originalOpenSync(...args); };
    fs.closeSync = (...args) => { closes++; return originalCloseSync(...args); };

    const originalStatSync = fs.statSync;
    let statCalls = 0;
    fs.statSync = (...args) => {
      const p = typeof args[0] === "string" ? String(args[0]) : "";
      if (p.endsWith("/subdir/keep.txt") || p.endsWith("/keep.txt")) {
        statCalls++;
        if (statCalls === 1) {
          const err = new Error("EACCES: permission denied");
          err.code = "EACCES";
          throw err;
        }
      }
      return originalStatSync(...args);
    };

    const fdsBefore = countFds();
    try {
      assert.throws(() => listTaskOutputFiles(dir), (err) => err.code === "EACCES");
    } finally {
      fs.statSync = originalStatSync;
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
    }
    const fdsAfter = countFds();
    assert.equal(fdsAfter, fdsBefore, "a throwing file stat mid-walk must not leak the popped directory fd");
    assert.equal(opens, closes, `expected balanced open/close but got ${opens} opens vs ${closes} closes`);
  });
});

describe("boot-time sweep of orphaned output dirs under <stateDir>/outputs (PR #482 review)", () => {
  let sweepTestCounter = 0;
  test("deletes an output dir whose task id is not in tasks.json at startup", () => {
    sweepTestCounter++;
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-orphan-output-");
    const orphanId = `oc_orphan_output_${sweepTestCounter}_${process.pid}`;
    const orphanDir = path.join(stateDir, "outputs", orphanId);
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "stale.txt"), "leftover from a prior crash");

    const mgr = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
    }));

    assert.equal(fs.existsSync(orphanDir), false, "the orphan output dir should have been swept at boot");
    mgr.close();
  });

  test("keeps an output dir whose task id IS in tasks.json (settled tasks are intentional)", () => {
    sweepTestCounter++;
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-keep-output-");
    const taskId = `oc_kept_output_${sweepTestCounter}_${process.pid}`;
    const taskDir = path.join(stateDir, "outputs", taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "deliverable.txt"), "keep this");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify([
      { id: taskId, status: "done" },
    ]));

    const mgr = trackManager(createTaskManager({
      stateDir,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
    }));

    assert.equal(fs.existsSync(taskDir), true, "a tracked settled task's dir must be preserved by the boot sweep");
    mgr.close();
  });
});

describe("response-budget guard (taskferry#508 review)", () => {
  test("control-character-heavy file that fits raw cap but exceeds wire budget surfaces clear knob-specific error, not generic RESPONSE_TOO_LARGE", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    // 300 KiB of \x01: raw 307200, JSON-escaped ≈ 6× = 1.8 MiB > 1 MiB ceiling
    const heavy = String.fromCharCode(1).repeat(300 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "heavy.bin"), heavy);
    assert.throws(
      () => mgr.output(dispatched.id, { path: "heavy.bin", maxOutputFileBytes: 512 * 1024 }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Must mention the knob and safe ceiling, not the generic fallback
        assert.match(msg, /would exceed daemon response limit/);
        assert.match(msg, /--max-output-file-bytes/);
        assert.match(msg, new RegExp(String(MAX_SAFE_OUTPUT_FILE_BYTES)));
        assert.match(msg, /help:/);
        // Generic fallback must NOT appear
        assert.doesNotMatch(msg, /daemon response for this request exceeds/);
        return true;
      },
    );
  });

  test("ASCII file of same raw size succeeds under same cap (no false positive)", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    const ascii = "a".repeat(300 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "ascii.txt"), ascii);
    const result = mgr.output(dispatched.id, { path: "ascii.txt", maxOutputFileBytes: 512 * 1024 });
    assert.equal(result.file.content, ascii);
    assert.equal(result.file.truncated, false);
  });

  test("small control file within safe ceiling succeeds", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    const smallHeavy = String.fromCharCode(1).repeat(50 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "small.bin"), smallHeavy);
    const result = mgr.output(dispatched.id, { path: "small.bin", maxOutputFileBytes: 512 * 1024 });
    assert.equal(result.file.content, smallHeavy);
    assert.equal(result.file.truncated, false);
    // Also assert computed safe is indeed ≈ (1MiB-4096)/6 and matches both exports
    assert.equal(MAX_SAFE_OUTPUT_FILE_BYTES, TASK_SAFE);
    assert.equal(MAX_SAFE_OUTPUT_FILE_BYTES, Math.floor((MAX_BUFFER_BYTES - 4096) / 6));
  });

  test("--max-output-file-bytes exceeding raw daemon ceiling throws clear error", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, "tiny.txt"), "x");
    assert.throws(
      () => mgr.output(dispatched.id, { path: "tiny.txt", maxOutputFileBytes: MAX_BUFFER_BYTES + 1 }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /exceeds daemon response limit/);
        assert.match(msg, /--max-output-file-bytes/);
        return true;
      },
    );
  });

  test("creates manager with TASKFERRY_MAX_OUTPUT_FILE_BYTES exceeding raw ceiling throws at construction", () => {
    const prev = process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES;
    process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES = String(MAX_BUFFER_BYTES + 1000);
    try {
      assert.throws(
        () => createTaskManager({ stateDir: mkdtempTracked(AXI_TASKS_TEST_DIR + "-guard-env-"), config: {} }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /exceeds daemon response limit/);
          assert.match(msg, /TASKFERRY_MAX_OUTPUT_FILE_BYTES/);
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES;
      else process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES = prev;
    }
  });
});

describe("listing response-budget guard (taskferry#508 follow-up)", () => {
  test("synthetic listing with control-character-heavy filenames that would exceed wire budget is truncated to fit, not generic RESPONSE_TOO_LARGE", () => {
    const taskId = "oc_listing_guard_synthetic";
    const outputDir = "/tmp/state/outputs/oc_listing_guard_synthetic";
    const files = [];
    for (let i = 0; i < 256; i++) {
      files.push({ path: String.fromCharCode(1).repeat(800) + `_${i}.txt`, size: 10 });
    }
    const listing = { files, bytes: files.reduce((s, f) => s + f.size, 0), total: files.length, truncated: false };
    const fullPayload = { taskId, outputDir, files: listing.files, bytes: listing.bytes, total: listing.total, truncated: listing.truncated };
    const fullSize = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, fullPayload)));
    assert.ok(fullSize > MAX_BUFFER_BYTES, `synthetic full listing must exceed budget to test guard (got ${fullSize} <= ${MAX_BUFFER_BYTES})`);
    const guarded = assertListingResponseFits(taskId, outputDir, listing);
    assert.ok(guarded.truncated, "guarded listing must be marked truncated");
    assert.ok(guarded.files.length < listing.files.length, "guarded listing must have fewer files than the original");
    const guardedPayload = { taskId, outputDir, files: guarded.files, bytes: guarded.bytes, total: guarded.total, truncated: guarded.truncated };
    const guardedSize = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, guardedPayload)));
    assert.ok(guardedSize <= MAX_BUFFER_BYTES, `guarded listing must fit budget (got ${guardedSize} > ${MAX_BUFFER_BYTES})`);
  });

  test("plain taskferry output listing with control-character-heavy filenames is bounded to the response budget (integration)", async () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    const deepPrefix = Array.from({ length: 8 }, () => String.fromCharCode(1).repeat(100)).join("/");
    const deepDir = path.join(dispatched.outputDir, deepPrefix);
    fs.mkdirSync(deepDir, { recursive: true });
    for (let i = 0; i < 256; i++) {
      const name = String.fromCharCode(1).repeat(50) + `_${i}.txt`;
      fs.writeFileSync(path.join(deepDir, name), "x");
    }
    const fullListing = mgr.output(dispatched.id);
    // Must not throw generic fallback and must be bounded
    assert.ok(fullListing.truncated, "oversized listing must be truncated to the response budget");
    assert.ok(fullListing.files.length < 256, `expected fewer than 256 files after budget truncation, got ${fullListing.files.length}`);
    const payload = { taskId: dispatched.id, outputDir: dispatched.outputDir, files: fullListing.files, bytes: fullListing.bytes, total: fullListing.total, truncated: fullListing.truncated };
    const size = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, payload)));
    assert.ok(size <= MAX_BUFFER_BYTES, `guarded listing response must fit budget (got ${size} > ${MAX_BUFFER_BYTES})`);
    // Ensure file-read guard preserved: a heavy file still surfaces knob-specific error
    const heavy = String.fromCharCode(1).repeat(300 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "heavy2.bin"), heavy);
    assert.throws(
      () => mgr.output(dispatched.id, { path: "heavy2.bin", maxOutputFileBytes: 512 * 1024 }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /would exceed daemon response limit/);
        return true;
      },
    );
  });
});

describe("request-id overhead guard (taskferry#508 Luna re-review)", () => {
  test("BUDGET_CHECK_ID is 36 chars to match real UUID request ids", () => {
    assert.equal(BUDGET_CHECK_ID.length, 36, "guard must use 36-char placeholder, not 12-char budget-check");
    assert.match(BUDGET_CHECK_ID, /^[0-9a-f-]{36}$/i);
  });

  // eslint-disable-next-line sonarjs/cognitive-complexity, sonarjs/cyclomatic-complexity -- boundary probe needs loops to find 24-byte window where 12-char fits but 36-char overflows
  test("listing guard uses 36-char placeholder: near-boundary listing that fits with 12-char would overflow with real UUID and is truncated", () => {
    const OLD_ID = "budget-check";
    assert.equal(OLD_ID.length, 12);
    assert.equal(BUDGET_CHECK_ID.length, 36);
    const taskId = "oc_boundary_list";
    const outputDir = "/tmp/state/outputs/oc_boundary_list";
    let found = null;
    let baseCount = null;
    for (let n = 200; n <= 220; n++) {
      const files = [];
      for (let i = 0; i < n; i++) files.push({ path: String.fromCharCode(1).repeat(800) + `_${i}`, size: 10 });
      const listing = { files, bytes: files.reduce((s, f) => s + f.size, 0), total: files.length, truncated: false };
      const payload = { taskId, outputDir, files: listing.files, bytes: listing.bytes, total: listing.total, truncated: listing.truncated };
      const sizeOld = Buffer.byteLength(encodeMessage(successResponse(OLD_ID, payload)));
      if (sizeOld > MAX_BUFFER_BYTES) {
        baseCount = n - 1;
        break;
      }
    }
    if (baseCount === null) baseCount = 214;
    const baseFiles = [];
    for (let i = 0; i < baseCount; i++) baseFiles.push({ path: String.fromCharCode(1).repeat(800) + `_${i}`, size: 10 });
    // eslint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- need break on boundary and on overflow
    for (let extraLen = 0; extraLen <= 5000; extraLen++) {
      const files = extraLen === 0 ? baseFiles : [...baseFiles, { path: String.fromCharCode(1).repeat(extraLen), size: 10 }];
      if (files.length > 256) break;
      const listing = { files, bytes: files.reduce((s, f) => s + f.size, 0), total: files.length, truncated: false };
      const payload = { taskId, outputDir, files: listing.files, bytes: listing.bytes, total: listing.total, truncated: listing.truncated };
      const sizeOld = Buffer.byteLength(encodeMessage(successResponse(OLD_ID, payload)));
      const sizeReal = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, payload)));
      assert.equal(sizeReal - sizeOld, BUDGET_CHECK_ID.length - OLD_ID.length, "envelope overhead must be exactly id length difference");
      if (sizeOld <= MAX_BUFFER_BYTES && sizeReal > MAX_BUFFER_BYTES) {
        found = { listing, sizeOld, sizeReal, baseCount, extraLen };
        break;
      }
      if (sizeOld > MAX_BUFFER_BYTES && sizeReal > MAX_BUFFER_BYTES) break;
    }
    assert.ok(found, "must find near-boundary listing where 12-char fits but 36-char overflows");
    const guarded = assertListingResponseFits(taskId, outputDir, found.listing);
    assert.ok(guarded.truncated, "guarded listing must be truncated");
    assert.ok(guarded.files.length < found.listing.files.length, "guarded listing must have fewer files");
    const guardedPayload = { taskId, outputDir, files: guarded.files, bytes: guarded.bytes, total: guarded.total, truncated: guarded.truncated };
    const guardedRealSize = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, guardedPayload)));
    assert.ok(guardedRealSize <= MAX_BUFFER_BYTES, `guarded listing with real id must fit budget (got ${guardedRealSize} > ${MAX_BUFFER_BYTES})`);
    const realUuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(realUuid.length, 36);
    const guardedRealUuidSize = Buffer.byteLength(encodeMessage(successResponse(realUuid, guardedPayload)));
    assert.equal(guardedRealUuidSize, guardedRealSize, "BUDGET_CHECK_ID must be same length as real UUID");
    // Verify actual daemon would not fall through to generic RESPONSE_TOO_LARGE
    assert.ok(guardedRealUuidSize <= MAX_BUFFER_BYTES, "real daemon response must not exceed MAX_BUFFER after guard");
  });

  test("file guard uses 36-char placeholder: near-boundary file that fits with 12-char would overflow with real UUID and is rejected", () => {
    const OLD_ID = "budget-check";
    const taskId = "oc_boundary_file";
    const outputDir = "/tmp/state/outputs/oc_boundary_file";
    let found = null;
    for (let len = 172000; len < 176000; len += 10) {
      const content = String.fromCharCode(1).repeat(len);
      const file = { content, size: len, truncated: false };
      const payloadOld = { taskId, outputDir, file, files: [], bytes: 0, total: 0, truncated: false };
      const payloadReal = { taskId, outputDir, file, files: [], bytes: 0, total: 0, truncated: false };
      const sizeOld = Buffer.byteLength(encodeMessage(successResponse(OLD_ID, payloadOld)));
      const sizeReal = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, payloadReal)));
      if (sizeOld <= MAX_BUFFER_BYTES && sizeReal > MAX_BUFFER_BYTES) {
        found = { file, len, sizeOld, sizeReal };
        break;
      }
    }
    assert.ok(found, "must find near-boundary file where 12-char fits but 36-char overflows");
    assert.throws(
      () => assertOutputResponseFits(taskId, outputDir, found.file, "near-boundary.bin", 512 * 1024),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /would exceed daemon response limit/);
        assert.doesNotMatch(msg, /daemon response for this request exceeds/);
        return true;
      },
    );
    const smallFile = { content: "a".repeat(1000), size: 1000, truncated: false };
    assert.doesNotThrow(() => assertOutputResponseFits(taskId, outputDir, smallFile, "small.txt", 512 * 1024));
  });
});

describe("boot-time output sweep scales with orphan set, not all-time count (taskferry#513)", () => {
  test("expensive per-entry FS work (lstat + rm) scales with eligible orphans, not retained history", () => {
    // Direct unit test of sweepOrphanedOutputDirsFor with mocked expensive ops.
    // Simulates all-time history of 50 retained tasks plus 3 orphans; the
    // sweep should only stat/rm the 3 orphans, not all 53 entries. This is
    // the filter-then-process ordering mandated by CLAUDE.md ("Always filter,
    // then process") and fixed alongside #287's filteredTaskDetails.
    const keptIds = Array.from({ length: 50 }, (_, i) => `oc_kept_513_${i}_${process.pid}`);
    const orphanIds = [`oc_orphan_513_a_${process.pid}`, `oc_orphan_513_b_${process.pid}`, `oc_orphan_513_c_${process.pid}`];
    const allEntries = [...keptIds, ...orphanIds, ".", ".."];
    const tasks = new Map(keptIds.map((id) => [id, { id, status: "done" }]));
    const statCalls = [];
    const removeCalls = [];
    const readdirFn = () => allEntries;
    const lstatFn = (p) => {
      statCalls.push(path.basename(p));
      return { isDirectory: () => true, isSymbolicLink: () => false };
    };
    const removeDirFn = (p) => { removeCalls.push(path.basename(p)); };

    sweepOrphanedOutputDirsFor({
      OUTPUT_DIR_ROOT: "/tmp/fake-outputs-513",
      tasks,
      readdirFn,
      lstatFn,
      removeDirFn,
    });
    assert.equal(removeCalls.length, orphanIds.length, `removeDir should be called only for orphans (${orphanIds.length}), not for all ${keptIds.length} retained entries`);
    assert.deepEqual(removeCalls.sort(), orphanIds.sort(), "only orphan ids should be removed");
    assert.equal(statCalls.length, orphanIds.length, `lstat (expensive FS work) should be called only for orphans (${orphanIds.length}), not for all ${keptIds.length} retained entries`);
    assert.deepEqual(statCalls.sort(), orphanIds.sort(), "only orphan ids should be stated");
  });

  test("boot sweep via createTaskManager only deletes orphans and leaves many retained dirs intact (integration)", () => {
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR + "-513-scale-");
    const outputsRoot = path.join(stateDir, "outputs");
    fs.mkdirSync(outputsRoot, { recursive: true });
    const keptIds = Array.from({ length: 20 }, (_, i) => `oc_513_int_kept_${i}_${process.pid}_${Date.now()}`);
    const orphanIds = [`oc_513_int_orphan_a_${process.pid}`, `oc_513_int_orphan_b_${process.pid}`];
    for (const id of [...keptIds, ...orphanIds]) {
      const dir = path.join(outputsRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "file.txt"), "data");
    }
    // Seed tasks.json with only kept ids; orphans have no record.
    fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify(keptIds.map((id) => ({ id, status: "done" }))));

    const statCalls = [];
    const lstatFn = (p) => {
      if (typeof p === "string" && p.startsWith(outputsRoot)) statCalls.push(path.basename(p));
      return fs.lstatSync(p);
    };
    const mgr = trackManager(createTaskManager({
      stateDir,
      lstatFn,
      sandboxEnabled: false,
      spawnFn: () => fakeChild(),
      killFn: () => {},
    }));
    for (const id of keptIds) {
      assert.equal(fs.existsSync(path.join(outputsRoot, id)), true, `kept dir ${id} must survive boot sweep`);
    }
    for (const id of orphanIds) {
      assert.equal(fs.existsSync(path.join(outputsRoot, id)), false, `orphan dir ${id} must be swept`);
    }
    const orphanStats = statCalls.filter((b) => orphanIds.includes(b));
    const keptStats = statCalls.filter((b) => keptIds.includes(b));
    assert.equal(orphanStats.length, orphanIds.length, "stat should have run for each orphan");
    assert.equal(keptStats.length, 0, `expensive lstat must not run for retained history (${keptStats.length} unexpected calls for ${keptIds.length} kept entries); sweep must scale with orphan set, not all-time count`);
    mgr.close();
  });
});
