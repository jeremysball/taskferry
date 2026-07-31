# CoW sandbox design: overlay writes, diff-gated apply

Implements ADR 0001 (`docs/adr/0001-cow-overlays-and-diff-gated-writes.md`).
Read that first — this spec doesn't re-argue any locked decision from it
(see the ADR's own "do not re-litigate" list), only resolves the mechanism
below the decision line: exact function signatures, config keys, CLI
surface, and file-by-file changes an implementation plan can be written
from directly.

## Scope

Every sandboxed ferry (dispatch or advisor) gets a copy-on-write overlay
instead of a plain read-write bind on its target directory. Writes land in
a per-task upper layer, not the real tree. On exit, taskferry extracts a
diff from that upper. A dispatch's diff is gated behind an explicit
`taskferry accept`/`taskferry reject`; an advisor's diff is always
discarded (informational only — advisors have no accept path). Out of
scope: worktree creation (ADR decision 3 — stays a skill-layer choice,
taskferry core doesn't create worktrees), any change to `--allowed-dirs`
semantics, and the pi executor's missing-command-input audit gap (§11,
routed to its own issue).

## Terminology

- **lower** — the real target directory (`launchDirectory` in
  `tasks.js`), unchanged by the overlay by construction.
- **upper** — `/tmp/taskferry-cow-<task-id>/upper`, where all sandboxed
  writes/deletes actually land.
- **work** — `/tmp/taskferry-cow-<task-id>/work`, overlayfs's required
  scratch dir; never inspected directly.
- **changeset** — the diff taskferry extracts from upper at process exit,
  cached to disk, independent of whether the sandboxed process is still
  "running" in the task-status sense.
- **role** — `"dispatch"` (implementer, changeset is accept/reject-gated)
  or `"advisor"` (changeset is always discarded, exposed read-only for
  debugging).

## 1. `buildBwrapArgs()` overlay variant

`src/sandbox.js:142` currently emits one line for the target directory:
`args.push("--bind", directory, directory)`. Replace it with a conditional:

```js
export function buildBwrapArgs({
  directory,
  stateDir,
  runtimeDir,
  homeDir,
  denyList = defaultDenyList(homeDir, stateDir),
  extraRwBinds = [],
  extraRwPairBinds = [],
  extraRoBinds = [],
  overlay,        // new: { upperDir: string, workDir: string } | undefined
  shareNet = true, // new: see §6
}) {
  ...
  if (overlay) {
    args.push("--overlay-src", directory, "--overlay", overlay.upperDir, overlay.workDir, directory);
  } else {
    args.push("--bind", directory, directory);
  }
  ...
  args.push("--unshare-all", shareNet ? "--share-net" : "--unshare-net", "--die-with-parent");
  return args;
}
```

Argument order is `RWSRC WORKDIR DEST` per the ADR's verified evidence.
`overlay` is optional and undefined by default so every existing
`buildBwrapArgs()` caller/test that doesn't pass it keeps today's plain
bind — no behavior change for callers that don't opt in yet (summary
children, per §6.1, never opt in).

### 1.1 Capability check

New `checkOverlaySupport()` in `sandbox.js`, parsing the version string
`checkBwrapAvailable()`'s probe already returns (`bwrap --version` prints
`bubblewrap X.Y.Z`) and comparing against a `0.8.0` floor:

```js
export function parseBwrapVersion(stdout) { /* regex \d+\.\d+\.\d+ -> [maj,min,patch] or null */ }
export function checkOverlaySupport(runCommand = defaultRunCommand) {
  const probe = checkBwrapAvailable(runCommand);
  if (!probe.available) return { supported: false, reason: probe.reason };
  const version = parseBwrapVersion(probe.raw ?? "");
  if (!version) return { supported: false, reason: "could not parse bwrap version" };
  const [maj, min] = version;
  if (maj > 0 || (maj === 0 && min >= 8)) return { supported: true };
  return { supported: false, reason: `bwrap ${version.join(".")} < 0.8 required for --overlay` };
}
```

No separate userns probe is needed: `buildBwrapArgs()` already emits
`--unshare-all`, which requires unprivileged user namespaces for the
*existing* v1 sandbox too. A host without them already fails plain
sandboxed dispatch today (an unhandled bwrap spawn-time error, pre-existing
gap, not introduced here). Overlay support only *raises* the version floor
from "any" to 0.8; it adds no new namespace dependency. `checkBwrapAvailable()`
needs one small addition: return the raw stdout (`raw: result.stdout`) so
`checkOverlaySupport()` can parse it without a second subprocess call.

### 1.2 Config surface

One new key, following `sandboxEnabled`'s exact existing shape (`config.js:23`,
`docs/config.md`'s precedence table):

| Config key | Env var | Type | Default |
|---|---|---|---|
| `overlayEnabled` | `TASKFERRY_DISABLE_OVERLAY` (inverted) | boolean | `true` |

Only consulted when `sandboxEnabled` is already true. Behavior:

- `overlayEnabled: true` (default) and host `checkOverlaySupport()` fails:
  **fail closed**, same shape as the existing "Fail-fast on Linux" rule for
  a missing `bwrap` binary (`docs/security.md:230`) — `dispatch` returns a
  `crashed` task with a `spawnError` naming the bwrap-version reason, no
  silent unsandboxed or unguarded-write fallback.
- `overlayEnabled: false` (explicit opt-out, config or `--no-overlay` CLI
  flag on a single `taskferry dispatch` call, mirroring
  `--no-sandbox`'s existing per-call shape): falls back to the v1 plain
  `--bind directory directory`, with a one-line stderr warning
  (`warning: overlay disabled -- writes land directly on <directory>,
  not gated by accept/reject`) so a user opting into the legacy path can't
  mistake it for the new one. **The opt-out is dispatch-role only**
  (2026-07-30 revision, review finding #5): `--no-overlay` is not accepted
  on `taskferry advisor` at all, and a globally disabled overlay fails an
  advisor dispatch closed (`crashed` + `spawnError`) instead of falling
  back — an advisor with a plain writable bind would have a path to persist
  writes, contradicting ADR 0001's "an advisor has no path to persist a
  write." The guarantee is enforced, not weakened.

No new tmp-dir config knob (`/tmp/taskferry-cow-<task-id>/...` is
hardcoded) — matches the existing "deny-list is fixed in this version, no
config override" precedent (`docs/security.md:171`) until a real need
surfaces.

## 2. Interaction with the git-common-dir bind (worktrees)

`tasks.js:1639-1678` currently resolves a worktree's `gitCommonDir`/`gitDir`
and pushes narrow slices of it into `extraRwBinds` (a **plain writable
bind**, bypassing whatever the main directory's own mount mode is) so
`git commit`/`git add` don't fail read-only inside the sandbox. Left as-is,
this bypasses the overlay entirely: a worktree dispatch's commits would
land for real, immediately, on the shared object store — exactly the
"gated" property this whole design exists to add.

**Decision: when `overlay` is active, every path that would otherwise go
into `extraRwBinds`/`extraRwPairBinds` for the git-common-dir case instead
gets its own overlay mount**, same task-scoped tmp root, one
`upper`/`work` subpair per bound path (e.g.
`/tmp/taskferry-cow-<task-id>/upper/gitcommon-objects`,
`.../work/gitcommon-objects` for the `objects` dir, etc. — a stable slug
derived from the bound path's basename, collision-suffixed if two entries
share one). `buildBwrapArgs()` needs a second new option,
`overlayRwBinds: [{ path, upperDir, workDir }]`, appended in the same
position `extraRwBinds` occupies today (each becomes its own
`--overlay-src <path> --overlay <upper> <work> <path>` line). The
narrow-slice *selection* logic in `tasks.js:1639-1678` (taskferry#224's
fix — which paths to expose at all) is unchanged; only how each selected
path is mounted changes.

This also simplifies a debt the ADR surfaces implicitly: since nothing
lands on the real common dir until accept regardless of mount breadth, the
taskferry#224 corruption scenario (a dispatch against one worktree
mutating a sibling checkout) becomes structurally impossible even in the
narrow-slice fallback logic's least-precise branch (submodule / unresolvable
gitdir → falls back to binding the whole common dir, `tasks.js:1676`) — that
branch stays as today's *bind-set*, just now overlay-mounted instead of
plain-writable.

**Resulting git semantics (must be documented, see §9):** a `git commit`
made inside the sandbox advances `HEAD` only inside the overlay's merged
view. It is never replayed onto the real object store as a commit by
`taskferry accept` — see §4's `preDispatchHead` diff strategy. It is
flattened into the same single working-tree-style diff as an uncommitted
edit would produce. This directly resolves the ADR's stated consequence:
"Worker-facing docs must say taskferry applies accepted changes, not that
the worker's commit is durable."

## 3. New module: `src/changeset.js`

`tasks.js` is already ~2900 lines with one call site for sandbox
construction; the diff/accept/reject/cleanup logic below is a distinct
concern (git-diff mechanics, apply mechanics, overlay cleanup) and belongs
in its own module, matching the existing
`sandbox.js`/`executor.js`/`activity.js` split rather than growing
`tasks.js` further. `tasks.js` calls into it at two points: after a
sandboxed dispatch's process exits (extract), and from the new
`accept`/`reject` task-manager functions (apply/discard).

## 4. Diff extraction

Runs once, at process exit, for every task dispatched with an active
overlay (both roles) — not lazily on-demand at accept time. Reasons: the
overlay's `upper`/`work` are awkward to re-mount cheaply on a delay
(namespace/mount lifecycle, not an ownership issue — see §7's corrected
cleanup finding); accept/reject may happen minutes or hours later and
shouldn't require keeping the mount machinery alive that whole window; and
the ADR's "Debug opacity" consequence requires upper to be promptly
discardable on reject rather than lingering.

**Pre-dispatch anchor.** Before spawning inside the overlay, taskferry
records `preDispatchHead = git -C <lower> rev-parse HEAD` (only for git
targets) against the *real*, unmounted directory. This is the diff base —
not `HEAD` read from inside the merged view after the worker may have
committed, which would make `git diff HEAD` show nothing for a worker that
committed everything cleanly.

**Extraction command**, run via one short-lived `bwrap` invocation that
reuses the exact same overlay mount line as the executor's own run
(sequential reuse of one `upper`/`work` pair across two bwrap invocations
that never overlap in time is safe; overlayfs's `work` dir only needs to be
unshared between *concurrent* mounts):

```sh
# git targets
git -C <lower> add -A            # stage untracked files + deletions so they surface in the diff
git -C <lower> diff --cached <preDispatchHead> > <state-dir>/diffs/<task-id>.patch
git -C <lower> reset             # undo the transient staging; harmless, upper already captured it
```

`git add -A` inside this ephemeral remount does write to the upper's index
file, but that's fine: the diff-extraction step still only *reads*
pre-existing worker writes plus this transient staging op, and the ADR's
"upper is the diff" property is about content, not about the index being
byte-for-byte pristine. Untracked files, deletions (which surface as
overlayfs whiteouts, resolved automatically by diffing through the merged
view rather than parsing the raw upper directory listing — the ADR's
explicit reason for going through `git diff` at all), and any worker
commits (flattened, per §2) are all captured by this single diff.

```sh
# non-git targets: informational diff -ru for human review only (§5 covers
# the actual apply mechanism, which does not use this text as a patch)
diff -ru <lower> <merged-view-of-lower> > <state-dir>/diffs/<task-id>.patch
```

Output lands at `<state-dir>/diffs/<task-id>.patch`, no retention/pruning
(matches the existing no-pruning behavior of `<state-dir>/logs/*.ndjson` —
`docs/config.md` names no log-retention field and none exists in `tasks.js`
today).

**Unborn HEAD** (2026-07-30 revision, review finding #10): a git target
with zero commits makes `rev-parse HEAD` fail; `resolvePreDispatchHead()`
returns the empty-tree hash (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`)
for that case so the target stays on the git extraction path — misclassifying
it as non-git would make `accept` rsync the overlay's merged view (including
its `.git`) over the real directory, replaying the worker's commits as real
commits, which §2 forbids.

**Known, documented limitations of the `git add -A && git diff --cached`
strategy** (review finding #10, accepted as documented costs): writes to
gitignored paths are excluded from the changeset by design (`git add -A`
respects ignore rules — build artifacts and dependencies stay out of the
gate); and the extraction remount has a short window in which a concurrent
external edit to the *lower* can fold into the cached diff, sharing the
existing "Lower-layer volatility" consequence of the ADR (worktrees remain
the mitigation). Extraction fails closed: a non-zero bwrap exit or execution
error throws, the exit handler records `changesetError`, the task stays
`pending` with no `diffPath`, and the overlay is deliberately NOT cleaned up
so the changes remain recoverable (review finding #2).

## 5. Task state, accept/reject, apply

### 5.1 New persisted fields

The task record (`tasks.json`) gains, only for tasks dispatched with an
active overlay:

- `role: "dispatch" | "advisor"`
- `changesetStatus: "none" | "pending" | "accepted" | "rejected"` (`"none"`
  for non-overlay tasks — legacy bind, macOS, `--no-overlay`)
- `diffPath: string | null` — `<state-dir>/diffs/<task-id>.patch` once
  extracted
- `overlayDirs: { root, upperDir, workDir, rwBinds: [{ path, upperDir,
  workDir }] } | null` — cleared (set to `null`) once cleanup (§7) has run.
  `rwBinds` (2026-07-30 revision, review finding #1) persists the §2
  git-common-dir sub-overlays the worker actually ran with, because
  settlement-time extraction must re-mount exactly those — they are not
  reliably re-derivable later (the `packed-refs`/`objects`/`refs` selection
  depends on live filesystem state that can change between dispatch and
  extraction).
- `changesetError: string | null` (2026-07-30 revision, review finding #2) —
  set when settlement-time extraction throws; the task stays `pending` with
  `diffPath: null` and the overlay deliberately preserved (its `upper` is
  the only copy of the worker's changes; `accept` errors usefully, `reject`
  still cleans up)

`role` defaults to `"dispatch"`; `advisor()` (`tasks.js:2356`) passes
`role: "advisor"` on its internal `dispatch({...})` call. Advisor
changesets go `pending → rejected` automatically right after extraction —
no user action, no accept path exposed for an advisor task id at all
(`taskferry accept <advisor-task-id>` errors: `error: task <id> has role
"advisor" and cannot be accepted\nhelp: use "taskferry result <id> --diff"
to inspect what it wrote — advisor writes are never applied`).

### 5.2 "Pending blocks" — scoped definition

A dispatch task's `changesetStatus: "pending"` means: cleanup (§7) does not
run yet, and `taskferry list`/`taskferry status --full` surface the pending
changeset prominently (not silently indistinguishable from a task with no
changes) so a real diff can't be forgotten and garbage-collected by
accident. It does **not** block new dispatches against the same directory
at the queue/scheduling level — that's out of scope here; a second
dispatch against a directory with a pending changeset from a first just
gets its own overlay on the same (unaccepted) lower, same as two dispatches
against a directory with real uncommitted changes today.

A dispatch whose settlement-time extraction finds **zero changes** never
enters `pending` at all (2026-07-30 revision, review finding #3): it
auto-resolves to `accepted` with immediate cleanup. There is nothing to
gate, and leaving a no-op `pending` would force a manual `reject` whose
`git apply` of an empty patch would itself normally fail. `accepted` is the
truthful terminal state: applying nothing succeeds trivially.

### 5.3 CLI surface

Extends `result` for the read-only case (matches its existing pure-read
contract — `docs/cli-reference.md`'s `result` entry, `--fields`); adds two
new verb subcommands for the two side-effecting actions, matching the
existing `cancel`-shaped taxonomy (`args.js:85` `result`, and the
`cancel`/`wait`/`status`/`tail`/`summary`/`result` list at `args.js:318`)
rather than bolting flags onto `result` that mutate state:

| Command | Effect |
|---|---|
| `taskferry result <id> --diff` | prints the cached patch text, read-only, no side effect |
| `taskferry result <id> --full` | (existing flag) now also includes `role`/`changesetStatus`/a `diffStat` summary (files changed, `+`/`-` counts) without needing `--diff` |
| `taskferry accept <id>` | applies the changeset (§5.4), sets `changesetStatus: "accepted"`, runs cleanup (§7) |
| `taskferry reject <id>` | discards the changeset without applying, sets `changesetStatus: "rejected"`, runs cleanup (§7) |

Both `accept`/`reject` error on a task whose `changesetStatus` isn't
`"pending"` (already resolved, or no overlay was ever active) and on an
unknown task id, matching `cancel`'s existing validation shape.

### 5.4 Apply mechanics

- **Git target (worktree, main checkout, or bare-target-with-a-`.git`):**
  `git -C <directory> apply <diffPath>`, no `--index` — lands as an
  ordinary unstaged working-tree diff, the same state a direct (unsandboxed)
  edit would leave, so the user still stages/commits it themselves exactly
  as they would today. If the lower moved since dispatch (a concurrent
  session edited/switched branches on the main checkout — the ADR's
  "Lower-layer volatility" consequence) the apply can conflict; that
  surfaces as an ordinary `git apply` failure, not a silent corruption, and
  is the documented cost of running without a worktree (§8/9).
- **Non-git target:** an in-sandbox copy, not the `diff -ru` text from §4
  (which is human-readable, not machine-appliable). One more short-lived
  `bwrap` mounts the same overlay (rw) at `directory` and copies the
  resulting merged tree over the real directory, applying whiteout-implied
  deletions. Exact copy tool (`rsync -a --delete --delay-updates` vs. a
  small whiteout-aware copier) is an implementation-plan-level choice, not a
  spec-level one — both satisfy "the merged view becomes the real
  directory." The plan locks in `rsync -a --delete --delay-updates`
  (2026-07-30 revision, review finding #9): `--delay-updates` stages updated
  files and renames them in at the end, so an interrupted apply leaves old
  files intact rather than a half-mutated tree. It is not fully
  transactional (deletions still apply incrementally), but a failed apply
  leaves the overlay in place (§5.4's failure rule below), so the apply is
  retryable.
- **Non-git targets and reboots** (2026-07-30 revision, review finding #7):
  a non-git `accept` needs the *live* overlay to rebuild its merged view.
  `overlayTmpRoot` defaults to `os.tmpdir()`, a tmpfs — a reboot clears it.
  A git changeset survives (its patch is persisted under `<state-dir>` and
  `git apply` needs no overlay), but a non-git changeset left `pending`
  across a reboot is unrecoverable: `accept` must fail loudly with a
  distinct error ("overlay is gone ... reject to clear") rather than
  rsyncing a missing tree. No silent degradation, no retry-after-reboot
  promise for non-git targets.
- Apply failure (conflicting `git apply`, copy error) leaves
  `changesetStatus: "pending"` and does **not** run cleanup — the upper
  survives so the user can resolve the conflict and retry `accept`, or fall
  back to `taskferry result <id> --diff` and apply by hand.

## 6. Advisor role plumbing

`advisor()` (`tasks.js:2347`) already calls `dispatch()` internally with no
role distinction reaching the sandbox spawn path (`tasks.js:1591`) at all —
today an advisor gets the exact same mount as an implementer. Two changes:

1. `role: "advisor"` flows from `advisor()`'s internal `dispatch({...})`
   call through `dispatchLaunch`/the task record down to the spawn-path
   code, which reads it to pass `shareNet: dispatchLaunch.role !== "advisor"`
   into `buildBwrapArgs()` (§1's new `shareNet` param — default `true`
   preserves today's `--share-net` for every other caller unchanged).
2. As covered in §5.1, advisor changesets auto-resolve to `"rejected"`
   right after extraction; no CLI path ever accepts one.
3. **Overlay is mandatory for the advisor role** (2026-07-30 revision,
   review finding #5): whenever sandboxing is active, an advisor dispatch
   with overlay disabled — globally (`overlayEnabled: false`) — fails
   closed with a `crashed` task and a `spawnError`, and `--no-overlay` is
   rejected at the CLI/protocol layer for advisor entirely (§1.2). ADR
   0001's "an advisor has no path to persist a write" is enforced, not
   conditional. (Hosts with sandboxing off entirely — macOS, `--no-sandbox`
   — keep today's ungated behavior; that pre-existing exposure is outside
   this design's scope.)
4. **The daemon's socket is unreachable from an advisor sandbox**
   (2026-07-30 revision, review finding #6): `runtimeDir` holds the daemon's
   Unix socket (`daemon.sock`), and `--unshare-net` does not block
   Unix-domain-socket connects through a *writable* bind mount — so advisor
   spawns bind `runtimeDir` read-only (`buildBwrapArgs()`'s new
   `runtimeDirWritable` param, false for advisors), making `connect()` fail.
   Dispatch roles keep today's writable bind.

### 6.1 Summary children

Summary/report children (`isSummary` branch, `tasks.js:1560` on) never get
`overlay` — they don't write to the target directory in any sense the
overlay model cares about; leaving them on the plain bind (today's
behavior) is correct and requires no change.

## 7. Cleanup protocol

ADR 0001 originally assumed `upper`/`work` come back owned by an unmapped
namespace uid, requiring a privileged rm or a purpose-built cleanup
namespace. **Corrected during implementation planning:** verified live
against the exact `buildBwrapArgs()` flag set on the target host —
`upper`/`work` (including overlayfs's internal `work/work` scratch subdir,
mode `000`) come back owned by the *invoking* uid, not an unmapped one
(bwrap's default `--unshare-user` identity-maps the outer uid; nothing in
this design passes `--uid`/`--gid`). A plain `rm -rf` from the daemon's own
uid removes the whole tree with no error — unlink authority comes from the
parent directory's permissions, not the child's own mode. **Decision:**
plain removal (`fs.rmSync(root, { recursive: true, force: true })`), no
bwrap invocation, no privileged path.

**Triggers:** immediately on `reject`; immediately after a successful
`accept`'s apply step (§5.4); and a daemon-startup sweep for orphaned
`/tmp/taskferry-cow-*` dirs whose task id no longer exists in `tasks.json`
(same-boot daemon-crash recovery only — `/tmp` being a tmpfs already clears
everything on a real reboot for free).

## 8. Skill rewrites

- **`integrations/claude/skills/using-taskferry/SKILL.md`:**
  - New question at the start of feature-work dispatch (ADR decision 3):
    worktree vs. main checkout, framed on the ADR's actual remaining
    trade-offs — branch isolation (parallel sessions on different branches
    without a switch race) and lower-layer stability (a concurrent edit to
    the main checkout mutates the overlay's lower in place mid-flight) —
    explicitly *not* framed as a safety requirement anymore, since overlay
    writes are gated regardless of worktree-or-not.
  - **"Verifying A Worker's Claimed Commit"** (lines 76-100) needs a real
    rewrite, not an addendum: its core assumption — that `git -C
    "<worktree>" log`/`status` against the real worktree reflects what the
    worker did — no longer holds. Under this design that check will show
    nothing until an explicit `taskferry accept`, every time, for every
    settled dispatch, regardless of whether the worker's changes are good.
    The new workflow: inspect `taskferry result <id> --diff` (or `--full`
    for the stat summary) to verify the changeset matches the claimed
    work, *then* `taskferry accept <id>`, *then* the existing
    `git log`/`git status` check becomes meaningful again. The "sandboxed
    worker's `git commit` can fail silently... verify tests and lint
    yourself, then commit it directly" fallback path (lines 91-96) is
    obsoleted outright: there's no more silent-commit-loss failure mode to
    route around, because commits were never going to land as commits in
    the first place (§2) — replace it with guidance to `reject` and
    re-dispatch, or apply the cached diff by hand, if `accept` itself
    conflicts.
- **`using-git-worktrees-addendum`** (external, versioned cache dir:
  `/home/jeremy/.claude-qwen/skills/using-git-worktrees-addendum/SKILL.md`,
  its "shared-checkout-race" section, lines ~9-88 per the earlier grep):
  currently frames worktrees as necessary to prevent a dispatch from
  corrupting the shared checkout (the pre-ADR threat model). Needs
  inverting to: worktrees are for concurrency/branch-isolation only: with
  overlay-gated writes, a rogue dispatch structurally cannot corrupt the
  shared checkout regardless of worktree-or-not; the *only* remaining
  worktree-relevant hazard is a live *lower* mutating in place under a
  long-running ferry (ADR's "Lower-layer volatility" consequence), which is
  a staleness/conflict concern, not a corruption one. This file is outside
  this repo and outside this spec's write scope — name it as a required
  follow-up edit, don't perform it here or in this repo's implementation
  plan.

## 9. Docs

- **`docs/security.md`**, "Filesystem sandboxing (bubblewrap)" section
  (currently lines 153-244): new subsection covering the overlay mount,
  the `overlayEnabled`/`--no-overlay` opt-out and its fail-closed default,
  the git-common-dir overlay extension (§2), and the flattened-commit
  semantics stated explicitly (a worker's `git commit` inside the sandbox
  is never replayed as a commit by `accept` — only a working-tree-style
  diff survives). New subsection for accept/reject/diff-extraction/cleanup
  (§4-§7), parallel in depth to the existing credential-visibility and
  fail-fast subsections.
- **`docs/config.md`**: add the `overlayEnabled`/`TASKFERRY_DISABLE_OVERLAY`
  row to the fields table (§1.2), matching `sandboxEnabled`'s row exactly
  in shape.
- **`docs/cli-reference.md`**: document `--diff` on `result`, and the two
  new `accept`/`reject` subcommands.
- **`docs/sourcemap.md`** (CI-enforced sync, per this repo's `CLAUDE.md` —
  update in the same PR as the code, not after):
  - `sandbox.js` row (line 56): add `buildBwrapArgs()`'s new `overlay`/
    `overlayRwBinds`/`shareNet`/`runtimeDirWritable` params and
    `checkOverlaySupport()`.
  - `tasks.js` row: note the `role`/`changesetStatus` additions to the
    spawn path and the new `accept`/`reject` task-manager functions.
  - New row for `src/changeset.js` (§3): diff extraction, apply, cleanup.
  - `config.js` row: note the new `overlayEnabled` field.

## 10. Tests

- `src/sandbox.test.js` (existing 250 lines, `describe("buildBwrapArgs()")`
  block at line 109 is the pattern to extend): new cases for the
  `overlay`-present arg-ordering (mirrors the existing extraRwBinds-ordering
  style at line 194), `overlayRwBinds` ordering, and `shareNet: false`
  emitting `--unshare-net` in place of `--share-net` at the tail (extends
  the existing tail assertion at line 158/248). New
  `describe("checkOverlaySupport()")`/`describe("parseBwrapVersion()")`
  blocks mirroring the existing `checkBwrapAvailable()` block's
  injected-`runCommand` style (line 24).
- New `src/changeset.test.js`: `preDispatchHead`-anchored diff-command
  construction (mocked git calls, same injected-command style as
  `sandbox.test.js`), apply-command construction for the worktree /
  main-checkout / non-git-target cases (§5.4), and `cleanupOverlay()`'s
  removal call with an injected `rmFn` (§7) — verifying argument/call
  construction, not actually exercising bwrap/overlayfs in unit tests
  (that's the ADR's own manual-evidence role, not CI's).
- **One Linux-gated integration suite that exercises a real bwrap overlay**
  (2026-07-30 revision, review finding #14): the mocked-runner unit tests
  above cannot prove filesystem containment, which is this feature's entire
  purpose. `src/changeset.integration.test.js` (plan Task 19) runs real
  round trips — sandboxed write → extract → apply → verify the real
  directory → cleanup — for a git target (including the flattened-commit
  semantics of §2), a worktree-shaped target with git-common-dir
  sub-overlays (the §2 / finding #1 regression), and a non-git target
  (including whiteout-implied deletions). The suite probes
  `checkOverlaySupport()` + `rsync` availability and skips cleanly with a
  stated reason on hosts that lack either, so CI images without bwrap ≥ 0.8
  stay green.

## 11. pi executor audit gap

**Decision: separate GitHub issue, not folded into this implementation
plan.** The gap (pi's ndjson logs record command *output* but not *input* —
surfaced during the 2026-07-29 incident forensics) lives in the pi
executor's own log-formatting path (`executor.js`'s `piExecutor()`), is
orthogonal to the overlay/diff-gate mechanism, and bundling it in would
blur this plan's diff/review surface for no shared code. Worth filing
before or alongside implementation, but as its own issue — ask before
filing, since posting to GitHub is a shared-state action outside this
writing task's scope.

## Config surface summary

| Config key | Env var | Type | Default |
|---|---|---|---|
| `overlayEnabled` | `TASKFERRY_DISABLE_OVERLAY` (inverted) | boolean | `true` |

## CLI surface summary

| Command | New/changed |
|---|---|
| `taskferry dispatch` / `taskferry advisor` | `--no-overlay` flag (mirrors `--no-sandbox`) |
| `taskferry result <id> --diff` | new flag, read-only patch text |
| `taskferry result <id> --full` | now includes `role`/`changesetStatus`/`diffStat` |
| `taskferry accept <id>` | new subcommand |
| `taskferry reject <id>` | new subcommand |

## Explicitly deferred to the implementation plan

- Exact non-git apply copy tool (`rsync` vs. a whiteout-aware copier, §5.4).
- Exact slug/collision scheme for `overlayRwBinds` subdirectory naming (§2).
- Whether `taskferry list`'s default (non-`--full`) output gets a
  pending-changeset indicator column, or only surfaces it under `--full`/
  `status` (§5.2's "prominently" is a requirement, not a layout).
