// src/changeset.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { overlayPaths, subOverlayPaths, subOverlaySlug, extractGitDiff, resolvePreDispatchHead, buildMergedViewBwrapArgs, extractNonGitDiff } from "./changeset.js";

describe("overlayPaths()", () => {
  test("builds a per-task root plus a main upper/work pair under it", () => {
    const paths = overlayPaths("oc_abc123", "/tmp");
    assert.equal(paths.root, "/tmp/taskferry-cow-oc_abc123");
    assert.equal(paths.upperDir, "/tmp/taskferry-cow-oc_abc123/upper/main");
    assert.equal(paths.workDir, "/tmp/taskferry-cow-oc_abc123/work/main");
  });
});

describe("subOverlaySlug()", () => {
  test("combines the basename with a stable short hash of the full path", () => {
    const slugA = subOverlaySlug("/workspace/main-repo/.git/worktrees/my-repo");
    const slugB = subOverlaySlug("/workspace/main-repo/.git/worktrees/my-repo");
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
    const targetPath = "/workspace/main-repo/.git/worktrees/my-repo";
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
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      mergedMountPoint: "/tmp/taskferry-cow-t1/merged",
    });
    const dirIndex = args.indexOf("--dir");
    assert.equal(args[dirIndex + 1], "/tmp/taskferry-cow-t1/merged");
    const overlayIndex = args.indexOf("--overlay-src");
    assert.deepEqual(args.slice(overlayIndex, overlayIndex + 6), [
      "--overlay-src", "/workspace/repo",
      "--overlay", "/tmp/taskferry-cow-t1/upper/main", "/tmp/taskferry-cow-t1/work/main", "/tmp/taskferry-cow-t1/merged",
    ]);
    assert.ok(dirIndex < overlayIndex, "--dir must come before the --overlay line that mounts onto it");
    // runtimeDir still needs --bind, but directory itself must NOT be rw-bound
    const bindForDir = args.filter((_, i) => args[i] === "--bind" && args[i + 1] === "/workspace/repo").length;
    assert.equal(bindForDir, 0, "directory stays read-only (part of the root ro-bind) when writable is not set");
  });

  test("also rw-binds directory itself when writable: true", () => {
    const args = buildMergedViewBwrapArgs({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/u", workDir: "/tmp/w" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      mergedMountPoint: "/tmp/merged",
      writable: true,
    });
    const bindIndex = args.indexOf("--bind");
    assert.equal(args[bindIndex + 1], "/workspace/repo");
    assert.equal(args[bindIndex + 2], "/workspace/repo");
  });
});

describe("extractNonGitDiff()", () => {
  test("runs diff -ru between the real directory and the merged view, writing stdout to diffPath", () => {
    let capturedArgs = null;
    const written = {};
    const runCommand = (command, args) => {
      capturedArgs = args;
      return { status: 1, stdout: "Only in /tmp/taskferry-cow-t1/merged: newfile.txt\n", stderr: "", error: undefined };
    };
    const result = extractNonGitDiff({
      directory: "/workspace/repo",
      overlay: { root: "/tmp/taskferry-cow-t1", upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      diffPath: "/state/diffs/t1.patch",
      runCommand,
      writeFileFn: (filePath, content) => { written[filePath] = content; },
      mkdirFn: () => {},
    });
    // diff -ru takes directory then mergedMountPoint positionally, so mergedMountPoint is last
    assert.deepEqual(capturedArgs.slice(-4), ["diff", "-ru", "/workspace/repo", "/tmp/taskferry-cow-t1/merged"]);
    assert.equal(capturedArgs.at(-1), "/tmp/taskferry-cow-t1/merged");
    assert.equal(result.hasChanges, true);
    assert.equal(written["/state/diffs/t1.patch"], "Only in /tmp/taskferry-cow-t1/merged: newfile.txt\n");
  });

  test("diff -ru exit status 0 or 1 are both success (0 = no diff, 1 = differences found)", () => {
    const runCommand = () => ({ status: 0, stdout: "", stderr: "", error: undefined });
    const result = extractNonGitDiff({
      directory: "/workspace/repo",
      overlay: { root: "/tmp/taskferry-cow-t1", upperDir: "/tmp/u", workDir: "/tmp/w" },
      stateDir: "/state", runtimeDir: "/state/run", homeDir: "/home/user", denyList: [],
      diffPath: "/state/diffs/t1.patch", runCommand, writeFileFn: () => {}, mkdirFn: () => {},
    });
    assert.equal(result.hasChanges, false);
  });
});

describe("resolvePreDispatchHead()", () => {
  test("returns the trimmed HEAD sha for a git directory", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", "/workspace/repo", "rev-parse", "HEAD"]);
      return { status: 0, stdout: "abc123\n", stderr: "", error: undefined };
    };
    assert.equal(resolvePreDispatchHead("/workspace/repo", runCommand), "abc123");
  });

  test("returns null for a non-git directory", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository", error: undefined });
    assert.equal(resolvePreDispatchHead("/tmp/scratch", runCommand), null);
  });

  test("returns the empty-tree hash for a git repo with an unborn HEAD (zero commits)", () => {
    const runCommand = (command, args) => {
      if (args.includes("HEAD")) return { status: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n", error: undefined };
      if (args.includes("--git-dir")) return { status: 0, stdout: ".git\n", stderr: "", error: undefined };
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
      capturedCommand = command;
      capturedArgs = args;
      return { status: 0, stdout: "diff --git a/foo b/foo\n+bar\n", stderr: "", error: undefined };
    };
    const result = extractGitDiff({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      overlayRwBinds: [],
      preDispatchHead: "abc123",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      diffPath: "/state/diffs/t1.patch",
      runCommand,
      writeFileFn: (filePath, content) => { written[filePath] = content; },
      mkdirFn: () => {},
    });
    assert.equal(capturedCommand, "bwrap");
    assert.ok(capturedArgs.includes("--overlay-src"));
    const shIndex = capturedArgs.indexOf("sh");
    assert.equal(capturedArgs[shIndex + 1], "-c");
    const script = capturedArgs[shIndex + 2];
    assert.match(script, /git -C '\/workspace\/repo' add -A/);
    assert.match(script, /git -C '\/workspace\/repo' diff --cached 'abc123'/);
    assert.match(script, /git -C '\/workspace\/repo' reset/);
    assert.match(script, /rc=\$\?/, "the script must capture the diff's own exit code");
    assert.match(script, /exit \$rc/, "the script must exit with the diff's code, not reset's");
    assert.equal(result.diffPath, "/state/diffs/t1.patch");
    assert.equal(result.hasChanges, true);
    assert.equal(written["/state/diffs/t1.patch"], "diff --git a/foo b/foo\n+bar\n");
  });

  test("reports hasChanges: false for an empty diff", () => {
    const runCommand = () => ({ status: 0, stdout: "", stderr: "", error: undefined });
    const result = extractGitDiff({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/u", workDir: "/tmp/w" },
      overlayRwBinds: [],
      preDispatchHead: "abc123",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      diffPath: "/state/diffs/t1.patch",
      runCommand,
      writeFileFn: () => {},
      mkdirFn: () => {},
    });
    assert.equal(result.hasChanges, false);
  });
});

describe("extraction fail-closed behavior", () => {
  const baseGitParams = {
    directory: "/workspace/repo",
    overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
    overlayRwBinds: [],
    preDispatchHead: "abc123",
    stateDir: "/state",
    runtimeDir: "/state/run",
    homeDir: "/home/user",
    denyList: [],
    diffPath: "/state/diffs/t1.patch",
  };

  test("extractGitDiff throws on a bwrap execution error and writes nothing", () => {
    let written = null;
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn bwrap ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    assert.throws(
      () => extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: (p) => { written = p; } }),
      /git diff extraction failed.*ETIMEDOUT/
    );
    assert.equal(written, null, "no patch file may be written for a failed extraction");
  });

  test("extractGitDiff throws on a non-zero exit status and writes nothing", () => {
    let written = null;
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: bad revision 'abc123'\n", error: undefined });
    assert.throws(
      () => extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: (p) => { written = p; } }),
      /git diff extraction failed.*bad revision/
    );
    assert.equal(written, null);
  });

  test("extractGitDiff's extraction script propagates the diff's exit status, not reset's", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => { capturedArgs = args; return { status: 0, stdout: "diff --git a/x b/x\n", stderr: "", error: undefined }; };
    extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    const script = capturedArgs[capturedArgs.indexOf("sh") + 2];
    assert.match(script, /rc=\$\?/, "the script must capture the diff's own exit code");
    assert.match(script, /exit \$rc/, "the script must exit with the diff's code, not reset's");
  });

  const baseNonGitParams = {
    directory: "/workspace/scratch",
    overlay: { root: "/tmp/taskferry-cow-t1", upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
    stateDir: "/state",
    runtimeDir: "/state/run",
    homeDir: "/home/user",
    denyList: [],
    diffPath: "/state/diffs/t1.patch",
  };

  test("extractNonGitDiff throws on a bwrap execution error", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn bwrap ENOENT") });
    assert.throws(() => extractNonGitDiff({ ...baseNonGitParams, runCommand }), /non-git diff extraction failed/);
  });

  test("extractNonGitDiff throws on diff exit status >= 2 (real failure)", () => {
    const runCommand = () => ({ status: 2, stdout: "", stderr: "diff: error reading foo\n", error: undefined });
    assert.throws(() => extractNonGitDiff({ ...baseNonGitParams, runCommand }), /non-git diff extraction failed.*exit 2/);
  });

  test("extractNonGitDiff treats diff exit status 1 (differences found) as success", () => {
    const runCommand = () => ({ status: 1, stdout: "diff -ru a/x b/x\n", stderr: "", error: undefined });
    const result = extractNonGitDiff({ ...baseNonGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.equal(result.hasChanges, true);
  });
});
