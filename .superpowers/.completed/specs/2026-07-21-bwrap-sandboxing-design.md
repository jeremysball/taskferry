# bwrap filesystem sandboxing for dispatched task children

## Problem

Dispatched `opencode` task children currently run with full daemon
privileges and no process-level confinement: they can read/write anywhere
the daemon's user can, including other tasks' NDJSON logs in
`TASKFERRY_STATE_DIR` (which may contain sensitive prompt/tool output) and
credential files (`~/.ssh`, `~/.aws`, cloud CLI config) that have nothing to
do with the dispatched task. `docs/security.md` already documents this gap
explicitly: nothing is sandboxed today.

## Goal

Wrap the existing opencode child-process spawn in `bwrap` (bubblewrap) to
confine its filesystem access, on Linux, by default — while keeping the
system usable (no whitelist-everything friction) and failing safely when
the sandbox can't be set up.

## Scope

- Confines dispatched opencode task children only: both the regular
  dispatch path and the summary-launch path, since they share one spawn
  call site.
- Threat model: filesystem access is the primary concern. Network access is
  secondary and explicitly deferred past v1.
- Not in scope: cross-platform sandboxing (bwrap is Linux-only), network
  namespace restriction, multi-user isolation beyond what already exists.

## Design

### Module: `src/sandbox.js` (new)

Pure-function module, no daemon/RPC dependency — the same shape as the
existing `src/mcp-isolation.js` doctor-check pattern.

```js
export function platformSupportsSandbox(platform = process.platform)
// true iff platform === "linux"

export function checkBwrapAvailable(runCommand = defaultRunCommand)
// returns { checked: true, available: boolean, reason?: string }
// uses runCommand("bwrap", ["--version"]), matching setup.js's
// defaultRunCommand pattern (spawnSync with a timeout)

export function buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList })
// returns the full argv array: ["--ro-bind", "/", "/", ...flags, "--", cmd, ...args]
```

`buildBwrapArgs` constructs:

1. `--ro-bind / /` — full read-only bind of the filesystem, so the sandboxed
   process can read normal system libraries, binaries, and opencode's own
   config without a hand-maintained whitelist.
2. `--tmpfs <path>` for each deny-list entry, layered on top of the
   read-only bind so those paths appear empty inside the sandbox:
   - `TASKFERRY_STATE_DIR` (holds every task's NDJSON logs, including other
     tasks' prompt/tool output)
   - `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gh`, `~/.gnupg`
3. `--bind <path> <path>` (read-write) for:
   - the task's own working directory (`dispatchLaunch.directory`)
   - `TASKFERRY_RUNTIME_DIR` — needed so a nested/recursive dispatch from
     inside the sandbox can still reach the daemon socket at
     `<runtimeDir>/daemon.sock`
4. Standard bwrap process/device mounts: `--proc /proc`, `--dev /dev`,
   `--tmpfs /tmp`, `--unshare-all`, `--share-net`, `--die-with-parent`.

`TASKFERRY_RUNTIME_DIR` is a subdirectory of `TASKFERRY_STATE_DIR` in the
default layout (`<stateDir>/run`); bwrap applies mount rules in argument
order, so binding it read-write after the state-dir tmpfs mount re-exposes
just the socket path without exposing the rest of the state dir.

The deny-list is a fixed default in v1 — no config-driven override. The
default set is conservative and covers the paths this design is actually
motivated by (taskferry's own state dir plus the standard credential
locations); a config override can be added later if a real need surfaces.

### Interception point: `src/tasks.js`

The only change to the spawn path itself is in `startTask()`
(`tasks.js:1243-1390`), at the existing call:

```js
const spawnEnv = isSummary ? summaryLaunch.env : dispatchEnvironment(dispatchLaunch.keyEnvValue);
child = spawnFn("opencode", args, {
  cwd: isSummary ? SUMMARY_DIR : dispatchLaunch.directory,
  stdio: ["ignore", logFd, logFd],
  detached: true,
  env: spawnEnv,
});
```

becomes (conceptually):

```js
let spawnCommand = "opencode";
let spawnArgs = args;

if (sandboxEnabled && platformSupportsSandbox()) {
  requireBwrap(); // throws if unavailable — see "bwrap availability" below
  spawnCommand = "bwrap";
  spawnArgs = buildBwrapArgs({
    directory: isSummary ? SUMMARY_DIR : dispatchLaunch.directory,
    stateDir,
    runtimeDir,
    homeDir: os.homedir(),
  }).concat(["--", "opencode", ...args]);
}

child = spawnFn(spawnCommand, spawnArgs, {
  cwd: isSummary ? SUMMARY_DIR : dispatchLaunch.directory,
  stdio: ["ignore", logFd, logFd],
  detached: true,
  env: spawnEnv,
});
```

Both the regular-dispatch and summary-launch paths flow through this one
call, so this single change covers both. No change is needed to
`dispatchEnvironment()` or `summaryEnvironment()` — the env stripping they
already do (key-slot source vars, `TASKFERRY_CHILD=1`) runs before the spawn
call and is passed straight through to `spawn()`'s `env` option; bwrap
doesn't need `--clearenv`/`--setenv` since the child's environment is fully
controlled by the `spawn()` call, not by anything namespace-related.

`createTaskManager()` gains `sandboxEnabled` (default: `true`, unless
`TASKFERRY_DISABLE_SANDBOX` is `"1"`/`"true"`) and needs `runtimeDir` in
scope for `buildBwrapArgs` — `daemon.js` already resolves and passes
`runtimeDir` into the manager, so no new plumbing is needed there.

### bwrap availability

Checked once per daemon lifetime via a cached closure, not per-dispatch:

```js
let bwrapAvailable = null;
function requireBwrap() {
  if (bwrapAvailable === false) {
    throw new Error(
      "error: bwrap is required for sandboxing but was not found\n" +
      "help: install bubblewrap (e.g. apt install bubblewrap) or opt out " +
      "with --no-sandbox or TASKFERRY_DISABLE_SANDBOX=1"
    );
  }
  if (bwrapAvailable === true) return;
  const check = checkBwrapAvailable();
  bwrapAvailable = check.available;
  if (!bwrapAvailable) requireBwrap(); // re-enter to throw with the message above
}
```

On Linux, with sandboxing on (the default), a missing `bwrap` binary fails
dispatch immediately and loudly — there is no silent unsandboxed fallback on
the platform where sandboxing is expected to work.

### Activation and opt-out

Sandboxing is on by default. Two opt-out mechanisms, both fully wired:

- **`TASKFERRY_DISABLE_SANDBOX=1`** (or `"true"`) — daemon-wide, read at
  `createTaskManager()` construction time.
- **`--no-sandbox`** — per-dispatch CLI flag, threaded end-to-end:
  `args.js` (`commandSpecs.dispatch.options`, `booleanCommands`,
  `commandAllows`, `defaultOptions`) → `commands.js`'s dispatch RPC payload
  → `daemon.js`'s `task.dispatch` handler → `tasks.js`'s `dispatch()` →
  stored on the pending launch → checked in `startTask()` alongside the
  manager-wide `sandboxEnabled` default.

`sandboxEnabled` also becomes a `taskferry` config field
(`CONFIG_FIELD_TYPES.sandboxEnabled: "boolean"`) following the existing
config precedence (CLI flag > env var > config file > default).

### Platform handling

bwrap is Linux-only. `platformSupportsSandbox()` gates every code path
above: on macOS, dispatch runs exactly as it does today (no `bwrap`
wrapping, no availability check, no error). `taskferry doctor` surfaces an
informational, non-blocking note that sandboxing isn't available on this
platform — this follows the existing Linux/macOS precedent already
established by `daemon.js`'s platform gate.

### Doctor / setup integration

New `checkBwrapAvailable()` wired into the `doctor` command's warnings list,
following the exact pattern `src/mcp-isolation.js`'s checks already use:

- Linux + bwrap missing: a warning naming the gap and the fix (install
  bubblewrap, or opt out).
- macOS: an informational note, not a warning (nothing is actionable here).

No `setup`/`ensure*()` auto-repair is added for this check — unlike the MCP
isolation checks, there's nothing safe to auto-fix (installing a system
package requires sudo/package-manager access outside taskferry's remit).

### Cancellation

No change. Verified empirically: sending `SIGTERM` to the outer `bwrap`
process (the same PID Node's `spawn()` returns as `child.pid`) kills that
process, and because it owns the pid namespace it created (`--unshare-all`
implies `--unshare-pid`), the entire sandboxed process tree is torn down
with it — regardless of whether anything inside the sandbox tried to ignore
the signal. The existing `cancel()` SIGTERM-then-SIGKILL-after-grace-period
sequence in `tasks.js` works unmodified against bwrap-wrapped children.

### Testing

No new test infrastructure needed. `src/tasks.test.js`'s existing
`makeManager({spawnFn})` / `fakeChild()` pattern already supports asserting
on the captured spawn call — tests assert `captured.cmd === "bwrap"` and
inspect the prepended bind-mount args (`--ro-bind`, `--tmpfs`, `--bind`
pairs) instead of asserting `captured.cmd === "opencode"` directly, plus a
case confirming `--no-sandbox`/`TASKFERRY_DISABLE_SANDBOX`/macOS all fall
through to the unwrapped `"opencode"` command. `src/sandbox.js`'s pure
functions (`buildBwrapArgs`, `checkBwrapAvailable`, `platformSupportsSandbox`)
get direct unit tests with an injected `runCommand`, no real `bwrap` binary
required.

### Documentation

`docs/security.md` gains a new section (after the existing
`TASKFERRY_CHILD` section) documenting: the mount layout, the deny-list, the
opt-out mechanisms, the macOS behavior, and the fail-fast-on-missing-bwrap
behavior — matching that document's existing structure and tone.

## Files touched

| Action | File | What |
|---|---|---|
| **New** | `src/sandbox.js` | `checkBwrapAvailable()`, `buildBwrapArgs()`, `platformSupportsSandbox()` |
| **New** | `src/sandbox.test.js` | Unit tests for the above, no real `bwrap` needed |
| **Modify** | `src/tasks.js` | `createTaskManager()` accepts `sandboxEnabled`; `startTask()` wraps the spawn call with bwrap when active; cached `requireBwrap()` availability check; `dispatch()`/pending-launch storage for per-task `noSandbox` |
| **Modify** | `src/tasks.test.js` | New sandboxed-spawn test cases (capture `cmd === "bwrap"`, opt-out fall-through cases) |
| **Modify** | `src/args.js` | `--no-sandbox` added to `dispatch`'s command spec, boolean flags, allow-list, defaults |
| **Modify** | `src/commands.js` | Thread `noSandbox` through the dispatch RPC payload; add bwrap-availability check to `doctor` warnings |
| **Modify** | `src/config.js` | Add `sandboxEnabled: "boolean"` to `CONFIG_FIELD_TYPES` |
| **Modify** | `docs/security.md` | New "Filesystem sandboxing (bubblewrap)" section |

## Trade-offs

- **Full `/` read-only bind + deny-list, not a whitelist.** OpenCode needs
  access to system libraries, language runtimes, git, and its own config
  across a filesystem layout that varies by environment and by what the
  dispatched prompt asks it to do. A whitelist would require enumerating
  all of that; a deny-list of known-sensitive paths is finite and testable.
- **Fixed deny-list, no config override in v1.** Keeps the module small and
  the behavior predictable. Revisit only if a real need for a
  non-default-layout credential path surfaces.
- **No `--clearenv`/`--setenv`.** bwrap's own env-clearing flags would
  require passing the entire environment through as `--setenv` args,
  duplicating what `spawn()`'s `env` option already does correctly. Safe
  because `dispatchEnvironment()`/`summaryEnvironment()` already strip
  key-slot source vars before the spawn call.
- **No network restriction in v1.** Explicitly deferred per the agreed
  threat model (filesystem primary, network secondary). `--share-net` is
  passed; a future version could add `--unshare-net` plus explicit
  allow-listed egress if needed.
- **No `setup` auto-repair for a missing `bwrap` binary.** Unlike the
  MCP-isolation checks, installing a system package isn't something
  taskferry can safely automate — `doctor` surfaces it, the user installs
  it.
