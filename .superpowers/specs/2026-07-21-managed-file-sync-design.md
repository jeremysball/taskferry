# Managed File Sync Design

## Goal

Replace `taskferry`'s two incompatible mechanisms for keeping installed files
current with the checkout — real symlinks for the CLI shim, opencode plugin,
and `tf-sl` statusline; a git-HEAD-hash-gated Claude plugin install/uninstall
dance for skill files — with one consistent mechanism: content-hash-compared
real file copies, with no symlinks and no dependency on `.git` being present.
Fixes #73 (issue title: "Manage skill and statusline files ourselves instead
of requiring manual `/plugin update taskferry`").

Also removes the Claude Code plugin integration entirely. Investigation
(2026-07-21, five independent research passes against Anthropic's current
plugin docs) confirmed plugin "monitors" deliver stdout lines as notifications
into Claude's own context, not a rendered user-facing status panel — the
mechanism was never capable of the live activity display the `monitors.json`
integration was built for, regardless of any specific bug. `tf-sl`'s
`statusLine` mechanism already replaces that need. The plugin's `SessionStart`
hook behavior (context injection) is real and worth keeping, but moves to a
direct `~/.claude/settings.json` merge instead of shipping through a plugin.

## Background

Today, `runSetup` in `setup.js` installs four things:

1. `~/.local/bin/taskferry` — symlink to the checkout's `src/cli.js`.
2. `$XDG_CONFIG_HOME/opencode/plugins/taskferry.js` — symlink to
   `src/opencode-plugin.js`.
3. `~/.local/bin/tf-sl` — symlink to `src/tf-sl.sh`.
4. The Claude Code plugin, via `claude plugin marketplace add`/`install`,
   gated by comparing `git rev-parse HEAD` against a hash stored at
   `~/.local/state/taskferry/claude-plugin-hash`; on mismatch it force-resyncs
   via `uninstall` + `install`.

(1)-(3) never go stale, since a symlink always resolves to the checkout's
current content. (4) only resyncs when a user remembers to run
`taskferry setup` again after a `git pull`, and depends on `.git` existing.
Neither approach survives a future non-git distribution (e.g. an npm install
with no checkout `.git` directory), and skill files installed into the Claude
plugin's own cache directory
(`~/.claude/plugins/cache/taskferry/taskferry/<version>/skills/...`) sit
outside `~/.claude/skills/`, which breaks opencode's own skill-discovery path
(it expects skills directly under `~/.claude/skills/<name>/`).

## Managed file sync primitive

Replace `replaceManagedSymlink(destination, source)` in `setup.js` with:

```js
function syncManagedFile(destination, source)
```

Behavior:

- Compute an md5 hash of `source`'s bytes.
- If `destination` does not exist, or is a symlink (even one that currently
  resolves to matching content — a leftover from a prior symlink-based
  install must always be converted to a real file), or its content hash
  differs from `source`'s: `mkdir -p` the destination's parent directory,
  write `source`'s bytes to `destination`, and match `source`'s executable
  bit (`chmod` if `source` is executable).
- If `destination` exists as a regular file with a matching content hash:
  no-op.
- No manifest, no stored hash, no ownership tracking — the two sides'
  content is compared directly every call, so this is safe to call
  unconditionally and repeatedly (idempotent), including from the daemon's
  best-effort background path (see below). No "refuse to replace unmanaged
  path" check: these are taskferry's own well-known install paths, so a
  simpler always-overwrite-on-mismatch primitive is preferable to
  maintaining separate ownership state.

Replaces all three current `replaceManagedSymlink` call sites in `runSetup`:
CLI shim, opencode plugin, `tf-sl`. Adds a fourth call site for the Claude
skill file (below).

## Claude Code skill file

Replace the plugin-based install with a direct copy using the same
`syncManagedFile` primitive:

```js
syncManagedFile(
  path.join(homeDirectory, ".claude", "skills", "using-taskferry", "SKILL.md"),
  path.join(checkoutDirectory, "skills", "using-taskferry", "SKILL.md"),
);
```

This uses the canonical `skills/using-taskferry/SKILL.md` directly — the same
file `scripts/generate-skill.js` already treats as canonical for the
`integrations/claude` and `integrations/codex` generated copies. No new
generation step needed.

## Claude Code SessionStart hook

Replace plugin-based hook registration with a direct, idempotent merge into
the user's `~/.claude/settings.json`:

- Read `~/.claude/settings.json` (treat a missing file as `{}`).
- Look for an existing entry in `hooks.SessionStart[].hooks[]` whose
  `command` contains the marker string `taskferry context` (this identifies
  the taskferry-managed entry regardless of exact command formatting).
- If found, replace that single hook object's `command`/`timeout`/`matcher`
  fields with the current canonical values (from the current
  `integrations/claude/hooks/hooks.json`'s command). Leave every other
  `SessionStart` entry, and every other top-level `settings.json` key,
  untouched.
- If not found, append a new entry to `hooks.SessionStart` (creating the
  array/object path as needed) with the canonical matcher (`startup|clear|compact`)
  and command.
- Write the file back only if its content actually changed (parse-compare,
  not always-write), preserving key order and formatting as much as
  `JSON.stringify(..., null, 2)` allows.

This is a find-or-insert into one array entry, not a whole-file overwrite —
it must not clobber hooks the user configured for other tools.

## Removed entirely

- `installClaude`, `checkClaudeIntegration`, `pluginInstalled`,
  `marketplaceHas`'s Claude-specific usage, and the
  `~/.local/state/taskferry/claude-plugin-hash` state file. (`marketplaceHas`
  itself stays — `registerCodex` still uses it for the unrelated Codex
  marketplace integration, which this design does not touch.)
- `integrations/claude/monitors/monitors.json` and its `.claude-plugin`
  registration. The `--format claude-monitor` output mode in `output.js`
  becomes dead code and is removed along with its CLI flag wiring.
- The Claude Code plugin itself (`.claude-plugin/plugin.json` under
  `integrations/claude/`, and the top-level marketplace listing that exposes
  it) — once skills and hooks install as real files/settings merges, there is
  nothing left for the plugin to ship.

## `doctor` integration

Extend the `doctor` command in `commands.js` to report drift on each managed
file and the hook entry, following the existing warning pattern (see the
Playwright MCP isolation checks added in PR #76 for precedent — detect, warn,
point at `taskferry setup` as the fix, never mutate from `doctor` itself):

- For each of the 4 managed files: compare installed content hash to
  canonical source hash (the same comparison `syncManagedFile` does,
  factored into a shared read-only `isManagedFileCurrent(destination,
  source)` helper so `doctor` and `setup`/the daemon share one hash-compare
  implementation).
- For the hook entry: check whether a `hooks.SessionStart` entry matching the
  `taskferry context` marker exists in `~/.claude/settings.json` and whether
  its command matches the canonical one.
- Any mismatch or missing file/entry produces a warning: `"<name> is stale or
  missing (<path>): <consequence>. Run taskferry setup to fix."`

## Daemon integration

`daemon.js` already has an idle-deferred self-restart hook (`maybeRestart`):
it detects that its own source files' mtimes changed since startup, and once
no tasks are running/queued, closes the server and respawns onto the new
code. This is exactly the "a `git pull` just landed" moment issue #73 cares
about, so the managed-file resync piggybacks on it — but that path alone only
covers a daemon that was already running when the drift happened. A daemon
that starts fresh (first launch, or a relaunch after being down — reboot, a
crash, or a manual `taskferry daemon` run after `git pull` while nothing was
running) never goes through `maybeRestart` in that process's lifetime: it
captures `startupSourceSignature` at that startup, so there is nothing for it
to ever diverge from. So there are two call sites, not one:

- **On every `startDaemon` call, once, before the server starts accepting
  requests:** call `resyncManagedFiles({ checkoutDirectory, homeDirectory, env })`
  unconditionally. This is what actually closes the "started on new code but
  never went through a live restart" gap — it runs regardless of whether this
  is the very first install or the Nth relaunch, and regardless of whether
  `maybeRestart` will ever fire during this process's life.
- **Immediately before `maybeRestart`'s existing `close()` / `spawnReplacement()`
  step**, call the same `resyncManagedFiles` again. This covers the
  long-lived-daemon case: a daemon that has been running for a while when a
  `git pull` lands underneath it resyncs at the same moment it decides to
  restart itself onto the new code, rather than waiting for a future cold
  start that may not come for days.
- Both call sites wrap the call in `try { ... } catch (error) { /* log, don't
  rethrow */ }`. A resync failure (e.g. permissions, disk full) must never
  block the daemon from starting or from restarting — the daemon coming up
  (or back up) on new code is the more critical guarantee. Log the caught
  error via the daemon's existing stderr diagnostic path so it's visible
  without being fatal.
- This makes the resync automatic and unattended in both the cold-start and
  long-lived-daemon cases, with no manual `taskferry setup` required for the
  common case. `doctor` and manual `taskferry setup` remain as the
  visibility/fallback path for anyone not running the daemon continuously, or
  who wants to confirm sync state without waiting for the daemon to start or
  restart.

## Migration

For users with an existing symlink-based install:

- `syncManagedFile`'s "destination is a symlink → always convert" rule
  (above) handles the CLI shim, opencode plugin, and `tf-sl` automatically on
  the next `setup` run or daemon-triggered resync — no separate migration
  code needed.
- One-time cleanup for the Claude plugin: if `~/.local/state/taskferry/claude-plugin-hash`
  exists, `taskferry setup` uninstalls the plugin (`claude plugin uninstall
  taskferry@taskferry --keep-data -y`, tolerating "not installed" as success)
  and removes the hash file. This runs once; on a system where the file is
  already absent, it's a no-op.

## Testing

Unit tests (in `setup.test.js`, `commands.test.js`, `daemon.test.js`) cover:

- `syncManagedFile`: creates a missing destination, overwrites on content
  mismatch, no-ops on matching content, converts an existing symlink to a
  real file even when its resolved content matches, preserves the
  executable bit.
- Skill file install: writes `~/.claude/skills/using-taskferry/SKILL.md`
  matching the canonical source.
- Hook merge: inserts into an empty/missing settings file, inserts alongside
  unrelated existing hooks without disturbing them, replaces an existing
  taskferry entry in place (matched by the `taskferry context` marker) when
  the canonical command changes, and is a no-op (no file write) when already
  current.
- One-time plugin cleanup: uninstalls and removes the hash file when present;
  no-ops when absent; tolerates "plugin already not installed."
- `doctor`: reports a warning per stale/missing managed file and per stale/
  missing hook entry; reports nothing when everything is current.
- Daemon resync: `startDaemon` calls the resync once on startup, before the
  server begins accepting requests; `maybeRestart` also calls the resync
  before respawning; a resync failure at either call site is caught and
  logged but does not prevent daemon startup or restart, respectively;
  verifies the `maybeRestart`-path resync only runs on the deferred-restart
  path (not on every request), and that the startup-path resync runs exactly
  once per `startDaemon` call regardless of whether a later restart ever
  happens.
