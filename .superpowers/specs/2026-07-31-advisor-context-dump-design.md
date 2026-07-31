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
   budget })` over the same daemon connection `advisor` already uses.
3. **Else** → no context source available. If `--prompt` was also not
   given, fail fast (UsageError). If `--prompt` *was* given, proceed with
   no attached context — the canned prompt plus the caller's own prompt
   still go out.

### 4. Budget and summarization

- Default budget: **120,000 chars** (~30k tokens), read as a trailing tail
  (most recent content, since that's what's relevant to "what is this agent
  doing right now"). Overridable via `TASKFERRY_ADVISOR_CONTEXT_CHARS` env
  var or a `advisorContextChars` config key, following the same
  env-then-config-then-default resolution pattern already used elsewhere in
  this file (e.g. `resolveWaitDefaultTimeoutMs`).
- New opt-in flag **`--summarize-context`** (default off): when set, the
  gathered context is passed through taskferry's existing summarizer
  (`task.summary`, report mode) before being attached, instead of being
  attached raw. This trades some latency/cost for a denser, pre-condensed
  context blob — useful when a ferry's log is large and mostly noise.
  Default stays off so the common path has no extra round-trip.

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
      read/fetch bounded context (optionally through task.summary first)
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
- `commands.test.js` (or wherever `runCommand` is tested): one test per
  context-resolution branch (Claude-session tail read, ferry `task.tail`
  fetch, no-source-plus-no-prompt failure, no-source-plus-prompt success),
  plus a test that `--summarize-context` routes through `task.summary`
  first.
- `tasks.test.js`: extend the existing `TASKFERRY_CHILD` spawn-env
  assertions to also check `TASKFERRY_TASK_ID` is present and equals the
  task's own id, for both `dispatch` and `advisor` roles, and absent for
  summary spawns.

## Out of scope

- Any enforcement of "stronger model" — purely a documentation/positioning
  change (requirement a).
- Changing `advisor`'s existing blocking/timeout/sandbox/overlay behavior
  (requirement c) — already implemented, untouched by this design.
- A model-tier config or allowlist.
