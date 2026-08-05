# Task 2 report — Task schema + RPC/CLI wiring for the new fields

## What I implemented

Wired every new schema field (`checkStatus`/`checkCommand`/`checkExitCode`/
`checkOutputTail`/`checkStartedAt`/`checkEndedAt`/`checkOverride`/
`projectConfigWarning`/`parentTaskId`/`checkGatePid`) and every new CLI/RPC
flag (`--parent-task`, `--force`) end-to-end through dispatch → daemon →
manager → result/summary, following the exact same pattern the existing
`--class`/`class` field already uses (Step 1-9 of the brief). No gate
behavior yet — Task 5/6 add that. Every new field defaults to its neutral
value (`checkStatus: "none"`, `parentTaskId: null`, `checkGatePid: null`,
etc.) so existing dispatch paths are unaffected. The `acceptTaskChangeset`
signature change (Step 9) and every caller binding that depends on it
landed atomically in the same commit so the unit suite proves the plumbing
is correct as its own change.

**Files modified:**

- `src/tasks.js` (5294 → 5437 lines, +143)
  - `Task` / `TaskSummary` / `ResultDetail` typedefs (Step 1): added
    `parentTaskId`/`checkStatus`/`checkCommand`/`checkExitCode`/
    `checkOutputTail`/`checkStartedAt`/`checkEndedAt`/`checkOverride`/
    `projectConfigWarning`/`checkGatePid` (`checkGatePid` only on Task
    itself, not ResultDetail — it stays an internal field for the
    gate runner and Task 7's restart-recovery sweep, never surfaced).
  - `buildDispatchTask` (Step 2): `parentTaskId?: string|null` in its
    `@param`, default `null` in the destructure, full default block on
    the returned task record (per the brief's spec verbatim).
  - `dispatchTask`/`dispatchAdvisorTask`/`runAdvisor` (Step 3):
    `parentTaskId` added to each `@param`/destructure/`buildDispatchTask`
    call/`ctx.dispatch({...})` call, with `parentTaskId = null` default
    and shorthand-property ordering kept under sonarjs
    `shorthand-property-grouping` (shorthand properties — including
    `parentTaskId` and the existing `class: taskClass` non-shorthand —
    placed at the start of each object literal).
  - `summarizeOptionalFields` / `computeResultDetail` (Step 4): both
    surface the new fields. `checkOutputTail` deliberately stays out of
    the lean summary; in `computeResultDetail` it's gated on the
    caller's `fields` selection (large payload, opt-in via
    `--fields checkOutputTail` or `--full`).
  - `accept`/`reject` factory bindings + public API `accept` (Step 9):
    factory bindings now accept `(taskId, options)` and forward
    `options` to `acceptTaskChangeset`; the public API's
    `accept(taskId, options)` delegates to the helpers closure the same
    way. `reject` factory binding also threads `killGateAndWait`
    through so Task 6's in-flight-gate kill handshake can `await
    ctx.killGateAndWait(taskId)` without Task 6 having to re-edit the
    binding.
  - `acceptTaskChangeset` signature (Step 9, the load-bearing plumbing
    change the brief warns about): `function acceptTaskChangeset(taskId,
    ctx, _options = {})` — parameter order is `(taskId, ctx, options)`
    rather than the brief's literal `(taskId, { force = false } = {},
    ctx)` because the latter hit TypeScript's TS1016 "a required
    parameter cannot follow an optional parameter" error (ctx is
    required; the original `force` default made `options` optional).
    See Deviations below for the reasoning.
  - `buildManagerEnvHelpers` (Step 9's `killGateAndWait` stub):
    added `killGateAndWait: async (_taskId) => undefined` so the
    factory binding's `ctx.env.killGateAndWait(taskId2)` resolves
    without a TS2353 "object literal may only specify known
    properties" error. The brief said the supervisor lands in Task 6;
    this stub is the no-op stand-in so the type plumbing checks out
    today.

- `src/protocol.js` (407 → 418 lines, +11)
  - `RESULT_FIELDS`: added `checkStatus`/`checkCommand`/`checkExitCode`/
    `checkOutputTail`/`checkStartedAt`/`checkEndedAt`/`checkOverride`/
    `parentTaskId`/`projectConfigWarning` after `changesetError` (Step
    5, verbatim).
  - `METHOD_PARAMS["task.dispatch"].optional`: added `["parentTaskId",
    isNonEmptyString]`. Identical addition to `task.advisor`.optional.
    `task.accept`.optional: changed from `[]` to
    `[["force", isBoolean]]`. (`task.reject` deliberately stays
    `optional: []` — force-override is accept-only, per the brief.)

- `src/args.js` (397 → 399 lines, +2)
  - `FLAGS` (Step 6):
    ```js
    "--parent-task": { allow: ["dispatch", "advisor"], key: "parentTaskId" },
    ```
    and
    ```js
    "--force": { allow: ["accept"], bool: true },
    ```
  - `DEFAULT_OPTIONS.accept` now resolves through `flagDefaultsFor()`
    so `force: false` appears in the default shape (Step 6 verbatim).

- `src/command-specs.js` (109 → 110 lines, +1)
  - `dispatch.options`: added `"--parent-task <id>"` doc line and a
    matching `dispatch` example (`'taskferry dispatch --prompt "Fix:
    check gate failed" --parent-task oc_msgabc12'`). Identical
    `--parent-task <id>` and example addition to `advisor.options`.
  - `accept.options`: changed from `{}` to
    `{ "--force": "apply the changeset even though its check gate
    failed, timed out, is still running, or was interrupted by a
    daemon restart; records checkOverride: true" }` plus an
    `examples` entry for `'taskferry accept <id> --force'`.

- `src/commands.js` (482 → 483 lines, +1)
  - `DISPATCH_PASSTHROUGH_KEYS`: added `"parentTaskId"` (Step 8, line
    149 in the source).
  - `runAccept` now reads `{ taskId: options.taskId, ...(options.force
    === true && { force: true }) }` — `force: true` is forwarded only
    when the CLI flag was actually set (avoids the
    `METHOD_PARAMS["task.accept"]` validator's strict `isBoolean`
    rejection on `force: false` from a clean RPC path).

- `src/daemon.js` (503 lines, ±1)
  - `invokeHandlers["task.accept"]`: now reads `manager.accept(params
    .taskId, { force: params.force === true })` (Step 9 verbatim). This
    is the only daemon.js change — `task.dispatch`/`task.advisor` ride
    through unchanged because both already forward the whole
    validated params object to `manager.dispatch`.

- `src/output.js` (321 → 343 lines, +22)
  - `leanStatus` (Step 9b): surfaces `checkStatus`/`checkCommand`/
    `checkExitCode`/`checkStartedAt`/`checkEndedAt`/`checkOverride`
    when `checkStatus !== "none"`, and `projectConfigWarning` when
    set. Extracted into a `leanCheckGateFields()` helper (per the
    `summarizeCheckGateFields` / `resultCheckGateFields` split in
    `tasks.js`) so `leanStatus`'s own cyclomatic count stays under the
    sonarjs ceiling — see Deviations.

- `src/daemon.test.js` (952 → 958 lines, +6)
  - Updated the fake manager's `accept` from `(taskId) => ...` to
    `(taskId, options) => ...`, and updated the assertion in
    `"task.accept"` to `["accept", "t1", { force: false }]` — the
    default `force: false` is what protocol.js's `isBoolean` validator
    sees after the daemon forwards it; Task 6's `force: true`
    override path will hit the same shape with `true`.

- `src/args.test.js` (522 → 565 lines, +43) — 6 new tests:
  - `"parses dispatch and applies its argument defaults"` updated to
    include `parentTaskId: void 0` in the expected defaults shape.
  - `"dispatch accepts --parent-task and stores it under
    parentTaskId"` — extract `PARENT_TASK_FLAG` /
    `PARENT_TASK_ID` constants to keep sonarjs `no-duplicate-string`
    happy across the four tests that use them.
  - `"advisor accepts --parent-task and stores it under
    parentTaskId"` — same constant-driven pair.
  - `"accept defaults to force: false and accepts --force"` — proves
    the `flagDefaultsFor("accept")` change surfaces `force: false` in
    the default shape, and that `--force` flips it to `true`.
  - `"dispatch rejects --force"` — negative case: `--force` is only
    allowed on `accept`.
  - `"dispatch rejects --parent-task on accept"` / `"accept rejects
    --parent-task"` — negative pair: `--parent-task` is only allowed
    on `dispatch`/`advisor`.

- `src/output.test.js` (461 → 538 lines, +77) — 5 new tests:
  - `"leanStatus surfaces a non-default checkStatus without --full"`.
  - `"leanStatus surfaces checkOverride only when set"`.
  - `"leanStatus omits checkStatus fields when checkStatus is the
    default 'none'"`.
  - `"leanStatus surfaces a projectConfigWarning when set"`.
  - `"leanStatus omits projectConfigWarning when unset"`.

- `src/protocol.test.js` (488 → 500 lines, +12) — 2 new tests:
  - `"accepts task.accept with force: true"` — proves the new
    `force: isBoolean` validator passes a valid boolean.
  - `"rejects task.accept with non-boolean force"` — proves the same
    validator rejects `force: "yes"`.

- `docs/sourcemap.md` (12-row update + 3 new "Where do I look for X"
  rows)
  - Updated line counts for all 11 modified files.
  - Added a note to the `args.js` row flagging `--parent-task` and
    `--force` (alongside the existing `--class` mention).
  - Added a note to the `commands.js` row flagging `parentTaskId`
    forwarding on `dispatch`/`advisor` and `force` forwarding on
    `accept`.
  - Added a note to the `daemon.js` row flagging `task.accept`'s
    `force` forwarding.
  - Added a note to the `protocol.js` row flagging `parentTaskId`/
    `force` and the new `RESULT_FIELDS` allow-list entries.
  - Added a note to the `output.js` row flagging the `checkStatus` /
    `projectConfigWarning` lean-status surfacing and the
    `leanCheckGateFields()` helper split.
  - Three new "Where do I look for X?" rows: `--parent-task`
    validation/persistence/surfacing, `--force` end-to-end wiring,
    and the check-gate fields' projection through result/status.

## Test command + output summary

```
$ env -i HOME="$HOME" PATH="$PATH" env -u TASKFERRY_CHILD \
    env -u TASKFERRY_STATE_DIR -u TASKFERRY_RUNTIME_DIR \
    env -u TASKFERRY_CACHE_DIR -u TASKFERRY_TASK_ID \
    env -u TASKFERRY_SOCKET_PATH -u TASKFERRY_DEV_ROOT \
    npm run test:unit
ℹ tests 994
ℹ suites 153
ℹ pass 994
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14386
```

994/994 pass — 13 of those are the new tests (6 args, 5 output, 2
protocol), the remaining 981 are the pre-existing suite with no
regressions introduced. The full `npm run check` (syntax via
`node --check` on every committed JS file, then `eslint .`, then `tsc
--noEmit`) is clean:

```
$ env -i ... bash -c \
    'git ls-files "*.js" | xargs -P4 -I{} node --check {} \
     && /workspace/taskferry/node_modules/.bin/eslint . \
     && /workspace/taskferry/node_modules/.bin/tsc --noEmit'
$ echo $?
0
```

CLI smoke test (real `node src/cli.js`, no daemon involved) confirms the
new flags round-trip through the help text:

```
$ node src/cli.js dispatch --help | grep -A1 parent-task
  "--parent-task <id>": "tag this dispatch as fixing/retrying an
  earlier task; persisted as parentTaskId, and echoed by that task's
  check-gate failure message"
... "taskferry dispatch --prompt \"Fix: check gate failed\"
       --parent-task oc_msgabc12"

$ node src/cli.js accept --help | grep -A1 force
  "--force": "apply the changeset even though its check gate failed,
  timed out, is still running, or was interrupted by a daemon restart;
  records checkOverride: true"
... taskferry accept <id> --force
```

## Concerns / deviations from the brief

Four deviations, all benign and following existing precedent:

1. **`acceptTaskChangeset` parameter order** — the brief specifies
   `acceptTaskChangeset(taskId, { force = false } = {}, ctx)` (options
   second, ctx third). I reordered to
   `acceptTaskChangeset(taskId, ctx, _options = {})` (ctx second,
   options third). The reason is TypeScript's TS1016 error: a required
   parameter cannot follow an optional one, and `ctx` is required. The
   brief's `force = false` default makes `options` technically
   optional, which the TS compiler rejects when paired with the
   required `ctx` parameter. The JSDoc `@param` order was rewritten to
   match (`ctx` second, `_options` third, with `_options` prefix
   because the function body still ignores the option until Task 6
   consumes it — matches the brief's `_force` precedent for the
   original 2-arg form). This is the literal plumbing change the
   brief warns about ("threading a new positional `options` through
   every caller"); the function body is unchanged from the brief's
   intent, only the slot the options object lands in moves from
   position 2 to position 3 to satisfy TS.

2. **`acceptTaskChangeset` option parameter name** — the brief
   destructures `{ force = false }` (unused until Task 6, hence the
   brief's `_force` rename later). I destructured `_options = {}`
   instead, because renaming the object parameter to `_options` makes
   the "this is plumbed but not yet consumed" intent visible at the
   call-site without needing the inner field rename. Every factory
   binding and the daemon's `invokeHandlers["task.accept"]` still
   forward the same `{ force: ... }` shape; only the receiving end
   is the underscore-prefixed placeholder until Task 6 starts
   consuming it.

3. **`computeResultDetail`/`summarizeOptionalFields`/`leanStatus`
   complexity ceiling** — the brief's Step 4/Step 9b adds 2-3 new
   conditional spreads per function, which lifts each function above
   the project's sonarjs `cyclomatic-complexity` cap (10) and the
   `complexity` cap (15). I extracted three helpers from
   `summarizeOptionalFields` (`summarizeCompletionFields`/
   `summarizeExecutionFields`/`summarizeCheckGateFields`), one
   helper from `computeResultDetail` (`resultCheckGateFields`), and
   one helper from `leanStatus` (`leanCheckGateFields`). Each helper
   carries the brief's verbatim conditional-spread shape; the parent
   functions now delegate to them and stay under both caps. This
   follows the existing precedent in
   `summarizeOptionalFields` itself, which already had a
   `summarizeChangesetField()` helper extracted for the same
   reason (see the file's existing comment about the
   `changesetStatus` conditional spread).

4. **`sonarjs/no-duplicate-string` in the new tests** — the new
   args tests have four `parseArgs([...])` calls each starting with
   the same string literal, and the new output tests have seven
   `startedAt: "..."` literals. Both flagged by sonarjs. I extracted
   shared constants (`PARENT_TASK_ID`/`PARENT_TASK_FLAG`/`TASK_STARTED_AT`)
   at the top of each test file, matching the file's existing
   constant-extraction convention (`OCCURRED_AT_MID`,
   `TASK_STARTED_AT_EXAMPLE`, `TASK_MODEL_SOL`, etc.).

The full `npm run check` (syntax + lint + typecheck) is green, the
full `npm run test:unit` is green (994/994), and the new CLI flags
are documented in `taskferry dispatch --help` and
`taskferry accept --help`.

No infrastructure incident this round — `node_modules` is a real
directory with 74 package symlinks (Task 1's setup) plus a real
`smol-toml@1.6.1` copy, so this work didn't have to fight the
EROFS/read-only-fs npm-install landmine that the prior attempt
tripped on. The full suite was run under `env -i HOME=... PATH=...`
with `TASKFERRY_*` redirected under
`/tmp/taskferry-dev-check-gate-pc/` per CLAUDE.md's "Isolate your own
taskferry runs" guidance, so cross-session state-dir pollution
couldn't land here either.

## Commit hash

```
370c0d8 feat(tasks): add check-gate/parentTaskId schema and CLI/RPC wiring
```

On branch `check-gate-project-config`, parent `29be084` (Task 1's
ledger-update commit). The `feat(tasks):` commit message in the brief
("add check-gate/parentTaskId schema and CLI/RPC wiring") was
followed verbatim except the `git add -A` in the brief was replaced
with an explicit `git add <files>` so the unrelated
`docs/sourcemap.md` row updates land in the same commit (per
CLAUDE.md's "Keep the sourcemap up to date" instruction: any commit
that changes `src/` and adds new exported fields needs the sourcemap
updated in the same PR). The report file itself also lands in this
commit.

Status: DONE