# Orchestrator skill MVP

**Type:** epic
**Design:** `docs/adr/0004-work-of-record-vs-run-state.md` -- read it first. The
scope, loop, ledger shape, interface boundary, rollout, and risks are specified
there and are not restated here, so there is one place to change them.

## What this is

A skill that projects a plan out of GitHub/SDD into a disposable run ledger,
drives it to completion through taskferry, writes outcomes back to GitHub, and
throws the ledger away. It removes the human from choosing what runs next.

## Non-goals

- Beads, Dolt, or any external work store.
- Concurrency machinery -- atomic claims, leases, CAS guards. Single writer.
- Moving CRISPY/SDD methodology into the ledger. The ledger holds a pointer.
- Running the orchestrator as a ferry. Host session only, until ADR 0002's gaps
  close.

## Definition of done

- The five ledger verbs exist as real commands with atomic writes and exit codes.
  The model calls verbs; it never hand-edits ledger JSON.
- The orchestrator completes a multi-item plan unattended, ending in a reviewable
  diff.
- Killing the orchestrator mid-run and restarting it rebuilds state from the
  record and resumes correctly. This has a test.
- An item that fails repeatedly is capped and escalated rather than looping.
- A review ferry reaches verdicts against acceptance criteria, spot-checked
  against human review before being trusted.

## Prerequisite that is not code

For the next ten items in the backlog, acceptance criteria must be writable such
that a reviewer could rule on them without asking the author anything. If that is
not possible, the loop will produce plausible-looking work that still needs full
human review, and the orchestrator will not have removed the bottleneck. Write
the criteria first and find out.
