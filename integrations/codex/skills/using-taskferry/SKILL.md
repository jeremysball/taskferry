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

See `deciding-to-dispatch` for the full gate and self-check before routing a
backlog item, bug, or fix through Taskferry — worktree creation, a written
brief, dispatch, wait, review are all costs to weigh against a one-or-two-call
Read/Edit/Grep. That skill's gate applies unchanged here; this file assumes
you've already passed it.

## Always Use A Worktree

Every sandboxed ferry writes to a copy-on-write overlay, never the real
directory directly -- a rogue or mistaken dispatch cannot corrupt whatever
directory you point it at, worktree or not. `taskferry result --diff` also
handles HEAD drift safely rather than silently corrupting: if the
directory's real git HEAD has moved since dispatch (someone or something
checked out a different branch there while the task was in flight),
extraction reports a `headDrift` field and tries to recover via `git apply
--3way` against the new HEAD. If recovery succeeds, the diff is applied and
the task settles `pending` for normal `accept`/`reject`; if the 3-way merge
fails, the task is auto-rejected with a `changesetError`; if recovery
couldn't be determined, the task settles `pending` with `changesetError`
for you to look at by hand. The diff is never silently computed against the
wrong tree, but extraction no longer refuses outright — it always records
something (taskferry#261 replaced the old fail-closed "HEAD moved" refusal
with this recover-or-flag behavior).

That handling only fires on a *confirmed* HEAD mismatch, though -- it won't
catch every way a shared directory can bite you (a concurrent file edit that
doesn't touch HEAD -- an uncommitted working-tree change, for instance --
leaves no ref movement for the recovery to detect), and hitting either case
mid-session is still lost wall time you'd rather not spend even when
recovery succeeds. **Always dispatch at a worktree, never the main
checkout.** This used to carve out an exception for a solo session doing
one task at a time on the reasoning that nothing else would touch the
directory -- that reasoning failed in practice (taskferry#261): a real
solo session hit an unexplained branch flip on the main checkout mid-dispatch,
and `taskferry result --diff` silently produced a diff comparing the wrong
trees before this HEAD-drift handling existed. "Nothing else touches this
directory" is an assumption, not a guarantee the sandbox can enforce, and the
cost of being wrong (lost wall time re-diagnosing a `changesetError`, or an
uncommitted concurrent edit the drift check can't even see) is never worth
the one worktree-creation step it saves. Create a worktree even for a single
quick dispatch. Branch isolation (parallel sessions on different branches
without a switch race) is the other standing reason worktrees help beyond
this. (An earlier version of this section additionally warned that any
concurrent edit to a live main checkout, HEAD-moving or not, "mutates the
overlay's lower in place... which can make `accept` conflict later" --
that framing predates the recover-or-flag behavior above and is superseded
by it for the HEAD-moving case, which is exactly what a commit like the one
that prompted this note does: a `git commit` in the shared worktree while a
ferry was in flight moved HEAD, and the recovery mechanism -- not a
corrupted diff -- was the actual outcome. The genuinely open risk is
narrower than that old framing suggested: uncommitted, non-HEAD-moving
edits only.)

**A worker's writes only land somewhere durable inside `--directory`.** The
sandbox mounts `--directory` as the one copy-on-write overlay and binds the
rest of the root read-only, plus a small set of explicitly read-write paths
(the git common dir, `runtimeDir`, any `--allowed-dirs` entries) -- there is
no second, throwaway overlay for anything else. A symlink out to some other
path on the host (e.g. a worktree's scratch directory symlinked to a shared
location in the main checkout) resolves into the read-only root, so a write
through it fails with EROFS rather than silently landing anywhere. A write
that resolves to one of the other read-write paths *does* land durably on
the host, but still doesn't appear in `taskferry result --diff`, because
diff extraction is rooted at `--directory` only (doubly true for a
gitignored path, which a git-diff-based extraction can't see regardless) --
and the worker's own narration will still report success either way. If
multiple worktrees need to share scratch files (an SDD plan's ledger,
briefs, reports), put them inside the dispatched `--directory` (or one of
its allowed dirs) instead of symlinking across the sandbox boundary.

## Enabling The Verification Gate

A repo with a `.taskferry.toml` at its root gets an automatic
settle-time gate — every dispatched worker is told about the check
command in its prompt, then that same command runs inside the worker's
copy-on-write overlay at settle, and `accept` refuses any task whose
gate has not settled in your favor. Scaffold one with `taskferry init`:

```sh
taskferry init
```

`init` runs in literal cwd (no `--directory` flag, no workspace-root
redirect) and detects the project's ecosystem — package.json's
`check`/`lint`/`typecheck`/`test` scripts, or a marker file
(`pyproject.toml`, `go.mod`, `Cargo.toml`, `deno.json[c]`, `bunfig.toml`)
— proposing a `check` command. On a TTY it asks before writing the
detected value in directly; without a TTY it always writes a commented
fill-in template, so the file is never silently encoded with a guess
nobody approved. Run it once per repo (or per worktree if each
worktree wants its own gate), commit the result, and the next dispatch
picks it up automatically — no daemon restart required. The schema is
documented in `docs/config.md#taskferrytoml`; the gate's accept
refusal / `--force` override behavior is in "Verification gate (`accept`
refusal and `--force`)" under "Verifying A Worker's Claimed Changeset"
below. `init` never overwrites an existing `.taskferry.toml`.

## Worker Contract

- Select the worker model and variant explicitly when the task needs them:
  `taskferry dispatch --prompt - --directory "<worktree>" --model
  <provider/model> --variant <name> <<'PROMPT_EOF'` ... `PROMPT_EOF`.
- State the exact `provider/model` slug (and variant, if set) being
  dispatched in your response to the user, not just in the shell command — the
  user shouldn't have to read the command to know what's running. `dispatch`/
  `advisor`/`summary` (report mode) forward your own shell's environment to
  the daemon on every call, with no per-call opt-out — export a fresh
  provider key before dispatching and it's visible immediately, no daemon
  restart needed.
- Both `dispatch` and `advisor` also accept `--executor <opencode|pi>` to pick
  which worker CLI is spawned. Omit it to use the configured default (built-in:
  `pi`, but a workspace can set `TASKFERRY_DEFAULT_EXECUTOR` or
  `config.json`'s `defaultExecutor` to `opencode` instead — check before
  assuming an omitted flag means pi). Pass `--executor pi`/`--executor
  opencode` explicitly whenever the task needs a specific CLI regardless of
  that default. Both also accept `--class <name>` to tag the task with a
  free-text classification for telemetry aggregation (any non-empty string;
  taskferry does not validate against a fixed list). Both also accept
  `--parent-task <id>` to tag the dispatch as fixing/retrying an earlier
  task (persisted as `parentTaskId`, surfaced by `taskferry status <id>` /
  `taskferry result <id> --fields parentTaskId`); pass it whenever a
  fix-forward round is resuming from a known failing task — the parent
  task's check-gate failure message echoes the link, so the chain stays
  traceable across rounds instead of looking like an unrelated re-dispatch.
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

## Verifying A Worker's Claimed Changeset

A worker's final `Status:` line and narration are not evidence of what it
wrote -- only the extracted changeset is. Every sandboxed dispatch writes
to an overlay, not the real directory: `git -C "<worktree>" log`/`status`
against the real worktree will show nothing until you explicitly accept,
regardless of how good or bad the worker's actual changes were. After every
settled implementer/fixer dispatch, before treating the task as done:

```sh
taskferry result <id> --diff
```

If the diff matches what the worker claims (a `Status: DONE` describing a
specific change, matched by an actual diff doing that change), accept it:

```sh
taskferry accept <id>
```

*Then* the ordinary `git -C "<worktree>" log --oneline origin/main..HEAD` /
`git -C "<worktree>" status --short` checks become meaningful again, since
the diff has now actually landed.

### Verification gate (`accept` refusal and `--force`)

A repo with a `.taskferry.toml` at its root that declares a `check`
command (scaffold one with `taskferry init`; see
`docs/config.md#taskferrytoml` for the schema) runs that command
automatically inside the worker's copy-on-write overlay at settle. The
gate's verdict is recorded on the task as `checkStatus` (`none`/`running`/
`passed`/`failed`/`timeout`/`interrupted`) and surfaces on plain
`taskferry status <id>` (it's not `--full`-only) and `taskferry result <id>
--fields ...` even before `accept` runs; `--full` adds the changeset side
(`diff`, `diffStat`, `headDrift`, `changesetError`, ...) on top. `accept`
then refuses any task whose gate has not settled in your favor:

- `checkStatus: "failed"` or `"timeout"` — refuse with a multi-line
  fix-forward message (command, exit/timeout, last 40 lines of the
  gate's combined output, and a ready-to-paste `--parent-task`-tagged
  resume command).
- `checkStatus: "interrupted"` — same fix-forward message (rendered as
  a re-run notice). The gate was killed by a daemon restart; on the
  next daemon boot the gate auto-re-runs whenever the task's overlay
  survived.
- `checkStatus: "running"` — refuse with `error: check gate still
  running for <id>` and a pointer at `taskferry status <id>` for
  progress.

If you have manually verified the changeset (read the diff, run the
check yourself, decided the gate's verdict is the wrong one), override
the gate's outcome with `--force`:

```sh
taskferry accept <id> --force
```

`--force` stamps `checkOverride: true` on the task and applies normally,
including over a still-running gate (it group-kills the bwrap child
and best-effort waits for it to actually exit — SIGTERM, wait
`CHECK_GATE_KILL_GRACE_MS`, escalate to SIGKILL, wait another
`CHECK_GATE_KILL_GRACE_MS`, then resolve anyway rather than hang
`accept` forever). `--force` never overrides anything except the gate's
outcome — every other accept validation (pending changeset, diff
present, overlay live) still applies. Do not reach for `--force`
reflexively: if the gate refused, the fix-forward message is the
cheaper path back to a clean accept.

If the repo has no `.taskferry.toml` (or no `check` line in it), `accept`
prints a one-line stderr warning that the changeset landed unverified —
an accidental missing `.taskferry.toml` is loud rather than silent.

If `accept` itself fails for an unrelated reason (a conflicting `git
apply` -- the lower moved under a long-running ferry, see "Always Use A
Worktree" above), don't re-dispatch reflexively: `taskferry result <id>
--diff` still has the worker's changes, so resolve the conflict by hand
or reject and retry with a fresh dispatch against the now-current
directory.

If the diff itself is missing, wrong, or incomplete relative to the
worker's claim, reject it and re-dispatch:

```sh
taskferry reject <id>
```

`reject` is always allowed regardless of `checkStatus` (per the design's
"reject is always allowed" rule) and tears down any in-flight gate
before releasing the overlay.

A worker's `git commit` made *inside* the sandbox is never preserved as a
commit -- it's flattened into the same diff an uncommitted edit would
produce, and only survives if you `accept`. There is no more
"sandboxed `git commit` failed silently" failure mode to route around: a
commit was never going to land as a commit in the first place, by design,
not by an environment quirk.

This generalizes past just diffs: any deliverable a worker claims to have
produced (a written file, a pushed branch, a passed test run) is a claim to
verify independently, not to accept on narration alone.

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
- **Provider-specific availability rules (time windows, credential limits,
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

**Never read a task's raw log file directly** (`~/.local/state/taskferry/logs/*.ndjson`,
or any `--directory`/workspace-scoped equivalent) with `cat`/`grep`/`jq`/a
one-off script in place of a CLI command. `taskferry tail`, `wait
--summarize`, `result`, and `summary` are the sanctioned interface — they
exist specifically so nothing has to parse the raw event stream by hand.
Reaching around them costs the same context a raw `tail`/`cat` would, gains
nothing a CLI command doesn't already give more cheaply, and drifts from
whatever the CLI does to redact or bound output. The **only** standing
exception is the `workdir`-mismatch diagnostic in "When a worker's tool
calls don't honor `--directory`" below, which specifically needs the raw
`type=="tool_use"` `workdir` field the CLI commands don't surface — that one
stays scoped to that failure mode, not a general license to grep logs
whenever a CLI command feels slower.

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

**Inside Claude Code, run `wait --summarize` via `Bash` `run_in_background:
true`.** Don't arm a second, per-task `Monitor` for it — the fleet-wide
`watch --summaries` `Monitor` armed once per session (see "Fleet-Wide
Monitoring" below) already surfaces every ferry's progress, this one
included, as periodic batched notifications. `run_in_background` notifies
once, on the whole command's exit; that notification is the settlement
signal for this specific task.

**Never reach for `ScheduleWakeup` to wait on a settling ferry.**
`ScheduleWakeup` exists to self-pace a `/loop` session between iterations —
it takes a `/loop`-shaped `prompt`, not a task id, and errors outside that
context. It is not a general-purpose "check back later" primitive, and
nothing about waiting on `taskferry wait`/`taskferry result` should reach
for it, `/loop`-mode session or not: a `taskferry wait` already backgrounded
with `Bash` `run_in_background: true` delivers its own settlement
notification the moment the task finishes — there is nothing left to
schedule a wakeup for. Confirmed by a direct failed call: invoking
`ScheduleWakeup` immediately after backgrounding a `wait` errored
(`prompt is required when stop is not true`), because the tool has no
notion of "wake me when task X settles" at all. A genuine `/loop` session
separately polling ferry status as its actual loop body is a different,
legitimate use of the tool — that loop's own `prompt`/`delaySeconds`
governs its iteration, which is not the same thing as substituting
`ScheduleWakeup` for `run_in_background`'s notification.

**Never background `taskferry wait` with a shell `&`, `nohup … &`, `disown`,
or any equivalent manual detacher — this is NOT ALLOWED, in Claude Code or
any other host.** That idiom was a fallback for opencode's old
foreground-only Bash tool and exists nowhere else; in Claude Code it is
strictly worse than `Bash` `run_in_background: true` in every respect:

- `run_in_background` notifies you once, on the wait's exit — the
  settlement signal, delivered automatically. A `nohup … &` job never
  notifies; you can only learn it finished by *polling* the log file on a
  timer or re-running `cat`/`tail` on the chance it's done, which is
  exactly the polling loop the `--timeout` rule below forbids.
- It leaks orphaned `wait` processes and leftover `/tmp/taskferry-wait-*.log`
  files across turns and sessions, with no tracking the harness manages.
- It obscures the real exit status behind a log you have to remember to read.

If `run_in_background` is unavailable, the correct answer is **not** to
reach for `nohup`. Run `wait` in the foreground, or — in opencode — follow
the "no interim updates / pull, don't push" options in the opencode section
below, which deliberately avoid a standing background poller. The only
standing exception to "no shell backgrounding" is the **fleet-wide
`taskferry watch`** daemon in "Fleet-Wide Monitoring" (armed once per
session with a pid-file guard, a different command, a different purpose),
never a per-task `wait`.

Relay every summary-line notification with this exact template:

`⛴ <emoji> <short-task-id> <NN%> — <clause>`

- `<short-task-id>` — the taskferry task id, shortened to its first segment
  (e.g. `oc_mrpxgbg8`). This always exists, unlike other context, which may
  not apply to the dispatch at all. Add a human label in parens right after
  it only when one is genuinely in context, and always name what kind of
  thing it is — `issue #35`, `PR #12`, never a bare `#35` that leaves the
  reader guessing issue vs. PR vs. something else.
- `<emoji>` — pick whichever fits this specific update, from the narration
  tail; treat the following as a starting palette, not an enum: 🔨
  mid-implementation, 🧪 tests, 📝 docs, 🔍 investigating, ✅ settled clean,
  ⚠️ concern, 🚨 crashed/blocked.
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

Because opencode's own Bash tool has nothing like `run_in_background`, the
default is a **foreground** `wait --summarize`: it blocks the turn until
settlement, which is fine — the turn was going to wait on the task anyway.
Use `--summarize` for the same reason as the Claude Code case above: it
periodically condenses the narration tail into the stream instead of
leaving raw NDJSON sitting there, which is what actually makes option 2's
occasional peek worth reading rather than a wall of unprocessed events.
For options 2–3, where you need a look at progress before it settles and a
foreground `wait` would tie up the turn, `taskferry tail <id> --chars 2000`
is the right move — a one-shot read that returns immediately, not a
standing background process.

**Do not shell-background `wait` (`nohup … &`, `&` + `disown`, etc.) to
fake `run_in_background` inside opencode either.** It produces an untracked
orphan with no notification, the only way to learn it finished being a
polled `cat`/`tail` of a `/tmp` log on a timer — the exact polling loop
this guidance forbids — and leaks processes and log files across turns.
The foreground `wait` (option 1) or a one-shot `tail` (options 2–3) cover
every legitimate opencode need without that cost. This restriction is the
same one stated for Claude Code above: there is no host in which
`nohup taskferry wait … &` is the correct way to wait.

Read the final result and request an independent review when needed:

```sh
taskferry result <id>
taskferry advisor --prompt - --model <provider/model> --directory "<worktree>" <<'PROMPT_EOF'
<full prompt text>
PROMPT_EOF
```

Pull only the fields you actually need from a result instead of the full payload
with `taskferry result <id> --fields message,tokens,cost` (or any subset of
`message,narration,tokens,cost,sessionId,exitCode,signal,spawnError,failureReason,failureDetail,logPath,incomplete,finalMarker`)
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

**A `watch`/`list`/`context` scoped to a repo's root also sees every task
dispatched into a linked worktree of that repo** (taskferry#315) — the
directory filter compares the git workspace root of both sides, not the raw
`--directory` string, so a `--directory <main checkout>` watch still matches
a ferry dispatched with `--directory <worktree>`, which "Always Use A
Worktree" above requires for essentially every dispatch. This means one
fleet watch scoped to the repo root covers every worktree of that repo —
you no longer need to arm a separate watch per worktree. `watch --all`
additionally streams every workspace's events regardless of repo, for a
session that genuinely spans multiple repos.

Given that, arm the fleet watch scoped to the repo root (`resolveWorkspaceRoot`
of whatever directory this session works in — usually the main checkout, not
a worktree), once per session, on the first `taskferry dispatch`. That one
watch covers every worktree this session dispatches into, current or future,
without re-arming.

Background `taskferry watch --summaries --flush-interval 15m --directory
<repo root>` and register the process with the harness `Monitor` tool. This
is the only kind of `Monitor` this skill arms for dispatch progress — there
is no separate per-task `Monitor` alongside it (see "Inside Claude Code..."
above). It surfaces periodic, batched updates for every ferry dispatched
anywhere in that repo — including ones dispatched by other concurrent
sessions, and ones dispatched into a different worktree of the same repo.

This is pure convention for agent sessions to follow — the `Monitor` tool is
harness-native and can't be invoked from within taskferry's own code, so
nothing in taskferry itself enforces it.

**Scope the log path to the watched directory, not a fixed filename.** A
literal `/tmp/taskferry-fleet-watch.log` collides across concurrent
sessions: two sessions watching different repos (or two
sessions/terminals watching the same one) both redirecting to the
identical path race on the same inode — the second session's `>` truncates
the file out from under the first session's already-open write fd,
corrupting or dropping the first session's events with no error from
either side. Derive the path from the watched directory instead, so every
session targeting the same repo recomputes the identical path
deterministically (no `mktemp` — a random suffix can't be recomputed in a
later shell call, since shell state doesn't persist between tool calls) and
reuses the same watcher rather than spawning a duplicate:

```sh
WATCH_DIR="<this repo's root, e.g. the main checkout's path>"
SLUG=$(echo "$WATCH_DIR" | tr -c 'A-Za-z0-9_-' '-')
FLEET_LOG="/tmp/taskferry-fleet-watch${SLUG}.log"
FLEET_PID="/tmp/taskferry-fleet-watch${SLUG}.pid"
if ! kill -0 "$(cat "$FLEET_PID" 2>/dev/null)" 2>/dev/null; then
  taskferry watch --summaries --flush-interval 15m --directory "$WATCH_DIR" > "$FLEET_LOG" 2>&1 &
  disown
  echo $! > "$FLEET_PID"
fi
```

Then arm a `Monitor` tailing `$FLEET_LOG` (`tail -n0 -F "$FLEET_LOG"`,
`persistent: true`), the same pattern used for a single `wait --summarize`
job above — one notification per flush tick instead of one per raw event.
Recompute `$FLEET_LOG`/`$FLEET_PID` from `$WATCH_DIR` the same way in
any later shell call in this session (e.g. to `cat` the log) — don't rely on
the variable surviving between tool calls.

Arm this once per repo per session, on the first dispatch into that repo
(any of its worktrees), not once per dispatch and not once per worktree —
re-arming on every subsequent dispatch, or on every distinct worktree,
would spawn a redundant background `watch` process each time. The
`kill -0`/pid-file check above additionally guards the cross-session case:
a second concurrent session working in the same repo reuses the first
session's already-running watcher instead of starting a colliding second
one. A session that genuinely dispatches into more than one unrelated repo
still needs one watch per repo (or a single `watch --all`, at the cost of
mixing every workspace's events into one stream).

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

A worker can crash with `status: crashed, failureReason:
no_output_timeout_dead_spawn` (no parseable log event ever emitted) or
`no_output_timeout_stalled` (some parseable event emitted, then no progress
past the post-output budget) while genuinely still working, not actually
stuck: high-reasoning-effort models can go silent for minutes mid-turn (long
internal reasoning, or a slow tool call such as a full test suite), and some
models (e.g. `glm-5.2`) stream long stretches of empty `</think>`
thinking-tail events that don't reset the watchdog. Taskferry's own watchdog
kills the process regardless of whether real work is happening underneath.

Treat every `no_output_timeout_*` crash as a possible false-positive kill,
not proof the task failed:

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
- Two or more consecutive `no_output_timeout_*` crashes on the same
  prompt+model+variant combination, especially with `sessionId: null` every
  time, is a signal to change something rather than retry unchanged: drop to a
  less exhaustive `--variant`, switch model/provider, or shorten the prompt so
  the worker produces its first tool call sooner.

Use `taskferry cancel <id>` for work that should stop; it sends SIGTERM and
escalates to SIGKILL after a grace period (default 5000ms, override with
`--grace-ms <number>` for a worker that needs longer to unwind, e.g. mid
long-running command). Use `taskferry list` or `taskferry context --format toon`
to inspect workspace-scoped state, `taskferry doctor --full` if something
about the daemon itself seems wrong (dead socket, stale process, health check
failing) before assuming a task-level problem, and `taskferry doctor --stats`
for an aggregate report over task history (status mix, per-model crash rates,
failure-reason histogram, unknown backlog, crash-rate trend) instead of
hand-computing it from `taskferry list --all`. The CLI emits structured data,
errors, and help as TOON on stdout, keeps diagnostics on stderr, and uses exit
codes to distinguish success, operational failure, and usage errors.

**The daemon picks up code changes automatically (deferred-until-idle
restart), and provider credentials no longer require a daemon restart.**
`dispatch`, `advisor`, and `summary` (report mode) forward the calling
shell's own environment to the daemon on every call — so exporting a fresh
API key into your shell immediately takes effect on the next taskferry
command. Daemon-level configuration variables
(`TASKFERRY_MAX_CONCURRENT_TASKS`, `TASKFERRY_ENV_DENYLIST`, and the
`config.json` fields they override) still require a daemon restart because
they are read once at startup.

**`TASKFERRY_ENV_FILE` (or the `envFile` config field) solves a different
problem than caller-env forwarding: a non-interactive caller — cron,
systemd, a scheduled job — that never had the secret in its own environment
to forward in the first place**, because secrets exported in an interactive
shell's rc file (`.bashrc`/`.zshrc`/`config.fish`) are invisible to a
process cron spawns. Point it at a `.env`-style file (`NAME=VALUE` per
line) and the daemon loads it once at startup as the lowest-priority layer
of every spawned child's environment — below its own ambient env, below the
caller's forwarded env, so a live caller's or the daemon's own value still
wins on a shared key. It's read once at daemon startup like the other
daemon-level vars above, not per-dispatch — a daemon restart is required to
pick up a changed file or a newly set/changed `TASKFERRY_ENV_FILE`. See
`docs/security.md#caller-env-forwarding` and `docs/config.md`.

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

## `/tmp` paths are invisible inside the sandbox by default

Every sandboxed dispatch mounts a fresh, empty `--tmpfs /tmp`. If you point a
dispatch at a scratch file you saved under `/tmp` (a diff, a prompt, any
input the worker's supposed to read) without also passing `--allowed-dirs`
for that path, the file doesn't exist from the worker's point of view —
even though it's right there on the host. Pass the containing directory via
`--allowed-dirs /tmp/your-scratch-dir` any time a dispatch needs to read
something under `/tmp` that isn't already the dispatch's `--directory`.

This bit once with a batch of code-review dispatches pointed at diff files
saved under `/tmp/pr-reviews/pr-<N>.diff`: none of the finders could read
them, and instead of reporting the read failure, each one silently
reconstructed the diff itself with `git diff main...HEAD` in its own
worktree. For PRs stacked on another open PR's branch, that reconstruction
pulled in the whole underlying stack and produced findings that didn't
belong to the PR under review — with no error, no `incomplete: true`, just
a `done`/`exitCode: 0` task that quietly answered a different question than
the one asked (taskferry#211). If a worker's report describes reading a
specific `/tmp` path you gave it, and the content it echoes back doesn't
match what you saved there, suspect this before suspecting the model.

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
