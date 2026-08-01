# `advisor` auto-context-dump design

## Purpose

Reframe `taskferry advisor` as the mechanism a weaker ferry (a background
dispatch worker) uses to consult a stronger model, and make consulting it
require zero prompt-writing effort in the common case: the ferry's own
recent context (its Claude session transcript, or its own taskferry task
log) is gathered and attached automatically, wrapped in a canned, directive
instruction prompt, before the request is sent. The call still blocks the
caller until the advisor model answers — that part of `advisor` is
unchanged.

## Current state

`taskferry advisor` (`src/args.js`, `src/commands.js`, `src/tasks.js`)
already:

- Requires `--prompt` and `--model` (`src/args.js:450-451`).
- Blocks: `commands.js`'s `case "advisor"` makes a synchronous
  `client.request("task.advisor", ...)` call, and `tasks.js`'s `advisor()`
  dispatches internally with `role: "advisor"` and polls until settlement or
  timeout (`src/tasks.js:2883`).
- Runs the advisor child sandboxed with overlay-gated writes mandatory
  (ADR 0001), `--unshare-net`, and a read-only runtime dir so the daemon
  socket is unreachable from inside an advisor's own sandbox
  (`src/tasks.js:1904-2052`).

What's missing: any notion of "what is this ferry currently doing," and any
positioning of `advisor` as the weaker-model-consults-stronger-model
pattern beyond its literal mechanics.

## Design

### 1. Docs/positioning (requirement a)

Update `args.js`'s `advisor` help entry (`usage`, `description`,
`examples`) to frame the command as asking a stronger model for a second
opinion mid-task. No enforcement: `--model` stays required and unrestricted
— nothing validates that the chosen model is actually "stronger."

### 2. `TASKFERRY_TASK_ID` plumbing var (new)

`tasks.js`'s `dispatchEnvironment()` (`src/tasks.js:818`) currently sets
only `TASKFERRY_CHILD = "1"` on every spawned dispatch/advisor child's env.
Add `TASKFERRY_TASK_ID = task.id` alongside it, set the same way (after the
caller-env union, so it always wins regardless of what the caller passed).
This does not need to join `TASKFERRY_PLUMBING_ENV_VARS` in `paths.js` —
like `TASKFERRY_CHILD`, it's stamped unconditionally at spawn time, not
excluded from the caller-env merge.

This lets a ferry (a running dispatch/advisor task) that shells out to
`taskferry advisor` identify its own task id, so `advisor` can fetch that
task's own log as context.

Summary/report spawns (`isSummary` branch, `summaryEnvironment()`) do not
get this var — they aren't ferries capable of invoking `advisor` themselves.

### 3. Context source resolution (requirement b)

Lives in `commands.js`'s `case "advisor"`, client-side, before the RPC:

1. **`env.CLAUDE_CODE_SESSION_ID` is set** → this is a Claude Code session
   calling `advisor` directly (not a taskferry-spawned ferry). Read a
   bounded tail from
   `~/.claude/projects/<slugified-cwd>/<CLAUDE_CODE_SESSION_ID>.jsonl`,
   where the slug is the absolute `cwd` with `/` replaced by `-` (the
   convention already used by this account's memory paths, e.g.
   `/workspace/taskferry` → `-workspace-taskferry`). If the file doesn't
   exist or can't be read, fail fast (see Error handling) rather than
   falling through to the next source — the signal was explicit, so a
   missing file is a real error, not "try something else."
2. **Else, `env.TASKFERRY_TASK_ID` is set** → this is a ferry (a taskferry
   dispatch/advisor child) calling `advisor` on itself. Call
   `client.request("task.tail", { taskId: env.TASKFERRY_TASK_ID, chars:
   min(budget, 131072) })` over the same daemon connection `advisor`
   already uses (see "`task.tail` cap raised" below for the 131072 figure).
3. **Else** → no context source available. If `--prompt` was also not
   given, fail fast (UsageError). If `--prompt` *was* given, proceed with
   no attached context — the canned prompt plus the caller's own prompt
   still go out.

### 3a. `task.tail` cap raised to 131072

`task.tail`'s `chars` parameter is currently hard-capped at 65536,
enforced in three places: `args.js`'s `parseNumber(..., { min: 1, max:
65536 })` for both `tail --chars` and `wait --tail-chars`, `protocol.js`'s
RPC-level validator (`value <= 65536`), and `tasks.js`'s `tail()` itself
(`chars > 65536` throws). That's below the 120,000-char advisor context
budget, so the ferry-log source could never deliver the configured budget
without a change here.

Raise the ceiling to **131072** (128k) in all three places — a round
number comfortably above the 120k default budget, with headroom for a
larger `TASKFERRY_ADVISOR_CONTEXT_CHARS` override. This is a general
`task.tail`/`wait --tail-chars` capability change, not an advisor-only
carve-out: `TAIL_READ_BYTES` (1 MiB, `tasks.js:168`) already reads enough
of the log to support it, so no other part of `tail()`'s implementation
needs to change.

### 4. Budget and summarization

- Default budget: **120,000 chars** (~30k tokens), read as a trailing tail
  (most recent content, since that's what's relevant to "what is this agent
  doing right now"). Overridable via `TASKFERRY_ADVISOR_CONTEXT_CHARS` env
  var or a `advisorContextChars` config key, following the same
  env-then-config-then-default resolution pattern already used elsewhere in
  this file (e.g. `resolveWaitDefaultTimeoutMs`).
- New opt-in flag **`--summarize-context`** (default off): when set, the
  gathered context is condensed before being attached, instead of being
  attached raw. This trades some latency/cost for a denser, pre-condensed
  context blob — useful when a ferry's log or a session transcript is large
  and mostly noise. Default stays off so the common path has no extra
  round-trip.

  `task.summary` doesn't fit here as-is: it summarizes an *existing
  taskferry task's own log* by `taskId`, but the Claude-session source is a
  transcript file with no taskId to hand it. Rather than build a
  parallel summarization pipeline, condensation is implemented as a
  same-process helper in `commands.js` (`summarizeContextText()`) that
  works on the raw text string directly, using RPCs already exposed for
  other commands — no daemon changes, and not a new public command surface:
  1. `client.request("task.dispatch", { prompt: <condense instruction +
     text>, directory, model: <fixed cheap model>, env })` — a throwaway
     dispatch, same `directory` already resolved for the advisor call
     itself.
  2. `client.request("task.wait", { taskId, timeoutMs: 120000 })` — block
     for it to settle.
  3. `client.request("task.result", { taskId, fields: ["message"] })` —
     pull the condensed text out.
  4. Return `result.message` as the summarized context (falling back to
     the raw, unsummarized text with a note if the summarize dispatch
     crashed or times out — condensation is a best-effort convenience,
     never a hard dependency that turns a working advisor call into a
     failure).

  The model is a fixed constant (`opencode/mimo-v2.5-free`, matching
  `tasks.js`'s own `DEFAULT_SUMMARY_MODEL` value, kept as an independent
  local constant since `commands.js` doesn't otherwise import daemon-side
  `tasks.js`), overridable via `TASKFERRY_ADVISOR_SUMMARIZER_MODEL` — not a
  new `--model`-like CLI flag, since the flag only toggles condensation
  on/off, it doesn't pick the condenser.

### 5. Prompt assembly

The final `prompt` sent to `task.advisor` is always:

```
<CANNED_PROMPT>

--- attached context (<source>, <N> chars) ---
<context>
---

<caller's --prompt, if any, appended verbatim>
```

Where `<source>` is `claude-session` or `ferry-log` (or `summarized
ferry-log` / `summarized claude-session` when `--summarize-context` was
used), and the context block is omitted entirely only in the no-source
case described above.

`<CANNED_PROMPT>` (fixed constant, drafted and reviewed against this exact
brief):

> You are an advisor reviewing the in-progress work of a cheaper dispatcher
> agent. The text that follows is a tail of its session log: its current
> task, what it has read, what it has decided, and what it is about to do
> next. Treat it as suspect, not as a draft to refine.
>
> Your reply goes directly back to that autonomous agent mid-task; it will
> not be read by a human first. Do not summarize what the ferry did and do
> not validate its choices for politeness. Push back.
>
> Interrogate its assumptions: list each one the ferry is acting on without
> verifying, and say whether it is load-bearing. Hunt for blind spots: what
> did it not read, not run, not check, and where is a known foot-gun
> pattern it is about to step on (silent error swallow, mock-green-real-
> fail, off-by-one on the boundary it is touching, an unverified config
> default). Propose concrete alternatives: for each decision it is about to
> lock in, name at least one it has not considered, with the file and
> approximate line, not just an abstraction. Rank so the single
> highest-leverage change comes first.
>
> Format: bulleted, terse, no preamble, no closing summary. Short
> sentences. Reference code as `path/to/file.js:NNN`. Prefer "should" and
> "must" over "you might consider." If there is nothing material to add,
> reply `no change, proceed` and stop.

### 6. `--prompt` becomes optional

`args.js:450` currently throws `--prompt is required` for both `dispatch`
and `advisor`. Split this: `dispatch` keeps the hard requirement;
`advisor`'s requirement moves to runtime (in `commands.js`, after context
resolution) since a context-only call with no explicit `--prompt` is now a
valid, in fact the primary, invocation shape.

## Data flow

```
CLI `taskferry advisor [--prompt ...] --model <id> [--summarize-context]`
  → commands.js case "advisor":
      resolve context source (env.CLAUDE_CODE_SESSION_ID / env.TASKFERRY_TASK_ID / none)
      read/fetch bounded context
      if --summarize-context: summarizeContextText() (dispatch+wait+result round trip)
      assemble final prompt (canned + context + caller prompt)
      fail fast if no context AND no --prompt
  → client.request("task.advisor", { prompt: assembled, model, directory, ... })
  → (unchanged) tasks.js advisor() dispatches role:"advisor", polls, returns on settle
```

## Error handling

- No context source and no `--prompt` → `UsageError`, message names which
  sources were checked and why they came up empty (e.g. neither
  `CLAUDE_CODE_SESSION_ID` nor `TASKFERRY_TASK_ID` set).
- `CLAUDE_CODE_SESSION_ID` set but the expected transcript file is missing
  or unreadable → fail fast with the resolved path in the error, don't
  silently fall through to the ferry-log path.
- `TASKFERRY_TASK_ID` set but `task.tail` RPC fails (task not found,
  daemon error) → the RPC rejection propagates as-is; no swallowing.

## Testing

- `args.js`/`args.test.js`: `advisor` no longer throws at parse time for a
  missing `--prompt`; add a test that this is now valid at the parse layer
  (the runtime check moves to `commands.js`).
- `commands.test.js`: one test per context-resolution branch (Claude-session
  tail read, ferry `task.tail` fetch, no-source-plus-no-prompt failure,
  no-source-plus-prompt success), a test that `--summarize-context` drives
  the dispatch+wait+result round trip and substitutes its `message`, and a
  test that a crashed/timed-out summarize dispatch falls back to the raw
  text rather than failing the whole advisor call. Existing advisor tests
  in this file (the `resolveWorkspaceRoot` regression test, the executor-
  forwarding test, the env-forwarding test) must pass an explicit `env`
  with neither `CLAUDE_CODE_SESSION_ID` nor `TASKFERRY_TASK_ID` set, so
  they keep testing what they already test instead of picking up
  whatever's ambient in the real test-runner process's `process.env`
  default.
- `tasks.test.js`: extend the existing `TASKFERRY_CHILD` spawn-env
  assertions to also check `TASKFERRY_TASK_ID` is present and equals the
  task's own id, for both `dispatch` and `advisor` roles, and absent for
  summary spawns.
- `args.test.js`/`protocol.test.js`/`tasks.test.js`: no test currently pins
  the literal 65536 value, so this is new coverage, not an update — add a
  test per layer confirming 131072 is now accepted and 131073 now rejected
  (`args.js` parse-time, `protocol.js` RPC-level, `tasks.js`'s `tail()`
  itself).

## Out of scope

- Any enforcement of "stronger model" — purely a documentation/positioning
  change (requirement a).
- Changing `advisor`'s existing blocking/timeout/sandbox/overlay behavior
  (requirement c) — already implemented, untouched by this design.
- A model-tier config or allowlist.
