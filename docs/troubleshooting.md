# Troubleshooting

Start with `taskferry doctor --full`. It connects to the daemon
(auto-starting one if none is reachable) and reports:

```
healthy: true
pid: 605018
version: 1
cliVersion: 2.0.0
protocolVersion: 1
```

If this fails outright, nothing else in taskferry will work either — work
through the sections below in order.

## `taskferry doctor` never returns / times out

The CLI's daemon auto-start waits up to 5 seconds for a health check before
giving up with `error: taskferry daemon did not become ready within
5000ms`. Causes, roughly in likelihood order:

1. **Permission problem on the runtime directory.** The daemon needs to
   `mkdir`/`chmod` `TASKFERRY_RUNTIME_DIR` (default
   `<state-dir>/run`, or `$XDG_RUNTIME_DIR/taskferry`) to mode `0700` before
   it can bind a socket there. Check the directory is writable by the
   current user; a stale directory owned by a different user (e.g. left
   over from running taskferry as root once) blocks every subsequent start.
2. **Something else is listening on the socket path.** See
   [Another process is already listening](#another-process-is-already-listening-on-the-socket)
   below.
3. **Node itself failed to start** (missing binary, corrupted install).
   Run `node -e "console.log(1)"` to confirm Node works at all, then `node
   /path/to/taskferry/src/daemon.js` directly and read whatever it prints
   to stderr before exiting.

## Another process is already listening on the socket

```
error: taskferry daemon is already listening on <path>
help: use the existing daemon or choose another TASKFERRY_RUNTIME_DIR
```

or, if a non-taskferry process happens to own that socket file:

```
error: another process is already listening on <path>
help: use the existing daemon or choose another TASKFERRY_RUNTIME_DIR
```

The first case usually just means a daemon from an earlier session is
still running and healthy — nothing to fix, your command should have
connected to it rather than trying to start a new one; if it printed this
anyway, something raced the auto-start lock unexpectedly and retrying
the command should succeed. The second case means an unrelated process
bound that exact path (rare unless you set a custom
`TASKFERRY_RUNTIME_DIR`/`TASKFERRY_SOCKET_PATH` that collides with
something else) — point `TASKFERRY_RUNTIME_DIR` somewhere taskferry-only.

## A stale socket file won't clean up

If a daemon was killed with `SIGKILL` (not `SIGTERM`/`SIGINT`, which clean
up the socket file on the way out), the socket file can be left behind
with nothing listening on it. The daemon detects this automatically on its
next start (health-checks the existing file, finds nothing answering,
removes it under a lock — see [daemon.md](daemon.md#startup-races-and-stale-sockets))
and this resolves itself on the next `taskferry` invocation. If it doesn't,
confirm nothing else holds that path open (`lsof <socket-path>` on macOS,
`fuser <socket-path>` on Linux) before removing it by hand.

## `dispatch` fails with `spawnError`

The task's worker CLI itself failed to launch — `opencode` or `pi`,
whichever the task's executor selected (explicitly via `--executor`, or the
daemon's configured default) — usually because that binary isn't installed
or isn't on the `PATH` the daemon was started with. Confirm with `which
opencode`/`which pi` in the same shell/environment the daemon auto-started
from (remember: the daemon inherits environment from whichever command
first triggered its auto-start, not necessarily your current shell — see
[daemon.md](daemon.md#auto-start)). If you just installed the missing
binary, stop the existing daemon (it started before that binary was on
`PATH`) and let the next command spawn a fresh one.

## A task is stuck `crashed` with `failureReason: "no_output_timeout_dead_spawn"` or `"no_output_timeout_stalled"`

The task went silent past the applicable no-output deadline and the
watchdog killed it. The clock the watchdog tracks resets on **any log
growth**, not just a complete parseable JSON line — an in-progress line,
non-JSON stderr chatter, or a write straddling two ticks all count as proof
of life. `"no_output_timeout_dead_spawn"` means either the log never grew
at all, or it grew but never once yielded a parseable event, within
`TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (default 256000ms) — the worker or
provider never started producing anything. `"no_output_timeout_stalled"`
means it did produce at least one parseable event and then went silent
(no further log growth at all) past
`TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` (default 400000ms) — it did
real work, then hung mid-task. Both apply equally to either executor. Read
the log directly (`taskferry status <id> --full` for the `logPath`) to see
what, if anything, the selected worker wrote before being killed — a
common cause of the dead-spawn variant is a prompt or model that needs an
interactive step taskferry's non-interactive invocation can't satisfy
(`opencode run --auto` for the `opencode` executor; `pi`'s own
non-interactive mode for `pi`). Raise the relevant timeout only if the
task is legitimately slow, not to paper over a hung worker.

There's also a separate, absolute ceiling on the pre-output phase:
`TASKFERRY_PRE_OUTPUT_MAX_MS` (default 4x `TASKFERRY_NO_OUTPUT_TIMEOUT_MS`,
so 1024000ms), measured from when the watcher armed rather than from the
last activity. A worker that never produces a single parseable line but
keeps the raw log growing forever (continuous non-JSON noise) would
otherwise ride the any-growth reset indefinitely, holding a concurrency
slot forever — this ceiling still kills it as
`"no_output_timeout_dead_spawn"` even while raw bytes keep arriving. It
stops applying the moment a parseable line lands; from then on the
escalated post-output budget above is the only mechanism.

**Known limitation:** stderr is piped straight to the raw log file
unfiltered — no JSON parsing, no event normalization — so any stderr
chatter not causally tied to real task progress (a CLI-level spinner or
retry-loop print, a Node runtime warning) still counts as "any log
growth" and resets the clock. This is an accepted tradeoff, not a bug:
narrowing what counts as activity would bring back the false-positive
kills this watchdog change exists to prevent.

If the log shows the worker recovered on its own after a transient error
mid-run and reached a genuine final answer, check `status` again: taskferry
reclassifies that specific pattern (a `crashed` exit whose log still ends
in a real `step_finish "stop"`) to `"done"` at settlement, keeping
`failureReason` set as a record. A task stuck `crashed` here never reached
that point.

## A task is stuck `crashed` with a provider-failure `failureReason`

The watchdog matched a known provider-failure diagnostic in the task's log
and stopped it early rather than let it burn the remaining grace period
against a key that was never going to succeed. Which value you see picks
the fix — for the `opencode` executor it's one of three bare names below;
a task dispatched with a different executor (e.g. `pi`) gets the same
three buckets prefixed with the executor name instead (`pi_rate_limited`,
etc.). See [daemon.md](daemon.md#watchdogs) for exactly what triggers each
one:

- `"rate_limited"`: transient. Retry later, or switch `--model` in the
  meantime.
- `"payment_required"`: the account behind that credential needs a
  billing fix.
- `"authentication_failed"`: the credential is broken. Rotate it, or
  export a different one before the next dispatch (see
  [security.md](security.md#caller-env-forwarding)).

`taskferry status <id> --full` (or `result --fields failureDetail`) shows
the specific log line or error text that triggered the classification.

## A task crashes instantly with `failureReason: "boot_failure"`

The child exited non-zero without ever emitting a log event, which means
it died during CLI startup, before doing any work. The bucket follows the
same prefix rule (`"pi_boot_failure"` for the `pi` executor), and
`failureDetail` carries the last `Error:` line of the captured output (or
the last non-JSON line when nothing is Error-prefixed). Read the detail
as the fix list: a malformed provider extension, a broken config, or
whatever else the runtime loads before reaching the model. Fix what it
names, then re-dispatch. Retrying unchanged will crash the same way.

## `taskferry result` says the task is still running

`result` only returns a final `message`/`narration` once a task reaches
`done` or `crashed`. Call `taskferry wait <id>` first (re-running it past
its 15-minute default cap for a long task — see
[cli-reference.md](cli-reference.md#taskferry-wait-id-options)), or check
`taskferry status <id>` to confirm it has actually settled.

## `unknown task id: <id>`

Either a typo, or the task belongs to a different daemon instance — most
commonly because `TASKFERRY_STATE_DIR`/`TASKFERRY_RUNTIME_DIR` differ
between the shell that dispatched it and the shell asking about it (a
smoke test's isolated daemon, a different user, a container boundary).
Run `taskferry list --all` against the same state directory the task was
dispatched under to confirm it's actually there.

## A task shows `status: "unknown"`

The daemon that owned that task's process handle restarted while it was
still `queued` or `running`. This is expected, not a bug — see
[daemon.md](daemon.md#recovery) for why taskferry deliberately doesn't try
to reattach to it. Inspect the task's log file directly, or run `opencode
session list`, to check on the underlying process by hand.

## Claude Code / Codex hook shows "taskferry is unavailable"

The hook's `command -v taskferry` check failed — the binary isn't on the
`PATH` the agent's hook subprocess runs with. From inside the taskferry
checkout, run:

```bash
taskferry setup
```

`setup` creates the `~/.local/bin/taskferry` symlink and prints the
exact `PATH` line to add if `~/.local/bin` is not yet on it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to your shell rc (or run it in the shell that starts the
agent) and confirm `taskferry --version` resolves in a fresh shell. If
the hook still reports the binary as missing, confirm the agent itself
was started with that same `PATH` — a GUI-launched app often inherits a
different `PATH` than a terminal, so the export needs to be visible to
the agent's launcher, not just the shell you ran it from. See
[integrations/claude-code.md](integrations/claude-code.md) or
[integrations/codex.md](integrations/codex.md).

## Watch stream never shows an event

Confirm `--directory` matches the exact workspace a task was dispatched
against (workspace scoping is strict `fs.realpathSync` equality, not
git-repository identity — two worktrees of the same repo are different
workspaces, even though they share history). Confirm the task hasn't
already settled before the watch subscription opened: `watch` only streams
events going forward, it does not replay history — use `taskferry list`/
`taskferry status` for anything that already happened.
