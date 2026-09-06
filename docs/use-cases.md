# taskferry use cases

Source material for future READMEs. Each case states the problem, the
taskferry loop that answers it, and where the reversion path lives. Anything
marked **Direction** is not shipped; everything else is current behavior with
the canonical reference next to it.

Copy rules (from `docs/branding/positioning.md`): lead with dispatch,
inspection, and acceptance; say "worker", never imply taskferry wrote the
code; keep `accept`/`reject` visible; state Linux/macOS sandboxing
differences where relevant.

## 1. Script, manage, and settle subagents

**Problem:** background agent work started from a script is unmanageable:
no handle, no wait, no clean read-back of what happened.

**Loop:** `dispatch` returns a task id; `wait` blocks to settlement;
`result` reads the final answer; `accept` or `reject` settles the changeset.
Settlement is the point — a task is `done`, `crashed`, or `cancelled` by
process event, and every later step keys off that state.

```bash
taskferry dispatch --prompt "Fix the failing tests" --directory /workspace/my-repo --model opencode-go/minimax-m3
taskferry wait <id>
taskferry result <id> --diff
taskferry accept <id>   # or: taskferry reject <id>
```

References: `README.md:23-32`, `docs/cli-reference.md` (`dispatch`, `wait`,
`result`, `accept`, `reject`), `docs/overview.md:36-51`.

## 2. No more shelling out and praying

**Problem:** shell-backgrounded agents die with the terminal, and completion
is inferred by grepping a log or watching a pane.

**Answer:** the daemon owns task state and child-process handles past the
calling terminal (`README.md:34`, `docs/overview.md:42-44`). Completion is
the child's exit event, not a parsed string (`docs/overview.md:45-46`).
Watchdogs, provider-failure buckets, cancellation, output, and check-gate
state are queryable via `status`/`result` (`docs/overview.md:47-49`). The
interface is a normal CLI, so scripts, CI, and any agent that can shell out
use the same lifecycle (`docs/overview.md:50-51`).

## 3. Unattended coding agents with a reversion path

**Problem:** an agent left running alone needs a safe landing: inspectable
output and one command to take it or leave it.

**Loop:** dispatch, go away, come back, `result --diff`, then `accept` or
`reject`. On Linux the worker runs sandboxed in a copy-on-write overlay by
default, so nothing lands until `accept` applies it; a `.taskferry.toml`
check gate can refuse acceptance until the project's own verification passes
(`README.md:32-34`, `docs/cli-reference.md:276-304`, `docs/overview.md:39-41`).
`output` retrieves files from the per-task scratch directory even when the
task ends on a tool call or is cancelled (`docs/overview.md:64-66`).
macOS runs without the bubblewrap layer (`docs/overview.md:18-20`).

## 4. A crashed ferry leaves its work in the overlay, not in a transcript

**Problem:** reconstructing dead agent work from a JSON transcript is
guesswork. The work itself should survive the crash.

**Answer:** on Linux, worker writes land in the task's overlay
(`upper/main`, plus git-plumbing sub-overlays — see
`docs/bwrap-mechanics.md`). If the worker crashes or the
daemon restarts, the pending changeset is retained: the startup sweep
deliberately skips `pending` changesets, the diff is extracted to the task's
diff file, and `accept`/`reject` still apply (`docs/daemon.md:318-361`,
`docs/bwrap-mechanics.md:106-113`). Session resume (`--session-id`) is the
separate continuity mechanism for continuing a conversation; the changeset is
the continuity mechanism for the files (`docs/overview.md:71-72`).

## 5. User-created tags for model management — Direction

**Problem:** every dispatch re-states model, executor, and effort level.
What matters (which model class does review, which does cheap edits) should
be codified once and dispatched by tag.

**Today (primitives, not presets):** `--class <name>` is a free-text tag
stored on the task for telemetry aggregation — any string, no fixed-list
validation (`docs/cli-reference.md:64`, `src/command-specs.js:5`).
Reasoning effort is `--variant` with the `defaultVariant` chain
(`docs/cli-reference.md:57`, `docs/config.md`); concurrency is
`providerLimits` (`src/config.js:105-114`).

**Direction:** named tag presets — codify model + executor + variant once
under a user-chosen tag, dispatch with the tag alone. A README written from
this case must not claim presets exist until the config schema and
`dispatch` resolution chain land.
