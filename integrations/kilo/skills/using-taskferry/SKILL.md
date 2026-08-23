---
name: using-taskferry
description: Dispatch long-running background agents (ferries) through the taskferry CLI.
---

# Taskferry Worker Backend

Taskferry dispatches long-running background agents — ferries — through the
`taskferry` CLI, on an external worker model rather than the host runtime.
Each dispatch runs in a copy-on-write overlay over a directory you name, and
settles into a changeset you accept or reject, so a ferry always produces a
verifiable diff before anything lands.

This file is the core loop: decide, dispatch, wait, verify, accept. Four
resources hold the detail:

| Resource | Read it when |
|---|---|
| `resources/deciding-to-dispatch.md` | Before dispatching at all — the gate that decides whether this is ferry work |
| `resources/choosing-a-model.md` | Picking `--model` / `--variant`: tiers, role mapping, panels |
| `resources/monitoring-progress.md` | Waiting on a run, relaying progress, arming a fleet watch |
| `resources/failure-modes.md` | A dispatch crashed, lied, or silently answered the wrong question |

## Sizing The Task Before Dispatching

See `resources/deciding-to-dispatch.md` for the gate and self-check before
routing a backlog item, bug, or fix through Taskferry — worktree creation, a
written brief, dispatch, wait, review are all costs to weigh against a
one-or-two-call Read/Edit/Grep. That resource's gate applies unchanged here;
this file assumes you've already passed it.

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
this.

**Two flags turn that isolation off, and both change how you verify a
result.** `--no-overlay` runs the dispatch without the copy-on-write overlay,
so writes land in the directory immediately and are not gated by
`accept`/`reject`. `--no-sandbox` runs it without the bwrap filesystem
sandbox (sandboxing is the default on Linux). Everything below, and the whole
accept/reject loop, assumes the default overlayed dispatch. Under
`--no-overlay` there is no changeset to inspect and no accept step, so
`git status` in the directory becomes the way to see what happened, and a bad
dispatch has already written to your tree. Reach for either flag only when you
specifically want that.

**A worker's writes only land somewhere durable inside `--directory`.** The
sandbox mounts `--directory` as the one copy-on-write overlay and binds the
rest of the root read-only, plus a small set of explicitly read-write paths
(the git common dir, `runtimeDir`, and any `--rw-bind` entries; `--allowed-dirs`
is a deprecated alias for `--rw-bind`). There is no second, throwaway overlay
for anything else. A symlink out to some other
path on the host (e.g. a worktree's scratch directory symlinked to a shared
location in the main checkout) resolves into the read-only root, so a write
through it fails with EROFS rather than silently landing anywhere. A write
that resolves to one of the other read-write paths *does* land durably on
the host, but still doesn't appear in `taskferry result --diff`, because
diff extraction is rooted at `--directory` only (doubly true for a
gitignored path, which a git-diff-based extraction can't see regardless) --
and the worker's own narration will still report success either way. If
multiple worktrees need to share scratch files (a plan's ledger, briefs,
reports), put them inside the dispatched `--directory` (or one of its
allowed dirs) instead of symlinking across the sandbox boundary.

## Worker Contract

- Select the worker model explicitly — `--model <provider/model>` is required
  for a fresh dispatch (only a `--session-id` resume may inherit the prior
  task's model). Omit `--variant` to get that model's hardest thinking
  level; pass a concrete variant only when the task wants a lower effort
  level: `taskferry dispatch --prompt - --directory "<worktree>" --model
  <provider/model> --variant <name> <<'PROMPT_EOF'` ... `PROMPT_EOF`. See
  `resources/choosing-a-model.md` for which tier each role needs.
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
- Resume the session that already did the work for any follow-up on it, and
  start a fresh session only in the cases listed under "Resume The Session
  That Did The Work" below.
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
- **The delimiter must not appear on its own line anywhere inside the prompt.**
  A heredoc ends at the first line equal to its delimiter, so a prompt that
  contains a bare `PROMPT_EOF` is silently cut off there, and whatever followed
  is handed to the shell as commands. Nothing errors: `taskferry` receives a
  truncated prompt, the worker answers the question it was actually asked, and
  the task settles `done` with `exitCode: 0`. **Whenever the prompt embeds
  content you did not write** (a file's contents, a diff, a transcript, another
  prompt), pick a delimiter and verify it is absent from the payload before
  dispatching, rather than reaching for `PROMPT_EOF` out of habit. A random
  suffix makes collision effectively impossible:

  ```sh
  TF_EOF="TF_EOF_$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  grep -qxF "$TF_EOF" prompt-payload && echo "delimiter collides, regenerate" >&2
  ```

  This bites hardest on prompts that embed taskferry's own documentation,
  because every example of this very rule contains the literal token.
- End every dispatch prompt with an explicit instruction to close on a line
  starting `Status:` — one of `DONE | DONE_WITH_CONCERNS | BLOCKED |
  NEEDS_CONTEXT` for implementers, or `Approved | Needs fixes` after a `Task
  quality:` line for reviewers. This is a standing contract, not a per-task
  flourish; `--require-final-marker` enforces it.
- Wait for settlement, retrieve the result, handle crashes, and validate the
  worker's deliverables yourself.

## Resume The Session That Did The Work

**Every dispatch that continues work a prior ferry already did resumes that
ferry's session.** Pass `--session-id`, drop `--model` (a resume inherits the
prior task's model, executor, and variant), and keep `--directory` on the
worktree the original ran in -- on the `pi` executor the session lookup is
keyed by that launch directory:

```sh
taskferry dispatch --prompt - --directory "<same worktree>" --session-id <sessionId> <<'PROMPT_EOF'
<the delta only: what changed since that worker's last turn, and what to do now>
PROMPT_EOF
```

`taskferry result <id> --fields sessionId` prints the id, and a crashed
task's `next:` line prints the whole resume command ready to paste.

"Continues work a prior ferry did" is the predicate, and it is broader than a
fix round:

| The follow-up | Resume |
|---|---|
| A fix round on the reviewer's findings | that task's implementer session |
| A later fix round, or another bug found in the same change | that same implementer session |
| Finishing a task cut short by a crash, a timeout, or a cancel | the interrupted session |
| A re-review checking whether the findings were addressed | the reviewer session that wrote those findings |
| A follow-up question about work a worker already reported on | that worker's session |

A resumed worker still holds the brief, the files it read, and the findings
it wrote. **Send it the delta, not the briefing** -- "your three findings were
fixed; the diff is at HEAD; verify only those" -- never the brief, the report
and the diff over again. Re-briefing a session that already has the context
pays twice: once for the prompt, and again for the worker re-reading every
file it had already read.

**Start a fresh session only when one of these holds:**

- **It is different work**, not a continuation of the same change.
- **It is the first review of a change.** A reviewer must not be the session
  that wrote the code, and must not inherit an earlier review's frame. This
  covers the first review only -- a *re*-review of that same reviewer's own
  findings is a continuation, and resumes.
- **There is nothing to resume.** `sessionId` is null, or the session has
  crashed twice in a row (see `resources/failure-modes.md`).
- **The executor changes.** Session ids are unique per executor, so a session
  created under `--executor opencode` can't be resumed under `--executor pi`,
  or the reverse.
- **The sandbox mode changes.** Sandboxed and `--no-sandbox` dispatches
  resolve sessions against different worker data homes: on `opencode` neither
  can resume the other's session, and on `pi` only a host-created session can
  be bound into a sandboxed resume, never the reverse.

Wanting a *different model* is not on that list. `--session-id` with an
explicit `--model` hands the prior transcript to a stronger model, which
beats starting that model cold.

| Excuse | Reality |
|---|---|
| "A re-review is a review, not a fix, so it needs a fresh session" | A re-review of findings that reviewer itself produced continues that reviewer's work. Resume it. |
| "Fresh sessions for each reviewer" | Every reviewer *assignment* -- the first review of a change. Round 2 is the same assignment, not a new one. |
| "The fresh prompt reproduces the brief and the findings, so nothing is lost" | The context was rebuilt, not preserved. The worker re-reads every file and re-derives every conclusion it already had, and you pay for both. |

## The Core Loop

Dispatch with an explicit workspace, feeding the prompt straight over stdin
with a quoted heredoc — `--prompt -` reads until EOF:

```sh
taskferry dispatch --prompt - --directory "<worktree>" --model <provider/model> --variant <name> <<'PROMPT_EOF'
<full prompt text>
PROMPT_EOF
```

Then wait for settlement, and inspect:

```sh
taskferry wait <id> --summarize   # blocks, streams progress; check the status it returns
taskferry status <id>             # point-in-time state, including checkStatus
taskferry tail <id> --chars 2000  # one-shot look at recent narration
taskferry result <id>             # the settled result
taskferry output <id>             # scratch dir the worker wrote (taskferry#423); use --path <relpath> to read one file
```

Pull only the fields you need instead of the full payload with `taskferry
result <id> --fields message,tokens,cost` (or any subset of
`message,narration,tokens,cost,sessionId,exitCode,signal,spawnError,failureReason,failureDetail,logPath,incomplete,finalMarker`)
— cheaper than `--full` when you don't need untruncated narration. If the raw
narration is long enough that reading it whole would blow the context budget,
condense it instead:

```sh
taskferry summary <id> --mode report  # a bounded final report, after settlement
```

The CLI emits structured data, errors, and help as TOON on stdout, keeps
diagnostics on stderr, and uses exit codes to distinguish success,
operational failure, and usage errors.

**Never read a task's raw log file directly** (`~/.local/state/taskferry/logs/*.ndjson`,
or any `--directory`/workspace-scoped equivalent) with `cat`/`grep`/`jq`/a
one-off script in place of a CLI command. `taskferry tail`, `wait
--summarize`, `result`, and `summary` are the sanctioned interface — they
exist specifically so nothing has to parse the raw event stream by hand.
Reaching around them costs the same context a raw `tail`/`cat` would, gains
nothing a CLI command doesn't already give more cheaply, and drifts from
whatever the CLI does to redact or bound output. The **only** standing
exception is the `workdir`-mismatch diagnostic in
`resources/failure-modes.md`, which specifically needs the raw
`type=="tool_use"` `workdir` field the CLI commands don't surface.

Waiting has real rules — no `--timeout`, no shell backgrounding, no grepping
for `Status:` as a settlement signal — and they differ by host runtime. They
live in `resources/monitoring-progress.md`; read it before your first `wait`
in a session.

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

If the diff itself is missing, wrong, or incomplete relative to the worker's
claim, reject it and re-dispatch:

```sh
taskferry reject <id>
```

`reject` is always allowed regardless of `checkStatus`, and tears down any
in-flight gate before releasing the overlay.

### `accept` requires a clean target tree

**Every path in the diff must have identical content in the target's working
tree and in its index, or `accept` applies nothing at all.** This is the most
common way a good changeset fails to land, it destroys the worker's real work
when it fires, and it has nothing to do with the quality of the diff.

Extraction stages everything before diffing (`changeset.js`):

```sh
git -C <directory> add -A && git -C <directory> diff --cached <preDispatchHead>
```

The overlay inherits the real directory's untracked files from the lower, so
`add -A` sweeps them into the patch as `new file` entries the worker never
wrote. `accept` then runs `git apply --3way`, which refuses the **entire**
patch when any one path is unclean and rolls back what it had already applied.
Reproduced on stock git: a single untracked `ambient.txt` present before
dispatch discarded a `brand-new.txt` the worker had legitimately created.

```
error: ambient.txt: does not exist in index
error: cannot read the current contents of 'ambient.txt'
error: ambient.txt: patch does not apply
```

Two states violate the rule, and the second one is easy to miss:

- **An untracked, non-ignored file anywhere in the target directory.**
  Gitignored paths are safe, since `add -A` honors `.gitignore`, so
  dependencies and build output are not the hazard. Stray scratch files, plan
  dumps, and screenshots dropped at the repo root are.
- **An uncommitted edit to a file the ferry also touched.** `git apply`
  refuses any path whose working-tree content disagrees with its index entry,
  even for an ordinary tracked file with the base blob available. Editing a
  file while a ferry runs on it is enough to trigger this.

**Stage before accepting.** Staging makes tree and index agree by definition,
satisfying both cases without deleting scratch you may still want:

```sh
git -C "<worktree>" add -A && taskferry accept <id>
```

To check first, `git -C "<worktree>" status --short` printing any line at all
means `accept` is at risk.

**Until taskferry#414 is fixed, `accept` can exit 0 after the apply failed**,
so a zero exit code is not evidence the changeset landed. Confirm with `git -C
"<worktree>" status --short` or `git diff --stat HEAD` afterward.

**New files are the unrecoverable case.** A patch that creates a file records
a null preimage hash (`index 0000000..<hash>`), so there is no merge base and
no three-way merge is possible. Direct application is the only path left, and
it refuses to write over a path that already exists. A conflict in a *tracked*
file can often be resolved by the three-way merge; a new file colliding with
an untracked one cannot, unless an index entry exists for it, which is exactly
what staging supplies.

If `accept` fails for a different reason, a genuinely conflicting `git apply`
after the lower moved under a long-running ferry (see "Always Use A Worktree"
above), don't re-dispatch reflexively: `taskferry result <id> --diff` still
holds the worker's changes, so resolve the conflict by hand or reject and
retry with a fresh dispatch against the now-current directory.

A worker's `git commit` made *inside* the sandbox is never preserved as a
commit -- it's flattened into the same diff an uncommitted edit would
produce, and only survives if you `accept`. There is no "sandboxed `git
commit` failed silently" failure mode to route around: a commit was never
going to land as a commit in the first place, by design, not by an
environment quirk.

This generalizes past just diffs: any deliverable a worker claims to have
produced (a written file, a pushed branch, a passed test run) is a claim to
verify independently, not to accept on narration alone.

### The verification gate

A repo with a `.taskferry.toml` at its root that declares a `check` command
gets an automatic settle-time gate: every dispatched worker is told about
the command in its prompt, that same command then runs inside the worker's
copy-on-write overlay at settle, and `accept` refuses any task whose gate
has not settled in your favor. Scaffold one with:

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

**!temp: a bare `--timeout` number is milliseconds, not seconds.** `--timeout
1800` is 1.8 seconds, not 30 minutes. Bare digits pass straight through as
milliseconds (`src/args.js:78`), so the value that reads like a generous
half-hour budget actually times the wait out almost immediately. Always write
the unit: `--timeout 30m`, `--timeout 90s`, `--timeout 1h`. The same applies to
every duration flag that goes through `parseDuration`, including
`--flush-interval`.

A `!temp:` directive papers over a rough edge in the current CLI rather than
describing intended behavior. Delete it once the underlying surface changes.

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
taskferry init
```

`init` runs in literal cwd (no `--directory` flag, no workspace-root
redirect) and detects the project's ecosystem — package.json's
`check`/`lint`/`typecheck`/`test` scripts, or a marker file
(`pyproject.toml`, `go.mod`, `Cargo.toml`, `deno.json[c]`, `bunfig.toml`) —
proposing a `check` command. On a TTY it asks before writing the detected
value in directly; without a TTY it always writes a commented fill-in
template, so the file is never silently encoded with a guess nobody
approved. Run it once per repo (or per worktree if each worktree wants its
own gate), commit the result, and the next dispatch picks it up
automatically — no daemon restart required. `init` never overwrites an
existing `.taskferry.toml`. The schema is documented in
`docs/config.md#taskferrytoml`.

The gate's verdict is recorded on the task as `checkStatus`
(`none`/`running`/`passed`/`failed`/`timeout`/`interrupted`) and surfaces on
plain `taskferry status <id>` (it's not `--full`-only) and `taskferry result
<id> --fields ...` even before `accept` runs; `--full` adds the changeset
side (`diff`, `diffStat`, `headDrift`, `changesetError`, ...) on top.
`accept` refuses on:

- `checkStatus: "failed"` or `"timeout"` — with a multi-line fix-forward
  message (command, exit/timeout, last 40 lines of the gate's combined
  output, and a ready-to-paste `--parent-task`-tagged resume command).
- `checkStatus: "interrupted"` — same fix-forward message, rendered as a
  re-run notice. The gate was killed by a daemon restart; on the next daemon
  boot it auto-re-runs whenever the task's overlay survived.
- `checkStatus: "running"` — `error: check gate still running for <id>`, with
  a pointer at `taskferry status <id>` for progress.

If you have manually verified the changeset (read the diff, run the check
yourself, decided the gate's verdict is the wrong one), override it:

```sh
taskferry accept <id> --force
```

`--force` stamps `checkOverride: true` on the task and applies normally,
including over a still-running gate (it group-kills the bwrap child and
best-effort waits for it to exit — SIGTERM, wait `CHECK_GATE_KILL_GRACE_MS`,
escalate to SIGKILL, wait again, then resolve anyway rather than hang
`accept` forever). `--force` never overrides anything except the gate's
outcome — every other accept validation (pending changeset, diff present,
overlay live) still applies. Do not reach for it reflexively: if the gate
refused, the fix-forward message is the cheaper path back to a clean accept.

If the repo has no `.taskferry.toml` (or no `check` line in it), `accept`
prints a one-line stderr warning that the changeset landed unverified — an
accidental missing `.taskferry.toml` is loud rather than silent.

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

## When Something Goes Wrong

`resources/failure-modes.md` covers the crashes and silent wrong answers that
look like something else: `no_output_timeout` kills that aren't real failures, a
worker whose tool calls ignore `--directory`, `/tmp` paths that don't exist
inside the sandbox, models that can't actually perceive audio or images, and
which knobs need a daemon restart. Start there before re-dispatching, and use
`taskferry cancel <id>` for work that should just stop.

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
