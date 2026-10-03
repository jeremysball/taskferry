# Structure Outline — Fleet Concept

Slug: `fleet-concept`. Source: `2026-08-30-fleet-concept-design.md` (approved).

Ordering principle: each phase is a vertical, independently testable
increment. Foundational primitives (side channel, probe) land before the
fleet commands that consume them. The small CLI ergonomics (`--format json`,
`--prompt @file`, default marker) are independent and grouped where they
share a file surface.

**`wait-all` is a separate track.** This outline assumes `wait-all` is
implemented and reviewed before Phase 8 (`fleet wait`). The interface
contract `fleet wait` needs from `wait-all` is stated in Phase 8 so it
informs how `wait-all` is built, without pulling `wait-all` into this plan.

**`#561` (n-1 default thinking level) is a separate track.** It is listed as
Phase 9 for completeness but is independently shippable and does not block
any fleet phase.

---

# Phase 1 — Side channel: conditional allocation + rename

**Testable result:** A dispatch allocates a side channel only when
`(git repo AND overlay) OR role is advisor`. A non-git, non-overlay dispatch
has no side channel and its deliverable lands in `--directory`. An advisor
always gets a side channel, even non-git. The prompt block and env var are
renamed from "Persistent output dir" to "side channel".

**Files touched:**
- `src/tasks.js` — conditional allocation at dispatch (currently unconditional, `:7476-7480`)
- `src/output-dir.js` — rename `outputDirPromptBlock` text; keep `$TASKFERRY_OUTPUT_DIR` env var name (or add alias)
- `src/tasks.*.test.js` — allocation-condition cases

**Checks:**
- `npm test`
- Manual: non-git non-overlay dispatch → no side channel, deliverable in `--directory`
- Manual: advisor dispatch → side channel present
- Manual: git+overlay dispatch → side channel present

---

# Phase 2 — `--format json` on `result`/`list`/`status`

**Testable result:** `taskferry result <id> --format json` returns valid
JSON (not TOON); same for `list` and `status`. `toon` remains the default.

**Files touched:**
- `src/args.js` — extend `--format` gate from `["watch","context"]` to include `result`/`list`/`status` (`:442`)
- `src/output.js` — JSON projection for the three commands
- `src/args.test.js`, `src/commands.test.js`

**Checks:**
- `npm test`
- Manual: `taskferry result <id> --format json | jq .` parses cleanly

---

# Phase 3 — Dispatch ergonomics: `--prompt @file` + default `--require-final-marker`

**Testable result:** `taskferry dispatch --prompt @prompt.md` reads the
prompt from a file. `--require-final-marker` with no value defaults to
`Status:`.

**Files touched:**
- `src/args.js` — `@file` expansion for `--prompt`; default value for `--require-final-marker`
- `src/commands.js` — read file into prompt
- `src/args.test.js`, `src/commands.test.js`

**Checks:**
- `npm test`
- Manual: `--prompt @file` dispatches with file contents
- Manual: `--require-final-marker` (no value) enforces `Status:`

---

# Phase 4 — Pre-flight probe, cached with TTL

**Testable result:** `fleet dispatch` (and single `dispatch`) probes a model
before fan-out. A hard eligibility failure (403/401/404) refuses the fan-out
and names the model. Probe results are cached per model; a fleet re-fetches
when the same model is dispatched more than N times; single dispatches probe
on TTL expiry. Transient failures (429/5xx) warn, not block.

**Files touched:**
- `src/tasks.js` — probe execution, cache, TTL, failure taxonomy
- `src/config.js` — probe cache N and TTL knobs (flag/env/config triplet)
- `src/command-specs.js` — probe-related flags
- `src/tasks.*.test.js`

**Checks:**
- `npm test`
- Manual: dispatch on an unpurchased model refuses and names the 403
- Manual: cached probe is not re-run within TTL; re-run after TTL expiry

---

# Phase 5 — Fleet grouping record + `fleet dispatch`

**Testable result:** `fleet dispatch --model <a> --model <b> --count <n>`
fans out atomically, returns one `fleetId` + member ids. The fleet record is
durable (survives daemon restart). Members are ordinary tasks.

**Files touched:**
- `src/command-specs.js` — `fleet` subcommand group
- `src/args.js` — `fleet dispatch` parsing
- `src/commands.js` — `runFleetDispatch`
- `src/protocol.js` + `src/tasks.js` — fleet record persistence
- `src/commands.test.js`, `src/tasks.*.test.js`

**Checks:**
- `npm test`
- Manual: `fleet dispatch` returns `fleetId` + N member ids atomically
- Manual: fleet record survives daemon restart

---

# Phase 6 — `fleet status` + `fleet result`

**Testable result:** `fleet status <fleetId>` returns every member's status
in one call. `fleet result <fleetId>` aggregates member deliverables from the
side channel when present, from `--directory` otherwise. No message-field
parsing.

**Files touched:**
- `src/commands.js` — `runFleetStatus`, `runFleetResult`
- `src/args.js` — `fleet status`/`fleet result` parsing, `--member <id>` for data access
- `src/commands.test.js`

**Checks:**
- `npm test`
- Manual: `fleet result` returns side-channel deliverables for git+overlay members
- Manual: `fleet result --member <id>` returns one member's full result

---

# Phase 7 — `fleet wait`

**Testable result:** `fleet wait <fleetId>` blocks until every member
settles, delegating to `wait-all`.

**Files touched:**
- `src/commands.js` — `runFleetWait` resolves member ids, delegates to `wait-all`
- `src/commands.test.js`

**Checks:**
- `npm test`
- Manual: `fleet wait` converges to `N/N settled`

**Interface contract for `wait-all` (informs the separate track):**
`fleet wait` needs `wait-all` to accept an explicit id list and block until
all settle, returning per-id terminal status. It does not need `wait-all`'s
directory-scope or `--mine`/`--parent` modes. The delegation is
`wait-all <memberIds...> --timeout <t>`; `fleet wait` adds the fleet-id
resolution and the `N/M settled` tally.

---

# Phase 8 — `#561`: default thinking level n-1

**Testable result:** An omitted `--variant` defaults to the model's
second-highest declared level, not the top. Explicit concrete levels still
work.

**Files touched:**
- `src/variants.js` — `resolveVariant`/`rankOpencodeVariants` resolve `"highest"` to n-1
- `src/tasks.js` — default resolution (`:4399`)
- `src/variants.test.js`, `src/tasks.*.test.js`

**Checks:**
- `npm test`
- Manual: dispatch with no `--variant` uses n-1, not the top

---

## Dependency graph

```
Phase 1 (side channel) ──┐
Phase 2 (--format json)  │  independent
Phase 3 (ergonomics)     │  independent
Phase 4 (probe) ─────────┼──> Phase 5 (fleet dispatch)
                         │        └──> Phase 6 (status/result) ──> Phase 7 (wait)
Phase 8 (#561)           │  independent
```

- Phase 5 depends on Phase 4 (dispatch probes before fan-out).
- Phase 6 depends on Phase 1 (side channel) and Phase 5 (fleet record).
- Phase 7 depends on Phase 6 and the separate `wait-all` track.
- Phases 2, 3, 8 are independent and can land in any order.
