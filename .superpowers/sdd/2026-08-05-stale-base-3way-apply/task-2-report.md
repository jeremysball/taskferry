# Task 2 report — `resolveHeadDrift` disposable-worktree 3-way probe

## What I changed

- **`src/changeset.js`** (+42 lines, now 592 total)
  - Added `CONFLICT_STATUS_PATTERN` — a module-private regex matching
    unmerged `git status --porcelain` lines (`UU/AA/DD/AU/UD/UA/DU`).
    Pinned to `git status --porcelain` (not `git apply --3way`'s exit
    code) per the spec's "A `--check` correction" warning: --3way's own
    status can't be trusted to distinguish a clean merge from a real
    conflict.
  - Added exported `resolveHeadDrift({ directory, diffPath, currentHead,
    scratchDir, runCommand })`. It creates a detached worktree at
    `scratchDir` off the live `directory`'s `currentHead`, runs
    `git apply --3way diffPath` inside that scratch tree, inspects
    `git status --porcelain` for unmerged paths, then removes the
    scratch worktree unconditionally (whether the merge was clean, a
    conflict, or even if `worktree add` itself failed). Returns
    `{recovered: true, conflictDetail: null}` on a clean merge,
    `{recovered: false, conflictDetail}` on a real conflict (decided by
    conflict markers, not apply's exit code), or
    `{recovered: null, conflictDetail}` when `worktree add` itself
    failed — no apply attempted in that case.
  - The live `directory` is only read (as `worktree add`'s source); all
    write traffic targets `scratchDir`. The brief's contract — and the
    spec's "disposable worktree" framing — relies on this; the
    `apply`/`status`/`remove` calls all use `-C scratchDir` (apply,
    status) or `-C directory` (add, remove, which only reference the
    live directory as the source repo).
  - References `gitApplyFailureReason` (defined later in the file) for
    its failure-reason strings; safe via function hoisting (both are
    `function` declarations).
- **`src/changeset.test.js`** (+88 lines, now 861 total)
  - Added `resolveHeadDrift` to the existing `import { ... } from
    "./changeset.js"` line.
  - Added the `resolveHeadDrift()` describe block after the
    `detectHeadDrift()` block, with all 6 test cases from the brief
    (clean merge, genuine conflict, status-marker-without-apply-failure,
    worktree-add failure, unconditional cleanup, live-directory-read-only).
  - **One deviation from the brief's verbatim test**: the first test's
    arg-shape assertions (`assert.ok(calls.some((c) => c ===
    'worktree add --detach ...'))`) used strict equality against
    `args.join(" ")`. The brief's implementation passes args including
    the `-C <directory>` / `-C <scratchDir>` prefix required to target
    each git invocation at the right repo (matching the
    `resolvePreDispatchHead` convention in the same file, and the only
    way `args[1]` in the second test can equal `SCRATCH_DIR`). With
    those prefixes in args, the joined string never equals the bare
    `worktree add --detach ...` form. I changed `===` to
    `.includes(...)` on those four assertions — same intent (verify
    those specific commands were called) without forcing an
    internally-inconsistent test/implementation pair. Documented here
    as a concern.
  - Renamed the unused `command` parameter to `_command` in the
    `runCommand` mock for the first test to satisfy
    `sonarjs/no-unused-function-argument` (the rest of the file uses
    the same convention).
- **`docs/sourcemap.md`**
  - Updated the `changeset.js` row: line count `540 → 592`; replaced
    the stale `assertNoHeadDrift()` reference (left over after Task 1)
    with `detectHeadDrift()`, and added a sentence summarizing
    `resolveHeadDrift()`'s role in the drift-resolution pipeline (Task
    3 will wire it into `extractGitDiff()`).

## What I did not touch

- `extractGitDiff()` and its two `detectHeadDrift` call sites — per the
  brief, those stay as-is until Task 3 rewires them.
- `defaultRunCommand` — unchanged; `resolveHeadDrift` accepts an
  injected `runCommand` like every other testable function in the file.
- `gitApplyFailureReason` — unchanged; reused via function hoisting.

## Test commands and results

- `env -u TASKFERRY_CHILD node --test src/changeset.test.js`
  - **Before implementation** (Step 2): file fails to load with
    `SyntaxError: The requested module './changeset.js' does not
    provide an export named 'resolveHeadDrift'` — exactly the brief's
    expected "FAIL — resolveHeadDrift is not exported yet" failure
    mode.
  - **After implementation** (Step 4, final): `tests 50, pass 50,
    fail 0`. The 6 new `resolveHeadDrift()` tests pass alongside the
    44 pre-existing tests in this file.
- `env -u TASKFERRY_CHILD node --test --test-name-pattern="resolveHeadDrift" src/changeset.test.js`
  - All 6 resolveHeadDrift tests pass.
- `env -u TASKFERRY_CHILD node --test src/changeset.integration.test.js`
  - `tests 4, pass 4, fail 0`. Unaffected.
- `npm test` (full suite)
  - `tests 984, pass 980, fail 4`. The 4 failures are pre-existing
    and unrelated to this task — I verified by `git stash`-ing my
    changes and re-running: the same 4 tests fail on `main`
    (`client.js's direct-execution guard runs ensureDaemonStarted()
    when invoked through a symlink`, `TASKFERRY_TASK_ID is absent from
    summary spawns`, `ro-binds the real opencode auth.json into the
    sandboxed XDG_DATA_HOME when it exists`, and `leaves XDG_DATA_HOME
    untouched when sandboxing is disabled`).
- `npm run lint` — clean.
- `npm run typecheck` — clean.

## Commits

- `0054c6d` — `feat(changeset): add resolveHeadDrift disposable-worktree 3-way probe`
  (src/changeset.js, src/changeset.test.js, docs/sourcemap.md; 3 files,
  +132 / -2)

## Concerns

- **Brief's first test had a strict-equality assertion that conflicts
  with its own implementation's `-C` args.** The test asserts
  `calls.some((c) => c === 'worktree add --detach ...')` against
  `args.join(" ")`, but the implementation passes args as `["-C",
  directory, "worktree", "add", ...]`, so the joined string never
  equals the bare subcommand form. The other 5 tests in the same
  describe block consistently assume the `-C` style (e.g. the
  "live-directory-read-only" test asserts `args[1] === SCRATCH_DIR`,
  which only holds when args starts with `["-C", SCRATCH_DIR, ...]`).
  I resolved this by changing `===` to `.includes(...)` on the four
  arg-shape assertions in the first test — minimal change, preserves
  intent. If the brief author intended the implementation to skip
  `-C` (e.g. by adding cwd to `defaultRunCommand`'s spawn options),
  that's a much larger change spanning both this function and the
  shared runner, and the brief didn't ask for it. The current
  resolution is the smallest diff that makes all 6 tests pass while
  keeping the implementation consistent with the existing
  `resolvePreDispatchHead` / `extractGitDiff` conventions in the same
  file.
- **`gitApplyFailureReason(add)` reused for the worktree-add
  failure path.** The brief specifies
  `` `could not evaluate: ${gitApplyFailureReason(add)}` ``. The
  helper's wording ("git apply exited with status N") is slightly
  inaccurate when reused for a failed `worktree add` — but the
  surrounding `could not evaluate:` prefix and the test's
  `/could not create work tree dir/` regex match the actual `stderr`
  text, so the user-visible error is correct. Worth flagging if
  anyone cares about a tighter error message; not worth a follow-up
  on its own.
- **`detectHeadDrift` doc-comment still references `resolveHeadDrift`
  but does not link to a file/line.** Pre-existing in Task 1's
  commit; left alone.
