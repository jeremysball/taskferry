# 02 — Research: Fleet Concept (Deterministic Multi-Task Management)

Slug: `fleet-concept`
Source: case study of session `ses_face09d5bf` (Muse 9-ferry `medium` review of dotclaude#88, 2026-08-30) + taskferry source + open issue list. Prior case study `ses_fdeb4bc58f` (8-issue fleet #507–#514) is catalogued in `case-study.md` and referenced where it corroborates.

Note: this supersedes the earlier `fleet-management-skill` research framing. The deliverable changed from "a skill that teaches fleet discipline" to "deterministic primitives that make fleet discipline un-failable." The questions below are the reframed set; the old `01-questions.md` (skill-shaped, Q6 asks "what shape for the fleet skill") is stale and should be retired, not answered.

## Q1 — What did the operator re-implement by hand that the daemon already knows?

**Finding:** Every failure in `ses_face09d5bf` is the operator reconstructing, in bash, a fact the daemon already holds. The daemon knows fleet membership (it created the tasks), model eligibility (it got the 403), token count (it accumulates `step_finish` usage), and settlement state (it owns the task lifecycle). The operator rebuilt all four from scratch and got each wrong.

**Evidence:**
- Fleet membership: operator hand-wrote `/tmp/dispatch_medium2.sh` fanning out 9 dispatches, then hand-copied 9 ids into `/tmp/wait_medium2.sh` (session tool calls #225/#229).
- Model eligibility: all 9 first-batch ferries crashed `403 AccessDenied.Unpurchased` on `alibaba-tknplan/deepseek-v4-flash-0731` (session tool #227, log `{"code":"AccessDenied.Unpurchased"}`).
- Token count: `taskferry result` already surfaces `tokens.total` (`src/protocol.js:32`); operator discovered the 1.23M-token ferry (oc_mtfxl9c5) only by reading `result` after the fact.
- Settlement: operator aborted the wait loop with 2 ferries still running (session tool #229, "User aborted the command").

**Confidence:** High. Directly observed in the session transcript and source.

## Q2 — Which failure modes are already filed as issues, and which are new?

**Finding:** Four of the eight failure modes map to open issues; four are new.

| Failure mode | Issue | State |
|---|---|---|
| Hand-written fan-out + id-scraping + wait loop | #95 (fleet concept) | open, 1mo |
| Scraping TOON output for machine data | #242 (`--format json`) | open, 1mo |
| No pre-flight model eligibility check | #84 (cheap probe) + #410 (`providers --stats`) | open |
| Trivially-satisfied `--require-final-marker` | #495 (default to `Status:`) | open |
| `--prompt-file` doesn't exist | — | new |
| No per-task token budget | — | new (no `maxTokens` key in `src/config.js`) |
| No settlement watcher (aborted wait) | — | new (but `wait-all` spec covers the wait half) |
| Sandbox /tmp shadowing of the diff file | — | documented in CLAUDE.md, minor |

**Evidence:** `gh-axi issue list --state open` (152 open); `src/config.js:29-58` (config keys, no `maxTokens`); `src/args.js:442` (`--format` gated to `["watch","context"]` only).

**Confidence:** High. Issue states and source verified directly.

## Q3 — What deterministic primitives already exist, and what is their exact contract?

**Finding:** The substrate already has most of the raw material; the fleet concept is a grouping layer on top, not new machinery.

- `taskferry dispatch` returns a task id and full detail atomically (`src/commands.js:218` `runDispatch` → `task.dispatch`).
- `taskferry wait <id>` blocks on one id; `--summarize` streams progress (`src/command-specs.js:32`).
- `taskferry result <id> --fields message,tokens` returns the final message and token usage (`src/command-specs.js:78`).
- `taskferry watch --all --summaries` streams settle events (`src/command-specs.js:90`).
- `--class <name>` tags a task, but `list` has **no** `--class` filter — the tag is write-only for querying (`src/command-specs.js:84`).
- `--parent-task <id>` tags a dispatch as fixing/retrying an earlier task; it is caller-supplied and unverified (`src/command-specs.js:5`), distinct from the recursive spec's daemon-derived `parentTaskId`.
- Tokens are accumulated per task from `step_finish` usage (`src/tasks.js:2089`) and surfaced in `result` (`src/protocol.js:32`).

**Evidence:** `src/command-specs.js`, `src/commands.js:218`, `src/tasks.js:2089`, `src/protocol.js:32`.

**Confidence:** High. Read from source, not inferred.

## Q4 — What is the relationship between fleet, wait-all, and recursive orchestration?

**Finding:** Three distinct layers, one-directional dependencies.

- **`wait-all`** (`2026-08-18-wait-all-design.md`, unmerged `feat/wait-all` worktree): a client fan-out of `task.wait` that blocks until N ids (or a directory scope) settle. Covers the "wait for a group" half.
- **Recursive orchestration** (`2026-08-11-recursive-ferry-orchestration-design.md`): daemon-derived `parentTaskId`/`depth`, self-identity, parking, nested changesets. Defines *lineage* (parent/child), not *grouping*.
- **Fleet** (this work): a flat, named group of sibling tasks dispatched atomically and managed as a unit. Orthogonal to lineage (members are siblings, not parent/child) and to `wait-all` (which waits on ids but does not create or name a group).

`fleet wait` should delegate to `wait-all` (one-directional: fleet depends on wait-all, never the reverse). The recursive spec's prerequisite defects (sibling overlay exposure, read-only socket guard) gate `--mine`/recursive fit, not the flat fleet concept.

**Evidence:** `2026-08-18-wait-all-design.md`, `2026-08-11-recursive-ferry-orchestration-design.md` (both in `.superpowers/specs/`).

**Confidence:** High. Both specs read in full.

## Q5 — What is the token-budget mechanism, and why settlement-flag not live-kill?

**Finding:** Tokens are only known at `step_finish` (`src/tasks.js:2089` sums `evt.part.tokens`). A live kill mid-run would fire on a partial step with no clean signal. A settlement-time `budgetExceeded` flag is the deterministic signal the operator needed — "this ferry went over budget" — without inventing a mid-run kill that the token stream can't cleanly support.

**Evidence:** `src/tasks.js:2083-2089` (step_finish accumulation), `src/executor.js:411` (`tokens: lastAssistant.usage`).

**Confidence:** High for the mechanism; the settlement-flag-vs-live-kill choice is a design decision (recorded in the design spec, Decision 4), not a research fact.

## Q6 — What is the pre-flight probe's failure taxonomy?

**Finding:** The operator conflated two distinct failure classes. A `403 AccessDenied.Unpurchased` is a hard eligibility failure (the model is not purchasable on that provider route) — it will fail every member of a fan-out identically. A `429`/`5xx` is transient (rate limit / overload) — it may pass on retry. The probe must gate on the former and warn on the latter. The operator did the reverse: treated a 429 as a config fault (session, kilo roll-call), then treated a 403 as transient and re-dispatched 9 ferries into it.

**Evidence:** session tool #227 (403 `AccessDenied.Unpurchased` on all 9); session tool #229 (re-dispatch on a different model after the 403s); `src/tasks.js:277-282` (provider "quota"/"usage limit" error classification already exists).

**Confidence:** High. Both failure classes observed directly in the session.

## Cross-cutting finding

The operator treated a fleet as a sequence of individual dispatches. The daemon already holds the fleet's membership, the model's eligibility, the token count, and the settlement state. The fix is to make the daemon own those facts and expose them as primitives — `fleet dispatch`/`status`/`wait`/`result`, a pre-flight probe, a token budget, and `--format json` — so the operator cannot get them wrong. This is the same root cause as the first case study (`case-study.md` "Cross-cutting root cause"), reached independently, which strengthens the evidence base.
