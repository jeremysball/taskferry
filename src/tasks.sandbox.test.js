import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeManager, fakeChild, baseTask, AXI_GIT_COMMON_DIR, AXI_ALLOWED_DIR, AXI_TASKS_CACHE_DIR, OPENCODE_DATA, INVESTIGATED_TEXT, SOURCE_LOG, OVERLAY_SRC, SOL_MODEL, MIMIMAX_MODEL, mkdtempTracked } from "./tasks.test-helpers.js";

describe("bwrap sandboxing: dispatch argv shape and gitdir scoping", () => {
  test("wraps the spawn command in bwrap when sandboxing is enabled and available", () => {
    let captured = null;
    const runtimeDir = path.join(os.tmpdir(), "axi-tasks-runtime");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      runtimeDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: "opencode-go/minimax-m3", variant: "max", executor: "opencode" });

    assert.equal(captured.cmd, "bwrap");
    assert.deepEqual(captured.args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.deepEqual(captured.args.slice(3, 9), ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
    assert.ok(captured.args.includes(mgr.paths.STATE_DIR));
    const bindIndex = captured.args.indexOf("--bind");
    assert.equal(captured.args[bindIndex + 1], os.tmpdir());
    // The daemon socket is bound at its own path; the whole runtimeDir is not
    // (the #453/#455 fix -- sibling overlays and other tasks' state under
    // runtimeDir are no longer reachable).
    assert.ok(captured.args.includes(path.join(runtimeDir, "daemon.sock")));
    assert.ok(!captured.args.includes(runtimeDir));
    assert.deepEqual(captured.args.slice(-14).slice(0, 13), [
      "--", "opencode", "run", "--dir", os.tmpdir(), "--auto", "--format", "json",
      "-m", "opencode-go/minimax-m3", "--variant", "max", "--",
    ]);
    assert.ok(captured.args.at(-1).startsWith("hello\n\n## Persistent output dir"),
      `expected prompt to be augmented with the scratch-dir block, got: ${captured.args.at(-1)}`);
    // taskferry#423: the per-task scratch dir is rw-bound inside the sandbox
    // at the same path. There must be at least one --bind whose src and dst
    // both live under <stateDir>/outputs/.
    const outputsRoot = path.join(mgr.paths.STATE_DIR, "outputs");
    let outputBindFound = false;
    for (let i = 0; i + 2 < captured.args.length; i++) {
      const src = captured.args[i + 1];
      const dst = captured.args[i + 2];
      if (captured.args[i] === "--bind" && src === dst && src.startsWith(outputsRoot + path.sep)) {
        outputBindFound = true;
        break;
      }
    }
    assert.ok(outputBindFound, `expected an rw-bind for a path under ${outputsRoot} in argv: ${JSON.stringify(captured.args)}`);
    assert.equal(captured.opts.cwd, os.tmpdir());
  });

  test("snapshots the fallback git-common-dir bind when gitDir resolves to the common dir", () => {
    let captured = null;
    const directory = mkdtempTracked("axi-worktree-dir-");
    const gitCommonDir = mkdtempTracked(AXI_GIT_COMMON_DIR);
    fs.writeFileSync(path.join(gitCommonDir, "HEAD"), "ref: refs/heads/main\n");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitCommonDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindIndex = captured.args.findIndex((arg, index) => arg === "--bind" && captured.args[index + 2] === gitCommonDir);
    assert.notEqual(bindIndex, -1);
    assert.notEqual(captured.args[bindIndex + 1], gitCommonDir, "fallback must bind a scratch snapshot, not the live common dir");
    assert.equal(fs.readFileSync(path.join(captured.args[bindIndex + 1], "HEAD"), "utf8"), "ref: refs/heads/main\n");
  });

  test("does not add a redundant bind when the resolved git-common-dir is already inside the dispatch directory", () => {
    let captured = null;
    const directory = os.tmpdir();
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => path.join(directory, ".git"),
      // Independent of whatever real ~/.pi files happen to exist on the
      // machine running this test -- a real sessions/ dir there would
      // otherwise add a 4th --bind (the rw sessions pair-bind) and make
      // this count flaky across environments.
      existsFn: () => false,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindCount = captured.args.filter((arg) => arg === "--bind").length;
    // directory + runtimeDir + the sandboxed opencode data home + the per-task
    // scratch dir (taskferry#423) -- the git-common-dir sits inside `directory`,
    // already covered by that one bind.
    assert.equal(bindCount, 4);
  });

  test("snapshots the whole common dir for a submodule layout, where gitDir resolves to the same path as gitCommonDir", () => {
    let captured = null;
    const directory = mkdtempTracked("axi-submodule-dir-");
    const gitCommonDir = mkdtempTracked(AXI_GIT_COMMON_DIR);
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitCommonDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindIndex = captured.args.findIndex((arg, index) => arg === "--bind" && captured.args[index + 2] === gitCommonDir);
    assert.notEqual(bindIndex, -1);
    assert.notEqual(captured.args[bindIndex + 1], gitCommonDir);
  });

  test("snapshots the whole common dir when gitDir resolution fails outright", () => {
    let captured = null;
    const directory = mkdtempTracked("axi-resolve-fail-dir-");
    const gitCommonDir = mkdtempTracked(AXI_GIT_COMMON_DIR);
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => null,
    });

    mgr.dispatch({ prompt: "hello", directory });

    const bindIndex = captured.args.findIndex((arg, index) => arg === "--bind" && captured.args[index + 2] === gitCommonDir);
    assert.notEqual(bindIndex, -1);
    assert.notEqual(captured.args[bindIndex + 1], gitCommonDir);
  });

  test("snapshots only the private gitDir, never the whole common dir, in the no-overlay path", () => {
    let captured = null;
    const directory = mkdtempTracked("axi-separate-gitdir-dir-");
    const gitCommonDir = mkdtempTracked(AXI_GIT_COMMON_DIR);
    // A gitDir that lives entirely outside gitCommonDir's own tree (e.g. a
    // manually re-pointed `gitdir:`/`commondir` file) -- the earlier version
    // of this fix fell through to binding the whole common dir for this
    // case, re-admitting taskferry#224's exposure. It must not do that.
    const gitDir = mkdtempTracked("axi-elsewhere-gitdir-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    mgr.dispatch({ directory, prompt: "hello", noOverlay: true });

    const boundDestinations = [];
    for (let i = 0; i < captured.args.length - 1; i++) {
      if (captured.args[i] === "--bind") {
        boundDestinations.push(captured.args[i + 2]);
      }
    }
    assert.ok(boundDestinations.includes(gitDir), "should bind the resolved private gitdir");
    assert.equal(boundDestinations.includes(gitCommonDir), false, "must never bind the whole common dir once a distinct gitDir was resolved");
    const gitDirBindIndex = captured.args.findIndex((arg, index) => arg === "--bind" && captured.args[index + 2] === gitDir);
    assert.notEqual(gitDirBindIndex, -1, "the private gitDir must still be mounted into the sandbox");
    assert.notEqual(captured.args[gitDirBindIndex + 1], gitDir, "--no-overlay must use a scratch snapshot for the private gitDir");
  });

  test("scopes the git-common-dir bind to the worktree's own admin dir + shared objects/refs, never the main checkout's private HEAD/index/config (regression for taskferry#224)", () => {
    const root = mkdtempTracked("axi-git-repo-");
    const mainCheckout = path.join(root, "main");
    fs.mkdirSync(mainCheckout);
    const git = (args) => execFileSync("git", args, { cwd: mainCheckout, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "a@b.com"]);
    git(["config", "user.name", "test"]);
    fs.writeFileSync(path.join(mainCheckout, "f.txt"), "hi\n");
    git(["add", "f.txt"]);
    git(["commit", "-q", "-m", "init"]);
    git(["branch", "feature"]);
    const worktreeDir = path.join(root, "wt");
    git(["worktree", "add", "-q", worktreeDir, "feature"]);

    let captured = null;
    // No resolveGitCommonDirFn/resolveGitDirFn override -- exercises the
    // real `git rev-parse` calls against the worktree above, not a mock.
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: worktreeDir });

    const boundPaths = [];
    const boundDestinations = [];
    for (let i = 0; i < captured.args.length - 1; i++) {
      if (captured.args[i] === "--bind") {
        boundPaths.push(captured.args[i + 1]);
        boundDestinations.push(captured.args[i + 2]);
      }
    }
    const mainGitDir = path.join(mainCheckout, ".git");
    const worktreeGitDir = path.join(mainGitDir, "worktrees", "wt");

    assert.ok(boundDestinations.includes(worktreeGitDir), "should bind the worktree's own private gitdir");
    assert.ok(boundPaths.includes(path.join(mainGitDir, "objects")), "should bind shared objects");
    assert.ok(boundPaths.includes(path.join(mainGitDir, "refs")), "should bind shared refs");

    // The main checkout's own private admin files must never be writable
    // from a dispatch that never named that checkout at all.
    assert.equal(boundPaths.includes(mainGitDir), false, "must not bind the whole common dir");
    assert.equal(boundPaths.includes(path.join(mainGitDir, "HEAD")), false);
    assert.equal(boundPaths.includes(path.join(mainGitDir, "index")), false);
    assert.equal(boundPaths.includes(path.join(mainGitDir, "config")), false);
  });
});

describe("bwrap sandboxing: allowedDirs and denylist", () => {
  test("binds the manager-level allowedDirs config default read-write", () => {
    let captured = null;
    const allowed = mkdtempTracked(AXI_ALLOWED_DIR);
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => null,
      allowedDirs: [allowed],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    const bindIndex = captured.args.indexOf(allowed);
    assert.notEqual(bindIndex, -1);
    assert.equal(captured.args[bindIndex - 1], "--bind");
  });

  test("binds a per-dispatch --allowed-dirs entry read-write, in addition to the manager-level default", () => {
    let captured = null;
    const managerDefault = mkdtempTracked(AXI_ALLOWED_DIR);
    const perDispatch = mkdtempTracked(AXI_ALLOWED_DIR);
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => null,
      allowedDirs: [managerDefault],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), allowedDirs: [perDispatch] });

    const managerBindIndex = captured.args.indexOf(managerDefault);
    assert.notEqual(managerBindIndex, -1);
    assert.equal(captured.args[managerBindIndex - 1], "--bind");

    const perDispatchBindIndex = captured.args.indexOf(perDispatch);
    assert.notEqual(perDispatchBindIndex, -1);
    assert.equal(captured.args[perDispatchBindIndex - 1], "--bind");
  });

  test("silently skips an allowedDirs entry that doesn't exist on disk", () => {
    let captured = null;
    const missing = path.join(os.tmpdir(), "axi-allowed-dir-does-not-exist");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => null,
      allowedDirs: [missing],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.args.includes(missing), false);
  });

  test("drops deny-list paths that don't exist on disk, since bwrap's --tmpfs fails on a missing mount point", () => {
    let captured = null;
    const missing = path.join(os.homedir(), ".aws");
    const present = path.join(os.homedir(), ".ssh");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: (p) => p !== missing,
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.args.includes(missing), false);
    assert.equal(captured.args.includes(present), true);
  });

  test("tmpfs-masks a configured sandboxDenylist entry in addition to the fixed default deny-list", () => {
    let captured = null;
    const extra = mkdtempTracked("axi-sandbox-denylist-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      // Fixed-default entries (~/.ssh, ~/.claude) are asserted below as
      // present alongside the configured extra -- stub existsFn so that
      // assertion doesn't depend on this host's actual home directory
      // contents (a clean CI runner has neither), same pattern as the
      // sibling "drops deny-list paths that don't exist on disk" test above.
      existsFn: () => true,
      platform: "linux",
      sandboxDenylist: [extra],
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    const extraIndex = captured.args.indexOf(extra);
    assert.notEqual(extraIndex, -1, "expected the configured extra path to be tmpfs-denied");
    assert.equal(captured.args[extraIndex - 1], "--tmpfs");
    // The fixed defaults are still applied alongside the configured extra.
    assert.ok(captured.args.includes(path.join(os.homedir(), ".ssh")));
    assert.ok(captured.args.includes(path.join(os.homedir(), ".claude")));
  });
});

describe("bwrap sandboxing: opencode auth and data home", () => {
  test("points XDG_DATA_HOME at a writable spot under cacheDir when sandboxing, so opencode's own log/session db isn't blocked by the read-only root", () => {
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      cacheDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.opts.env.XDG_DATA_HOME, path.join(cacheDir, OPENCODE_DATA));
  });

  test("ro-binds the real opencode auth.json into the sandboxed XDG_DATA_HOME when it exists, so credentialed providers still resolve", () => {
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const realAuthFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: (p) => p === realAuthFile,
      lstatFn: (p) => {
        if (p !== realAuthFile) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
      },
      platform: "linux",
      cacheDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    const srcIndex = captured.args.indexOf(realAuthFile);
    assert.notEqual(srcIndex, -1);
    assert.equal(captured.args[srcIndex - 1], "--ro-bind");
    assert.equal(captured.args[srcIndex + 1], path.join(cacheDir, OPENCODE_DATA, "opencode", "auth.json"));
  });

  test("--rw-bind at the real auth.json path promotes the credential bind to read-write instead of dropping it", () => {
    let captured = null;
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const realAuthFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: (p) => p === realAuthFile,
      lstatFn: (p) => {
        if (p !== realAuthFile) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
      },
      platform: "linux",
      cacheDir,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode", allowedDirs: [realAuthFile] });

    // The pair must still reach the sandbox -- as a --bind (rw) pair with the
    // same source/dest the ro-bind would have used -- not vanish because the
    // user's --rw-bind collided with the executor's own credential path.
    // (A separate, redundant same-path --bind for realAuthFile also appears,
    // from the plain --rw-bind same-path rw bind -- that's expected and
    // harmless; find the specific promoted pair by its distinct dest.)
    const expectedDest = path.join(cacheDir, OPENCODE_DATA, "opencode", "auth.json");
    const pairIndex = captured.args.findIndex(
      (arg, i) => arg === "--bind" && captured.args[i + 1] === realAuthFile && captured.args[i + 2] === expectedDest,
    );
    assert.notEqual(pairIndex, -1, `auth.json bind pair missing entirely after --rw-bind collision: ${JSON.stringify(captured.args)}`);
  });

  test("omits the auth.json ro-bind when the real file doesn't exist on disk", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      existsFn: () => false,
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    // "--ro-bind" still appears once, for the base "/" root bind — the extra
    // auth.json ro-bind (destination ".../opencode-data/opencode/auth.json")
    // is absent, even though the data home itself is still read-write bound.
    assert.equal(captured.args.some((arg) => typeof arg === "string" && arg.includes(path.join(OPENCODE_DATA, "opencode", "auth.json"))), false);
  });

  test("leaves XDG_DATA_HOME untouched when sandboxing is disabled", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: false,
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    assert.equal(captured.opts.env.XDG_DATA_HOME, undefined);
  });
});

describe("bwrap sandboxing: platform and availability gating", () => {
  test("falls through to the unwrapped opencode command when --no-sandbox is set on a dispatch", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called when --no-sandbox is set"); },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), noSandbox: true, executor: "opencode" });

    assert.equal(captured.cmd, "opencode");
  });

  test("falls through to the unwrapped opencode command when sandboxEnabled is false", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: false,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called when sandboxEnabled is false"); },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.cmd, "opencode");
  });

  test("falls through to the unwrapped opencode command on a non-Linux platform without probing bwrap", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { throw new Error("checkBwrapAvailableFn should not be called on a non-Linux platform"); },
      platform: "darwin",
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.cmd, "opencode");
  });

  test("crashes the task with a matching spawnError when bwrap is required but unavailable", () => {
    const mgr = makeManager({
      spawnFn: () => { throw new Error("spawnFn should not be called when bwrap is unavailable"); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: false, reason: "bwrap not found" }),
      platform: "linux",
    });

    const dispatched = mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const status = mgr.status(dispatched.id);

    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /bwrap is required for sandboxing but was not found/);
  });

  test("checks bwrap availability only once across multiple dispatches", () => {
    let calls = 0;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => { calls++; return { checked: true, available: true }; },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "two", directory: os.tmpdir() });

    assert.equal(calls, 1);
  });
});

describe("bwrap sandboxing: prompt and summary launches under bwrap", () => {
  test("ro-binds PROMPT_DIR when an oversized prompt is attached inside the sandbox", () => {
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    const prompt = "x".repeat(96 * 1024 + 1);

    mgr.dispatch({ prompt, directory: os.tmpdir(), executor: "opencode" });

    assert.equal(captured.cmd, "bwrap");
    const attachment = captured.args[captured.args.indexOf("-f") + 1];
    const promptDir = path.join(mgr.paths.STATE_DIR, "prompts");
    assert.equal(path.dirname(attachment), promptDir);
    const promptBindIndex = captured.args.findIndex(
      (arg, index) => arg === "--ro-bind"
        && captured.args[index + 1] === promptDir
        && captured.args[index + 2] === promptDir
    );
    assert.notEqual(promptBindIndex, -1, "expected PROMPT_DIR to be restored read-only after stateDir is masked");
  });

  test("wraps a summary launch's spawn in bwrap too, binding SUMMARY_DIR", async () => {
    let captured;
    const child = fakeChild();
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: INVESTIGATED_TEXT } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, SOURCE_LOG) })],
      logs: { [SOURCE_LOG]: log },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      spawnFn: (command, args, options) => { captured = { command, args, options }; return child; },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal(captured.command, "bwrap");
    assert.equal(captured.options.cwd, mgr.paths.SUMMARY_DIR);
    const bindIndex = captured.args.indexOf("--bind");
    assert.equal(captured.args[bindIndex + 1], mgr.paths.SUMMARY_DIR);
    assert.equal(captured.args.includes("--agent"), false);

    child.emit("exit", 0, null);
  });
});

describe("bwrap sandboxing: overlay mount and probe gating", () => {
  test("mounts an overlay on the target directory when overlayEnabled and the host supports it", () => {
    let captured = null;
    const directory = mkdtempTracked("axi-overlay-dir-");
    const overlayTmpRoot = mkdtempTracked("axi-overlay-tmp-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    assert.ok(captured.args.includes(OVERLAY_SRC));
    const overlayIndex = captured.args.indexOf(OVERLAY_SRC);
    assert.equal(captured.args[overlayIndex + 1], directory);
    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.ok(status.overlayDirs.upperDir.startsWith(overlayTmpRoot));
    assert.equal(status.overlayDirs.tmpRoot, overlayTmpRoot);
  });

  test("resolvePreDispatchHead is invoked through the injected runOverlayCommandFn delegate, not via a direct subprocess", () => {
    // The pre-dispatch HEAD probe used to be a direct call into the
    // changeset.js default runner, side-stepping the runOverlayCommandFn
    // delegate every other git/command invocation in this module goes
    // through. Fake it out and assert the probe is observably routed through
    // the injected delegate (and the captured HEAD lands on the task).
    const overlayTmpRoot = mkdtempTracked("axi-pre-dispatch-head-tmp-");
    const preDispatchCalls = [];
    const FAKE_HEAD = "0123456789abcdef0123456789abcdef01234567";
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: (command, args) => {
        preDispatchCalls.push({ command, args });
        // Only the pre-dispatch HEAD probe runs here (the child never
        // exits, so there's no extraction bwrap call). Return a fake HEAD
        // for the first probe + a git-dir for the fallback to land on the
        // git target path.
        if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
          return { status: 0, stdout: `${FAKE_HEAD}\n`, stderr: "" };
        }
        if (command === "git" && args.includes("--git-dir")) {
          return { status: 0, stdout: ".git\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      overlayTmpRoot,
    });

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });

    // The probe must be observable through the injected delegate, not a
    // real subprocess. The directory argument has to be threaded through too,
    // so the bwrap/git probe targets the dispatch's launch directory.
    const headProbe = preDispatchCalls.find((c) => c.command === "git" && c.args.includes("HEAD"));
    assert.ok(headProbe, "resolvePreDispatchHead must go through runOverlayCommandFn");
    assert.equal(headProbe.args[0], "-C");
    assert.equal(headProbe.args[1], os.tmpdir());
    // The probe went through the delegate: the dispatch landed on a git
    // target rather than a non-git one (otherwise the --git-dir fallback
    // probe would have returned the empty-tree sentinel and the task would
    // have been a git target via a different code path -- the existence of
    // the HEAD probe alone is what we're checking here).
    assert.ok(preDispatchCalls.some((c) => c.command === "git" && c.args.includes("HEAD")));
  });

  test("falls back to a plain bind with a warning when overlayEnabled is explicitly false", () => {
    let captured = null;
    let warned = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warned += chunk; return true; };
    try {
      const directory = mkdtempTracked("axi-no-overlay-dir-");
      const mgr = makeManager({
        spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
        sandboxEnabled: true,
        checkBwrapAvailableFn: () => ({ checked: true, available: true }),
        overlayEnabled: false,
        platform: "linux",
      });
      const result = mgr.dispatch({ prompt: "hello", directory });
      assert.equal(captured.args.includes(OVERLAY_SRC), false);
      assert.equal("changesetStatus" in mgr.status(result.id), false);
      assert.match(warned, /overlay disabled/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("crashes the task with a spawnError instead of dispatching unguarded when overlay is required but unsupported", () => {
    const directory = mkdtempTracked("axi-unsupported-dir-");
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: false, reason: "bwrap 0.6.0 < 0.8 required for --overlay" }),
      platform: "linux",
    });
    const result = mgr.dispatch({ prompt: "hello", directory });
    const status = mgr.status(result.id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /bwrap 0.6.0 < 0.8/);
  });

  test("requireOverlaySupport() re-probes a negative result after the TTL so a transient failure can self-heal", () => {
    // Trigger: a time-based TTL on a negative probe cache. A positive probe
    // is cached forever (no point re-probing); a transient negative probe
    // (PATH temporarily missing bwrap, bwrap version low mid-upgrade, ...) is
    // re-evaluated after 60s so the daemon self-heals without a restart.
    let calls = 0;
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    const restore = () => { Date.now = realNow; };
    try {
      const mgr = makeManager({
        spawnFn: () => fakeChild(),
        sandboxEnabled: true,
        checkBwrapAvailableFn: () => ({ checked: true, available: true }),
        overlayEnabled: true,
        checkOverlaySupportFn: () => { calls++; return { supported: false, reason: "bwrap 0.6.0 < 0.8" }; },
        platform: "linux",
      });

      // First dispatch: probe runs, cached as negative.
      mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
      assert.equal(calls, 1);

      // Second dispatch immediately: cache is negative and recent, no re-probe.
      mgr.dispatch({ prompt: "two", directory: os.tmpdir() });
      assert.equal(calls, 1);

      // Just under the TTL: still cached.
      now += 59_999;
      mgr.dispatch({ prompt: "three", directory: os.tmpdir() });
      assert.equal(calls, 1);

      // At/past the TTL: re-probe.
      now += 1;
      mgr.dispatch({ prompt: "four", directory: os.tmpdir() });
      assert.equal(calls, 2);
    } finally {
      restore();
    }
  });

  test("requireOverlaySupport() caches a positive result forever (no re-probe)", () => {
    // Companion to the negative-TTL test: once supported, the host stays
    // supported (bwrap doesn't get uninstalled through a transient issue).
    // A TTL here would be wasted work on every dispatch.
    let calls = 0;
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => { calls++; return { supported: true }; },
      platform: "linux",
    });

    mgr.dispatch({ prompt: "one", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "two", directory: os.tmpdir() });
    mgr.dispatch({ prompt: "three", directory: os.tmpdir() });

    assert.equal(calls, 1);
  });
});

describe("bwrap sandboxing: overlay rwBinds and shareNet", () => {
  test("snapshots the whole common-dir fallback instead of live-overlaying it when overlay is active", () => {
    let captured = null;
    const directory = mkdtempTracked("axi-worktree-overlay-dir-");
    const gitCommonDir = mkdtempTracked("axi-git-common-overlay-");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
    });

    mgr.dispatch({ prompt: "hello", directory });

    // The whole-common-dir fallback path (no resolveGitDirFn override -> gitDir
    // resolution fails in this temp dir) must use the same isolated snapshot as
    // a linked worktree's private gitDir, not a live overlay of worktrees/.
    assert.equal(captured.args.filter((arg) => arg === OVERLAY_SRC).length, 1, "only the target directory should use an overlay");
    const bindIndex = captured.args.findIndex((arg, index) => arg === "--bind" && captured.args[index + 2] === gitCommonDir);
    assert.notEqual(bindIndex, -1, "expected a scratch-copy bind for the common-dir fallback");
    assert.notEqual(captured.args[bindIndex + 1], gitCommonDir);
  });

  test("retries a private gitDir snapshot after transient ENOENT and ENOTDIR copy failures", (t) => {
    const realCpSync = fs.cpSync;
    let attempts = 0;
    t.mock.method(fs, "cpSync", (source, destination, options) => {
      attempts++;
      if (attempts <= 2) {
        const error = new Error(`transient copy failure ${attempts}`);
        error.code = attempts === 1 ? "ENOENT" : "ENOTDIR";
        throw error;
      }
      return realCpSync(source, destination, options);
    });

    const directory = mkdtempTracked("axi-snapshot-retry-dir-");
    const gitCommonDir = mkdtempTracked("axi-snapshot-retry-common-");
    const gitDir = path.join(gitCommonDir, "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    assert.equal(attempts, 3, "the copy should retry twice before succeeding");
    const snapshot = mgr.status(result.id).overlayDirs.rwFileBinds.find((bind) => bind.path === gitDir);
    assert.ok(snapshot, "the successful retry must still produce the gitDir snapshot bind");
    assert.equal(fs.readFileSync(path.join(snapshot.bindSrc, "HEAD"), "utf8"), "ref: refs/heads/feature\n");
  });

  test("shareNet stays true (--share-net) for both a plain dispatch and an advisor role", async () => {
    // Regression: an advisor role previously passed shareNet: false
    // (--unshare-net), which blocks ALL outbound network in the sandbox --
    // not just the daemon socket -- so the worker CLI could never reach its
    // model provider's API at all. It failed instantly (connection refused)
    // or hung until the no-output watchdog killed it, depending on the
    // executor. The daemon socket is protected by omitting the socket bind
    // for advisor roles instead (see the advisor-guardrails test below), which
    // doesn't touch network access.
    let dispatchArgs = null;
    let advisorArgs = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => {
        if (!dispatchArgs) { dispatchArgs = args; } else { advisorArgs = args; }
        const child = fakeChild();
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    assert.ok(dispatchArgs.includes("--share-net"));
    assert.ok(!dispatchArgs.includes("--unshare-net"));

    await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: SOL_MODEL });
    assert.ok(advisorArgs.includes("--share-net"));
    assert.ok(!advisorArgs.includes("--unshare-net"));
  });

  test("persists the whole-common-dir fallback snapshot onto the task record for extraction", () => {
    const directory = mkdtempTracked("axi-rwbinds-persist-dir-");
    const gitCommonDir = mkdtempTracked("axi-rwbinds-common-");
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    // Review finding #1: extraction (Task 10) re-mounts the exact snapshot
    // bind the worker ran with; it must be persisted here, not re-derived later.
    const status = mgr.status(result.id);
    assert.ok(Array.isArray(status.overlayDirs.rwBinds));
    assert.equal(status.overlayDirs.rwBinds.length, 0, "the whole-common-dir fallback must not use a live sub-overlay");
    assert.ok(status.overlayDirs.rwFileBinds.some((bind) => bind.path === gitCommonDir), "the fallback snapshot must be persisted as a file bind");
  });
});

describe("bwrap sandboxing: packed-refs file binds (overlayfs mounts are directory-only)", () => {
  test("binds a git-common-dir FILE (packed-refs) as a scratch-copy rw bind instead of a directory sub-overlay", () => {
    // Regression: overlayfs mounts are directory-only. A worktree dispatch
    // whose common dir has a packed-refs file used to pass that file through
    // the same sub-overlay machinery as objects/refs, and bwrap died at
    // spawn with "Can't mkdir <...>/packed-refs: Not a directory".
    let captured = null;
    const directory = mkdtempTracked("axi-filebind-dir-");
    const gitCommonDir = mkdtempTracked("axi-filebind-common-");
    const gitDir = path.join(gitCommonDir, "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitCommonDir, "objects"));
    fs.mkdirSync(path.join(gitCommonDir, "refs"));
    fs.mkdirSync(path.join(gitCommonDir, "logs", "refs"), { recursive: true });
    const packedRefs = path.join(gitCommonDir, "packed-refs");
    fs.writeFileSync(packedRefs, "# packfile refs\naaaa1111 refs/heads/main\n");
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    // No directory overlay may target the packed-refs file...
    for (let i = captured.args.indexOf(OVERLAY_SRC); i !== -1 && i < captured.args.length; i = captured.args.indexOf(OVERLAY_SRC, i + 1)) {
      assert.notEqual(captured.args[i + 1], packedRefs, "packed-refs must not be mounted as a directory overlay");
    }
    // ...instead it is bound rw from a scratch copy onto its host path.
    const scratchIdx = captured.args.findIndex((a, idx) => a === "--bind" && captured.args[idx + 2] === packedRefs);
    assert.notEqual(scratchIdx, -1, "expected an rw bind whose destination is the host packed-refs");
    const scratchPath = captured.args[scratchIdx + 1];
    assert.notEqual(scratchPath, packedRefs, "the bind source must be a scratch copy, not the host file itself");
    assert.equal(fs.readFileSync(scratchPath, "utf8"), "# packfile refs\naaaa1111 refs/heads/main\n");

    const status = mgr.status(result.id);
    // Directory slices are only objects/refs/logs/refs now -- the worktree's
    // own gitDir moved to a scratch-copy file bind (taskferry#304) so a
    // concurrent `git worktree add` for a sibling worktree can't perturb a
    // live overlay mount of it.
    assert.equal(status.overlayDirs.rwBinds.length, 3);
    // ...and both the gitDir snapshot and the packed-refs scratch copy are
    // persisted as file binds for extraction to re-mount.
    assert.equal(status.overlayDirs.rwFileBinds.length, 2);
    const gitDirBind = status.overlayDirs.rwFileBinds.find((b) => b.path === gitDir);
    assert.ok(gitDirBind, "expected a snapshot bind for the worktree's own gitDir");
    assert.notEqual(gitDirBind.bindSrc, gitDir, "the bind source must be a scratch copy, not the live gitDir itself");
    assert.deepEqual(status.overlayDirs.rwFileBinds.find((b) => b.path === packedRefs), { path: packedRefs, bindSrc: scratchPath });
  });

  test("a git-common-dir with no packed-refs file (unborn/fresh repo) gets a gitDir snapshot bind but no packed-refs file bind", () => {
    // Companion to the packed-refs regression test above -- a fresh worktree
    // with no packed refs yet must not synthesize a scratch-copy bind for a
    // file that doesn't exist (existsFn(packedRefs) guards this). The
    // worktree's own gitDir still gets its unconditional snapshot bind
    // (taskferry#304).
    let captured = null;
    const directory = mkdtempTracked("axi-nofilebind-dir-");
    const gitCommonDir = mkdtempTracked("axi-nofilebind-common-");
    const gitDir = path.join(gitCommonDir, "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitCommonDir, "objects"));
    fs.mkdirSync(path.join(gitCommonDir, "refs"));
    fs.mkdirSync(path.join(gitCommonDir, "logs", "refs"), { recursive: true });
    // Deliberately no packed-refs file written.
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitDir,
    });

    const result = mgr.dispatch({ prompt: "hello", directory });

    const packedRefs = path.join(gitCommonDir, "packed-refs");
    const scratchIdx = captured.args.findIndex((a, idx) => a === "--bind" && captured.args[idx + 2] === packedRefs);
    assert.equal(scratchIdx, -1, "no rw bind should target a packed-refs file that doesn't exist");

    const status = mgr.status(result.id);
    assert.equal(status.overlayDirs.rwFileBinds.length, 1, "only the gitDir snapshot bind, no packed-refs bind");
    assert.equal(status.overlayDirs.rwFileBinds[0].path, gitDir);
    assert.equal(status.overlayDirs.rwBinds.length, 3, "objects/refs/logs/refs are unaffected");
  });
});

describe("bwrap sandboxing: advisor guardrails", () => {
  test("binds the daemon socket for dispatch spawns and omits it entirely for advisor spawns so the daemon is unreachable", async () => {
    // --unshare-net alone does not block Unix-domain-socket access to a
    // writable bind-mounted path, and runtimeDir holds daemon.sock (review
    // finding #6). The #454 fix: instead of a read-only bind (which never
    // gated connect()), the advisor gets no socket bind at all, so the daemon
    // is unreachable from the advisor sandbox.
    let dispatchArgs = null;
    let advisorArgs = null;
    const mgr = makeManager({
      spawnFn: (_cmd, args) => {
        if (!dispatchArgs) { dispatchArgs = args; } else { advisorArgs = args; }
        const child = fakeChild();
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    const runtimeDir = path.join(mgr.paths.STATE_DIR, "run");
    const socketPath = path.join(runtimeDir, "daemon.sock");

    mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const flagPairs = (args) => {
      const pairs = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--bind" || args[i] === "--ro-bind") pairs.push([args[i], args[i + 1]]);
      }
      return pairs;
    };
    assert.ok(flagPairs(dispatchArgs).some(([flag, p]) => flag === "--bind" && p === socketPath), "dispatch binds the daemon socket");
    assert.ok(!flagPairs(dispatchArgs).some(([_flag, p]) => p === runtimeDir), "dispatch must not bind the whole runtimeDir");

    await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: SOL_MODEL });
    assert.ok(!flagPairs(advisorArgs).some(([_flag, p]) => p === socketPath), "advisor must not get any bind onto the daemon socket");
    assert.ok(!flagPairs(advisorArgs).some(([_flag, p]) => p === runtimeDir), "advisor must not get any bind onto the whole runtimeDir");
  });

  test("crashes an advisor dispatch instead of running it unguarded when overlay is globally disabled", async () => {
    // Review finding #5: an advisor without an overlay gets a plain writable
    // bind -- a path to persist writes, contradicting ADR 0001. Fail closed.
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: false,
      platform: "linux",
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: SOL_MODEL });
    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
  });

  test("crashes an advisor dispatch instead of running it unguarded when sandboxing is force-disabled", async () => {
    // Review finding #5 (dispatch-launch side): the overlay fail-closed check
    // lives inside the sandbox block, so a globally-disabled sandbox would
    // otherwise let an advisor launch with a plain writable bind -- a path to
    // persist writes, contradicting ADR 0001. Fail closed at dispatch-launch.
    let spawned = false;
    const mgr = makeManager({
      spawnFn: () => { spawned = true; return fakeChild(); },
      sandboxEnabled: false,
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: SOL_MODEL });
    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
    assert.match(status.spawnError, /sandbox is unavailable/);
    assert.equal(spawned, false, "advisor must not spawn an unsandboxed child");
  });

  test("crashes an advisor dispatch instead of running it unguarded when the platform cannot sandbox", async () => {
    // Same guarantee on a platform with no sandbox support (e.g. non-Linux):
    // overlay-gating cannot be established, so an advisor must fail closed
    // rather than silently writing through to the target directory.
    let spawned = false;
    const mgr = makeManager({
      spawnFn: () => { spawned = true; return fakeChild(); },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "darwin",
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: SOL_MODEL });
    const status = mgr.status(advised.task_id);
    assert.equal(status.status, "crashed");
    assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
    assert.equal(spawned, false, "advisor must not spawn an unsandboxed child");
  });
});

describe("bwrap sandboxing: project-config read_only_paths", () => {
  // Local constant -- the brief's `read_only_paths` handling reads this
  // exact filename, so the test setup needs to write it three times.
  const TOML_FILENAME = ".taskferry.toml";

  test("read_only_paths from .taskferry.toml become extra --ro-bind pairs", () => {
    const directory = mkdtempTracked("axi-readonly-dir-");
    const roTarget = mkdtempTracked("axi-readonly-target-");
    fs.writeFileSync(path.join(directory, TOML_FILENAME), `read_only_paths = [${JSON.stringify(roTarget)}]\n`);
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    mgr.dispatch({ directory, prompt: "hello", model: MIMIMAX_MODEL, executor: "opencode" });
    const roBindIndex = captured.args.indexOf("--ro-bind");
    const roPairs = [];
    for (let i = 0; i < captured.args.length - 2; i++) {
      if (captured.args[i] === "--ro-bind") roPairs.push([captured.args[i + 1], captured.args[i + 2]]);
    }
    assert.ok(roPairs.some(([src, dest]) => src === roTarget && dest === roTarget), `expected a --ro-bind pair for ${roTarget}, got ${JSON.stringify(roPairs)}`);
    assert.ok(roBindIndex !== -1);
  });

  test("a read_only_paths entry that doesn't exist on this host is skipped and warned, not fatal", () => {
    const directory = mkdtempTracked("axi-readonly-missing-");
    const missing = path.join(os.tmpdir(), "axi-readonly-does-not-exist");
    fs.writeFileSync(path.join(directory, TOML_FILENAME), `read_only_paths = [${JSON.stringify(missing)}]\n`);
    const mgr = makeManager({
      spawnFn: () => fakeChild(),
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    const dispatched = mgr.dispatch({ directory, prompt: "hello", model: MIMIMAX_MODEL, executor: "opencode" });
    const status = mgr.status(dispatched.id);
    assert.match(status.projectConfigWarning, /read_only_paths/);
    assert.match(status.projectConfigWarning, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("a read_only_paths entry that overlaps a protected sandbox mount is rejected and reported, never bound", () => {
    // Mount-order safety: bwrap applies --ro-bind last, so a
    // read_only_paths entry that is an ancestor of any protected mount
    // (e.g. the deny-list `~/.ssh` paths inside $HOME) would re-expose
    // the deny-list tmpfs mounts -- reject before it ever reaches
    // extraRoBinds. Uses homeDir here -- any non-root ancestor of a
    // protected path exercises the same code path.
    const directory = mkdtempTracked("axi-readonly-unsafe-");
    const homeDir = os.homedir();
    fs.writeFileSync(path.join(directory, TOML_FILENAME), `read_only_paths = [${JSON.stringify(homeDir)}]\n`);
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    const dispatched = mgr.dispatch({ directory, prompt: "hello", model: MIMIMAX_MODEL, executor: "opencode" });
    const status = mgr.status(dispatched.id);
    // No `--ro-bind <homeDir> <homeDir>` was added -- the unsafe check
    // rejected it (homeDir is an ancestor of /home/.../.<dotfile> deny-list
    // entries).
    const roPairs = [];
    for (let i = 0; i < captured.args.length - 2; i++) {
      if (captured.args[i] === "--ro-bind") roPairs.push([captured.args[i + 1], captured.args[i + 2]]);
    }
    assert.ok(!roPairs.some(([src]) => src === homeDir), `unexpected ro-bind for ${homeDir}, got ${JSON.stringify(roPairs)}`);
    // projectConfigWarning records the rejected entry.
    assert.match(status.projectConfigWarning, /read_only_paths/);
    assert.match(status.projectConfigWarning, /overlaps a protected sandbox mount/);
  });

  test("read_only_paths = ['/'] is rejected as overlapping every protected mount (root is an ancestor of all paths)", () => {
    // Regression for the brief's exact canonical exploit: the resolver
    // must treat `/` as an ancestor of every protected path so an
    // untrusted `.taskferry.toml` declaring `read_only_paths = ["/"]`
    // never reaches the bwrap argv as `--ro-bind / /` -- that second
    // `--ro-bind / /` would shadow the deny-list tmpfs mounts (un-hiding
    // `~/.ssh`/etc.) and the overlay mount itself (defeating CoW).
    const directory = mkdtempTracked("axi-readonly-root-");
    fs.writeFileSync(path.join(directory, TOML_FILENAME), `read_only_paths = ["/"]\n`);
    let captured = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
    });
    const dispatched = mgr.dispatch({ directory, prompt: "hello", model: MIMIMAX_MODEL, executor: "opencode" });
    const status = mgr.status(dispatched.id);
    // The base bwrap args always include exactly one `--ro-bind / /`
    // (buildBwrapBaseArgs's read-only-root bind). The unsafe check must
    // prevent a second `--ro-bind / /` from being added for the
    // read_only_paths entry -- that second one would shadow the deny-list
    // tmpfs mounts AND the overlay mount.
    const roRootCount = captured.args.filter((arg) => arg === "/").length;
    assert.equal(roRootCount, 2, `expected exactly 2 '/' occurrences (one base read-only-root bind only, no second from read_only_paths); got ${roRootCount} in ${JSON.stringify(captured.args)}`);
    // projectConfigWarning records the rejected entry.
    assert.match(status.projectConfigWarning, /read_only_paths/);
    assert.match(status.projectConfigWarning, /overlaps a protected sandbox mount/);
  });
});
