# Config file

taskferry reads user-tunable options from a JSON config file, in addition
to the `TASKFERRY_*` env vars it has always supported. Use the config file
for settings you want to persist across shells; use the env var for a
one-off override (e.g. in CI, or to debug a single run).

## Location

`$XDG_CONFIG_HOME/taskferry/config.json`, defaulting to
`~/.config/taskferry/config.json` when `XDG_CONFIG_HOME` is unset.

A missing file is not an error — every option falls back to its env var
(if set) or its built-in default.

## Format

A flat JSON object. Every field is optional. Unrecognized keys and
wrong-typed values are rejected at daemon startup with an `error:`/`help:`
message — there is no silent typo tolerance.

```json
{
  "maxConcurrentTasks": 8,
  "noOutputTimeoutMs": 300000,
  "summaryModel": "opencode/mimo-v2.5-free",
  "envDenylist": "PI_CODING_AGENT_DIR"
}
```

## Fields

| Config key | Env var (still works, takes precedence) | Type | Default |
|---|---|---|---|
| `maxConcurrentTasks` | `TASKFERRY_MAX_CONCURRENT_TASKS` | number | `4` |
| `maxDispatchesPerWindow` | `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` | number | `2` |
| `dispatchWindowMs` | `TASKFERRY_DISPATCH_WINDOW_MS` | number | `5000` |
| `noOutputTimeoutMs` | `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` | number | `256000` |
| `preOutputMaxMs` | `TASKFERRY_PRE_OUTPUT_MAX_MS` | number | `1024000` (4x `noOutputTimeoutMs`); see `docs/daemon.md#watchdogs` |
| `postOutputNoOutputTimeoutMs` | `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` | number | `400000` |
| `summaryModel` | `TASKFERRY_SUMMARY_MODEL` | string | `"opencode/mimo-v2.5-free"` |
| `activitySummariesEnabled` | `TASKFERRY_ACTIVITY_SUMMARIES` | boolean | `true` |
| `summarizerTimeoutMs` | `TASKFERRY_SUMMARIZER_TIMEOUT_MS` | number | `360000` |
| `activityMaxWords` | `TASKFERRY_ACTIVITY_MAX_WORDS` | number | `75` |
| `advisorSessionTtlMs` | `TASKFERRY_ADVISOR_SESSION_TTL_MS` | number | `1800000` (30 min) |
| `advisorContextChars` | `TASKFERRY_ADVISOR_CONTEXT_CHARS` | number | `120000` |
| `watchdogGraceMs` | `TASKFERRY_WATCHDOG_GRACE_MS` | number | `5000` |
| `envDenylist` | `TASKFERRY_ENV_DENYLIST` | string (comma-separated var names) | (none) |
| `sandboxEnabled` | `TASKFERRY_DISABLE_SANDBOX` (inverted: `1`/`true` disables) | boolean | `true` |
| `overlayEnabled` | `TASKFERRY_DISABLE_OVERLAY` (inverted: `1`/`true` disables) | boolean | `true` |
| `rwBind` | `TASKFERRY_RW_BIND` | string (comma-separated paths) | (none) |
| `allowedDirs` | `TASKFERRY_ALLOWED_DIRS` | string (comma-separated paths) | (none), **deprecated alias for `rwBind`** |
| `roBind` | `TASKFERRY_RO_BIND` | string (comma-separated paths) | (none) |
| `sandboxDenylist` | `TASKFERRY_SANDBOX_DENYLIST` | string (comma-separated paths) | (none) |
| `waitDefaultTimeoutMs` | `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS` | number | `900000` (15 min); `0` disables via the env var only — a config-file value of `0` is ignored and falls back to the 15-minute default |
| `cancelGraceMs` | `TASKFERRY_CANCEL_GRACE_MS` | number | `5000`; overridden per-call by `cancel --grace-ms` |
| `defaultExecutor` | `TASKFERRY_DEFAULT_EXECUTOR` | string (`opencode` or `pi`) | `pi` |
| `defaultVariant` | `TASKFERRY_DEFAULT_VARIANT` | string (`highest`, or one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) | `highest` |
| `envFile` | `TASKFERRY_ENV_FILE` | string (path to a `.env`-style file) | (none) |
| `profilingEnabled` | `TASKFERRY_PROFILING_ENABLED` | boolean | `false`; see `docs/daemon.md#request-latency-profiling` |
| `lowerdirStaggerMs` | `TASKFERRY_LOWERDIR_STAGGER_MS` | number | `3000`; `0` disables |
| `providerLimits` | `TASKFERRY_PROVIDER_LIMITS` | object (provider -> `{maxConcurrentTasks?, maxDispatchesPerWindow?}`) | `{}` (no per-provider limit; only the global ceiling applies) |

`envDenylist` uses the same comma-separated grammar as `allowedDirs` — a
flat list of env var names, always stripped from every spawned child
regardless of whether the value came from the daemon's own ambient
environment or a caller's forwarded env; see `docs/security.md`.

`allowedDirs` is a deprecated alias for `rwBind` — both bind directories
read-write inside the sandbox for every dispatch. The two are **unioned**,
not mutually exclusive: if both the new name and its deprecated alias are
set, all paths from both contribute. `rwBind` (and `allowedDirs`) also union
with the per-dispatch `--rw-bind`/`--allowed-dirs` flags and the
`TASKFERRY_RW_BIND`/`TASKFERRY_ALLOWED_DIRS` env vars rather than any one
layer replacing another. `allowedDirs` emits a deprecation warning whenever
it is used and will be removed in the next major release.

`roBind` is the read-only counterpart: host paths bound **read-only**
(`--ro-bind`) into the sandbox for every dispatch, resolved through the same
protected-mount safety check as `.taskferry.toml`'s `read_only_paths`
(a nonexistent or protected-overlapping entry is skipped and reported, never
bound). It unions across the config file, `TASKFERRY_RO_BIND`, the manager
option, and the per-dispatch `--ro-bind` flag. If a path appears in both
`rwBind` and `roBind`, read-write wins and a warning is emitted.

`sandboxDenylist` uses the same comma-separated grammar as `allowedDirs` —
extra directories tmpfs-masked inside the bwrap sandbox, merged with the
fixed default deny-list (`~/.ssh`, `~/.aws`, `~/.config/gcloud`,
`~/.config/gh`, `~/.gnupg`, `~/.claude`) rather than replacing it; see
`docs/security.md`.

`envFile` points at a `.env`-style file (`NAME=VALUE` per line, blank lines
and `#`-comment lines skipped, an optional leading `export `, values
optionally wrapped in matching single/double quotes) loaded once at daemon
startup and unioned into every spawned child's environment as the
lowest-priority layer — below the daemon's own ambient environment, which
stays below a caller's forwarded env. This exists for secrets that live
only in an interactive shell's rc file and therefore never reach a
non-interactive caller (cron, systemd, a scheduled job) dispatching
through the same daemon — see `docs/security.md`. Unlike the other string
fields above, a configured path that can't be read is a hard error at
daemon startup, not a silent fallback: a `.env`-shaped file carries secrets
a dispatch may need, so a typo'd path fails loudly rather than dispatching
without them.

The file must have no group or other permission bits (`(mode & 0o077) == 0`).
Modes such as `0400`, `0600`, and `0700` pass. `loadEnvFile()` refuses (also a
hard daemon-startup error) a file
readable by anyone other than the daemon's own user, since this file
exists specifically to hold secrets rather than ordinary settings.

`TASKFERRY_ENV_FILE=""` (explicitly set to empty) disables env-file
loading; it does not fall through to a `envFile` config-file value, same
"explicit empty overrides, doesn't fall through" semantics as an explicit
`false`/`0` would for a boolean field.

`providerLimits` scopes `maxConcurrentTasks`/`maxDispatchesPerWindow` to a
single provider — the substring of a task's `model` before its first `/`
(e.g. `"minimax/MiniMax-M3"` is provider `"minimax"`). A task must clear
both its provider's own limit (if configured) and the global
`maxConcurrentTasks`/`maxDispatchesPerWindow` ceiling to launch; a provider
absent from `providerLimits` has no limit of its own and is bound only by
the global ceiling. There is no per-provider window duration — every
provider's rate window reuses the single configured `dispatchWindowMs`.

```json
{
  "providerLimits": {
    "minimax": { "maxConcurrentTasks": 4, "maxDispatchesPerWindow": 10 },
    "ollama": { "maxConcurrentTasks": 3 }
  }
}
```

`TASKFERRY_PROVIDER_LIMITS` uses a compact grammar instead of JSON:
`provider:maxConcurrentTasks[:maxDispatchesPerWindow]`, comma-separated
(e.g. `TASKFERRY_PROVIDER_LIMITS="minimax:4:10,ollama:3"`). Setting the env
var replaces the config file's entire `providerLimits` map wholesale, the
same all-or-nothing precedence every other field uses — it is not merged
key-by-key with a config-file `providerLimits` value.
`TASKFERRY_PROVIDER_LIMITS=""` (explicitly set to empty) clears the
config-file `providerLimits` entirely — every provider becomes unlimited —
rather than being ignored; it does not fall through to a config-file
`providerLimits` value, same "explicit empty overrides, doesn't fall
through" semantics as `TASKFERRY_ENV_FILE=""` above.

## Precedence

Per field: env var (if set) > config file value (if present) > built-in
default. Setting the env var is always a full override — you don't need to
remove a config value to fall back to the old env-var-only behavior.

## What's not in the config file

`TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`, `TASKFERRY_SOCKET_PATH`,
`TASKFERRY_CACHE_DIR`, `TASKFERRY_WATCHDOG_POLL_MS`, `TASKFERRY_CHILD`, and
`TASKFERRY_AUTO_START` stay env-var-only — they're process plumbing (where
state and sandboxed-worker cache data live, how fast the watchdog polls, an
internal marker, the daemon auto-spawn escape hatch), not something most
users tune for behavior.

## No hot-reload

Daemon-side config fields (`maxConcurrentTasks`, `noOutputTimeoutMs`, and
the rest read at `createTaskManager()` construction) are read once, at
daemon startup — the same as env vars today. Changing `config.json` while
the daemon is running has no effect on those fields until the daemon
restarts. `waitDefaultTimeoutMs` is the one exception: the CLI reads it
fresh on every `wait`/`summary --wait` call, so a change takes effect
immediately without a daemon restart. There is also no `taskferry config`
CLI subcommand yet; hand-edit the file.

`envFile`'s *contents* are a second exception, with a narrower scope: the
`envFile` path itself (the config-file value or `TASKFERRY_ENV_FILE`) is
still read once at startup like every other field, but once that path is
resolved, the daemon watches the file it points at and re-applies it live
whenever it changes — a `secrets-unlock`-style decrypt-and-replace rotates
a secret into every subsequent spawn without a restart. Changing *which*
file `envFile` points at still needs a restart; changing the *contents* of
the file it already points at does not. See `docs/security.md` for the
mechanics (debounced directory watch, last-known-good on a failed reload).

## Errors

A malformed file, an unrecognized key, or a wrong-typed value throws
immediately when the daemon starts (or auto-starts on the first
`taskferry` command), with a two-line `error: ...` / `help: ...` message
naming the file. Unrecognized keys and wrong-typed values name the
offending key; malformed JSON reports the parse error instead.

## `.taskferry.toml`

A per-project TOML file at the dispatch's working-tree root that
declares the verification gate taskferry runs at settle, plus the host
paths the gate and every worker should see read-only inside the
sandbox. Distinct from the user-level `~/.config/taskferry/config.json`
documented above: this file lives in the *repo* (committed to source
control like `.eslintrc` or `pyproject.toml`), is project-supplied, and
only one taskferry command ever writes it (`taskferry init` — see
[cli-reference.md](cli-reference.md#taskferry-init)).

### Location

`<dispatch --directory>/.taskferry.toml`. A dispatch reads the file
fresh (mtime-cached) at three independent points in a task's lifecycle —
dispatch-time prompt injection, spawn-time read-only binds, settle-time
gate — so editing it does not require a daemon restart, but the change
takes effect on the next dispatch/settle in each of those three slots.

### Format

Plain [TOML](https://toml.io/) with a top-level table of the keys below.
Unrecognized keys, wrong-typed values, and invalid TOML syntax are all
"errors" rather than silent fallbacks: the loader returns an
`EMPTY_CONFIG`-shaped result with `parseError` set. When a sandboxed dispatch
reaches project-bind processing or gate startup, taskferry surfaces that
message through `projectConfigWarning` (visible on `taskferry status <id>
--full` and `taskferry result <id> --fields projectConfigWarning`) instead of
guessing a partial config. With sandboxing disabled or unavailable, those
bind and gate paths do not run, so the parse warning is not attached to the
task. Dispatch proceeds without the project gate or extra read-only binds.

```toml
check = "npm run check"
check_timeout_seconds = 900
roBind = ["/srv/reference-docs"]
```

### Fields

| Key | Type | Default | Meaning |
|---|---|---|---|
| `check` | string | absent → no gate | Shell command taskferry runs as the settle-time verification gate, and that workers are told (via a `## Verification (required)` block appended to their prompt) to run before declaring the task done. Empty / null / missing → no gate, no prompt injection. |
| `check_timeout_seconds` | positive integer | `900` | Hard cap on a single gate run. On timeout the gate is SIGTERM'd, escalated to SIGKILL after a short grace, and recorded as `checkStatus: "timeout"`, which `accept` treats as a failure unless `--force` overrides. |
| `read_only_paths` | array of strings | `[]` | Deprecated alias for `roBind`. Host paths to bind read-only into the bwrap sandbox for every dispatch from this project (and for the gate, with the same mount semantics — the worker and the gate see an identical read-only mount surface). An entry is dropped (and reported via `projectConfigWarning`) if it does not exist on the host, or if it overlaps a protected mount (`equals`, `is an ancestor of`, or `is a descendant of` any of the deny-list, `stateDir`, `runtimeDir`, or `launchDirectory`). `read_only_paths = ["/"]` is rejected by the ancestor check, not slipped through as `--ro-bind / /`. Ignored when sandboxing is off (`TASKFERRY_DISABLE_SANDBOX=1` or `--no-sandbox`). If both `roBind` and `read_only_paths` are set, the two are unioned (not replaced). Using `read_only_paths` sets a `deprecatedReadOnlyPaths` flag on the parsed config, but no caller surfaces it yet, so no deprecation warning is printed. Will be removed in the next major release. |
| `roBind` | array of strings | `[]` | The modern name for `read_only_paths` (one name per concept). Host paths to bind read-only into the bwrap sandbox for every dispatch from this project. Same mount semantics as `read_only_paths`, including the protected-mount drop + `projectConfigWarning`. |

### Precedence

There is no user-level `.taskferry.toml` and taskferry never creates one
outside `init`. The project file is the only source: an absent file is
not an error, every field falls back to its default, and the daemon has
no separate "default check command" it would substitute. If a workspace
wants a uniform check command across many projects, set it via a shell
init script that calls `taskferry init` in each project, not via a
taskferry-wide override.

### Prompt injection (always on)

When `check` is set, every dispatched worker is told about it in a
prompt block appended right before the worker runs:

```
## Verification (required)
This repo declares a check command in .taskferry.toml:
    <check command>
Run it before declaring the task done. If it fails, fix the failures and
re-run until it passes. State the final result in your summary.
```

The block is injected purely on the condition `role === "dispatch" &&
!noOverlay && projectConfig.check` (see `dispatchTask()` in
`src/tasks.js`). It is NOT skipped for non-git targets — a non-git
directory dispatched without `--no-overlay` still receives the
verification block, even though the gate itself later never actually
runs for that target (the gate requires an overlay mounted on a
git-tracked directory with `preDispatchHead` set, which a non-git
dispatch never produces; see "The check-gate lifecycle" below). So a
non-git repo can have its worker prompted to run a check that no gate
will ever verify — a rough edge worth being aware of, but not currently
disambiguated. Advisor dispatches never receive the block (the advisor
role has no gate and no changeset to gate), and explicit `--no-overlay`
dispatches do not either (no overlay, no gate).

### The check-gate lifecycle

The gate only ever fires for a `role: "dispatch"` task that produced a
real changeset over a live copy-on-write overlay mounted on a
git-tracked directory (`task.overlayDirs` set, `preDispatchHead` not
null, `changesetStatus` about to become `"pending"`). Advisor dispatches,
`--no-overlay` dispatches, and zero-change auto-accepts deliberately
skip the gate. For non-git / overlay-only targets the gate would have
side effects (test caches, build artifacts) that `applyNonGitChangeset`
would rsync onto the real directory on `accept`, so the gate is skipped
entirely and `checkStatus` stays at its default `"none"` — the CLI's
`runAccept()` stderr warning "this repo declares no check command"
still fires for these tasks today (the warning condition is purely
`accepted.applied && (checkStatus == null || checkStatus === "none")`,
without distinguishing "absent" from "ignored for a non-git target"),
so it should be read as "nothing was verified before landing," not "you
forgot to declare a check command." A future revision may split the
two paths (a separate "ignored, not absent" warning for non-git) but
today the message is the same in both cases.

`checkStatus` is the gate's state machine:

```
   none ─────► running ─────► passed
                  │  ▲         │
                  │  │         └─► (recorded; changeset is acceptable)
                  │  │
                  ▼  │
              failed
                  ▲
                  │
              timeout (after check_timeout_seconds)

   running ─► interrupted (on unclean daemon restart)
                  │
                  ▼
              (next boot: auto re-run if overlay survived; left at
               "interrupted" otherwise -- accept keeps refusing
               without --force until --force or until the overlay
               is gone and the task is rejected)
```

When a daemon restart lands mid-gate, every `checkStatus: "running"`
task with `changesetStatus: "pending"` is reclassified as
`"interrupted"`. If its overlay is still live, the gate is re-invoked
automatically (which flips `checkStatus` back to `"running"`); if the
overlay was swept away between the daemon's death and its restart, the
task is left at `"interrupted"` and `accept` keeps refusing it without
`--force`. The "interrupted" failure message renders the auto re-run
path explicitly, so a user landing on a stuck task understands why the
gate is not yet decided and what they can do about it.

The recorded fields on the task record (visible via
`taskferry status <id> --full` / `taskferry result <id> --fields ...`)
are: `checkStatus`, `checkCommand` (verbatim from the TOML), `checkExitCode`
(integer or `null` for `timeout`/`interrupted`/`spawn-error`), `checkStartedAt`/
`checkEndedAt` (ISO timestamps), `checkOutputTail` (last 40 lines of
combined stdout+stderr, capped at 256 KiB to bound the daemon's heap on
a chatty test suite), `checkOverride` (`true` when `accept --force`
overrode a blocking gate, including a running override), and
`projectConfigWarning` (parse error or `read_only_paths`/`roBind` warning,
`null` when both clear). All of these are omitted from a lean
`taskferry status <id>` (without `--full`) when their value is at the
neutral default — see `src/output.js` for the exact projection.

### Error handling summary

The exact same table that ships with the design spec — copied here
verbatim so the docs and the implementation cannot drift:

| situation | behavior |
|---|---|
| no `.taskferry.toml` / no `check` key | gate skipped, `checkStatus: none`; an accepted changeset produces the CLI's no-check warning, while lean status/result omit the neutral gate fields |
| check run exceeds timeout | killed, `checkStatus: timeout`, treated as failure |
| daemon crashes mid-gate | task settles with `checkStatus: interrupted`; gate re-runnable; never silently passed |
| `.taskferry.toml` unparseable | dispatch proceeds, gate skipped (`checkStatus: none`), and the parse error is attached as `projectConfigWarning` when sandbox bind or gate processing runs |
| `read_only_paths`/`roBind` entry doesn't exist on host | dispatch proceeds without that binding, warning surfaced in `status --full` (paths may legitimately differ between machines) |
| check command itself not found at runtime | `checkStatus: failed` with the spawn error in `checkOutputTail` |

The "doctor context" column in this table is the design's stated
contract; the per-task doctor-context aggregation is part of the doctor
fleet-health spec (out of scope here — see the design's "Non-goals"
section), so today's `projectConfigWarning` / `checkStatus` surfacing
on `taskferry status <id> --full` and `taskferry result <id> --fields
...` is the live channel for *most* of these warnings.

Note that the no-check row ("no `.taskferry.toml` / no `check` key")
is NOT covered by that surfacing: `summarizeCheckGateFields()` and
`resultCheckGateFields()` each explicitly `return {}` (omit
`checkStatus` and every other gate field) when `checkStatus == null ||
checkStatus === "none"`, so the
no-check case carries NO signal on `taskferry status` / `taskferry
result`, even with `--full`. The only place that row's "loud warning"
actually surfaces today is the one-line `stderr` message
`runAccept()` writes at accept time. The timeout / interrupted /
spawn-error rows ARE covered by `checkStatus` landing on status/result.
An unparseable `.taskferry.toml` is different again: `startCheckGate()`
sets `task.projectConfigWarning` to the parse error and returns before
ever touching `checkStatus`, which stays at its untouched `"none"`
default — so that row is covered by `projectConfigWarning`, not by
`checkStatus`, the same way a missing `read_only_paths` entry is
covered by `projectConfigWarning` alone.
