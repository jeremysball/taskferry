# CoW Sandbox: Overlay Writes, Diff-Gated Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sandboxed taskferry ferry writes to a copy-on-write overlay instead of the real target directory; a dispatch's changes are gated behind explicit `taskferry accept`/`taskferry reject`, and an advisor's changes are always discarded.

**Architecture:** `src/sandbox.js`'s `buildBwrapArgs()` grows an `overlay` mode (`--overlay-src`/`--overlay` replacing `--bind` on the target directory, plus one overlay per git-common-dir sub-bind) and a `shareNet` toggle. A new `src/changeset.js` module owns diff extraction (one short-lived `bwrap` remount, `git diff`-based for git targets and a dual-mountpoint `diff -ru` for non-git targets), apply (`git apply` or an in-sandbox `rsync`), and cleanup (a plain `fs.rmSync()` from the daemon's own uid — verified live against the target host that overlay `upper`/`work` dirs come back owned by the invoking uid, not an unmapped namespace one, so no privileged or namespaced removal step is needed). `src/tasks.js` wires a `role` (`"dispatch"`/`"advisor"`) and `changesetStatus` onto the task record, computes the diff once at process exit, and exposes new `accept()`/`reject()` manager functions threaded through `protocol.js`/`daemon.js`/`args.js`/`commands.js` the same way every other verb (`cancel`, `result`) already is.

**Tech Stack:** Node.js (no new runtime dependencies), `bwrap`/bubblewrap ≥ 0.8, `git`, `rsync` (non-git apply only), Node's built-in `node:test` + `node:assert/strict`.

## Review findings (2026-07-30): all 14 resolved, implementation complete

> **Status as of 2026-07-31: done.** Every task in this plan is implemented on
> `worktree-cow-sandbox`, and all 14 accepted findings below are fixed. Each fix was
> re-verified against the actual code on 2026-07-31, not just against this plan's own
> resolution list. Gates on that branch: 729 unit tests passing, 3 real-`bwrap` 0.11.2
> integration tests passing, `typecheck` exit 0, `eslint` 0 errors. Findings #7 and #10
> are closed as documented limitations rather than code fixes; see the Resolutions block
> below and `docs/security.md`. Nothing here is outstanding work. Read this section as
> history explaining why the code looks the way it does.

An independent review (`minimax/MiniMax-M3` via taskferry, task `oc_ms6ybuxr_bc880930`) plus manual verification against this plan's actual code/text found the design not ready to implement **as originally written**. Verified findings below; two of the reviewer's original claims were checked and disproven (noted at the end), so don't reintroduce fixes for those.

**Critical, architecture-level (these blocked continuing past Tasks 1-6 at the time; all now resolved):**

1. **Git-common-dir sub-overlays are lost at extraction.** Task 9's spawn path creates a separate overlay per git-common-dir slice (`overlayRwBinds`), but Task 10's `extractChangesetForTask()` hardcodes `overlayRwBinds: []` with a comment claiming they're "already merged into the main worker run" — they aren't persisted onto the task anywhere, so a worktree's `.git` metadata writes are invisible to the extracted diff.
2. **Extraction silently swallows failures.** `extractGitDiff()`/`extractNonGitDiff()` never check `result.status`/`result.error` from the `bwrap` subprocess — they write whatever `stdout` came back and derive `hasChanges` from it alone. A crashed extraction (bad mount, timeout, `bwrap` failure) is indistinguishable from "no changes."
3. **Empty changesets stay `pending` forever.** `extractChangesetForTask()`'s dispatch-role branch sets `changesetStatus = "pending"` unconditionally, ignoring the `hasChanges` the extraction functions already compute. A no-op dispatch requires a manual `reject` (whose `git apply` on an empty patch will itself normally fail) to ever leave `pending`.
4. **Wrong timeout in production due to a name collision.** Task 10 imports `defaultRunCommand` from `sandbox.js` (5s timeout, meant for a version probe) instead of `changeset.js`'s own unexported 30s version (meant for real diff/apply work) — extraction, apply, accept, and reject all run on the 5s timeout in production.
5. **`--no-overlay` on advisors contradicts the ADR's core guarantee.** This traces back to the spec itself (spec line 118-124), not just the plan: `--no-overlay` falls back to a plain writable `--bind` for *any* role including advisor, directly contradicting ADR 0001's "an advisor has no path to persist a write." Either advisors shouldn't accept `--no-overlay`, or the guarantee needs to be stated as conditional.
6. **Advisor network isolation doesn't cover the daemon's own socket.** `runtimeDir` (which holds the daemon's Unix socket, `src/daemon.js:97-119`) is `--bind`-mounted into every sandboxed spawn, advisor included — `--unshare-net` doesn't block Unix-domain-socket access to a bind-mounted path, so an advisor (full bash toolset per the ADR) may retain a path back into the daemon.
7. **Non-git accept can't survive a reboot.** `overlayTmpRoot` defaults to `os.tmpdir()` (typically a tmpfs, cleared on reboot). Non-git `accept()` needs the live overlay to rebuild its merged view for `rsync`; after a reboot a non-git pending changeset becomes unapplyable with no recovery path described.
8. **Cancelled tasks never get their changeset extracted.** The exit handler only calls `extractChangesetForTask()` for `status === "done" || "crashed"`; `"cancelled"` is a distinct real status (`src/tasks.js:1892,1993`) that's excluded, contradicting the spec's "at process exit, for every task dispatched with an active overlay."

**High, real but narrower (all now resolved):**

9. `rsync -a --delete` (non-git apply) is not transactional; a mid-apply failure can partially mutate the real target with no rollback.
10. `git add -A && git diff --cached <head>` misses gitignored-but-untracked worker writes, doesn't handle an unborn-HEAD target, and diffs against whatever the lower currently is — concurrent external edits to the lower during a dispatch can get folded into the cached patch and misattributed to the worker.
11. `accept()`/`reject()` set the terminal `changesetStatus` before checking whether `cleanupOverlay()` actually succeeded; a failed cleanup leaves a resolved task with its overlay still on disk and no distinct "cleanup pending" state.
12. `cleanupOverlay()` and the temp-dir creation path (`fs.mkdirSync(..., {recursive:true})`) don't validate that a persisted `overlayDirs.root` actually lives under `overlayTmpRoot` before a forced recursive removal, and don't use an atomic/exclusive create — both require an attacker already at the daemon's own uid to exploit, but are gaps worth closing given this feature is explicitly security-motivated.
13. Spec requires `diffStat` (files changed, +/- counts) on `result --full`; Task 11's `result()`/`summarize()` never implements it.
14. No end-to-end test anywhere in the plan exercises a real `bwrap` overlay — every test mocks `runCommand`/`spawnFn`. The ADR's one manual verification run isn't a substitute for a Linux-gated integration suite given this feature's whole purpose is filesystem containment.

**Disproven — do not act on these if seen elsewhere:**

- ~~"`--tmpfs /tmp` (emitted before `--overlay-src`/`--overlay` in `buildBwrapArgs()`) hides the overlay upper/work dirs from bwrap."~~ Reproduced the exact arg sequence with real `bwrap 0.11.2`: reads/writes through the overlay correctly. `bwrap` resolves bind/overlay sources against the host before building the sandbox's mount tree; the `--tmpfs /tmp` ordering is irrelevant.
- ~~"`accept()`/`reject()` are not concurrency-safe — two concurrent RPC calls can race."~~ Both are fully synchronous (including `persistTask()`) with no `await` in their bodies; Node's single-threaded execution model means one call runs to completion before another can start. The real (much narrower) issue is finding #7's crash-window, not a live-request race.

### Resolutions (2026-07-30 revision — every accepted finding folded into the plan text below)

- **#1** → Task 9 persists `rwBinds` onto `task.overlayDirs`; Task 10's extraction re-mounts them (plus a Task 19 real-worktree regression test and a mocked-args test in Task 10).
- **#2** → Task 6 fix round: `extractGitDiff()`/`extractNonGitDiff()` throw on failure (both functions, Task 5's deferred Minor reopened); Task 10's exit handler catches, records `changesetError`, stays `pending`, and never cleans up on that path.
- **#3** → Task 10: a zero-change extraction auto-resolves to `accepted` with immediate cleanup; spec §5.2 updated.
- **#4** → Task 10's Step 3a exports `changeset.js`'s own 30s `defaultRunCommand` and `runOverlayCommandFn` defaults to it (aliased import), not `sandbox.js`'s 5s probe runner.
- **#5** → overlay is mandatory for the advisor role: Task 9's spawn path throws (→ crashed + spawnError) for an advisor without overlay (covers global disable); Task 15 removes the `--no-overlay` surface from advisor at the CLI/protocol layers; spec §1.2/§6 updated; ADR 0001's guarantee stands as written and is now enforced.
- **#6** → `buildBwrapArgs()` gains `runtimeDirWritable` (Task 9's Step 3a prerequisite in `sandbox.js`); advisor spawns get `--ro-bind runtimeDir`, blocking `connect()` on `daemon.sock`; spec §6 updated.
- **#7** → Task 11's `accept()` errors loudly for a non-git target whose overlay is gone (reboot); spec §5.4 documents the git/non-git reboot asymmetry; Task 17's security docs cover it.
- **#8** → Task 10's exit-handler gate includes `"cancelled"`.
- **#9** → Task 7's apply script uses `rsync -a --delete --delay-updates`; spec §5.4 and the out-of-scope note document the remaining (narrower) non-transactionality plus the preserved-overlay retry path.
- **#10** → unborn-HEAD handling folded into the Task 6 fix round (`resolvePreDispatchHead()` → empty-tree anchor); gitignored-write exclusion and the extraction-window race documented as known costs in spec §4.
- **#11** → Task 11's `accept()`/`reject()` return `cleanupFailed: true` on a failed removal (overlayDirs stays set); Task 15's CLI cases print a warning; Task 12's sweep already retries resolved-task leftovers.
- **#12** → Task 7's `cleanupOverlay()` takes `tmpRoot` and refuses any root that isn't a `taskferry-cow-*` tree under it (all callers updated); Task 9 creates the overlay root with an exclusive non-recursive mkdir.
- **#13** → Task 11's `result()` computes `diffStat` via `computeDiffStat()`; Task 13 adds `diffStat` (and `changesetError`) to `RESULT_FIELDS`.
- **#14** → new Task 19: Linux-gated real-`bwrap` integration suite (git round trip, worktree sub-overlay regression, non-git round trip), wired into `package.json`'s hardcoded `test:unit` list; spec §10 updated.

## Global Constraints

- bwrap ≥ 0.8 required for overlay support (raises the existing "any version" floor). No new unprivileged-userns dependency — `--unshare-all` already required it.
- `/tmp/taskferry-cow-<task-id>/...` is hardcoded, not config-surfaced (matches the existing fixed-deny-list precedent — no config knob until a real need surfaces).
- Every new config key follows the exact precedence chain already used by `sandboxEnabled`: CLI flag (where one exists) > env var > config file > built-in default.
- Fail closed, never silently downgrade: an unsupported host with `overlayEnabled: true` (the default) must produce a `crashed` task with a `spawnError`, the same shape as today's missing-`bwrap` failure — never an unguarded plain bind.
- No placeholder code, no TBD comments, no privileged (root/setuid) operations anywhere in this plan — cleanup is a plain `fs.rmSync()` from the daemon's own uid (verified live on the target host that overlay `upper`/`work` dirs are owned by the invoking uid, not an unmapped namespace one — no `bwrap`/`sudo` wrapper needed or used for cleanup).
- This plan does **not** create git worktrees, does not change `--allowed-dirs` semantics, and does not touch the pi executor's missing-command-input audit gap (tracked as its own follow-up issue, out of scope here).
- Spec: `.superpowers/specs/2026-07-29-cow-sandbox-design.md`. ADR: `docs/adr/0001-cow-overlays-and-diff-gated-writes.md`. Read both before starting — every locked decision in the ADR's "do not re-litigate" list stands; this plan only fills in mechanism.

---

## File Structure

| File | Change |
|---|---|
| `src/sandbox.js` | Extend: `checkBwrapAvailable()` returns raw stdout; new `parseBwrapVersion()`, `checkOverlaySupport()`; `buildBwrapArgs()` gains `overlay`, `overlayRwBinds`, `shareNet`. |
| `src/sandbox.test.js` | Extend with tests for all of the above. |
| `src/config.js` | Add `overlayEnabled` to `CONFIG_FIELD_TYPES`. |
| `src/config.test.js` | Extend with `overlayEnabled` validation tests. |
| `src/changeset.js` | **New.** Overlay path helpers, diff extraction (git + non-git), apply, cleanup. |
| `src/changeset.test.js` | **New.** |
| `src/tasks.js` | Extend `dispatch()` (role/noOverlay params, new task fields, `preDispatchHead`), the spawn path (overlay construction, git-common-dir overlay conversion, `shareNet`), the exit handler (diff extraction hook), `advisor()` (role), `summarize()`/`result()` (new fields), new `accept()`/`reject()`. |
| `src/tasks.test.js` | Extend. |
| `src/protocol.js` | Add `task.accept`/`task.reject` to `RPC_METHODS` + `validParams`; add `"diff"` to `RESULT_FIELDS`. |
| `src/protocol.test.js` | Extend. |
| `src/daemon.js` | Add `task.accept`/`task.reject` cases to `invoke()`. |
| `src/daemon.test.js` | Extend. |
| `src/args.js` | `--no-overlay` (**dispatch only** — rejected on `advisor`; overlay is mandatory for the advisor role, review finding #5), `--diff` (result), `accept`/`reject` command specs and parsing. |
| `src/args.test.js` | Extend. |
| `src/commands.js` | `case "accept"`/`case "reject"`; `result` `--diff` wiring; `dispatch`/`advisor` `noOverlay` wiring. |
| `src/commands.test.js` | Extend. |
| `src/output.js` | `leanStatus()` surfaces a pending `changesetStatus` even without `--full`. |
| `src/output.test.js` | Extend. |
| `docs/security.md`, `docs/config.md`, `docs/cli-reference.md`, `docs/sourcemap.md` | Document the new mechanism, config key, and CLI surface. |
| `integrations/claude/skills/using-taskferry/SKILL.md` | Add the worktree-or-checkout question; rewrite "Verifying A Worker's Claimed Commit". |

Not touched by this plan (spec §8, external to this repo): `/home/jeremy/.claude-qwen/skills/using-git-worktrees-addendum/SKILL.md`'s shared-checkout-race framing.

---

## Task 1: `sandbox.js` — bwrap version probe and overlay capability check

**Files:**
- Modify: `src/sandbox.js:17-42` (`defaultRunCommand`, `checkBwrapAvailable`)
- Test: `src/sandbox.test.js`

**Interfaces:**
- Produces: `parseBwrapVersion(stdout: string): [number, number, number] | null`
- Produces: `checkOverlaySupport(runCommand?: RunCommandFn): { supported: boolean, reason?: string }`
- Modifies: `checkBwrapAvailable()`'s return shape gains `raw: string` (the probe's raw stdout) alongside the existing `checked`/`available`/`reason` fields.

- [ ] **Step 1: Write the failing tests**

```js
// src/sandbox.test.js -- add after the existing checkBwrapAvailable() describe block
describe("checkBwrapAvailable() raw stdout", () => {
  test("includes the raw probe stdout when available", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined });
    const result = checkBwrapAvailable(runCommand);
    assert.equal(result.raw, "bubblewrap 0.11.2\n");
  });
});

describe("parseBwrapVersion()", () => {
  test("parses a standard version string", () => {
    assert.deepEqual(parseBwrapVersion("bubblewrap 0.11.2\n"), [0, 11, 2]);
  });

  test("returns null for unparseable output", () => {
    assert.equal(parseBwrapVersion("not a version"), null);
  });
});

describe("checkOverlaySupport()", () => {
  test("supports bwrap 0.8.0 exactly", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.8.0\n", stderr: "", error: undefined });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("supports a version newer than 0.8", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: undefined });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("supports a future major version", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 1.0.0\n", stderr: "", error: undefined });
    assert.deepEqual(checkOverlaySupport(runCommand), { supported: true });
  });

  test("rejects a version below 0.8", () => {
    const runCommand = () => ({ status: 0, stdout: "bubblewrap 0.7.1\n", stderr: "", error: undefined });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /0\.7\.1 < 0\.8/);
  });

  test("reports unsupported when bwrap itself is unavailable", () => {
    const runCommand = () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /bwrap not found/);
  });

  test("reports unsupported when the version string can't be parsed", () => {
    const runCommand = () => ({ status: 0, stdout: "unexpected output\n", stderr: "", error: undefined });
    const result = checkOverlaySupport(runCommand);
    assert.equal(result.supported, false);
    assert.match(result.reason, /could not parse/);
  });
});
```

Update the top import line to include the new exports:

```js
import { buildBwrapArgs, checkBwrapAvailable, checkOverlaySupport, defaultDenyList, parseBwrapVersion, platformSupportsSandbox, resolveGitCommonDir, resolveGitDir } from "./sandbox.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/sandbox.test.js`
Expected: FAIL — `parseBwrapVersion`/`checkOverlaySupport` are not exported, `raw` is `undefined`.

- [ ] **Step 3: Implement**

```js
// src/sandbox.js -- replace defaultRunCommand's two return statements to include raw stdout
export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  if (result.error) {
    return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}
```

(no change needed here — `defaultRunCommand` already returns `stdout`; the change is in `checkBwrapAvailable` below, which currently discards it)

```js
// src/sandbox.js -- replace checkBwrapAvailable()
export function checkBwrapAvailable(runCommand = defaultRunCommand) {
  const result = runCommand("bwrap", ["--version"]);
  if (result.error) {
    return {
      checked: true,
      available: false,
      reason: result.error.code === "ENOENT" ? "bwrap not found" : `bwrap --version failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { checked: true, available: false, reason: `bwrap --version exited with status ${result.status}` };
  }
  return { checked: true, available: true, raw: result.stdout };
}

/**
 * Parses `bubblewrap X.Y.Z` (bwrap's own `--version` output) into a
 * [major, minor, patch] tuple, or null if the string doesn't match.
 * @param {string} stdout
 * @returns {[number, number, number]|null}
 */
export function parseBwrapVersion(stdout) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Overlay support (`--overlay-src`/`--overlay`) requires bwrap >= 0.8. No
 * separate unprivileged-userns probe is needed: buildBwrapArgs() already
 * emits --unshare-all, which every existing sandboxed dispatch already
 * requires -- overlay only raises the version floor, it adds no new
 * namespace dependency.
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [runCommand]
 * @returns {{supported: boolean, reason?: string}}
 */
export function checkOverlaySupport(runCommand = defaultRunCommand) {
  const probe = checkBwrapAvailable(runCommand);
  if (!probe.available) return { supported: false, reason: probe.reason };
  const version = parseBwrapVersion(probe.raw ?? "");
  if (!version) return { supported: false, reason: "could not parse bwrap version" };
  const [major, minor] = version;
  if (major > 0 || (major === 0 && minor >= 8)) return { supported: true };
  return { supported: false, reason: `bwrap ${version.join(".")} < 0.8 required for --overlay` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/sandbox.test.js`
Expected: PASS, including every pre-existing test in the file (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.js src/sandbox.test.js
git commit -m "feat(sandbox): add checkOverlaySupport() and bwrap version parsing"
```

---

## Task 2: `sandbox.js` — `buildBwrapArgs()` overlay and shareNet support

**Files:**
- Modify: `src/sandbox.js:142-175` (`buildBwrapArgs`)
- Test: `src/sandbox.test.js`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `buildBwrapArgs({ ..., overlay?: {upperDir, workDir}, overlayRwBinds?: Array<{path, upperDir, workDir}>, shareNet?: boolean })` — every new param optional, defaults preserve today's plain-bind, `--share-net` behavior for every existing caller.

- [ ] **Step 1: Write the failing tests**

```js
// src/sandbox.test.js -- add inside describe("buildBwrapArgs()"), after the existing tests
test("mounts an overlay on the target directory instead of a plain bind when overlay is given", () => {
  const args = buildBwrapArgs({
    directory: "/workspace/my-repo",
    stateDir: "/home/user/.local/state/taskferry",
    runtimeDir: "/home/user/.local/state/taskferry/run",
    homeDir: "/home/user",
    overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
  });
  const overlayIndex = args.indexOf("--overlay-src");
  assert.notEqual(overlayIndex, -1);
  assert.deepEqual(args.slice(overlayIndex, overlayIndex + 6), [
    "--overlay-src", "/workspace/my-repo",
    "--overlay", "/tmp/taskferry-cow-t1/upper/main", "/tmp/taskferry-cow-t1/work/main", "/workspace/my-repo",
  ]);
  assert.equal(args.includes("--bind"), false, "no plain --bind for the target directory when overlay is active");
});

test("keeps the plain --bind on the target directory when overlay is omitted", () => {
  const args = buildBwrapArgs({
    directory: "/workspace/my-repo",
    stateDir: "/home/user/.local/state/taskferry",
    runtimeDir: "/home/user/.local/state/taskferry/run",
    homeDir: "/home/user",
  });
  assert.equal(args.includes("--overlay-src"), false);
  const bindIndex = args.indexOf("--bind");
  assert.equal(args[bindIndex + 1], "/workspace/my-repo");
});

test("mounts each overlayRwBinds entry as its own overlay, after extraRwBinds and before extraRwPairBinds", () => {
  const args = buildBwrapArgs({
    directory: "/workspace/my-repo",
    stateDir: "/home/user/.local/state/taskferry",
    runtimeDir: "/home/user/.local/state/taskferry/run",
    homeDir: "/home/user",
    extraRwBinds: ["/home/user/.cache/taskferry/opencode-data"],
    overlayRwBinds: [
      { path: "/workspace/main-repo/.git/worktrees/my-repo", upperDir: "/tmp/taskferry-cow-t1/upper/extra/a", workDir: "/tmp/taskferry-cow-t1/work/extra/a" },
    ],
  });
  const extraRwBindIndex = args.indexOf("/home/user/.cache/taskferry/opencode-data");
  const overlayRwIndex = args.indexOf("--overlay-src", extraRwBindIndex);
  assert.notEqual(overlayRwIndex, -1);
  assert.deepEqual(args.slice(overlayRwIndex, overlayRwIndex + 6), [
    "--overlay-src", "/workspace/main-repo/.git/worktrees/my-repo",
    "--overlay", "/tmp/taskferry-cow-t1/upper/extra/a", "/tmp/taskferry-cow-t1/work/extra/a", "/workspace/main-repo/.git/worktrees/my-repo",
  ]);
});

test("emits --share-net by default and --unshare-net when shareNet is false", () => {
  const withNet = buildBwrapArgs({ directory: "/workspace/my-repo", stateDir: "/state", runtimeDir: "/state/run", homeDir: "/home/user" });
  assert.deepEqual(withNet.slice(-3), ["--unshare-all", "--share-net", "--die-with-parent"]);

  const withoutNet = buildBwrapArgs({ directory: "/workspace/my-repo", stateDir: "/state", runtimeDir: "/state/run", homeDir: "/home/user", shareNet: false });
  assert.deepEqual(withoutNet.slice(-3), ["--unshare-all", "--unshare-net", "--die-with-parent"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/sandbox.test.js`
Expected: FAIL — `buildBwrapArgs()` still always emits `--bind directory directory` and always `--share-net`.

- [ ] **Step 3: Implement**

```js
// src/sandbox.js -- replace the buildBwrapArgs() JSDoc + signature + body
/**
 * @param {object} options
 * @param {string} options.directory
 * @param {string} options.stateDir
 * @param {string} options.runtimeDir
 * @param {string} options.homeDir
 * @param {string[]} [options.denyList]
 * @param {string[]} [options.extraRwBinds]
 * @param {[string, string][]} [options.extraRwPairBinds]
 * @param {[string, string][]} [options.extraRoBinds]
 * @param {{upperDir: string, workDir: string}} [options.overlay] - when given, `directory` is mounted as a
 *   copy-on-write overlay (`--overlay-src <directory> --overlay <upperDir> <workDir> <directory>`) instead of
 *   a plain read-write bind; all writes/deletes land in upperDir, `directory` itself is never mutated.
 * @param {Array<{path: string, upperDir: string, workDir: string}>} [options.overlayRwBinds] - extra paths
 *   (e.g. a worktree's git-common-dir slice) that need the same CoW treatment instead of a plain writable
 *   bind, one independent overlay mount per entry. Applied after extraRwBinds and before extraRwPairBinds.
 * @param {boolean} [options.shareNet] - default true (matches today's --share-net); pass false for
 *   advisor-role dispatches to emit --unshare-net instead.
 * @returns {string[]}
 */
export function buildBwrapArgs({
  directory,
  stateDir,
  runtimeDir,
  homeDir,
  denyList = defaultDenyList(homeDir, stateDir),
  extraRwBinds = [],
  extraRwPairBinds = [],
  extraRoBinds = [],
  overlay,
  overlayRwBinds = [],
  shareNet = true,
}) {
  const args = ["--ro-bind", "/", "/"];
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const denied of denyList) {
    args.push("--tmpfs", denied);
  }
  if (overlay) {
    args.push("--overlay-src", directory, "--overlay", overlay.upperDir, overlay.workDir, directory);
  } else {
    args.push("--bind", directory, directory);
  }
  args.push("--bind", runtimeDir, runtimeDir);
  for (const extra of extraRwBinds) {
    args.push("--bind", extra, extra);
  }
  for (const { path: overlayPath, upperDir, workDir } of overlayRwBinds) {
    args.push("--overlay-src", overlayPath, "--overlay", upperDir, workDir, overlayPath);
  }
  for (const [src, dest] of extraRwPairBinds) {
    args.push("--bind", src, dest);
  }
  for (const [src, dest] of extraRoBinds) {
    args.push("--ro-bind", src, dest);
  }
  args.push("--unshare-all", shareNet ? "--share-net" : "--unshare-net", "--die-with-parent");
  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/sandbox.test.js`
Expected: PASS, all tests including the pre-existing `extraRwBinds`/`extraRwPairBinds`/`extraRoBinds` ordering tests (unchanged behavior when `overlay`/`overlayRwBinds`/`shareNet` are omitted).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.js src/sandbox.test.js
git commit -m "feat(sandbox): add overlay and shareNet options to buildBwrapArgs()"
```

---

## Task 3: `config.js` — `overlayEnabled` field

**Files:**
- Modify: `src/config.js:7-28` (`CONFIG_FIELD_TYPES`)
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `overlayEnabled: "boolean"` recognized in `loadConfig()`.

- [ ] **Step 1: Write the failing tests**

```js
// src/config.test.js -- add near the existing sandboxEnabled tests
test("accepts a valid overlayEnabled value", () => {
  const dir = fs.mkdtempSync(...); // match this file's existing temp-dir helper exactly
  const configPath = writeConfig(dir, JSON.stringify({ overlayEnabled: false }));
  assert.deepEqual(loadConfig({ configPath }), { overlayEnabled: false });
});

test("rejects a wrong-typed overlayEnabled value", () => {
  const dir = fs.mkdtempSync(...);
  const configPath = writeConfig(dir, JSON.stringify({ overlayEnabled: "false" }));
  assert.throws(() => loadConfig({ configPath }), /error: config key "overlayEnabled".*must be a boolean.*\nhelp:/s);
});
```

(Match the exact `fs.mkdtempSync(...)` call and `writeConfig()` helper already used by the neighboring `sandboxEnabled` tests in this file — copy their precise form rather than inventing a new helper.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/config.test.js`
Expected: FAIL — `error: unrecognized config key "overlayEnabled"`.

- [ ] **Step 3: Implement**

```js
// src/config.js -- add one line inside CONFIG_FIELD_TYPES, next to sandboxEnabled
const CONFIG_FIELD_TYPES = {
  // ...existing fields...
  sandboxEnabled: "boolean",
  overlayEnabled: "boolean",
  allowedDirs: "string",
  // ...existing fields...
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): add overlayEnabled config field"
```

---

## Task 4: `changeset.js` — overlay path helpers

**Files:**
- Create: `src/changeset.js`
- Test: `src/changeset.test.js`

**Interfaces:**
- Produces: `overlayPaths(taskId: string, tmpRoot: string): { root, upperDir, workDir }`
- Produces: `subOverlaySlug(targetPath: string): string`
- Produces: `subOverlayPaths(root: string, targetPath: string): { path, upperDir, workDir }`

- [ ] **Step 1: Write the failing tests**

```js
// src/changeset.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { overlayPaths, subOverlayPaths, subOverlaySlug } from "./changeset.js";

describe("overlayPaths()", () => {
  test("builds a per-task root plus a main upper/work pair under it", () => {
    const paths = overlayPaths("oc_abc123", "/tmp");
    assert.equal(paths.root, "/tmp/taskferry-cow-oc_abc123");
    assert.equal(paths.upperDir, "/tmp/taskferry-cow-oc_abc123/upper/main");
    assert.equal(paths.workDir, "/tmp/taskferry-cow-oc_abc123/work/main");
  });
});

describe("subOverlaySlug()", () => {
  test("combines the basename with a stable short hash of the full path", () => {
    const slugA = subOverlaySlug("/workspace/main-repo/.git/worktrees/my-repo");
    const slugB = subOverlaySlug("/workspace/main-repo/.git/worktrees/my-repo");
    assert.equal(slugA, slugB);
    assert.match(slugA, /^my-repo-[0-9a-f]{8}$/);
  });

  test("produces distinct slugs for two different paths with the same basename", () => {
    const slugA = subOverlaySlug("/workspace/repo-a/.git/worktrees/shared-name");
    const slugB = subOverlaySlug("/workspace/repo-b/.git/worktrees/shared-name");
    assert.notEqual(slugA, slugB);
  });
});

describe("subOverlayPaths()", () => {
  test("nests upper/work under root/{upper,work}/extra/<slug>", () => {
    const root = "/tmp/taskferry-cow-oc_abc123";
    const targetPath = "/workspace/main-repo/.git/worktrees/my-repo";
    const result = subOverlayPaths(root, targetPath);
    const slug = subOverlaySlug(targetPath);
    assert.equal(result.path, targetPath);
    assert.equal(result.upperDir, path.join(root, "upper", "extra", slug));
    assert.equal(result.workDir, path.join(root, "work", "extra", slug));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/changeset.test.js`
Expected: FAIL — `src/changeset.js` doesn't exist yet.

- [ ] **Step 3: Implement**

```js
// src/changeset.js
import crypto from "node:crypto";
import path from "node:path";

/**
 * @param {string} taskId
 * @param {string} tmpRoot
 * @returns {{root: string, upperDir: string, workDir: string}}
 */
export function overlayPaths(taskId, tmpRoot) {
  const root = path.join(tmpRoot, `taskferry-cow-${taskId}`);
  return { root, upperDir: path.join(root, "upper", "main"), workDir: path.join(root, "work", "main") };
}

/**
 * Basename plus a short stable hash of the full path, so two paths that
 * happen to share a basename (e.g. two worktrees both named "my-repo"
 * under different parents) don't collide when used as an overlay
 * subdirectory name.
 * @param {string} targetPath
 * @returns {string}
 */
export function subOverlaySlug(targetPath) {
  const hash = crypto.createHash("sha1").update(targetPath).digest("hex").slice(0, 8);
  return `${path.basename(targetPath)}-${hash}`;
}

/**
 * @param {string} root
 * @param {string} targetPath
 * @returns {{path: string, upperDir: string, workDir: string}}
 */
export function subOverlayPaths(root, targetPath) {
  const slug = subOverlaySlug(targetPath);
  return { path: targetPath, upperDir: path.join(root, "upper", "extra", slug), workDir: path.join(root, "work", "extra", slug) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/changeset.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): add overlay path helpers"
```

---

## Task 5: `changeset.js` — pre-dispatch HEAD and git diff extraction

> **Post-implementation revision (2026-07-30, folded into the Task 6 fix round):** this task's code is amended for review findings #2 and #10 — `extractGitDiff()` **throws** on a non-zero bwrap exit or execution error instead of writing whatever stdout arrived and reporting success (fail closed; Task 10's exit handler catches and records `changesetError`), and `resolvePreDispatchHead()` returns the empty-tree hash (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) for a git target with an unborn HEAD, so a zero-commit repo stays on the git extraction path instead of being misclassified as a non-git target (whose rsync apply would otherwise copy the overlay's `.git` over the real one). Known documented limitations of the `git add -A && git diff --cached` strategy (spec §4): gitignored worker writes are excluded by design, and the short extraction-remount window shares the documented lower-layer-volatility cost. See the SDD ledger for the fix-round record.

**Files:**
- Modify: `src/changeset.js`
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `buildBwrapArgs` from `src/sandbox.js` (Task 2).
- Produces: `resolvePreDispatchHead(directory: string, runCommand?): string | null`
- Produces: `extractGitDiff({ directory, overlay, overlayRwBinds, preDispatchHead, stateDir, runtimeDir, homeDir, denyList, diffPath, runCommand?, writeFileFn?, mkdirFn? }): { diffPath, hasChanges }`

- [ ] **Step 1: Write the failing tests**

```js
// src/changeset.test.js -- add
import { extractGitDiff, resolvePreDispatchHead } from "./changeset.js";

describe("resolvePreDispatchHead()", () => {
  test("returns the trimmed HEAD sha for a git directory", () => {
    const runCommand = (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["-C", "/workspace/repo", "rev-parse", "HEAD"]);
      return { status: 0, stdout: "abc123\n", stderr: "", error: undefined };
    };
    assert.equal(resolvePreDispatchHead("/workspace/repo", runCommand), "abc123");
  });

  test("returns null for a non-git directory", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository", error: undefined });
    assert.equal(resolvePreDispatchHead("/tmp/scratch", runCommand), null);
  });
});

describe("extractGitDiff()", () => {
  test("remounts the overlay and runs a stage-diff-reset script anchored on preDispatchHead, writing stdout to diffPath", () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const written = {};
    const runCommand = (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return { status: 0, stdout: "diff --git a/foo b/foo\n+bar\n", stderr: "", error: undefined };
    };
    const result = extractGitDiff({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      overlayRwBinds: [],
      preDispatchHead: "abc123",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      diffPath: "/state/diffs/t1.patch",
      runCommand,
      writeFileFn: (filePath, content) => { written[filePath] = content; },
      mkdirFn: () => {},
    });
    assert.equal(capturedCommand, "bwrap");
    assert.ok(capturedArgs.includes("--overlay-src"));
    const shIndex = capturedArgs.indexOf("sh");
    assert.equal(capturedArgs[shIndex + 1], "-c");
    const script = capturedArgs[shIndex + 2];
    assert.match(script, /git -C '\/workspace\/repo' add -A/);
    assert.match(script, /git -C '\/workspace\/repo' diff --cached 'abc123'/);
    assert.match(script, /git -C '\/workspace\/repo' reset/);
    assert.equal(result.diffPath, "/state/diffs/t1.patch");
    assert.equal(result.hasChanges, true);
    assert.equal(written["/state/diffs/t1.patch"], "diff --git a/foo b/foo\n+bar\n");
  });

  test("reports hasChanges: false for an empty diff", () => {
    const runCommand = () => ({ status: 0, stdout: "", stderr: "", error: undefined });
    const result = extractGitDiff({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/u", workDir: "/tmp/w" },
      overlayRwBinds: [],
      preDispatchHead: "abc123",
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      diffPath: "/state/diffs/t1.patch",
      runCommand,
      writeFileFn: () => {},
      mkdirFn: () => {},
    });
    assert.equal(result.hasChanges, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/changeset.test.js`
Expected: FAIL — `extractGitDiff`/`resolvePreDispatchHead` not exported.

- [ ] **Step 3: Implement**

```js
// src/changeset.js -- add near the top, after the existing imports
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { buildBwrapArgs } from "./sandbox.js";

// Diff/apply calls are heavier than sandbox.js's bwrap --version probe (a
// real git diff over a worker's changes), so this uses a longer timeout
// than sandbox.js's defaultRunCommand.
function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  if (result.error) return { status: null, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

function shQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} directory
 * @param {typeof defaultRunCommand} [runCommand]
 * @returns {string|null}
 */
export function resolvePreDispatchHead(directory, runCommand = defaultRunCommand) {
  const result = runCommand("git", ["-C", directory, "rev-parse", "HEAD"]);
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Extracts the overlay's upper into a single diff, anchored on the real
 * pre-dispatch HEAD (not whatever HEAD ends up at inside the overlay --
 * diffing against a possibly-advanced HEAD would show nothing for a worker
 * that committed cleanly). Runs `git add -A` first so untracked files and
 * deletions surface too, then resets the transient staging -- the upper
 * already captured everything needed by that point.
 * @param {object} params
 * @param {string} params.directory
 * @param {{upperDir: string, workDir: string}} params.overlay
 * @param {Array<{path: string, upperDir: string, workDir: string}>} params.overlayRwBinds
 * @param {string} params.preDispatchHead
 * @param {string} params.stateDir
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir
 * @param {string[]} params.denyList
 * @param {string} params.diffPath
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @param {(filePath: string, content: string) => void} [params.writeFileFn]
 * @param {(dirPath: string) => void} [params.mkdirFn]
 * @returns {{diffPath: string, hasChanges: boolean}}
 */
export function extractGitDiff({
  directory,
  overlay,
  overlayRwBinds,
  preDispatchHead,
  stateDir,
  runtimeDir,
  homeDir,
  denyList,
  diffPath,
  runCommand = defaultRunCommand,
  writeFileFn = (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
  mkdirFn = (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }),
}) {
  const bwrapArgs = buildBwrapArgs({ directory, stateDir, runtimeDir, homeDir, denyList, overlay, overlayRwBinds });
  const script = `git -C ${shQuote(directory)} add -A && git -C ${shQuote(directory)} diff --cached ${shQuote(preDispatchHead)}; git -C ${shQuote(directory)} reset > /dev/null 2>&1`;
  const result = runCommand("bwrap", [...bwrapArgs, "--", "sh", "-c", script]);
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  return { diffPath, hasChanges: result.stdout.trim().length > 0 };
}

function pathDirname(filePath) {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/changeset.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): extract a preDispatchHead-anchored diff from the overlay"
```

---

## Task 6: `changeset.js` — merged-view builder and non-git diff extraction

> **Post-implementation revision (2026-07-30, the Task 6 fix round):** the first-pass review rated this task "Needs fixes". The fix round amends `extractNonGitDiff()` to **throw** on a non-zero bwrap exit or execution error (review finding #2 — fail closed, same contract as `extractGitDiff()` above), repairs the displaced `subOverlayPaths()` JSDoc block, and adds the `docs/sourcemap.md` row for `changeset.js` that this file's creation in Task 4 should have carried. See the SDD ledger for the fix-round record.

**Files:**
- Modify: `src/changeset.js`
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `buildBwrapArgs` (Task 2), `overlayPaths()` (Task 4).
- Produces: `buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable? }): string[]`
- Produces: `extractNonGitDiff({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, diffPath, runCommand?, writeFileFn?, mkdirFn? }): { diffPath, hasChanges }`

- [ ] **Step 1: Write the failing tests**

```js
// src/changeset.test.js -- add
import { buildMergedViewBwrapArgs, extractNonGitDiff } from "./changeset.js";

describe("buildMergedViewBwrapArgs()", () => {
  test("creates the merged mountpoint and overlays directory's content onto it, leaving directory itself read-only", () => {
    const args = buildMergedViewBwrapArgs({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      mergedMountPoint: "/tmp/taskferry-cow-t1/merged",
    });
    const dirIndex = args.indexOf("--dir");
    assert.equal(args[dirIndex + 1], "/tmp/taskferry-cow-t1/merged");
    const overlayIndex = args.indexOf("--overlay-src");
    assert.deepEqual(args.slice(overlayIndex, overlayIndex + 6), [
      "--overlay-src", "/workspace/repo",
      "--overlay", "/tmp/taskferry-cow-t1/upper/main", "/tmp/taskferry-cow-t1/work/main", "/tmp/taskferry-cow-t1/merged",
    ]);
    assert.ok(dirIndex < overlayIndex, "--dir must come before the --overlay line that mounts onto it");
    assert.equal(args.includes("--bind"), false, "directory stays read-only (part of the root ro-bind) when writable is not set");
  });

  test("also rw-binds directory itself when writable: true", () => {
    const args = buildMergedViewBwrapArgs({
      directory: "/workspace/repo",
      overlay: { upperDir: "/tmp/u", workDir: "/tmp/w" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      mergedMountPoint: "/tmp/merged",
      writable: true,
    });
    const bindIndex = args.indexOf("--bind");
    assert.equal(args[bindIndex + 1], "/workspace/repo");
    assert.equal(args[bindIndex + 2], "/workspace/repo");
  });
});

describe("extractNonGitDiff()", () => {
  test("runs diff -ru between the real directory and the merged view, writing stdout to diffPath", () => {
    let capturedArgs = null;
    const written = {};
    const runCommand = (command, args) => {
      capturedArgs = args;
      return { status: 1, stdout: "Only in /tmp/taskferry-cow-t1/merged: newfile.txt\n", stderr: "", error: undefined };
    };
    const result = extractNonGitDiff({
      directory: "/workspace/repo",
      overlay: { root: "/tmp/taskferry-cow-t1", upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      diffPath: "/state/diffs/t1.patch",
      runCommand,
      writeFileFn: (filePath, content) => { written[filePath] = content; },
      mkdirFn: () => {},
    });
    // diff -ru takes directory then mergedMountPoint positionally, so mergedMountPoint is last
    assert.deepEqual(capturedArgs.slice(-4), ["diff", "-ru", "/workspace/repo", "/tmp/taskferry-cow-t1/merged"]);
    assert.equal(capturedArgs.at(-1), "/tmp/taskferry-cow-t1/merged");
    assert.equal(result.hasChanges, true);
    assert.equal(written["/state/diffs/t1.patch"], "Only in /tmp/taskferry-cow-t1/merged: newfile.txt\n");
  });

  test("diff -ru exit status 0 or 1 are both success (0 = no diff, 1 = differences found)", () => {
    const runCommand = () => ({ status: 0, stdout: "", stderr: "", error: undefined });
    const result = extractNonGitDiff({
      directory: "/workspace/repo",
      overlay: { root: "/tmp/taskferry-cow-t1", upperDir: "/tmp/u", workDir: "/tmp/w" },
      stateDir: "/state", runtimeDir: "/state/run", homeDir: "/home/user", denyList: [],
      diffPath: "/state/diffs/t1.patch", runCommand, writeFileFn: () => {}, mkdirFn: () => {},
    });
    assert.equal(result.hasChanges, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/changeset.test.js`
Expected: FAIL — `buildMergedViewBwrapArgs`/`extractNonGitDiff` not exported.

- [ ] **Step 3: Implement**

```js
// src/changeset.js -- add
import path from "node:path"; // already imported above in Task 4; keep single import line

/**
 * Mounts directory's merged (overlay) view at a *separate* synthetic
 * mountpoint instead of at directory itself, so directory can be diffed
 * against its own merged view in the same sandbox (git targets don't need
 * this -- git diff only needs the merged tree at the real path -- this is
 * only for the non-git diff -ru / non-git apply cases).
 * @param {object} params
 * @param {string} params.directory
 * @param {{upperDir: string, workDir: string}} params.overlay
 * @param {string} params.stateDir
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir
 * @param {string[]} params.denyList
 * @param {string} params.mergedMountPoint
 * @param {boolean} [params.writable] - also rw-bind directory itself, for the apply step (Task 7); omit for
 *   pure extraction, where directory only needs to stay readable via the standard root ro-bind.
 * @returns {string[]}
 */
export function buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable = false }) {
  const args = ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const denied of denyList) args.push("--tmpfs", denied);
  args.push("--dir", mergedMountPoint);
  args.push("--overlay-src", directory, "--overlay", overlay.upperDir, overlay.workDir, mergedMountPoint);
  if (writable) args.push("--bind", directory, directory);
  args.push("--bind", runtimeDir, runtimeDir);
  args.push("--unshare-all", "--unshare-net", "--die-with-parent");
  return args;
}

/**
 * @param {object} params
 * @param {string} params.directory
 * @param {{root: string, upperDir: string, workDir: string}} params.overlay
 * @param {string} params.stateDir
 * @param {string} params.runtimeDir
 * @param {string} params.homeDir
 * @param {string[]} params.denyList
 * @param {string} params.diffPath
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @param {(filePath: string, content: string) => void} [params.writeFileFn]
 * @param {(dirPath: string) => void} [params.mkdirFn]
 * @returns {{diffPath: string, hasChanges: boolean}}
 */
export function extractNonGitDiff({
  directory,
  overlay,
  stateDir,
  runtimeDir,
  homeDir,
  denyList,
  diffPath,
  runCommand = defaultRunCommand,
  writeFileFn = (filePath, content) => fs.writeFileSync(filePath, content, { mode: 0o600 }),
  mkdirFn = (dirPath) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }),
}) {
  const mergedMountPoint = path.join(overlay.root, "merged");
  const bwrapArgs = buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable: false });
  const result = runCommand("bwrap", [...bwrapArgs, "--", "diff", "-ru", directory, mergedMountPoint]);
  mkdirFn(pathDirname(diffPath));
  writeFileFn(diffPath, result.stdout);
  return { diffPath, hasChanges: result.stdout.trim().length > 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/changeset.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): extract a diff -ru changeset for non-git overlay targets"
```

---

## Task 7: `changeset.js` — apply and cleanup

**Files:**
- Modify: `src/changeset.js`
- Test: `src/changeset.test.js`

**Interfaces:**
- Consumes: `buildMergedViewBwrapArgs()` (Task 6).
- Produces: `applyChangeset({ directory, diffPath, isGitTarget, overlay, stateDir, runtimeDir, homeDir, denyList, runCommand? }): { applied: boolean, reason: string|null }`
- Produces: `cleanupOverlay({ root, tmpRoot, rmFn? }): { removed: boolean, reason: string|null }` — plain removal, not a bwrap invocation (see this task's Step 3 for why); refuses any `root` that isn't a `taskferry-cow-*` tree under `tmpRoot` (review finding #12).

- [ ] **Step 1: Write the failing tests**

```js
// src/changeset.test.js -- add
import { applyChangeset, cleanupOverlay } from "./changeset.js";

describe("applyChangeset()", () => {
  test("git target: runs git apply <diffPath> against directory", () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const runCommand = (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "", error: undefined };
    };
    const result = applyChangeset({
      directory: "/workspace/repo",
      diffPath: "/state/diffs/t1.patch",
      isGitTarget: true,
      runCommand,
    });
    assert.equal(capturedCommand, "git");
    assert.deepEqual(capturedArgs, ["-C", "/workspace/repo", "apply", "/state/diffs/t1.patch"]);
    assert.deepEqual(result, { applied: true, reason: null });
  });

  test("git target: surfaces git apply's stderr as the failure reason on conflict", () => {
    const runCommand = () => ({ status: 1, stdout: "", stderr: "error: patch does not apply\n", error: undefined });
    const result = applyChangeset({ directory: "/workspace/repo", diffPath: "/state/diffs/t1.patch", isGitTarget: true, runCommand });
    assert.equal(result.applied, false);
    assert.match(result.reason, /patch does not apply/);
  });

  test("non-git target: rsyncs the merged overlay view onto directory inside one writable remount", () => {
    let capturedArgs = null;
    const runCommand = (command, args) => {
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "", error: undefined };
    };
    const result = applyChangeset({
      directory: "/workspace/scratch",
      diffPath: "/state/diffs/t1.patch",
      isGitTarget: false,
      overlay: { root: "/tmp/taskferry-cow-t1", upperDir: "/tmp/taskferry-cow-t1/upper/main", workDir: "/tmp/taskferry-cow-t1/work/main" },
      stateDir: "/state",
      runtimeDir: "/state/run",
      homeDir: "/home/user",
      denyList: [],
      runCommand,
    });
    assert.ok(capturedArgs.includes("--dir"));
    assert.ok(capturedArgs.includes("/workspace/scratch"), "directory must be rw-bound for the apply's writable remount");
    const shIndex = capturedArgs.indexOf("sh");
    const script = capturedArgs[shIndex + 2];
    assert.match(script, /rsync -a --delete --delay-updates '\/tmp\/taskferry-cow-t1\/merged'\/ '\/workspace\/scratch'\//);
    assert.deepEqual(result, { applied: true, reason: null });
  });
});

describe("cleanupOverlay()", () => {
  // Overlay upper/work dirs come back owned by the daemon's own uid, not an
  // unmapped namespace one (verified live against the target host, see
  // ADR 0001's corrected "Namespace-owned leftovers" entry) -- a plain
  // removal is correct, no bwrap wrapper needed.
  test("removes the task's overlay root and reports success", () => {
    let removedPath = null;
    const result = cleanupOverlay({ root: "/tmp/taskferry-cow-t1", tmpRoot: "/tmp", rmFn: (p) => { removedPath = p; } });
    assert.equal(removedPath, "/tmp/taskferry-cow-t1");
    assert.deepEqual(result, { removed: true, reason: null });
  });

  test("refuses to remove a root that is not a taskferry-cow tree under the overlay tmp root", () => {
    let removedPath = null;
    const result = cleanupOverlay({ root: "/home/user/important", tmpRoot: "/tmp", rmFn: (p) => { removedPath = p; } });
    assert.equal(removedPath, null);
    assert.equal(result.removed, false);
    assert.match(result.reason, /not a taskferry-cow overlay under/);
  });

  test("reports failure with the thrown error's message", () => {
    const result = cleanupOverlay({ root: "/tmp/taskferry-cow-t1", tmpRoot: "/tmp", rmFn: () => { throw new Error("EACCES: permission denied"); } });
    assert.equal(result.removed, false);
    assert.match(result.reason, /permission denied/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/changeset.test.js`
Expected: FAIL — `applyChangeset`/`cleanupOverlay` not exported.

- [ ] **Step 3: Implement**

```js
// src/changeset.js -- add
/**
 * @param {object} params
 * @param {string} params.directory
 * @param {string} params.diffPath
 * @param {boolean} params.isGitTarget
 * @param {{root: string, upperDir: string, workDir: string}} [params.overlay] - required when isGitTarget is false
 * @param {string} [params.stateDir]
 * @param {string} [params.runtimeDir]
 * @param {string} [params.homeDir]
 * @param {string[]} [params.denyList]
 * @param {typeof defaultRunCommand} [params.runCommand]
 * @returns {{applied: boolean, reason: string|null}}
 */
export function applyChangeset({ directory, diffPath, isGitTarget, overlay, stateDir, runtimeDir, homeDir, denyList, runCommand = defaultRunCommand }) {
  if (isGitTarget) {
    const result = runCommand("git", ["-C", directory, "apply", diffPath]);
    if (result.status === 0) return { applied: true, reason: null };
    return { applied: false, reason: result.stderr.trim() || result.error?.message || `git apply exited with status ${result.status}` };
  }
  const mergedMountPoint = path.join(overlay.root, "merged");
  const bwrapArgs = buildMergedViewBwrapArgs({ directory, overlay, stateDir, runtimeDir, homeDir, denyList, mergedMountPoint, writable: true });
  // --delay-updates (review finding #9): rsync stages each updated file and
  // renames them all into place in the final update phase, so an interrupted
  // apply leaves old files intact rather than a half-mutated tree. Not fully
  // transactional (deletions still apply incrementally), but retryable: a
  // failed apply leaves changesetStatus "pending" and never runs cleanup
  // (spec §5.4), so the overlay survives for a second attempt.
  const script = `rsync -a --delete --delay-updates ${shQuote(mergedMountPoint)}/ ${shQuote(directory)}/`;
  const result = runCommand("bwrap", [...bwrapArgs, "--", "sh", "-c", script]);
  if (result.status === 0) return { applied: true, reason: null };
  return { applied: false, reason: result.stderr.trim() || `apply copy exited with status ${result.status}` };
}

/**
 * Overlay upper/work dirs come back owned by the invoking (daemon's own)
 * uid, not an unmapped namespace one -- bwrap's default --unshare-user
 * identity-maps the outer uid, and nothing in this design passes
 * --uid/--gid. Verified live against the exact buildBwrapArgs() flag set
 * on the target host: overlayfs's internal work/work scratch subdir comes
 * back mode 000, but a plain rm -rf from the same uid still removes it
 * (unlink authority comes from the parent directory's permissions, not the
 * child's own mode). No bwrap wrapper or elevated privilege is needed --
 * see ADR 0001's corrected "Namespace-owned leftovers" entry.
 * @param {object} params
 * @param {string} params.root
 * @param {string} params.tmpRoot - the overlayTmpRoot the overlay was created under; removal is
 *   refused for any root that isn't a taskferry-cow tree under it (review finding #12 -- defense
 *   in depth against a corrupted/tampered tasks.json pointing rm -rf elsewhere; exploiting it
 *   already requires the daemon's own uid, which is exactly the attacker this feature targets).
 * @param {(path: string) => void} [params.rmFn]
 * @returns {{removed: boolean, reason: string|null}}
 */
export function cleanupOverlay({ root, tmpRoot, rmFn = (p) => fs.rmSync(p, { recursive: true, force: true }) }) {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(tmpRoot) + path.sep) || !path.basename(resolved).startsWith("taskferry-cow-")) {
    return { removed: false, reason: `refusing to remove ${root}: not a taskferry-cow overlay under ${tmpRoot}` };
  }
  try {
    rmFn(root);
    return { removed: true, reason: null };
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/changeset.test.js`
Expected: PASS — all of Tasks 4-7's tests green.

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "feat(changeset): add applyChangeset() and cleanupOverlay()"
```

---

## Task 8: `tasks.js` — `overlayEnabled`/`checkOverlaySupportFn` wiring and new task fields

**Files:**
- Modify: `src/tasks.js:460-534` (`createTaskManager` options), `src/tasks.js:983-1096` (`dispatch()`), `src/tasks.js:2347-2358` (`advisor()`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `checkOverlaySupport` (Task 1), `overlayPaths`/`resolvePreDispatchHead` (Tasks 4-5).
- Produces: task record gains `role: "dispatch"|"advisor"`, `changesetStatus: "none"|"pending"|"accepted"|"rejected"`, `diffPath: string|null`, `overlayDirs: {root,upperDir,workDir,rwBinds}|null` (`rwBinds`: the git-common-dir sub-overlays persisted for extraction — review finding #1), `preDispatchHead: string|null`, `changesetError: string|null` (set when settlement-time extraction fails — review finding #2; the overlay is deliberately NOT cleaned up so the changes remain recoverable).
- Produces: `dispatch()` accepts `role = "dispatch"` and `noOverlay = false`.
- Produces: `createTaskManager()` accepts `overlayEnabled` (same precedence shape as `sandboxEnabled`), `checkOverlaySupportFn`, `overlayTmpRoot` (test-only injection point, defaults to `os.tmpdir()`), and `rmOverlayTreeFn` (test-only injection point for `cleanupOverlay()`'s removal, defaults to a real `fs.rmSync`).

- [ ] **Step 1: Write the failing tests**

```js
// src/tasks.test.js -- extend makeManager()'s destructured params and createTaskManager() call.
// Add all five overlay-related test injection points now, even though createTaskManager()
// itself only gains overlayEnabled/checkOverlaySupportFn/overlayTmpRoot in this task --
// runOverlayCommandFn (Task 10) and rmOverlayTreeFn (Task 7/11/12's cleanupOverlay() callers)
// land in later tasks. Passing an extra key through to createTaskManager() before it
// destructures that option is harmless (plain object property, ignored until read), so
// wiring the test helper once here avoids re-touching this block in three more tasks.
//
// overlayEnabled defaults to false here, mirroring this same file's existing
// sandboxEnabled = false default and for the same reason: createTaskManager()'s own
// production default is true (Global Constraints: fail closed), but every pre-existing
// sandboxed test in this file mocks checkBwrapAvailableFn without mocking
// checkOverlaySupportFn -- on a host where real bwrap happens to be >= 0.8 (common in dev
// containers), an unconditional pass-through would silently activate a real overlay for
// all of them, replacing their expected --bind <directory> <directory> with
// --overlay-src/--overlay and breaking bindIndex-style assertions throughout the "bwrap
// sandboxing" describe block. Defaulting false here keeps every pre-existing test on the
// old plain-bind path unchanged; only the new overlay-specific tests below opt in
// explicitly via overlayEnabled: true or checkOverlaySupportFn.
function makeManager({ /* ...existing params..., */ overlayEnabled = false, checkOverlaySupportFn, overlayTmpRoot, runOverlayCommandFn, rmOverlayTreeFn } = {}) {
  // ...existing body...
  return createTaskManager({
    // ...existing fields...
    overlayEnabled,
    ...(checkOverlaySupportFn != null ? { checkOverlaySupportFn } : {}),
    ...(overlayTmpRoot != null ? { overlayTmpRoot } : {}),
    ...(runOverlayCommandFn != null ? { runOverlayCommandFn } : {}),
    ...(rmOverlayTreeFn != null ? { rmOverlayTreeFn } : {}),
  });
}

// New describe block, near "bwrap sandboxing"
describe("dispatch() role/changeset fields", () => {
  test("a plain dispatch defaults to role 'dispatch' and changesetStatus 'none' when sandboxing is off", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild(), sandboxEnabled: false });
    const result = mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
    const status = mgr.status(result.id);
    assert.equal(status.role, "dispatch");
    assert.equal(status.changesetStatus, "none");
  });

  test("advisor() dispatches internally with role 'advisor'", async () => {
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
      sandboxEnabled: false,
    });
    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    const status = mgr.status(advised.task_id);
    assert.equal(status.role, "advisor");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `status.role`/`status.changesetStatus` are `undefined`.

- [ ] **Step 3: Implement**

```js
// src/tasks.js -- add imports near the top, alongside the existing sandbox.js import
import { checkOverlaySupport } from "./sandbox.js"; // add to the existing "./sandbox.js" import line
import { overlayPaths, resolvePreDispatchHead } from "./changeset.js";
```

```js
// src/tasks.js -- add to createTaskManager()'s destructured options, right after the existing
// sandboxEnabled/allowedDirs block (~line 526)
  overlayEnabled = process.env.TASKFERRY_DISABLE_OVERLAY !== undefined
    ? !["1", "true"].includes(process.env.TASKFERRY_DISABLE_OVERLAY)
    : (/** @type {boolean|undefined} */ (config.overlayEnabled) ?? true),
  checkOverlaySupportFn = checkOverlaySupport,
  overlayTmpRoot = os.tmpdir(),
  rmOverlayTreeFn = (/** @type {string} */ p) => fs.rmSync(p, { recursive: true, force: true }),
```

```js
// src/tasks.js -- add a cached capability-check helper next to requireBwrap() (~line 566-578)
  /** @type {{supported: boolean, reason?: string}|null} */
  let overlaySupport = null;
  function requireOverlaySupport() {
    if (overlaySupport == null) {
      overlaySupport = checkOverlaySupportFn();
    }
    if (!overlaySupport.supported) {
      throw new Error(
        `error: overlay is required for gated dispatch writes but is unsupported (${overlaySupport.reason})\n` +
        "help: upgrade bubblewrap to >= 0.8, or opt out explicitly with --no-overlay or TASKFERRY_DISABLE_OVERLAY=1 (writes will not be gated)"
      );
    }
  }
```

```js
// src/tasks.js -- modify dispatch()'s signature (line 983)
  function dispatch({ prompt, directory, model, variant, sessionId, keySlot, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, executor: executorName, role = "dispatch" }) {
```

```js
// src/tasks.js -- extend the task object literal (line 1067-1093) with the new fields, right
// after finalMarker
    /** @type {Task} */
    const task = {
      id,
      status: "queued",
      directory: normalizedDirectory,
      model: resolvedModel,
      executorId: executor.id,
      variant: usingDefaultModel ? "high" : variant || null,
      sessionId: sessionId || null,
      originSessionId: originSessionId || null,
      pid: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
      logPath,
      promptPreview: prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt,
      promptTotalChars: prompt.length > 200 ? prompt.length : null,
      spawnError: null,
      cancelRequested: false,
      internal: internal === true,
      failureReason: null,
      failureDetail: null,
      keySlot: resolvedKeySlot.keySlot,
      incomplete: false,
      finalMarker: finalMarker == null ? null : finalMarker,
      role,
      changesetStatus: "none",
      diffPath: null,
      overlayDirs: null,
      preDispatchHead: null,
      changesetError: null,
    };
```

```js
// src/tasks.js -- extend pendingLaunches.set() (line 1096) to carry noOverlay and role through
    // to the spawn path, mirroring how noSandbox/allowedDirs already do
    pendingLaunches.set(id, { prompt, directory: normalizedDirectory, model: resolvedModel, variant: task.variant, sessionId, keyEnvValue: resolvedKeySlot.keyEnvValue, noSandbox: noSandbox === true, noOverlay: noOverlay === true, allowedDirs: dispatchAllowedDirs, executor, role });
```

```js
// src/tasks.js -- advisor() (line 2356): pass role: "advisor" on its internal dispatch() call
      dispatched = dispatch({ prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), model, variant, sessionId: resolved.sessionId, executor, role: "advisor" });
```

`overlayPaths`/`resolvePreDispatchHead`/`requireOverlaySupport` aren't called yet from the spawn path — that's Task 9. This task only establishes the fields, options, and the `role` plumbing so Task 9's spawn-path changes have somewhere to write their results.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): add role/changeset fields and overlayEnabled wiring to dispatch()"
```

---

## Task 9: `tasks.js` — spawn path: overlay construction and git-common-dir conversion

**Files:**
- Modify: `src/tasks.js:1591-1685` (sandboxed spawn-args construction)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `overlayPaths`, `subOverlayPaths` (Task 4), `resolvePreDispatchHead` (Task 5), `requireOverlaySupport` (Task 8), `buildBwrapArgs`'s new `runtimeDirWritable` param (added to `sandbox.js` in this task's Step 3 — review finding #6).
- Produces: on a sandboxed dispatch with overlay active, `task.overlayDirs` (**including `rwBinds`** — the per-path git-common-dir sub-overlays, persisted because they are not reliably re-derivable at extraction time; review finding #1), `task.changesetStatus = "pending"`, `task.preDispatchHead` are populated before spawn; the git-common-dir binds that used to land in `extraRwBinds` land in `overlayRwBinds` instead.
- Produces: advisor-role spawns bind `runtimeDir` read-only (the daemon's `daemon.sock` lives there; `--unshare-net` does not block Unix-socket connects through a writable bind — review finding #6).
- Produces: an advisor dispatch with overlay disabled (global `overlayEnabled: false`) fails closed with a `spawnError` — overlay is mandatory for the advisor role per ADR 0001 (review finding #5). Per-call `--no-overlay` on advisor is rejected at the CLI/protocol layer entirely (Task 15).

- [ ] **Step 1: Write the failing tests**

```js
// src/tasks.test.js -- add to the "bwrap sandboxing" describe block
test("mounts an overlay on the target directory when overlayEnabled and the host supports it", () => {
  let captured = null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-dir-"));
  const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-overlay-tmp-"));
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    overlayEnabled: true,
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    overlayTmpRoot,
  });

  const result = mgr.dispatch({ prompt: "hello", directory });

  assert.ok(captured.args.includes("--overlay-src"));
  const overlayIndex = captured.args.indexOf("--overlay-src");
  assert.equal(captured.args[overlayIndex + 1], directory);
  const status = mgr.status(result.id);
  assert.equal(status.changesetStatus, "pending");
  assert.ok(status.overlayDirs.upperDir.startsWith(overlayTmpRoot));
});

test("falls back to a plain bind with a warning when overlayEnabled is explicitly false", () => {
  let captured = null;
  let warned = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { warned += chunk; return true; };
  try {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-no-overlay-dir-"));
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: false,
      platform: "linux",
    });
    const result = mgr.dispatch({ prompt: "hello", directory });
    assert.equal(captured.args.includes("--overlay-src"), false);
    assert.equal(mgr.status(result.id).changesetStatus, "none");
    assert.match(warned, /overlay disabled/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("crashes the task with a spawnError instead of dispatching unguarded when overlay is required but unsupported", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-unsupported-dir-"));
  const mgr = makeManager({
    spawnFn: () => fakeChild(),
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    checkOverlaySupportFn: () => ({ supported: false, reason: "bwrap 0.6.0 < 0.8 required for --overlay" }),
    platform: "linux",
  });
  const result = mgr.dispatch({ prompt: "hello", directory });
  const status = mgr.status(result.id);
  assert.equal(status.status, "crashed");
  assert.match(status.spawnError, /bwrap 0.6.0 < 0.8/);
});

test("converts the git-common-dir binds into per-path overlays instead of plain writable binds when overlay is active", () => {
  let captured = null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-worktree-overlay-dir-"));
  const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-git-common-overlay-"));
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    overlayEnabled: true,
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    resolveGitCommonDirFn: () => gitCommonDir,
  });

  mgr.dispatch({ prompt: "hello", directory });

  // The whole-common-dir fallback path (no resolveGitDirFn override -> gitDir
  // resolves to the same as gitCommonDir via the real `git` binary failing in
  // this temp dir, matching the existing "falls back to binding the whole
  // common dir" test's setup) must appear as an overlay, not a plain --bind.
  const overlaySrcIndex = captured.args.indexOf("--overlay-src", captured.args.indexOf("--overlay-src") + 1);
  assert.notEqual(overlaySrcIndex, -1, "expected a second --overlay-src for the git-common-dir slice");
  assert.equal(captured.args[overlaySrcIndex + 1], gitCommonDir);
});

test("shareNet is true (--share-net) for a plain dispatch and false (--unshare-net) for an advisor role", async () => {
  let dispatchArgs = null;
  let advisorArgs = null;
  const mgr = makeManager({
    spawnFn: (cmd, args) => { if (!dispatchArgs) dispatchArgs = args; else advisorArgs = args; const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
  });
  mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
  assert.ok(dispatchArgs.includes("--share-net"));
  assert.ok(!dispatchArgs.includes("--unshare-net"));

  await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
  assert.ok(advisorArgs.includes("--unshare-net"));
  assert.ok(!advisorArgs.includes("--share-net"));
});

test("persists the git-common-dir sub-overlays onto the task record for extraction", () => {
  let captured = null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-rwbinds-persist-dir-"));
  const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-rwbinds-common-"));
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    overlayEnabled: true,
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
    resolveGitCommonDirFn: () => gitCommonDir,
  });

  const result = mgr.dispatch({ prompt: "hello", directory });

  // Review finding #1: extraction (Task 10) re-mounts the exact sub-overlays
  // the worker ran with; they must be persisted here, not re-derived later.
  const status = mgr.status(result.id);
  assert.ok(Array.isArray(status.overlayDirs.rwBinds));
  assert.ok(status.overlayDirs.rwBinds.length > 0, "the whole-common-dir fallback must be persisted as a sub-overlay");
  assert.ok(status.overlayDirs.rwBinds.every((b) => b.path && b.upperDir && b.workDir));
});

test("binds runtimeDir read-only for advisor spawns so the daemon socket is unreachable", async () => {
  // --unshare-net alone does not block Unix-domain-socket access to a
  // writable bind-mounted path, and runtimeDir holds daemon.sock (review
  // finding #6); a read-only bind makes connect() fail instead.
  let dispatchArgs = null;
  let advisorArgs = null;
  const mgr = makeManager({
    spawnFn: (cmd, args) => { if (!dispatchArgs) dispatchArgs = args; else advisorArgs = args; const child = fakeChild(); setImmediate(() => child.emit("exit", 0, null)); return child; },
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    checkOverlaySupportFn: () => ({ supported: true }),
    platform: "linux",
  });
  const runtimeDir = path.join(mgr.paths.STATE_DIR, "run");

  mgr.dispatch({ prompt: "hello", directory: os.tmpdir() });
  const flagPairs = (args) => {
    const pairs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") pairs.push([args[i], args[i + 1]]);
    }
    return pairs;
  };
  assert.ok(flagPairs(dispatchArgs).some(([flag, p]) => flag === "--bind" && p === runtimeDir), "dispatch keeps today's writable runtimeDir bind");

  await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
  assert.ok(flagPairs(advisorArgs).some(([flag, p]) => flag === "--ro-bind" && p === runtimeDir), "advisor must get a read-only runtimeDir bind");
  assert.ok(!flagPairs(advisorArgs).some(([flag, p]) => flag === "--bind" && p === runtimeDir), "advisor must not get a writable runtimeDir bind");
});

test("crashes an advisor dispatch instead of running it unguarded when overlay is globally disabled", async () => {
  // Review finding #5: an advisor without an overlay gets a plain writable
  // bind -- a path to persist writes, contradicting ADR 0001. Fail closed.
  const mgr = makeManager({
    spawnFn: () => fakeChild(),
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    overlayEnabled: false,
    platform: "linux",
  });
  const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
  const status = mgr.status(advised.task_id);
  assert.equal(status.status, "crashed");
  assert.match(status.spawnError, /advisor dispatch requires overlay-gated writes/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — no `--overlay-src` is emitted yet; `shareNet` is always true; `runtimeDir` is always writable-bound; `overlayDirs.rwBinds` doesn't exist; an advisor with overlay disabled runs unguarded instead of crashing.

- [ ] **Step 3: Implement**

**Step 3a: `sandbox.js` prerequisite — `runtimeDirWritable` (review finding #6).** `runtimeDir` holds the daemon's Unix socket (`daemon.sock`, `src/daemon.js`'s `prepareSocket`); `--unshare-net` does not block Unix-domain-socket connects through a *writable* bind mount, so an advisor (full bash toolset per ADR 0001) would retain a path back into the daemon. Extend `buildBwrapArgs()` (Task 2's function):

```js
// src/sandbox.js -- add to buildBwrapArgs()'s JSDoc options, next to the shareNet entry
 * @param {boolean} [options.runtimeDirWritable] - default true (today's --bind runtimeDir for dispatch
 *   roles); pass false for advisor-role dispatches to emit --ro-bind instead, so the daemon's Unix
 *   socket inside runtimeDir is unreachable from the sandbox (connect() fails on a read-only mount).

// ...destructure it with the same default:
  runtimeDirWritable = true,

// ...and replace the unconditional runtimeDir bind:
  args.push(runtimeDirWritable ? "--bind" : "--ro-bind", runtimeDir, runtimeDir);
```

```js
// src/sandbox.test.js -- add
test("binds runtimeDir read-only when runtimeDirWritable is false (advisor isolation)", () => {
  const args = buildBwrapArgs({ directory: "/w", stateDir: "/s", runtimeDir: "/s/run", homeDir: "/h", denyList: [], runtimeDirWritable: false });
  assert.notEqual(args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/s/run"), -1);
  assert.equal(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run"), -1);
});

test("defaults to a writable runtimeDir bind (unchanged dispatch behavior)", () => {
  const args = buildBwrapArgs({ directory: "/w", stateDir: "/s", runtimeDir: "/s/run", homeDir: "/h", denyList: [] });
  assert.notEqual(args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/s/run"), -1);
});
```

**Step 3b: the spawn path.** Replace the sandboxed spawn-args block (`src/tasks.js:1591-1685`) with:

```js
      if (sandboxEnabled && !noSandbox && platformSupportsSandbox(platform)) {
        requireBwrap();
        spawnCommand = "bwrap";
        const homeDir = os.homedir();
        const denyList = defaultDenyList(homeDir, stateDir).filter(existsFn);
        const {
          extraRoBinds: executorRoBinds,
          extraRwPairBinds: executorRwPairBinds = [],
          sandboxedDataHome,
          sandboxEnv,
        } = executor.sandboxAuthFile({
          homeDir,
          dataDir: cacheDir,
          spawnEnv,
          existsFn,
          statFn,
          readdirFn,
          ...(isSummary ? {} : { sessionId: dispatchLaunch.sessionId ?? null, launchDirectory: launchDirectory || null }),
        });
        /** @type {[string, string][]} */
        const extraRoBinds = [...executorRoBinds];
        if (promptFilePath) extraRoBinds.push([PROMPT_DIR, PROMPT_DIR]);
        /** @type {string[]} */
        const extraRwBinds = [];
        fs.mkdirSync(sandboxedDataHome, { recursive: true, mode: 0o700 });
        extraRwBinds.push(sandboxedDataHome);

        // Summary/report children never get an overlay -- they don't write
        // to the target directory in any sense the changeset model cares
        // about, so the plain v1 bind is correct and unchanged for them.
        const role = isSummary ? null : (dispatchLaunch.role ?? "dispatch");
        const wantsOverlay = !isSummary && overlayEnabled && dispatchLaunch.noOverlay !== true;
        /** @type {{root: string, upperDir: string, workDir: string}|null} */
        let overlayInfo = null;
        if (wantsOverlay) {
          requireOverlaySupport();
          overlayInfo = overlayPaths(task.id, overlayTmpRoot);
          // Exclusive creation of the overlay root (review finding #12): the
          // non-recursive mkdir fails closed (EEXIST -> spawnError via the
          // outer catch) if the path already exists -- e.g. a pre-planted
          // symlink, which a recursive mkdir would follow. Fresh random task
          // ids make a genuine collision impossible in practice; upper/work
          // are then created recursively *under* the safely-exclusive root.
          fs.mkdirSync(overlayTmpRoot, { recursive: true, mode: 0o700 });
          fs.mkdirSync(overlayInfo.root, { mode: 0o700 });
          fs.mkdirSync(overlayInfo.upperDir, { recursive: true, mode: 0o700 });
          fs.mkdirSync(overlayInfo.workDir, { recursive: true, mode: 0o700 });
        } else if (role === "advisor") {
          // Review finding #5: an advisor without an overlay gets a plain
          // writable bind -- a path to persist writes, contradicting ADR
          // 0001's "an advisor has no path to persist a write." Overlay is
          // mandatory for the advisor role whenever sandboxing is active, so
          // a globally-disabled overlay fails closed here. (Per-call
          // --no-overlay never reaches here for advisors: the CLI/protocol
          // surface rejects it, see Task 15.)
          throw new Error(
            "error: advisor dispatch requires overlay-gated writes, but overlay is disabled\n" +
            "help: unset TASKFERRY_DISABLE_OVERLAY or set overlayEnabled: true in config -- advisor writes must be gated, see docs/adr/0001-cow-overlays-and-diff-gated-writes.md"
          );
        } else if (!isSummary) {
          process.stderr.write(`warning: overlay disabled -- writes land directly on ${launchDirectory}, not gated by accept/reject\n`);
        }

        /** @type {Array<{path: string, upperDir: string, workDir: string}>} */
        const overlayRwBinds = [];
        const gitCommonDir = resolveGitCommonDirFn(launchDirectory);
        if (gitCommonDir && existsFn(gitCommonDir) && isOutsideDirectory(launchDirectory, gitCommonDir)) {
          const gitDir = resolveGitDirFn(launchDirectory);
          /** @param {string} p */
          const addWritable = (p) => {
            if (overlayInfo) {
              const sub = subOverlayPaths(overlayInfo.root, p);
              fs.mkdirSync(sub.upperDir, { recursive: true, mode: 0o700 });
              fs.mkdirSync(sub.workDir, { recursive: true, mode: 0o700 });
              overlayRwBinds.push(sub);
            } else {
              extraRwBinds.push(p);
            }
          };
          if (gitDir && existsFn(gitDir) && gitDir !== gitCommonDir) {
            addWritable(gitDir);
            for (const rel of ["objects", "refs", path.join("logs", "refs")]) {
              const resolved = path.join(gitCommonDir, rel);
              fs.mkdirSync(resolved, { recursive: true });
              addWritable(resolved);
            }
            const packedRefs = path.join(gitCommonDir, "packed-refs");
            if (existsFn(packedRefs)) addWritable(packedRefs);
          } else {
            addWritable(gitCommonDir);
          }
        }
        for (const dir of [...allowedDirs, ...(isSummary ? [] : dispatchLaunch.allowedDirs || [])]) {
          const resolved = path.isAbsolute(dir) ? dir : path.resolve(launchDirectory, dir);
          if (existsFn(resolved)) extraRwBinds.push(resolved);
        }
        spawnArgs = buildBwrapArgs({
          directory: launchDirectory,
          stateDir,
          runtimeDir,
          homeDir,
          denyList,
          extraRwBinds,
          extraRwPairBinds: executorRwPairBinds,
          extraRoBinds,
          ...(overlayInfo ? { overlay: { upperDir: overlayInfo.upperDir, workDir: overlayInfo.workDir }, overlayRwBinds } : {}),
          shareNet: role !== "advisor",
          runtimeDirWritable: role !== "advisor",
        }).concat(["--", executor.binaryName, ...args]);
        spawnEnv = { ...spawnEnv, ...sandboxEnv };

        if (overlayInfo && !isSummary) {
          // rwBinds persisted onto the task (review finding #1): settlement-time
          // extraction (Task 10) must re-mount the exact git-common-dir sub-overlays
          // the worker ran with. They are not reliably re-derivable later -- the
          // packed-refs/objects/refs selection above depends on live filesystem
          // state that can change between dispatch and extraction.
          task.overlayDirs = { ...overlayInfo, rwBinds: overlayRwBinds };
          task.changesetStatus = "pending";
          task.preDispatchHead = resolvePreDispatchHead(launchDirectory);
        }
      }
```

Add `requireOverlaySupport`'s error path handling: it throws synchronously inside the same `try` block the rest of this code already runs in (`src/tasks.js:1583` onward), which the existing outer `catch (err)` (line 1927) already converts into `task.status = "crashed"` / `task.spawnError = errMessage(err)` — no new catch logic needed.

The tests above assert on `status().overlayDirs` — `status()` delegates to `summarize()`, so extend `summarize()` **in this task** (Task 11's rewrite keeps it): add `...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),` to the returned object, next to the other conditional spreads.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, including every pre-existing "bwrap sandboxing" test. Those tests never pass `overlayEnabled`, so they get `makeManager()`'s own `overlayEnabled = false` default (see Task 8's note on why that default exists) and `wantsOverlay` stays false for all of them — confirm this by re-running the full pre-existing suite, not just the new tests.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.js src/sandbox.test.js src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): mount a CoW overlay on sandboxed dispatch/advisor spawns"
```

---

## Task 10: `tasks.js` — exit-handler diff extraction and advisor auto-reject

**Files:**
- Modify: `src/tasks.js:1848-1900` (exit handler)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `extractGitDiff`, `extractNonGitDiff` (Tasks 5-6 — as amended by the Task 6 fix round: both **throw** on a non-zero bwrap exit or execution error, review finding #2).
- Consumes: `defaultRunCommand` **from `changeset.js`** (the 30s diff/apply runner, exported by this task's Step 3a — NOT `sandbox.js`'s 5s version-probe runner of the same name; review finding #4).
- Produces: on settlement of a task with `task.overlayDirs` set — for **every** terminal status that reaches the exit handler, including `"cancelled"` (spec §4: "every task dispatched with an active overlay"; review finding #8) — `task.diffPath` is populated and `task.changesetStatus` becomes `"pending"` (dispatch role, has changes), `"accepted"` (dispatch role, **zero changes** — a no-op needs no gate; review finding #3), or `"rejected"` (advisor role, auto-discarded — cleanup runs immediately).
- Produces: on an extraction failure, `task.changesetError` records the reason, `changesetStatus` stays `"pending"`, and the overlay is deliberately NOT cleaned up (the changes are still recoverable from `upper`; `accept` errors usefully, `reject` still works — Task 11).

- [ ] **Step 1: Write the failing tests**

```js
// src/tasks.test.js -- add to "bwrap sandboxing" or a new "changeset extraction" describe block
describe("changeset extraction at settlement", () => {
  test("extracts a diff and leaves changesetStatus pending for a settled dispatch with an active overlay", () => {
    let extractCommand = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: (command, args) => { extractCommand = { command, args }; return { status: 0, stdout: "diff --git a/x b/x\n", stderr: "", error: undefined }; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.ok(status.diffPath);
    assert.equal(extractCommand.command, "bwrap");
  });

  test("auto-rejects and cleans up an advisor's changeset at settlement", async () => {
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });

    const advisePromise = mgr.advisor({ prompt: "hello", directory, model: "openai/gpt-5.6-sol" });
    setImmediate(() => child.emit("exit", 0, null));
    const advised = await advisePromise;

    const status = mgr.status(advised.task_id);
    assert.equal(status.changesetStatus, "rejected");
    assert.ok(cleanedRoot);
  });

  test("re-mounts the persisted git-common-dir sub-overlays during extraction (regression: review finding #1)", () => {
    // A real git repo so preDispatchHead resolves (git extraction path), plus
    // an outside-directory common dir + distinct gitdir so the spawn path
    // builds sub-overlays (Task 9's worktree branch).
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-git-dir-"));
    spawnSync("git", ["init", "-q", directory]);
    fs.writeFileSync(path.join(directory, "f.txt"), "base\n");
    spawnSync("git", ["-C", directory, "add", "-A"]);
    spawnSync("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-common-"));
    const gitWorktreeAdminDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-extract-gitdir-"));
    let extractArgs = null;
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      resolveGitCommonDirFn: () => gitCommonDir,
      resolveGitDirFn: () => gitWorktreeAdminDir,
      runOverlayCommandFn: (command, args) => { extractArgs = args; return { status: 0, stdout: "diff --git a/f.txt b/f.txt\n", stderr: "", error: undefined }; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    // The extraction bwrap must carry the main overlay PLUS the persisted
    // sub-overlays -- hardcoding overlayRwBinds: [] dropped all of these.
    const overlaySrcCount = extractArgs.filter((a) => a === "--overlay-src").length;
    assert.ok(overlaySrcCount >= 2, `expected the main overlay plus git-common-dir sub-overlays in the extraction mount, got ${overlaySrcCount} --overlay-src args`);
    assert.ok(extractArgs.includes(gitWorktreeAdminDir), "the worktree's private gitdir sub-overlay must be re-mounted for extraction");
    assert.equal(mgr.status(result.id).changesetStatus, "pending");
  });

  test("auto-resolves a zero-change extraction to accepted and cleans up immediately (regression: review finding #3)", () => {
    let cleanedRoot = null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-empty-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-empty-extract-tmp-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "accepted", "a no-op dispatch must not sit pending awaiting a manual reject");
    assert.ok(cleanedRoot, "the overlay must be cleaned up once there is nothing to gate");
    assert.equal(status.overlayDirs, null);
  });

  test("extracts a changeset for a cancelled task too (regression: review finding #8)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-cancel-extract-dir-"));
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      runOverlayCommandFn: () => ({ status: 0, stdout: "diff --git a/x b/x\n", stderr: "", error: undefined }),
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    mgr.cancel(result.id);
    child.emit("exit", null, "SIGTERM");

    const status = mgr.status(result.id);
    assert.equal(status.status, "cancelled");
    assert.equal(status.changesetStatus, "pending");
    assert.ok(status.diffPath, "cancelled tasks keep their changes too");
  });

  test("a failed extraction records changesetError, stays pending, and keeps the overlay for recovery (regression: review finding #2)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-failed-extract-dir-"));
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-failed-extract-tmp-"));
    let cleanedAny = false;
    let child;
    const mgr = makeManager({
      spawnFn: (cmd, args) => { child = fakeChild(); return child; },
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      overlayEnabled: true,
      checkOverlaySupportFn: () => ({ supported: true }),
      platform: "linux",
      overlayTmpRoot,
      runOverlayCommandFn: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn bwrap ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
      rmOverlayTreeFn: () => { cleanedAny = true; },
    });

    const result = mgr.dispatch({ prompt: "hello", directory });
    child.emit("exit", 0, null);

    const status = mgr.status(result.id);
    assert.equal(status.changesetStatus, "pending");
    assert.match(status.changesetError, /ETIMEDOUT/);
    assert.equal(status.diffPath, null);
    assert.ok(status.overlayDirs, "the overlay must survive a failed extraction -- it is the only copy of the worker's changes");
    assert.equal(cleanedAny, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `changesetStatus` stays `"pending"` for every settled task (extraction never runs), advisor never auto-rejects.

- [ ] **Step 3: Implement**

```js
// src/changeset.js -- Step 3a prerequisite (review finding #4): export the module's own 30s
// runner. Importing sandbox.js's defaultRunCommand here instead would put extraction, apply,
// accept, and reject on a 5s timeout meant for a bwrap --version probe, and a real git diff
// over a worker's changes routinely takes longer than that.
export function defaultRunCommand(command, args) {  // (the existing unexported function -- add `export`)
```

```js
// src/tasks.js -- add createTaskManager() option, alongside overlayEnabled/checkOverlaySupportFn (Task 8)
  runOverlayCommandFn = defaultOverlayRunCommand, // changeset.js's 30s runner (NOT sandbox.js's 5s probe runner -- review finding #4); injectable for tests
```

Add the import: `import { checkOverlaySupport } from "./sandbox.js";` (extend the existing import line — note: **no** `defaultRunCommand` from sandbox.js here).

```js
// src/tasks.js -- import extractGitDiff/extractNonGitDiff/cleanupOverlay and the 30s runner
// (aliased, since sandbox.js exports a different function of the same name) alongside the Task 8 import
import { cleanupOverlay, defaultRunCommand as defaultOverlayRunCommand, extractGitDiff, extractNonGitDiff, overlayPaths, resolvePreDispatchHead } from "./changeset.js";
```

```js
// src/tasks.js -- add a helper near requireOverlaySupport(), used by both the exit handler
// (this task) and accept()/reject() (Task 11)
  /**
   * @param {Task} finishedTask
   */
  function extractChangesetForTask(finishedTask) {
    if (!finishedTask.overlayDirs) return;
    const denyList = defaultDenyList(os.homedir(), stateDir).filter(existsFn);
    const diffPath = path.join(stateDir, "diffs", `${finishedTask.id}.patch`);
    const isGitTarget = finishedTask.preDispatchHead != null;
    let extracted;
    try {
      extracted = isGitTarget
        ? extractGitDiff({
            directory: finishedTask.directory,
            overlay: { upperDir: finishedTask.overlayDirs.upperDir, workDir: finishedTask.overlayDirs.workDir },
            // Review finding #1: re-mount the exact git-common-dir sub-overlays
            // persisted at spawn time (Task 9). Hardcoding [] here made a
            // worktree's .git-metadata writes invisible to the extracted diff.
            overlayRwBinds: finishedTask.overlayDirs.rwBinds ?? [],
            preDispatchHead: finishedTask.preDispatchHead,
            stateDir,
            runtimeDir,
            homeDir: os.homedir(),
            denyList,
            diffPath,
            runCommand: runOverlayCommandFn,
          })
        : extractNonGitDiff({
            directory: finishedTask.directory,
            overlay: finishedTask.overlayDirs,
            stateDir,
            runtimeDir,
            homeDir: os.homedir(),
            denyList,
            diffPath,
            runCommand: runOverlayCommandFn,
          });
    } catch (err) {
      // Review finding #2 (fail closed): extractGitDiff/extractNonGitDiff throw
      // on a non-zero bwrap exit or execution error rather than writing whatever
      // stdout happened to arrive. Record the failure, leave the task "pending"
      // with no diffPath, and deliberately KEEP the overlay -- the changes are
      // still recoverable from upper (accept errors usefully, reject still
      // cleans up; Task 11). Never clean up on this path.
      finishedTask.changesetStatus = "pending";
      finishedTask.changesetError = err instanceof Error ? err.message : String(err);
      persistTask(finishedTask.id);
      return;
    }
    finishedTask.diffPath = extracted.diffPath;
    if (finishedTask.role === "advisor") {
      finishedTask.changesetStatus = "rejected";
      const removal = cleanupOverlay({ root: finishedTask.overlayDirs.root, tmpRoot: overlayTmpRoot, rmFn: rmOverlayTreeFn });
      if (removal.removed) finishedTask.overlayDirs = null;
      // A failed cleanup leaves overlayDirs set so the daemon-startup orphan
      // sweep (Task 12) can retry it later; not fatal to settlement.
    } else if (extracted.hasChanges) {
      finishedTask.changesetStatus = "pending";
    } else {
      // Review finding #3: a zero-change extraction auto-resolves. Leaving it
      // "pending" would force a manual reject of a no-op (whose git apply of an
      // empty patch would itself normally fail). "accepted" is the truthful
      // terminal state: applying nothing succeeds trivially. Cleanup runs now,
      // same as the advisor branch.
      finishedTask.changesetStatus = "accepted";
      const removal = cleanupOverlay({ root: finishedTask.overlayDirs.root, tmpRoot: overlayTmpRoot, rmFn: rmOverlayTreeFn });
      if (removal.removed) finishedTask.overlayDirs = null;
    }
  }
```

```js
// src/tasks.js -- call it from the exit handler, right after task.status is finalized and
// before finishSettlement() (line 1899)
        if (task.status === "done") evaluateOutputCompleteness(task);
        // Review finding #8: "cancelled" is a real settlement status too, and
        // spec §4 says extraction runs "for every task dispatched with an
        // active overlay" -- excluding it lost a cancelled worker's changes.
        if (task.status === "done" || task.status === "crashed" || task.status === "cancelled") extractChangesetForTask(task);
        // ...existing summary-session-continuity block...
        finishSettlement();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): extract the overlay changeset at task settlement, auto-reject advisor writes"
```

---

## Task 11: `tasks.js` — `accept()`/`reject()`, `result()` diff field, `summarize()` exposure

**Files:**
- Modify: `src/tasks.js:866-881` (`summarize`), `src/tasks.js:2656-2760` (`result`), new functions near `cancel()` (`src/tasks.js:1954`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Produces: `accept(taskId: string): { taskId, changesetStatus, applied: boolean, reason?, cleanupFailed? }` — `cleanupFailed: true` when apply succeeded but overlay removal failed (the overlay survives for the daemon-startup sweep to retry; review finding #11). Errors usefully when `diffPath` is `null` (a failed extraction, Task 10) or when a non-git target's overlay has vanished (e.g. a reboot cleared the tmpfs — review finding #7).
- Produces: `reject(taskId: string): { taskId, changesetStatus, cleanupFailed? }`
- Produces: `result(taskId, { fields: ["diff"] })` returns the cached patch text (or `null` if none) under `.diff`; `fields: ["diffStat"]` (or no `fields`, i.e. `--full`) returns `{ files, additions, deletions }` under `.diffStat` (spec §5.3; review finding #13).
- Produces: `summarize()` includes `role`/`changesetStatus` whenever the task has ever had an overlay (`changesetStatus !== "none"` or `role === "advisor"`), plus `overlayDirs` while set and `changesetError` when an extraction failed.

- [ ] **Step 1: Write the failing tests**

```js
// src/tasks.test.js -- add
describe("accept()/reject()", () => {
  // The fixture's overlay root lives under this host's actual tmpdir so
  // cleanupOverlay's containment check (Task 7, review finding #12) accepts
  // it -- a hardcoded /tmp path would fail that check on hosts where
  // os.tmpdir() resolves elsewhere.
  const fixtureTmpRoot = os.tmpdir();
  const fixtureRoot = path.join(fixtureTmpRoot, "taskferry-cow-t_pending");
  function pendingTaskFixture(overrides = {}) {
    return {
      ...baseTask({ id: "t_pending", status: "done" }),
      role: "dispatch",
      changesetStatus: "pending",
      diffPath: "/does-not-matter-for-this-fixture.patch",
      overlayDirs: { root: fixtureRoot, upperDir: path.join(fixtureRoot, "upper", "main"), workDir: path.join(fixtureRoot, "work", "main"), rwBinds: [] },
      preDispatchHead: "abc123",
      ...overrides,
    };
  }

  test("accept() applies the diff, marks the changeset accepted, and cleans up", () => {
    let applyCalled = false;
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[2] === "apply") applyCalled = true;
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.applied, true);
    assert.equal(applyCalled, true);
    assert.equal(cleanedRoot, fixtureRoot);
    assert.equal(mgr.status("t_pending").changesetStatus, "accepted");
  });

  test("accept() leaves changesetStatus pending and does not clean up when apply fails", () => {
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command) => {
        if (command === "git") return { status: 1, stdout: "", stderr: "error: patch does not apply\n", error: undefined };
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.applied, false);
    assert.equal(mgr.status("t_pending").changesetStatus, "pending");
    assert.equal(cleanedRoot, null);
  });

  test("reject() discards the changeset without applying and cleans up", () => {
    let applyCalled = false;
    let cleanedRoot = null;
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: (command, args) => {
        if (command === "git" && args[2] === "apply") applyCalled = true;
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    const result = mgr.reject("t_pending");
    assert.equal(result.changesetStatus, "rejected");
    assert.equal(applyCalled, false);
    assert.equal(cleanedRoot, fixtureRoot);
    assert.equal(mgr.status("t_pending").changesetStatus, "rejected");
  });

  test("accept() on an advisor task throws a clear, non-applying error", () => {
    const mgr = makeManager({ tasksFixture: [pendingTaskFixture({ id: "t_advisor", role: "advisor", changesetStatus: "rejected" })] });
    assert.throws(() => mgr.accept("t_advisor"), /role "advisor" and cannot be accepted/);
  });

  test("accept() on a task with no pending changeset throws", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_none" })] });
    assert.throws(() => mgr.accept("t_none"), /no pending changeset/);
  });

  test("accept() on a task whose extraction failed errors usefully and keeps the overlay (regression: review finding #2)", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({ diffPath: null, changesetError: "spawn bwrap ETIMEDOUT" })],
    });
    assert.throws(() => mgr.accept("t_pending"), /changeset was never extracted.*ETIMEDOUT/s);
    assert.ok(mgr.status("t_pending").overlayDirs, "the preserved overlay is the user's only copy of the changes");
  });

  test("accept() on a non-git target whose overlay vanished errors instead of applying nothing (regression: review finding #7)", () => {
    // A reboot clears the tmpfs overlay; the pending changeset can never be
    // re-applied. Fail loudly rather than rsyncing a missing tree.
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture({
        preDispatchHead: null, // non-git target
        overlayDirs: { root: fixtureRoot, upperDir: path.join(fixtureRoot, "upper", "main"), workDir: path.join(fixtureRoot, "work", "main"), rwBinds: [] }, // never created on disk
      })],
    });
    assert.throws(() => mgr.accept("t_pending"), /overlay is gone/);
  });

  test("accept() surfaces a failed cleanup via cleanupFailed and leaves overlayDirs for the sweep (regression: review finding #11)", () => {
    const mgr = makeManager({
      tasksFixture: [pendingTaskFixture()],
      runOverlayCommandFn: () => ({ status: 0, stdout: "", stderr: "", error: undefined }),
      rmOverlayTreeFn: () => { throw new Error("EBUSY: resource busy or locked"); },
    });
    const result = mgr.accept("t_pending");
    assert.equal(result.applied, true);
    assert.equal(result.changesetStatus, "accepted");
    assert.equal(result.cleanupFailed, true, "a failed cleanup must not be swallowed");
    assert.ok(mgr.status("t_pending").overlayDirs, "overlayDirs must stay set so the daemon-startup sweep retries");
  });
});

describe("result() diffStat field", () => {
  test("computes files/additions/deletions from the cached patch (regression: review finding #13)", () => {
    const patch = [
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1,2 @@",
      "+added line",
      "+another",
      "diff --git a/two.txt b/two.txt",
      "--- a/two.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed line",
      "",
    ].join("\n");
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_stat", logPath: path.join(logDir, "t_stat.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_stat.patch"),
      }],
      logs: { "t_stat.ndjson": "" },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_stat.patch"), patch);
    const result = mgr.result("t_stat", { fields: ["diffStat"] });
    assert.deepEqual(result.diffStat, { files: 2, additions: 2, deletions: 1 });
  });
});

describe("result() diff field", () => {
  test("returns the cached patch text for fields: ['diff']", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_diff", logPath: path.join(logDir, "t_diff.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_diff.patch"),
      }],
      logs: { "t_diff.ndjson": "" },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_diff.patch"), "diff --git a/x b/x\n");
    const result = mgr.result("t_diff", { fields: ["diff"] });
    assert.equal(result.diff, "diff --git a/x b/x\n");
  });

  test("returns null for a task with no diffPath", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_no_diff" })] });
    const result = mgr.result("t_no_diff", { fields: ["diff"] });
    assert.equal(result.diff, null);
  });
});
```

(If `mgr.paths.STATE_DIR` isn't already exposed by `createTaskManager()`'s return value, use the same `stateDir` the test itself passed via `makeManager`'s temp dir — check the existing "bwrap sandboxing" test at line 422 (`mgr.paths.STATE_DIR`) confirms it already is.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `mgr.accept`/`mgr.reject` are not functions; `result(...).diff` is `undefined`.

- [ ] **Step 3: Implement**

```js
// src/tasks.js -- add RESULT_FIELDS "diff"/"diffStat" handling inside result(), right before
// the final projectResult(...) call (~line 2739), reading the cached patch when requested
    let diffText = null;
    if (task.diffPath && (fields == null || fields.includes("diff") || fields.includes("diffStat"))) {
      try {
        diffText = fs.readFileSync(task.diffPath, "utf8");
      } catch {
        diffText = null;
      }
    }
    // Review finding #13: spec §5.3 requires a diffStat summary (files changed,
    // +/- counts) on result --full. Counted from the cached patch text: "diff
    // --git" headers for files, hunk-body +/- lines otherwise (works for the
    // git format; for the non-git diff -ru format the +++/--- header lines are
    // excluded and "Only in" lines are not counted -- an approximation, which
    // is all a human-readable summary needs).
    const diffStat = diffText != null && (fields == null || fields.includes("diffStat")) ? computeDiffStat(diffText) : null;

    return projectResult({
      taskId,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      spawnError: task.spawnError,
      ...failureFields(task),
      diff: diffText,
      diffStat,
      changesetError: task.changesetError ?? null,
      // ...existing fields (message, narration, tokens, cost, sessionId, keySlot, logPath, incomplete, finalMarker)...
    }, fields);
```

```js
// src/tasks.js -- add the helper near the other small pure helpers
  /**
   * @param {string} diffText
   * @returns {{files: number, additions: number, deletions: number}}
   */
  function computeDiffStat(diffText) {
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of diffText.split("\n")) {
      if (line.startsWith("diff --git ")) files++;
      else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { files, additions, deletions };
  }
```

`projectResult()` (line 2566-2572) already reads `detail[field] ?? null` per requested field name, so adding `diff` to the object passed in is sufficient — no change needed there.

```js
// src/tasks.js -- summarize() (line 866-881): expose role/changesetStatus when they're meaningful
  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, keySlot, incomplete, finalMarker, spawnError, executorId, role, changesetStatus } = task;
    return {
      id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      ...failureFields(task),
      keySlot: keySlot ?? null,
      spawnError: spawnError ?? null,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      ...(incomplete === true ? { incomplete: true } : {}),
      ...(finalMarker != null ? { finalMarker } : {}),
      ...(executorId != null ? { executorId } : {}),
      ...(changesetStatus != null && changesetStatus !== "none" ? { role, changesetStatus } : {}),
      ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
      ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
      cancelRequested: !!cancelRequested,
    };
  }
```

```js
// src/tasks.js -- add accept()/reject() near cancel() (after line 1954's function, before status())
  /**
   * @param {string} taskId
   * @returns {{taskId: string, changesetStatus: string, applied: boolean}}
   */
  function accept(taskId) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.role === "advisor") {
      throw new Error(`error: task ${taskId} has role "advisor" and cannot be accepted\nhelp: use "taskferry result ${taskId} --diff" to inspect what it wrote -- advisor writes are never applied`);
    }
    if (task.changesetStatus !== "pending") {
      throw new Error(`error: task ${taskId} has no pending changeset (changesetStatus: ${task.changesetStatus ?? "none"})\nhelp: only a task with changesetStatus "pending" can be accepted`);
    }
    if (task.diffPath == null) {
      // The extraction at settlement failed (Task 10 records why in
      // changesetError); there is no patch to apply, but the overlay was
      // deliberately kept so the changes remain recoverable.
      throw new Error(
        `error: task ${taskId}'s changeset was never extracted (${task.changesetError ?? "unknown reason"})\n` +
        `help: the overlay was preserved${task.overlayDirs ? ` at ${task.overlayDirs.root}` : ""} -- inspect it there directly, or "taskferry reject ${taskId}" to discard it`
      );
    }
    const isGitTarget = task.preDispatchHead != null;
    if (!isGitTarget && task.overlayDirs && !existsFn(task.overlayDirs.upperDir)) {
      // Review finding #7: a non-git accept must rebuild the merged view from
      // the live overlay to rsync it; /tmp being a tmpfs, a reboot clears it.
      // Fail loudly (fail-fast, never pretend to apply nothing) rather than
      // rsyncing a missing tree. A git target's patch is persisted under
      // stateDir and survives reboots, so this check is non-git only.
      throw new Error(
        `error: task ${taskId}'s overlay is gone (likely cleared by a reboot -- /tmp is a tmpfs)\n` +
        `help: a non-git changeset cannot be re-applied without its overlay; use "taskferry result ${taskId} --diff" for the informational diff, then "taskferry reject ${taskId}" to clear the pending state`
      );
    }
    const denyList = defaultDenyList(os.homedir(), stateDir).filter(existsFn);
    const applied = applyChangeset({
      directory: task.directory,
      diffPath: /** @type {string} */ (task.diffPath),
      isGitTarget,
      overlay: task.overlayDirs ?? undefined,
      stateDir,
      runtimeDir,
      homeDir: os.homedir(),
      denyList,
      runCommand: runOverlayCommandFn,
    });
    if (!applied.applied) {
      return { taskId, changesetStatus: task.changesetStatus, applied: false, reason: applied.reason };
    }
    task.changesetStatus = "accepted";
    // Review finding #11: a cleanup failure must not be swallowed. The status
    // is terminal either way (the apply is what the user asked for), but the
    // failure surfaces in the return value and overlayDirs stays set so the
    // daemon-startup sweep (Task 12) retries the removal.
    let cleanupFailed = false;
    if (task.overlayDirs) {
      const removal = cleanupOverlay({ root: task.overlayDirs.root, tmpRoot: overlayTmpRoot, rmFn: rmOverlayTreeFn });
      if (removal.removed) task.overlayDirs = null;
      else cleanupFailed = true;
    }
    persistTask(task.id);
    return { taskId, changesetStatus: task.changesetStatus, applied: true, ...(cleanupFailed ? { cleanupFailed: true } : {}) };
  }

  /**
   * @param {string} taskId
   * @returns {{taskId: string, changesetStatus: string}}
   */
  function reject(taskId) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.changesetStatus !== "pending") {
      throw new Error(`error: task ${taskId} has no pending changeset (changesetStatus: ${task.changesetStatus ?? "none"})\nhelp: only a task with changesetStatus "pending" can be rejected`);
    }
    task.changesetStatus = "rejected";
    let cleanupFailed = false;
    if (task.overlayDirs) {
      const removal = cleanupOverlay({ root: task.overlayDirs.root, tmpRoot: overlayTmpRoot, rmFn: rmOverlayTreeFn });
      if (removal.removed) task.overlayDirs = null;
      else cleanupFailed = true;
    }
    persistTask(task.id);
    return { taskId, changesetStatus: task.changesetStatus, ...(cleanupFailed ? { cleanupFailed: true } : {}) };
  }
```

Add the import: `import { applyChangeset, cleanupOverlay, defaultRunCommand as defaultOverlayRunCommand, extractGitDiff, extractNonGitDiff, overlayPaths, resolvePreDispatchHead } from "./changeset.js";` (extend Task 10's import line, keeping its alias).

Add `accept, reject,` to the object `createTaskManager()` returns (find the existing `advisor,` entry near line 2789 and add both new functions alongside it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): add accept()/reject() and expose the diff result field"
```

---

## Task 12: `tasks.js` — daemon-startup orphan overlay sweep

**Files:**
- Modify: `src/tasks.js:780-809` (right after `loadPersisted()`/`sweepOrphanedPromptFiles()`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `cleanupOverlay` (Task 7), `overlayTmpRoot` (Task 8).
- Produces: `sweepOrphanedOverlays()`, run once at manager construction, mirroring the existing `sweepOrphanedPromptFiles()` pattern one function above it.

Spec §7's cleanup protocol requires a same-boot daemon-crash recovery sweep for `/tmp/taskferry-cow-*` dirs whose task id no longer exists in `tasks.json` — `/tmp` being a tmpfs already clears everything on a real reboot for free, so this only matters for a daemon that crashed and restarted without ever running `accept`/`reject`'s cleanup. This task fills that gap; `sweepOrphanedPromptFiles()` right above it in `tasks.js` is the exact precedent to mirror.

- [ ] **Step 1: Write the failing tests**

```js
// src/tasks.test.js -- add
describe("sweepOrphanedOverlays()", () => {
  test("removes an overlay directory whose task id is unknown to this manager (crash before extraction ever ran)", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-tmp-"));
    fs.mkdirSync(path.join(overlayTmpRoot, "taskferry-cow-oc_gone", "upper", "main"), { recursive: true });
    let cleanedRoot = null;
    makeManager({
      overlayTmpRoot,
      rmOverlayTreeFn: (p) => { cleanedRoot = p; },
    });
    assert.equal(cleanedRoot, path.join(overlayTmpRoot, "taskferry-cow-oc_gone"));
  });

  test("does not sweep an overlay directory whose task still has a pending changeset", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-tmp-"));
    const overlayRoot = path.join(overlayTmpRoot, "taskferry-cow-t_pending");
    fs.mkdirSync(path.join(overlayRoot, "upper", "main"), { recursive: true });
    let cleanedAny = false;
    makeManager({
      overlayTmpRoot,
      tasksFixture: [{
        ...baseTask({ id: "t_pending" }),
        role: "dispatch",
        changesetStatus: "pending",
        overlayDirs: { root: overlayRoot, upperDir: path.join(overlayRoot, "upper", "main"), workDir: path.join(overlayRoot, "work", "main") },
      }],
      rmOverlayTreeFn: () => { cleanedAny = true; },
    });
    assert.equal(cleanedAny, false);
  });

  test("does nothing when overlayTmpRoot doesn't exist or is empty", () => {
    const overlayTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-orphan-empty-"));
    assert.doesNotThrow(() => makeManager({ overlayTmpRoot }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — no sweep runs yet, `cleanedRoot` stays `null`.

- [ ] **Step 3: Implement**

```js
// src/tasks.js -- add right after sweepOrphanedPromptFiles(); call (line 809), before
// ensureStateLoaded()
  // Mirrors sweepOrphanedPromptFiles() above: a daemon that crashed after an
  // overlay was created but before its cleanup (reject/accept, or the
  // advisor auto-reject in extractChangesetForTask()) ever ran leaves a
  // /tmp/taskferry-cow-<task-id> dir behind. /tmp being a tmpfs clears these
  // on a real reboot for free; this only matters for a same-boot daemon
  // restart. A task whose changesetStatus is still "pending" legitimately
  // owns its overlay and must never be swept here -- only unknown task ids
  // and already-resolved (accepted/rejected) tasks with a leftover
  // overlayDirs (their own cleanupOverlay() call crashed mid-removal) are
  // orphans.
  function sweepOrphanedOverlays() {
    let entries;
    try {
      entries = fs.readdirSync(overlayTmpRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith("taskferry-cow-")) continue;
      const taskId = entry.slice("taskferry-cow-".length);
      const task = tasks.get(taskId);
      if (task && task.changesetStatus === "pending") continue;
      const root = path.join(overlayTmpRoot, entry);
      const removal = cleanupOverlay({ root, tmpRoot: overlayTmpRoot, rmFn: rmOverlayTreeFn });
      if (removal.removed && task) task.overlayDirs = null;
    }
  }
  sweepOrphanedOverlays();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): sweep orphaned overlay dirs left by a daemon crash on startup"
```

---

## Task 13: `protocol.js` — `task.accept`/`task.reject` RPC methods and `diff` result field

**Files:**
- Modify: `src/protocol.js:7-37, 96-146`
- Test: `src/protocol.test.js`

**Interfaces:**
- Produces: `RPC_METHODS` includes `"task.accept"`, `"task.reject"`.
- Produces: `RESULT_FIELDS` includes `"diff"`.
- Produces: `validParams("task.accept"|"task.reject", { taskId })` validates a lone required `taskId` string.

- [ ] **Step 1: Write the failing tests**

```js
// src/protocol.test.js -- add, matching the existing task.cancel-style tests' structure in this file
describe("task.accept / task.reject", () => {
  test("accepts a valid taskId-only request", () => {
    const line = JSON.stringify({ version: PROTOCOL_VERSION, id: "r1", method: "task.accept", params: { taskId: "t1" } });
    assert.doesNotThrow(() => parseRequestLine(line));
  });

  test("rejects task.accept with extra params", () => {
    const line = JSON.stringify({ version: PROTOCOL_VERSION, id: "r1", method: "task.accept", params: { taskId: "t1", extra: true } });
    assert.throws(() => parseRequestLine(line), /INVALID_PARAMS/);
  });

  test("rejects task.reject with a missing taskId", () => {
    const line = JSON.stringify({ version: PROTOCOL_VERSION, id: "r1", method: "task.reject", params: {} });
    assert.throws(() => parseRequestLine(line), /INVALID_PARAMS/);
  });
});

describe("RESULT_FIELDS", () => {
  test("includes diff, diffStat, and changesetError", () => {
    assert.ok(RESULT_FIELDS.has("diff"));
    assert.ok(RESULT_FIELDS.has("diffStat"));
    assert.ok(RESULT_FIELDS.has("changesetError"));
  });
});
```

(Match this file's actual assertion style for a thrown `ProtocolError` — check the neighboring `task.cancel` tests in `src/protocol.test.js` for whether they assert on `.code` or a message regex, and mirror that exactly rather than introducing a new assertion style.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/protocol.test.js`
Expected: FAIL — `UNKNOWN_METHOD` for `task.accept`/`task.reject`; `RESULT_FIELDS.has("diff")` is `false`.

- [ ] **Step 3: Implement**

```js
// src/protocol.js -- add to RPC_METHODS (line 7-19)
export const RPC_METHODS = Object.freeze([
  "system.health",
  "task.dispatch",
  "task.cancel",
  "task.status",
  "task.wait",
  "task.list",
  "task.result",
  "task.tail",
  "task.summary",
  "task.advisor",
  "task.context",
  "task.accept",
  "task.reject",
]);
```

```js
// src/protocol.js -- add "diff", "diffStat", and "changesetError" to RESULT_FIELDS (line 22-37).
// diffStat is spec §5.3's --full summary (review finding #13); changesetError lets
// "taskferry result <id> --fields changesetError" surface a failed extraction (Task 10).
export const RESULT_FIELDS = new Set([
  "message",
  "narration",
  "tokens",
  "cost",
  "sessionId",
  "exitCode",
  "signal",
  "spawnError",
  "failureReason",
  "failureDetail",
  "keySlot",
  "logPath",
  "incomplete",
  "finalMarker",
  "diff",
  "diffStat",
  "changesetError",
]);
```

```js
// src/protocol.js -- add two cases to validParams()'s switch, right after "task.context" (line 132-133)
    case "task.accept":
    case "task.reject":
      return hasOnly(params, ["taskId"]) && isNonEmptyString(params.taskId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/protocol.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.js src/protocol.test.js
git commit -m "feat(protocol): add task.accept/task.reject RPC methods and diff result field"
```

---

## Task 14: `daemon.js` — wire `task.accept`/`task.reject` to the manager

**Files:**
- Modify: `src/daemon.js:176-223` (`invoke`)
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: `manager.accept(taskId)`, `manager.reject(taskId)` (Task 11).

- [ ] **Step 1: Write the failing test**

```js
// src/daemon.test.js -- add, matching this file's existing invoke()-testing style for task.cancel
describe("task.accept / task.reject", () => {
  test("task.accept invokes manager.accept(taskId)", async () => {
    let capturedTaskId = null;
    const manager = { accept: (taskId) => { capturedTaskId = taskId; return { taskId, changesetStatus: "accepted", applied: true }; } };
    const result = await invoke(manager, { method: "task.accept", params: { taskId: "t1" } });
    assert.equal(capturedTaskId, "t1");
    assert.equal(result.changesetStatus, "accepted");
  });

  test("task.reject invokes manager.reject(taskId)", async () => {
    let capturedTaskId = null;
    const manager = { reject: (taskId) => { capturedTaskId = taskId; return { taskId, changesetStatus: "rejected" }; } };
    const result = await invoke(manager, { method: "task.reject", params: { taskId: "t1" } });
    assert.equal(capturedTaskId, "t1");
    assert.equal(result.changesetStatus, "rejected");
  });
});
```

(If `invoke()` isn't exported from `src/daemon.js` for direct testing, match whatever the existing `task.cancel` test in this file actually does to exercise `invoke()` — likely a mock `manager` object passed through the same helper the file already uses for other method tests. Use that exact helper rather than inventing a new one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/daemon.test.js`
Expected: FAIL — `unsupported method after validation: task.accept`.

- [ ] **Step 3: Implement**

```js
// src/daemon.js -- add two cases to invoke()'s switch, right after "task.context" (line 216-219)
    case "task.accept":
      return manager.accept(params.taskId);
    case "task.reject":
      return manager.reject(params.taskId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/daemon.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.js src/daemon.test.js
git commit -m "feat(daemon): wire task.accept/task.reject RPC methods to the task manager"
```

---

## Task 15: `args.js` + `commands.js` + `output.js` — CLI surface

**Files:**
- Modify: `src/args.js:5-137, 255-473` (command specs, defaults, parsing, `commandAllows`)
- Modify: `src/commands.js:76-193` (`dispatch`/`advisor`/`result` cases, new `accept`/`reject` cases)
- Modify: `src/output.js:97-137` (`leanStatus`)
- Test: `src/args.test.js`, `src/commands.test.js`, `src/output.test.js`

**Interfaces:**
- Produces: `taskferry dispatch --no-overlay`. `--no-overlay` is **not** a valid flag on `taskferry advisor` (review finding #5: overlay is mandatory for the advisor role per ADR 0001 — a plain writable bind would give an advisor a path to persist writes). The parse-time rejection covers the per-call opt-out; a *globally* disabled overlay on an advisor dispatch fails closed daemon-side with a `spawnError` (Task 9's spawn path).
- Produces: `taskferry result <id> --diff`.
- Produces: `taskferry accept <id>`, `taskferry reject <id>`.
- Produces: `leanStatus()` includes `changesetStatus: "pending"` on a non-`--full` `status`/`wait` response whenever the settled task has one, without requiring `--full`.

- [ ] **Step 1: Write the failing tests**

```js
// src/args.test.js -- add
test("dispatch accepts --no-overlay", () => {
  const parsed = parseArgs(["dispatch", "--prompt", "hi", "--no-overlay"]);
  assert.equal(parsed.options.noOverlay, true);
});

test("advisor rejects --no-overlay (overlay is mandatory for the advisor role; review finding #5)", () => {
  // Mirrors args.js's existing unknown-flag UsageError shape (the
  // booleanCommands gate): the remediation lists advisor's valid flags.
  assert.throws(
    () => parseArgs(["advisor", "--prompt", "hi", "--model", "openai/gpt-5.6-sol", "--no-overlay"]),
    /unknown flag --no-overlay/
  );
});

test("result accepts --diff", () => {
  const parsed = parseArgs(["result", "t1", "--diff"]);
  assert.equal(parsed.options.diff, true);
});

test("result rejects --diff combined with --fields", () => {
  assert.throws(() => parseArgs(["result", "t1", "--diff", "--fields", "message"]), /--diff cannot be combined with --fields/);
});

test("accept requires a task id", () => {
  assert.throws(() => parseArgs(["accept"]), /task id is required/);
});

test("accept parses a task id positional", () => {
  const parsed = parseArgs(["accept", "t1"]);
  assert.equal(parsed.command, "accept");
  assert.equal(parsed.options.taskId, "t1");
});

test("reject parses a task id positional", () => {
  const parsed = parseArgs(["reject", "t1"]);
  assert.equal(parsed.command, "reject");
  assert.equal(parsed.options.taskId, "t1");
});
```

```js
// src/commands.test.js -- add, matching this file's existing runCommand()-testing style for
// "cancel"/"result"
test("accept calls task.accept via the client", async () => {
  let capturedMethod = null;
  let capturedParams = null;
  const client = { request: async (method, params) => { capturedMethod = method; capturedParams = params; return { taskId: "t1", changesetStatus: "accepted", applied: true }; } };
  const result = await runCommand("accept", { taskId: "t1" }, { client });
  assert.equal(capturedMethod, "task.accept");
  assert.deepEqual(capturedParams, { taskId: "t1" });
  assert.equal(result.changesetStatus, "accepted");
});

test("reject calls task.reject via the client", async () => {
  let capturedMethod = null;
  const client = { request: async (method) => { capturedMethod = method; return { taskId: "t1", changesetStatus: "rejected" }; } };
  const result = await runCommand("reject", { taskId: "t1" }, { client });
  assert.equal(capturedMethod, "task.reject");
  assert.equal(result.changesetStatus, "rejected");
});

test("result --diff requests fields: ['diff']", async () => {
  let capturedParams = null;
  const client = { request: async (method, params) => { capturedParams = params; return { taskId: "t1", status: "done", diff: "diff --git a/x b/x\n" }; } };
  await runCommand("result", { taskId: "t1", diff: true }, { client });
  assert.deepEqual(capturedParams.fields, ["diff"]);
});

test("dispatch forwards noOverlay to task.dispatch", async () => {
  let capturedParams = null;
  const client = { request: async (method, params) => { capturedParams = params; return {}; } };
  await runCommand("dispatch", { prompt: "hi", directory: "/tmp", noOverlay: true }, { client, cwd: "/tmp", checkSkills: () => {} });
  assert.equal(capturedParams.noOverlay, true);
});
```

```js
// src/output.test.js -- add
test("leanStatus surfaces a pending changesetStatus without --full", () => {
  const detail = { id: "t1", status: "done", startedAt: "2026-07-29T00:00:00.000Z", exitCode: 0, signal: null, role: "dispatch", changesetStatus: "pending" };
  const lean = leanStatus(detail);
  assert.equal(lean.changesetStatus, "pending");
});

test("leanStatus omits changesetStatus when it's already resolved", () => {
  const detail = { id: "t1", status: "done", startedAt: "2026-07-29T00:00:00.000Z", exitCode: 0, signal: null, role: "dispatch", changesetStatus: "accepted" };
  const lean = leanStatus(detail);
  assert.equal(lean.changesetStatus, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/args.test.js src/commands.test.js src/output.test.js`
Expected: FAIL across all three files (unknown flags, unknown commands, unhandled RPC methods, missing lean field).

- [ ] **Step 3: Implement**

```js
// src/args.js -- commandSpecs: add "--no-overlay" to dispatch's options ONLY (lines 9-20).
// Review finding #5: advisor gets NO --no-overlay entry -- overlay is mandatory for the
// advisor role (ADR 0001). args.js's booleanCommands gate then rejects `taskferry advisor
// --no-overlay` with its standard "unknown flag" UsageError at parse time; a globally
// disabled overlay on an advisor dispatch fails closed daemon-side (Task 9's spawn path).
  dispatch: {
    // ...
    options: {
      // ...existing entries...
      "--no-sandbox": "run this dispatch without the bwrap filesystem sandbox (default: sandboxed on Linux)",
      "--no-overlay": "run this dispatch without the copy-on-write overlay (writes land directly, not gated by accept/reject)",
      // ...existing entries...
    },
  },
```

```js
// src/args.js -- commandSpecs: add "--diff" to result (lines 85-93)
  result: {
    usage: "taskferry result <id> [options]",
    description: "Read the final model result for a task.",
    options: {
      "--full": "include untruncated narration",
      "--fields <comma-list>": "request selected result fields",
      "--diff": "print the task's changeset diff (read-only; cannot combine with --fields)",
    },
    examples: ['taskferry result <id>', 'taskferry result <id> --full', 'taskferry result <id> --fields message,tokens', 'taskferry result <id> --diff'],
  },
```

```js
// src/args.js -- commandSpecs: add accept/reject entries, near cancel (after line 34)
  accept: {
    usage: "taskferry accept <id>",
    description: "Apply a dispatch task's pending changeset to its target directory.",
    options: {},
    examples: ['taskferry accept <id>'],
  },
  reject: {
    usage: "taskferry reject <id>",
    description: "Discard a task's pending changeset without applying it.",
    options: {},
    examples: ['taskferry reject <id>'],
  },
```

```js
// src/args.js -- defaultOptions(): extend dispatch/result, add accept/reject (lines 255-286).
// advisor stays UNCHANGED -- it gets no noOverlay default (review finding #5).
    case "dispatch":
      return { prompt: undefined, directory: cwd, model: undefined, variant: undefined, sessionId: undefined, keySlot: undefined, finalMarker: undefined, noSandbox: false, noOverlay: false, allowedDirs: undefined, executor: undefined };
    case "advisor":
      return { prompt: undefined, model: undefined, directory: undefined, variant: undefined, sessionId: undefined, timeoutMs: undefined, executor: undefined };
    case "cancel":
      return { taskId: undefined, graceMs: undefined };
    // ...
    case "result":
      return { taskId: undefined, full: false, fields: undefined, diff: false };
    // ...
    case "accept":
      return { taskId: undefined };
    case "reject":
      return { taskId: undefined };
```

```js
// src/args.js -- positional-taskId gate (line 318) and required-taskId check (line 429): add
// "accept"/"reject" to both lists
      if (!["cancel", "wait", "status", "tail", "summary", "result", "accept", "reject"].includes(command)) {
        throw usageError(`unexpected argument: ${token}`, command);
      }
```

```js
    if (["cancel", "wait", "status", "tail", "summary", "result", "accept", "reject"].includes(command) && !options.taskId) {
      throw usageError("task id is required", command);
    }
```

```js
// src/args.js -- booleanCommands map (lines 354-362): add --no-overlay and --diff
    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
      "--no-sandbox": ["dispatch"],
      "--no-overlay": ["dispatch"], // advisor deliberately excluded -- review finding #5
      "--diff": ["result"],
    };
    const booleanKeyOverrides = { "--no-sandbox": "noSandbox", "--no-overlay": "noOverlay" };
```

```js
// src/args.js -- new validation, alongside the existing result/--full+--fields check (line 434-436)
    if (command === "result" && options.diff && options.fields) {
      throw usageError("--diff cannot be combined with --fields", command);
    }
```

```js
// src/args.js -- commandAllows(): "cancel"/"status"/"doctor" already have empty arrays for their
// no-value-flag commands; accept/reject need no entry added here since they take no --flags at
// all (only the boolean-flag and positional paths apply). No change needed.
```

Now `src/commands.js`:

```js
// src/commands.js -- dispatch case (line 86-99): forward noOverlay
      return client.request("task.dispatch", {
        prompt: options.prompt,
        directory,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),
        ...(options.finalMarker === undefined ? {} : { finalMarker: options.finalMarker }),
        ...(options.noSandbox === undefined ? {} : { noSandbox: options.noSandbox }),
        ...(options.noOverlay === undefined ? {} : { noOverlay: options.noOverlay }),
        ...(options.allowedDirs === undefined ? {} : { allowedDirs: options.allowedDirs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
        ...(process.env.CLAUDE_CODE_SESSION_ID ? { originSessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      });
```

```js
// src/commands.js -- advisor case (line 145-155): unchanged -- no noOverlay forward.
// Review finding #5: --no-overlay is not parseable on advisor (args.js excludes it),
// so options.noOverlay can never be set here.
      return client.request("task.advisor", {
        prompt: options.prompt,
        directory,
        model: options.model,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
      });
```

```js
// src/commands.js -- result case (line 186-193): --diff overrides fields
    case "result": {
      const detail = await client.request("task.result", {
        ...(options.diff ? { fields: ["diff"] } : options.full ? { full: true } : {}),
        ...(!options.diff && options.fields ? { fields: options.fields } : {}),
        taskId: options.taskId,
      });
      return leanResult(detail, { full: options.full, fields: options.diff ? ["diff"] : options.fields });
    }
```

```js
// src/commands.js -- add accept/reject cases, next to "cancel" (after line 105)
    case "accept": {
      const accepted = await client.request("task.accept", { taskId: options.taskId });
      // Review finding #11: a failed cleanup must not be swallowed -- without
      // this, the leftover overlay is invisible until the daemon-restart sweep.
      if (accepted.cleanupFailed) process.stderr.write(`warning: changeset applied, but overlay cleanup failed -- ${accepted.taskId}'s overlay dir remains on disk (a daemon restart will sweep it)\n`);
      return accepted;
    }
    case "reject": {
      const rejected = await client.request("task.reject", { taskId: options.taskId });
      if (rejected.cleanupFailed) process.stderr.write(`warning: changeset rejected, but overlay cleanup failed -- ${rejected.taskId}'s overlay dir remains on disk (a daemon restart will sweep it)\n`);
      return rejected;
    }
```

`task.dispatch`'s `validParams` in `protocol.js` must also accept `noOverlay` — extend Task 13's work (this is a small addendum to Task 13's file, done here since it's part of this task's CLI-surface deliverable). **`task.advisor` deliberately does NOT accept `noOverlay`** (review finding #5 — a raw-RPC caller gets an `INVALID_PARAMS` rejection, matching the CLI layer):

```js
// src/protocol.js -- task.dispatch (line 84-95): add noOverlay. task.advisor (line 123-131): NO change.
    case "task.dispatch":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "keySlot", "finalMarker", "originSessionId", "noSandbox", "noOverlay", "allowedDirs", "executor"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && optional(params.model, isNonEmptyString)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.keySlot, isNonEmptyString)
        && optional(params.finalMarker, isNonEmptyString)
        && optional(params.originSessionId, isNonEmptyString)
        && optional(params.noSandbox, (value) => typeof value === "boolean")
        && optional(params.noOverlay, (value) => typeof value === "boolean")
        && optional(params.allowedDirs, (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry)))
        && optional(params.executor, (value) => typeof value === "string" && KNOWN_EXECUTORS.includes(value));
```

And `daemon.js`'s existing `task.dispatch` case (line 181-182) already forwards the whole `params` object or spreads it — check whether `noOverlay` needs an explicit add to the spread the same way `noSandbox`/`allowedDirs` currently do; if `task.dispatch` already does `manager.dispatch(params)` (whole-object passthrough, per the earlier read at `daemon.js:182`), no change is needed there. **The `task.advisor` case (line 206-215) gets no `noOverlay` line** — the protocol rejects the param before it ever reaches the daemon (review finding #5).

`advisor()` in `tasks.js` (Task 8) likewise takes **no `noOverlay` parameter at all** — its signature and internal `dispatch()` call stay exactly as Task 8 wrote them (`role: "advisor"`, no `noOverlay` key). The mandatory-overlay enforcement for advisors lives entirely in Task 9's spawn path, which catches the one remaining route to an ungated advisor: a *globally* disabled overlay (`overlayEnabled: false` / `TASKFERRY_DISABLE_OVERLAY=1`).

Finally, `src/output.js`:

```js
// src/output.js -- leanStatus() (lines 97-137): add changesetStatus alongside the existing
// conditional fields
export function leanStatus(detail, { full = false } = {}) {
  if (full) return detail;
  const {
    id,
    status,
    startedAt,
    exitCode,
    signal,
    logBytesWritten,
    logLastWriteAt,
    logHasEvent,
    outputTail,
    outputTailTotalChars,
    outputTailTruncated,
    timedOut,
    changesetStatus,
  } = detail;
  const lean = { id, status, startedAt };
  if (status !== "running" && status !== "queued") {
    lean.exitCode = exitCode;
    lean.signal = signal;
  }
  if (changesetStatus === "pending") {
    lean.changesetStatus = changesetStatus;
  }
  if (detail.changesetError) lean.changesetError = detail.changesetError;
  // ...existing logBytesWritten/outputTail blocks, unchanged...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/args.test.js src/commands.test.js src/output.test.js src/protocol.test.js src/daemon.test.js src/tasks.test.js`
Expected: PASS across all six files.

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/commands.js src/output.js src/protocol.js src/daemon.js src/tasks.js src/args.test.js src/commands.test.js src/output.test.js
git commit -m "feat(cli): add --no-overlay, result --diff, and accept/reject commands"
```

---

## Task 16: Run the full suite and fix any cross-file regressions

**Files:** none new — verification-only task.

- [ ] **Step 1: Run the entire suite**

Run: `npm test` (or `node --test src/`, matching whatever `package.json`'s `test` script actually invokes — check `package.json` first if unsure)
Expected: every test file passes, including files untouched by this plan (`activity.test.js`, `cli.test.js`, `events.test.js`, `executor.test.js`, `integrations.test.js`, `opencode-plugin.test.js`, `paths.test.js`, `setup.test.js`, `state-lock.test.js`) — this plan didn't intend to touch them, so a failure here means an unnoticed contract change (e.g. `summarize()`'s new conditional fields breaking a snapshot-style assertion elsewhere).

- [ ] **Step 2: Fix any regressions found**

If a test outside this plan's file list fails, read it, determine whether the new `role`/`changesetStatus`/`diff` fields broke an assumption it made (e.g. an exact-shape `assert.deepEqual` on a `summarize()`/`result()` output), and update that specific assertion to account for the new conditional field — do not weaken the assertion's intent (e.g. don't switch a `deepEqual` to a partial match just to make it pass; add the new field to the expected object instead).

- [ ] **Step 3: Commit** (only if Step 2 required changes)

```bash
git add -A
git commit -m "fix: reconcile pre-existing tests with the new changeset fields"
```

---

## Task 17: Documentation — `security.md`, `config.md`, `cli-reference.md`, `sourcemap.md`

**Files:**
- Modify: `docs/security.md:153-244`
- Modify: `docs/config.md:33-54`
- Modify: `docs/cli-reference.md` (locate the `result`/`cancel` entries and mirror their format)
- Modify: `docs/sourcemap.md:55-59, 103-106`

**Interfaces:** none — documentation only, no test cycle. Still bite-sized: each file is its own step so review can proceed file-by-file.

- [ ] **Step 1: `docs/security.md`**

Add two new subsections inside "Filesystem sandboxing (bubblewrap)" (after the existing "Opt out" bullet, `docs/security.md:238-244`):

```markdown
- **Copy-on-write overlay.** By default, the sandboxed target directory
  (and, for a git worktree, the scoped git-common-dir slice described
  above) is mounted as a copy-on-write overlay instead of a plain
  read-write bind: all writes and deletes land in a per-task upper layer
  under `/tmp/taskferry-cow-<task-id>/`, never on the real directory. This
  requires bwrap >= 0.8 (`--overlay-src`/`--overlay`); a host below that
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
  at all. An advisor's sandbox additionally runs with `--unshare-net`
  instead of `--share-net`, and its `runtimeDir` is bound read-only so the
  daemon's Unix socket (which lives there) is unreachable -- `--unshare-net`
  alone does not block Unix-domain-socket connects through a writable bind.
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
  only be rejected, never applied.
```

- [ ] **Step 2: `docs/config.md`**

Add one row to the fields table (`docs/config.md:50`, right after `sandboxEnabled`):

```markdown
| `overlayEnabled` | `TASKFERRY_DISABLE_OVERLAY` (inverted: `1`/`true` disables) | boolean | `true` |
```

- [ ] **Step 3: `docs/cli-reference.md`**

Add `--diff` to `result`'s option list and two new entries for `accept`/`reject`, matching this file's existing per-command format exactly (check `cancel`'s entry for the template before writing these).

- [ ] **Step 4: `docs/sourcemap.md`**

Update the `sandbox.js` row (`docs/sourcemap.md:56`) to mention `buildBwrapArgs()`'s new `overlay`/`overlayRwBinds`/`shareNet`/`runtimeDirWritable` params and `checkOverlaySupport()`. **A `changeset.js` row already exists at this point** — the Task 6 fix round added it early (same-PR sourcemap rule), so here VERIFY it covers the module's full export surface after Tasks 4-7 (path helpers, pre-dispatch HEAD, git/non-git diff extraction, apply, cleanup) and correct its line count; do not add a duplicate row. Update the `TASKFERRY_DISABLE_SANDBOX` env-var table entry's neighboring rows (`docs/sourcemap.md:103-106`) with a new `TASKFERRY_DISABLE_OVERLAY` row.

- [ ] **Step 5: Commit**

```bash
git add docs/security.md docs/config.md docs/cli-reference.md docs/sourcemap.md
git commit -m "docs: document the CoW overlay, diff-gated accept/reject, and overlayEnabled config"
```

---

## Task 18: `using-taskferry` skill — worktree question and commit-verification rewrite

**Files:**
- Modify: `integrations/claude/skills/using-taskferry/SKILL.md`

**Interfaces:** none — skill-doc only.

- [ ] **Step 1: Add the worktree-or-checkout question**

Insert a new section after "Sizing The Task Before Dispatching" (`integrations/claude/skills/using-taskferry/SKILL.md:27-37`) and before "Worker Contract":

```markdown
## Worktree Or Main Checkout

Every sandboxed ferry writes to a copy-on-write overlay, never the real
directory directly -- a rogue or mistaken dispatch cannot corrupt whatever
directory you point it at, worktree or not. Worktrees remain useful for two
unrelated reasons, not safety: branch isolation (parallel sessions on
different branches without a switch race) and lower-layer stability (a
concurrent edit to a live main checkout mutates the overlay's *lower* in
place while a ferry is in flight, which can make `accept` conflict later).
Ask which of those two applies before choosing; if neither does (a solo
session, one task at a time), dispatching straight at the main checkout is
fine.
```

- [ ] **Step 2: Rewrite "Verifying A Worker's Claimed Commit"**

Replace the entire section (`integrations/claude/skills/using-taskferry/SKILL.md:76-100`) with:

```markdown
## Verifying A Worker's Claimed Changeset

A worker's final `Status:` line and narration are not evidence of what it
wrote -- only the extracted changeset is. Every sandboxed dispatch writes
to an overlay, not the real directory: `git -C "<worktree>" log`/`status`
against the real worktree will show nothing until you explicitly accept,
regardless of how good or bad the worker's actual changes were. After every
settled implementer/fixer dispatch, before treating the task as done:

```sh
taskferry result <id> --diff
```

If the diff matches what the worker claims (a `Status: DONE` describing a
specific change, matched by an actual diff doing that change), accept it:

```sh
taskferry accept <id>
```

*Then* the ordinary `git -C "<worktree>" log --oneline origin/main..HEAD` /
`git -C "<worktree>" status --short` checks become meaningful again, since
the diff has now actually landed.

If `accept` itself fails (a conflicting `git apply` -- the lower moved
under a long-running ferry, see "Worktree Or Main Checkout" above), don't
re-dispatch reflexively: `taskferry result <id> --diff` still has the
worker's changes, so resolve the conflict by hand or reject and retry with
a fresh dispatch against the now-current directory.

If the diff itself is missing, wrong, or incomplete relative to the
worker's claim, reject it and re-dispatch:

```sh
taskferry reject <id>
```

A worker's `git commit` made *inside* the sandbox is never preserved as a
commit -- it's flattened into the same diff an uncommitted edit would
produce, and only survives if you `accept`. There is no more
"sandboxed `git commit` failed silently" failure mode to route around: a
commit was never going to land as a commit in the first place, by design,
not by an environment quirk.

This generalizes past just diffs: any deliverable a worker claims to have
produced (a written file, a pushed branch, a passed test run) is a claim to
verify independently, not to accept on narration alone.
```

Preserve everything after the original section's line 100 (whatever follows "This generalizes past just commits" in the current file) unless it specifically depends on the old git-log-against-the-real-worktree assumption — check the following ~10 lines for that dependency before leaving them untouched.

- [ ] **Step 3: Commit**

```bash
git add integrations/claude/skills/using-taskferry/SKILL.md
git commit -m "docs(using-taskferry): add the worktree question and rewrite changeset verification"
```

Do **not** edit `/home/jeremy/.claude-qwen/skills/using-git-worktrees-addendum/SKILL.md` as part of this plan (out of repo, flagged as a manual follow-up per the spec's §8).

---

## Task 19: Linux-gated integration tests — real bwrap overlay round trips (review finding #14)

**Files:**
- Create: `src/changeset.integration.test.js`
- Modify: `package.json` (`test:unit` script — hardcoded file list, NOT a glob; see the Task 4 gotcha)

**Why this task exists:** every test in Tasks 1-18 mocks `runCommand`/`spawnFn`. This feature's entire purpose is filesystem containment, so the plan needs at least one suite that runs a *real* `bwrap` overlay end-to-end — write inside the sandbox, extract, apply, verify the real directory, clean up. Review finding #14. The suite is Linux-gated with a capability probe so hosts without `bwrap >= 0.8` (and CI images that lack it) skip cleanly instead of failing.

**Interfaces:**
- Consumes: the real `buildBwrapArgs` (Task 2), `overlayPaths`/`subOverlayPaths` (Task 4), `resolvePreDispatchHead`/`extractGitDiff` (Task 5), `buildMergedViewBwrapArgs`/`extractNonGitDiff` (Task 6), `applyChangeset`/`cleanupOverlay` (Task 7), the real `defaultRunCommand` (exported by Task 10's Step 3a).
- Produces: `src/changeset.integration.test.js` with three round-trip tests and a capability skip guard.

- [ ] **Step 1: Write the tests**

```js
// src/changeset.integration.test.js -- new file
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildBwrapArgs, checkOverlaySupport } from "./sandbox.js";
import { applyChangeset, cleanupOverlay, extractGitDiff, extractNonGitDiff, overlayPaths, resolvePreDispatchHead, subOverlayPaths } from "./changeset.js";

// Skip the whole suite unless this host can actually run overlays: Linux,
// bwrap >= 0.8, and (for the non-git round trip) a real rsync. A missing
// capability is an environment fact, not a test failure.
const support = process.platform === "linux" ? checkOverlaySupport() : { supported: false, reason: "not linux" };
const rsyncAvailable = spawnSync("rsync", ["--version"], { encoding: "utf8" }).status === 0;
const skipReason = support.supported ? (rsyncAvailable ? null : "rsync not installed") : support.reason;
const skip = skipReason ? { skip: `overlay integration skipped: ${skipReason}` } : undefined;

// Runs one real bwrap invocation against a directory mounted as a CoW
// overlay (plus any sub-overlays), executing `script` inside.
function runInOverlay({ directory, overlay, overlayRwBinds = [], script, runtimeDir, homeDir }) {
  const args = buildBwrapArgs({ directory, stateDir: os.tmpdir(), runtimeDir, homeDir, denyList: [], overlay: { upperDir: overlay.upperDir, workDir: overlay.workDir }, overlayRwBinds });
  return spawnSync("bwrap", [...args, "--", "sh", "-c", script], { encoding: "utf8" });
}

describe("overlay round trips (real bwrap)", () => {
  test("git target: sandboxed write + commit extracts as one flattened diff, applies, cleans up", skip ? undefined : () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-git-"));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-tmp-"));
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-run-"));
    spawnSync("git", ["init", "-q", directory]);
    fs.writeFileSync(path.join(directory, "tracked.txt"), "base\n");
    spawnSync("git", ["-C", directory, "add", "-A"]);
    spawnSync("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const preDispatchHead = resolvePreDispatchHead(directory);
    assert.ok(preDispatchHead, "fixture repo must have a HEAD");

    const overlay = overlayPaths("int_git", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    // A worker that both edits and commits: the commit must flatten into the
    // same working-tree-style diff (spec §2), anchored on preDispatchHead.
    const ran = runInOverlay({
      directory, overlay, runtimeDir, homeDir: os.homedir(),
      script: `echo changed >> ${directory}/tracked.txt && echo new > ${directory}/added.txt && git -C ${directory} add -A && git -C ${directory} -c user.email=t@t -c user.name=t commit -qm worker`,
    });
    assert.equal(ran.status, 0, `sandboxed worker script failed: ${ran.stderr}`);
    // The real directory must be untouched before accept -- the whole point.
    assert.equal(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"), "base\n");
    assert.equal(fs.existsSync(path.join(directory, "added.txt")), false);

    const diffPath = path.join(tmpRoot, "int_git.patch");
    const extracted = extractGitDiff({ directory, overlay, overlayRwBinds: [], preDispatchHead, stateDir: tmpRoot, runtimeDir, homeDir: os.homedir(), denyList: [], diffPath });
    assert.equal(extracted.hasChanges, true);
    assert.match(fs.readFileSync(diffPath, "utf8"), /\+changed/);
    assert.match(fs.readFileSync(diffPath, "utf8"), /added\.txt/);

    const applied = applyChangeset({ directory, diffPath, isGitTarget: true });
    assert.deepEqual(applied, { applied: true, reason: null });
    assert.equal(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"), "base\nchanged\n");
    assert.equal(fs.existsSync(path.join(directory, "added.txt")), true);
    // Applied as a working-tree diff, NOT replayed as the worker's commit.
    const log = spawnSync("git", ["-C", directory, "log", "--oneline"], { encoding: "utf8" }).stdout;
    assert.ok(!log.includes("worker"), "the worker's commit must not land as a commit");

    const removal = cleanupOverlay({ root: overlay.root, tmpRoot });
    assert.equal(removal.removed, true);
    assert.equal(fs.existsSync(overlay.root), false);
  });

  test("worktree-shaped target: git-common-dir sub-overlays capture .git-metadata writes (regression: review finding #1)", skip ? undefined : () => {
    // A real linked worktree: its private admin dir + shared objects/refs
    // live outside the working directory, so commits need sub-overlays
    // (Task 9's overlayRwBinds). Extraction must re-mount those same
    // sub-overlays or the commit's metadata writes are invisible.
    const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-main-"));
    spawnSync("git", ["init", "-q", mainRepo]);
    fs.writeFileSync(path.join(mainRepo, "f.txt"), "one\n");
    spawnSync("git", ["-C", mainRepo, "add", "-A"]);
    spawnSync("git", ["-C", mainRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-wt-")), "wt");
    spawnSync("git", ["-C", mainRepo, "worktree", "add", "-q", worktree, "-b", "wt-branch"]);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-tmp-"));
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-run-"));
    const preDispatchHead = resolvePreDispatchHead(worktree);
    const overlay = overlayPaths("int_subovl", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    // Mirror Task 9's sub-overlay selection for a linked worktree.
    const gitCommonDir = path.join(mainRepo, ".git");
    const gitDir = path.join(gitCommonDir, "worktrees", path.basename(worktree));
    const overlayRwBinds = [gitDir, path.join(gitCommonDir, "objects"), path.join(gitCommonDir, "refs"), path.join(gitCommonDir, "logs", "refs")]
      .map((p) => { const sub = subOverlayPaths(overlay.root, p); fs.mkdirSync(sub.upperDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(sub.workDir, { recursive: true, mode: 0o700 }); return sub; });

    const ran = runInOverlay({
      directory: worktree, overlay, overlayRwBinds, runtimeDir, homeDir: os.homedir(),
      script: `echo two >> ${worktree}/f.txt && git -C ${worktree} add -A && git -C ${worktree} -c user.email=t@t -c user.name=t commit -qm wt-worker`,
    });
    assert.equal(ran.status, 0, `sandboxed worktree commit failed: ${ran.stderr}`);
    // The shared object store must NOT have gained the worker's commit yet.
    assert.ok(!spawnSync("git", ["-C", mainRepo, "log", "--all", "--oneline"], { encoding: "utf8" }).stdout.includes("wt-worker"));

    const diffPath = path.join(tmpRoot, "int_subovl.patch");
    const extracted = extractGitDiff({ directory: worktree, overlay, overlayRwBinds, preDispatchHead, stateDir: tmpRoot, runtimeDir, homeDir: os.homedir(), denyList: [], diffPath });
    assert.equal(extracted.hasChanges, true, "with overlayRwBinds re-mounted, the flattened commit diff must be visible");
    assert.match(fs.readFileSync(diffPath, "utf8"), /\+two/);
    cleanupOverlay({ root: overlay.root, tmpRoot });
  });

  test("non-git target: sandboxed write extracts a diff -ru, rsync-applies, cleans up", skip ? undefined : () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-nongit-"));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-tmp-"));
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-run-"));
    fs.writeFileSync(path.join(directory, "keep.txt"), "stays\n");
    fs.writeFileSync(path.join(directory, "edit.txt"), "before\n");

    const overlay = overlayPaths("int_nongit", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    const ran = runInOverlay({
      directory, overlay, runtimeDir, homeDir: os.homedir(),
      script: `echo after > ${directory}/edit.txt && echo brand-new > ${directory}/new.txt && rm ${directory}/keep.txt`,
    });
    assert.equal(ran.status, 0, `sandboxed worker script failed: ${ran.stderr}`);
    assert.equal(fs.readFileSync(path.join(directory, "edit.txt"), "utf8"), "before\n");

    const diffPath = path.join(tmpRoot, "int_nongit.patch");
    const extracted = extractNonGitDiff({ directory, overlay, stateDir: tmpRoot, runtimeDir, homeDir: os.homedir(), denyList: [], diffPath });
    assert.equal(extracted.hasChanges, true);
    const patch = fs.readFileSync(diffPath, "utf8");
    assert.match(patch, /brand-new/);
    assert.match(patch, /Only in|keep\.txt/); // the deletion surfaces one way or the other

    const applied = applyChangeset({ directory, diffPath, isGitTarget: false, overlay, stateDir: tmpRoot, runtimeDir, homeDir: os.homedir(), denyList: [] });
    assert.deepEqual(applied, { applied: true, reason: null });
    assert.equal(fs.readFileSync(path.join(directory, "edit.txt"), "utf8"), "after\n");
    assert.equal(fs.readFileSync(path.join(directory, "new.txt"), "utf8"), "brand-new\n");
    assert.equal(fs.existsSync(path.join(directory, "keep.txt")), false, "whiteout-implied deletions must land");
    cleanupOverlay({ root: overlay.root, tmpRoot });
  });
});
```

(`test(name, undefined)` is how `node:test` receives "no options, run normally" here — if the version in use prefers `test(name, fn)` unconditionally, branch on `skipReason` with an explicit `test.skip(...)` instead; match whatever the repo's other skipped-on-platform tests do, if any exist.)

- [ ] **Step 2: Wire it into the test script (Task 4 gotcha)**

`package.json`'s `test:unit` script is a **hardcoded file list, not a glob** — Task 4's fix round caught exactly this silent-drop for `changeset.test.js`. Add `src/changeset.integration.test.js` to that list in the same commit.

- [ ] **Step 3: Run and verify**

Run: `node --test src/changeset.integration.test.js`
Expected on this host (bwrap 0.11.2, rsync present): all three tests PASS — a real overlay write never touches the real directory pre-apply, extraction sees sub-overlay writes, apply lands everything including deletions, cleanup removes the tree. On a host without the capabilities: the suite reports as skipped with the reason, and `npm test` stays green.

- [ ] **Step 4: Commit**

```bash
git add src/changeset.integration.test.js package.json
git commit -m "test(changeset): add Linux-gated real-bwrap overlay round-trip tests"
```

---

## Explicitly out of scope for this plan

- The pi executor's missing-command-input audit gap (spec §11) — file as its own GitHub issue, don't fold into this work.
- Any change to the `using-git-worktrees-addendum` skill outside this repo.
- The exact `rsync` vs. hand-rolled whiteout-aware copier choice for non-git apply is locked in as `rsync -a --delete --delay-updates` by Task 7 above (the spec left this open; this plan resolves it, since a plan can't ship a TBD). `--delay-updates` makes file updates near-atomic on an interrupted apply (review finding #9); full transactionality — including incremental deletions — remains out of scope, with the preserved overlay on failed apply as the retry path.
