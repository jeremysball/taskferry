---
name: using-taskferry
description: Dispatch and validate background OpenCode work through taskferry's AXI CLI inside subagent-driven-development.
---

# Taskferry Worker Backend

Use Taskferry as the worker backend inside `subagent-driven-development`. The
`subagent-driven-development` lifecycle owns task briefs, worktrees, implementer
and reviewer passes, fixes, and final verification. Taskferry owns external worker
execution. Taskferry is not an alternative lifecycle.

Every implementer, fixer, task reviewer, and final reviewer that lifecycle
dispatches runs through Taskferry, at zero session-token cost per task. That is
the only plan-execution handoff — there is no separate "delegate to opencode"
option alongside it, because `subagent-driven-development` already *is*
taskferry-backed dispatch. When `writing-plans` offers execution-approach
choices, the real choice is `subagent-driven-development` vs. inline execution
(`executing-plans`, or working the plan yourself), not a third opencode-specific
lane.

Taskferry is a backend for external (non-host-model) workers. Read-only research,
code location, and one-off lookups belong in the host runtime's own subagent
mechanism, not here — forcing a quick lookup through a full dispatch/wait/review
cycle costs turns and wall time for nothing.

## Sizing The Task Before Dispatching

Before routing a backlog item, bug, or fix through Taskferry — worktree creation,
a written brief, dispatch, wait, review — ask: would you finish this yourself in
one or two edit/read/search calls if you just looked? If yes, do that instead.

Reserve dispatch for work that is genuinely large or ambiguous: real design
decisions, multi-file changes, broad multi-location research, anything where
doing it directly would still take meaningful back-and-forth. Dispatching a
small, mechanical, single-file fix through a full worker cycle bloats context
and burns wall-clock time versus just doing it.

## Worker Contract

- Select the worker model, variant, and optional key slot explicitly when the task
  needs them: `taskferry dispatch --prompt - --directory "<worktree>" --model
  <provider/model> --variant <name> --key-slot <name> <<'PROMPT_EOF'` ... `PROMPT_EOF`.
- State the exact `provider/model` slug (and variant/key-slot, if set) being
  dispatched in your response to the user, not just in the shell command — the
  user shouldn't have to read the command to know what's running.
- Both `dispatch` and `advisor` also accept `--executor <opencode|pi>` to pick
  which worker CLI is spawned. Omit it to use the configured default (built-in:
  `pi`, but a workspace can set `TASKFERRY_DEFAULT_EXECUTOR` or
  `config.json`'s `defaultExecutor` to `opencode` instead — check before
  assuming an omitted flag means pi). Pass `--executor pi`/`--executor
  opencode` explicitly whenever the task needs a specific CLI regardless of
  that default.
- Start fresh sessions for each separate implementation task and each reviewer.
- Resume only the implementer session for a fix to that same task.
- Keep the task brief and directory explicit so the worker operates in the intended
  worktree.
- Feed every prompt to `--prompt -` over stdin via a heredoc: `taskferry dispatch
  --prompt - ... <<'PROMPT_EOF'` followed by the prompt text and a `PROMPT_EOF`
  terminator on its own line. Always quote the delimiter (`<<'PROMPT_EOF'`, not
  `<<PROMPT_EOF`) so the shell doesn't expand `$vars` or backticks inside the
  prompt. No intermediate prompt file, no file-writing tool call — the heredoc
  is the only prompt-delivery mechanism. Never inline the prompt as a `--prompt
  "<text>"` argument and never pass it via command substitution
  (`--prompt "$(cat some_file)"`) — both risk shell-quoting breakage on prompts
  containing quotes, `$`, or backticks, and substitution is capped by the
  platform's argv-length limit on large prompts.
- End every dispatch prompt with an explicit instruction to close on a line
  starting `Status:` — one of `DONE | DONE_WITH_CONCERNS | BLOCKED |
  NEEDS_CONTEXT` for implementers, or `Approved | Needs fixes` after a `Task
  quality:` line for reviewers. This is a standing contract, not a per-task
  flourish; `--require-final-marker` enforces it.
- Wait for settlement, retrieve the result, handle crashes, and validate the
  worker's deliverables yourself.

## Verifying A Worker's Claimed Commit

A worker's final `Status:` line and narration are not evidence a commit
happened — only `git log`/`git status` against the actual worktree is. After
every settled implementer/fixer dispatch, before treating the task as done:

```sh
git -C "<worktree>" log --oneline origin/main..HEAD
git -C "<worktree>" status --short
```

If commits exist and their stated summary is plausible, you're done. If the
worktree shows uncommitted changes (or nothing at all) despite a `Status:
DONE` claim describing a commit, don't re-dispatch reflexively — first check
whether the diff on disk actually matches what the worker described. If it
does, the implementation itself is real and only the git step failed (a
sandboxed worker's `git commit` can fail silently for reasons invisible to
its own narration, e.g. a broken or read-only git-dir mount in its
environment); verify tests and lint yourself, then commit it directly rather
than throwing away completed work. Only re-dispatch when the diff itself is
missing, wrong, or incomplete.

This generalizes past just commits: any deliverable a worker claims to have
produced (a written file, a pushed branch, a passed test run) is a claim to
verify independently, not to accept on narration alone — a confident,
detailed self-report is exactly as unverified as a terse one.

## Choosing a Model

See `choosing-a-model` for the full tier breakdown (cheapest/standard/
most-capable), the role-to-tier mapping, and effort-level nuances. The
summary that matters here: use the least powerful model that can handle
each role, not reflexively the strongest one available — but the review
role never inherits the implementer's tier just because the diff being
reviewed was mechanical. Escalate tier when the task is architecturally
risky, security-sensitive, or has already failed on a lighter model.

- **Always specify the model explicitly when dispatching through
  `taskferry`.** An omitted `--model` falls back to taskferry's own default,
  which may not match the tier the task actually needs.
- **Task reviewers need a standard-tier floor, always** — reviewing a diff
  requires judgment even when the diff itself was cheap-tier transcription
  work. Dispatching the cheapest available model as a task reviewer because
  the implementer task was cheap is a documented anti-pattern (see
  `choosing-a-model`), not an acceptable cost optimization.
- **Turn count beats token price.** The cheapest models routinely take
  2-3× the turns on multi-step work, costing more overall in wall-clock and
  context than a standard-tier model that finishes clean. Reserve the cheapest
  tier for implementers whose brief already contains the exact code to
  write (transcription plus testing) and single-file mechanical fixes.
- **Provider-specific availability rules (time windows, key-slot limits,
  single-in-flight constraints) are account state and live outside this
  skill** — in your CLAUDE.md, or a personal skill covering provider
  availability. Check it before dispatching to a gated provider, and pick an
  equivalent model on another provider rather than waiting idle or
  dispatching outside the allowed window.
- **Reliability is part of "good enough."** A model that crashes or times
  out on a large fraction of its dispatches costs more in wall-clock retries
  than a slightly pricier model that finishes clean the first time. Two or
  more `no_output_timeout` crashes running on the same model+task shape is a
  signal to switch model or provider, not to keep retrying unchanged — see
  `no_output_timeout` Crashes below.
- When unsure which model fits, check recent `taskferry list`/`context`
  history for how that model has actually performed on similar work in this
  workspace, rather than defaulting to habit or reaching for the biggest name.

## AXI CLI

Dispatch work with an explicit workspace, feeding the prompt straight over
stdin with a quoted heredoc — no intermediate prompt file, no file-writing
tool call. `--prompt -` reads until EOF:

```sh
taskferry dispatch --prompt - --directory "<worktree>" <<'PROMPT_EOF'
<full prompt text>
PROMPT_EOF
```

Inspect and wait for a task:

```sh
taskferry status <id>
taskferry wait <id>
taskferry tail <id> --chars 2000
```

Do not pass `--timeout` to `taskferry wait`. The process exits on its own the
moment the task settles; a timeout only makes the caller re-issue `wait` in a
polling loop for no benefit.

**`taskferry wait` is the only settlement signal — never a bare search for
`Status:` in the output.** Grepping for the marker alone, before the task has
settled, false-positives whenever the worker's own output quotes earlier text
containing a `Status:`-prefixed line (a task that reads old transcripts or other
dispatch logs matches the first hit anywhere in the stream, not the model's real
final report). Wait for settlement first, then read `Status:` / `Task quality:`
out of `taskferry result` or `taskferry tail`. Don't poll for a report file or a
commit to appear, and don't `tail` mid-run just to check progress absent a real
need to inspect activity.

`wait` also takes a `--tail-chars <number>` option, but it only fires on a
timeout (trailing text characters from that point) — including the default
15-minute wait timeout, not just an explicit `--timeout`. Since neither
timeout is something to wait out deliberately (previous paragraph), treat
`--tail-chars` as dead weight too and don't reach for it. For the settled
result, use `taskferry result <id> --fields ...` (see below) instead — it
returns real structured fields, not a raw character tail.

For a long-running task, prefer `taskferry wait <id> --summarize` over a bare
`wait`: it streams periodic one-line summaries of the task's narration tail
while blocking, then returns the same settlement status a plain `wait` would.
This gives visibility into what the worker is doing without polling `tail` by
hand. To watch one specific task's live event stream instead of the whole
workspace's, use `taskferry watch --task-id <id>` rather than an unscoped
`taskferry watch`; add `--summaries` to get condensed activity summaries in
that stream instead of raw events.

**Inside Claude Code, always run `wait --summarize` via `Bash`
`run_in_background: true`, then immediately arm a `Monitor` tailing that
background job's own output file** (the file path the `Bash` tool reports back
at launch, e.g. `/tmp/.../tasks/<bash-id>.output`) with `tail -n0 -F <path>`,
`persistent: true`. `run_in_background` only notifies once, on the whole
command's exit — it does not surface each summary line as it's written, so
without a `Monitor` the summaries sit in that file unseen until settlement.
`tail -n0 -F` starts from the end so you don't re-emit lines already read, and
turns every new summary line into its own notification as it lands (every
~6 minutes by default — `DEFAULT_SUMMARIZER_TIMEOUT_MS` in `src/activity.js`,
overridable via `TASKFERRY_SUMMARIZER_TIMEOUT_MS`). Stop the monitor with `TaskStop` once the wait job's own completion
notification confirms the task settled.

Relay every summary-line notification with this exact template:

`⛴ <emoji> <short-task-id> <NN%> — <clause>`

- `<short-task-id>` — the taskferry task id, shortened to its first segment
  (e.g. `oc_mrpxgbg8`). This always exists, unlike other context, which may
  not apply to the dispatch at all. Add a human label in parens right after
  it only when one is genuinely in context, and always name what kind of
  thing it is — `issue #35`, `PR #12`, never a bare `#35` that leaves the
  reader guessing issue vs. PR vs. something else.
- `<emoji>` — pick one that actually fits what this specific update is
  about, not a rotating decoration and not the same emoji every time. Read
  the narration tail and choose freely: 🔨 mid-implementation, 🧪 running or
  fixing tests, 📝 writing docs, 🔍 investigating/debugging, ✅ settled
  clean, ⚠️ a concern worth a second look, 🚨 crashed or blocked. Treat this
  list as a starting palette, not an enum — reach for whatever emoji best
  matches the actual moment (including something outside this list) rather
  than forcing the nearest listed option.
- `<NN%>` — required on every update, never omitted. Estimate from where the
  task brief's steps actually stand (e.g. "tests written, docs still
  pending" reads differently than "just started"), not from elapsed time
  alone.
- `<clause>` — one compact clause of the actual substance: files/functions
  touched, what step completed, what's left. Not a restatement of everything
  said in prior updates.

Never append a "no push needed" / "no action needed" verdict line — silence
on that front is the default, so saying so out loud on every single update is
pure noise. Only speak up beyond the one-line update when something genuinely
warrants the user's attention (a blocker, a crash, settlement).

Example: `⛴ 📝 oc_mrpxgbg8 (issue #35) 90% — docs updated, finishing the
result section, tests and lint already green.`

**Inside OpenCode itself (opencode as the host running taskferry, not Claude
Code), none of the above Monitor pattern applies, and there is no way to
manufacture a live-update experience.** OpenCode's own Bash tool is
synchronous and foreground-only — no `run_in_background`, no event-push
mechanism equivalent to `Monitor`, and no async wake primitive at all. OpenCode
only gets to say anything during a turn it is already taking; nothing can
interrupt it mid-task to post a progress line, so genuinely proactive "live"
updates are not achievable here. Don't imply otherwise. The honest options,
in order of preference:

1. **No interim updates.** Report once, at settlement. This is the default
   for most dispatches.
2. **Pull, not push.** If the user asks how it's going while the task runs,
   check the backgrounded log's tail at that moment and answer. This only
   works because the user's message is itself the trigger — it is not a
   standing update loop.
3. **Piggyback, don't dedicate.** If opencode is already taking a turn for
   an unrelated reason while the dispatch runs, a cheap glance at the log
   tail as a side action is fine. Do not spend a turn *solely* to poll for
   an update nobody asked for — that reintroduces the wasted-wall-time
   pattern this whole guidance exists to avoid.

Background the wait rather than blocking the turn on it directly —
opencode's own Bash tool has nothing like `run_in_background`, so a
foreground `wait` ties up the whole turn until settlement, with no way to
do anything else (including answering the user) in the meantime. Use
`--summarize` here too, same as the Claude Code case above: it periodically
condenses the narration tail into the log instead of leaving raw NDJSON
sitting there, which is what actually makes options 2–3's occasional peek
worth reading rather than a wall of unprocessed events:

```sh
nohup taskferry wait <id> --summarize > /tmp/taskferry-wait-<id>.log 2>&1 &
disown
```

That call returns immediately. Settlement shows up as the job's exit and a
final line in the log; check `cat /tmp/taskferry-wait-<id>.log` (or `jobs`)
when you're about to report on the task rather than polling it on a timer.
For options 2–3 above, where you need a look at progress before it settles,
reading that same log's tail (`tail -n 5 /tmp/taskferry-wait-<id>.log`) is
the right move — it's the summarized view, cheaper to read than a raw
`taskferry tail`.

Read the final result and request an independent review when needed:

```sh
taskferry result <id>
taskferry advisor --prompt - --model <provider/model> --directory "<worktree>" <<'PROMPT_EOF'
<full prompt text>
PROMPT_EOF
```

Pull only the fields you actually need from a result instead of the full payload
with `taskferry result <id> --fields message,tokens,cost` (or any subset of
`message,narration,tokens,cost,sessionId,exitCode,signal,spawnError,failureReason,failureDetail,keySlot,logPath,incomplete,finalMarker`)
— cheaper than `--full` when you don't need untruncated narration. To continue
an advisor conversation instead of starting a fresh one (e.g. a follow-up
question after its first answer), pass the same `--session-id` the first
`advisor` call returned.

If the raw narration is long enough that reading it directly would blow the
context budget, condense it first instead of pulling it whole:

```sh
taskferry summary <id> --mode report # a bounded final report, after settlement
```

Don't call `summary <id> --mode activity` directly for interim visibility
while a task is still running -- that mode exists for the statusline/human
`watch` path, not for a model checking in on its own dispatch. Use
`taskferry wait <id> --summarize` instead (see above): it already streams
the same condensed activity summaries while blocking, without a second
parallel command doing the same job.

## Fleet-Wide Monitoring

On a session's first `taskferry dispatch`, also background `taskferry watch
--summaries --flush-interval 5m` (no `--directory` needed — it resolves the
git workspace root automatically) and register the process with the harness
`Monitor` tool, the same way `Monitor` is armed for a single `wait
--summarize` job elsewhere in this skill. This surfaces periodic, batched
updates for every ferry dispatched with the workspace root as its directory —
the default when dispatching from the repo root, or from a subdirectory with an
explicit `--directory <root>` — including ones dispatched by other concurrent
sessions. A ferry dispatched from a subdirectory without an explicit
`--directory` stays tagged with that subdirectory (dispatch's own directory
default is unchanged) and won't appear in a root-scoped watch.

This is pure convention for agent sessions to follow — the `Monitor` tool is
harness-native and can't be invoked from within taskferry's own code, so
nothing in taskferry itself enforces it.

```sh
taskferry watch --summaries --flush-interval 5m > /tmp/taskferry-fleet-watch.log 2>&1 &
disown
```

Then arm a `Monitor` tailing that log file (`tail -n0 -F
/tmp/taskferry-fleet-watch.log`, `persistent: true`), the same pattern used
for a single `wait --summarize` job above — one notification per flush tick
instead of one per raw event.

Arm this once per session, on the first dispatch, not once per dispatch —
re-arming on every subsequent dispatch would spawn a redundant background
`watch` process each time.

## Advisor Review

Dispatch an independent advisor review when finished work is judgment-heavy or
correctness-critical in a way passing tests wouldn't catch: statistical or
mathematical reasoning, security-sensitive logic, or any change where "it runs
and the tests pass" is a weaker guarantee than "the reasoning is right." Reach
for it before merging or reporting that class of work done — not only when the
user names a model.

- `taskferry advisor --prompt - --model <provider/model> --directory
  "<worktree>" <<'PROMPT_EOF'` ... `PROMPT_EOF` dispatches and waits in one call.
- Use the model and effort the user specifies. Absent one, default to the
  strongest model available to you.
- **Advisor is a review-only role: it reports findings and does not edit files.**
  State that in the prompt. Never blend it with the implementer role in one
  dispatch.
- Give it what a human reviewer would need — the files, the invariant being
  relied on, and what "wrong" would look like.
- If the advisor you want is the host runtime's own model, use the host's native
  subagent mechanism instead of `taskferry advisor`; Taskferry exists to reach
  models the host can't run itself.
- Continue an advisor conversation by passing back the `--session-id` its first
  call returned, rather than opening a fresh one.

**After the report lands, verify every checkable finding empirically** — rerun
the corrected code, recompute the number — before folding it into the diff. An
advisor's confident wrong claim costs more than no review at all.

## Sending Audio Or Image Parts To A Model

OpenCode passes file paths through as text strings, so a worker never actually
hears or sees the file — it only receives its path. When a model must genuinely
perceive the bytes (audio review, image review), bypass the worker and POST
directly to the provider's chat-completions endpoint with a real content part:

```jsonc
{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "mp3"}}
// or {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}}
```

Keep the one-shot script in a temp directory; this is a side channel around
Taskferry, not a Taskferry feature.

## `no_output_timeout` Crashes

A worker can crash with `status: crashed, failureReason: no_output_timeout` while
genuinely still working, not actually stuck: high-reasoning-effort models can go
silent for minutes mid-turn (long internal reasoning, or a slow tool call such as
a full test suite), and some models (e.g. `glm-5.2`) stream long stretches of
empty `</think>` thinking-tail events that don't reset the watchdog. Taskferry's
own watchdog kills the process regardless of whether real work is happening
underneath.

Treat every `no_output_timeout` crash as a possible false-positive kill, not proof
the task failed:

- Check `taskferry status <id> --full` for `sessionId`. If it is non-null, real
  work happened before the kill — resume that exact session rather than
  re-dispatching fresh and re-paying for research already done:
  `taskferry dispatch --prompt - --model <same model> --directory "<worktree>"
  --session-id <sessionId> <<'PROMPT_EOF'` followed by `Continue exactly where
  you left off and finish the task.` and a `PROMPT_EOF` terminator.
- If `sessionId` is null, nothing was salvageable (the process never got far
  enough to start a session) — dispatching fresh is the only option.
- Inspect the worktree (`git status`, `git diff --stat`, look for the expected
  new/changed files) before deciding whether to resume or restart. A crash can
  land mid-write; verify what actually landed on disk rather than assuming
  either "nothing happened" or "it finished."
- Two or more consecutive `no_output_timeout` crashes on the same
  prompt+model+variant combination, especially with `sessionId: null` every
  time, is a signal to change something rather than retry unchanged: drop to a
  less exhaustive `--variant`, switch model/provider, or shorten the prompt so
  the worker produces its first tool call sooner.

Use `taskferry cancel <id>` for work that should stop; it sends SIGTERM and
escalates to SIGKILL after a grace period (default 5000ms, override with
`--grace-ms <number>` for a worker that needs longer to unwind, e.g. mid
long-running command). Use `taskferry list` or `taskferry context --format toon`
to inspect workspace-scoped state, and `taskferry doctor --full` if something
about the daemon itself seems wrong (dead socket, stale process, health check
failing) before assuming a task-level problem. The CLI emits structured data,
errors, and help as TOON on stdout, keeps diagnostics on stderr, and uses exit
codes to distinguish success, operational failure, and usage errors.

**The daemon picks up code changes automatically (deferred-until-idle
restart), but not new environment variables.** A newly-added API key
exported into your interactive shell after the daemon started is invisible
to it — the daemon inherited its environment once at spawn time, and an
env var isn't part of the source-signature check that triggers an
auto-restart. If a dispatch crashes with an auth/`UnknownError` failure on
a route that worked minutes ago via a direct `opencode run` PONG test,
suspect a stale daemon environment before suspecting a provider outage: a
PONG test runs in your interactive shell and bypasses the daemon entirely,
so it succeeding is *not* evidence that a `taskferry dispatch` on the same
model will work. Confirm with `tr '\0' '\n' < /proc/<daemon-pid>/environ |
rg <KEY_NAME>`; if the key is missing, kill the daemon so the next
`taskferry` command respawns it from a shell that has the key. On a
machine with concurrent taskferry sessions sharing one daemon socket, the
respawn race can take several kill-and-check iterations before a respawn
actually wins the race and inherits the right env — loop until
`/proc/<new-pid>/environ` shows the expected var.

## When a worker's tool calls don't honor `--directory`

Even with `--directory <worktree>` set correctly on the dispatch, a
worker's individual tool calls can pass their own `workdir` that overrides
it — confirmed once with `opencode/deepseek-v4-flash-free`: it made the
correct code changes but every `bash`/`edit`/`write` tool call explicitly
passed `workdir: <main-checkout-root>` instead of the assigned worktree
(visible in the raw taskferry ndjson log via `jq 'select(.type=="tool_use")'`),
so the commit landed on local `main` in the main checkout, not the
worktree branch — and the worker's own report claimed a commit hash that
didn't exist in the worktree at all. `taskferry status --full` had flagged
`incomplete: true` on that task, which in hindsight was the earlier
warning sign worth checking alongside the final message text.

**Recovery, once you confirm this happened** (per "Verifying A Worker's
Claimed Commit" above — the commit is missing from the assigned worktree):
check other likely locations (the main checkout is the common one) before
assuming the work vanished. If found there, `git cherry-pick` the commit
onto the correct worktree branch, then `git revert` it in the wrong
location to remove it — never a hard reset there, since that could disturb
unrelated pre-existing dirty state in that checkout.

## Codex Installation And Hooks

Registering the taskferry checkout as a Codex marketplace (see
`docs/integrations/codex.md` for the bootstrap command) does not install the
plugin itself — Codex desktop drives that step through its own UI. Open
Codex desktop, install Taskferry from its marketplace, then review and trust
its hooks through `/hooks` before they run.

The plugin injects current workspace context at `SessionStart` and refreshes it at
`UserPromptSubmit`. It does not provide a persistent live monitor surface. If
hooks are disabled in your Codex configuration, enable them only when you want this
lifecycle context by setting:

```toml
[features]
hooks = true
```
