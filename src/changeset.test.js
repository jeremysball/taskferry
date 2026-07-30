// src/changeset.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { overlayPaths, subOverlayPaths, subOverlaySlug, extractGitDiff, resolvePreDispatchHead } from "./changeset.js";

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
