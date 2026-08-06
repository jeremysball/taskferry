## Task 2: `resolveHeadDrift` — disposable-worktree 3-way probe

**Files:**
- Modify: `src/changeset.js` (add `resolveHeadDrift` plus small helpers, after `detectHeadDrift`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `defaultRunCommand` (existing), `detectHeadDrift` (Task 1)
- Produces: `export function resolveHeadDrift({directory, diffPath, currentHead, scratchDir, runCommand}): {recovered: boolean|null, conflictDetail: string|null}` — `recovered: true` = clean 3-way merge; `false` = genuine conflict; `null` = could not evaluate (the `git worktree add` itself failed). `conflictDetail` is `null` only when `recovered: true`.

- [ ] **Step 1: Write the failing tests**

Add to `src/changeset.test.js`, after the `detectHeadDrift()` block:

```js
describe("resolveHeadDrift()", () => {
  const CURRENT_HEAD = "def456";
  const SCRATCH_DIR = "/tmp/taskferry-stale-base-scratch";

  test("recovered: true on a clean 3-way merge (add, apply, status, remove all succeed with no conflict markers)", () => {
    const calls = [];
    const runCommand = (command, args) => {
      calls.push(args.join(" "));
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("status")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.deepEqual(result, { recovered: true, conflictDetail: null });
    assert.ok(calls.some((c) => c === `worktree add --detach ${SCRATCH_DIR} ${CURRENT_HEAD}`));
    assert.ok(calls.some((c) => c === `apply --3way ${DIFF_PATCH}`));
    assert.ok(calls.some((c) => c === "status --porcelain"));
    assert.ok(calls.some((c) => c === `worktree remove --force ${SCRATCH_DIR}`));
  });

  test("recovered: false on a genuine conflict (apply exits non-zero and status reports UU)", () => {
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 1, stdout: "", stderr: "Applied patch to 'f.txt' with conflicts.\n", error: null };
      if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "", error: null };
      if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(result.recovered, false);
    assert.match(result.conflictDetail, /conflicts/);
  });

  test("recovered: false when status reports conflict markers even though apply's own exit code was 0", () => {
    // Defensive: pin the check on git status --porcelain, not solely on
    // apply's exit code, since --3way's exit-code semantics are exactly
    // what the spec's --check correction warns not to trust blindly.
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("status")) return { status: 0, stdout: "AA g.txt\n", stderr: "", error: null };
      if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(result.recovered, false);
  });

  test("recovered: null when git worktree add itself fails (no apply attempted, could not evaluate)", () => {
    let applyAttempted = false;
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 128, stdout: "", stderr: "fatal: could not create work tree dir\n", error: null };
      if (args.includes("apply")) applyAttempted = true;
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const result = resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(result.recovered, null);
    assert.match(result.conflictDetail, /could not create work tree dir/);
    assert.equal(applyAttempted, false, "must never attempt the apply once worktree add has failed");
  });

  test("always runs worktree remove, even after a genuine conflict", () => {
    let removeRan = false;
    const runCommand = (_command, args) => {
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      if (args.includes("apply")) return { status: 1, stdout: "", stderr: "conflict\n", error: null };
      if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "", error: null };
      if (args.includes("remove")) { removeRan = true; return { status: 0, stdout: "", stderr: "", error: null }; }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.equal(removeRan, true);
  });

  test("the live directory is only ever read (worktree add's source), never written -- apply/status/remove all target scratchDir, not directory", () => {
    const targets = [];
    const runCommand = (_command, args) => {
      if (args.includes("apply") || args.includes("status")) targets.push(args[1]);
      if (args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    resolveHeadDrift({ directory: REPO_DIR, diffPath: DIFF_PATCH, currentHead: CURRENT_HEAD, scratchDir: SCRATCH_DIR, runCommand });
    assert.deepEqual(targets, [SCRATCH_DIR, SCRATCH_DIR]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "resolveHeadDrift"`
Expected: FAIL — `resolveHeadDrift` is not exported yet.

- [ ] **Step 3: Implement `resolveHeadDrift`**

In `src/changeset.js`, add after `detectHeadDrift`:

```js
// Matches a `git status --porcelain` line for any unmerged path (both
// added, both deleted, or one/both sides modified) -- the exact signature
// the spec's --check correction says is the only trustworthy way to detect
// a real conflict, since --3way --check's own exit code can't be trusted
// (see the spec's "A --check correction" section).
const CONFLICT_STATUS_PATTERN = /^(?:UU|AA|DD|AU|UD|UA|DU) /m;

/**
 * Probes whether `diffPath` (already extracted, anchored on the original
 * preDispatchHead) would forward-apply cleanly onto `currentHead` via a real
 * `git apply --3way` -- never `--check`, which cannot distinguish a clean
 * merge from a real conflict (spec "A `--check` correction"). Runs entirely
 * inside a disposable detached worktree created off the live `directory`;
 * `directory` itself is only ever read (as `worktree add`'s source) and is
 * removed unconditionally afterward, whether the merge succeeded or not.
 * @param {object} params
 * @param {string} params.directory - live directory; read-only source for the scratch worktree
 * @param {string} params.diffPath
 * @param {string} params.currentHead
 * @param {string} params.scratchDir
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @returns {{recovered: boolean|null, conflictDetail: string|null}}
 */
export function resolveHeadDrift({ directory, diffPath, currentHead, scratchDir, runCommand = defaultRunCommand }) {
  const add = runCommand("git", ["-C", directory, "worktree", "add", "--detach", scratchDir, currentHead]);
  if (add.error || add.status !== 0) {
    return { recovered: null, conflictDetail: `could not evaluate: ${gitApplyFailureReason(add)}` };
  }
  const apply = runCommand("git", ["-C", scratchDir, "apply", "--3way", diffPath]);
  const statusResult = runCommand("git", ["-C", scratchDir, "status", "--porcelain"]);
  // Unconditional cleanup regardless of outcome; a failed removal doesn't
  // change the merge outcome already computed above (it's a best-effort
  // tidy-up of a throwaway worktree, same class as cleanupOverlay's own
  // best-effort semantics elsewhere in this file).
  runCommand("git", ["-C", directory, "worktree", "remove", "--force", scratchDir]);
  const hasConflictMarkers = CONFLICT_STATUS_PATTERN.test(statusResult.stdout || "");
  if (!apply.error && apply.status === 0 && !hasConflictMarkers) {
    return { recovered: true, conflictDetail: null };
  }
  return { recovered: false, conflictDetail: gitApplyFailureReason(apply) || statusResult.stdout.trim() || null };
}
```

`gitApplyFailureReason` already exists lower in the file (used by `applyGitChangeset`) — no new helper needed for that part. Since `resolveHeadDrift` is defined above `gitApplyFailureReason`'s current position, either move `gitApplyFailureReason` above `resolveHeadDrift` or rely on function hoisting (both are `function` declarations, so hoisting already makes this safe — no reordering required).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "resolveHeadDrift"`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): add resolveHeadDrift disposable-worktree 3-way probe"
```

---

