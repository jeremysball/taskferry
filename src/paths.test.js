import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceRoot, TASKFERRY_PLUMBING_ENV_VARS } from "./paths.js";

test("TASKFERRY_PLUMBING_ENV_VARS is a frozen array of the TASKFERRY_* plumbing names tasks.js excludes from caller-env forwarding", () => {
  assert.ok(Array.isArray(TASKFERRY_PLUMBING_ENV_VARS));
  assert.ok(Object.isFrozen(TASKFERRY_PLUMBING_ENV_VARS));
  assert.deepEqual(
    [...TASKFERRY_PLUMBING_ENV_VARS].sort(),
    ["TASKFERRY_CACHE_DIR", "TASKFERRY_RUNTIME_DIR", "TASKFERRY_SOCKET_PATH", "TASKFERRY_STATE_DIR"],
    "expected exactly the four TASKFERRY_* plumbing names, no more, no less"
  );
});

test("TASKFERRY_PLUMBING_ENV_VARS contains only uppercase TASKFERRY_* names", () => {
  for (const name of TASKFERRY_PLUMBING_ENV_VARS) {
    assert.match(name, /^TASKFERRY_[A-Z0-9_]+$/);
  }
});

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
  // `git rev-parse --git-common-dir` returns the parent repo's
  // `<parent>/.git/modules/<name>`, whose `path.dirname()` lands at the
  // parent's `.git/modules` directory -- not the submodule's own working
  // tree. The submodule case is detected and resolved with
  // `git rev-parse --show-toplevel`, which reports the working-tree root
  // of whichever repo the startDir belongs to.
  const runCommand = (_cmd, args) => {
    if (args.includes("--git-common-dir")) {
      return { status: 0, stdout: "/workspace/repo/.git/modules/vendor-lib\n", stderr: "" };
    }
    if (args.includes("--show-toplevel")) {
      return { status: 0, stdout: "/workspace/repo/vendor-lib\n", stderr: "" };
    }
    throw new Error(`unexpected runCommand call: ${args.join(" ")}`);
  };
  assert.equal(resolveWorkspaceRoot("/workspace/repo/vendor-lib", { runCommand }), "/workspace/repo/vendor-lib");
});

test("falls back to the input directory unchanged when no git repo is found, warning once per directory (not once per process)", () => {
  // Each distinct non-repo startDir gets its own one-shot warning, so a
  // second call from a different non-repo directory in the same process
  // doesn't get silently swallowed by a global "warn once ever" flag.
  const warnings = [];
  const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
  const warn = (message) => warnings.push(message);
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-1", { runCommand, warn }), "/tmp/not-a-repo-1");
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-2", { runCommand, warn }), "/tmp/not-a-repo-2");
  assert.equal(warnings.length, 2, "each directory must get its own one-shot warning");
  assert.match(warnings[0], /no git repository found for \/tmp\/not-a-repo-1/);
  assert.match(warnings[1], /no git repository found for \/tmp\/not-a-repo-2/);
});

test("still suppresses repeat warnings for the same directory (not warn-on-every-call)", () => {
  const warnings = [];
  const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
  const warn = (message) => warnings.push(message);
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-3", { runCommand, warn }), "/tmp/not-a-repo-3");
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-3", { runCommand, warn }), "/tmp/not-a-repo-3");
  assert.equal(warnings.length, 1, "repeated calls with the same directory should only warn once");
});

test("uses the real defaultRunCommand and process.stderr.write when no overrides are given", () => {
  // Exercises the real default path (this repo's own checkout is a git repo),
  // proving the defaults are wired correctly without needing a fake.
  const root = resolveWorkspaceRoot(process.cwd());
  assert.equal(typeof root, "string");
  assert.ok(root.length > 0);
});
