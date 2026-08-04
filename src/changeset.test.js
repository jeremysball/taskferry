// src/changeset.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overlayPaths, subOverlayPaths, subOverlaySlug, extractGitDiff, resolvePreDispatchHead, buildMergedViewBwrapArgs, extractNonGitDiff, applyChangeset, cleanupOverlay } from "./changeset.js";

// Shared fixture literals lifted to module scope so the sonarjs
// no-duplicate-string rule stays quiet (each literal now appears once, in
// its constant definition) and so every test case points at the same paths.
const REPO_DIR = "/workspace/repo";
const SCRATCH_DIR = "/workspace/scratch";
const STATE_DIR = "/state";
const RUNTIME_DIR = "/state/run";
const HOME_DIR = "/home/user";
const DIFF_PATCH = "/state/diffs/t1.patch";
const T1_ROOT = "/tmp/taskferry-cow-t1";
const T1_UPPER = "/tmp/taskferry-cow-t1/upper/main";
const T1_WORK = "/tmp/taskferry-cow-t1/work/main";
const T1_MERGED = "/tmp/taskferry-cow-t1/merged";
const TMP_DIR = "/tmp";
const UPPER_DIR = "/tmp/u";
const WORK_DIR = "/tmp/w";
const PRE_DISPATCH_HEAD = "abc123";
const MY_REPO_WT = "/workspace/main-repo/.git/worktrees/my-repo";
const GIT_CMD = "git";
const BWRAP_CMD = "bwrap";
const DIR_FLAG = "--dir";
const OVERLAY_SRC_FLAG = "--overlay-src";
const OVERLAY_FLAG = "--overlay";
const SAMPLE_DIFF_X = "diff --git a/x b/x\n";
const BIND_FLAG = "--bind";
const RO_BIND_FLAG = "--ro-bind";
const ROOT_BIND = "/";
const SH_CMD = "sh";

describe("overlayPaths()", () => {
  test("builds a per-task root plus a main upper/work pair under it", () => {
    const paths = overlayPaths("oc_abc123", TMP_DIR);
    assert.equal(paths.root, "/tmp/taskferry-cow-oc_abc123");
    assert.equal(paths.upperDir, "/tmp/taskferry-cow-oc_abc123/upper/main");
    assert.equal(paths.workDir, "/tmp/taskferry-cow-oc_abc123/work/main");
  });
});

describe("subOverlaySlug()", () => {
  test("combines the basename with a stable short hash of the full path", () => {
    const slugA = subOverlaySlug(MY_REPO_WT);
    const slugB = subOverlaySlug(MY_REPO_WT);
    assert.equal(slugA, slugB);
    assert.match(slugA, /^my-repo-[0-9a-f]{8}$/);
  });

  test("produces distinct slugs for two different paths with the same basename", () => {
    const slugA = subOverlaySlug("/workspace/repo-a/.git/worktrees/shared-name");
    const slugB = subOverlaySlug("/workspace/repo-b/.git/worktrees/shared-name");
    assert.notEqual(slugA, slugB);
  });
});

describe("subOverlayPaths()", () => {
  test("nests upper/work under root/{upper,work}/extra/<slug>", () => {
    const root = "/tmp/taskferry-cow-oc_abc123";
    const targetPath = MY_REPO_WT;
    const result = subOverlayPaths(root, targetPath);
    const slug = subOverlaySlug(targetPath);
    assert.equal(result.path, targetPath);
    assert.equal(result.upperDir, path.join(root, "upper", "extra", slug));
    assert.equal(result.workDir, path.join(root, "work", "extra", slug));
  });
});

describe("buildMergedViewBwrapArgs()", () => {
  test("creates the merged mountpoint and overlays directory's content onto it, leaving directory itself read-only", () => {
    const args = buildMergedViewBwrapArgs({
      directory: REPO_DIR,
      overlay: { upperDir: T1_UPPER, workDir: T1_WORK },
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      mergedMountPoint: T1_MERGED,
    });
    const dirIndex = args.indexOf(DIR_FLAG);
    assert.equal(args[dirIndex + 1], T1_MERGED);
    const overlayIndex = args.indexOf(OVERLAY_SRC_FLAG);
    assert.deepEqual(args.slice(overlayIndex, overlayIndex + 6), [
      OVERLAY_SRC_FLAG, REPO_DIR,
      OVERLAY_FLAG, T1_UPPER, T1_WORK, T1_MERGED,
    ]);
    assert.ok(dirIndex < overlayIndex, "--dir must come before the --overlay line that mounts onto it");
    // runtimeDir still needs --bind, but directory itself must NOT be rw-bound
    const bindForDir = args.filter((_, i) => args[i] === BIND_FLAG && args[i + 1] === REPO_DIR).length;
    assert.equal(bindForDir, 0, "directory stays read-only (part of the root ro-bind) when writable is not set");
  });

  test("also rw-binds directory itself when writable: true", () => {
    const args = buildMergedViewBwrapArgs({
      directory: REPO_DIR,
      overlay: { upperDir: UPPER_DIR, workDir: WORK_DIR },
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      mergedMountPoint: "/tmp/merged",
      writable: true,
    });
    const bindIndex = args.indexOf(BIND_FLAG);
    assert.equal(args[bindIndex + 1], REPO_DIR);
    assert.equal(args[bindIndex + 2], REPO_DIR);
  });
});

describe("buildMergedViewBwrapArgs() byte-identical output (Task 5: post-refactor regression)", () => {
  // The two baseline arrays below were captured from the pre-refactor
  // buildMergedViewBwrapArgs() against the inputs shown. Refactoring it to
  // share buildBwrapBaseArgs() with buildBwrapArgs() must not change any
  // element of these arrays -- this is the safety net. The overlay paths
  // themselves (upperDir/workDir/mergedMountPoint, all under /tmp by
  // construction) need no shadowing protection: upper/work are consumed
  // by the kernel overlay mount(2) on host paths, and mergedMountPoint is
  // the overlayfs mount point in the new namespace -- see the JSDoc on
  // buildMergedViewBwrapArgs().
  test("writable: false (extraction) case is byte-identical to the pre-refactor output", () => {
    const args = buildMergedViewBwrapArgs({
      directory: REPO_DIR,
      overlay: { upperDir: T1_UPPER, workDir: T1_WORK },
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      mergedMountPoint: T1_MERGED,
    });
    assert.deepEqual(args, [
      RO_BIND_FLAG, ROOT_BIND, ROOT_BIND,
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", TMP_DIR,
      DIR_FLAG, T1_MERGED,
      OVERLAY_SRC_FLAG, REPO_DIR,
      OVERLAY_FLAG, T1_UPPER, T1_WORK, T1_MERGED,
      RO_BIND_FLAG, REPO_DIR, REPO_DIR,
      BIND_FLAG, RUNTIME_DIR, RUNTIME_DIR,
      "--unshare-all", "--unshare-net", "--die-with-parent",
    ]);
  });

  test("writable: true (apply) case is byte-identical to the pre-refactor output", () => {
    const args = buildMergedViewBwrapArgs({
      directory: REPO_DIR,
      overlay: { upperDir: T1_UPPER, workDir: T1_WORK },
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      mergedMountPoint: T1_MERGED,
      writable: true,
    });
    assert.deepEqual(args, [
      RO_BIND_FLAG, ROOT_BIND, ROOT_BIND,
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", TMP_DIR,
      DIR_FLAG, T1_MERGED,
      OVERLAY_SRC_FLAG, REPO_DIR,
      OVERLAY_FLAG, T1_UPPER, T1_WORK, T1_MERGED,
      BIND_FLAG, REPO_DIR, REPO_DIR,
      BIND_FLAG, RUNTIME_DIR, RUNTIME_DIR,
      "--unshare-all", "--unshare-net", "--die-with-parent",
    ]);
  });
});

describe("extractNonGitDiff()", () => {
  test("runs diff -ruN between the real directory and the merged view, writing stdout to diffPath", () => {
    let capturedArgs = null;
    const written = {};
    const runCommand = (_command, args) => {
      capturedArgs = args;
      return { status: 1, stdout: "Only in /tmp/taskferry-cow-t1/merged: newfile.txt\n", stderr: "", error: null };
    };
    const result = extractNonGitDiff({
      runCommand,
      directory: REPO_DIR,
      overlay: { root: T1_ROOT, upperDir: T1_UPPER, workDir: T1_WORK },
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      diffPath: DIFF_PATCH,
      writeFileFn: (filePath, content) => { written[filePath] = content; },
      mkdirFn: () => {},
    });
    // diff -ruN takes directory then mergedMountPoint positionally, so mergedMountPoint is last
    assert.deepEqual(capturedArgs.slice(-4), ["diff", "-ruN", REPO_DIR, T1_MERGED]);
    assert.equal(capturedArgs.at(-1), T1_MERGED);
    assert.equal(result.hasChanges, true);
    assert.equal(written[DIFF_PATCH], "Only in /tmp/taskferry-cow-t1/merged: newfile.txt\n");
  });

  test("diff -ruN exit status 0 or 1 are both success (0 = no diff, 1 = differences found)", () => {
    const runCommand = () => ({ status: 0, stdout: "", stderr: "", error: null });
    const result = extractNonGitDiff({
      runCommand,
      directory: REPO_DIR,
      overlay: { root: T1_ROOT, upperDir: UPPER_DIR, workDir: WORK_DIR },
      stateDir: STATE_DIR, runtimeDir: RUNTIME_DIR, homeDir: HOME_DIR, denyList: [],
      diffPath: DIFF_PATCH, writeFileFn: () => {}, mkdirFn: () => {},
    });
    assert.equal(result.hasChanges, false);
  });
});

describe("resolvePreDispatchHead()", () => {
  test("returns the trimmed HEAD sha for a git directory", () => {
    const runCommand = (command, args) => {
      assert.equal(command, GIT_CMD);
      assert.deepEqual(args, ["-C", REPO_DIR, "rev-parse", "HEAD"]);
      return { status: 0, stdout: "abc123\n", stderr: "", error: null };
    };
    assert.equal(resolvePreDispatchHead(REPO_DIR, runCommand), PRE_DISPATCH_HEAD);
  });

  test("returns null for a non-git directory", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository", error: null });
    assert.equal(resolvePreDispatchHead("/tmp/scratch", runCommand), null);
  });

  test("returns the empty-tree hash for a git repo with an unborn HEAD (zero commits)", () => {
    const runCommand = (_command, args) => {
      if (args.includes("HEAD")) return { status: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n", error: null };
      if (args.includes("--git-dir")) return { status: 0, stdout: ".git\n", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    assert.equal(resolvePreDispatchHead("/repo", runCommand), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

describe("extractGitDiff()", () => {
  test("remounts the overlay and runs a stage-diff-reset script anchored on preDispatchHead, writing stdout to diffPath", () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const written = {};
    const runCommand = (command, args) => {
      if (command === "git") return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      capturedCommand = command;
      capturedArgs = args;
      return { status: 0, stdout: "diff --git a/foo b/foo\n+bar\n", stderr: "", error: null };
    };
    const result = extractGitDiff({
      runCommand,
      directory: REPO_DIR,
      overlay: { upperDir: T1_UPPER, workDir: T1_WORK },
      overlayRwBinds: [],
      preDispatchHead: PRE_DISPATCH_HEAD,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      diffPath: DIFF_PATCH,
      writeFileFn: (filePath, content) => { written[filePath] = content; },
      mkdirFn: () => {},
    });
    assert.equal(capturedCommand, BWRAP_CMD);
    assert.ok(capturedArgs.includes(OVERLAY_SRC_FLAG));
    const shIndex = capturedArgs.indexOf(SH_CMD);
    assert.equal(capturedArgs[shIndex + 1], "-c");
    const script = capturedArgs[shIndex + 2];
    assert.match(script, /git -C '\/workspace\/repo' add -A/);
    assert.match(script, /git -C '\/workspace\/repo' diff --cached 'abc123'/);
    assert.match(script, /git -C '\/workspace\/repo' reset/);
    assert.match(script, /rc=\$\?/, "the script must capture the diff's own exit code");
    assert.match(script, /exit \$rc/, "the script must exit with the diff's code, not reset's");
    assert.equal(result.diffPath, DIFF_PATCH);
    assert.equal(result.hasChanges, true);
    assert.equal(written[DIFF_PATCH], "diff --git a/foo b/foo\n+bar\n");
  });

  test("reports hasChanges: false for an empty diff", () => {
    const runCommand = (command) => command === "git"
      ? { status: 0, stdout: "abc123\n", stderr: "", error: null }
      : { status: 0, stdout: "", stderr: "", error: null };
    const result = extractGitDiff({
      runCommand,
      directory: REPO_DIR,
      overlay: { upperDir: UPPER_DIR, workDir: WORK_DIR },
      overlayRwBinds: [],
      preDispatchHead: PRE_DISPATCH_HEAD,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      diffPath: DIFF_PATCH,
      writeFileFn: () => {},
      mkdirFn: () => {},
    });
    assert.equal(result.hasChanges, false);
  });

  test("re-mounts persisted rwFileBinds as scratch-copy binds so the diff sees the worker's file writes", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => {
      if (command === "git") return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    extractGitDiff({
      runCommand,
      directory: REPO_DIR,
      overlay: { upperDir: UPPER_DIR, workDir: WORK_DIR },
      overlayRwBinds: [],
      overlayRwFileBinds: [{ path: "/host/.git/packed-refs", bindSrc: "/tmp/taskferry-cow-t1/files/packed-refs-abcd1234" }],
      preDispatchHead: PRE_DISPATCH_HEAD,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      diffPath: DIFF_PATCH,
      writeFileFn: () => {},
      mkdirFn: () => {},
    });
    const idx = capturedArgs.indexOf("/tmp/taskferry-cow-t1/files/packed-refs-abcd1234");
    assert.notEqual(idx, -1, "the scratch copy must appear in the extraction bwrap args");
    assert.equal(capturedArgs[idx - 1], BIND_FLAG);
    assert.equal(capturedArgs[idx + 1], "/host/.git/packed-refs");
  });
});

describe("extraction fail-closed behavior", () => {
  const baseGitParams = {
    directory: REPO_DIR,
    overlay: { upperDir: T1_UPPER, workDir: T1_WORK },
    overlayRwBinds: [],
    preDispatchHead: PRE_DISPATCH_HEAD,
    stateDir: STATE_DIR,
    runtimeDir: RUNTIME_DIR,
    homeDir: HOME_DIR,
    denyList: [],
    diffPath: DIFF_PATCH,
  };

  test("extractGitDiff throws on a bwrap execution error and writes nothing", () => {
    let written = null;
    const runCommand = (command) => command === "git"
      ? { status: 0, stdout: "abc123\n", stderr: "", error: null }
      : { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn bwrap ETIMEDOUT"), { code: "ETIMEDOUT" }) };
    assert.throws(
      () => extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: (p) => { written = p; } }),
      /git diff extraction failed.*ETIMEDOUT/
    );
    assert.equal(written, null, "no patch file may be written for a failed extraction");
  });

  test("extractGitDiff throws on a non-zero exit status and writes nothing", () => {
    let written = null;
    const runCommand = (command) => command === "git"
      ? { status: 0, stdout: "abc123\n", stderr: "", error: null }
      : { status: 128, stdout: "", stderr: "fatal: bad revision 'abc123'\n", error: null };
    assert.throws(
      () => extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: (p) => { written = p; } }),
      /git diff extraction failed.*bad revision/
    );
    assert.equal(written, null);
  });

  test("extractGitDiff's extraction script propagates the diff's exit status, not reset's", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => {
      if (command === "git") return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      capturedArgs = args;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    const script = capturedArgs[capturedArgs.indexOf(SH_CMD) + 2];
    assert.match(script, /rc=\$\?/, "the script must capture the diff's own exit code");
    assert.match(script, /exit \$rc/, "the script must exit with the diff's code, not reset's");
  });

  test("extractGitDiff refuses to extract when the directory's HEAD moved since preDispatchHead, without invoking bwrap", () => {
    let bwrapCalled = false;
    const runCommand = (command) => {
      if (command === "git") return { status: 0, stdout: "def456\n", stderr: "", error: null };
      bwrapCalled = true;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    assert.throws(
      () => extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} }),
      /HEAD moved from 'abc123' to 'def456' since dispatch/
    );
    assert.equal(bwrapCalled, false, "extraction must never run against a directory whose HEAD has drifted");
  });

  test("extractGitDiff proceeds normally when the HEAD re-check itself can't resolve (git failure)", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => {
      if (command === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repository\n", error: null };
      capturedArgs = args;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.ok(capturedArgs, "bwrap must still run when the HEAD re-check is inconclusive rather than a confirmed drift");
    assert.equal(result.hasChanges, true);
  });

  const baseNonGitParams = {
    directory: SCRATCH_DIR,
    overlay: { root: T1_ROOT, upperDir: T1_UPPER, workDir: T1_WORK },
    stateDir: STATE_DIR,
    runtimeDir: RUNTIME_DIR,
    homeDir: HOME_DIR,
    denyList: [],
    diffPath: DIFF_PATCH,
  };

  test("extractNonGitDiff throws on a bwrap execution error", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn bwrap ENOENT") });
    assert.throws(() => extractNonGitDiff({ ...baseNonGitParams, runCommand }), /non-git diff extraction failed/);
  });

  test("extractNonGitDiff throws on diff exit status >= 2 (real failure)", () => {
    const runCommand = () => ({ status: 2, stdout: "", stderr: "diff: error reading foo\n", error: null });
    assert.throws(() => extractNonGitDiff({ ...baseNonGitParams, runCommand }), /non-git diff extraction failed.*exit 2/);
  });

  test("extractNonGitDiff treats diff exit status 1 (differences found) as success", () => {
    const runCommand = () => ({ status: 1, stdout: "diff -ru a/x b/x\n", stderr: "", error: null });
    const result = extractNonGitDiff({ ...baseNonGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.equal(result.hasChanges, true);
  });
});

describe("applyChangeset()", () => {
  test("git target: runs git apply <diffPath> against directory", () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const runCommand = (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const result = applyChangeset({
      directory: REPO_DIR,
      diffPath: DIFF_PATCH,
      isGitTarget: true,
      runCommand,
    });
    assert.equal(capturedCommand, GIT_CMD);
    assert.deepEqual(capturedArgs, ["-C", REPO_DIR, "apply", DIFF_PATCH]);
    assert.deepEqual(result, { applied: true, reason: null });
  });

  test("git target: surfaces git apply's stderr as the failure reason on conflict", () => {
    const runCommand = () => ({ status: 1, stdout: "", stderr: "error: patch does not apply\n", error: null });
    const result = applyChangeset({ directory: REPO_DIR, diffPath: DIFF_PATCH, isGitTarget: true, runCommand });
    assert.equal(result.applied, false);
    assert.match(result.reason, /patch does not apply/);
  });

  test("non-git target: rsyncs the merged overlay view onto directory inside one writable remount", () => {
    let capturedArgs = null;
    const runCommand = (_command, args) => {
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const result = applyChangeset({
      directory: SCRATCH_DIR,
      diffPath: DIFF_PATCH,
      isGitTarget: false,
      overlay: { root: T1_ROOT, upperDir: T1_UPPER, workDir: T1_WORK },
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      homeDir: HOME_DIR,
      denyList: [],
      runCommand,
    });
    assert.ok(capturedArgs.includes(DIR_FLAG));
    assert.ok(capturedArgs.includes(SCRATCH_DIR), "directory must be rw-bound for the apply's writable remount");
    const shIndex = capturedArgs.indexOf(SH_CMD);
    const script = capturedArgs[shIndex + 2];
    assert.match(script, /rsync -a --delete --delay-updates '\/tmp\/taskferry-cow-t1\/merged'\/ '\/workspace\/scratch'\//);
    assert.deepEqual(result, { applied: true, reason: null });
  });

  test("non-git target: errors usefully when required overlay inputs are missing", () => {
    assert.throws(
      () => applyChangeset({ directory: SCRATCH_DIR, diffPath: DIFF_PATCH, isGitTarget: false }),
      /non-git changeset apply requires a live overlay, stateDir, runtimeDir, homeDir, and denyList/
    );
  });
});

describe("cleanupOverlay()", () => {
  // Overlay upper/work dirs come back owned by the daemon's own uid, not an
  // unmapped namespace one (verified live against the target host, see
  // ADR 0001's corrected "Namespace-owned leftovers" entry) -- a plain
  // removal is correct, no bwrap wrapper needed.
  test("removes the task's overlay root and reports success", () => {
    let removedPath = null;
    const result = cleanupOverlay({ root: T1_ROOT, tmpRoot: TMP_DIR, rmFn: (p) => { removedPath = p; } });
    assert.equal(removedPath, T1_ROOT);
    assert.deepEqual(result, { removed: true, reason: null });
  });

  test("refuses to remove a root that is not a taskferry-cow tree under the overlay tmp root", () => {
    let removedPath = null;
    const result = cleanupOverlay({ root: "/home/user/important", tmpRoot: TMP_DIR, rmFn: (p) => { removedPath = p; } });
    assert.equal(removedPath, null);
    assert.equal(result.removed, false);
    assert.match(result.reason, /not a taskferry-cow overlay under/);
  });

  test("reports failure with the thrown error's message", () => {
    const result = cleanupOverlay({ root: T1_ROOT, tmpRoot: TMP_DIR, rmFn: () => { throw new Error("EACCES: permission denied"); } });
    assert.equal(result.removed, false);
    assert.match(result.reason, /permission denied/);
  });

  test("default rmFn includes chmod's own stderr when both chmod and rm fail", () => {
    const calls = [];
    const spawnFn = (command, _args) => {
      calls.push(command);
      if (command === "chmod") return { status: 1, stderr: "chmod: Operation not permitted (immutable flag)" };
      return { status: 1, stderr: "rm: cannot remove: Read-only file system" };
    };
    const result = cleanupOverlay({ root: "/tmp/taskferry-cow-t1", tmpRoot: "/tmp", spawnFn });
    assert.deepEqual(calls, ["chmod", "rm"]);
    assert.equal(result.removed, false);
    assert.match(result.reason, /chmod failed: chmod: Operation not permitted \(immutable flag\)/);
    assert.match(result.reason, /rm -rf failed: rm: cannot remove: Read-only file system/);
  });

  // Real overlayfs mounts leave a kernel-owned, mode-000 scratch directory at
  // workDir/work, and -- once anything in the overlay was ever deleted --
  // that directory holds an internal whiteout entry (verified live against a
  // real leftover overlay: `sudo ls -la` showed a mode-000 dir containing a
  // single char-device entry, e.g. "c--------- 1 jeremy jeremy 0, 0 ... #2d1b").
  // An *empty* mode-000 directory is removable by a same-uid `rm -rf` (GNU
  // rm's optimistic rmdir() fast path needs only the parent's permissions),
  // but a *non-empty* one forces rm to opendir()/readdir() it to remove its
  // children first, which requires read+execute on the directory itself --
  // mode 000 blocks that, so rm fails with EACCES and aborts, having already
  // deleted sibling entries like upper/. That leaves upperDir gone but
  // cleanupOverlay() reporting removed: false, so the caller never clears
  // overlayDirs -- a task now claims a live overlay whose upper/ no longer
  // exists (taskferry issue #273: "Can't find source path .../upper/main").
  // This exercises the real default rmFn (no injected fake) against that
  // exact shape.
  test("default rmFn removes a tree containing a non-empty mode-000 kernel-owned work scratch dir", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-overlay-test-"));
    const root = path.join(tmpRoot, "taskferry-cow-modetest");
    const upperDir = path.join(root, "upper", "main");
    const workScratch = path.join(root, "work", "main", "work");
    fs.mkdirSync(upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workScratch, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workScratch, "whiteout-marker"), "");
    fs.chmodSync(workScratch, 0o000);

    const result = cleanupOverlay({ root, tmpRoot });

    assert.deepEqual(result, { removed: true, reason: null });
    assert.equal(fs.existsSync(root), false);
  });
});
