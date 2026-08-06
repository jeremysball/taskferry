## Task 3: Wire `detectHeadDrift`/`resolveHeadDrift` into `extractGitDiff`

**Files:**
- Modify: `src/changeset.js:165-209` (`extractGitDiff`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `detectHeadDrift` (Task 1), `resolveHeadDrift` (Task 2)
- Produces: `extractGitDiff(...)` now returns `{diffPath, hasChanges, headDrift: null | {from: string, to: string, recovered: boolean|null, conflictDetail: string|null}}` and **never throws on drift** — only on a real bwrap/extraction failure, unchanged from today.

- [ ] **Step 1: Write the failing tests**

In `src/changeset.test.js`, replace the two drift-throwing tests in `describe("extraction fail-closed behavior", ...)`:

Delete:
- `"extractGitDiff refuses to extract when the directory's HEAD moved since preDispatchHead, without invoking bwrap"`
- `"extractGitDiff proceeds normally when the HEAD re-check itself can't resolve (git failure)"`
- `"extractGitDiff re-checks HEAD after the retry loop and refuses to write a diff that drifted mid-backoff"` (taskferry#329 test — the *behavior* it pinned, "don't silently write a diff anchored on a drifted HEAD," no longer applies: drift is now resolved, not silently ignored. Replace it per below.)

Replace with:

```js
  test("extractGitDiff proceeds through bwrap and writes the diff even when HEAD has drifted, reporting headDrift instead of throwing", () => {
    let bwrapCalled = false;
    let written = null;
    const runCommand = (command, args) => {
      if (command === "git") {
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "", error: null };
        if (args.includes("worktree") && args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("apply")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("status")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      }
      bwrapCalled = true;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: (p, c) => { written = { p, c }; }, mkdirFn: () => {} });
    assert.equal(bwrapCalled, true, "extraction must still run against a drifted directory, not abort");
    assert.deepEqual(written, { p: DIFF_PATCH, c: SAMPLE_DIFF_X });
    assert.deepEqual(result.headDrift, { from: PRE_DISPATCH_HEAD, to: "def456", recovered: true, conflictDetail: null });
  });

  test("extractGitDiff reports headDrift.recovered: false for a genuine conflicting drift", () => {
    const runCommand = (command, args) => {
      if (command === "git") {
        if (args.includes("rev-parse")) return { status: 0, stdout: "def456\n", stderr: "", error: null };
        if (args.includes("worktree") && args.includes("add")) return { status: 0, stdout: "", stderr: "", error: null };
        if (args.includes("apply")) return { status: 1, stdout: "", stderr: "conflict\n", error: null };
        if (args.includes("status")) return { status: 0, stdout: "UU f.txt\n", stderr: "", error: null };
        if (args.includes("remove")) return { status: 0, stdout: "", stderr: "", error: null };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      }
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.equal(result.headDrift.recovered, false);
    assert.match(result.headDrift.conflictDetail, /conflict/);
  });

  test("extractGitDiff reports headDrift: null when the HEAD re-check itself can't resolve (git failure)", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => {
      if (command === "git") return { status: 128, stdout: "", stderr: "fatal: not a git repository\n", error: null };
      capturedArgs = args;
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.ok(capturedArgs, "bwrap must still run when the HEAD re-check is inconclusive");
    assert.equal(result.headDrift, null);
  });

  test("extractGitDiff reports headDrift: null when HEAD has not moved (today's normal path)", () => {
    const runCommand = (command, args) => {
      if (command === "git") return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      return { status: 0, stdout: SAMPLE_DIFF_X, stderr: "", error: null };
    };
    const result = extractGitDiff({ ...baseGitParams, runCommand, writeFileFn: () => {}, mkdirFn: () => {} });
    assert.equal(result.headDrift, null);
  });
```

Also update the still-passing `"remounts the overlay and runs a stage-diff-reset script..."` and `"reports hasChanges: false for an empty diff"` tests (both mock `command === "git"` to return `{stdout: "abc123\n"}` for every git call) — no change needed there since `detectHeadDrift`'s single call also returns `"abc123\n"`, matching `preDispatchHead` (no drift). Confirm by reading them; if any test's `runCommand` distinguishes git calls by call count assuming exactly one `git rev-parse` invocation (the old pre-retry check), that assumption is now correct on its own — Task 3 only ever issues *one* `git rev-parse` call (this task removes the pre-retry check).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "extractGitDiff"`
Expected: FAIL — old drift tests removed/replaced don't match current throwing behavior yet; new tests fail because `headDrift` isn't returned yet.

- [ ] **Step 3: Rewire `extractGitDiff`**

In `src/changeset.js`, add `import os from "node:os";` to the top-of-file imports (alongside the existing `crypto`/`fs`/`path` imports).

Replace the body of `extractGitDiff` (lines 165-209) with:

```js
export function extractGitDiff({
  directory,
  overlay,
  overlayRwBinds,
  overlayRwFileBinds = [],
  preDispatchHead,
  stateDir,
  runtimeDir,
  homeDir,
  denyList,
  diffPath,
  runCommand = defaultRunCommand,
  writeFileFn = (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
  mkdirFn = (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }),
  sleepFn = sleepSync,
  scratchDirFn = () => path.join(os.tmpdir(), `taskferry-stale-base-${crypto.randomUUID()}`),
}) {
  const bwrapArgs = buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList, overlay, overlayRwBinds, overlayRwFileBinds });
  // The final `exit $rc` propagates the diff's own status: the previous
  // `; git reset` tail made the whole script exit with reset's status, so a
  // failed diff still reported success. reset runs first regardless (undo
  // the transient staging -- the upper already captured everything), then
  // the shell exits with the diff's code.
  const script = `git -C ${shQuote(directory)} add -A && { git -C ${shQuote(directory)} diff --cached ${shQuote(preDispatchHead)}; rc=$?; git -C ${shQuote(directory)} reset > /dev/null 2>&1; exit $rc; }`;
  const result = runExtractionBwrap(runCommand, [...bwrapArgs, "--", "sh", "-c", script], sleepFn);
  if (result.error || result.status !== 0) {
    throw new Error(`error: git diff extraction failed for ${directory} (exit ${result.status ?? "null"}): ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  // Extraction always completes and the diff is always written -- nothing
  // about the diff's content depends on live HEAD (see the module-level
  // "key insight" comment below `resolveHeadDrift`). A drift, if any, is
  // resolved here rather than aborting: a stale-base diff is still valid
  // content, `git apply --3way` exists precisely to forward-apply it.
  const drift = detectHeadDrift(directory, runCommand, preDispatchHead);
  let headDrift = null;
  if (drift) {
    const { recovered, conflictDetail } = resolveHeadDrift({ directory, diffPath, currentHead: drift.to, scratchDir: scratchDirFn(), runCommand });
    headDrift = { from: drift.from, to: drift.to, recovered, conflictDetail };
  }
  return { diffPath, hasChanges: result.stdout.trim().length > 0, headDrift };
}
```

Update the function's JSDoc (`@returns`) above it to:

```js
 * @returns {{diffPath: string, hasChanges: boolean, headDrift: null | {from: string, to: string, recovered: boolean|null, conflictDetail: string|null}}}
```

and add `@param {() => string} [params.scratchDirFn]` to the param list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "extractGitDiff|extraction fail-closed"`
Expected: PASS — all extraction tests, including the overlay-mount-busy retry tests (unaffected: they never reach the drift-detection code because their `runCommand` always returns `"abc123\n"` for git calls, matching `preDispatchHead`).

Run the full changeset unit suite to catch any other regressions:
Run: `npm test -- src/changeset.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): extractGitDiff resolves HEAD drift via 3-way instead of aborting"
```

---

