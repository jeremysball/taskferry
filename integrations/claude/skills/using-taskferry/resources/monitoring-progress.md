# Monitoring a ferry's progress

How to wait on a dispatch, surface its progress, and relay updates. The
mechanics differ by host runtime, so find your host below — Claude Code and
OpenCode are covered explicitly; anything else falls back to the "Host: any
other runtime" section at the end. The core `dispatch`/`wait`/`result`
commands live in SKILL.md; this file covers everything about *watching* a
run in flight.

## Waiting rules that hold in every host

**`taskferry wait` is the only settlement signal — never a bare search for
`Status:` in the output.** Grepping for the marker alone, before the task has
settled, false-positives whenever the worker's own output quotes earlier text
containing a `Status:`-prefixed line (a task that reads old transcripts or other
dispatch logs matches the first hit anywhere in the stream, not the model's real
final report). Wait for settlement first, then read `Status:` / `Task quality:`
out of `taskferry result` or `taskferry tail`. Don't poll for a report file or a
commit to appear, and don't `tail` mid-run just to check progress absent a real
need to inspect activity.

**Do not pass `--timeout` to `taskferry wait`.** The process exits on its own the
moment the task settles; a timeout only makes the caller re-issue `wait` in a
polling loop for no benefit.

`wait` also takes a `--tail-chars <number>` option, but it only fires on a
timeout (trailing text characters from that point) — including the default
15-minute wait timeout, not just an explicit `--timeout`. Since neither
timeout is something to wait out deliberately, treat `--tail-chars` as dead
weight too and don't reach for it. For the settled result, use `taskferry
result <id> --fields ...` instead — it returns real structured fields, not a
raw character tail.

For a long-running task, prefer `taskferry wait <id> --summarize` over a bare
`wait`: it streams periodic one-line summaries of the task's narration tail
while blocking, then returns the same settlement status a plain `wait` would.
This gives visibility into what the worker is doing without polling `tail` by
hand. To watch one specific task's live event stream instead of the whole
workspace's, use `taskferry watch --task-id <id>` rather than an unscoped
`taskferry watch`; add `--summaries` to get condensed activity summaries in
that stream instead of raw events.

Don't call `summary <id> --mode activity` directly for interim visibility
while a task is still running — that mode exists for the statusline/human
`watch` path, not for a model checking in on its own dispatch. Use `taskferry
wait <id> --summarize` instead: it already streams the same condensed activity
summaries while blocking, without a second parallel command doing the same job.

## Never manually detach a `wait`

**Never background `taskferry wait` with a shell `&`, `nohup … &`, `disown`,
or any equivalent manual detacher — this is NOT ALLOWED, in any host.** That
idiom was a fallback for opencode's old foreground-only Bash tool and exists
nowhere else. It:

- **never notifies.** You can only learn it finished by *polling* the log file
  on a timer or re-running `cat`/`tail` on the chance it's done, which is
  exactly the polling loop the `--timeout` rule above forbids.
- leaks orphaned `wait` processes and leftover `/tmp/taskferry-wait-*.log`
  files across turns and sessions, with no tracking the harness manages.
- obscures the real exit status behind a log you have to remember to read.

If a host-native background primitive is unavailable, the correct answer is
**not** to reach for `nohup`. Run `wait` in the foreground, or — in opencode —
follow the "no interim updates / pull, don't push" options below, which
deliberately avoid a standing background poller. The only standing exception
to "no shell backgrounding" is the **fleet-wide `taskferry watch`** daemon
below (armed once per session with a pid-file guard, a different command, a
different purpose), never a per-task `wait`.

## Host: Claude Code

**Run `wait --summarize` via `Bash` `run_in_background: true`.** Don't arm a
second, per-task `Monitor` for it — the fleet-wide `watch --summaries`
`Monitor` armed once per session (below) already surfaces every ferry's
progress, this one included, as periodic batched notifications.
`run_in_background` notifies once, on the whole command's exit; that
notification is the settlement signal for this specific task.

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

### Relaying a summary-line notification

Use this exact template:

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

## Host: OpenCode

**Inside OpenCode itself (opencode as the host running taskferry, not Claude
Code), none of the Monitor pattern above applies, and there is no way to
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

The "never manually detach a `wait`" rule above applies here unchanged: a
`nohup … &` inside opencode produces an untracked orphan with no
notification, the only way to learn it finished being a polled `cat`/`tail`
of a `/tmp` log on a timer. The foreground `wait` (option 1) or a one-shot
`tail` (options 2–3) cover every legitimate opencode need without that cost.

## Host: any other runtime

This file documents Claude Code and OpenCode explicitly because those are
the two hosts this repo's own sessions run under; nothing here has been
verified against any other host's tool surface, Codex included. If you're on
a host not listed above, check whether it has a genuine backgrounded-execution
primitive with its own settlement notification (like Claude Code's
`run_in_background: true`) before assuming one. If it doesn't — or you
haven't confirmed it does — default to the same **foreground** `wait
--summarize` the OpenCode section above uses: a foreground wait blocks the
turn but works correctly on every host by construction, with no risk of the
untracked-orphan failure mode the manual-detach rule above warns about.

## Fleet-wide monitoring

**A `watch`/`list`/`context` scoped to a repo's root also sees every task
dispatched into a linked worktree of that repo** (taskferry#315) — the
directory filter compares the git workspace root of both sides, not the raw
`--directory` string, so a `--directory <main checkout>` watch still matches
a ferry dispatched with `--directory <worktree>`, which the worktree rule in
SKILL.md requires for essentially every dispatch. This means one fleet watch
scoped to the repo root covers every worktree of that repo — you no longer
need to arm a separate watch per worktree. `watch --all` additionally streams
every workspace's events regardless of repo, for a session that genuinely
spans multiple repos.

Given that, arm the fleet watch scoped to the repo root (`resolveWorkspaceRoot`
of whatever directory this session works in — usually the main checkout, not
a worktree), once per session, on the first `taskferry dispatch`. That one
watch covers every worktree this session dispatches into, current or future,
without re-arming.

Background `taskferry watch --summaries --flush-interval 15m --directory
<repo root>` and register the process with the harness `Monitor` tool. This
is the only kind of `Monitor` this skill arms for dispatch progress — there
is no separate per-task `Monitor` alongside it. It surfaces periodic, batched
updates for every ferry dispatched anywhere in that repo — including ones
dispatched by other concurrent sessions, and ones dispatched into a different
worktree of the same repo.

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
`persistent: true`) — one notification per flush tick instead of one per raw
event. Recompute `$FLEET_LOG`/`$FLEET_PID` from `$WATCH_DIR` the same way in
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
