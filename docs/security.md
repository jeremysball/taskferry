# Security

## Filesystem and socket permissions

- State directory (`TASKFERRY_STATE_DIR`, default
  `~/.local/state/taskferry`): mode `0700`.
- Runtime directory (`TASKFERRY_RUNTIME_DIR`, default
  `<state-dir>/run`): mode `0700`.
- Daemon socket (`<runtime-dir>/daemon.sock`): mode `0600`, set immediately
  after the daemon binds it.

These restrict every file taskferry writes, including task logs and
`tasks.json`, to the owning user. Nothing here is designed for multi-user
sharing; run a separate daemon (distinct `TASKFERRY_STATE_DIR`/
`TASKFERRY_RUNTIME_DIR`) per user or per isolated environment instead of
relying on socket-level access control.

## Task logs

Every dispatched task's stdout/stderr — OpenCode's own `--format json`
NDJSON stream — is written verbatim to
`<state-dir>/logs/<task-id>.ndjson`. If a prompt or a task's own tool use
touches secrets, those secrets land in that file, readable by anyone who
can read the owning user's files. There is no redaction step. Treat the
logs directory with the same care as any other credential-adjacent local
state, and see [Activity summaries](#activity-summaries) below for the one
place log content leaves the local machine.

## Provider key slots

By default, a dispatched task inherits the daemon's own process
environment, so it authenticates the same way the daemon does. Key slots
let a single daemon dispatch some tasks under a different provider
credential without ever putting that credential in a tool call, a log, or
task state.

- `TASKFERRY_KEY_SLOTS`: a comma-separated registry mapping a slot name to
  the *source* environment variable holding that key, e.g.
  `TASKFERRY_KEY_SLOTS=primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_BACKUP`.
- `TASKFERRY_PROVIDER_KEY_ENV`: the environment variable name the
  `opencode` child actually reads for its provider key (e.g.
  `OPENCODE_GO_API_KEY`). The selected slot's source value is copied into
  *this* variable in the child's environment only — never into task state,
  logs, prompts, or CLI output.
- Pass `--key-slot <name>` to `taskferry dispatch` to pick a configured slot
  for that task. An unconfigured, unknown, or unset-source slot fails
  immediately, before anything spawns.
- `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV`: the
  separate key slot and target variable used for `taskferry summary`'s
  report-style child. A source task's own `--key-slot` never transfers to
  its summary task.
- The daemon only sees environment values present at its own startup;
  restart it after changing any of these variables (see
  [daemon.md](daemon.md#auto-start)).
- Every dispatched child's environment has every registered slot *source*
  variable stripped, whether or not that dispatch used a slot — so an
  unslotted task never accidentally inherits a backup key meant to stay
  opt-in. If `TASKFERRY_PROVIDER_KEY_ENV` happens to share a name with a
  slot's source variable (the natural setup — the ambient key and a slot
  both point at `OPENCODE_GO_API_KEY`), the ambient value is restored after
  stripping, so an unslotted dispatch still authenticates normally.

To use a backup slot, start with both source variables available in your
shell, then install the mapping into the daemon's environment before the
first command that would auto-start it:

```bash
export OPENCODE_GO_API_KEY="..."
export OPENCODE_GO_API_KEY_BACKUP="..."
export TASKFERRY_KEY_SLOTS="primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_BACKUP"
export TASKFERRY_PROVIDER_KEY_ENV="OPENCODE_GO_API_KEY"
taskferry doctor   # first command in this shell auto-starts the daemon with these set
```

Then select the slot per dispatch:

```bash
taskferry dispatch --prompt "review this diff" --directory /repo --key-slot backup
```

## Activity summaries

`taskferry watch --summaries` and `taskferry summary --style activity` both
run a bounded snapshot of a task's recent narration through a secondary
model (`opencode/hy3-free` by default, overridable with
`TASKFERRY_SUMMARY_MODEL`) to produce a short human-readable status line.
`taskferry summary --style report` (the default `summary` style) does the
same thing at larger scale: a full asynchronous OpenCode subtask that reads
more of the log.

This is a real, secondary call to a model provider — do not summarize a
task whose log contains secrets you don't want sent there. Specifics:

- **Bounded.** The snapshot cache reads at most 96 KiB of the log (head and
  tail, `DEFAULT_ACTIVITY_SNAPSHOT_BYTES` in `src/activity.js`), never the
  whole file, and the resulting narration is capped at 4000 characters
  before it's sent for summarization.
- **Cached.** A snapshot is reused rather than resummarized until the log
  has grown by at least 4 KiB (`ACTIVITY_REFRESH_BYTES`) *and* at least
  `TASKFERRY_SUMMARIZER_TIMEOUT_MS` (default 180000ms) has passed since
  the last refresh for that task — bounding both the token cost and the
  request rate of watching a busy task.
- **Isolated.** The report-style summary child uses a private attachment,
  runs outside the source workspace, disables plugins, and denies every
  agent tool — it cannot read other files or run commands, only summarize
  the snapshot it was given.
- **Opt-in per subscription.** `taskferry watch` only requests live
  summaries when called with `--summaries`; a plain `watch` gets local,
  no-model activity text (the task's own narration, truncated and
  sanitized) instead. The daemon only pays for summary generation while at
  least one subscriber has asked for it — the last `--summaries` watcher
  disconnecting turns summary generation back off for that daemon.
- **Fully disable.** Set `TASKFERRY_ACTIVITY_SUMMARIES=0` on the daemon to
  turn off model-backed summaries everywhere, regardless of what any client
  requests; `watch --summaries` and `summary --style activity` then fall
  back to the same local, no-model activity text.

`TASKFERRY_SUMMARY_MODEL` selects an available replacement model if the
default is unsuitable or unavailable; `--max-words` on `taskferry summary`
bounds the target length between 75 and 300 words (default 200).

## `TASKFERRY_CHILD`

Every dispatched OpenCode child, and every summary child, runs with
`TASKFERRY_CHILD=1` set in its environment. The native OpenCode plugin
(`src/opencode-plugin.js`) checks this and returns an empty hook set when
present — so a task that itself runs `opencode` (directly, or indirectly
through a nested taskferry dispatch) doesn't load a second copy of the
toast/context integration inside that nested process.
