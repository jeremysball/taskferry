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

## Caller-env forwarding

By default, a dispatched task inherits the daemon's own process
environment, so it authenticates the same way the daemon does. On top of
that, `taskferry dispatch`, `taskferry advisor`, and `taskferry summary`
(report mode — the default) each forward the *calling* process's own
environment to the daemon over the same socket, which the daemon unions on
top of its own ambient environment before spawning — caller wins.

There are three layers, unioned low-to-high priority: `envFile` (see
below), the daemon's own ambient `process.env`, then the caller's
forwarded env. Each layer overrides the one below it key-by-key; a caller
that sets nothing for a given var falls through to the daemon's ambient
value, which in turn falls through to the env-file value, which finally
falls through to nothing (the var is simply absent from the spawned
child).

### The `envFile` gap this closes

Caller-env forwarding only helps when the *caller itself* has the secret
in its own environment. A caller launched from a minimal, non-interactive
environment — a cron job, a systemd timer, a CI runner — typically doesn't:
secrets exported in an interactive shell's rc file (`.bashrc`, `.zshrc`,
`config.fish`) are invisible to a process cron spawns, since cron never
sources that file. In that case the caller forwards a stripped-down env,
the daemon's own ambient env may be equally stripped (if the daemon itself
was started from a similarly minimal launch context), and every dispatch
fails at the worker's own auth/boot step — indistinguishable, from the
caller's side, from the credential simply being wrong.

`TASKFERRY_ENV_FILE` (or the `envFile` config field; see `docs/config.md`)
points the daemon at a `.env`-style file, loaded at startup and unioned in
as the base layer beneath its own ambient environment, so a
non-interactive caller's dispatch still authenticates correctly even
though neither the caller's own env nor the daemon's ambient env carries
the secret. It does not need to duplicate everything already in the
daemon's ambient environment — only the subset that a non-interactive
caller would otherwise be missing.

After that initial load, the daemon keeps watching the file and re-applies
it whenever it changes, so rotating a secret (e.g. re-running a
`secrets-unlock`-style decrypt-and-replace) reaches every subsequent spawn
without a daemon restart. This watches the file's *parent directory*,
filtered by filename, rather than the file itself: a decrypt-and-replace
rewrite typically goes through `mktemp`+`rename`, which swaps the file's
inode out from under a watch held on the file directly, but a directory
watch survives that. Multiple filesystem events from one rewrite are
coalesced with a short debounce. A reload that fails partway (a partial
write caught mid-rename, a permission regression, the file briefly
missing) is logged to stderr and otherwise ignored — the daemon keeps
serving whatever it last loaded successfully rather than dropping every
env-file-supplied secret because of one transient read failure. A failure
to establish the watch in the first place (as opposed to a later reload)
is likewise logged and non-fatal: the mandatory initial load has already
succeeded by that point, so the daemon still starts, it just falls back to
the old restart-required behavior for that one field.

- The file itself must be owner-only (`chmod 600`) — `loadEnvFile()` fails
  daemon startup on any file readable by group or other, the same
  fail-loud stance as a missing/malformed file (see `docs/config.md`).
- The fixed set of daemon-controlled plumbing variables below (`PATH`,
  `HOME`, and the `TASKFERRY_*` names in `TASKFERRY_PLUMBING_ENV_VARS`) is
  excluded from the env-file layer exactly the same way it's excluded from
  the caller layer — a value for `TASKFERRY_SOCKET_PATH` (for instance) set
  in the env file can never reach a spawned child, even when the daemon's
  own ambient environment happens not to have that variable set (in which
  case a naive union would otherwise let the file's value through
  unopposed).
- The daemon and every caller run as the same local user over a `0600`
  socket (see "Filesystem and socket permissions" above) — there's no
  trust boundary being crossed by a live caller handing over its own
  environment, since a caller can already read the daemon's own ambient
  env via `/proc` and run arbitrary code via dispatch prompts.
- A fixed set of daemon-controlled plumbing variables can never be
  overridden by a caller's env, regardless of what it sets: `PATH`,
  `HOME`, `TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`,
  `TASKFERRY_CACHE_DIR`, `TASKFERRY_SOCKET_PATH`, `TASKFERRY_OVERLAY_TMP_DIR`.
  These are resolved once
  at the daemon's own startup; letting a caller override any of them (most
  notably `TASKFERRY_SOCKET_PATH`) could misroute a nested `taskferry`
  call made from inside a dispatched worker.
- `TASKFERRY_ENV_DENYLIST` (or the `envDenylist` config field): a
  comma-separated list of env var names an operator wants permanently
  stripped from every spawned child, whether the value came from the
  daemon's own ambient environment or from a caller's forwarded env. This
  is the mechanism for permanently retiring a stale or unwanted variable
  (e.g. a leftover `PI_CODING_AGENT_DIR` in the daemon's own launch
  environment) without needing every caller to remember to unset it. It's
  also the mechanism for an operator who wants to block a specific caller
  env value from ever reaching a spawned child on principle — e.g.
  `LD_PRELOAD` or `LD_LIBRARY_PATH`, which aren't in the fixed excluded set
  above and would otherwise propagate from caller to child unmodified.
- No restart is needed to pick up a new key: exporting a fresh provider
  key in your own shell before running `taskferry dispatch` (or
  `advisor`/`summary`) is enough — the daemon sees it on that call, live,
  because the caller forwards its own environment on every such call.
- There is no per-call opt-out for this forwarding. A missing or invalid
  credential now surfaces as a failure from inside the spawned worker
  itself (classified by the same provider-failure-bucket parser that
  already handles `pi_authentication_failed` and similar), not as an
  upfront `dispatch` error.

```bash
export OPENCODE_GO_API_KEY="..."
taskferry dispatch --prompt "review this diff" --directory /repo
```

The exported key above is visible to `taskferry dispatch` because it's
forwarded from the calling shell's own environment on that call — no
daemon restart, no key-slot registry.

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

## Advisor auto-context

`taskferry advisor`'s `--prompt` is optional. When it is omitted (or when
it is supplied but a context source is available), advisor auto-attaches
up to 120,000 chars of caller-side text to the prompt before dispatching
the advisor role — a real, secondary call to a model provider, which can
differ from whatever model/provider the calling session itself uses. Do
not invoke advisor in an environment whose caller-side text contains
secrets you don't want sent there. Specifics:

- **Trigger sources.** Two environment variables, each independently,
  cause advisor to attach caller-side text:
  - `CLAUDE_CODE_SESSION_ID` set in the caller's own environment makes
    advisor tail the corresponding Claude Code session transcript
    (`~/.claude/projects/<slug>/<session>.jsonl`) and attach that tail.
  - `TASKFERRY_TASK_ID` set in the caller's own environment makes advisor
    tail the calling ferry's own task log (via `task.tail`) and attach
    that tail.
  When both are set, the Claude Code session transcript wins; the calling
  ferry's task log is only read when no Claude session is available.
- **Automatic, not opt-in.** There is no `--no-context` flag — the auto
  attachment happens whenever a source is available, with no per-call
  opt-out. The only ways to suppress it are to unset the relevant env
  var, or unset both, or invoke advisor in an environment with neither
  set. Passing an explicit `--prompt` does *not* suppress it either —
  the auto-attached context is prepended to whatever `--prompt` you
  supply, when a source is available.
- **Bounded.** At most 120,000 chars (`TASKFERRY_ADVISOR_CONTEXT_CHARS`
  default, in chars / code points) of the chosen tail are attached, read
  via `extractTranscriptText()` in `src/advisor-context.js` (for the Claude
  Code session path) or the `task.tail` RPC (for the calling ferry's own
  task log); an unreadable transcript
  surfaces as a `UsageError` at parse time rather than a silently empty
  context, so a misconfigured caller fails loudly instead of sending a
  prompt with no context the caller expected to be there. The budget is
  overridable via the `TASKFERRY_ADVISOR_CONTEXT_CHARS` env var or the
  `advisorContextChars` config field (`docs/config.md`); the env var wins
  over the config file.

The Claude Code session path is resolved by
`src/advisor-context.js`'s `claudeTranscriptPath()`, so a future change to how
Claude Code organizes its transcripts will be picked up there; the budget
and the priority order live next to it. `--summarize-context` on
`taskferry advisor` (off by default) is a separate, additional
condensation pass on top of this auto-attached text, dispatched through a
throwaway `task.dispatch`/`task.wait`/`task.result` against an env-
overridable model (`TASKFERRY_ADVISOR_SUMMARIZER_MODEL`,
default `opencode/mimo-v2.5-free`) — best-effort, returns the input
unchanged on any failure so condensation can never break an otherwise-
valid advisor call. See [Activity summaries](#activity-summaries) above
for the same-shape concern around the model's `summary --mode report`
child, which reads the same task log without the same auto-context
budget.

## `TASKFERRY_CHILD`

Every dispatched worker child (OpenCode or pi), and every summary child,
runs with `TASKFERRY_CHILD=1` set in its environment. The native OpenCode plugin
(`src/opencode-plugin.js`) checks this and returns an empty hook set when
present — so a task that itself runs `opencode` (directly, or indirectly
through a nested taskferry dispatch) doesn't load a second copy of the
toast/context integration inside that nested process.

**Leak into a dispatched child's own test/build invocation (#292).** Any repo
whose own tests or build steps branch on an "am I a spawned child
process"-shaped environment variable will see spurious failures under a
taskferry-dispatched run, because `TASKFERRY_CHILD=1` is ambient in that
child's whole process tree, not just the top-level worker process. taskferry's
own test suite hit exactly this: `package.json`'s `test:unit` script has to
`env -u TASKFERRY_CHILD` before its `node --test` invocation to get a clean
baseline, which is now also what makes `.taskferry.toml`'s own `check =
"npm run check"` (which runs `npm test` -> `test:unit`) safe to run as a
settle-time verification gate against this repo itself — the unset already
happens at exactly the point a dispatched gate run needs it to. If a check
command in another repo hits the same failure mode, apply the identical
`env -u TASKFERRY_CHILD` workaround around whatever invocation branches on
the variable.

## Filesystem sandboxing (bubblewrap)

Every dispatched worker child (OpenCode or pi), and every summary child,
runs wrapped in
[`bwrap`](https://github.com/containers/bubblewrap) by default on Linux:

- **Mount layout.** A full read-only bind of `/` (`--ro-bind / /`) so the
  sandboxed process can read normal system libraries, binaries, and
  OpenCode's own config without a hand-maintained whitelist, with the
  following paths overlaid as empty (`--tmpfs`) on top of that read-only
  view. **`/tmp` itself is always one of these tmpfs mounts** (`--tmpfs
  /tmp`, `src/sandbox.js`), applied before any read-write binds — a path a
  caller saved under `/tmp` for a dispatch to read (a diff file, a scratch
  input) is invisible inside the sandbox unless it's also the dispatch's
  own `directory`, `runtimeDir`, or an explicit `--rw-dirs`/`--allowed-dirs`
  entry, even
  though the file exists on the host. Hitting this looks like a plain
  missing-file error from inside the sandbox, not a sandbox-specific one,
  and a worker prompted to read a path it can't see may silently
  reconstruct an answer instead of reporting the read failure — the
  dispatch itself still settles `done`/`exitCode: 0` with no signal
  anything was wrong (taskferry#211):
  - `TASKFERRY_STATE_DIR` (every task's NDJSON logs, including other tasks'
    prompt/tool output)
  - `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`
  - `~/.claude` — not a credential, but a global instructions/context file
    (`CLAUDE.md`) with no legitimate reason to be readable by a worker;
    OpenCode reads `CLAUDE.md` the same way it reads `AGENTS.md`, so without
    this entry a worker's context (and therefore its output) silently picks
    up the caller's personal instructions
- **Read-write access** is then re-granted only for the task's own working
  directory and `TASKFERRY_RUNTIME_DIR` (needed so a nested/recursive
  dispatch from inside the sandbox can still reach the daemon socket at
  `<runtimeDir>/daemon.sock`).
- **Deny-list has a fixed base plus an optional extension.** The paths above
  are always denied; `sandboxDenylist` / `TASKFERRY_SANDBOX_DENYLIST` (see
  `docs/config.md`) adds extra directories on top, merged with — not
  replacing — the fixed base. Entries are directories only: a file mount
  point (e.g. `~/.npmrc`, `~/.netrc`, `~/.git-credentials`) needs a
  different bwrap mechanism (masking the file, not tmpfs-ing a directory)
  and isn't covered by this list yet.
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
  was narrowed. The scoped bind applies even when the resolved
  worktree-private gitdir turns out to live outside the common dir's own
  tree (a non-standard, manually re-pointed `gitdir:`/`commondir` layout) —
  that still binds only the private gitdir plus the common dir's shared
  data, never the common dir's top level. Only when the worktree-private
  gitdir genuinely can't be distinguished from the common dir at all (e.g.
  a submodule, whose "common dir" already *is* its own private gitdir with
  no sibling checkout to protect) or its resolution fails outright does the
  whole common dir still get bound, matching the original behavior.
- **`allowedDirs`** (deprecated alias for `rwDirs`) extends this same
  read-write allowance to arbitrary extra directories, for anything else a
  dispatch legitimately needs to write outside its own working directory.
  Set it as a comma-separated list of paths — as the `rwDirs`/`allowedDirs`
  config field (applies to every dispatch the daemon serves, including
  internal report-summary children) or via `--rw-dirs`/`--allowed-dirs
  <path,path,...>` on a single `taskferry dispatch` call (adds to, not
  replaces, the config default; unlike the config-level setting,
  per-dispatch `--rw-dirs`/`--allowed-dirs` does not carry over to that
  dispatch's own summary children). All three layers (flag, env var, config)
  **union** rather than replace, so a `--rw-dirs` flag adds to — never
  overrides — `TASKFERRY_RW_DIRS` and config `rwDirs`. `allowedDirs`
  (flag/env/config key) still works as a deprecated alias, emits a
  deprecation warning when used, and will be removed in the next major
  release. Entries that don't exist on disk are silently skipped, the same
  as the deny-list.
- **`roDirs`** is the read-only counterpart to `rwDirs`: extra directories
  bound **read-only** into the sandbox for a review-only worker that should
  be able to read several repos but edit none of them. Resolved through the
  same protected-mount safety check as `.taskferry.toml`'s `read_only_paths`
  — an entry that doesn't exist on the host, or that overlaps a protected
  mount (deny-list, `stateDir`, `runtimeDir`, or the launch directory), is
  skipped and reported rather than bound. `roDirs` unions across the
  per-dispatch `--ro-dirs` flag, `TASKFERRY_RO_DIRS`, config `roDirs`, and
  the manager option. If the same resolved path appears in both the
  read-write set and the read-only set, it is bound **read-write** and a
  warning is emitted naming the path (read-write wins, never an error) — so
  a `roDirs`/`read_only_paths` entry can be promoted to read-write from the
  command line.
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
- **Copy-on-write overlay.** By default, the sandboxed target directory
  (and, for a git worktree, the scoped git-common-dir slice described
  above) is mounted as a copy-on-write overlay instead of a plain
  read-write bind: all writes and deletes land in a per-task upper layer
  under `<overlayTmpRoot>/taskferry-cow-<task-id>/`, never on the real
  directory. `overlayTmpRoot` defaults to `<runtimeDir>/overlay` (e.g.
  `/run/user/<uid>/taskferry/overlay`), not `/tmp` — it was moved off
  `os.tmpdir()` so two daemons on the same host don't share an overlay
  namespace (taskferry#286); override it with `TASKFERRY_OVERLAY_TMP_DIR`.
  This requires bwrap >= 0.8 (`--overlay-src`/`--overlay`); a host below that
  floor fails the dispatch with a `crashed` task and a `spawnError`
  explaining why, the same fail-closed shape as a missing `bwrap` binary --
  unless overlay is explicitly disabled **for a dispatch role**
  (`--no-overlay` per dispatch, `overlayEnabled: false` in config, or
  `TASKFERRY_DISABLE_OVERLAY=1`), which falls back to the old plain bind
  with a printed warning that writes are no longer gated. **The advisor
  role gets no opt-out**: overlay is mandatory for advisors (ADR 0001 --
  "an advisor has no path to persist a write"), so a globally disabled
  overlay crashes an advisor dispatch with a `spawnError` instead of
  falling back, and `--no-overlay` is not accepted on `taskferry advisor`
  at all. An advisor's sandbox keeps `--share-net` like every other
  role — the worker CLI still needs outbound network to reach its model
  provider, so `--unshare-net` was tried for advisor and reverted when it
  blocked that. The advisor-specific guardrail is narrower: its `runtimeDir`
  is bound read-only instead of read-write, so the daemon's Unix socket
  (which lives there) is unreachable from inside the sandbox, without
  touching the network namespace at all.
  A worker's `git commit` inside the sandbox is never
  replayed as a commit -- only a working-tree-style diff, computed against
  the real pre-dispatch `HEAD`, survives into `accept`.
- **Diff-gated writes.** A dispatch's changeset is extracted once at
  process exit and held as `changesetStatus: "pending"` until
  `taskferry accept <id>` (applies it: `git apply` for a git target, an
  in-sandbox `rsync` for a non-git one) or `taskferry reject <id>`
  (discards it). A dispatch whose extraction finds zero changes
  auto-resolves to `accepted` immediately (a no-op needs no gate).
  `taskferry result <id> --diff` inspects the pending
  changeset read-only. An advisor-role dispatch (`taskferry advisor`)
  never gets an accept path -- its changeset is always auto-rejected right
  after extraction. Note the reboot asymmetry for non-git targets: a git
  changeset's patch is persisted under the state dir and survives a reboot,
  but a non-git `accept` needs the live overlay to rebuild its merged view,
  so a non-git changeset left pending across a reboot fails loudly and can
  only be rejected, never applied. Cleanup has the same persistence
  boundary: each overlay records the tmp root in effect at creation, so
  removal keeps working across daemon restarts even when `TMPDIR` changes,
  but records persisted before that field existed get the live
  `overlayTmpRoot` backfilled at load as a best-effort guess. A legacy
  overlay whose effective `TMPDIR` has since changed can't be recovered
  retroactively and sits until reboot.
