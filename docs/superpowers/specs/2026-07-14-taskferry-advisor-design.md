# taskferry_advisor: a blocking "ask a bigger model" tool

## Context

taskferry (this repo) is an MCP server that lets a calling model dispatch background
`opencode run` tasks and poll them (`taskferry_dispatch`, `taskferry_wait`,
`taskferry_status`, `taskferry_tail`, `taskferry_result`, `taskferry_summary`,
`taskferry_cancel`, `taskferry_list`). Every existing tool follows a fire-and-forget
pattern: dispatch now, poll later.

Anthropic's Claude Code ships a different, server-side "Advisor" tool
(`BetaAdvisorTool20260301`): a weaker executor model can call a stronger advisor model
mid-turn, block, and get an answer back inline before continuing — closer to a subagent
consult than a background task. That tool is entirely server-side (Anthropic's backend
decides when to invoke it and runs the exchange); nothing about its trigger logic or
prompt is present client-side, so it can't be copied — only the *shape* of the
interaction (ask, block, get an answer, keep going) is worth reproducing.

This spec defines a taskferry-native equivalent: **`taskferry_advisor`**, a blocking
tool any caller model can invoke to consult a different (typically stronger) model
mid-task, built entirely out of taskferry's existing dispatch/wait/result machinery.

Concretely: a weaker model (e.g. Sonnet, or a project's "Terra" agent) calls
`taskferry_advisor` with a self-contained question and a target model (e.g.
`openai/gpt-5.6-sol`, `zai/glm-5.2`), blocks until it answers, and continues its own
turn with that answer in hand.

## Scope

1. Rename `taskferry_wait` → `taskferry_poll`.
2. New tool: `taskferry_advisor`.
3. Advisor session TTL/recency tracking.

Out of scope: model-strength pairing enforcement (vanilla advisor's "advisor ≥
executor" rule) — the caller is trusted to pick a sensible advisor model, the same way
`taskferry_dispatch`'s `model` param is already trusted today.

## 1. Rename `taskferry_wait` → `taskferry_poll`

Purely mechanical, done to free up "wait" as vocabulary for the advisor's own built-in
blocking behavior, so the two aren't confusable in tool descriptions or in a caller's
reasoning about which one to use.

- `server.js`: tool name `taskferry_wait` → `taskferry_poll` (title/description text
  unchanged in meaning, `taskferry_wait` reference in taskferry_advisor's error paths
  and every other tool's description updated to `taskferry_poll`).
- `tasks.js`: internal `wait()` function renamed to `poll()`. Nothing external depends
  on the internal function name; renamed for consistency with the tool it backs.
- `tasks.test.js`, `wait-smoke-test.js`, `README.md`: references updated. Consider
  renaming `wait-smoke-test.js` → `poll-smoke-test.js` for consistency (mechanical,
  matches existing `cancel-smoke-test.js` / `smoke-test.js` naming).
- `SUMMARY_AND_TAIL_SPEC.md`: any `taskferry_wait` mentions updated.

No behavior change: same 45s cap, same timeout/tail semantics.

## 2. `taskferry_advisor`

### Input schema

```
prompt: string (required)       — self-contained question/context for the advisor.
                                   The caller is responsible for summarizing whatever
                                   context the advisor needs; taskferry has no access
                                   to the caller's own conversation.
directory: string (required)    — absolute path, same contract as taskferry_dispatch's
                                   `directory` (must exist, must be absolute).
model: string (required)        — provider/model string for the advisor, e.g.
                                   "openai/gpt-5.6-sol" or "zai/glm-5.2". No default —
                                   unlike taskferry_dispatch, there is no sensible
                                   default advisor model.
variant: string (optional)      — reasoning effort for the advisor model (high, max,
                                   minimal, ...). Same semantics as taskferry_dispatch.
session_id: string (optional)   — continue a prior advisor exchange. Subject to the
                                   TTL/recency rules in section 3.
timeout_ms: number (optional)   — how long to block before falling back to a
                                   "still running" response. Capped at 45000, same
                                   ceiling as taskferry_poll (Claude Code's own MCP
                                   tool-call timeout headroom).
```

### Behavior

Implemented as a thin composition of existing `tasks.js` machinery — no new
subprocess-spawning or log-parsing code:

1. Resolve `session_id` per the TTL rules in section 3 (may become `undefined` if
   stale/unknown — see below).
2. `tasks.dispatch({ prompt, directory, model, variant, sessionId })` — reuses the
   existing launch queue and its "at most two launches per rolling 5s window" throttle,
   so an advisor call competes fairly with regular `taskferry_dispatch` calls for launch
   slots.
3. `tasks.poll(id, { timeoutMs })` (formerly `wait`) — blocks up to the capped timeout.
4. On settle:
   - **`done`**: call `tasks.result(id, { fields: ["message", "sessionId", "tokens",
     "cost"] })` and return it inline, plus the session-reset fields from section 3.
     This returned `message` is the "answer" — the calling model reads it and continues
     its own turn.
   - **`crashed` / `cancelled`**: return that status plus `spawnError`/`exitCode`, same
     shape `taskferry_result` already produces for those states.
   - **still `running`/`queued`** (timeout hit before settling): return
     `{ status: "running", task_id, session_id, note: "still running — call
     taskferry_poll or taskferry_advisor again with session_id to continue" }`.
     `session_id` is available even mid-run because `tasks.js` stamps `task.sessionId`
     as soon as the first log event carrying one arrives (existing behavior, `tasks.js`
     around the narration-parsing loop) — the caller isn't stuck waiting for full
     completion just to learn the session id.

### Example response (done)

```json
{
  "status": "done",
  "session_id": "ses_abc123",
  "session_reset": false,
  "message": "The race is safe under a single global lock, but sharding the counter avoids the contention entirely...",
  "tokens": { "input": 812, "output": 340 },
  "cost": { "total": 0.0041 }
}
```

## 3. Advisor session TTL

### Motivation

An advisor `session_id` resumes a prior opencode conversation (`--continue --session`).
Resuming a session whose prompt cache has gone cold, or that's simply old enough that
its context is no longer relevant, wastes tokens re-priming context that should have
been a fresh start. The system should never silently keep piling onto a stale
conversation — it should notice and start clean, telling the caller it did so.

### Registry

An in-memory `Map<sessionId, lastUsedAt>` inside the task manager (`tasks.js`),
alongside the existing `tasks` Map. Process-lifetime only — not persisted to
`TASKS_FILE` or disk. A taskferry restart means every previously-known session_id is
now "unknown," which resolves identically to "expired" (see below) — no special-casing
needed.

### Config

`TASKFERRY_ADVISOR_SESSION_TTL_MS`, default `1800000` (30 minutes). Read the same way
`TASKFERRY_SUMMARY_MODEL` is read today (env var, sane default, no per-call override).

### Resolution logic

When `taskferry_advisor` is called with a `session_id`:

1. Look up `session_id` in the registry.
2. **Fresh** (`now - lastUsedAt <= TTL`): pass `session_id` through to
   `tasks.dispatch()` unchanged — resumes the opencode session via `--continue
   --session`.
3. **Expired, or absent from the registry entirely** (never tracked — typo, or a
   session_id from before a taskferry restart): treated identically. Drop `session_id`
   from the dispatch call — `tasks.dispatch()` starts a brand-new opencode session
   using the same `prompt`, with no `--continue`. No hard error in either case.
4. After the underlying task settles and a `session_id` comes back from
   `tasks.result()`, stamp `lastUsedAt = Date.now()` in the registry for whichever
   session_id was actually used (new or continued). This is what keeps an
   actively-used advisor thread alive — a session touched every 20 minutes for an
   hour never expires; one left idle for 31+ minutes does.

### Response fields

`taskferry_advisor`'s response gains:

```
session_reset: boolean            — true if the requested session_id was stale or
                                     unknown and a new session was started instead.
previous_session_id: string       — only present when session_reset is true; the
                                     session_id that was requested but not reused.
```

This is the "session no longer exists → here's your new one" signal: the caller checks
`session_reset`, and if true, discards the old session_id and starts tracking the new
one for future calls.

### Example response (session reset)

```json
{
  "status": "done",
  "session_id": "ses_def456",
  "session_reset": true,
  "previous_session_id": "ses_abc123",
  "message": "...",
  "tokens": { "input": 205, "output": 180 },
  "cost": { "total": 0.0012 }
}
```

## Testing

- `tasks.test.js` additions:
  - `taskferry_poll` rename: existing wait-behavior tests carried over under the new
    name, no behavior change to assert beyond the name.
  - `taskferry_advisor` composition: dispatch+poll+result glued correctly; timeout
    before settle returns `status: "running"` with a populated `session_id`; crashed/
    cancelled states surface `spawnError`/`exitCode` correctly.
  - Session TTL: fresh session_id passes through untouched (`session_reset: false`);
    expired session_id triggers a reset (`session_reset: true`,
    `previous_session_id` set, no `--continue` in the launch args); unknown session_id
    behaves identically to expired; `lastUsedAt` is refreshed on every successful use
    (a session touched every 20 minutes across an hour never expires; one idle 31+
    minutes does).
- No new integration/smoke test needed beyond the composition tests above — the
  underlying spawn/parse path is already covered by `smoke-test.js` /
  `wait-smoke-test.js` (renamed `poll-smoke-test.js`).

## Non-goals

- No model-strength pairing/enforcement table (vanilla advisor's "advisor ≥ executor"
  rule). The caller picks the advisor model; taskferry trusts it, same as
  `taskferry_dispatch`'s `model` param today.
- No persistence of the session TTL registry across taskferry restarts.
- No changes to `taskferry_dispatch`'s own session handling — TTL/reset logic is
  scoped to `taskferry_advisor` only.
