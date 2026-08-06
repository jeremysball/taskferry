# Stale-Base 3-Way Apply and Honest Terminal Status — Design

Date: 2026-08-05. Status: approved in brainstorm, pending plan.

## Background

The 2026-08-05 usage audit (`findings.md`/`analysis.md`, written up in the
`analyzing-taskferry-usage-and-creating-tooling-around-it` workspace) traced a
45-dispatch SDD run where an orchestrator "freaked out" every time a ferry
landed on a directory whose HEAD had moved since dispatch. Finding 5 measured
the cost: two bases in that one run alone piled up 10 dispatches apiece before
the orchestrator worked out what was happening — 20 dispatches burned on
nothing but stale-base churn.

That's not a one-run anomaly. `tf_stale_base.py churn` against the live
fleet-wide `tasks.json` today:

```
Directories tracked: 34
Distinct (directory, preDispatchHead) bases: 61
Bases with >=2 dispatches piled on them: 29
Total dispatches on a stale (shared, non-first) base: 76
Worst single base: 15 dispatches
```

`tf_stale_base.py simulate` dry-ran `git apply --3way --check` against the 10
still-reachable stale patches with a saved diff: all 10 reported clean.
(That check-mode number turned out to need a caveat — see "A `--check`
correction" below — but the direction holds: most stale-base collisions are
file-disjoint, non-conflicting diffs, exactly what "the tasks are disjoint"
implies they should be.)

**Current behavior, read from the actual code, not assumed:**

- `extractGitDiff` calls `assertNoHeadDrift()` twice — before the bwrap
  extraction and again immediately after (`changeset.js:187,205`, closing a
  race window from #329 where the retry backoff could let HEAD move mid-
  extraction). It **throws** on drift, unconditionally aborting extraction.
  No `diffPath` is ever written.
- `tasks.js`'s catch around extraction (`tasks.js:4334-4357`) only
  auto-settles the advisor role to `rejected`. Every other role — implementer,
  reviewer, fixer — lands in `changesetStatus: "pending"` with
  `changesetError` populated and `diffPath` still `null`. `validateAcceptable`
  requires a non-null `diffPath`, so `taskferry accept` throws too. The
  *practical* effect is "you can't accept this," but taskferry never makes
  that call itself — the orchestrator has to notice `changesetError`, work out
  what it means, and explicitly `taskferry reject`. That manual archaeology is
  exactly what Finding 5 called "the orchestrator's only real option."
- At `accept` time, for a git target, `applyGitChangeset` (`changeset.js:394-
  410`) already runs plain `git apply <diffPath>` against the live directory —
  but this path is only reachable once `diffPath` exists, which stale-base
  drift currently prevents.

**The key insight the fix rests on:** the diff extraction itself never reads
the live directory's *current* HEAD. It diffs the overlay's upper against the
recorded `preDispatchHead` entirely inside the sandbox (`changeset.js:194`),
and the overlay's own git history hasn't moved. `assertNoHeadDrift` is a
guard bolted on before/after extraction, not something extraction depends on.
A stale-base diff's *content* is still perfectly valid, anchored to the old
base — the only thing broken today is forward-applying it, and `git apply
--3way` exists precisely to forward-apply a patch across exactly this kind of
divergence using the blob shas embedded in the diff.

## A `--check` correction (found while grounding this spec in real repro, not just docs)

Before writing this down, the natural assumption was: dry-run `git apply
--3way --check` first, trust its exit code to mean "would apply cleanly."
That assumption is wrong, and it would have silently corrupted the "honest
terminal status" goal. Repro (base repo, worker patch changes `line2`, target
independently changes `line2` too — a genuine conflict):

```
$ git apply --3way --check worker.patch
Applied patch to 'f.txt' with conflicts.
$ echo $?
0
```

`--check` mode with `--3way` still runs the merge algorithm and treats
"resolved with conflict markers" as success — **the exit code does not
distinguish a clean 3-way merge from a real conflict.** Only the real
(non-`--check`) apply reports it accurately:

```
$ git apply --3way worker.patch
Applied patch to 'f.txt' with conflicts.
$ echo $?
1
$ git status --short
UU f.txt
```

Non-conflicting drift (target changes a *different* line) behaves as
expected in both modes — clean exit 0, correct merge. So the bug is specific
to `--check` + genuine conflicts, not to `--3way` generally. This means:

- The "10/10 would apply cleanly" number from `tf_stale_base.py simulate` is
  optimistic — it used `--check` and can't have caught a genuine conflict
  even if one existed among those 10. `tf_stale_base.py` should switch to the
  real-apply-then-discard method below, or at minimum get this caveat added
  to its own output.
- Any code in this spec that needs to *know* whether a 3-way apply would
  conflict, without touching the live directory, must do a **real apply
  inside a disposable copy** and inspect the result (exit code + `git status
  --porcelain` for `U`-prefixed paths), then discard the copy — `--check`
  cannot be trusted for this.

## Design

### 1. Extraction proceeds through drift instead of aborting

`extractGitDiff`'s contract changes: a detected HEAD drift no longer throws
and abandons extraction. Extraction always runs to completion and writes
`diffPath` (nothing about that step depends on live HEAD). `assertNoHeadDrift`
stops being fatal; it becomes an observation recorded on the return value:

```js
{ diffPath, hasChanges, headDrift: null | { from: string, to: string, recovered: boolean, conflictDetail: string | null } }
```

`headDrift` is `null` when no drift was observed (today's normal path,
completely unaffected). The second (post-retry) check point — already there
to close the #329 race window — is where drift, if any, actually gets
resolved, since that's the point a real diff exists to test-apply.

### 2. Drift resolution: real apply into a disposable worktree, then discard

When drift is observed:

1. `git worktree add --detach <scratch-dir> <currentHead>` off the *live*
   `directory` — cheap (shares the object database, no blob copies).
2. `git -C <scratch-dir> apply --3way <diffPath>` — the real apply, not
   `--check`, per the correction above.
3. Inspect: exit code `0` and `git status --porcelain` empty (no `U*`
   entries) → `recovered: true`. Anything else → `recovered: false`,
   `conflictDetail` captured from stderr / the conflicting paths.
4. `git worktree remove --force <scratch-dir>` unconditionally, whether
   recovered or not. **The live `directory` is never touched by this step** —
   it's read-only as a worktree source the whole time.

This makes the extraction-time recovery attempt safe to run unattended inside
the daemon, with no human watching, at any drift frequency: worst case it
costs a throwaway worktree add/remove per drifted extraction.

### 3. Settlement: drift recovery slots into the existing status machine

`tasks.js`'s post-extraction success branch (`tasks.js:4358-4367`) gains one
new condition, checked before the existing `hasChanges` branch:

| condition | `changesetStatus` | notes |
|---|---|---|
| `headDrift && !headDrift.recovered` | `rejected` | `changesetError` = `conflictDetail`; overlay released immediately, same as the advisor-reject branch — nothing left to accept |
| `headDrift && headDrift.recovered` | unchanged (`pending` if `hasChanges`, else `accepted`) | drift is now invisible downstream except for an audit trail (below) — the diff already reflects the 3-way-merged content* |
| no drift | unchanged | today's behavior, untouched |

\* One subtlety worth being explicit about: the *stored* `diffPath` still
holds the diff anchored on the original `preDispatchHead`, not the merged
result — the scratch-worktree apply in step 2 was solely a conflict probe,
its output is discarded with the worktree. `accept` (below) redoes the real
`git apply --3way` against the live directory at accept time, which is safe
because step 2 already proved it merges clean. If the live directory drifts
*again* between extraction and accept, accept's own 3-way apply either merges
that too or fails honestly — see section 4.

For audit, stamp `headDriftFrom` / `headDriftTo` / `headDriftRecovered` on
the task record whenever `headDrift` was non-null, regardless of outcome —
`status --full` and `doctor` context should be able to say "this changeset
survived a base drift" without an operator having to diff `preDispatchHead`
against current HEAD by hand.

### 4. `accept` always uses `--3way`, not just drifted tasks

`applyGitChangeset` (`changeset.js:399`) switches unconditionally from
`git apply <diffPath>` to `git apply --3way <diffPath>`. Verified safe as a
drop-in: the no-drift case behaves identically under `--3way` (repro above —
"Applied patch to 'f.txt' cleanly" either way), and `--3way` is a strict
superset that only engages its merge machinery when a plain apply would have
failed. This also covers the second drift window: a directory can move again
in the gap between extraction settling and a human running `accept`, and
today's plain `apply` would just fail outright in that case too.

Unlike extraction-time recovery, `accept` runs synchronously in front of a
human who typed the command and is watching the output. If `--3way` hits a
real conflict here, it's allowed to leave conflict markers in the live
directory — that's exactly the UX a human gets running `git apply --3way` by
hand, and it's this codebase's existing behavior class (surface `stderr`,
let the human resolve it), not a new failure mode taskferry invents. No
disposable-worktree dance is needed at accept time.

### 5. Reachability note

Non-git targets (`applyNonGitChangeset`, the rsync-merged-overlay-view path)
are unaffected — `assertNoHeadDrift`/3-way apply are git-diff concepts. A
non-git target's changeset was never subject to this specific drift-abort
behavior in the first place (see Non-goals).

## Error handling summary

| situation | behavior |
|---|---|
| no drift observed | identical to today, zero behavior change |
| drift, scratch-worktree 3-way apply clean | `recovered: true`, normal `pending`/`accepted` flow, drift stamped for audit |
| drift, scratch-worktree 3-way apply conflicts | `changesetStatus: "rejected"`, `changesetError` holds the conflicting-file detail, overlay released, no manual archaeology needed to learn the changeset is DOA |
| `git worktree add`/`remove` itself fails (e.g. disk pressure, git version without worktree support) | treated as a real extraction error — falls back to today's `pending` + `changesetError` path, drift metadata reports "could not evaluate," never silently assumed clean |
| accept-time `--3way` conflicts (second drift window) | `applyGitChangeset` returns `{applied: false, reason}` exactly as plain `apply` failure does today; conflict markers are left in the live directory for the human running `accept` to resolve, same as running `git apply --3way` by hand |
| preDispatchHead's blobs unreachable (squash-merged away, shallow clone) | `git apply --3way` itself reports this in stderr; surfaced verbatim as `conflictDetail`/failure reason, never guessed at |

## Testing

- Unit (mocked `runCommand`): `assertNoHeadDrift` no longer throwing out of
  `extractGitDiff`; the scratch-worktree add/apply/status/remove sequence
  under both outcomes; the new `changesetStatus` branch ordering
  (drift-unrecovered beats `hasChanges`); `applyGitChangeset` invoked with
  `--3way` in all cases, no-drift equivalence preserved.
- Real exercise (per the "mocked tests aren't proof at a system boundary"
  rule — this is exactly the git-subprocess boundary that mattered here):
  reuse the three-scenario repro built while grounding this spec (no-drift,
  non-conflicting-drift, genuine-conflict-drift) as an integration test
  fixture in `changeset.integration.test.js`, asserting the exact exit-code/
  `git status --porcelain` behavior this design depends on — this is what
  caught the `--check` false-clean bug, and it's cheap enough (three tiny
  git repos) to keep exercising on every run rather than trusting the
  one-off repro not to regress silently if a future git version changes
  `--3way --check` semantics again.
- Fleet-data validation once implemented: re-run `tf_stale_base.py simulate`
  (updated to use real-apply-then-discard instead of `--check`) against the
  same stale-patch set and confirm the `recovered` counts it reports match
  what the new code actually produces when pointed at the same directories.

## Non-goals

- Non-git-target changesets (`applyNonGitChangeset`'s rsync path) — no drift-
  abort exists there today, nothing to fix.
- Auto-accepting a recovered changeset. Drift recovery only gets a stale-base
  diff back to a normal, acceptable `pending` state — a human still runs
  `accept`. "Automatic merge" in this design means the merge is resolved
  automatically, not that acceptance is.
- Rewriting `tf_stale_base.py` itself (flagged above as a followup, not part
  of this change).
- Any change to the `.taskferry.toml` check-gate design (separate, already-
  written spec) — this spec is purely about changeset extraction/apply
  mechanics.
