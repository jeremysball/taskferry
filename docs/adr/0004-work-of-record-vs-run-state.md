# ADR 0004: Work of record vs. run state; build a run ledger, keep GitHub as the record

**Status:** Proposed. Supersedes an earlier draft of this ADR that framed the
decision as "when to adopt Beads." That framing was wrong -- see Context.

**Date:** 2026-09-01

## Context

taskferry executes agent work: dispatch, sandbox, changeset, accept/reject, crash
handling. It has no notion of what work exists beyond the task in flight. Grep
`src/` for dependency concepts and you get nothing; statuses are
`queued/running/done/crashed/cancelled`. So the human is the scheduler, and that
is the bottleneck -- not execution capacity.

The obvious move was to adopt Beads (`gastownhall/beads`), a Dolt-backed issue
graph with dependencies, readiness queries, and atomic claiming. Investigation
said no, but the first reasons given were wrong. "Adopt it when the backlog must
outlive a session" is not a real trigger: GitHub issues, PRs, and SDD documents
already provide durable cross-session work state, and have for a long time.

The actual insight is that two different kinds of state were being called by one
name.

**Work of record.** GitHub issues, PRs, SDD docs. Durable, human-facing,
review-worthy, slow -- and correctly slow, because it is the artifact people read
later. Already solved. Not missing.

**Run state.** What got selected for this pass, in what order, which item is in
flight, which ferry holds it, how many attempts, what failed, what is ready next.
Machine-facing, written every few seconds, interesting for hours rather than
months. Missing entirely. This is what an orchestrator needs in order to exist.

Run state cannot live in GitHub even in principle: every write is a network round
trip against a rate limit, and an attempt counter or a ferry ID is noise inside
an artifact humans read. Wrong medium, wrong tempo.

And the property that makes it cheap: **run state is derived.** It is a
projection of "these eight issues, in this order" out of the work of record for
one execution pass. Losing it is not data loss -- you rebuild it by re-reading the
sources and reconciling against live taskferry tasks.

## Decision

**1. GitHub and SDD remain the work of record.** No migration, no second tracker,
no duplication.

**2. Build a run ledger -- derived, disposable, single-writer.** The orchestrator
projects a pass out of the record, executes it, writes outcomes back to the
record, and discards the ledger. It carries no durability guarantee, no
versioning, no migration story, no history, because it can always be rebuilt.

**3. Crash recovery rebuilds rather than trusts.** On startup the orchestrator
re-reads the record and reconciles against live taskferry tasks instead of
believing a ledger that may be mid-write. This is simpler than making the ledger
crash-safe, and it is the direct consequence of the state being derived.

**4. Do not adopt Beads now.** Beads is a *work of record* system -- durable,
versioned, human-legible, and it ships tracker integrations specifically to
import from GitHub. It competes with what we already have and does not supply
what we lack. Adopting it would duplicate the record and still leave the
orchestrator unbuilt.

**5. The real trigger for reconsidering Beads is dependency complexity, not
durability or concurrency.** Beads' one genuine differentiator over GitHub is a
machine-queryable dependency graph with a readiness frontier; `bd ready` has no
GitHub equivalent, where dependencies are prose or checkboxes rather than edges.
So the question to revisit is: *does a machine need to compute what is ready, or
do we state the order at plan time?* Stating the order at plan time needs a run
ledger and nothing more. Wanting "everything unblocked across four epics,
whatever that currently is" is when the graph earns its keep.

**6. Ferries do not write the ledger.** A leaf ferry that files discovered work
directly is a second writer, which would create a concurrency problem under a
single orchestrator. Instead, ferries report discoveries in their result and the
orchestrator writes them to the record. This preserves the single-writer property
for free and adds a review point where a discovery can be judged real before it
enters the backlog.

**7. Skills stay skills.** A ledger item carries a *pointer* to the CRISPY/SDD
skill that drives it, never the methodology itself.

**8. Verification comes from taskferry and review.** Definition of done is
taskferry's project check passing before `accept`, plus a review ferry judging
against the item's acceptance criteria. No second test pass at the orchestrator
layer -- `accept` already runs the check inside the worker's overlay.

## Layer map

| Layer | Owns | Question | Status |
|---|---|---|---|
| GitHub + SDD | work of record | WHAT | exists |
| Run ledger | run state for one pass | WHEN / WHERE-ARE-WE | **to build** |
| CRISPY/SDD skills | methodology, standard of done | HOW | exists |
| taskferry | sandbox, model, dispatch, changeset | WITH WHAT | exists |
| Orchestrator skill | assignment | WHO | **to build** |
| Human | what is worth doing; what "good" means | WHY | does not delegate |

The goal is to move the human off WHO. WHY stays.

## Implementation: orchestrator MVP

### Scope

Read a plan from the record, project it into a run ledger, execute it through
taskferry, write outcomes back, discard the ledger. Success is an unattended run
ending in a diff to review rather than a queue to work.

### The loop

```
project plan from GitHub/SDD → run ledger
  → pick next unblocked item
  → resolve skill from item → compose prompt → taskferry dispatch
  → record tf_task on the item (BEFORE awaiting the ferry)
  → wait
  → on accept: close/comment on the record, mark done
  → on failure: record reason; requeue, or file discovered work to the record
  → repeat → discard ledger
```

### Ledger shape

A single JSON file the orchestrator owns, written atomically (temp + rename).
Per item, minimally: `id` (pointing at the GitHub issue), `status`, `deps`,
`skill`, `acceptance`, `tf_task`, `attempts`, `last_failure`.

Document the single-writer assumption at the top of the file. It is the first
thing that breaks when someone adds a second orchestrator or lets ferries write.

### Interface boundary

Keep ledger access behind five verbs: `next-ready`, `mark-in-progress`,
`record-task`, `close`, `file-discovered`. Nothing else touches it. Implement
them as real commands with atomic writes and real exit codes -- the model calls
verbs, it does not hand-edit ledger JSON. If Beads is ever adopted it becomes an
implementation of that interface rather than a rewrite.

### Rollout

1. Projection from GitHub/SDD into the ledger; atomic writes; the five verbs.
2. One item end to end, human watching.
3. Reconciliation on startup. Kill the orchestrator mid-run; confirm it rebuilds
   and resumes. Required test, not a nice-to-have.
4. Review ferry and acceptance gating.
5. Unattended run against a small real backlog.

### Risks

- **Silent failure loops** -- an item that fails, requeues, and fails identically
  forever. Cap `attempts` and escalate.
- **Context loss between dispatch and record.** Write `tf_task` first, always.
- **Verification theatre** -- a review ferry that approves everything. Spot-check
  its verdicts against your own review before trusting it.
- **Acceptance criteria quality.** This is the highest-value artifact in the
  system: it is what lets a review ferry reach a verdict without the human. Weak
  criteria make the whole loop decorative -- a machine for generating
  plausible-looking PRs faster than they can be rejected.

## Consequences

- The orchestrator is small. Most of what looked like required infrastructure
  (durable store, concurrency control, dependency engine) turned out to be
  either already solved or not needed for a single-writer pass.
- Building the ledger before adopting any substrate means it may be thrown away
  later. Accepted: it is small, and building it is what teaches us the schema.
- Two sources of truth exist during a run -- the record and live taskferry task
  state. Reconciliation on startup is the mitigation. Skipping it is how a
  crashed orchestrator becomes unrecoverable.
- The orchestrator runs on the host as a layer-1 session, not as a ferry, until
  ADR 0002's gaps close: a parent ferry's CoW overlay does not refresh after a
  child's `accept`, and its isolated `gh` config cannot push.

## Alternatives considered

- **Adopt Beads as the work store.** Rejected: it is a work-of-record system and
  we have one. It would duplicate GitHub and leave the actual gap -- run state and
  assignment -- unfilled.
- **Build the work graph inside taskferry.** Rejected: taskferry is the execution
  substrate, and mixing work coordination into it would make both harder to
  reason about. Its state is also a JSON file under an advisory lock, the wrong
  regime for a durable record.
- **Put run state in GitHub.** Rejected: rate limits, latency, and pollution of a
  human-facing artifact with machine bookkeeping.
- **Translate CRISPY/SDD into Beads molecules.** Rejected. Sequencing is the
  smallest and least valuable part of those skills; the rest is methodology,
  which a molecule step can only hold as opaque text. Beads' own release formula
  demonstrates the failure mode -- 916 lines of TOML, mostly prose instructions,
  copied into every bead at instantiation and unversioned against the code.
- **Adopt Gastown (`gt`) as the orchestrator.** Rejected: it would mean a second
  orchestration model alongside taskferry.

## Evidence

Verified against `jeremysball/taskferry` @ `6661b55` and `gastownhall/beads` @
`40b3232`.

- taskferry has no dependency or readiness concept in `src/`; statuses are
  terminal-or-running only.
- Beads' `engdocs/PROJECT_CHARTER.md` places *workflow semantics* in the
  orchestration layer, not in core, and directs extensions to issue metadata.
- Beads' formula DSL advertises more control flow than `bd` implements:
  `condition`, `loop.count`, `loop.range` all resolve at cook time;
  `loop.until` emits a `loop:{…}` label with no consumer in the repo;
  `on_complete.for_each` is parsed and cloned but never executed. The runtime
  executor those features assume is Gastown, not `bd`.
- Beads independently arrived at the same durable/ephemeral split: molecules are
  persistent work, wisps are operational runs explicitly described as worthless
  once closed and GC'd. Different starting point, same distinction.

## Revisit this decision if

- Sequencing gets complex enough that a machine should compute the ready frontier
  rather than a human stating the order at plan time.
- A second orchestrator is wanted, which breaks the single-writer assumption the
  ledger rests on.
- Ferries need to write work state directly rather than reporting discoveries
  through their result.
- Rebuilding run state from the record proves too slow or too lossy to be the
  recovery path.
