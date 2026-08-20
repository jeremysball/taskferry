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
import { TASKFERRY_OUTPUT_DIR_ENV, ensureTaskOutputDir, listTaskOutputFiles, readTaskOutputFile, resolveTaskOutputDir, resolveOutputDirRoot, resolveInsideDir } from "./output-dir.js";
import { createTaskManager } from "./tasks.js";

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
    fs.writeFileSync(path.join(dir, "keep.txt"), "k");

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
      if (p.endsWith("/keep.txt")) {
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
