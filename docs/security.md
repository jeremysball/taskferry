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

Every dispatched task's stdout/stderr lands in
`<state-dir>/logs/<task-id>.ndjson`. stderr writes straight through to that
file, byte-for-byte. stdout is parsed line-by-line and normalized through
the dispatching executor (`opencode`'s or `pi`'s own `--format json` NDJSON
shape both become taskferry's canonical event shape) before being
re-serialized and written — content-equivalent, not necessarily
byte-identical to what the worker emitted; a non-JSON stdout line (e.g. a
plain-text auth failure) is preserved verbatim, unfiltered. If a prompt or
a task's own tool use touches secrets, those secrets land in that file,
readable by anyone who can read the owning user's files. There is no
redaction step. Treat the logs directory with the same care as any other
credential-adjacent local state, and see [Activity summaries](#activity-summaries) below for the one
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
- If a dispatched model's provider is the one `TASKFERRY_PROVIDER_KEY_ENV`
  targets (matched by convention, e.g. `openrouter/...` against
  `OPENROUTER_API_KEY`) and no key resolves for it — neither the ambient
  variable nor a `--key-slot` — `dispatch` fails immediately with a clear
  error instead of spawning `opencode` and getting an opaque crash deep in
  the child.
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

`taskferry watch --summaries` and `taskferry summary --mode activity` both
run a bounded snapshot of a task's recent narration through a secondary
model (`opencode/mimo-v2.5-free` by default, overridable with
`TASKFERRY_SUMMARY_MODEL`) to produce a short human-readable status line.
`taskferry summary --mode report` (the default `summary` mode) does the
same thing as a full asynchronous OpenCode subtask instead of an inline
call, but reads the log under the same bound: at most 96 KiB (head and
tail), or a smaller delta excerpt when continuing a prior summary session.

This is a real, secondary call to a model provider — do not summarize a
task whose log contains secrets you don't want sent there. Specifics:

- **Bounded.** The snapshot cache reads at most 96 KiB of the log (head and
  tail, `DEFAULT_ACTIVITY_SNAPSHOT_BYTES` in `src/activity.js`), never the
  whole file, and the resulting narration is capped at 4000 characters
  before it's sent for summarization.
- **Cached.** A snapshot is reused rather than resummarized until the log
  has grown by at least 4 KiB (`ACTIVITY_REFRESH_BYTES`) *and* at least
  `TASKFERRY_SUMMARIZER_TIMEOUT_MS` (default 360000ms) has passed since
  the last refresh for that task — bounding both the token cost and the
  request rate of watching a busy task.
- **Isolated, but not tool-denied.** The report-style summary child runs
  with `--pure` (disables plugins) against a private attachment outside the
  source workspace, and its prompt instructs the model to use only that
  attachment and ignore any instructions inside it. This is a soft,
  prompt-level constraint, not an enforced tool-permission denial — the
  child still has the same tool access (bash, read, write) as any other
  agent run in its sandbox. Stronger, enforced read-only sandboxing for
  summary children is tracked in #118.
- **Opt-in per subscription.** `taskferry watch` only requests live
  summaries when called with `--summaries`; a plain `watch` gets local,
  no-model activity text (the task's own narration, truncated and
  sanitized) instead. The daemon only pays for summary generation while at
  least one subscriber has asked for it — the last `--summaries` watcher
  disconnecting turns summary generation back off for that daemon.
- **Fully disable.** Set `TASKFERRY_ACTIVITY_SUMMARIES=0` on the daemon to
  turn off model-backed summaries everywhere, regardless of what any client
  requests; `summary --mode activity` then falls back to the same local,
  no-model activity text. `watch --summaries` does not currently honor this
  flag the same way: subscribing with `summaries: true` always runs a
  model-availability preflight check first, and that check throws if
  `TASKFERRY_SUMMARY_MODEL` isn't installed — even with summaries disabled.
  A `watch --summaries` caller on a daemon with no working summary model
  should expect that preflight to fail rather than a silent local-text
  fallback.

`TASKFERRY_SUMMARY_MODEL` selects an available replacement model if the
default is unsuitable or unavailable; `--max-words` on `taskferry summary`
bounds the target length between 75 and 300 words (default 200).

## `TASKFERRY_CHILD`

Every dispatched worker child (OpenCode or pi), and every summary child,
runs with `TASKFERRY_CHILD=1` set in its environment. The native OpenCode plugin
(`src/opencode-plugin.js`) checks this and returns an empty hook set when
present — so a task that itself runs `opencode` (directly, or indirectly
through a nested taskferry dispatch) doesn't load a second copy of the
toast/context integration inside that nested process.

## Filesystem sandboxing (bubblewrap)

Every dispatched worker child (OpenCode or pi), and every summary child,
runs wrapped in
[`bwrap`](https://github.com/containers/bubblewrap) by default on Linux:

- **Mount layout.** A full read-only bind of `/` (`--ro-bind / /`) so the
  sandboxed process can read normal system libraries, binaries, and
  OpenCode's own config without a hand-maintained whitelist, with the
  following paths overlaid as empty (`--tmpfs`) on top of that read-only
  view:
  - `TASKFERRY_STATE_DIR` (every task's NDJSON logs, including other tasks'
    prompt/tool output)
  - `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`
- **Read-write access** is then re-granted only for the task's own working
  directory and `TASKFERRY_RUNTIME_DIR` (needed so a nested/recursive
  dispatch from inside the sandbox can still reach the daemon socket at
  `<runtimeDir>/daemon.sock`).
- **Deny-list is fixed** in this version — no config override. It covers
  taskferry's own state dir plus the standard credential locations; a
  config override can be added later if a real need surfaces.
- **Git worktrees get a scoped slice of their real gitdir bound read-write
  automatically.** A worktree's `.git` is just a pointer file to its actual
  gitdir under the main checkout's `.git/worktrees/<name>` — outside the
  worktree's own directory, and therefore invisible to the read-write bind
  on that directory alone. Every dispatch resolves `git rev-parse
  --git-common-dir` against its working directory and, when the result sits
  outside that directory (i.e. this is a worktree, not the main checkout),
  binds a narrow slice of it read-write: the worktree's own private admin
  dir (`.git/worktrees/<name>` — its `HEAD`/`index`/logs) plus the pieces of
  the shared common dir a commit actually writes (`objects/`, `refs/`,
  `logs/refs/`, `packed-refs` if present) — otherwise `git commit`/`git add`
  inside the sandbox fails with a read-only filesystem error. It does
  **not** bind the common dir's own top level, which holds the *main*
  checkout's private `HEAD`/`index`/`config` — those stay part of the
  read-only root bind, so a dispatch against one worktree cannot flip the
  main checkout's branch or stage changes into its index. An earlier version
  bound the whole common dir read-write, which handed exactly that access to
  every worktree dispatch; a dispatch corrupted a completely separate main
  checkout's branch and working tree as a result (taskferry#224) before this
  was narrowed. For a layout where the resolved worktree-private gitdir
  can't be determined (e.g. a submodule, whose "common dir" already *is*
  its own private gitdir with no sibling checkout to protect), the whole
  common dir is still bound, matching the original behavior.
- **`allowedDirs`** extends this same read-write allowance to arbitrary
  extra directories, for anything else a dispatch legitimately needs to
  write outside its own working directory. Set it as a comma-separated
  list of paths — as the `allowedDirs` config field (applies to every
  dispatch the daemon serves, including internal report-summary children)
  or via `--allowed-dirs <path,path,...>` on a single `taskferry dispatch`
  call (adds to, not replaces, the config default; unlike the config-level
  setting, per-dispatch `--allowed-dirs` does not carry over to that
  dispatch's own summary children). Entries that don't exist on disk are
  silently skipped, the same as the deny-list.
- **`XDG_DATA_HOME` is redirected.** OpenCode writes its own logs, session
  database, and snapshots under `XDG_DATA_HOME` (`~/.local/share` by
  default), which is read-only inside the sandbox. Sandboxed dispatches get
  `XDG_DATA_HOME` pointed at `<cacheDir>/opencode-data` instead (`cacheDir`
  is `TASKFERRY_CACHE_DIR` or `$XDG_CACHE_HOME/taskferry`, default
  `~/.cache/taskferry`) — real disk, not the small `runtimeDir` tmpfs used
  for the daemon socket, since OpenCode's snapshot store grows unbounded
  across dispatches and previously filled that tmpfs entirely. This is a
  separate store from the host's real data home: a
  session started outside the sandbox can't be resumed inside it (or vice
  versa), and `--continue`/`--session <id>` resolve against whichever data
  home the current dispatch is using.
- **Credential visibility.** Provider credentials normally live in
  `auth.json` under the real `XDG_DATA_HOME`, so redirecting it would
  otherwise hide every stored credential from the sandboxed process. To keep
  credentialed providers working, the real `auth.json` (and only that file,
  not the rest of the real data home) is ro-bound read-only into the
  sandboxed data home when it exists on disk.
- **Fail-fast on Linux.** If sandboxing is enabled (the default) and `bwrap`
  is not installed, dispatch fails immediately with a `crashed` task and a
  matching `spawnError` — there is no silent unsandboxed fallback on the
  platform where sandboxing is expected to work.
- **macOS.** `bwrap` is Linux-only; on macOS dispatch runs exactly as it did
  before this feature, with no wrapping, no availability check, and no
  error. `taskferry doctor` surfaces this as an informational note, not a
  warning.
- **Opt out**, if you need a dispatch to see the whole filesystem (e.g. it
  legitimately needs `~/.ssh` or another denied path): pass `--no-sandbox`
  on a single `taskferry dispatch` call, or set
  `TASKFERRY_DISABLE_SANDBOX=1` (or `"true"`) on the daemon to disable
  sandboxing for every dispatch it serves. `sandboxEnabled` is also a
  `taskferry` config field, following the usual precedence (CLI flag > env
  var > config file > default).
