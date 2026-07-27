# Git-Workspace-Scoped Fleet Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give observation commands (`list`, `watch`, `context`, `advisor`, `home`) a default directory scoped to the whole git workspace root instead of literal cwd, and add `watch --flush-interval` so periodic batched fleet updates can be surfaced through the harness `Monitor` tool instead of a per-event firehose.

**Architecture:** A new `resolveWorkspaceRoot(startDir, { runCommand, warn })` helper in `src/paths.js` reuses the existing `resolveGitCommonDir` (`src/sandbox.js`) to find the repo root, falling back to `startDir` unchanged (with a once-per-process stderr warning) outside a git repo. That helper is wired into the *default* directory resolution for five commands, in every layer that currently computes that default — `args.js`'s `defaultOptions()`, `cli.js`'s pre-normalization block, and `commands.js`'s per-command fallback expressions. `dispatch`'s directory resolution is untouched everywhere. Separately, `watch --flush-interval <duration>` buffers `task.activity`/`task.state` events in a `Map<taskId, event>` and flushes them as one batch on a timer instead of writing immediately.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), no new dependencies. Depends on `parseDuration` from the duration-flags work (already on this branch).

## Global Constraints

- `dispatch`'s directory resolution (explicit `--directory`, else literal cwd) is completely unchanged — no swap to `resolveWorkspaceRoot` anywhere in `args.js`, `cli.js`, or `commands.js` for the `dispatch` case. It is the one call site of the `options.directory || <default>` pattern that keeps `cwd` as the fallback.
- Only the five observation commands (`home`, `list`, `watch`, `context`, `advisor`) get the new default. `list --all` (directory forced to `undefined`, all workspaces) and `watch --task-id` without an explicit `--directory` (directory resolved server-side from the task) keep their existing special-cased behavior untouched.
- `normalizeDirectory`'s `fs.realpathSync` canonicalization is what keeps directory strings comparable across callers for the daemon's exact-string matching (`src/daemon.js`'s `filteredTaskDetails` and `onEvent` subscription filter) — every call site below still routes its final value through `normalizeDirectory`, `resolveWorkspaceRoot` itself is never pre-normalized.
- `--flush-interval` is `watch`-only, requires `--summaries` (rejected otherwise with a `UsageError`), and is parsed with the existing `parseDuration` helper (accepts milliseconds or `30s`/`5m`/`1h`).
- No compound duration strings, decimals, or other `parseDuration` extensions — out of scope per the duration-flags spec.
- `originSessionId` stays in the protocol, unused by this feature — no removal or renaming of it or its existing tests (`src/daemon.js`, `src/daemon.test.js`).
- **Deviation from the design spec, decided during planning:** `.superpowers/specs/2026-07-27-fleet-monitor-design.md`'s Component 2 describes the directory-default change as a `commands.js`-only edit. Reading the actual code surfaced two gaps the spec didn't account for, both confirmed by direct inspection, not assumption:
  1. `src/args.js`'s `defaultOptions()` already pre-fills `directory: cwd` (a truthy value) for `list`, `context`, `advisor`, and the `home` fast-paths — only `watch` leaves it `undefined`. A `commands.js`-only fix would be dead code for the other four commands, since `options.directory || resolveWorkspaceRoot(cwd)` never reaches its fallback branch when `options.directory` is never falsy.
  2. `src/cli.js` (the CLI's actual entrypoint) independently *pre-normalizes* `parsed.options.directory` with the exact same `normalizeDirectory(parsed.options.directory || cwd)` pattern, before `commands.js`'s `runCommand` is ever invoked — and `runCommand` has exactly one production caller, `cli.js`. Fixing `commands.js` alone, without also fixing `cli.js`, would ship a feature that is a complete no-op in the real binary.

  Task 2 below fixes all three layers (`args.js`, `cli.js`, `commands.js`) together, since a fix to any one alone does nothing observable.

---

## File Structure

- **Create `src/paths.test.js`**: new test file for `resolveWorkspaceRoot`.
- **Modify `src/paths.js`**: add `resolveWorkspaceRoot(startDir, { runCommand, warn })`, importing `resolveGitCommonDir`/`defaultRunCommand` from `src/sandbox.js`.
- **Modify `src/args.js`**: fix `defaultOptions()`'s `list`/`context`/`advisor` cases and the two `home` fast-paths in `parseArgs` to leave `directory: undefined` (matching `watch`'s existing pattern) instead of pre-filling `cwd`; add the `--flush-interval` flag to `watch` (`commandSpecs`, `defaultOptions`, `values` map, `commandAllows`, parsing, and the `requires --summaries` validation).
- **Modify `src/cli.js`**: split the pre-normalization block so `dispatch` keeps plain `cwd` while `home`/`advisor`/`watch` (non-`--task-id`)/`context`/`list` (non-`--all`) use `resolveWorkspaceRoot(cwd)`; add a `resolveWorkspaceRoot` injection point to `runCli`'s options for testability.
- **Modify `src/commands.js`**: swap `cwd` for `resolveWorkspaceRootFn(cwd)` in the `home`/`advisor`/`list`/`context` cases and `watchCommand`'s non-`--task-id` branch; add a `resolveWorkspaceRoot` injection point to `runCommand`'s options, threaded through to `watchCommand`; add `flushIntervalMs` buffering to `streamTaskEvents`.
- **Modify `docs/cli-reference.md`**: update the `--directory` descriptions for `list`/`watch`/`context`/`advisor` to describe the new default; document `--flush-interval`.
- **Modify `skills/using-taskferry/SKILL.md`** (canonical): document the auto-arm convention (first dispatch backgrounds `taskferry watch --summaries --flush-interval 5m` and registers it with `Monitor`).
- **Regenerate** `integrations/claude/skills/using-taskferry/SKILL.md` and `integrations/codex/skills/using-taskferry/SKILL.md` via `npm run skill:generate`, verified with `npm run skill:check`.
- **Modify `docs/integrations/claude-code.md`**: cross-reference the auto-arm convention from its "Using taskferry as an external worker backend" section.

---

### Task 1: `resolveWorkspaceRoot` helper

**Files:**
- Modify: `src/paths.js`
- Test: `src/paths.test.js` (new)

**Interfaces:**
- Produces: `resolveWorkspaceRoot(startDir: string, options?: { runCommand?: RunCommandFn, warn?: (message: string) => void }): string` — exported from `src/paths.js`. `RunCommandFn` matches `src/sandbox.js`'s existing `(command: string, args: readonly string[]) => {status, stdout, stderr, error?}` shape (same type `resolveGitCommonDir` already takes). Returns the git workspace root (parent of `--git-common-dir`) when inside a repo, else `startDir` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to a new file `src/paths.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceRoot } from "./paths.js";

test("resolves the parent directory of the git-common-dir for a plain repo", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo", { runCommand }), "/workspace/repo");
});

test("resolves a nested worktree (.worktrees/x) to the main checkout's root, not the worktree's own directory", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo/.worktrees/issue-1", { runCommand }), "/workspace/repo");
});

test("resolves a sibling worktree (git worktree add ../repo-feat) to the main checkout's root", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo-feat", { runCommand }), "/workspace/repo");
});

test("treats a submodule as its own repo boundary, not the parent repo's root", () => {
  const runCommand = () => ({ status: 0, stdout: "/workspace/repo/.git/modules/vendor-lib\n", stderr: "" });
  assert.equal(resolveWorkspaceRoot("/workspace/repo/vendor-lib", { runCommand }), "/workspace/repo/.git/modules");
});

test("falls back to the input directory unchanged when no git repo is found, warning once per process (not once per call)", () => {
  const warnings = [];
  const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
  const warn = (message) => warnings.push(message);
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-1", { runCommand, warn }), "/tmp/not-a-repo-1");
  assert.equal(resolveWorkspaceRoot("/tmp/not-a-repo-2", { runCommand, warn }), "/tmp/not-a-repo-2");
  assert.equal(warnings.length, 1, "the warning must fire once per process, not once per call");
  assert.match(warnings[0], /no git repository found for \/tmp\/not-a-repo-1/);
});

test("uses the real defaultRunCommand and process.stderr.write when no overrides are given", () => {
  // Exercises the real default path (this repo's own checkout is a git repo),
  // proving the defaults are wired correctly without needing a fake.
  const root = resolveWorkspaceRoot(process.cwd());
  assert.equal(typeof root, "string");
  assert.ok(root.length > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/paths.test.js`
Expected: FAIL with `resolveWorkspaceRoot is not a function` (or a similar import error) — `src/paths.js` does not export it yet.

- [ ] **Step 3: Implement `resolveWorkspaceRoot`**

In `src/paths.js`, add the import and function (append near the bottom, after `resolveCacheDir`):

```javascript
import { resolveGitCommonDir, defaultRunCommand } from "./sandbox.js";
```

(Add this to the existing import block at the top of the file, alongside `fs`/`os`/`path`/`UsageError`.)

```javascript
// Emitted at most once per process: a startup-time git lookup failing
// repeatedly for the same reason (no git repo anywhere in the workspace)
// would otherwise spam stderr on every observation-command invocation.
let hasWarnedNoGitRepo = false;

/**
 * Resolves the git workspace root for `startDir`: the parent directory of
 * `git rev-parse --git-common-dir`, which already correctly handles nested
 * (`.worktrees/x`) and sibling (`git worktree add ../x`) worktree layouts,
 * and treats submodules as their own repo boundary the same way plain git
 * does. Falls back to `startDir` unchanged (today's existing default
 * behavior) when no git repository is found, warning once per process.
 * @param {string} startDir
 * @param {object} [options]
 * @param {(command: string, args: readonly string[]) => {status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} [options.runCommand]
 * @param {(message: string) => void} [options.warn]
 * @returns {string}
 */
export function resolveWorkspaceRoot(startDir, { runCommand = defaultRunCommand, warn = (message) => process.stderr.write(`${message}\n`) } = {}) {
  const gitCommonDir = resolveGitCommonDir(startDir, runCommand);
  if (gitCommonDir) return path.dirname(gitCommonDir);
  if (!hasWarnedNoGitRepo) {
    hasWarnedNoGitRepo = true;
    warn(`no git repository found for ${startDir}; using it directly`);
  }
  return startDir;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/paths.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/paths.js src/paths.test.js
git commit -m "feat(paths): add resolveWorkspaceRoot git-workspace-root helper"
```

---

### Task 2: Wire `resolveWorkspaceRoot` into the observation commands' default directory

**Files:**
- Modify: `src/args.js`
- Modify: `src/cli.js`
- Modify: `src/commands.js`
- Modify: `docs/cli-reference.md`
- Test: `src/args.test.js`
- Test: `src/cli.test.js`
- Test: `src/commands.test.js`

**Interfaces:**
- Consumes: `resolveWorkspaceRoot` from Task 1 (`src/paths.js`).
- Produces: `runCli`'s options gain an optional `resolveWorkspaceRoot` override (defaults to the real one). `runCommand`'s options (in `src/commands.js`) gain the same, threaded through to `watchCommand`. Task 3 consumes this same injection point when it extends `watchCommand`/`streamTaskEvents`.

- [ ] **Step 1: Write the failing tests**

In `src/args.test.js`, replace the existing default-options test (currently asserting `directory` equals `cwd` for `advisor`/`list`) — find and update this block:

```javascript
test("parses each command's required arguments and defaults", () => {
  const cwd = "/workspace/project";
  assert.equal(parseArgs(["cancel", "oc_1"]).options.taskId, "oc_1");
  assert.deepEqual(parseArgs(["wait", "oc_1"]).options, { taskId: "oc_1", timeoutMs: undefined, tailChars: undefined, full: false, summarize: false });
  assert.equal(parseArgs(["advisor", "--prompt", "help", "--model", "test/model"], { cwd }).options.directory, undefined);
  assert.equal(parseArgs(["status", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["tail", "oc_1"]).options.chars, undefined);
  assert.equal(parseArgs(["summary", "oc_1"]).options.mode, "report");
  assert.equal(parseArgs(["result", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["list"], { cwd }).options.directory, undefined);
  assert.equal(parseArgs(["watch"], { cwd }).options.format, "toon");
  assert.equal(parseArgs(["context"], { cwd }).options.directory, undefined);
  assert.equal(parseArgs(["doctor"]).options.full, false);
});
```

Add a new test for the `home` fast-paths (empty argv and bare `--help`):

```javascript
test("home's default directory is left undefined (resolved later via resolveWorkspaceRoot), for both the empty-argv and bare --help fast-paths", () => {
  assert.equal(parseArgs([], { cwd: "/workspace/project" }).options.directory, undefined);
  assert.equal(parseArgs(["--help"], { cwd: "/workspace/project" }).options.directory, undefined);
});

test("dispatch's default directory stays literal cwd, unaffected by the observation-command directory default change", () => {
  assert.equal(parseArgs(["dispatch", "--prompt", "x"], { cwd: "/workspace/project" }).options.directory, "/workspace/project");
});
```

In `src/commands.test.js`, add (near the other `watch`/`list` tests):

```javascript
test("list resolves its default directory via resolveWorkspaceRoot when --directory is omitted", async () => {
  const cwd = "/some/subdir";
  const resolvedRoot = "/some/repo/root";
  let calledWith;
  const resolveWorkspaceRootFn = (dir) => { calledWith = dir; return resolvedRoot; };
  const client = { request: async (method, params) => {
    assert.equal(method, "task.list");
    assert.equal(params.directory, resolvedRoot);
    return { counts: {}, tasks: [] };
  } };
  await runCommand("list", { directory: undefined, all: false, limit: undefined }, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
  assert.equal(calledWith, cwd);
});

test("home/advisor/context all resolve their default directory via resolveWorkspaceRoot when --directory is omitted", async () => {
  const cwd = "/some/subdir";
  const resolvedRoot = "/some/repo/root";
  const resolveWorkspaceRootFn = () => resolvedRoot;
  let seenDirectory;
  const clientFor = (method) => ({ request: async (m, params) => {
    assert.equal(m, method);
    seenDirectory = params.directory;
    return method === "task.list" ? { counts: {}, tasks: [] } : {};
  } });

  await runCommand("home", { directory: undefined }, { client: clientFor("task.list"), cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
  assert.equal(seenDirectory, resolvedRoot);

  await runCommand("advisor", { directory: undefined, prompt: "p", model: "m" }, { client: clientFor("task.advisor"), cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
  assert.equal(seenDirectory, resolvedRoot);

  await runCommand("context", { directory: undefined, format: "toon" }, { client: clientFor("task.context"), cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
  assert.equal(seenDirectory, resolvedRoot);
});

test("watch resolves its default directory via resolveWorkspaceRoot when --directory and --task-id are both omitted", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const resolveWorkspaceRootFn = (dir) => { assert.equal(dir, "/some/subdir"); return root; };
  const controller = new AbortController();
  let subscribedDirectory;
  const client = fakeClient({
    onSubscribe: (params, onEvent) => {
      subscribedDirectory = params.directory;
      controller.abort();
    },
  });
  const io = fakeIo();

  await runCommand("watch", { directory: undefined, format: "toon", summaries: false, taskId: undefined }, {
    client,
    io,
    signal: controller.signal,
    cwd: "/some/subdir",
    resolveWorkspaceRoot: resolveWorkspaceRootFn,
  });

  assert.equal(subscribedDirectory, root);
});

test("dispatch does NOT resolve via resolveWorkspaceRoot (regression test pinning the launch-directory behavior as unchanged)", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let called = false;
  const resolveWorkspaceRootFn = () => { called = true; return "/should/never/be/used"; };
  let seenDirectory;
  const client = { request: async (method, params) => {
    assert.equal(method, "task.dispatch");
    seenDirectory = params.directory;
    return { id: "oc_1", status: "queued" };
  } };
  const checkSkills = () => {};

  await runCommand("dispatch", { directory: undefined, prompt: "p" }, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn, checkSkills });

  assert.equal(called, false, "dispatch must never consult resolveWorkspaceRoot");
  assert.equal(seenDirectory, cwd);
});
```

In `src/cli.test.js`, add a real end-to-end test (no injection — proves the wiring works with the real default):

```javascript
test("list with no --directory resolves to this checkout's git workspace root via the real resolveWorkspaceRoot", async () => {
  const capture = capturedIo();
  const workspace = process.cwd();
  const { client, calls } = fakeClient({
    "task.list": { directory: workspace, counts: {}, tasks: [] },
  });
  const result = await runCli(["list"], {
    cwd: workspace,
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  // This checkout's cwd during `npm test` is already the repo root, so
  // resolveWorkspaceRoot(workspace) === workspace here -- this proves the
  // real (non-injected) resolveWorkspaceRoot is wired in and behaves
  // correctly for the at-repo-root case, without needing a temp git repo.
  assert.deepEqual(calls, [{ method: "task.list", params: { directory: workspace } }]);
});

test("dispatch's directory is never passed through resolveWorkspaceRoot even when injected", async () => {
  const capture = capturedIo({ stdin: fakeTtyStdin() });
  const workspace = process.cwd();
  const { client, calls } = fakeClient({ "task.dispatch": { id: "oc_1", status: "queued" } });
  let called = false;
  const result = await runCli(["dispatch", "--prompt", "hi"], {
    cwd: workspace,
    io: capture.io,
    connectClient: async () => client,
    resolveWorkspaceRoot: () => { called = true; return "/should/never/be/used"; },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(called, false);
  assert.equal(calls[0].params.directory, workspace);
});
```

(`fakeClient` in `src/cli.test.js` already exists near the top of the file — reuse it. Add `import fs from "node:fs"; import path from "node:path"; import os from "node:os";` to `src/commands.test.js` only if not already imported — they already are, per the existing `fakeIo`/`fakeClient` helpers at the top of that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/args.test.js src/commands.test.js src/cli.test.js`
Expected: FAIL — the new/updated assertions expect `undefined`/`resolvedRoot` but the current code still returns `cwd` directly; `resolveWorkspaceRoot` is not yet an accepted option on `runCommand`/`runCli`.

- [ ] **Step 3: Fix `src/args.js`'s `defaultOptions()` and `home` fast-paths**

In `defaultOptions()`, change:

```javascript
    case "advisor":
      return { prompt: undefined, model: undefined, directory: cwd, variant: undefined, sessionId: undefined, timeoutMs: undefined, executor: undefined };
```
to:
```javascript
    case "advisor":
      return { prompt: undefined, model: undefined, directory: undefined, variant: undefined, sessionId: undefined, timeoutMs: undefined, executor: undefined };
```

Change:
```javascript
    case "list":
      return { directory: cwd, all: false, limit: undefined };
```
to:
```javascript
    case "list":
      return { directory: undefined, all: false, limit: undefined };
```

Change:
```javascript
    case "context":
      return { directory: cwd, format: "toon" };
```
to:
```javascript
    case "context":
      return { directory: undefined, format: "toon" };
```

(`dispatch`'s case keeps `directory: cwd` unchanged — do not touch it. `watch`'s case already has `directory: undefined` — do not touch it either.)

In `parseArgs`, change both `home` fast-paths:

```javascript
  if (!argv.length) {
    return { command: "home", options: { directory: cwd }, help: false, helpText: helpText() };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 1) throw usageError(`unexpected argument: ${argv[1]}`);
    return { command: "home", options: { directory: cwd }, help: true, helpText: helpText() };
  }
```
to:
```javascript
  if (!argv.length) {
    return { command: "home", options: { directory: undefined }, help: false, helpText: helpText() };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 1) throw usageError(`unexpected argument: ${argv[1]}`);
    return { command: "home", options: { directory: undefined }, help: true, helpText: helpText() };
  }
```

- [ ] **Step 4: Fix `src/cli.js`'s pre-normalization block**

Add `resolveWorkspaceRoot` to `runCli`'s options and its dynamic import, and split the `dispatch` case out on its own:

```javascript
export async function runCli(argv = process.argv.slice(2), {
  io = process,
  cwd = process.cwd(),
  env = process.env,
  executablePath = process.argv[1],
  connectClient: connectClientFn,
  setup: setupFn = runSetup,
  signal,
  runShellCommand,
  homeDirectory = os.homedir(),
  resolveWorkspaceRoot: resolveWorkspaceRootFn,
} = {}) {
```

(Add `resolveWorkspaceRoot: resolveWorkspaceRootFn` to the destructured parameter list above, right after `homeDirectory`.)

```javascript
  const [{ runCommand }, { normalizeDirectory, resolveWorkspaceRoot }, { connectClient: defaultConnectClient }, { writeError, writeToon }] = await Promise.all([
    import("./commands.js"),
    import("./paths.js"),
    import("./client.js"),
    import("./output.js"),
  ]);
  const connectClient = connectClientFn || defaultConnectClient;
  const resolveRoot = resolveWorkspaceRootFn || resolveWorkspaceRoot;
```

Replace the pre-normalization block:

```javascript
    const watchNeedsTaskIdResolution = parsed.command === "watch" && parsed.options.taskId && !parsed.options.directory;
    if (parsed.command === "home"
      || parsed.command === "dispatch"
      || parsed.command === "advisor"
      || (parsed.command === "watch" && !watchNeedsTaskIdResolution)
      || parsed.command === "context"
      || (parsed.command === "list" && !parsed.options.all)) {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    }
```
with:
```javascript
    const watchNeedsTaskIdResolution = parsed.command === "watch" && parsed.options.taskId && !parsed.options.directory;
    if (parsed.command === "dispatch") {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    } else if (parsed.command === "home"
      || parsed.command === "advisor"
      || (parsed.command === "watch" && !watchNeedsTaskIdResolution)
      || parsed.command === "context"
      || (parsed.command === "list" && !parsed.options.all)) {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || resolveRoot(cwd));
    }
```

Finally, thread `resolveWorkspaceRoot` through to `runCommand`'s call further down:

```javascript
    const value = await runCommand(parsed.command, parsed.options, {
      client,
      io,
      signal,
      executablePath,
      cwd,
      runShellCommand,
      env,
      homeDirectory,
      resolveWorkspaceRoot: resolveRoot,
    });
```

- [ ] **Step 5: Fix `src/commands.js`**

Add the import and the new injectable parameter:

```javascript
import { normalizeDirectory, resolveWorkspaceRoot } from "./paths.js";
```

(Replace the existing `import { normalizeDirectory } from "./paths.js";` line with the one above.)

```javascript
export async function runCommand(command, options, { client, io = process, signal, executablePath, cwd = process.cwd(), homeDirectory = os.homedir(), env = process.env, runShellCommand = defaultShellRunner, platform = process.platform, checkSkills = defaultCheckSkills, resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot } = {}) {
```

(Add `resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot` to the destructured options above.)

Change the `home` case:
```javascript
    case "home": {
      const directory = normalizeDirectory(options.directory || cwd);
```
to:
```javascript
    case "home": {
      const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
```

Do **not** touch the `dispatch` case's `normalizeDirectory(options.directory || cwd)` line.

Change the `advisor` case:
```javascript
    case "advisor": {
      const directory = normalizeDirectory(options.directory || cwd);
```
to:
```javascript
    case "advisor": {
      const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
```

Change the `list` case:
```javascript
    case "list": {
      const params = options.all ? {} : { directory: normalizeDirectory(options.directory || cwd) };
```
to:
```javascript
    case "list": {
      const params = options.all ? {} : { directory: normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd)) };
```

Change the `context` case:
```javascript
    case "context": {
      const directory = normalizeDirectory(options.directory || cwd);
```
to:
```javascript
    case "context": {
      const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
```

Change the `watch` case to thread the injectable through, and update `watchCommand` itself:

```javascript
    case "watch":
      return watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
```

```javascript
async function watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot }) {
  const directory = options.directory
    ? normalizeDirectory(options.directory)
    : options.taskId
      ? null
      : normalizeDirectory(resolveWorkspaceRootFn(cwd));
```

- [ ] **Step 6: Update `docs/cli-reference.md`**

In the `## \`taskferry list [options]\`` section, change:
```
| `--directory <path>` | Workspace to inspect, defaults to the current workspace |
```
to:
```
| `--directory <path>` | Workspace to inspect, defaults to the current git workspace root (falls back to the literal current directory outside a git repo) |
```

Apply the same wording change to the `--directory` rows in the `## \`taskferry watch [options]\``, `## \`taskferry context [options]\``, and `## \`taskferry advisor ...\`` sections. Leave `dispatch`'s `--directory` row (`"defaults to the current workspace"`) unchanged.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test src/paths.test.js src/args.test.js src/commands.test.js src/cli.test.js`
Expected: PASS, all tests including the new ones.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: exits 0, all suites pass (this catches any other test relying on the old `directory: cwd` default anywhere in the suite).

- [ ] **Step 9: Commit**

```bash
git add src/args.js src/cli.js src/commands.js docs/cli-reference.md src/args.test.js src/cli.test.js src/commands.test.js
git commit -m "feat(directory): default list/watch/context/advisor/home to the git workspace root"
```

---

### Task 3: `watch --flush-interval` and buffered output

**Files:**
- Modify: `src/args.js`
- Modify: `src/commands.js`
- Modify: `docs/cli-reference.md`
- Test: `src/args.test.js`
- Test: `src/commands.test.js`

**Interfaces:**
- Consumes: `parseDuration` (already in `src/args.js`, from the duration-flags work); `watchCommand`/`streamTaskEvents` as fixed by Task 2.
- Produces: `options.flushIntervalMs` on `watch`'s parsed options (milliseconds, or `undefined` when omitted). `streamTaskEvents({ ..., flushIntervalMs })` — when set, buffers instead of writing immediately.

- [ ] **Step 1: Write the failing tests**

In `src/args.test.js`, add:

```javascript
test("parses watch --flush-interval as a duration and requires --summaries", () => {
  assert.equal(
    parseArgs(["watch", "--summaries", "--flush-interval", "5m"]).options.flushIntervalMs,
    300000
  );
  assert.equal(
    parseArgs(["watch", "--summaries", "--flush-interval", "30000"]).options.flushIntervalMs,
    30000
  );
  assert.throws(
    () => parseArgs(["watch", "--flush-interval", "5m"]),
    /--flush-interval requires --summaries/
  );
});
```

In `src/commands.test.js`, add:

```javascript
test("watch --flush-interval batches multiple events for the same and different taskIds into one flushed block", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => { deliver = onEvent; },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 1000 }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_2", directory: root, status: "running" });
  deliver({ sequence: 3, type: "task.state", taskId: "oc_1", directory: root, status: "done" }); // last-write-wins for oc_1

  assert.equal(io.lines.length, 0, "nothing should be written before the first flush tick");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  controller.abort();
  await pending;

  // toon/plain format renders one line per buffered event, same as today's
  // per-event output, just written together at flush time instead of
  // streamed individually -- Map preserves oc_1's original insertion
  // position, so it flushes first even though its value was last updated.
  assert.equal(io.lines.length, 2, "one line per distinct taskId, written together at the flush tick");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /done/);
  assert.doesNotMatch(io.lines[0], /running/, "oc_1's stale running event must not appear, only its final done");
  assert.match(io.lines[1], /oc_2/);
  assert.match(io.lines[1], /running/);
});

test("watch --flush-interval emits nothing on a tick where no events arrived", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  const client = fakeClient({ onSubscribe: () => {} });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 200 }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  await new Promise((resolve) => setTimeout(resolve, 450));
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 0);
});

test("watch --flush-interval --task-id flushes the terminal event synchronously before exiting, not left buffered", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => { deliver = onEvent; },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: true, flushIntervalMs: 60000, taskId: "oc_1" }, {
    client,
    io,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_1", directory: root, status: "done" });

  const result = await pending;

  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1, "the terminal event must flush immediately, not wait for a 60s tick that never fires in this test");
  assert.match(io.lines[0], /done/);
});

test("watch --flush-interval --format ndjson wraps buffered events in a single watch.flush envelope", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => { deliver = onEvent; },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "ndjson", summaries: true, flushIntervalMs: 100 }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "running" });

  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await pending;

  assert.equal(io.lines.length, 1);
  const parsed = JSON.parse(io.lines[0]);
  assert.equal(parsed.type, "watch.flush");
  assert.equal(typeof parsed.timestamp, "string");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].taskId, "oc_1");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/args.test.js src/commands.test.js`
Expected: FAIL — `--flush-interval` is an unknown flag; `flushIntervalMs` has no effect on `streamTaskEvents` yet.

- [ ] **Step 3: Add `--flush-interval` to `src/args.js`**

In `commandSpecs.watch.options`, add a new entry:

```javascript
  watch: {
    usage: "taskferry watch [options]",
    description: "Stream task state events for a workspace.",
    options: {
      "--directory <path>": "workspace to watch, defaults to the current workspace",
      "--task-id <id>": "scope the stream to one task; exits automatically once it settles",
      "--format toon|ndjson": "stream format, default toon",
      "--summaries": "request activity summaries when available",
      "--flush-interval <duration>": "batch events and print them together on this interval, e.g. 30s, 5m, 1h; requires --summaries",
    },
    examples: ['taskferry watch', 'taskferry watch --task-id <id> --summaries', 'taskferry watch --format ndjson', 'taskferry watch --summaries --flush-interval 5m'],
  },
```

In `defaultOptions()`'s `"watch"` case, add `flushIntervalMs: undefined`:

```javascript
    case "watch":
      return { directory: undefined, format: "toon", summaries: false, taskId: undefined, flushIntervalMs: undefined };
```

In the `values` map, add:

```javascript
      "--flush-interval": "flushIntervalMs",
```

In `commandAllows()`, add `"--flush-interval"` to `watch`'s list:

```javascript
    watch: ["--directory", "--format", "--task-id", "--flush-interval"],
```

In the value-parsing branch, extend the `timeoutMs` duration-parsing condition to also cover `flushIntervalMs`:

```javascript
    if (key === "timeoutMs" || key === "flushIntervalMs") {
      value = parseDuration(value, name);
    } else if (["graceMs", "tailChars", "chars", "maxWords", "limit"].includes(key)) {
```

Add the `--flush-interval` requires `--summaries` validation, in the `if (!help) { ... }` block, alongside the other `wait`-specific checks:

```javascript
    if (command === "watch" && options.flushIntervalMs !== undefined && !options.summaries) {
      throw usageError("--flush-interval requires --summaries", command);
    }
```

- [ ] **Step 4: Add buffering to `streamTaskEvents` in `src/commands.js`**

Replace the whole `streamTaskEvents` function:

```javascript
function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format, flushIntervalMs }) {
  let settle;
  let abortHandler;
  // `directory` is only known upfront when the caller already had it (plain
  // `watch --directory`); a taskId-scoped `watch --task-id` subscribes by
  // taskId directly (the daemon resolves the directory server-side) and only
  // learns it once the first matching event arrives.
  let resolvedDirectory = directory;
  const buffered = flushIntervalMs ? new Map() : null;
  const writeRaw = (event) => io.stdout.write(`${formatWatchEvent(event, format, io.stdout.isTTY)}\n`);
  const flush = () => {
    if (!buffered || buffered.size === 0) return;
    const events = [...buffered.values()];
    buffered.clear();
    if (format === "ndjson") {
      io.stdout.write(`${JSON.stringify({ type: "watch.flush", timestamp: new Date().toISOString(), events })}\n`);
      return;
    }
    for (const event of events) writeRaw(event);
  };
  const timer = buffered ? setInterval(flush, flushIntervalMs) : null;
  const emit = (event) => {
    if (buffered) {
      buffered.set(event.taskId, event);
      return;
    }
    writeRaw(event);
  };
  // A terminal event for a taskId-scoped watch must reach stdout before the
  // process exits, never left sitting unflushed in the buffer.
  const emitTerminalNow = (event) => {
    if (buffered) {
      buffered.set(event.taskId, event);
      flush();
      return;
    }
    writeRaw(event);
  };
  const finished = new Promise((resolve, reject) => {
    let settled = false;
    settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result ?? { directory: resolvedDirectory, watching: false });
    };
    abortHandler = () => settle();
    if (signal?.aborted) {
      settle();
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    Promise.resolve(client.subscribe({ ...(directory ? { directory } : { taskId }), ...(summaries ? { summaries: true } : {}) }, (event) => {
      if (taskId && event.taskId !== taskId) return;
      resolvedDirectory = event.directory;
      if (taskId && TERMINAL_STATUSES.has(event.status)) {
        emitTerminalNow(event);
        settle({ directory: resolvedDirectory, watching: false, event });
        return;
      }
      emit(event);
    })).then(() => {
      // Subscriptions only broadcast future transitions (no snapshot replay), so a task
      // that was already terminal before subscribing, or that settled in the gap between
      // resolving task.status above and the subscription actually registering, would
      // otherwise never deliver a terminal event and hang forever.
      if (!taskId || settled) return;
      return client.request("task.status", { taskId }).then((detail) => {
        if (settled || !TERMINAL_STATUSES.has(detail.status)) return;
        const event = terminalEventFromStatus(detail);
        resolvedDirectory = detail.directory;
        emitTerminalNow(event);
        settle({ directory: resolvedDirectory, watching: false, event });
      });
    }).catch((error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  return finished.finally(() => {
    signal?.removeEventListener("abort", abortHandler);
    if (timer) clearInterval(timer);
  });
}
```

Thread `flushIntervalMs` through from `watchCommand`:

```javascript
async function watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot }) {
  const directory = options.directory
    ? normalizeDirectory(options.directory)
    : options.taskId
      ? null
      : normalizeDirectory(resolveWorkspaceRootFn(cwd));
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    taskId: options.taskId,
    summaries: options.summaries,
    format: options.format,
    flushIntervalMs: options.flushIntervalMs,
  }).finally(() => {
    if (client.close) client.close();
  });
}
```

- [ ] **Step 5: Update `docs/cli-reference.md`**

In the `## \`taskferry watch [options]\`` section's flag table, add a row:

```
| `--flush-interval <duration>` | Batch `--summaries` events and print them together on this interval instead of streaming individually; milliseconds or a duration string (30s, 5m, 1h); requires `--summaries` |
```

Below the existing "`ndjson` emits one JSON object per line, for scripting." line, add:

```
With `--flush-interval`, `ndjson` emits one `{"type": "watch.flush", "timestamp": ..., "events": [...]}` object per flush tick instead of one object per event; `toon` renders the same buffered events as today's per-event lines, just batched under one tick.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test src/args.test.js src/commands.test.js`
Expected: PASS, all tests including the new ones.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/args.js src/commands.js docs/cli-reference.md src/args.test.js src/commands.test.js
git commit -m "feat(watch): add --flush-interval to batch events into periodic flushes"
```

---

### Task 4: Agent-side auto-arm convention (documentation only)

**Files:**
- Modify: `skills/using-taskferry/SKILL.md` (canonical)
- Regenerate: `integrations/claude/skills/using-taskferry/SKILL.md`, `integrations/codex/skills/using-taskferry/SKILL.md`
- Modify: `docs/integrations/claude-code.md`

**Interfaces:**
- Consumes: `watch --flush-interval` from Task 3, the harness `Monitor` tool convention already documented elsewhere in the same skill file (the "Inside Claude Code, always run `wait --summarize` via `Bash` `run_in_background`..." section).
- Produces: no code — this task only changes documentation read by future agent sessions.

- [ ] **Step 1: Add the auto-arm convention to the canonical `skills/using-taskferry/SKILL.md`**

Add a new `## Fleet-Wide Monitoring` section, placed after the existing `## AXI CLI` section and before `## Advisor Review`:

```markdown
## Fleet-Wide Monitoring

On a session's first `taskferry dispatch`, also background `taskferry watch
--summaries --flush-interval 5m` (no `--directory` needed — it resolves the
git workspace root automatically) and register the process with the harness
`Monitor` tool, the same way `Monitor` is armed for a single `wait
--summarize` job elsewhere in this skill. This surfaces periodic, batched
updates for *every* ferry dispatched anywhere in the git workspace —
including ones dispatched by other concurrent sessions or from other
subdirectories of the same repo — as notifications into the agent's own
context, without polling and without a firehose of individual per-event
notifications.

This is pure convention for agent sessions to follow — the `Monitor` tool is
harness-native and can't be invoked from within taskferry's own code, so
nothing in taskferry itself enforces it.

```sh
taskferry watch --summaries --flush-interval 5m > /tmp/taskferry-fleet-watch.log 2>&1 &
disown
```

Then arm a `Monitor` tailing that log file (`tail -n0 -F
/tmp/taskferry-fleet-watch.log`, `persistent: true`), the same pattern used
for a single `wait --summarize` job above — one notification per flush tick
instead of one per raw event.

Arm this once per session, on the first dispatch, not once per dispatch —
re-arming on every subsequent dispatch would spawn a redundant background
`watch` process each time.
```

- [ ] **Step 2: Regenerate the generated skill copies**

Run: `npm run skill:generate`
Expected: exits 0, silently overwrites `integrations/claude/skills/using-taskferry/SKILL.md` and `integrations/codex/skills/using-taskferry/SKILL.md` with the canonical file's new content.

- [ ] **Step 3: Verify the generated copies are in sync**

Run: `npm run skill:check`
Expected: exits 0 with no output.

- [ ] **Step 4: Cross-reference from `docs/integrations/claude-code.md`**

In the `## Using taskferry as an external worker backend` section, after the existing paragraph ending in "...see [cli-reference.md](../cli-reference.md) for the full command surface either path relies on.", add:

```markdown

Outside the SDD lifecycle, a live session also benefits from fleet-wide
visibility into every ferry dispatched anywhere in the git workspace — see
the bundled skill's "Fleet-Wide Monitoring" section for the `watch
--summaries --flush-interval` + `Monitor` auto-arm convention.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: exits 0 (this task touches no source files, but confirms `skill:check`'s regeneration didn't desync anything else).

- [ ] **Step 6: Commit**

```bash
git add skills/using-taskferry/SKILL.md integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md docs/integrations/claude-code.md
git commit -m "docs: document the watch --flush-interval + Monitor auto-arm convention"
```

---

## Self-Review Notes

- **Spec coverage:** Component 1 (`resolveWorkspaceRoot`) is Task 1. Component 2 (directory defaults) is Task 2, expanded beyond the spec's own File Structure to also fix `args.js`'s `defaultOptions` pre-fill bug and `cli.js`'s redundant/authoritative pre-normalization — both verified by direct code reading (see the Global Constraints deviation note), since the spec's literal `commands.js`-only change would have been a no-op in the shipped binary. Component 3 (`watch --flush-interval`) is Task 3. Component 4 (auto-arm convention) is Task 4. The spec's Non-goals (no `claude-monitor` revival, no phone push, no per-event notifications, no `dispatch` directory change, no `originSessionId` removal, no `parseDuration` extensions) have no corresponding tasks, correctly — they're explicitly out of scope.
- **Placeholder scan:** no TBD/TODO; every step has literal code, exact file paths, and runnable commands.
- **Type consistency:** `resolveWorkspaceRoot(startDir, { runCommand, warn })`'s signature (Task 1) matches every call site in Tasks 2 and 3 (`resolveWorkspaceRootFn(cwd)`, called with just the first argument — the `{ runCommand, warn }` second argument is optional and only exercised directly in Task 1's own tests). `flushIntervalMs` is spelled identically across `args.js`'s `values` map, `defaultOptions`, and `commands.js`'s `streamTaskEvents`/`watchCommand` parameter list.
