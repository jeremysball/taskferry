# ADR 0002: Recursive ferry dispatch (a ferry spawning its own child ferries)

**Status:** Proposed.

**Date:** 2026-08-15

## Context

A dogfooding session on `jeremysball/hearth` deliberately tried a nested
dispatch pattern — call it a "three-layer cake": a human-driven Claude Code
session (layer 1) dispatches a single `meta/muse-spark-1.2-contributor`
orchestrator ferry into its own worktree (layer 2), and that orchestrator's
prompt tells it to execute a multi-task implementation plan by spawning its
own `taskferry dispatch` child ferries per task (layer 3), rather than the
layer-1 session dispatching each task itself.

This is not hypothetical. It ran for real: the orchestrator spawned roughly
20 child dispatches over ~30 minutes and produced 3 real commits on
`feat/diaper-poo-copy` (`b0e73d4`, `89c8afd`, `3a79456`), later opened as
hearth PR #225. Verified independently via `gh pr diff` against the child
tasks' claimed changes, not taken on the orchestrator's self-report — one
sample child task even self-corrected two things the source plan document
got wrong (a stale file:line citation, and a wrong test-file target) before
writing any code. The pattern produces real, reviewable value when it works.

It also surfaced two structural gaps that had to be worked around by hand,
both real and reproducible, not one-off flukes:

**1. Double-sandbox overlay staleness.** Per ADR 0001, every ferry — parent
and child alike — runs its `--directory` mount as a copy-on-write overlay
whose lower is the live host directory *as it stood at that ferry's own
dispatch time*. The orchestrator (layer 2) is itself a ferry: its own view
of `--directory` is a CoW overlay snapshotted when *it* was dispatched. When
one of its child dispatches (layer 3) later runs `taskferry accept` and that
child's diff lands on the real host directory, the orchestrator's own
overlay lower does not refresh — overlayfs never snapshots a live
directory's later mutations back into an already-mounted lower. The
orchestrator is left looking at a stale view of the very tree its own
children just changed, and has no in-sandbox way to detect this on its own.
The orchestrator's workaround, done by hand inside its own dispatch: issue a
`--no-sandbox` check dispatch to see the real host state, manually re-apply
the diff it already knows landed into its own working view, then commit
from there. That workaround is exactly the kind of manual bookkeeping a
recursive-dispatch feature should not require its caller to invent per run.

**2. Host GitHub-credential reliance.** A sandboxed ferry's own isolated
`gh` config lives at a taskferry-managed cache path
(`~/.cache/taskferry/.../gh/hosts.yml` inside the sandbox), separate from
the host's real `~/.config/gh/hosts.yml`. In this run, the orchestrator's
own isolated `gh` config held only an expired PAT — it could not push or
open the PR under that identity, and fell back to the host's real OAuth
token to complete the push. This is not unique to recursive dispatch (any
single sandboxed ferry that needs `gh` hits the same isolated-vs-host config
split), but it surfaced here because the orchestrator, not just a leaf
implementer, needed working GitHub credentials to finish its job, and
"borrow the host's real token" is a privileged-access pattern worth naming
explicitly rather than leaving as an unremarked side effect of the sandbox
falling back silently.

Both gaps were survivable by hand in this one run because a human was
watching the orchestrator's narration and could interpret its self-reported
workaround. Neither gap is survivable unattended, and unattended operation
is the actual point of a recursive-dispatch feature — if the orchestrator
still needs a human to notice and unblock it, "recursive dispatch" has not
actually removed the human from the loop, only added a layer of indirection
around them.

## Decision (MVP scope — this ADR's near-term ask)

Ship the smallest fix for each gap that removes the manual workaround,
without yet promising a fully first-class recursive-dispatch API:

1. **Overlay-staleness MVP fix:** give a running ferry a way to learn its
   own `--directory` overlay lower has drifted since its dispatch — at
   minimum, a `taskferry status --check-drift` (or equivalent) the
   orchestrator can poll after each child `accept`, that compares the
   overlay's lower generation against the live directory's current git HEAD
   /working-tree state and reports drift explicitly, mirroring the
   `headDrift` handling `taskferry result --diff` already does for the
   plain worktree-HEAD-moved case (see `using-taskferry`'s "Always Use A
   Worktree" section). The orchestrator can then re-mount, re-sync, or at
   minimum surface the drift instead of silently operating on a stale view.
   Full transparent re-sync (the parent's overlay lower auto-refreshing
   after each child's accept) is a larger design and explicitly out of MVP
   scope here — see "Full first-class design" below.
2. **Credential-inheritance MVP fix:** document, and where reasonable
   default, an explicit choice for whether a dispatched ferry's `gh` sees
   the sandbox's own isolated config or a read-only bind of the host's real
   one — today this is an unremarked fallback, not a decision. At minimum,
   `taskferry doctor` (or dispatch itself) should flag when a ferry's
   isolated `gh` config has no usable credential *before* the ferry
   discovers this itself mid-task, rather than after.

Both are scoped to make the two blocking frictions from this dogfooding run
go away for the *next* recursive-dispatch attempt, not to build the general
feature. That's deliberately a fast MVP path — small, bounded changes to
existing mechanisms (`taskferry status`, `doctor`) rather than new
dispatch-time architecture.

## Full first-class design (follow-on work, not this ADR's immediate ask)

Once the MVP fixes land and a second recursive-dispatch run confirms they
close the gap in practice, the follow-on plan is to make recursive dispatch
a supported, named capability rather than an emergent pattern a caller has
to assemble from primitives never designed for it:

- A documented contract for what a ferry may assume about its own
  `--directory` staying live-synced (or not) across a child's `accept`,
  instead of leaving it to the parent's prompt discipline.
- First-class propagation of `--parent-task` through a self-dispatched
  child chain, so a fleet view of a recursive run shows the real
  orchestrator → child tree, not a flat list of unrelated-looking tasks.
- A considered default for the GitHub-credential question above — likely a
  `--allow-host-gh` opt-in flag rather than either a silent fallback or a
  hard block, consistent with the flag/env-var/config-key triplet
  convention this project already follows elsewhere for new knobs.
- Cost/observability rollup for a recursive run (today, verifying the
  orchestrator's total spend means manually summing each child task's
  `taskferry result --fields tokens,cost`, one call per child).

## Alternatives considered

- **Ban recursive dispatch outright** (a ferry may not call `taskferry`
  itself). Rejected: the pattern already produces real, verifiable value
  (PR #225) when the two gaps above are worked around by hand; banning it
  throws that away instead of closing the actual gaps.
- **Wait for the full first-class design before shipping anything.**
  Rejected: the two MVP fixes are small, self-contained, and each already
  has a template to extend (`headDrift` handling, `doctor`'s existing
  flag-and-report pattern), so there's no reason to gate them behind the
  larger design.

## Evidence

- hearth PR #225 (`feat/diaper-poo-copy`), 3 commits, produced entirely by
  the orchestrator's child dispatches, independently verified via
  `gh pr diff` rather than accepted on the orchestrator's self-report.
- Orchestrator's own narration describing both workarounds in the same
  dispatch (`--no-sandbox` re-check plus manual diff reapplication for the
  overlay-staleness case; fallback to the host's real `gh` OAuth token for
  the credential case).
- `docs/adr/0001-cow-overlays-and-diff-gated-writes.md`'s "Lower-layer
  volatility on the main checkout" consequence already names the same
  underlying mechanism (a live directory mutating under an already-mounted
  overlay) for the single-ferry case; this ADR is the two-layer
  generalization of that same gap.

## Revisit this decision if

- A recursive-dispatch attempt after the MVP fixes still needs a manual
  workaround for either gap — the MVP scope was wrong or incomplete.
- The full first-class design turns out to need dispatch-time architecture
  changes deep enough that splitting MVP from first-class stops making
  sense as two separate stages.
