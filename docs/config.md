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
  "summaryModel": "opencode/hy3-free",
  "keySlots": "primary:OPENCODE_GO_API_KEY,backup:OPENCODE_GO_API_KEY_2"
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
| `summaryModel` | `TASKFERRY_SUMMARY_MODEL` | string | `"opencode/hy3-free"` |
| `activitySummariesEnabled` | `TASKFERRY_ACTIVITY_SUMMARIES` | boolean | `true` |
| `summarizerTimeoutMs` | `TASKFERRY_SUMMARIZER_TIMEOUT_MS` | number | `180000` |
| `activityMaxWords` | `TASKFERRY_ACTIVITY_MAX_WORDS` | number | `75` |
| `advisorSessionTtlMs` | `TASKFERRY_ADVISOR_SESSION_TTL_MS` | number | `1800000` (30 min) |
| `keySlots` | `TASKFERRY_KEY_SLOTS` | string | (none) |
| `providerKeyEnv` | `TASKFERRY_PROVIDER_KEY_ENV` | string | (none) |
| `summaryKeySlot` | `TASKFERRY_SUMMARY_KEY_SLOT` | string | (none) |
| `summaryProviderKeyEnv` | `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` | string | (none) |

`keySlots` uses the same `name:ENV_VAR_NAME` comma-separated grammar as
`TASKFERRY_KEY_SLOTS` — see `docs/security.md`.

## Precedence

Per field: env var (if set) > config file value (if present) > built-in
default. Setting the env var is always a full override — you don't need to
remove a config value to fall back to the old env-var-only behavior.

## What's not in the config file

`TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`, `TASKFERRY_SOCKET_PATH`,
`TASKFERRY_WATCHDOG_POLL_MS`, and `TASKFERRY_CHILD` stay env-var-only —
they're process plumbing (where state lives, how fast the watchdog polls,
an internal marker), not something most users tune for behavior.

## No hot-reload

The config file is read once, at daemon startup — the same as env vars
today. Changing `config.json` while the daemon is running has no effect
until the daemon restarts. There is also no `taskferry config` CLI
subcommand yet; hand-edit the file.

## Errors

A malformed file, an unrecognized key, or a wrong-typed value throws
immediately when the daemon starts (or auto-starts on the first
`taskferry` command), with a two-line `error: ...` / `help: ...` message
naming the file. Unrecognized keys and wrong-typed values name the
offending key; malformed JSON reports the parse error instead.
