import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManager, fakeChild, MINIMAX_MODEL, TEST_DEFAULT_MODEL, SOL_MODEL, OPENCODE_DATA, AXI_TASKS_CACHE_PI, NO_API_KEY_FOUND, mkdtempTracked, makeFakeExecutor, makeFakeOpencodeExecutor } from "./tasks.test-helpers.js";

const OPENCODE_JSONC = "opencode.jsonc";
const GITIGNORE = ".gitignore";
const PI_SESSION_ID = "019f90ea-1234-70e0-98dc-6847db316eb4";

describe("startTask() writes stdout through executor.normalizeLogEvent (Task 7: write-time normalization)", () => {
  test("JSON events flagged null by normalizeLogEvent are dropped; kept events are written canonicalized", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = makeFakeOpencodeExecutor({
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      normalizeLogEvent: (evt) => (evt.type === "drop-me" ? null : { ...evt, normalized: true }),
    });
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    child.stdout.emit("data", Buffer.from('{"type":"drop-me"}\n{"type":"keep-me"}\n'));
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(!contents.includes("drop-me"), "events normalizeLogEvent returned null for must not be written to the log");
    assert.ok(contents.includes('"keep-me"'));
    assert.ok(contents.includes('"normalized":true'));
  });

  test("non-JSON stdout lines (e.g. pi's plain-text auth failure) are preserved verbatim for classifyProviderFailure", () => {
    // Real pi auth-failure output is plain text on stdout (not stderr) and
    // exits 0 -- the only way classifyProviderFailure can see it is if
    // it's written to the canonical log file. startTask must therefore
    // forward every line that isn't parseable JSON verbatim, not drop it.
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    // normalizeLogEvent defaults to identity in makeFakeExecutor, so dropped
    // lines here mean JSON.parse failed.
    const fakeExecutor = makeFakeOpencodeExecutor({
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
    });
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    child.stdout.emit("data", Buffer.from(NO_API_KEY_FOUND + "\n"));
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(contents.includes(NO_API_KEY_FOUND));
  });

  test("a non-empty trailing partial line at process end is preserved verbatim (no terminating newline required)", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = makeFakeOpencodeExecutor({
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
    });
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    child.stdout.emit("data", Buffer.from("trailing non-json fragment with no newline"));
    child.stdout.emit("end");
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(contents.includes("trailing non-json fragment with no newline"));
  });
});

describe("startTask() spawns the executor's CLI binary, not a hardcoded command (Task 7: executor-driven binary)", () => {
  test("a pi dispatch spawns the `pi` binary, with args from executor.buildSpawnArgs", () => {
    let captured = null;
    const fakePi = makeFakeExecutor({
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
    });
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      defaultExecutor: fakePi,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(captured.cmd, "pi");
    assert.deepEqual(captured.args.slice(0, 5), ["--model", TEST_DEFAULT_MODEL, "--mode", "json", "-p"]);
    assert.ok(captured.args.at(-1).startsWith("hi\n\n## Persistent output dir"),
      `expected pi -p arg to carry scratch-dir tail, got: ${captured.args.at(-1)}`);
  });

  test("a default (pi) dispatch still spawns `pi`", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(captured.cmd, "pi");
  });
});

describe("startTask() scopes the opencode sandboxed data home per task (taskferry#501)", () => {
  test("opencode's sandboxEnv rewrites XDG_DATA_HOME to the task's own sandboxed cache data home (taskferry#501)", () => {
    let captured = null;
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    // Per-task data home: XDG_DATA_HOME points at <cacheDir>/opencode-data/
    // <taskId>, not a daemon-wide shared dir, so concurrent dispatches never
    // contend on one opencode.db (taskferry#501).
    assert.equal(captured.opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, dispatched.id));
  });

  test("two concurrent dispatches get distinct XDG_DATA_HOMEs (no shared opencode.db)", () => {
    const captured = [];
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-conc-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured.push({ cmd, args, opts }); return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });
    const first = mgr.dispatch({ prompt: "hi one", directory: os.tmpdir(), executor: "opencode" });
    const second = mgr.dispatch({ prompt: "hi two", directory: os.tmpdir(), executor: "opencode" });
    assert.equal(captured.length, 2);
    const dataHomeA = captured[0].opts.env.XDG_DATA_HOME;
    const dataHomeB = captured[1].opts.env.XDG_DATA_HOME;
    assert.equal(dataHomeA, path.join(cacheDir, OPENCODE_DATA, first.id));
    assert.equal(dataHomeB, path.join(cacheDir, OPENCODE_DATA, second.id));
    assert.notEqual(dataHomeA, dataHomeB, "concurrent dispatches must not share one XDG_DATA_HOME");
  });

  test("a session-resuming dispatch inherits the session owner's data home, so --continue finds the session rows created by the earlier task (taskferry#501)", () => {
    const captured = [];
    const children = [];
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-res-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => {
        const child = fakeChild();
        children.push(child);
        captured.push({ cmd, args, opts });
        return child;
      },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });
    // Task A creates session ses_shared (its sandboxed data home holds the
    // session rows).
    const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir(), executor: "opencode" });
    // Settle A with a session id in its log: startTask's exit handler stamps
    // it onto the in-memory task record, which is what a later
    // --session-id resume resolves the session owner from.
    const firstLog = path.join(mgr.paths.LOG_DIR, `${first.id}.ndjson`);
    fs.writeFileSync(firstLog, JSON.stringify({ sessionID: "ses_shared", type: "text", part: { messageID: "m1", text: "first answer" } }) + "\n");
    children[0].emit("exit", 0, null);

    // Task B resumes ses_shared with --session-id: its spawn must point
    // XDG_DATA_HOME at A's data home, not B's, or opencode's --continue
    // fails with "Session not found".
    const resumed = mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_shared", executor: "opencode" });
    assert.equal(captured.length, 2);
    assert.equal(captured[1].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, first.id));
    assert.notEqual(captured[1].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, resumed.id));
  });
});

describe("startTask(): data home scope follows the resumed session's owner task (taskferry#501)", () => {
  test("a session-resuming dispatch scopes XDG_DATA_HOME to the earliest task holding the session id, not the resuming task's own id", () => {
    const captured = [];
    const children = [];
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-owner-");
    const mgr = makeManager({
      cacheDir,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      maxDispatchesPerWindow: 100,
      spawnFn: (cmd, args, opts) => {
        const child = fakeChild();
        children.push(child);
        captured.push({ cmd, args, opts });
        return child;
      },
    });
    // Task A settles holding session ses_shared.
    const first = mgr.dispatch({ prompt: "first", directory: os.tmpdir(), executor: "opencode" });
    const firstLog = path.join(mgr.paths.LOG_DIR, `${first.id}.ndjson`);
    fs.writeFileSync(firstLog, JSON.stringify({ sessionID: "ses_shared", type: "text", part: { messageID: "m1", text: "first answer" } }) + "\n");
    children[0].emit("exit", 0, null);

    // Task B also settles holding the same session id (a daemon-restart
    // auto-resume in production would restamp it onto B's record too).
    const second = mgr.dispatch({ prompt: "second", directory: os.tmpdir(), sessionId: "ses_shared", executor: "opencode" });
    const secondLog = path.join(mgr.paths.LOG_DIR, `${second.id}.ndjson`);
    fs.writeFileSync(secondLog, JSON.stringify({ sessionID: "ses_shared", type: "text", part: { messageID: "m1", text: "second answer" } }) + "\n");
    children[1].emit("exit", 0, null);

    // Task C resumes the same session again: the scope must follow the
    // *earliest* holder (A) -- that is where opencode's session rows live.
    const resumed = mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), sessionId: "ses_shared", executor: "opencode" });
    assert.equal(captured.length, 3);
    assert.equal(captured[2].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, first.id));
    assert.notEqual(captured[2].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, second.id));
    assert.notEqual(captured[2].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, resumed.id));
  });

  test("an advisor continuation inherits the data home of the task holding the resumed session (the session owner)", async () => {
    const captured = [];
    const children = [];
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-adv-");
    const mgr = makeManager({
      cacheDir,
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      maxDispatchesPerWindow: 100,
      advisorSessionTtlMs: 60000,
      spawnFn: (cmd, args, opts) => {
        const child = fakeChild();
        children.push(child);
        captured.push({ cmd, args, opts });
        return child;
      },
    });

    // First advisor call establishes ses_live in the advisor-session
    // registry via its own settled result.
    const firstPromise = mgr.advisor({ prompt: "q1", directory: os.tmpdir(), executor: "opencode", model: SOL_MODEL });
    const firstRow = mgr.list().tasks[0];
    const firstTask = { id: firstRow.id, logPath: path.join(mgr.paths.LOG_DIR, `${firstRow.id}.ndjson`) };
    fs.writeFileSync(
      firstTask.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "answer one" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_live" }),
      ].join("\n")
    );
    children[0].emit("exit", 0, null);
    const first = await firstPromise;
    assert.equal(first.status, "done");
    assert.equal(captured[0].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, first.task_id));

    // Second call resumes ses_live: its spawn must scope XDG_DATA_HOME to
    // the session owner's (first) task id, not the continuation's own id,
    // or opencode's --continue fails with "Session not found".
    const secondPromise = mgr.advisor({
      prompt: "q2 follow-up",
      directory: os.tmpdir(),
      executor: "opencode",
      model: SOL_MODEL,
      sessionId: "ses_live",
    });
    const secondRow = mgr.list().tasks[1];
    const secondTask = { id: secondRow.id, logPath: path.join(mgr.paths.LOG_DIR, `${secondRow.id}.ndjson`) };
    fs.writeFileSync(
      secondTask.logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "answer two" } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
        JSON.stringify({ sessionID: "ses_live" }),
      ].join("\n")
    );
    children[1].emit("exit", 0, null);
    const second = await secondPromise;
    assert.equal(second.status, "done");
    assert.equal(captured[1].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, first.task_id));
    assert.notEqual(captured[1].opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA, second.task_id));
  });
});

// opencode creates its config dir on boot (writing .gitignore and a default
// opencode.jsonc into it). The sandbox binds the whole root read-only, so
// leaving XDG_CONFIG_HOME pointed at the real ~/.config made that boot write
// fail EROFS on any machine where opencode had never run before -- a fresh
// CI runner, or a new user's first dispatch. Redirect it into a per-task
// writeable dir under cacheDir (taskferry#536) so the boot write has
// somewhere to go.
describe("startTask() merges executor.sandboxAuthFile().sandboxEnv into spawnEnv (Task 7: per-executor env overrides)", () => {
  test("opencode's sandboxEnv redirects XDG_CONFIG_HOME to a per-task sibling of the data home (taskferry#536)", () => {
    let captured = null;
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-cfg-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const configHome = captured.opts.env.XDG_CONFIG_HOME;
    assert.equal(configHome, path.join(cacheDir, "opencode-config", dispatched.id));
    // Sibling of the data home, not nested: each has its own rw bind and
    // doesn't rely on the other's mount. And it must be under cacheDir
    // (real disk), not the tmpfs runtimeDir.
    const sandboxedDataHome = path.join(cacheDir, OPENCODE_DATA, dispatched.id);
    assert.notEqual(configHome, sandboxedDataHome);
    assert.ok(configHome.startsWith(cacheDir + path.sep));
    // XDG_STATE_HOME and XDG_CACHE_HOME are likewise per-task (taskferry#536)
    assert.equal(captured.opts.env.XDG_STATE_HOME, path.join(cacheDir, "opencode-state", dispatched.id));
    assert.equal(captured.opts.env.XDG_CACHE_HOME, path.join(cacheDir, "opencode-cache", dispatched.id));
  });

  test("opencode's real config entries are ro-bound into the sandboxed config home, except .gitignore", () => {
    let captured = null;
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-bind-");
    const homeDir = os.homedir();
    const realConfigDir = path.join(homeDir, ".config", "opencode");
    const realJsonc = path.join(realConfigDir, OPENCODE_JSONC);
    const realGitignore = path.join(realConfigDir, GITIGNORE);
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      existsFn: (p) => p === realConfigDir || p === realJsonc || p === realGitignore,
      readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, GITIGNORE] : []),
      lstatFn: () => ({ isSymbolicLink: () => false }),
      cacheDir,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const sandboxedConfigDir = path.join(cacheDir, "opencode-config", dispatched.id, "opencode");
    // The user's real config (custom providers live here) is still visible.
    const destIdx = captured.args.indexOf(path.join(sandboxedConfigDir, OPENCODE_JSONC));
    assert.notEqual(destIdx, -1, "expected the real opencode.jsonc to be ro-bound into the sandboxed config dir");
    assert.equal(captured.args[destIdx - 2], "--ro-bind");
    assert.equal(captured.args[destIdx - 1], realJsonc);
    // .gitignore is deliberately NOT bound: opencode rewrites it on boot, and
    // a read-only bind there would fail exactly the way the real path did.
    assert.equal(captured.args.indexOf(path.join(sandboxedConfigDir, GITIGNORE)), -1);
  });

  test("pi's sandboxEnv rewrites PI_CODING_AGENT_DIR, not XDG_DATA_HOME, and the auth bind destination matches", () => {
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_PI);
    const realAuthFile = path.join(os.tmpdir(), "fake-pi-home", "auth.json");
    const fakePi = makeFakeExecutor({
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      sandboxAuthFile: ({ dataDir, existsFn }) => {
        const sandboxedDataHome = path.join(dataDir, "pi-data");
        return {
          extraRoBinds: existsFn(realAuthFile) ? [/** @type {[string, string]} */ ([realAuthFile, path.join(sandboxedDataHome, "auth.json")])] : [],
          sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
          sandboxedDataHome,
        };
      },
    });
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      existsFn: (p) => p === realAuthFile,
      cacheDir,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // The pi binary was launched inside bwrap
    assert.equal(captured.cmd, "bwrap");
    // The args tail is `-- <binaryName> <buildSpawnArgs...>`. Find the
    // separator and the binary right after it.
    const separatorIdx = captured.args.lastIndexOf("--");
    assert.equal(captured.args[separatorIdx + 1], "pi");
    // PI_CODING_AGENT_DIR was overridden to the sandboxed data home.
    assert.equal(captured.opts.env.PI_CODING_AGENT_DIR, path.join(cacheDir, "pi-data"));
    // XDG_DATA_HOME was NOT rewritten for pi -- the opencode dispatcher
    // rewrites it; pi's executor returns a sandboxEnv that only sets
    // PI_CODING_AGENT_DIR. (Any pre-existing XDG_DATA_HOME from process.env
    // is preserved verbatim; we don't care whether the host had one.)
    assert.notEqual(captured.opts.env.XDG_DATA_HOME, path.join(cacheDir, "pi-data"));
    // The auth.json bind destination matches the override (pi-data/auth.json)
    const piDataAuth = path.join(cacheDir, "pi-data", "auth.json");
    const destIdx = captured.args.indexOf(piDataAuth);
    assert.notEqual(destIdx, -1, "expected the auth.json destination to match PI_CODING_AGENT_DIR");
    // The bwrap pattern is `--ro-bind <src> <dest>`, so --ro-bind sits two
    // positions before the destination (src is the one position before dest).
    assert.equal(captured.args[destIdx - 2], "--ro-bind");
    assert.equal(captured.args[destIdx - 1], realAuthFile);
  });

  test("a pi dispatch's sandboxAuthFile call is invoked with the dispatch's sessionId + launchDirectory, so the bind can scope to a single session file", () => {
    let capturedArgs = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_PI);
    const realAuthFile = path.join(os.tmpdir(), "fake-pi-home", "auth.json");
    const fakePi = makeFakeExecutor({
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      sandboxAuthFile: (args) => {
        capturedArgs = args;
        const sandboxedDataHome = path.join(args.dataDir, "pi-data");
        return {
          extraRoBinds: [],
          extraRwPairBinds: [],
          sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
          sandboxedDataHome,
        };
      },
    });
    const directory = os.tmpdir();
    const sessionId = PI_SESSION_ID;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      existsFn: (p) => p === realAuthFile,
      cacheDir,
    });
    const dispatched = mgr.dispatch({ directory, sessionId, prompt: "resume me", model: MINIMAX_MODEL });
    assert.notEqual(capturedArgs, null, "sandboxAuthFile must be invoked for a sandboxed dispatch");
    assert.equal(capturedArgs.sessionId, sessionId, "sandboxAuthFile must receive the dispatch's sessionId so the bind can scope to that single file");
    assert.equal(capturedArgs.launchDirectory, directory, "sandboxAuthFile must receive the dispatch's launchDirectory so it can compute pi's per-cwd sessions subdirectory");
    assert.equal(capturedArgs.taskId, dispatched.id, "sandboxAuthFile must receive the task's id so the data home can be scoped per task (taskferry#501)");
    assert.equal(typeof capturedArgs.statFn, "function", "sandboxAuthFile must receive a statFn (for the isDirectory guard)");
    assert.equal(typeof capturedArgs.lstatFn, "function", "sandboxAuthFile must receive a lstatFn (for the config-entry symlink guard)");
    assert.equal(typeof capturedArgs.readdirFn, "function", "sandboxAuthFile must receive a readdirFn (for the session file lookup)");
  });

  test("a fresh (non-resume) pi dispatch does not pass a sessionId to sandboxAuthFile, so no sessions bind is added", () => {
    let capturedArgs = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_PI);
    const fakePi = makeFakeExecutor({
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      sandboxAuthFile: (args) => {
        capturedArgs = args;
        return {
          extraRoBinds: [],
          extraRwPairBinds: [],
          sandboxedDataHome: path.join(args.dataDir, "pi-data"),
          sandboxEnv: { PI_CODING_AGENT_DIR: path.join(args.dataDir, "pi-data") },
        };
      },
    });
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      existsFn: () => false,
      cacheDir,
    });
    mgr.dispatch({ prompt: "fresh", directory: os.tmpdir() });
    assert.notEqual(capturedArgs, null);
    assert.equal(capturedArgs.sessionId, null, "no sessionId must be threaded for a fresh (non-resume) dispatch");
    // launchDirectory is still passed -- it's needed for the per-cwd encoding
    // even when there's no sessionId, in case the executor wants to use it
    // for diagnostics. The bind itself stays empty because there's no
    // sessionId to resolve a file for.
    assert.equal(typeof capturedArgs.launchDirectory, "string");
  });
});

describe("startTask() lstat-guards every executor bind source against symlink planting (issue #392)", () => {
  test("a pi dispatch skips the auth.json ro-bind when the host auth.json is a symlink", () => {
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_PI);
    const realAuthFile = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      // existsFn lies and says auth.json exists; lstatFn reveals it is a
      // planted symlink. The executor must not ro-bind it into the sandbox.
      existsFn: (p) => p === realAuthFile,
      lstatFn: (p) => ({ isSymbolicLink: () => p === realAuthFile }),
      cacheDir,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(captured.cmd, "bwrap");
    assert.equal(captured.args.indexOf(realAuthFile), -1, "the symlinked auth.json must not reach the bwrap argv");
    assert.equal(captured.args.indexOf(path.join(cacheDir, "pi-data", "auth.json")), -1);
  });

  test("an opencode dispatch binds no config entries when the real config dir itself is a symlink", () => {
    let captured = null;
    const cacheDir = mkdtempTracked("axi-tasks-cache-oc-symlink-dir-");
    const realConfigDir = path.join(os.homedir(), ".config", "opencode");
    const realJsonc = path.join(realConfigDir, OPENCODE_JSONC);
    const readdirCalls = [];
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      existsFn: (p) => p === realConfigDir,
      readdirFn: (p) => { readdirCalls.push(p); return [OPENCODE_JSONC]; },
      // The config dir itself is a symlink: existsFn/readdirFn follow it, so
      // every entry inside would pass the per-entry guard. The dir-level
      // lstat check must skip the whole loop instead.
      lstatFn: (p) => ({ isSymbolicLink: () => p === realConfigDir }),
      cacheDir,
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    assert.equal(captured.cmd, "bwrap");
    assert.equal(captured.args.indexOf(realJsonc), -1, "no config-entry bind may exist when the config dir is a symlink");
    // (Construction itself readdirs the overlay tmp root; filter to the
    // config dir to prove the guarded loop never ran.)
    const configDirReaddirCalls = readdirCalls.filter((p) => p === realConfigDir);
    assert.deepEqual(configDirReaddirCalls, [], "readdirFn must not be called on a symlinked config dir");
  });

  test("a pi dispatch skips the resumed-session --bind when the session file is a symlink", () => {
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_PI);
    const realSessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
    const safePath = `--${os.tmpdir().replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const realSafePathDir = path.join(realSessionsDir, safePath);
    const realSessionFile = path.join(realSafePathDir, "2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      existsFn: () => true,
      statFn: (p) => (p === realSessionsDir ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === realSafePathDir ? [path.basename(realSessionFile)] : []),
      // The matched session file is a symlink; the resume bind is read-write,
      // so binding it would hand the worker write access to the link target.
      lstatFn: (p) => ({ isSymbolicLink: () => p === realSessionFile }),
      cacheDir,
    });
    mgr.dispatch({ prompt: "resume", directory: os.tmpdir(), model: MINIMAX_MODEL, sessionId: PI_SESSION_ID });
    assert.equal(captured.cmd, "bwrap");
    assert.equal(captured.args.indexOf(realSessionFile), -1, "a symlinked session file must not be bound read-write");
  });
});

describe("startTask() resolves the resumed session file via Array.find (no break/continue loop)", () => {
  test("the pi sandboxAuthFile call does not add the whole sessions/ pair-bind on the dispatch path -- only the resumed file's bind (regression: scope regression vs. shadowed sandboxed-only sessions)", () => {
    // Earlier round-2 review surfaced a security scope regression: pi's
    // sandboxAuthFile was binding the ENTIRE real sessions/ directory
    // read-write, which let a prompt-injectable sandboxed worker
    // write/delete any session in the user's pi history. After this fix,
    // only the resumed session's specific file is bound. Verify that
    // the bwrap invocation no longer contains a pair-bind of the whole
    // realSessionsDir, even when pi's own sandboxAuthFile decides to
    // bind a single file.
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_PI);
    const realSessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
    const realSessionFile = path.join(realSessionsDir, "--tmp--", "2026-07-23T21-42-41-761Z_019f90ea-1234-70e0-98dc-6847db316eb4.jsonl");
    const realAuthFile = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const fakePi = makeFakeExecutor({
      buildSpawnArgs: (ctx) => ["--model", ctx.model, "--mode", "json", "-p", ctx.prompt],
      sandboxAuthFile: ({ dataDir, existsFn, statFn, readdirFn, sessionId, launchDirectory }) => {
        const sandboxedDataHome = path.join(dataDir, "pi-data");
        const sandboxedSessionsHome = path.join(sandboxedDataHome, "sessions");
        const extraRwPairBinds = [];
        if (sessionId && launchDirectory && existsFn(realSessionsDir) && statFn(realSessionsDir)?.isDirectory()) {
          const safePath = `--${launchDirectory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
          const subdir = path.join(realSessionsDir, safePath);
          const entries = readdirFn(subdir);
          // Scan with Array.find so the loop never needs break/continue --
          // sonarjs/too-many-break-or-continue-in-loop flags two continues +
          // one break in the old imperative version as three control-flow
          // jumps in one body. .find() returns the first match (or
          // undefined) without any early-exit statements.
          const matchingEntry = entries.find((entry) => {
            if (!entry.endsWith(".jsonl")) return false;
            const underscoreIdx = entry.lastIndexOf("_");
            if (underscoreIdx === -1) return false;
            const fileSessionId = entry.slice(underscoreIdx + 1, -".jsonl".length);
            return fileSessionId.startsWith(sessionId);
          });
          if (matchingEntry) {
            extraRwPairBinds.push([path.join(subdir, matchingEntry), path.join(sandboxedSessionsHome, safePath, matchingEntry)]);
          }
        }
        return {
          extraRoBinds: existsFn(realAuthFile) ? [[realAuthFile, path.join(sandboxedDataHome, "auth.json")]] : [],
          sandboxEnv: { PI_CODING_AGENT_DIR: sandboxedDataHome },
          extraRwPairBinds,
          sandboxedDataHome,
        };
      },
    });
    const directory = os.tmpdir();
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      defaultExecutor: fakePi,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      // Pretend the host has both a sessions/ dir and the specific file.
      existsFn: (p) => p === realSessionsDir || p === realAuthFile,
      statFn: (p) => (p === realSessionsDir ? { isDirectory: () => true } : null),
      readdirFn: (p) => (p === path.join(realSessionsDir, "--tmp--") ? [path.basename(realSessionFile)] : []),
      cacheDir,
    });
    mgr.dispatch({ prompt: "resume", model: MINIMAX_MODEL, sessionId: PI_SESSION_ID, directory });
    assert.equal(captured.cmd, "bwrap");
    // Look for a --bind whose src is the whole realSessionsDir (not the
    // single file). Pre-fix this would appear; post-fix it must not.
    const pairBindSrcs = [];
    for (let i = 0; i < captured.args.length; i++) {
      if (captured.args[i] === "--bind" && captured.args[i + 1] && captured.args[i + 2]) {
        pairBindSrcs.push(captured.args[i + 1]);
      }
    }
    assert.ok(!pairBindSrcs.includes(realSessionsDir), `the whole sessions directory must not be pair-bound (would re-introduce the scope regression). Saw: ${pairBindSrcs.join(", ")}`);
    // The specific session file IS bound, mapped onto the matching path
    // under the sandboxed sessions tree.
    const fileBindSrcs = pairBindSrcs.filter((p) => p === realSessionFile);
    assert.equal(fileBindSrcs.length, 1, `expected exactly one --bind of the single session file, got ${fileBindSrcs.length} (all pair-bind srcs: ${pairBindSrcs.join(", ")})`);
  });
});

describe("startTask() never lets normalizeLogEvent() throws escape the stdout handler (Task 7 review fix)", () => {
  // The narrow helper used for both the inline and trailing-fragment paths
  // must catch any throw from executor.normalizeLogEvent(parsed), write a
  // canonical structured error event to the log file, and return -- the
  // EventEmitter callback must never propagate the throw up to Node, which
  // would otherwise unhandle it, crash the daemon, and orphan the child.
  // The daemon must not silently continue as if the malformed event had
  // been normalized successfully: a structured error event is observable
  // through classifyProviderFailure so the task settles with a real
  // failureReason, not an unclassified "crashed".
  test("a throwing normalizeLogEvent on the inline path does not crash out of the stdout handler", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = makeFakeOpencodeExecutor({
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      normalizeLogEvent: () => { throw new Error("boom from inside normalizeLogEvent"); },
    });
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    // If the throw escapes the EventEmitter callback, the synchronous emit
    // surfaces it as an unhandled exception (and crashes the test process).
    // assert.doesNotThrow proves the callback swallowed the throw.
    assert.doesNotThrow(() => {
      child.stdout.emit("data", Buffer.from('{"type":"event"}\n'));
    });
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    // The structured error event reached the log with the executor prefix,
    // so classifyProviderFailure can see it on the trailing-log path.
    assert.ok(contents.includes('"name":"ExecutorNormalizationError"'), "structured ExecutorNormalizationError event must be in the log");
    assert.ok(contents.includes("boom from inside normalizeLogEvent"), "thrown message must be preserved for diagnosis");
  });

  test("a throwing normalizeLogEvent on the trailing-fragment path is also caught", () => {
    const child = fakeChild();
    const spawnFn = mock.fn(() => child);
    const fakeExecutor = makeFakeOpencodeExecutor({
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      normalizeLogEvent: () => { throw new Error("trailing throw"); },
    });
    const mgr = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: process.cwd() });
    const logPath = mgr.status(dispatched.id).logPath;
    // Trailing JSON fragment (no terminating newline) -- exercises the
    // .on("end", ...) path. The trailing fragment and inline path share
    // one normalization helper, but the trailing branch is its own
    // emit call site, so it's covered explicitly.
    child.stdout.emit("data", Buffer.from('{"type":"trailing-event"}'));
    assert.doesNotThrow(() => {
      child.stdout.emit("end");
    });
    child.emit("exit", 0, null);
    const contents = fs.readFileSync(logPath, "utf8");
    assert.ok(contents.includes('"name":"ExecutorNormalizationError"'), "trailing-fragment path must also write the structured error event");
    assert.ok(contents.includes("trailing throw"), "thrown message must reach the log from the trailing path");
  });

  test("a task that emits only a normalizing-throw event settles with an executor-prefixed structured failure reason", async () => {
    // End-to-end check: a real executor whose normalizeLogEvent throws on
    // every event must not leave the task unclassified. The structured
    // error event written by the handler carries an unknown error class
    // name (`ExecutorNormalizationError`) which routes through the
    // structured-error fallthrough in classifyProviderFailure, producing
    // an executor-prefixed bucket.
    const child = fakeChild(9610);
    const fakeExecutor = makeFakeOpencodeExecutor({
      buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
      normalizeLogEvent: () => { throw new Error("always throws"); },
    });
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      defaultExecutor: fakeExecutor,
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    child.stdout.emit("data", Buffer.from('{"type":"event"}\n'));
    child.emit("exit", 0, null);
    // The watcher is async -- give classifyProviderFailure a chance to
    // scan the trailing log and set failureReason before we assert.
    await new Promise((r) => setTimeout(r, 40));
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "opencode_executornormalizationerror");
    assert.ok(s.failureDetail?.includes("always throws"), "failureDetail must carry the original thrown message for diagnosis");
  });
});
