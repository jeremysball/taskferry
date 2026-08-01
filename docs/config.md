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
| `allowedDirs` | `TASKFERRY_ALLOWED_DIRS` | string (comma-separated paths) | (none) |
| `sandboxDenylist` | `TASKFERRY_SANDBOX_DENYLIST` | string (comma-separated paths) | (none) |
| `waitDefaultTimeoutMs` | `TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS` | number | `900000` (15 min); `0` disables via the env var only — a config-file value of `0` is ignored and falls back to the 15-minute default |
| `cancelGraceMs` | `TASKFERRY_CANCEL_GRACE_MS` | number | `5000`; overridden per-call by `cancel --grace-ms` |
| `defaultExecutor` | `TASKFERRY_DEFAULT_EXECUTOR` | string (`opencode` or `pi`) | `pi` |
| `envFile` | `TASKFERRY_ENV_FILE` | string (path to a `.env`-style file) | (none) |

`envDenylist` uses the same comma-separated grammar as `allowedDirs` — a
flat list of env var names, always stripped from every spawned child
regardless of whether the value came from the daemon's own ambient
environment or a caller's forwarded env; see `docs/security.md`.

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
daemon startup, not a silent fallback: a `.env`-shaped file is presumably
carrying secrets a dispatch actually needs, so a typo'd path should fail
loudly rather than quietly dispatch without them.

The file must be owner-only (`chmod 600`, no group/other read bits) —
`loadEnvFile()` refuses (also a hard daemon-startup error) a file it's
readable by anyone other than the daemon's own user, since this file
exists specifically to hold secrets rather than ordinary settings.

`TASKFERRY_ENV_FILE=""` (explicitly set to empty) disables env-file
loading; it does not fall through to a `envFile` config-file value, same
"explicit empty overrides, doesn't fall through" semantics as an explicit
`false`/`0` would for a boolean field.

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
