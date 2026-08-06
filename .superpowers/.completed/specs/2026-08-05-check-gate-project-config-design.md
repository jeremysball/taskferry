# Verification Gate and Project Config (`.taskferry.toml`) — Design

Date: 2026-08-05. Status: approved in brainstorm, pending plan.

## Background

The 2026-08-05 usage audit (`findings.md` and `analysis.md` in the
`analyzing-taskferry-usage-and-creating-tooling-around-it` workspace)
measured where taskferry leaks value. The parts this spec attacks:

- Workers skip verification. Of 52 changeset-producing dispatches in the
  dashboard-audit corpus, lint was skipped in 18 and typecheck in 24. Test
  runs are common now (45/52) only because briefs started carrying explicit
  verification instructions. Compliance is prompt-driven and unenforced.
- The orchestrator pays for that gap twice: once as a fix-round dispatch when
  review catches the skip, again as a manual re-run of the whole suite
  because worker self-reports are unreliable (fabricated commit hashes,
  claimed-but-missing report files, misreported test counts were all observed
  in the telemetry-branch SDD run alone).
- Fleet-wide, fix rounds are unmeasurable: no field links a dispatch to the
  task it fixes or retries.

The fix in one sentence: repos declare one check command in a project config
file, taskferry tells every worker to run it and then runs it itself at
settle as the gate that decides whether a changeset is acceptable.

## Issue linkage

- Closes the core of #267 (per-project config file): lands the file
  mechanism and its first-pass field (read-only paths), plus `check`. #267
  stays open only for rewrite paths and skill scoping.
- #292 (TASKFERRY_CHILD leaking into dispatched children's test runs) is a
  direct blocker for dogfooding: the gate runs test suites inside the sandbox,
  so the leak must be fixed (or neutralized for gate runs) before taskferry's
  own gate passes.
- #281/#273 (overlay lifecycle: daemon crash mid-dispatch, extraction racing
  cleanup): the gate lives between settle and overlay cleanup. The plan must
  state what a daemon crash leaves behind for a half-run check (answer at
  plan time: the task settles with `checkStatus: interrupted`, the gate is
  re-runnable, nothing is silently treated as passed).

## Design

### 1. The file: `.taskferry.toml`

- Location: the dispatch's working-tree root, i.e. the worktree itself when
  the dispatch targets a worktree, not the main checkout. TOML.
- Read per dispatch and per settle. Never at daemon boot.
- Precedence: project file > built-in defaults. There is no user-level file
  and no default file anywhere; taskferry never creates one on its own.
  (`taskferry init` writes one only on explicit request, in the project
  directory, after showing and confirming the content.)
- v1 fields:

```toml
# Command the verification gate runs at settle, and that workers are told
# to run before declaring done. Absent = no gate; taskferry says so loudly.
check = "bun x check"

# Optional. Gate run is killed after this many seconds and recorded as a
# timeout. Default 900.
check_timeout_seconds = 900

# Optional. Host paths bound read-only into the sandbox for every dispatch
# from this project. Ignored when sandboxing is off.
read_only_paths = ["/workspace/reference-docs"]
```

- No manifest parsing at runtime, ever. The file is the only configuration
  source; ecosystem sniffing exists only inside `taskferry init` (below).

### 2. Check lifecycle and recording

New persisted fields on the task record (additive, same pattern as the
Tranche 2 fields):

| field | meaning |
|---|---|
| `checkStatus` | `none` (no check declared) / `running` / `passed` / `failed` / `timeout` / `interrupted` (daemon died mid-check) |
| `checkCommand` | the exact command run |
| `checkExitCode` | exit code, null until finished |
| `checkOutputTail` | last ~40 lines of combined output |
| `checkStartedAt` / `checkEndedAt` | timestamps |

`none` and a missing file are surfaced, never silent: `status`, `doctor`
context lines, and the gate refusal message all distinguish "this repo has no
checks" from "checks passed."

Surfacing: `status --full` shows the check block next to the changeset block;
`result --fields` accepts the new field names; `accept` prints the verdict.
No new subcommands.

### 3. Prompt injection (always-on)

When a dispatch has a resolved check command, the daemon appends to the
prompt, unconditionally, before dispatch:

```
## Verification (required)
This repo declares a check command in .taskferry.toml:
    <check command>
Run it before declaring the task done. If it fails, fix the failures and
re-run until it passes. State the final result in your summary.
```

The block is appended to the end of the dispatch prompt. Applies to
`dispatch` role only. Advisor dispatches get neither injection nor gate (no
changeset, nothing to verify).

### 4. The gate

Runs automatically when a task settles with a changeset:

1. Changeset extraction first (diff against `preDispatchHead`, exactly as
   today).
2. Gate second: the check command runs in the overlay tree, after extraction,
   so gate side effects (test artifacts, caches) never contaminate the diff.
3. Result recorded on the task (fields above), overlay then cleaned up on the
   existing schedule.

`checkStatus: running` is visible from the moment the gate starts. Timeout
kills the run and records `timeout`, which behaves as failure everywhere.

Accept semantics:

- `checkStatus` `running`: `accept` refuses with "check still in progress,
  see `taskferry status <id>`." `reject` is always allowed.
- `failed` / `timeout`: `accept` refuses with the fix-forward message
  (below). `accept --force` overrides; the acceptance records
  `checkOverride: true` so forced landings are auditable.
- `passed`: normal accept flow, unchanged.
- `none`: normal accept flow plus a one-line warning that the repo has no
  checks.
- `--no-overlay` dispatches: nothing isolated to gate against; the gate does
  not run and `checkStatus` stays `none`.

The double-run (worker runs checks because the prompt says so, gate runs them
again at settle) is deliberate. The worker run is for fast iteration inside
the session; the gate run is the trust boundary.

### 5. Failure UX

```
$ taskferry accept oc_msgabc12
error: check gate failed for oc_msgabc12
  command: bun x check (from .taskferry.toml)
  exit: 1
  output tail:
    2 tests failed (title-belt, sse)
changeset NOT accepted. To fix forward, resume the worker session:
  taskferry dispatch --session-id ses_02d5608a --parent-task oc_msgabc12 \
    --prompt "Fix: check gate failed. <output tail>"
Override only if you have verified manually: taskferry accept oc_msgabc12 --force
```

No auto-dispatch of fix rounds. The tool prepares the exact command; a human
or orchestrator fires it.

### 6. Retry linkage: `--parent-task`

New dispatch flag `--parent-task <id>`, persisted as `parentTaskId` on the
task record. Carries "this dispatch fixes/retries that one." The gate's
suggested command includes it, so gate-driven fix rounds are linked from day
one; SDD flows can pass it for review-fix rounds too. With this, fix-round
incidence becomes a query over `tasks.json` instead of a prompt-text grep.

### 7. Read-only paths

`read_only_paths` entries become bwrap `--ro-bind` bindings added to the
sandbox setup for every dispatch from the project, alongside the existing
read-write `--allowed-dirs` mechanism. TOML-only in v1 (no new CLI flag, per
#316's direction on CLI surface). Ignored when sandboxing is off
(`--no-sandbox`, `TASKFERRY_DISABLE_SANDBOX=1`, non-Linux): there is no
boundary to bind inside. Documented caveat: this widens what a ferry can
read; same trust class as `--allowed-dirs`, explicit per-repo choice.

### 8. `taskferry init`

One-time scaffolder, the only place ecosystem detection lives:

- Sniffs the repo: package.json scripts (`check` > `test`/`lint`/`typecheck`
  combinations), pyproject.toml (pytest/ruff), go.mod (`go test`/`go vet`),
  Cargo.toml (`cargo test`/`clippy`), bun/deno markers.
- Proposes a `check` command, prints it, waits for confirmation, writes
  `.taskferry.toml` with comments.
- Detects nothing: writes a commented template with `check` left as a
  fill-in, and says plainly that until it's filled there is no gate.
- Never overwrites an existing `.taskferry.toml`.

### 9. Dogfooding

Taskferry itself, in the same change:

- gets a `.taskferry.toml` with `check = "npm run check"`;
- its `check` script grows the `npm test` step it currently lacks (today it
  is syntax-check + lint + typecheck only);
- #292's env leak is fixed so the suite passes inside the sandbox.

The dogfood doubles as the spec's real-exercise verification (section 10).

## Error handling summary

| situation | behavior |
|---|---|
| no `.taskferry.toml` / no `check` key | gate skipped, `checkStatus: none`, loud warning in status and doctor context |
| check run exceeds timeout | killed, `checkStatus: timeout`, treated as failure |
| daemon crashes mid-gate | task settles with `checkStatus: interrupted`; gate re-runnable; never silently passed |
| `.taskferry.toml` unparseable | dispatch proceeds, gate skipped (`checkStatus: none`), parse error surfaced as a task warning and in doctor (fail loudly, do not guess) |
| `read_only_paths` entry doesn't exist on host | dispatch proceeds without that binding, warning surfaced in `status --full` (paths may legitimately differ between machines) |
| check command itself not found at runtime | `checkStatus: failed` with the spawn error in `checkOutputTail` |

## Testing

- Unit (mocked): TOML loader and parse-error surfacing; precedence; check
  state transitions including timeout and interrupted; injection text
  assembly (present when check declared, absent for advisor); `--parent-task`
  propagation and persistence; `read_only_paths` turning into the expected
  bwrap argument list.
- Real exercise (per the "a mocked test is not proof at the system boundary"
  rule): the dogfood. One genuine gated dispatch against the taskferry repo
  itself: worker runs injected checks, settles, gate runs in a real bwrap
  overlay, one pass case and one deliberately failing case (e.g. a broken
  scratch change) proving accept refuses and the fix-forward message renders
  with a real session id.

## Telemetry this unlocks (input to the next spec)

Per-task verification signals (`checkStatus` + timing) and retry chains
(`parentTaskId`) make measurable: verification compliance over time, gate
pass/fail/override rates, fix-round incidence per repo and model, and
wall-time spent in gate runs. The doctor fleet-health spec consumes these;
this spec does not build any doctor surface.

## Non-goals

- Doctor fleet-health surfacing (next spec, stacks on #332's stats engine).
- #267's rewrite paths and skill scoping (stay on #267).
- Auto-firing fix rounds on gate failure.
- A CLI flag for read-only paths.
- Gating `--no-overlay` dispatches.
- Any runtime parsing of package.json / pyproject.toml / go.mod / Cargo.toml
  outside `taskferry init`.
