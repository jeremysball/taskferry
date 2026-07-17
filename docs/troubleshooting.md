# Troubleshooting

Start with `taskferry doctor --full`. It connects to the daemon
(auto-starting one if none is reachable) and reports:

```
healthy: true
pid: 605018
version: 2.0.0
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

`opencode` itself failed to launch — usually `opencode` isn't installed or
isn't on the `PATH` the daemon was started with. Confirm with `which
opencode` in the same shell/environment the daemon auto-started from
(remember: the daemon inherits environment from whichever command first
triggered its auto-start, not necessarily your current shell — see
[daemon.md](daemon.md#auto-start)). If you just installed `opencode`, stop
the existing daemon (it started before `opencode` was on `PATH`) and let
the next command spawn a fresh one.

## A task is stuck `crashed` with `failureReason: "no_output_timeout"`

The task produced no parseable log event within
`TASKFERRY_NO_OUTPUT_TIMEOUT_MS` (default 120000ms) and the watchdog killed
it. Read the log directly (`taskferry status <id> --full` for the
`logPath`) to see what, if anything, `opencode` wrote before being killed —
a common cause is a prompt or model that needs an interactive step
taskferry's non-interactive `opencode run --auto` invocation can't satisfy.
Raise `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` only if the task is legitimately
slow to produce its first log line, not to paper over a hung `opencode`.

## A task is stuck `crashed` with `failureReason: "provider_usage_exhausted"`

The watchdog matched a known rate-limit/quota/`429` diagnostic in the
task's log and stopped it early rather than let it burn the remaining grace
period against an exhausted key. Retry with a different `--model` or
`--key-slot` (see [security.md](security.md#provider-key-slots)) rather
than immediately retrying the same one.

## `taskferry result` says the task is still running

`result` only returns a final `message`/`narration` once a task reaches
`done` or `crashed`. Call `taskferry wait <id>` first (looping past its
45-second internal cap for a long task — see
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

## `error: key_slot "..." source variable ... is not set`

The environment variable a configured key slot points at
(`TASKFERRY_KEY_SLOTS=name:ENV_VAR`) isn't set in the daemon's own
environment. Set it, then stop the daemon (`taskferry doctor --full` for
its pid) so the next command starts a fresh one with the variable present —
see [security.md](security.md#provider-key-slots).

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
