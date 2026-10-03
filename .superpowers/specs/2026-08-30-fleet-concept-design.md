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
| 3 | Dispatched 9 ferries on `alibaba-tknplan/deepseek-v4-flash-0731` → all 9 crashed `403 AccessDenied.Unpurchased` | Pre-flight probe, cached per model with TTL | #84 + #410 |
| 4 | 11+ tool calls regex-parsing `taskferry result`'s TOON output (escaped `message` field), never succeeded | Side channel is the single source of truth for non-repo deliverables; no message-field parsing | #242 (partial) |
| 5 | One ferry burned 1.23M tokens (oc_mtfxl9c5), ~4M fleet total, no cap | Default thinking level n-1 (proactive cost control) | #561 |
| 6 | `--require-final-marker '\]'` — a literal `]`, trivially satisfied, gate was a no-op | Default marker to `Status:` | #495 |
| 7 | Aborted the wait loop; 2 ferries still running when the operator gave up | `fleet wait` blocks until all settle | #95 |
| 8 | `--rw-bind /tmp` to force durable output through the ephemeral tmpfs | Side channel replaces `/tmp` for deliverables; no `--rw-bind` | new |

The through-line: **every failure is the LLM reconstructing, from scratch, a
fact the daemon already knows** — fleet membership, model eligibility, token
count, settlement state, and the deliverable location. The fix is to make the
daemon own those facts and expose them as primitives, so the operator cannot
get them wrong.

## Framing

**The daemon owns all deterministic state; the LLM only reasons.** This is
the governing principle. The daemon owns fleet membership, model eligibility,
settlement, and the deliverable location. The LLM decides *what* to dispatch,
*writes* the prompts, and *judges* the results — but it never tracks state,
never parses output, never copies a task id for fleet control flow, and never
reconstructs a fact the daemon already holds.

Consequences of this framing, applied to the design:

- **No escape hatches for the LLM.** The pre-flight probe refuses to fan out
  into a hard eligibility failure, period. There is no `--no-probe` for the
  LLM to override. (A human can override via config; the LLM cannot.)
- **Task ids are daemon-internal for fleet operations.** The LLM addresses a
  fleet (`fleet wait <fleetId>`, `fleet result <fleetId>`), never a member id.
  The fleet *exposes* member ids so the LLM can pull specific data
  (`fleet result <fleetId> --member <id>`, or `taskferry result <id>` for a
  member's full result), but a task id never enters fleet *control flow*.
  Ferry-wise operations still hand the LLM its own task id — the scoping is
  fleet-level, not ferry-level.

## What already exists (do not duplicate)

This design must reconcile with two prior specs, not re-derive them:

- **`wait-all`** (`2026-08-18-wait-all-design.md`, unmerged branch
  `feat/wait-all`): a client fan-out of the existing `task.wait` RPC that
  blocks until N ids (or a directory scope) settle. It covers the "wait for a
  group" half of the fleet problem, including `--summarize` heartbeat and
  `--mine`/`--parent` scoping for recursive fit. **Status: design only — two
  markdown files, zero code, zero review.** It is not a PR and has not been
  reviewed.
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
  **Sequencing note:** `wait-all` is unbuilt (design only), so it must be
  implemented and reviewed before `fleet wait` can delegate to it.
- `fleet result` aggregates member deliverables. It reads from the **side
  channel** (below) when one exists, and from `--directory` otherwise. It does
  not parse the `message` field.

### 3. Pre-flight probe, cached with TTL (failure mode #3)

Before fanning out, `fleet dispatch` probes each distinct `--model` once with
a minimal completion. If the probe returns a hard eligibility failure
(`403 AccessDenied.Unpurchased`, `401`, `404 model not found`), the fleet
dispatch **refuses to fan out** and reports which model failed and why.

- **Caching:** probe results are cached per model. A fleet re-fetches only
  when the same model is dispatched more than N times within the fleet.
  Single dispatches also run a probe when the cached TTL has passed. So the
  probe is a cached, TTL'd eligibility check, not a per-dispatch cost.
- **Failure taxonomy:** hard eligibility failures (403/401/404) block the
  fan-out. Transient failures (429, 5xx) do not — they are reported as a
  warning, because a rate limit is not an eligibility problem. The operator
  conflated the two (treated a 429 as a config fault, then a 403 as
  transient); the probe makes the distinction deterministic.
- No `--no-probe` escape hatch for the LLM (see Framing).

### 4. Side channel (failure modes #4 and #8)

The side channel is the general-purpose "not a repo change" deliverable path.
It is a substrate-level concept, not a fleet-level one; the fleet consumes it.

**Two destinations, split by what the deliverable is:**

1. **`--directory`** — anything that *belongs in the repo* (code, docs,
   config). Goes through the overlay, gated by accept/reject.
2. **Side channel** — anything that *doesn't* belong in `--directory`:
   advisor answers, review findings, candidate JSON, any report the operator
   wants to read without pulling it through the overlay and rejecting it.

**Allocation rule:** the side channel is allocated when `(git repo AND
overlay)` **OR** `role is advisor`. When neither is true, `--directory` is a
plain writable dir, so a non-repo deliverable just lands there and is read
directly — no separate channel needed.

This is a change from today: the current code allocates the output dir for
*every* dispatch unconditionally (`src/tasks.js:7476-7480`, citing
`taskferry#423`). The side channel becomes conditional, and the prompt block
(`src/output-dir.js:115`, currently "## Persistent output dir") is renamed to
match.

**Why this fixes the operator's failure:** the operator told ferries to write
durable JSON to `/tmp/kilo/candidates-$id.json` — the *ephemeral* per-ferry
tmpfs (`src/sandbox.js:202` pushes `--tmpfs /tmp`) — then passed
`--rw-bind /tmp` to force the host `/tmp` into the sandbox so the files would
survive. That `--rw-bind /tmp` lands after `--tmpfs /tmp` and un-masks the
whole host `/tmp` read-write to every ferry — the sibling-exposure class of
bug the recursive spec's prerequisite defects (#453/#454/#455) closed. The
operator reached for the wrong mechanism to get durability and reopened the
hole. The side channel is the correct mechanism, and it is already a daemon
primitive (`$TASKFERRY_OUTPUT_DIR`, `taskferry output <id>`).

**`fleet result` reads member deliverables from the side channel** when one
exists, and from `--directory` otherwise. No message-field parsing, no `/tmp`,
no `--rw-bind`.

### 5. Default thinking level n-1 (failure mode #5)

The token budget idea was rejected. The proactive cost control is a lower
default thinking level: an omitted `--variant` defaults to the model's
second-highest declared level (n-1), not the top. Filed as **#561**. A caller
wanting the true maximum passes the concrete top level explicitly.

### 6. `--format json` on script-consumed commands (failure mode #4, partial)

TOON is *not* the problem — it is doing exactly what it is designed to do
(`@toon-format/toon` README: "intended for LLM input"). It is fully
round-trippable via `decode()`. The operator's failure was a category error:
scraping the LLM-input format for machine data, and not knowing a decoder
existed.

The residual gap is that `result`/`list`/`status` have no machine format.
`--format` is gated to `["watch", "context"]` only (`src/args.js:442`).
Extending `--format json` to `result`/`list`/`status` (#242) gives a
dependency-free, stable machine contract. This is secondary to the side
channel — the side channel is the primary fix for "how does the operator get
results out," and `--format json` is the fallback for the human/LLM-facing
default.

### 7. Default `--require-final-marker` (failure mode #6)

`--require-final-marker` with no value defaults to `Status:` (#495). The
operator passed `'\]'` — a literal `]` that any JSON array satisfies — which
made the completeness gate a no-op. A default that means "the standard final
status line" removes the footgun of a caller inventing a trivially-satisfied
marker.

## Decisions

1. **Fleet is a grouping record, not a task class.** Members are ordinary
   tasks; the fleet is durable metadata. Preserves "one ferry type."
2. **`fleet wait` delegates to `wait-all`.** One-directional dependency;
   no parallel wait implementation. `wait-all` must be built and reviewed
   first (it is currently design-only).
3. **Pre-flight probe gates on hard eligibility failures only.** 403/401/404
   block; 429/5xx warn. Cached per model with TTL; re-fetched when a fleet
   dispatches the same model more than N times. No `--no-probe` for the LLM.
4. **No token budget.** Replaced by the n-1 default thinking level (#561).
5. **Side channel is the single source of truth for non-repo deliverables.**
   Allocated when `(git AND overlay) OR advisor`. `fleet result` reads from
   it when present, from `--directory` otherwise. No message-field parsing.
6. **Task ids are daemon-internal for fleet control flow, exposed for fleet
   data access.** The LLM never copies a member id to drive fleet operations.
7. **`--format json` is a fallback, not the primary fix.** The side channel
   is primary; `--format json` (#242) covers the human/LLM-facing default.
8. **The skill is demoted to an option.** A thin `managing-ferry-fleets`
   skill that points at these primitives is possible, but it is not the
   deliverable. The primitives are.

## Open (deferred, no evidence yet)

- Exact `fleet dispatch` flag shape (`--model` repeat vs `--count` vs a
  manifest file). Sketch only; lock during implementation.
- Whether the pre-flight probe is a throwaway dispatch or a direct provider
  HTTP check. Depends on provider-shape knowledge; the throwaway dispatch is
  the provider-agnostic fallback.
- The probe cache's N (re-fetch threshold) and TTL values. Sketch only.
- Fleet-level aggregate budget (sum of members) vs per-member only. Deferred;
  the n-1 default is the proactive control, and no aggregate budget is
  proposed until a real fleet shows the need.

## Files touched (sketch)

- `src/command-specs.js` — `fleet` subcommand group (dispatch/status/wait/result)
- `src/args.js` — `fleet` parsing, `--format json` on result/list/status,
  `--prompt @file`, default `--require-final-marker`
- `src/commands.js` — `runFleetDispatch`/`runFleetStatus`/`runFleetWait`/
  `runFleetResult`; `fleet wait` delegates to `wait-all`
- `src/protocol.js` + `src/tasks.js` — fleet record persistence, pre-flight
  probe with cache/TTL, conditional side-channel allocation
- `src/output-dir.js` — rename "Persistent output dir" → side channel;
  conditional allocation
- `src/output.js` — `--format json` projection for result/list/status
- `docs/cli-reference.md` — fleet section, side channel section
- Tests: `src/args.test.js`, `src/commands.test.js`, `src/tasks.*.test.js`

## Verification

- `npm test` (existing suite plus new fleet cases)
- Manual: `fleet dispatch --model <a> --model <b> --count 3` returns one
  `fleetId` + 6 member ids; `fleet wait` converges to `6/6 settled`;
  `fleet result` returns member deliverables from the side channel
- Manual: `fleet dispatch --model <unpurchased-model>` refuses to fan out
  and names the 403
- Manual: a non-git, non-overlay dispatch has no side channel; its deliverable
  lands in `--directory`
- Manual: an advisor dispatch always gets a side channel, even non-git
- Manual: `taskferry result <id> --format json` returns valid JSON, not TOON

## Out of scope

- Token budget (rejected; see Decision 4)
- Fleet-level aggregate budget (deferred)
- Background/detach fleet mode (no Monitor wake primitive; `fleet wait`
  foreground blocks, same as `wait-all`)
- Tree rendering of fleet lineage (a fleet is flat; lineage is the recursive
  spec's concern)
- The recursive orchestration prerequisites (sibling overlay exposure,
  read-only socket guard) — those gate `--mine`/recursive fit, not the flat
  fleet concept
