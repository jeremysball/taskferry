# Fleet Concept — Deterministic Multi-Task Management

Date: 2026-08-30. Status: design discussion (RPI), ready for a structure
outline. Supersedes the "fleet-management skill" framing: the deliverable is
a set of daemon/CLI primitives that make multi-ferry management deterministic,
not a skill that teaches an operator to do it by hand.

## Background

Two independent Muse sessions failed at the same thing: managing a fleet of
ferries. The first (`ses_fdeb4bc58f`, 8-issue fleet #507–#514) is catalogued
in `case-study.md` (18 failure modes). The second (`ses_face09d5bf`, a 9-ferry
`medium` code review of dotclaude#88) failed on a tighter set, all of which
trace to the same root cause: **the operator re-implemented, by hand in bash,
state the daemon already holds.**

The second session's failure modes, mapped to deterministic fixes:

| # | What the operator did (squishy) | Deterministic fix | Issue |
|---|---|---|---|
| 1 | Hand-wrote a `for` loop to fan out 9 dispatches, grepped ids into a scratch file, hand-copied them into a second wait loop | First-class fleet: one call fans out, returns `fleetId` + member ids atomically | #95 |
| 2 | Guessed `--prompt-file` (doesn't exist), burned a dispatch, read `--help`, rewrote | `--prompt @file`; fleet removes the hand-written script entirely | new |
| 3 | Dispatched 9 ferries on `alibaba-tknplan/deepseek-v4-flash-0731` → all 9 crashed `403 AccessDenied.Unpurchased` | Pre-flight probe: fleet probes the model once, refuses to fan out on 403 | #84 + #410 |
| 4 | 11+ tool calls regex-parsing `taskferry result`'s TOON output (escaped `message` field), never succeeded | `--format json` on `result`/`list`/`status` | #242 |
| 5 | One ferry burned 1.23M tokens (oc_mtfxl9c5), ~4M fleet total, no cap | Per-task token budget, daemon-enforced | new |
| 6 | `--require-final-marker '\]'` — a literal `]`, trivially satisfied, gate was a no-op | Default marker to `Status:` | #495 |
| 7 | Aborted the wait loop; 2 ferries still running when the operator gave up | `fleet wait` blocks until all settle | #95 |
| 8 | `--rw-bind /tmp` needed for the diff file (sandbox tmpfs shadowing) | Documented; fleet auto-binds the diff | minor |

The through-line: **every failure is the LLM reconstructing, from scratch, a
fact the daemon already knows** — fleet membership, model eligibility, token
count, settlement state. The fix is to make the daemon own those facts and
expose them as primitives, so the operator cannot get them wrong.

## What already exists (do not duplicate)

This design must reconcile with two prior specs, not re-derive them:

- **`wait-all`** (`2026-08-18-wait-all-design.md`, unmerged worktree
  `feat/wait-all`): a client fan-out of the existing `task.wait` RPC that
  blocks until N ids (or a directory scope) settle. It already covers the
  "wait for a group" half of the fleet problem, including `--summarize`
  heartbeat and `--mine`/`--parent` scoping for recursive fit.
- **`recursive-ferry-orchestration-design.md`** (`2026-08-11`): daemon-derived
  `parentTaskId`/`depth`, self-identity mounts, parking, nested changesets.
  It defines *lineage* (parent/child), not *grouping* (a flat set of siblings).

The fleet concept is the missing third layer: **a flat, named group of
sibling tasks that is dispatched atomically and managed as a unit.** It is
orthogonal to lineage (a fleet's members are siblings, not parent/child) and
to `wait-all` (which waits on ids but does not create or name a group).

## Design

### 1. Fleet as a first-class group

A fleet is a named, flat set of sibling tasks created in one dispatch call.

```
taskferry fleet dispatch --prompt @prompt.md --model <a> --model <b> ... --count <n>
```

- Fans out N dispatches in one call. Returns one `fleetId` plus the member
  task ids, atomically — no grep, no scratch file, no hand-copied id list.
- `--model` may be repeated (mixed-strength panel) or combined with `--count`
  (N copies of one model). Exact flag shape is a sketch, not locked.
- Members are ordinary tasks; a fleet is a grouping record, not a new task
  class. This preserves the recursive spec's "one ferry type" principle.

The fleet record is:

```
fleetId: string
name: string | null        (optional --name, else derived)
memberTaskIds: string[]    (ordered, dispatch order)
createdAt: number
```

Stored durably (same persistence as tasks), so a fleet survives a session
compaction or daemon restart — the exact state the operator lost in both
case studies.

### 2. Fleet lifecycle commands

```
taskferry fleet status <fleetId>   # every member's status in one call
taskferry fleet wait <fleetId>     # block until every member settles
taskferry fleet result <fleetId>   # aggregated results across members
```

- `fleet status` replaces the per-id polling loop. It is a single
  `task.list`-shaped projection filtered to `memberTaskIds`, not N RPCs.
- `fleet wait` is `wait-all` over the fleet's member ids. It should be
  implemented *on top of* `wait-all`, not as a parallel implementation —
  `fleet wait <fleetId>` resolves the member ids and delegates to the
  `wait-all` code path. This is the one place the two specs touch, and the
  dependency is one-directional: fleet depends on wait-all, never the reverse.
- `fleet result` aggregates `task.result` across members. With `--format json`
  (below) it returns a machine-parseable array, which is the fix for failure
  mode #4.

### 3. Pre-flight probe (failure mode #3)

Before fanning out, `fleet dispatch` probes each distinct `--model` once with
a minimal completion. If the probe returns a hard eligibility failure
(`403 AccessDenied.Unpurchased`, `401`, `404 model not found`), the fleet
dispatch **refuses to fan out** and reports which model failed and why.

- This is #84's cheap-model probe generalized from "disambiguate a hang" to
  "gate a fan-out." The probe is a single throwaway dispatch+wait+result, or
  a direct provider HTTP check where the provider shape is known.
- Transient failures (429, 5xx) do not block the fan-out; they are reported
  as a warning, because a rate limit is not an eligibility problem. The
  distinction is the same one the operator failed to make in the session
  (it treated a 429 as a config fault, then treated a 403 as transient).
- `--no-probe` escapes the gate for callers who know better.

### 4. Per-task token budget (failure mode #5)

A `maxTokens` cap on a task, daemon-enforced. Tokens are already accumulated
per task from `step_finish` usage events (`src/tasks.js:2089`) and surfaced
in `result` (`src/protocol.js:32`), so this is a cap on an existing signal,
not new instrumentation.

- Flag `--max-tokens <n>`, env `TASKFERRY_MAX_TOKENS`, config `maxTokens`,
  resolved with the standard flag > env > config > default precedence
  (default: unset, no cap).
- Enforcement is at settlement: a task whose accumulated `tokens.total`
  exceeds the cap is flagged `budgetExceeded: true` in `result`/`status`.
  A live kill mid-run is deferred — tokens are only known at `step_finish`,
  and a hard kill on a partial step is worse than a post-hoc flag. The flag
  is what the operator needed: a deterministic "this ferry went over budget"
  signal instead of discovering a 1.23M-token ferry by reading `result`
  after the fact.
- `fleet dispatch` accepts `--max-tokens` and applies it to every member, so
  a fleet has a per-member budget in one flag.

### 5. `--format json` on script-consumed commands (failure mode #4)

Extend `--format toon|json` to `result`, `list`, and `status` (it currently
gates to `watch`/`context` only, `src/args.js:442`). This is #242, already
filed, and it is the direct fix for the 11-tool-call parsing failure: the
operator was scraping a display format (`toon`) that never promised
stability. `json` for machines, `toon` stays the human default.

`fleet result --format json` returns a JSON array of member results, which
is the machine-parseable aggregate the operator was trying to reconstruct by
hand.

### 6. Default `--require-final-marker` (failure mode #6)

`--require-final-marker` with no value defaults to `Status:` (#495). The
operator passed `'\]'` — a literal `]` that any JSON array satisfies — which
made the completeness gate a no-op. A default that means "the standard final
status line" removes the footgun of a caller inventing a trivially-satisfied
marker.

## Decisions

1. **Fleet is a grouping record, not a task class.** Members are ordinary
   tasks; the fleet is durable metadata. Preserves "one ferry type."
2. **`fleet wait` delegates to `wait-all`.** One-directional dependency;
   no parallel wait implementation.
3. **Pre-flight probe gates on hard eligibility failures only.** 403/401/404
   block; 429/5xx warn. `--no-probe` escapes.
4. **Token budget is a settlement-time flag, not a live kill.** Tokens are
   only known at `step_finish`; a post-hoc `budgetExceeded` flag is the
   deterministic signal the operator needed, and a live kill is deferred.
5. **`--format json` is the parsing fix, not a better regex.** The operator's
   failure was scraping a display format; the fix is a machine format, which
   #242 already names.
6. **The skill is demoted to an option.** A thin `managing-ferry-fleets`
   skill that points at these primitives is possible, but it is not the
   deliverable. The primitives are.

## Open (deferred, no evidence yet)

- Exact `fleet dispatch` flag shape (`--model` repeat vs `--count` vs a
  manifest file). Sketch only; lock during implementation.
- Whether the pre-flight probe is a throwaway dispatch or a direct provider
  HTTP check. Depends on provider-shape knowledge; the throwaway dispatch is
  the provider-agnostic fallback.
- Live token kill vs settlement flag. Deferred per Decision 4; revisit if a
  real fleet shows a runaway ferry that must be stopped mid-run.
- Fleet-level aggregate budget (sum of members) vs per-member only. Per-member
  first; aggregate is a later knob.

## Files touched (sketch)

- `src/command-specs.js` — `fleet` subcommand group (dispatch/status/wait/result)
- `src/args.js` — `fleet` parsing, `--format json` on result/list/status,
  `--max-tokens`, `--prompt @file`, default `--require-final-marker`
- `src/commands.js` — `runFleetDispatch`/`runFleetStatus`/`runFleetWait`/
  `runFleetResult`; `fleet wait` delegates to `wait-all`
- `src/protocol.js` + `src/tasks.js` — fleet record persistence, `maxTokens`
  cap check at settlement, pre-flight probe
- `src/output.js` — `--format json` projection for result/list/status
- `docs/cli-reference.md` — fleet section
- Tests: `src/args.test.js`, `src/commands.test.js`, `src/tasks.*.test.js`

## Verification

- `npm test` (existing suite plus new fleet cases)
- Manual: `fleet dispatch --model <a> --model <b> --count 3` returns one
  `fleetId` + 6 member ids; `fleet wait` converges to `6/6 settled`;
  `fleet result --format json` returns a parseable array
- Manual: `fleet dispatch --model <unpurchased-model>` refuses to fan out
  and names the 403
- Manual: a task dispatched with `--max-tokens 1000` that exceeds it shows
  `budgetExceeded: true` in `result`
- Manual: `taskferry result <id> --format json` returns valid JSON, not TOON

## Out of scope

- Live token kill (deferred, Decision 4)
- Fleet-level aggregate budget (deferred)
- Background/detach fleet mode (no Monitor wake primitive; `fleet wait`
  foreground blocks, same as `wait-all`)
- Tree rendering of fleet lineage (a fleet is flat; lineage is the recursive
  spec's concern)
- The recursive orchestration prerequisites (sibling overlay exposure,
  read-only socket guard) — those gate `--mine`/recursive fit, not the flat
  fleet concept
