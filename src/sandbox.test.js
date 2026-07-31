import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildBwrapArgs, buildBwrapBaseArgs, checkBwrapAvailable, checkOverlaySupport, parseBwrapVersion, platformSupportsSandbox, resolveGitCommonDir, resolveGitDir } from "./sandbox.js";

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
      return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined };
    };
    assert.deepEqual(checkBwrapAvailable(runCommand), { checked: true, available: true, raw: "bubblewrap 0.11.2\n" });
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

  test("reports unavailable when the probe exits non-zero with no spawn error", () => {
    const runCommand = () => ({ status: 1, stdout: "", stderr: "boom", error: undefined });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.available, false);
    assert.match(result.reason, /status 1/);
  });
});

describe("checkBwrapAvailable() raw stdout", () => {
  test("includes the raw probe stdout when available", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.raw, "bubblewrap 0.11.2\n");
  });
});

describe("parseBwrapVersion()", () => {
  test("parses a standard version string", () => {
    assert.deepEqual(parseBwrapVersion("bubblewrap 0.11.2\n"), [0, 11, 2]);
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
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.8.0\n", stderr: "", error: undefined });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("supports a version newer than 0.8", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("supports a future major version", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 1.0.0\n", stderr: "", error: undefined });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("rejects a version below 0.8", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.7.1\n", stderr: "", error: undefined });
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
    const runCommand = () => ({ status: 0, stdout: "unexpected output\n", stderr: "", error: undefined });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /could not parse/);
  });

  test("reports unsupported when an unrelated digit triple has no bubblewrap prefix", () => {
    const runCommand = () => ({ status: 0, stdout: "wrapper 1.0.0\n", stderr: "", error: undefined });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /could not parse/);
  });
});

describe("resolveGitCommonDir()", () => {
  test("resolves a worktree's shared .git dir, outside the worktree's own directory", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", "/workspace/repo/.worktrees/issue-1", "rev-parse", "--git-common-dir"]);
      return { status: 0, stdout: "/workspace/repo/.git\n", stderr: "" };
    };
    assert.equal(resolveGitCommonDir("/workspace/repo/.worktrees/issue-1", runCommand), "/workspace/repo/.git");
  });

  test("resolves a relative --git-common-dir output against the given directory", () => {
    const runCommand = () => ({ status: 0, stdout: ".git\n", stderr: "" });
    assert.equal(resolveGitCommonDir("/workspace/repo", runCommand), "/workspace/repo/.git");
  });

  test("returns null when the directory is not a git repo", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    assert.equal(resolveGitCommonDir("/tmp/not-a-repo", runCommand), null);
  });

  test("returns null when git is not installed", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: /** @type {NodeJS.ErrnoException} */ (Object.assign(new Error("not found"), { code: "ENOENT" })) });
    assert.equal(resolveGitCommonDir("/workspace/repo", runCommand), null);
  });
});

describe("resolveGitDir()", () => {
  test("resolves a linked worktree's own private gitdir, distinct from the common dir (taskferry#224)", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", "/workspace/repo/.worktrees/issue-1", "rev-parse", "--absolute-git-dir"]);
      return { status: 0, stdout: "/workspace/repo/.git/worktrees/issue-1\n", stderr: "" };
    };
    assert.equal(resolveGitDir("/workspace/repo/.worktrees/issue-1", runCommand), "/workspace/repo/.git/worktrees/issue-1");
  });

  test("resolves to the same directory as the common dir for the main checkout itself", () => {
    const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
    assert.equal(resolveGitDir("/workspace/repo", runCommand), "/workspace/repo/.git");
  });

  test("returns null when the directory is not a git repo", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    assert.equal(resolveGitDir("/tmp/not-a-repo", runCommand), null);
  });

  test("returns null when git is not installed", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: /** @type {NodeJS.ErrnoException} */ (Object.assign(new Error("not found"), { code: "ENOENT" })) });
    assert.equal(resolveGitDir("/workspace/repo", runCommand), null);
  });
});

describe("buildBwrapArgs()", () => {
  test("orders ro-bind, then /proc+/dev+/tmp scaffolding, then deny-list tmpfs, then read-write binds, then standard flags", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
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
      "/home/user/.local/state/taskferry",
      path.join("/home/user", ".ssh"),
      path.join("/home/user", ".aws"),
      path.join("/home/user", ".config", "gcloud"),
      path.join("/home/user", ".config", "gh"),
      path.join("/home/user", ".gnupg"),
    ];
    for (const denied of deniedPaths) {
      const index = args.indexOf(denied);
      assert.notEqual(index, -1, `expected ${denied} to be tmpfs-denied`);
      assert.equal(args[index - 1], "--tmpfs");
      assert.ok(index > 8, `expected ${denied} to be denied after the /proc+/dev+/tmp scaffolding`);
    }

    // The state dir's tmpfs deny must come before the runtime dir's read-write
    // bind, since runtimeDir is nested under stateDir in the default layout
    // and bwrap applies rules in argument order.
    const stateDirTmpfsIndex = args.indexOf("/home/user/.local/state/taskferry");
    const runtimeDirBindIndex = args.lastIndexOf("/home/user/.local/state/taskferry/run");
    assert.ok(stateDirTmpfsIndex < runtimeDirBindIndex);
    assert.equal(args[runtimeDirBindIndex - 1], "/home/user/.local/state/taskferry/run");
    assert.equal(args[runtimeDirBindIndex - 2], "--bind");

    const directoryBindIndex = args.lastIndexOf("/workspace/my-repo");
    assert.equal(args[directoryBindIndex - 1], "/workspace/my-repo");
    assert.equal(args[directoryBindIndex - 2], "--bind");
    // The read-write binds must be the very last mounts, so they win over
    // every other mount above regardless of path nesting.
    assert.ok(directoryBindIndex < runtimeDirBindIndex);

    assert.deepEqual(args.slice(-3), ["--unshare-all", "--share-net", "--die-with-parent"]);
  });

  test("accepts an injected denyList override", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: ["/only/this/path"],
    });
    assert.equal(args[9], "--tmpfs");
    assert.equal(args[10], "/only/this/path");
    assert.equal(args.indexOf("/home/user/.ssh"), -1);
  });

  test("binds a directory and runtimeDir nested under /tmp after the /tmp tmpfs, so the fresh /tmp mount doesn't shadow them", () => {
    const args = buildBwrapArgs({
      directory: "/tmp/my-scratch-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/tmp/taskferry-runtime",
      homeDir: "/home/user",
    });

    const tmpTmpfsIndex = args.indexOf("--tmpfs");
    assert.equal(args[tmpTmpfsIndex + 1], "/tmp");

    const directoryBindIndex = args.indexOf("--bind", tmpTmpfsIndex);
    assert.equal(args[directoryBindIndex + 1], "/tmp/my-scratch-repo");
    assert.ok(directoryBindIndex > tmpTmpfsIndex);

    const runtimeDirBindIndex = args.lastIndexOf("--bind");
    assert.equal(args[runtimeDirBindIndex + 1], "/tmp/taskferry-runtime");
    assert.ok(runtimeDirBindIndex > tmpTmpfsIndex);
  });

  test("appends extraRwBinds after directory/runtimeDir and before extraRoBinds", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
      extraRwBinds: ["/workspace/main-repo/.git/worktrees/my-repo"],
    });
    const runtimeDirBindIndex = args.lastIndexOf("/home/user/.local/state/taskferry/run");
    const extraBindIndex = args.indexOf("/workspace/main-repo/.git/worktrees/my-repo");
    assert.notEqual(extraBindIndex, -1);
    assert.equal(args[extraBindIndex - 1], "--bind");
    assert.equal(args[extraBindIndex + 1], "/workspace/main-repo/.git/worktrees/my-repo");
    assert.ok(extraBindIndex > runtimeDirBindIndex);
  });

  test("appends extraRwPairBinds after extraRwBinds and before extraRoBinds, as a --bind (not --ro-bind) with different src/dest", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
      extraRwBinds: ["/workspace/main-repo/.git/worktrees/my-repo"],
      extraRwPairBinds: [["/home/user/.pi/agent/sessions", "/home/user/.local/state/taskferry/run/pi-data/sessions"]],
      extraRoBinds: [["/home/user/.pi/agent/auth.json", "/home/user/.local/state/taskferry/run/pi-data/auth.json"]],
    });

    const extraRwBindIndex = args.indexOf("/workspace/main-repo/.git/worktrees/my-repo");
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
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
      extraRoBinds: [["/home/user/.local/share/opencode/auth.json", "/home/user/.local/state/taskferry/run/opencode-data/opencode/auth.json"]],
    });

    const runtimeDirBindIndex = args.lastIndexOf("/home/user/.local/state/taskferry/run");
    const roBindIndex = args.indexOf("--ro-bind", runtimeDirBindIndex);
    assert.notEqual(roBindIndex, -1);
    assert.equal(args[roBindIndex + 1], "/home/user/.local/share/opencode/auth.json");
    assert.equal(args[roBindIndex + 2], "/home/user/.local/state/taskferry/run/opencode-data/opencode/auth.json");
    assert.ok(roBindIndex > runtimeDirBindIndex);
    assert.deepEqual(args.slice(-3), ["--unshare-all", "--share-net", "--die-with-parent"]);
  });

  test("mounts an overlay on the target directory instead of a plain bind when overlay is given", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
      overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
    });
    const overlayIndex = args.indexOf("--overlay-src");
    assert.notEqual(overlayIndex, -1);
    assert.deepEqual(args.slice(overlayIndex, overlayIndex + 6), [
      "--overlay-src", "/workspace/my-repo",
      "--overlay", "/tmp/taskferry-cow-t1/upper/main", "/tmp/taskferry-cow-t1/work/main", "/workspace/my-repo",
    ]);
    assert.equal(args.some((v, i) => v === "--bind" && args[i + 1] === "/workspace/my-repo"), false, "no plain --bind for the target directory when overlay is active");
  });

  test("keeps the plain --bind on the target directory when overlay is omitted", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
    });
    assert.equal(args.includes("--overlay-src"), false);
    const bindIndex = args.indexOf("--bind");
    assert.equal(args[bindIndex + 1], "/workspace/my-repo");
  });

  test("mounts each overlayRwBinds entry as its own overlay, after extraRwBinds and before extraRwPairBinds", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
      extraRwBinds: ["/home/user/.cache/taskferry/opencode-data"],
      overlayRwBinds: [
        { path: "/workspace/main-repo/.git/worktrees/my-repo", upperDir: "/tmp/taskferry-cow-t1/upper/extra/a", workDir: "/tmp/taskferry-cow-t1/work/extra/a" },
      ],
    });
    const extraRwBindIndex = args.indexOf("/home/user/.cache/taskferry/opencode-data");
    const overlayRwIndex = args.indexOf("--overlay-src", extraRwBindIndex);
    assert.notEqual(overlayRwIndex, -1);
    assert.deepEqual(args.slice(overlayRwIndex, overlayRwIndex + 6), [
      "--overlay-src", "/workspace/main-repo/.git/worktrees/my-repo",
      "--overlay", "/tmp/taskferry-cow-t1/upper/extra/a", "/tmp/taskferry-cow-t1/work/extra/a", "/workspace/main-repo/.git/worktrees/my-repo",
    ]);
  });

  test("emits --share-net by default and --unshare-net when shareNet is false", () => {
    const withNet = buildBwrapArgs({ directory: "/workspace/my-repo", stateDir: "/state", runtimeDir: "/state/run", homeDir: "/home/user" });
    assert.deepEqual(withNet.slice(-3), ["--unshare-all", "--share-net", "--die-with-parent"]);

    const withoutNet = buildBwrapArgs({ directory: "/workspace/my-repo", stateDir: "/state", runtimeDir: "/state/run", homeDir: "/home/user", shareNet: false });
    assert.deepEqual(withoutNet.slice(-3), ["--unshare-all", "--unshare-net", "--die-with-parent"]);
  });

  test("binds runtimeDir read-only when runtimeDirWritable is false (advisor isolation)", () => {
    const args = buildBwrapArgs({ directory: "/w", stateDir: "/s", runtimeDir: "/s/run", homeDir: "/h", denyList: [], runtimeDirWritable: false });
    assert.notEqual(args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/s/run"), -1);
    assert.equal(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run"), -1);
  });

  test("defaults to a writable runtimeDir bind (unchanged dispatch behavior)", () => {
    const args = buildBwrapArgs({ directory: "/w", stateDir: "/s", runtimeDir: "/s/run", homeDir: "/h", denyList: [] });
    assert.notEqual(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run"), -1);
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
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
    });
    assert.deepEqual(args, [
      "--ro-bind", "/", "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--tmpfs", "/home/user/.local/state/taskferry",
      "--tmpfs", "/home/user/.ssh",
      "--tmpfs", "/home/user/.aws",
      "--tmpfs", "/home/user/.config/gcloud",
      "--tmpfs", "/home/user/.config/gh",
      "--tmpfs", "/home/user/.gnupg",
      "--tmpfs", "/home/user/.claude",
      "--bind", "/workspace/my-repo", "/workspace/my-repo",
      "--bind", "/home/user/.local/state/taskferry/run", "/home/user/.local/state/taskferry/run",
      "--unshare-all", "--share-net", "--die-with-parent",
    ]);
  });

  test("overlay case is byte-identical to the pre-refactor output", () => {
    const args = buildBwrapArgs({
      directory: "/workspace/my-repo",
      stateDir: "/home/user/.local/state/taskferry",
      runtimeDir: "/home/user/.local/state/taskferry/run",
      homeDir: "/home/user",
      overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
    });
    assert.deepEqual(args, [
      "--ro-bind", "/", "/",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--tmpfs", "/home/user/.local/state/taskferry",
      "--tmpfs", "/home/user/.ssh",
      "--tmpfs", "/home/user/.aws",
      "--tmpfs", "/home/user/.config/gcloud",
      "--tmpfs", "/home/user/.config/gh",
      "--tmpfs", "/home/user/.gnupg",
      "--tmpfs", "/home/user/.claude",
      "--overlay-src", "/workspace/my-repo",
      "--overlay", "/tmp/taskferry-cow-t1/upper/main", "/tmp/taskferry-cow-t1/work/main", "/workspace/my-repo",
      "--bind", "/home/user/.local/state/taskferry/run", "/home/user/.local/state/taskferry/run",
      "--unshare-all", "--share-net", "--die-with-parent",
    ]);
  });
});
