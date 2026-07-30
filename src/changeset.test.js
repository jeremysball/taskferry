// src/changeset.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { overlayPaths, subOverlayPaths, subOverlaySlug } from "./changeset.js";

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
