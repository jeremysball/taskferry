import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildBwrapArgs, buildBwrapBaseArgs, checkBwrapAvailable, checkOverlaySupport, defaultDenyList, parseBwrapVersion, platformSupportsSandbox, resolveGitCommonDir, resolveGitDir } from "./sandbox.js";

// Repeated literals lifted to module-level constants to satisfy
// sonarjs/no-duplicate-string in this file.
const BWRAP_VERSION = "bubblewrap 0.11.2\n";
const REPO_DIR = "/workspace/repo";
const WORKTREE_DIR = "/workspace/repo/.worktrees/issue-1";
const GIT_COMMON_DIR_OUT = REPO_DIR + "/.git\n";
const GIT_DIR = REPO_DIR + "/.git";
const MY_REPO_DIR = "/workspace/my-repo";
const STATE_DIR = "/home/user/.local/state/taskferry";
const RUNTIME_DIR = "/home/user/.local/state/taskferry/run";
const SOCKET_PATH = RUNTIME_DIR + "/daemon.sock";
const HOME_DIR = "/home/user";
const UNSHARE_ALL = "--unshare-all";
const SHARE_NET = "--share-net";
const DIE_WITH_PARENT = "--die-with-parent";
const STATE_RUN_DIR = "/state/run";
const SSH_DIR = "/home/user/.ssh";
const MAIN_WORKTREE_GITDIR = "/workspace/main-repo/.git/worktrees/my-repo";
const COW_UPPER_MAIN = "/tmp/taskferry-cow-t1/upper/main";
const COW_WORK_MAIN = "/tmp/taskferry-cow-t1/work/main";
const OVERLAY_SRC = "--overlay-src";
const OPENCODE_DATA_DIR = "/home/user/.local/share/opencode";
const KILO_DATA_DIR = "/home/user/.local/share/kilo";

describe("platformSupportsSandbox()", () => {
  test("is true on linux", () => {
    assert.equal(platformSupportsSandbox("linux"), true);
  });

  test("is false on darwin", () => {
    assert.equal(platformSupportsSandbox("darwin"), false);
  });

  test("is false on win32", () => {
    assert.equal(platformSupportsSandbox("win32"), false);
  });

  test("defaults to process.platform when no argument is given", () => {
    assert.equal(platformSupportsSandbox(), process.platform === "linux");
  });
});

describe("checkBwrapAvailable()", () => {
  test("reports available when the probe exits 0", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "bwrap");
      assert.deepEqual(args, ["--version"]);
      return { status: 0, stdout: BWRAP_VERSION, stderr: "", error: null };
    };
    assert.deepEqual(checkBwrapAvailable(runCommand), { checked: true, available: true, raw: BWRAP_VERSION });
  });

  test("reports unavailable with an ENOENT-derived reason when the binary is missing", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.checked, true);
    assert.equal(result.available, false);
    assert.match(result.reason, /bwrap not found/);
  });

  test("reports unavailable with the spawn error message for a non-ENOENT error", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "EACCES", message: "spawnSync bwrap EACCES" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /EACCES/);
  });

  test("does not treat a numeric error code as the ENOENT 'bwrap not found' case", () => {
    // A spawned-probe failure can surface with a numeric ExecException.code
    // (e.g. 127). errCode() stringifies, so a numeric code must fall through to
    // the spawn-error message, not be misreported as a missing bwrap binary.
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: 127, message: "spawnSync bwrap ENOENT" } });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.doesNotMatch(result.reason, /bwrap not found/);
    assert.match(result.reason, /spawnSync bwrap ENOENT/);
  });

  test("reports unavailable when the probe exits non-zero with no spawn error", () => {
    const runCommand = () => ({ status: 1, stdout: "", stderr: "boom", error: null });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /status 1/);
  });
});

describe("checkBwrapAvailable() raw stdout", () => {
  test("includes the raw probe stdout when available", () => {
    const runCommand = () => ({ status: 0, stdout: BWRAP_VERSION, stderr: "", error: null });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.raw, BWRAP_VERSION);
  });
});

describe("parseBwrapVersion()", () => {
  test("parses a standard version string", () => {
    assert.deepEqual(parseBwrapVersion(BWRAP_VERSION), [0, 11, 2]);
  });

  test("returns null for unparseable output", () => {
    assert.equal(parseBwrapVersion("not a version"), null);
  });

  test("returns null for an unrelated digit triple without the bubblewrap prefix", () => {
    assert.equal(parseBwrapVersion("wrapper 1.0.0\n"), null);
  });
});

describe("checkOverlaySupport()", () => {
  test("supports bwrap 0.8.0 exactly", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.8.0\n", stderr: "", error: null });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("supports a version newer than 0.8", () => {
    const runCommand = () => ({ status: 0, stdout: BWRAP_VERSION, stderr: "", error: null });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("supports a future major version", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 1.0.0\n", stderr: "", error: null });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("rejects a version below 0.8", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.7.1\n", stderr: "", error: null });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /0\.7\.1 < 0\.8/);
  });

  test("reports unsupported when bwrap itself is unavailable", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /bwrap not found/);
  });

  test("reports unsupported when the version string can't be parsed", () => {
    const runCommand = () => ({ status: 0, stdout: "unexpected output\n", stderr: "", error: null });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /could not parse/);
  });

  test("reports unsupported when an unrelated digit triple has no bubblewrap prefix", () => {
    const runCommand = () => ({ status: 0, stdout: "wrapper 1.0.0\n", stderr: "", error: null });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /could not parse/);
  });
});

describe("resolveGitCommonDir()", () => {
  test("resolves a worktree's shared .git dir, outside the worktree's own directory", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", WORKTREE_DIR, "rev-parse", "--git-common-dir"]);
      return { status: 0, stdout: GIT_COMMON_DIR_OUT, stderr: "" };
    };
    assert.equal(resolveGitCommonDir(WORKTREE_DIR, runCommand), GIT_DIR);
  });

  test("resolves a relative --git-common-dir output against the given directory", () => {
    const runCommand = () => ({ status: 0, stdout: ".git\n", stderr: "" });
    assert.equal(resolveGitCommonDir(REPO_DIR, runCommand), GIT_DIR);
  });

  test("returns null when the directory is not a git repo", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    assert.equal(resolveGitCommonDir("/tmp/not-a-repo", runCommand), null);
  });

  test("returns null when git is not installed", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: /** @type {NodeJS.ErrnoException} */ (Object.assign(new Error("not found"), { code: "ENOENT" })) });
    assert.equal(resolveGitCommonDir(REPO_DIR, runCommand), null);
  });
});

describe("resolveGitDir()", () => {
  test("resolves a linked worktree's own private gitdir, distinct from the common dir (taskferry#224)", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", WORKTREE_DIR, "rev-parse", "--absolute-git-dir"]);
      return { status: 0, stdout: "/workspace/repo/.git/worktrees/issue-1\n", stderr: "" };
    };
    assert.equal(resolveGitDir(WORKTREE_DIR, runCommand), "/workspace/repo/.git/worktrees/issue-1");
  });

  test("resolves to the same directory as the common dir for the main checkout itself", () => {
    const runCommand = () => ({ status: 0, stdout: GIT_COMMON_DIR_OUT, stderr: "" });
    assert.equal(resolveGitDir(REPO_DIR, runCommand), GIT_DIR);
  });

  test("returns null when the directory is not a git repo", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    assert.equal(resolveGitDir("/tmp/not-a-repo", runCommand), null);
  });

  test("returns null when git is not installed", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: /** @type {NodeJS.ErrnoException} */ (Object.assign(new Error("not found"), { code: "ENOENT" })) });
    assert.equal(resolveGitDir(REPO_DIR, runCommand), null);
  });
});

describe("buildBwrapArgs()", () => {
  test("orders ro-bind, then /proc+/dev+/tmp scaffolding, then deny-list tmpfs, then read-write binds, then standard flags", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
    });

    assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
    // /proc, /dev, and /tmp must be mounted before the deny-list and the
    // read-write binds below: bwrap applies mounts in argument order, and a
    // later mount on a parent directory (e.g. /tmp) shadows an earlier one
    // nested inside it. Any deny-list entry or bind path that happens to
    // live under /tmp must not be silently hidden by a /tmp mount that
    // comes after it.
    assert.deepEqual(args.slice(3, 9), ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);

    const deniedPaths = [
      STATE_DIR,
      path.join(HOME_DIR, ".ssh"),
      path.join(HOME_DIR, ".aws"),
      path.join(HOME_DIR, ".config", "gcloud"),
      path.join(HOME_DIR, ".config", "gh"),
      path.join(HOME_DIR, ".gnupg"),
    ];
    for (const denied of deniedPaths) {
      const index = args.indexOf(denied);
      assert.notEqual(index, -1, `expected ${denied} to be tmpfs-denied`);
      assert.equal(args[index - 1], "--tmpfs");
      assert.ok(index > 8, `expected ${denied} to be denied after the /proc+/dev+/tmp scaffolding`);
    }

    // The state dir's tmpfs deny must come before the daemon socket bind,
    // since runtimeDir is nested under stateDir in the default layout and
    // bwrap applies rules in argument order -- the socket bind re-exposes
    // only the socket file under the stateDir tmpfs, not the whole runtimeDir.
    const stateDirTmpfsIndex = args.indexOf(STATE_DIR);
    const socketPath = SOCKET_PATH;
    const socketBindIndex = args.lastIndexOf(socketPath);
    assert.ok(stateDirTmpfsIndex < socketBindIndex);
    assert.equal(args[socketBindIndex - 1], socketPath);
    assert.equal(args[socketBindIndex - 2], "--bind");

    const directoryBindIndex = args.lastIndexOf(MY_REPO_DIR);
    assert.equal(args[directoryBindIndex - 1], MY_REPO_DIR);
    assert.equal(args[directoryBindIndex - 2], "--bind");
    // The read-write binds must be the very last mounts, so they win over
    // every other mount above regardless of path nesting.
    assert.ok(directoryBindIndex < socketBindIndex);

    assert.deepEqual(args.slice(-3), [UNSHARE_ALL, SHARE_NET, DIE_WITH_PARENT]);
  });

  test("accepts an injected denyList override", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: "/state",
      runtimeDir: STATE_RUN_DIR,
      homeDir: HOME_DIR,
      denyList: ["/only/this/path"],
    });
    assert.equal(args[9], "--tmpfs");
    assert.equal(args[10], "/only/this/path");
    assert.equal(args.indexOf(SSH_DIR), -1);
  });

  test("binds a directory and the daemon socket nested under /tmp after the /tmp tmpfs, so the fresh /tmp mount doesn't shadow them", () => {
    const args = buildBwrapArgs({
      directory: "/tmp/my-scratch-repo",
      stateDir: STATE_DIR,
      runtimeDir: "/tmp/taskferry-runtime",
      homeDir: HOME_DIR,
    });

    const tmpTmpfsIndex = args.indexOf("--tmpfs");
    assert.equal(args[tmpTmpfsIndex + 1], "/tmp");

    const directoryBindIndex = args.indexOf("--bind", tmpTmpfsIndex);
    assert.equal(args[directoryBindIndex + 1], "/tmp/my-scratch-repo");
    assert.ok(directoryBindIndex > tmpTmpfsIndex);

    const socketPath = "/tmp/taskferry-runtime/daemon.sock";
    const socketBindIndex = args.lastIndexOf("--bind");
    assert.equal(args[socketBindIndex + 1], socketPath);
    assert.ok(socketBindIndex > tmpTmpfsIndex);
  });

  test("appends extraRwBinds after directory/runtimeDir and before extraRoBinds", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      extraRwBinds: [MAIN_WORKTREE_GITDIR],
    });
    const socketPath = SOCKET_PATH;
    const socketBindIndex = args.lastIndexOf(socketPath);
    const extraBindIndex = args.indexOf(MAIN_WORKTREE_GITDIR);
    assert.notEqual(extraBindIndex, -1);
    assert.equal(args[extraBindIndex - 1], "--bind");
    assert.equal(args[extraBindIndex + 1], MAIN_WORKTREE_GITDIR);
    assert.ok(extraBindIndex > socketBindIndex);
  });

  test("appends extraRwPairBinds after extraRwBinds and before extraRoBinds, as a --bind (not --ro-bind) with different src/dest", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      extraRwBinds: [MAIN_WORKTREE_GITDIR],
      extraRwPairBinds: [["/home/user/.pi/agent/sessions", "/home/user/.local/state/taskferry/run/pi-data/sessions"]],
      extraRoBinds: [["/home/user/.pi/agent/auth.json", "/home/user/.local/state/taskferry/run/pi-data/auth.json"]],
    });

    const extraRwBindIndex = args.indexOf(MAIN_WORKTREE_GITDIR);
    const rwPairBindIndex = args.indexOf("--bind", extraRwBindIndex + 1);
    assert.notEqual(rwPairBindIndex, -1);
    assert.equal(args[rwPairBindIndex + 1], "/home/user/.pi/agent/sessions");
    assert.equal(args[rwPairBindIndex + 2], "/home/user/.local/state/taskferry/run/pi-data/sessions");
    assert.ok(rwPairBindIndex > extraRwBindIndex);

    const roBindIndex = args.indexOf("--ro-bind", rwPairBindIndex);
    assert.notEqual(roBindIndex, -1);
    assert.ok(roBindIndex > rwPairBindIndex + 2);
  });

  test("appends extraRoBinds after the read-write binds, so a specific file wins over a broader writable parent", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      extraRoBinds: [["/home/user/.local/share/opencode/auth.json", "/home/user/.local/state/taskferry/run/opencode-data/opencode/auth.json"]],
    });

    const socketPath = SOCKET_PATH;
    const socketBindIndex = args.lastIndexOf(socketPath);
    const roBindIndex = args.indexOf("--ro-bind", socketBindIndex);
    assert.notEqual(roBindIndex, -1);
    assert.equal(args[roBindIndex + 1], "/home/user/.local/share/opencode/auth.json");
    assert.equal(args[roBindIndex + 2], "/home/user/.local/state/taskferry/run/opencode-data/opencode/auth.json");
    assert.ok(roBindIndex > socketBindIndex);
    assert.deepEqual(args.slice(-3), [UNSHARE_ALL, SHARE_NET, DIE_WITH_PARENT]);
  });

  test("mounts an overlay on the target directory instead of a plain bind when overlay is given", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      overlay: { upperDir: COW_UPPER_MAIN, workDir: COW_WORK_MAIN },
    });
    const overlayIndex = args.indexOf(OVERLAY_SRC);
    assert.notEqual(overlayIndex, -1);
    assert.deepEqual(args.slice(overlayIndex, overlayIndex + 6), [
      OVERLAY_SRC, MY_REPO_DIR,
      "--overlay", COW_UPPER_MAIN, COW_WORK_MAIN, MY_REPO_DIR,
    ]);
    assert.equal(args.some((v, i) => v === "--bind" && args[i + 1] === MY_REPO_DIR), false, "no plain --bind for the target directory when overlay is active");
  });

  test("keeps the plain --bind on the target directory when overlay is omitted", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
    });
    assert.equal(args.includes(OVERLAY_SRC), false);
    const bindIndex = args.indexOf("--bind");
    assert.equal(args[bindIndex + 1], MY_REPO_DIR);
  });

  test("mounts each overlayRwBinds entry as its own overlay, after extraRwBinds and before extraRwPairBinds", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      extraRwBinds: ["/home/user/.cache/taskferry/opencode-data"],
      overlayRwBinds: [
        { path: MAIN_WORKTREE_GITDIR, upperDir: "/tmp/taskferry-cow-t1/upper/extra/a", workDir: "/tmp/taskferry-cow-t1/work/extra/a" },
      ],
    });
    const extraRwBindIndex = args.indexOf("/home/user/.cache/taskferry/opencode-data");
    const overlayRwIndex = args.indexOf(OVERLAY_SRC, extraRwBindIndex);
    assert.notEqual(overlayRwIndex, -1);
    assert.deepEqual(args.slice(overlayRwIndex, overlayRwIndex + 6), [
      OVERLAY_SRC, MAIN_WORKTREE_GITDIR,
      "--overlay", "/tmp/taskferry-cow-t1/upper/extra/a", "/tmp/taskferry-cow-t1/work/extra/a", MAIN_WORKTREE_GITDIR,
    ]);
  });

  test("emits --share-net by default and --unshare-net when shareNet is false", () => {
    const withNet = buildBwrapArgs({ directory: MY_REPO_DIR, stateDir: "/state", runtimeDir: STATE_RUN_DIR, homeDir: HOME_DIR });
    assert.deepEqual(withNet.slice(-3), [UNSHARE_ALL, SHARE_NET, DIE_WITH_PARENT]);

    const withoutNet = buildBwrapArgs({ directory: MY_REPO_DIR, stateDir: "/state", runtimeDir: STATE_RUN_DIR, homeDir: HOME_DIR, shareNet: false });
    assert.deepEqual(withoutNet.slice(-3), [UNSHARE_ALL, "--unshare-net", DIE_WITH_PARENT]);
  });

  test("binds only the daemon socket, not the whole runtimeDir, when socketPath is set (the #453/#455 fix)", () => {
    const args = buildBwrapArgs({ directory: "/w", stateDir: "/s", runtimeDir: "/s/run", homeDir: "/h", denyList: [] });
    // The socket is bound at its own path; the whole runtimeDir is not.
    assert.notEqual(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run/daemon.sock"), -1);
    assert.equal(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run"), -1);
    assert.equal(args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/s/run"), -1);
  });

  test("omits the socket bind entirely when socketPath is null, so the daemon is unreachable (the #454 fix)", () => {
    const args = buildBwrapArgs({ directory: "/w", stateDir: "/s", runtimeDir: "/s/run", homeDir: "/h", denyList: [], socketPath: null });
    assert.equal(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run/daemon.sock"), -1);
    assert.equal(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run"), -1);
    assert.equal(args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/s/run"), -1);
  });
});

describe("buildBwrapBaseArgs() (Task 5: shared scaffolding)", () => {
  test("emits ro-bind root, /proc+/dev+/tmp scaffolding, then one --tmpfs per denied path", () => {
    const args = buildBwrapBaseArgs({ denyList: ["/a", "/b"] });
    assert.deepEqual(args, [
      "--ro-bind", "/", "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--tmpfs", "/a", "--tmpfs", "/b",
    ]);
  });

  test("emits no --tmpfs for the deny-list entries when denyList is empty", () => {
    const args = buildBwrapBaseArgs({ denyList: [] });
    assert.deepEqual(args, ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
  });
});

describe("buildBwrapArgs() byte-identical output (Task 5: post-refactor regression)", () => {
  // The two baseline arrays below were captured from the pre-refactor
  // buildBwrapArgs() against the inputs shown. Refactoring buildBwrapArgs()
  // to share buildBwrapBaseArgs() with buildMergedViewBwrapArgs() must not
  // change any element of these arrays -- this is the safety net.
  test("non-overlay case is byte-identical to the pre-refactor output", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
    });
    assert.deepEqual(args, [
      "--ro-bind", "/", "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--tmpfs", STATE_DIR,
      "--tmpfs", SSH_DIR,
      "--tmpfs", "/home/user/.aws",
      "--tmpfs", "/home/user/.config/gcloud",
      "--tmpfs", "/home/user/.config/gh",
      "--tmpfs", "/home/user/.gnupg",
      "--tmpfs", "/home/user/.claude",
      "--tmpfs", OPENCODE_DATA_DIR,
      "--tmpfs", KILO_DATA_DIR,
      "--bind", MY_REPO_DIR, MY_REPO_DIR,
      "--bind", SOCKET_PATH, SOCKET_PATH,
      UNSHARE_ALL, SHARE_NET, DIE_WITH_PARENT,
    ]);
  });

  test("overlay case is byte-identical to the pre-refactor output", () => {
    const args = buildBwrapArgs({
      directory: MY_REPO_DIR,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      overlay: { upperDir: COW_UPPER_MAIN, workDir: COW_WORK_MAIN },
    });
    assert.deepEqual(args, [
      "--ro-bind", "/", "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--tmpfs", STATE_DIR,
      "--tmpfs", SSH_DIR,
      "--tmpfs", "/home/user/.aws",
      "--tmpfs", "/home/user/.config/gcloud",
      "--tmpfs", "/home/user/.config/gh",
      "--tmpfs", "/home/user/.gnupg",
      "--tmpfs", "/home/user/.claude",
      "--tmpfs", OPENCODE_DATA_DIR,
      "--tmpfs", KILO_DATA_DIR,
      OVERLAY_SRC, MY_REPO_DIR,
      "--overlay", COW_UPPER_MAIN, COW_WORK_MAIN, MY_REPO_DIR,
      "--bind", SOCKET_PATH, SOCKET_PATH,
      UNSHARE_ALL, SHARE_NET, DIE_WITH_PARENT,
    ]);
  });
});

describe("defaultDenyList()", () => {
  test("covers harness session databases under the default data home", () => {
    const list = defaultDenyList(HOME_DIR, STATE_DIR);
    assert.ok(list.includes(STATE_DIR));
    assert.ok(list.includes(SSH_DIR));
    assert.deepEqual(list.slice(-2), [OPENCODE_DATA_DIR, KILO_DATA_DIR]);
  });

  test("honors an explicit data home", () => {
    const list = defaultDenyList(HOME_DIR, STATE_DIR, "/data");
    assert.ok(list.includes("/data/opencode"));
    assert.ok(list.includes("/data/kilo"));
  });
});
