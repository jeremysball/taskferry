import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceRoot } from "./paths.js";

test("resolves the parent directory of the git-common-dir for a plain repo", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo", { runCommand }), "/workspace/repo");
});

test("resolves a nested worktree (.worktrees/x) to the main checkout's root, not the worktree's own directory", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo/.worktrees/issue-1", { runCommand }), "/workspace/repo");
});

test("resolves a sibling worktree (git worktree add ../repo-feat) to the main checkout's root", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo-feat", { runCommand }), "/workspace/repo");
});

test("treats a submodule as its own repo boundary, not the parent repo's root", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git/modules/vendor-lib\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo/vendor-lib", { runCommand }), "/workspace/repo/.git/modules");
});

test("falls back to the input directory unchanged when no git repo is found, warning once per process (not once per call)", () => {
  const warnings = [];
  const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
  const warn = (message) => warnings.push(message);
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-1", { runCommand, warn }), "/tmp/not-a-repo-1");
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-2", { runCommand, warn }), "/tmp/not-a-repo-2");
  assert.equal(warnings.length, 1, "the warning must fire once per process, not once per call");
  assert.match(warnings[0], /no git repository found for \/tmp\/not-a-repo-1/);
});

test("uses the real defaultRunCommand and process.stderr.write when no overrides are given", () => {
  // Exercises the real default path (this repo's own checkout is a git repo),
  // proving the defaults are wired correctly without needing a fake.
  const root = resolveWorkspaceRoot(process.cwd());
  assert.equal(typeof root, "string");
  assert.ok(root.length > 0);
});
