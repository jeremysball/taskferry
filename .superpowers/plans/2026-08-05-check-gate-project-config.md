# Verification Gate and Project Config (`.taskferry.toml`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repos declare one check command in `.taskferry.toml`; taskferry tells every worker to run it, then runs it itself at settle as the gate that decides whether a changeset is acceptable.

**Architecture:** A new `.taskferry.toml` (TOML, project-root, read fresh per dispatch/spawn/settle via an mtime cache) supplies `check`, `check_timeout_seconds`, `read_only_paths`. Dispatch-time: the check command is appended to the worker's prompt and `read_only_paths` become extra `--ro-bind`s. Settle-time (right after changeset extraction, only when real changes exist over a git-tracked target): a new async "gate" spawns `bwrap` over the *same* copy-on-write overlay the worker ran with and runs the check command there, recording `checkStatus`/`checkCommand`/`checkExitCode`/`checkOutputTail`/timestamps on the task. (Non-git / overlay-only targets deliberately skip the gate: `applyNonGitChangeset` rsyncs the merged overlay onto the real directory on accept, so gate side effects would land on the real tree too — these targets get no verification gate at all, and `checkStatus` stays at its default `"none"`.) `accept` refuses a `failed`/`timeout`/`interrupted`/`running` gate unless `--force` (which records `checkOverride: true`, including for `running` overrides); `reject` is always allowed. A new `--parent-task` dispatch flag links fix-round dispatches to the gate failure that provoked them. `taskferry init` scaffolds the file from ecosystem detection.

**Tech Stack:** Node.js (ESM), `node:child_process` (`spawn`), `node:test`, `smol-toml` (new dependency) for TOML parsing, `bwrap` (bubblewrap) for the sandboxed/overlay spawn.

## Global Constraints

- No manifest parsing at runtime, ever, outside `taskferry init` (package.json/pyproject.toml/go.mod/Cargo.toml sniffing lives only there).
- `.taskferry.toml` is read fresh (mtime-cached, never long-lived-cached) at three independent points in a task's lifecycle: dispatch build (prompt injection), spawn (`read_only_paths`), settle (the gate's check command/timeout) — per the design's "Read per dispatch and per settle."
- taskferry never creates `.taskferry.toml` on its own outside `taskferry init`, and `init` never overwrites an existing file.
- The gate only ever runs for a `role: "dispatch"` task that produced a real changeset over a live overlay mounted on a git-tracked directory (`task.overlayDirs` set, `task.preDispatchHead != null`, `changesetStatus` about to become `"pending"`). Advisor dispatches and `--no-overlay` dispatches never get prompt injection or a gate — there is no isolated tree to gate against. Non-git (`--no-overlay` / overlay-only) dispatches also do not run a gate, even with a live overlay: `applyNonGitChangeset` (`src/changeset.js:433-445`) rsyncs the entire merged overlay view onto the real directory on accept, so any gate side effects (test caches, build artifacts) the gate wrote into the overlay's `upper` would land on the real tree too. For these targets, `checkStatus` stays at its default `"none"` and the CLI-side "no gate ran" warning (Task 6 Step 5) tells the user that's why nothing was verified. Per-task doctor-context surfacing the design's error table calls for is deferred with the rest of the doctor fleet-health work (out of scope for this plan; see "Doctor surfacing gap" note below).
- No new subcommands beyond `init` (Task 8) — `init` is one of the spec's stated goals, every other new command is explicitly out of scope. No auto-dispatch of fix rounds, no CLI flag for `read_only_paths`, no doctor fleet-health surfacing (a later spec/plan) — all listed as this spec's explicit non-goals.

**Doctor surfacing gap (explicit deviation from the spec).** The design's "Error handling summary" table requires "loud warning in status **and doctor context**" / "surfaced as a task warning **and in doctor**" for `.taskferry.toml` issues — but the spec's own non-goals section says "the doctor fleet-health spec consumes these; this spec does not build any doctor surface." That is a genuine contradiction between the spec's error table and its non-goals, and the per-task doctor-context wiring called for by the error table is **deliberately deferred** along with the rest of doctor fleet-health work, out of scope for this plan. The error table's "loud warning in status" requirement is still met: `status --full` and `checkStatus` / `projectConfigWarning` carry the value to the user; the doctor-context aggregation is what the next spec builds. This is a documentation-only reconciliation, not a missing implementation, and it should not be read as an oversight when the next spec reader compares the two.
- Every new/changed function keeps this repo's existing test-injection convention: dependencies (`spawnFn`, `existsFn`, `statFn`, `persistTask`, etc.) are passed in via a `ctx`/options object with real defaults, never called as bare globals, so tests can fake them without touching the filesystem or spawning real processes.
- Follow this repo's JSDoc-typed-JS style (`@param`/`@returns` blocks, no TypeScript syntax in `.js` files) on every new exported function, matching the surrounding code.

---

## File Structure

- Create `src/project-config.js` — loads/validates/caches `.taskferry.toml`; builds the prompt-injection block. No side effects beyond `fs.statSync`/`fs.readFileSync`.
- Create `src/project-config.test.js` — unit tests for the loader.
- Create `src/init.js` — `taskferry init` ecosystem detection + interactive scaffolder.
- Create `src/init.test.js` — unit tests for detection + scaffolding.
- Create `.taskferry.toml` — taskferry's own dogfood config (Task 9).
- Modify `src/tasks.js` — Task/TaskSummary/ResultDetail schema, `buildDispatchTask`, `dispatchTask` (prompt injection), `buildBwrapBinds` (`read_only_paths`), the new `startCheckGate` gate runner wired into `extractChangesetForTaskRecord`, `validateAcceptable`/`acceptTaskChangeset` (gating + `--force`), `bootstrapManagerContext` (interrupted-gate sweep on daemon restart), `summarizeOptionalFields`, `computeResultDetail`, the `accept`/`dispatch`/`advisor` manager-API bindings.
- Modify `src/protocol.js` — `RESULT_FIELDS`, `task.dispatch`/`task.advisor` optional `parentTaskId`, `task.accept` optional `force`.
- Modify `src/args.js` — `--parent-task`, `--force` flags; `accept`'s `DEFAULT_OPTIONS` entry.
- Modify `src/command-specs.js` — help text for the new flags and the new `init` command.
- Modify `src/commands.js` — `DISPATCH_PASSTHROUGH_KEYS`, `runAccept`.
- Modify `src/daemon.js` — `task.accept` invoke handler forwards `force`.
- Modify `src/cli.js` — routes `init` the same way `setup` bypasses the daemon client.
- Modify `package.json` — add `smol-toml` dependency; dogfood's `check` script gains the `npm test` step it currently lacks; register new test files in `test:unit`.
- Modify `docs/cli-reference.md`, `docs/config.md`, `docs/sourcemap.md`, `docs/security.md` — document the new file/flags/command and close #292.
- Modify `skills/using-taskferry/SKILL.md` (canonical; regenerate `integrations/claude|codex/skills/using-taskferry/SKILL.md` via `npm run skill:generate`).

---

## Task 1: `.taskferry.toml` loader (`src/project-config.js`)

**Files:**
- Create: `src/project-config.js`
- Create: `src/project-config.test.js`
- Modify: `package.json` (add `smol-toml` dependency, register `src/project-config.test.js` in the `test:unit` script)

**Interfaces:**
- Produces: `resolveProjectConfigPath(directory: string): string`, `loadProjectConfig(directory: string, deps?): ProjectConfig`, `verificationPromptBlock(checkCommand: string): string`, `_resetProjectConfigCache(): void`. `ProjectConfig = { check: string|null, checkTimeoutSeconds: number, readOnlyPaths: string[], parseError: string|null }`. Every later task that touches `.taskferry.toml` imports these three functions from `./project-config.js` — do not duplicate the loading/caching logic anywhere else.

- [ ] **Step 1: Add the `smol-toml` dependency**

```bash
npm install smol-toml@^1.7.1
```

Verify: `package.json`'s `dependencies` now has `"smol-toml": "^1.7.1"` alongside the existing `"@toon-format/toon"` entry.

- [ ] **Step 2: Write the failing tests**

Create `src/project-config.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectConfigPath, loadProjectConfig, verificationPromptBlock, _resetProjectConfigCache } from "./project-config.js";

function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-project-config-test-"));
}

function writeConfig(dir, content) {
  fs.writeFileSync(resolveProjectConfigPath(dir), content);
}

describe("loadProjectConfig", () => {
  test("no .taskferry.toml -> no gate, no read-only paths, no error", () => {
    const dir = tmpProjectDir();
    const config = loadProjectConfig(dir);
    assert.deepEqual(config, { check: null, checkTimeoutSeconds: 900, readOnlyPaths: [], parseError: null });
  });

  test("parses check, check_timeout_seconds, and read_only_paths", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "bun x check"\ncheck_timeout_seconds = 120\nread_only_paths = ["/a", "/b"]\n`);
    const config = loadProjectConfig(dir);
    assert.deepEqual(config, { check: "bun x check", checkTimeoutSeconds: 120, readOnlyPaths: ["/a", "/b"], parseError: null });
  });

  test("check_timeout_seconds defaults to 900 when absent", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm run check"\n`);
    assert.equal(loadProjectConfig(dir).checkTimeoutSeconds, 900);
  });

  test("invalid TOML syntax never throws: returns EMPTY_CONFIG-shaped result with parseError set", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = \n`);
    const config = loadProjectConfig(dir);
    assert.equal(config.check, null);
    assert.equal(config.readOnlyPaths.length, 0);
    assert.match(config.parseError, /taskferry\.toml/);
  });

  test("unrecognized key is a validation error, not a silent pass-through", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\nnotarealfield = 1\n`);
    const config = loadProjectConfig(dir);
    assert.equal(config.check, null);
    assert.match(config.parseError, /notarealfield/);
  });

  test("check_timeout_seconds must be a positive integer", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\ncheck_timeout_seconds = -1\n`);
    assert.match(loadProjectConfig(dir).parseError, /check_timeout_seconds/);
  });

  test("read_only_paths must be an array of strings", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\nread_only_paths = [1, 2]\n`);
    assert.match(loadProjectConfig(dir).parseError, /read_only_paths/);
  });

  test("caches by mtime: a second call without a file change does not re-read", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\n`);
    let reads = 0;
    const deps = { readFileFn: (p) => { reads++; return fs.readFileSync(p, "utf8"); } };
    loadProjectConfig(dir, deps);
    loadProjectConfig(dir, deps);
    assert.equal(reads, 1);
  });

  test("cache invalidates when mtime changes", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\n`);
    assert.equal(loadProjectConfig(dir).check, "npm test");
    // Force a distinct mtime -- same-millisecond rewrites can land on an
    // unchanged mtimeMs on fast filesystems.
    fs.utimesSync(resolveProjectConfigPath(dir), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    writeConfig(dir, `check = "npm run check"\n`);
    assert.equal(loadProjectConfig(dir).check, "npm run check");
  });
});

describe("verificationPromptBlock", () => {
  test("renders the required-verification block with the check command embedded", () => {
    const block = verificationPromptBlock("bun x check");
    assert.match(block, /## Verification \(required\)/);
    assert.match(block, /bun x check/);
    assert.match(block, /Run it before declaring the task done/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/project-config.test.js`
Expected: FAIL with `Cannot find module './project-config.js'` (the module doesn't exist yet).

- [ ] **Step 4: Implement `src/project-config.js`**

```js
// src/project-config.js
import fs from "node:fs";
import path from "node:path";
import { parse, TomlError } from "smol-toml";

const CONFIG_FILENAME = ".taskferry.toml";
const DEFAULT_CHECK_TIMEOUT_SECONDS = 900;
const KNOWN_KEYS = new Set(["check", "check_timeout_seconds", "read_only_paths"]);

/** @typedef {{check: string|null, checkTimeoutSeconds: number, readOnlyPaths: string[], parseError: string|null}} ProjectConfig */

/** @type {ProjectConfig} */
const EMPTY_CONFIG = Object.freeze({ check: null, checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS, readOnlyPaths: [], parseError: null });

// Per-path cache: configPath -> { mtimeMs: number|null, result: ProjectConfig }.
// mtimeMs null means "file did not exist at last load" -- same shape as
// config.js's _configCache, so an edit (or a file appearing/disappearing) is
// observed on the next loadProjectConfig() call without an explicit reset.
const _projectConfigCache = new Map();

/** Exported for test use only. */
export function _resetProjectConfigCache() {
  _projectConfigCache.clear();
}

/** @param {string} directory @returns {string} */
export function resolveProjectConfigPath(directory) {
  return path.join(directory, CONFIG_FILENAME);
}

/**
 * @param {unknown} raw
 * @param {string} configPath
 * @returns {ProjectConfig}
 */
function validateAndNormalize(raw, configPath) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_CONFIG, parseError: `${configPath} must contain a TOML table at the top level` };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const errors = [];
  if (record.check !== undefined && typeof record.check !== "string") {
    errors.push(`"check" must be a string (got ${JSON.stringify(record.check)})`);
  }
  if (record.check_timeout_seconds !== undefined && !(Number.isInteger(record.check_timeout_seconds) && record.check_timeout_seconds > 0)) {
    errors.push(`"check_timeout_seconds" must be a positive integer (got ${JSON.stringify(record.check_timeout_seconds)})`);
  }
  const readOnlyPaths = record.read_only_paths;
  if (readOnlyPaths !== undefined && !(Array.isArray(readOnlyPaths) && readOnlyPaths.every((entry) => typeof entry === "string"))) {
    errors.push(`"read_only_paths" must be an array of strings (got ${JSON.stringify(readOnlyPaths)})`);
  }
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unrecognized key "${key}"`);
  }
  if (errors.length) {
    return { ...EMPTY_CONFIG, parseError: `${configPath}: ${errors.join("; ")}` };
  }
  return {
    check: /** @type {string|undefined} */ (record.check) ?? null,
    checkTimeoutSeconds: /** @type {number|undefined} */ (record.check_timeout_seconds) ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    readOnlyPaths: /** @type {string[]|undefined} */ (record.read_only_paths) ?? [],
    parseError: null,
  };
}

/**
 * Loads `.taskferry.toml` from a dispatch's working-tree root. Never throws:
 * an absent file returns EMPTY_CONFIG (no gate, no injection, no extra
 * binds); an unparseable or invalid file also returns an EMPTY_CONFIG-shaped
 * result, but with `parseError` set so the caller can surface a loud warning
 * instead of silently guessing a partial config -- dispatch proceeds with no
 * gate, per the design's error table. Cached per absolute path by mtime,
 * mirroring config.js's loadConfig() invalidation strategy, so the three
 * independent call sites in a task's lifecycle (dispatch-time prompt
 * injection, spawn-time read-only binds, settle-time gate) each pay only a
 * stat() when the file hasn't changed since the last read.
 * @param {string} directory
 * @param {{statFn?: (p: string) => {mtimeMs: number}, readFileFn?: (p: string) => string}} [deps]
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(directory, { statFn = fs.statSync, readFileFn = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const configPath = resolveProjectConfigPath(directory);
  let currentMtimeMs;
  try {
    currentMtimeMs = statFn(configPath).mtimeMs;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      const cached = _projectConfigCache.get(configPath);
      if (cached && cached.mtimeMs === null) return cached.result;
      _projectConfigCache.set(configPath, { mtimeMs: null, result: EMPTY_CONFIG });
      return EMPTY_CONFIG;
    }
    throw err;
  }
  const cached = _projectConfigCache.get(configPath);
  if (cached && cached.mtimeMs === currentMtimeMs) return cached.result;

  /** @type {ProjectConfig} */
  let result;
  try {
    result = validateAndNormalize(parse(readFileFn(configPath)), configPath);
  } catch (err) {
    if (err instanceof TomlError) {
      result = { ...EMPTY_CONFIG, parseError: `${configPath}: ${err.message.split("\n")[0]}` };
    } else {
      throw err;
    }
  }
  _projectConfigCache.set(configPath, { mtimeMs: currentMtimeMs, result });
  return result;
}

/**
 * The always-on prompt block appended to a dispatch's prompt when the
 * project declares a check command, verbatim per the design's §3.
 * @param {string} checkCommand
 * @returns {string}
 */
export function verificationPromptBlock(checkCommand) {
  return `\n\n## Verification (required)\nThis repo declares a check command in .taskferry.toml:\n    ${checkCommand}\nRun it before declaring the task done. If it fails, fix the failures and\nre-run until it passes. State the final result in your summary.\n`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/project-config.test.js`
Expected: PASS, all tests green.

- [ ] **Step 6: Register the new test file and commit**

In `package.json`'s `test:unit` script, append `src/project-config.test.js` to the space-separated file list (alphabetically near `src/protocol.test.js`, matching the script's existing ordering-by-topic pattern — exact position doesn't matter, just don't drop any existing entry).

```bash
git add package.json package-lock.json src/project-config.js src/project-config.test.js
git commit -m "feat(config): add .taskferry.toml loader (project-config.js)"
```

---

## Task 2: Task schema + RPC/CLI wiring for the new fields

**Files:**
- Modify: `src/tasks.js` (Task/TaskSummary/ResultDetail typedefs near line 40-165; `buildDispatchTask` ~1670; `dispatchTask` ~4913; `summarizeOptionalFields` ~2444; `computeResultDetail` ~1486; the `accept`/`dispatch`/`advisor` manager-API bindings ~3399/3491)
- Modify: `src/protocol.js` (`RESULT_FIELDS`; `METHOD_PARAMS["task.dispatch"]`, `["task.advisor"]`, `["task.accept"]`)
- Modify: `src/args.js` (`FLAGS`, `DEFAULT_OPTIONS.accept`)
- Modify: `src/command-specs.js` (dispatch/advisor/accept option docs)
- Modify: `src/commands.js` (`DISPATCH_PASSTHROUGH_KEYS`, `runAccept`)
- Modify: `src/daemon.js` (`invokeHandlers["task.accept"]`)

This task adds every new field and every new flag end-to-end, following the exact same wiring pattern the existing `--class`/`class` field already uses (confirmed at `src/args.js:211`, `src/commands.js:149,290`, `src/tasks.js:1671,1700,2445,4918`). No gate behavior yet — Task 5/6 add that. This task is independently testable: the fields round-trip through dispatch/status/result with default (empty) values, and `--parent-task`/`--force` parse and forward correctly.

**Interfaces:**
- Produces: `Task.checkStatus: "none"|"running"|"passed"|"failed"|"timeout"|"interrupted"`, `Task.checkCommand: string|null`, `Task.checkExitCode: number|null`, `Task.checkOutputTail: string|null`, `Task.checkStartedAt: string|null`, `Task.checkEndedAt: string|null`, `Task.checkOverride: boolean`, `Task.projectConfigWarning: string|null`, `Task.parentTaskId: string|null`, `Task.checkGatePid: number|null` (set by Task 5's gate runner, cleared when the gate settles). `buildDispatchTask(params)` accepts `parentTaskId` in its params object. `acceptTaskChangeset(taskId, { force }, ctx)` — note the added second positional options argument (was `acceptTaskChangeset(taskId, ctx)`; every caller must update). Task 5's gate runner and Task 6's accept-gating both consume these fields by name — do not rename any of them once this task lands.

- [ ] **Step 1: Extend the Task/TaskSummary typedefs**

In `src/tasks.js`, in the `Task` typedef block (ends `* @property {string|null} [changesetError]` around line 61), add:

```js
 * @property {string|null} [parentTaskId]
 * @property {"none"|"running"|"passed"|"failed"|"timeout"|"interrupted"} [checkStatus]
 * @property {string|null} [checkCommand]
 * @property {number|null} [checkExitCode]
 * @property {string|null} [checkOutputTail]
 * @property {string|null} [checkStartedAt]
 * @property {string|null} [checkEndedAt]
 * @property {boolean} [checkOverride]
 * @property {string|null} [projectConfigWarning]
 * @property {number|null} [checkGatePid]
```

(`checkGatePid` is the OS pid of the bwrap child (process-group leader — Task 5 spawns it `detached: true`) currently running the gate. Persisted alongside `checkStatus: "running"` for the in-flight gate, and also used by Task 7's restart-recovery sweep to best-effort group-kill a crash-orphaned gate on daemon boot. The live accept/reject kill-and-wait path (Task 6) does NOT read this field directly, though — it goes through `ctx.env.killGateAndWait(taskId)` (Task 5), which resolves the actual tracked `ChildProcess` from `ctx.gateChildren` so it can wait on a real `"exit"` event, not just fire a signal at a pid and hope. Cleared alongside `checkStatus` in `startCheckGate`'s `settle()` and `error` handlers.)

Make the identical addition to the `TaskSummary` typedef block (ends the same way, around line 95), and add the always-surfaced subset to `ResultDetail` (ends `* @property {string|null} [changesetError]` around line 163):

```js
 * @property {string|null} [parentTaskId]
 * @property {"none"|"running"|"passed"|"failed"|"timeout"|"interrupted"} [checkStatus]
 * @property {string|null} [checkCommand]
 * @property {number|null} [checkExitCode]
 * @property {string|null} [checkOutputTail]
 * @property {string|null} [checkStartedAt]
 * @property {string|null} [checkEndedAt]
 * @property {boolean} [checkOverride]
 * @property {string|null} [projectConfigWarning]
```

- [ ] **Step 2: Thread the fields through `buildDispatchTask`**

In `src/tasks.js`, `buildDispatchTask`'s params typedef (the `@param` line directly above it, ~line 1667) gains `parentTaskId?: string|null` at the end, and its destructuring signature:

```js
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, class: taskClass, parentTaskId = null }) {
```

and its return object gains, right after the existing `changesetError: null,` line:

```js
    parentTaskId: parentTaskId == null ? null : parentTaskId,
    checkStatus: "none",
    checkCommand: null,
    checkExitCode: null,
    checkOutputTail: null,
    checkStartedAt: null,
    checkEndedAt: null,
    checkOverride: false,
    projectConfigWarning: null,
    checkGatePid: null,
```

- [ ] **Step 3: Thread `parentTaskId` through `dispatchTask`**

In `src/tasks.js`, `dispatchTask`'s `@param` typedef (~line 4913) gains `parentTaskId?: string|null` at the end of the params object type. Its destructuring line gains `parentTaskId = null`:

```js
function dispatchTask(params, ctx) {
  const { prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, executor: executorName, env, role = "dispatch", class: taskClass = null, parentTaskId = null } = params;
```

and its `buildDispatchTask({...})` call gains `parentTaskId` alongside the existing `class: taskClass`:

```js
  const task = buildDispatchTask({ id, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, directory: normalizedDirectory, class: taskClass, parentTaskId });
```

(`dispatchAdvisorTask` at ~line 2130 and `runAdvisor` at ~line 2255 both call into `ctx.dispatch({...})`/pass params straight through to the same `dispatchTask` — extend their destructuring/forwarding the same way: add `parentTaskId` to `dispatchAdvisorTask`'s `{ prompt, directory, model, variant, sessionId, executor, env, class: taskClass }` destructure and its `ctx.dispatch({...})` call, and to `runAdvisor`'s equivalent destructure/forward.)

- [ ] **Step 4: Surface the new fields in `summarize()` and `computeResultDetail()`**

In `src/tasks.js`, `summarizeOptionalFields` (~line 2444):

```js
function summarizeOptionalFields(task) {
  const { promptTotalChars, incomplete, finalMarker, finalStatus, executorId, class: taskClass, checkStatus, parentTaskId, projectConfigWarning } = task;
  return {
    ...(promptTotalChars != null ? { promptTotalChars } : {}),
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(incomplete === true ? { incomplete: true } : {}),
    ...(finalMarker != null ? { finalMarker } : {}),
    ...(finalStatus != null ? { finalStatus } : {}),
    ...(taskClass != null ? { class: taskClass } : {}),
    ...(executorId != null ? { executorId } : {}),
    ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
    ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
    ...(parentTaskId != null ? { parentTaskId } : {}),
    ...(projectConfigWarning != null ? { projectConfigWarning } : {}),
    ...(checkStatus != null && checkStatus !== "none"
      ? {
          checkStatus,
          checkCommand: task.checkCommand,
          checkExitCode: task.checkExitCode,
          checkStartedAt: task.checkStartedAt,
          checkEndedAt: task.checkEndedAt,
          ...(task.checkOverride ? { checkOverride: true } : {}),
        }
      : {}),
  };
}
```

(`checkOutputTail` is deliberately left out of the lean summary — it can be large, same reasoning as why `diff`/full `narration` are gated behind explicit fields/`--full` rather than always included.)

In `computeResultDetail` (~line 1486), add right after the existing `...(task.class != null ? { class: task.class } : {}),` line:

```js
    ...(task.parentTaskId != null ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.projectConfigWarning != null ? { projectConfigWarning: task.projectConfigWarning } : {}),
    ...(task.checkStatus != null && task.checkStatus !== "none"
      ? {
          checkStatus: task.checkStatus,
          checkCommand: task.checkCommand,
          checkExitCode: task.checkExitCode,
          checkStartedAt: task.checkStartedAt,
          checkEndedAt: task.checkEndedAt,
          ...(task.checkOverride ? { checkOverride: true } : {}),
          ...((fields == null || fields.includes("checkOutputTail")) && task.checkOutputTail != null ? { checkOutputTail: task.checkOutputTail } : {}),
        }
      : {}),
```

- [ ] **Step 5: Add the new fields to `RESULT_FIELDS` and the RPC param schemas**

In `src/protocol.js`, add to the `RESULT_FIELDS` set (after `"changesetError"`):

```js
  "checkStatus",
  "checkCommand",
  "checkExitCode",
  "checkOutputTail",
  "checkStartedAt",
  "checkEndedAt",
  "checkOverride",
  "parentTaskId",
  "projectConfigWarning",
```

In `METHOD_PARAMS["task.dispatch"].optional`, add `["parentTaskId", isNonEmptyString],` (alongside the existing `["class", isNonEmptyString]`). Make the identical addition to `METHOD_PARAMS["task.advisor"].optional`. In `METHOD_PARAMS["task.accept"].optional`, add `["force", isBoolean]` (it's currently `optional: []`).

- [ ] **Step 6: Add `--parent-task` and `--force` to the CLI arg parser**

In `src/args.js`'s `FLAGS` table, add (near `--class`):

```js
  "--parent-task": { allow: ["dispatch", "advisor"], key: "parentTaskId" },
```

and near `--no-overlay`:

```js
  "--force": { allow: ["accept"], bool: true },
```

Change `DEFAULT_OPTIONS.accept` from `() => ({ taskId: void 0 })` to:

```js
  accept: () => ({ taskId: void 0, ...flagDefaultsFor("accept") }),
```

- [ ] **Step 7: Document the new flags in `command-specs.js`**

In `src/command-specs.js`'s `dispatch.options`, add after `"--class <name>": ...`:

```js
      "--parent-task <id>": "tag this dispatch as fixing/retrying an earlier task; persisted as parentTaskId, and echoed by that task's check-gate failure message",
```

and one new dispatch example: `'taskferry dispatch --prompt "Fix: check gate failed" --parent-task oc_msgabc12'`. Make the identical `--parent-task <id>` addition to `advisor.options`. The design's §6 only asks for `--parent-task` on `dispatch` (the gate's suggested fix-forward command is itself a `taskferry dispatch ... --parent-task ...`), but exposing it on `advisor` too is a deliberate, useful extra: a review-fix round that uses the advisor role to read the failing task's output and re-prompt a new dispatch can tag itself with `--parent-task` and the link survives into the dashboard, which is exactly the cross-role lineage metric the spec's "retry chains" telemetry section wants. (Documenting this as intentional rather than silent out-of-scope overshoot.)

In `accept`, change `options: {}` to:

```js
    options: { "--force": "apply the changeset even though its check gate failed, timed out, is still running, or was interrupted by a daemon restart; records checkOverride: true" },
```

and add an example: `'taskferry accept <id> --force'`.

- [ ] **Step 8: Forward `parentTaskId`/`force` through `commands.js`**

In `src/commands.js`, add `"parentTaskId"` to `DISPATCH_PASSTHROUGH_KEYS` (line 149). Change `runAccept`:

```js
async function runAccept(options, { client }) {
  const accepted = await client.request("task.accept", { taskId: options.taskId, ...(options.force === true && { force: true }) });
  warnIfCleanupFailed("changeset applied", accepted);
  return accepted;
}
```

(Task 6 extends `runAccept` further, once `acceptTaskChangeset`'s return value carries `checkStatus`, to warn on an accept where the repo declared no check command at all — see Task 6 Step 4.)

- [ ] **Step 9: Forward `force` from `daemon.js` and update the manager-API `accept` binding**

In `src/daemon.js`'s `invokeHandlers`, change:

```js
  "task.accept": (manager, params) => manager.accept(params.taskId, { force: params.force === true }),
```

In `src/tasks.js`, change every `accept:` binding that currently reads `accept: (taskId) => acceptTaskChangeset(taskId, {...})` (the `ctx.helpers.accept`-style closure ~line 3399, and the public API's `accept: (taskId) => ctx.helpers.accept(taskId)` ~line 3491) to thread a second `options` argument through:

```js
    accept: (taskId, options) => acceptTaskChangeset(taskId, options, { ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(), tasks: ctx.maps.tasks, existsFn: ctx.opts.existsFn, hasLiveOverlay: (task) => ctx.helpers.hasLiveOverlay(task), stateDir: ctx.opts.stateDir, runtimeDir: ctx.opts.runtimeDir, sandboxDenylist: ctx.opts.sandboxDenylist, runOverlayCommandFn: ctx.opts.runOverlayCommandFn, overlaySleepFn: ctx.opts.overlaySleepFn, persistTask: (taskId2) => ctx.helpers.persistTask(taskId2), releaseOverlay: (task) => ctx.env.releaseOverlay(task), killGateAndWait: (taskId2) => ctx.env.killGateAndWait(taskId2), noSuchTask }),
```

(`killGateAndWait` is threaded here — even though Task 2 doesn't consume it — so Task 6 Step 4's in-flight-gate kill handshake can `await ctx.killGateAndWait(taskId)` without Task 6 having to re-edit the factory binding. `killGateAndWait` itself is defined and exposed on `ctx.env` in Task 5 Step 5; Task 6 only adds the matching typedef entry to `acceptTaskChangeset`/`rejectTaskChangeset` and makes both functions `async` so the await has somewhere to land — see Task 6 Step 4's "review fix" note. Note this makes `acceptTaskChangeset` return a `Promise`, which is why the `accept:` binding above and the RPC handler both need no further change: `src/daemon-server.js:131` already does `await invoke(...)` generically for every method.)

```js
    accept: (taskId, options) => ctx.helpers.accept(taskId, options),
```

And update the `reject:` factory binding at the same scope (~line 3404) to thread `killGateAndWait` through. `rejectTaskChangeset`'s signature stays `rejectTaskChangeset(taskId, ctx)` (no `force` needed — `reject` is always allowed regardless of `checkStatus` per the design's §4), but the `ctx` object needs `killGateAndWait` so Task 6's in-flight-gate kill-and-wait handshake can fire without Task 6 having to re-edit the binding:

```js
    reject: (taskId) => rejectTaskChangeset(taskId, { ensureStateLoaded: () => ctx.helpers.ensureStateLoaded(), tasks: ctx.maps.tasks, persistTask: (taskId) => ctx.helpers.persistTask(taskId), releaseOverlay: (task) => ctx.env.releaseOverlay(task), killGateAndWait: (taskId2) => ctx.env.killGateAndWait(taskId2), noSuchTask }),
```

The public-API `reject: (taskId) => ctx.helpers.reject(taskId)` binding at ~line 3496 needs no changes — it just delegates to the helpers closure above.

And update `acceptTaskChangeset`'s own signature at `src/tasks.js:4536` from `function acceptTaskChangeset(taskId, ctx)` to `function acceptTaskChangeset(taskId, { force = false } = {}, ctx)` so the new positional `options` parameter (the `force` flag) lands in the function body — and is simply unused until Task 6 starts consuming it. This is the literal plumbing the caller bindings demand; threading a new positional `options` through every caller while leaving the function's own signature at the old 2-arg shape would land `options` in the `ctx` slot of `acceptTaskChangeset`, and `ctx.ensureStateLoaded()` would throw on every accept (`undefined` is not callable). The signature change must land atomically with the caller-binding changes in this step, so the unit suite run below proves the plumbing is correct as its own commit before any gating behavior builds on top. (Task 6 does not touch this signature declaration — it only adds the `validateAcceptable` `force` branch, the `buildCheckGateFailureMessage` helper, and `checkOverride` recording on top of the `{ force = false }` parameter Task 2 already landed.)

- [ ] **Step 9b: Surface `checkStatus` (when not `"none"`) and `projectConfigWarning` (when set) in `leanStatus`**

Without this, plain `taskferry status <id>` (no `--full`) reports nothing useful about a gate that just started or a parse error — the design requires `checkStatus: running` visible from gate start (per the design's §2 "checkStatus ... is visible from the moment the gate starts"), and Task 6's "check gate still running" error message points the user at `taskferry status <id>` for progress, which currently shows nothing (`leanStatus` in `src/output.js:144-169` is an allow-list projection that omits both fields entirely). Add this alongside the existing `changesetStatus`/`changesetError` project in the same function:

```js
  if (detail.checkStatus && detail.checkStatus !== "none") {
    lean.checkStatus = detail.checkStatus;
    lean.checkCommand = detail.checkCommand;
    lean.checkExitCode = detail.checkExitCode;
    lean.checkStartedAt = detail.checkStartedAt;
    lean.checkEndedAt = detail.checkEndedAt;
    if (detail.checkOverride) lean.checkOverride = true;
  }
  if (detail.projectConfigWarning) lean.projectConfigWarning = detail.projectConfigWarning;
```

(Place these right after the existing `if (detail.changesetError) lean.changesetError = detail.changesetError;` line, matching that line's exact pattern. `checkOutputTail` is intentionally left out of the lean projection — same large-payload reasoning as `Task 4` Step 4's `summarizeOptionalFields` / `Task 2` Step 4 below — it stays available via `taskferry result <id> --fields checkOutputTail` / `--full`.) Add a matching case to `src/output.test.js` (or wherever `leanStatus`'s existing tests live) verifying both: a task with `checkStatus: "running"` and a tasks with `projectConfigWarning` set both surface on the lean projection, and a task with `checkStatus: "none"` (the default) does not.

- [ ] **Step 10: Run the full suite and commit**

This task changes the *signature* of `acceptTaskChangeset` (Step 9 below), so the unit tests that exercise the accept path — `src/tasks.lifecycle.test.js`, `src/tasks.changeset.test.js`, `src/tasks.persist.test.js`, `src/commands.test.js`, `src/cli.test.js`, `src/daemon.test.js` — must run alongside the dispatch/args/protocol tests, not be deferred to Task 6. Running the narrowed subset here would land a signature change without proving it doesn't break the accept path, and Task 6's own "is anything in accept's plumbing broken?" check would then be running against the same broken build.

Run: `npm run test:unit`
Expected: PASS (every existing test, plus all of this task's new cases — the new fields default to neutral values, every new param is optional, and the `acceptTaskChangeset(taskId, { force = false } = {}, ctx)` signature accepts either old-style `acceptTaskChangeset(taskId, ctx)` callsites OR new-style `acceptTaskChangeset(taskId, options, ctx)` callsites, because the optional options object has a default of `{}`).

```bash
git add -A
git commit -m "feat(tasks): add check-gate/parentTaskId schema and CLI/RPC wiring"
```

---

## Task 3: Prompt injection at dispatch time

**Files:**
- Modify: `src/tasks.js` (`dispatchTask`, ~line 4917)
- Test: `src/tasks.dispatch.test.js` (add new cases)

**Interfaces:**
- Consumes: `loadProjectConfig(directory): ProjectConfig`, `verificationPromptBlock(checkCommand): string` from Task 1's `./project-config.js`.
- Produces: nothing new consumed by later tasks; this is a pure behavior addition.

- [ ] **Step 1: Write the failing test**

Add to `src/tasks.dispatch.test.js` (mirror the file's existing `makeManager`/`fakeChild` import pattern from `./tasks.test-helpers.js`):

```js
test("appends the verification block to a dispatch's prompt when .taskferry.toml declares a check command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-dispatch-checkcmd-"));
  fs.writeFileSync(path.join(dir, ".taskferry.toml"), `check = "npm run check"\n`);
  let captured = null;
  const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = opts; return fakeChild(); }, sandboxEnabled: false });
  mgr.dispatch({ prompt: "Fix the bug", directory: dir });
  assert.match(captured.env.__PROMPT__ ?? "", /Fix the bug/); // adjust to however this file's existing tests read the spawned prompt (promptFilePath/--) if it differs from env
});

test("does not inject the verification block for advisor dispatches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-advisor-checkcmd-"));
  fs.writeFileSync(path.join(dir, ".taskferry.toml"), `check = "npm run check"\n`);
  let captured = null;
  const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); }, sandboxEnabled: false, listModelsFn: async () => "openai/gpt-5.6-sol\n" });
  mgr.advisor({ prompt: "Review this", directory: dir, model: "openai/gpt-5.6-sol" });
  assert.ok(!captured.args.join(" ").includes("Verification (required)"));
});

test("no .taskferry.toml: prompt is unmodified", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-no-checkcmd-"));
  let captured = null;
  const mgr = makeManager({ spawnFn: (cmd, args, opts) => { captured = args; return fakeChild(); }, sandboxEnabled: false });
  mgr.dispatch({ prompt: "Fix the bug", directory: dir });
  const task = mgr.status(Array.from(mgr.list().tasks)[0].id);
  assert.equal(task.promptTotalChars, undefined); // "Fix the bug" is under the 200-char preview threshold either way
});
```

Before writing these, open `src/tasks.dispatch.test.js` and copy its actual existing pattern for reading the spawned prompt (some dispatch tests read `args` for the trailing positional prompt argument, per the sandbox test at `src/tasks.sandbox.test.js:30-33` showing `[..., "--", "hello"]` as the trailing args) — adjust the assertions above to match that exact convention instead of guessing at `opts.env.__PROMPT__`, which does not exist in this codebase.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.dispatch.test.js`
Expected: FAIL (prompt injection not implemented yet; the "does not inject" test should already pass trivially since nothing injects anything yet — that's fine, only the injection test is expected red).

- [ ] **Step 3: Implement prompt injection in `dispatchTask`**

In `src/tasks.js`, add the import at the top of the file (alongside the other local imports):

```js
import { loadProjectConfig, verificationPromptBlock } from "./project-config.js";
```

In `dispatchTask` (~line 4917), right after `const normalizedDirectory = resolveDispatchDirectory(directory);`, insert:

```js
  const projectConfig = loadProjectConfig(normalizedDirectory);
  const dispatchPrompt = role === "dispatch" && projectConfig.check
    ? `${prompt}${verificationPromptBlock(projectConfig.check)}`
    : prompt;
```

Then replace every remaining use of the bare `prompt` variable in this function's body with `dispatchPrompt`: the `buildDispatchTask({ id, prompt: dispatchPrompt, ... })` call and the `queueDispatchLaunch({...}, { id, task, prompt: dispatchPrompt, ... })` call. Leave the function's own `params` destructuring (`const { prompt, ... } = params;`) unchanged — only the two call sites that consume `prompt` downstream switch to `dispatchPrompt`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.dispatch.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite and commit**

Run: `npm run test:unit`
Expected: PASS (971+ tests, 0 failures — matches the pre-change baseline plus this task's new cases).

```bash
git add src/tasks.js src/tasks.dispatch.test.js
git commit -m "feat(dispatch): inject the .taskferry.toml verification block into dispatch prompts"
```

---

## Task 4: `read_only_paths` → sandbox read-only binds

**Files:**
- Modify: `src/tasks.js` (`buildBwrapBinds`, ~line 784)
- Modify: `src/project-config.js` (new exported `resolveReadOnlyProjectBinds`, reused by Task 5's gate)
- Test: `src/tasks.sandbox.test.js` (add new cases)

**Interfaces:**
- Consumes: `loadProjectConfig` from Task 1.
- Produces: `task.projectConfigWarning` set when a `read_only_paths` entry doesn't exist on the host, fails the mount-order safety check below, or the config fails to parse — Task 5's gate also writes this same field on a parse error, so both writers must use identical semantics (overwrite, don't append/concatenate multiple warnings; the later writer in a task's lifecycle wins, which is fine since a parse error found at spawn time will also be found identically at settle time). Also produces the exported `resolveReadOnlyProjectBinds()` helper (below) that Task 5's gate reuses verbatim, so the worker and the gate always see the same read-only mount surface — see that task's "sandbox parity" step.

**Security note (added after external review — verified against `src/sandbox.js:277-308` directly, not taken on faith):** `buildBwrapArgs` applies mounts in argument order via `pushPairBinds(args, extraRoBinds, "--ro-bind")`, which runs *after* the deny-list `--tmpfs` mounts (`buildBwrapBaseArgs`), the overlay mount, and the runtime-dir bind. bwrap's mount semantics mean a later mount on a parent directory shadows an earlier mount nested inside it — so an untrusted `.taskferry.toml` declaring `read_only_paths = ["/"]` or `["/home/user"]` would re-expose the tmpfs-hidden `~/.ssh`/`~/.aws`/etc. (un-hiding the deny list) and, for `"/"` specifically, shadow the overlay mount entirely (defeating the copy-on-write isolation the whole feature depends on). `read_only_paths` is project-supplied, not daemon-trusted, so every entry must be validated against the protected mount set before it ever reaches `extraRoBinds`.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.sandbox.test.js`:

```js
test("read_only_paths from .taskferry.toml become extra --ro-bind pairs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-readonly-dir-"));
  const roTarget = fs.mkdtempSync(path.join(os.tmpdir(), "axi-readonly-target-"));
  fs.writeFileSync(path.join(directory, ".taskferry.toml"), `read_only_paths = [${JSON.stringify(roTarget)}]\n`);
  let captured = null;
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => { captured = { cmd, args, opts }; return fakeChild(); },
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    platform: "linux",
  });
  mgr.dispatch({ prompt: "hello", directory, model: "opencode-go/minimax-m3", executor: "opencode" });
  const roBindIndex = captured.args.indexOf("--ro-bind");
  const roPairs = [];
  for (let i = 0; i < captured.args.length - 2; i++) {
    if (captured.args[i] === "--ro-bind") roPairs.push([captured.args[i + 1], captured.args[i + 2]]);
  }
  assert.ok(roPairs.some(([src, dest]) => src === roTarget && dest === roTarget), `expected a --ro-bind pair for ${roTarget}, got ${JSON.stringify(roPairs)}`);
  assert.ok(roBindIndex !== -1);
});

test("a read_only_paths entry that doesn't exist on this host is skipped and warned, not fatal", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-readonly-missing-"));
  const missing = path.join(os.tmpdir(), "axi-readonly-does-not-exist");
  fs.writeFileSync(path.join(directory, ".taskferry.toml"), `read_only_paths = [${JSON.stringify(missing)}]\n`);
  const mgr = makeManager({
    spawnFn: () => fakeChild(),
    sandboxEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    platform: "linux",
  });
  const dispatched = mgr.dispatch({ prompt: "hello", directory, model: "opencode-go/minimax-m3", executor: "opencode" });
  const status = mgr.status(dispatched.id);
  assert.match(status.projectConfigWarning, /read_only_paths/);
  assert.match(status.projectConfigWarning, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.sandbox.test.js`
Expected: FAIL (no `read_only_paths` handling yet).

- [ ] **Step 3: Add the shared, validated read-only-bind resolver**

Add this to `src/project-config.js` (exported, so both `buildBwrapBinds` here and `startCheckGate` in Task 5 call the identical function — a single enforcement point rather than two copies that could drift):

```js
/**
 * Filters a project's declared `read_only_paths` down to safe `[src, dest]`
 * ro-bind pairs: an entry is dropped (and reported) if it doesn't exist on
 * this host, or if it overlaps a protected mount -- equals it, is an
 * ancestor of it, or is a descendant of it. bwrap applies mounts in argument
 * order and `read_only_paths` binds land last (see `buildBwrapArgs`), so an
 * overlapping entry would either shadow a protected mount (e.g.
 * `read_only_paths = ["/"]` re-exposing the deny-listed `~/.ssh` a `--tmpfs`
 * mount hid, or shadowing the overlay mount entirely) or punch a read hole
 * into an otherwise-hidden protected directory (e.g.
 * `["~/.ssh/known_hosts"]`). `.taskferry.toml` is project-supplied, not
 * daemon-trusted, so this check is mandatory, not defensive nicety.
 * @param {string[]} readOnlyPaths
 * @param {{protectedPaths: string[], existsFn: (p: string) => boolean}} ctx
 * @returns {{roBinds: [string, string][], missing: string[], unsafe: string[]}}
 */
export function resolveReadOnlyProjectBinds(readOnlyPaths, ctx) {
  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  const roBinds = [];
  const missing = [];
  const unsafe = [];
  for (const p of readOnlyPaths) {
    if (!ctx.existsFn(p)) { missing.push(p); continue; }
    if (ctx.protectedPaths.some((protectedPath) => overlaps(p, protectedPath))) { unsafe.push(p); continue; }
    roBinds.push([p, p]);
  }
  return { roBinds, missing, unsafe };
}
```

(`path` is already imported in `project-config.js` from Task 1.)

- [ ] **Step 4: Wire it into `buildBwrapBinds`**

In `src/tasks.js`'s `buildBwrapBinds` (~line 784), the function already has `task` as a parameter and already computes `denyList` above this point. Replace:

```js
  const extraRoBinds = [...executorRoBinds];
  if (promptFilePath) extraRoBinds.push([ctx.PROMPT_DIR, ctx.PROMPT_DIR]);
```

with:

```js
  const extraRoBinds = [...executorRoBinds];
  if (promptFilePath) extraRoBinds.push([ctx.PROMPT_DIR, ctx.PROMPT_DIR]);
  const projectConfig = loadProjectConfig(launchDirectory);
  if (projectConfig.parseError) {
    task.projectConfigWarning = projectConfig.parseError;
  } else {
    const { roBinds, missing, unsafe } = resolveReadOnlyProjectBinds(projectConfig.readOnlyPaths, {
      protectedPaths: [...denyList, ctx.stateDir, ctx.runtimeDir, launchDirectory],
      existsFn: ctx.existsFn,
    });
    extraRoBinds.push(...roBinds);
    const warnings = [];
    if (missing.length) warnings.push(`not found on this host, skipped: ${missing.join(", ")}`);
    if (unsafe.length) warnings.push(`overlaps a protected sandbox mount, skipped: ${unsafe.join(", ")}`);
    if (warnings.length) task.projectConfigWarning = `.taskferry.toml read_only_paths ${warnings.join("; ")}`;
  }
```

(`loadProjectConfig` and `resolveReadOnlyProjectBinds` are both already imported at the top of `src/tasks.js` from Task 3/this step.)

- [ ] **Step 5: Add a mount-order-safety test, then run the tests to verify they pass**

Add one more case to `src/tasks.sandbox.test.js` alongside the existing two (Step 1) proving the safety check actually rejects an overlapping entry, e.g. `read_only_paths = ["/"]` (or the resolved `homeDir`) against a `directory` inside a tmpdir — assert `roBinds` excludes it and `unsafe`/`projectConfigWarning` reports it.

Run: `env -u TASKFERRY_CHILD node --test src/tasks.sandbox.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full unit suite and commit**

Run: `npm run test:unit`
Expected: PASS.

```bash
git add src/tasks.js src/project-config.js src/tasks.sandbox.test.js
git commit -m "feat(sandbox): bind .taskferry.toml read_only_paths read-only, reject overlapping protected mounts"
```

---

## Task 5: The verification gate (async check-command runner)

**Files:**
- Modify: `src/tasks.js` (new `startCheckGate`/`lastLines`/constants near `extractChangesetForTaskRecord` ~line 4293; wiring into `extractChangesetForTaskRecord`'s `hasChanges` branch ~line 4364; wiring `startCheckGate` as a genuine top-level `ctx.env.startCheckGate` key in `buildManagerEnvHelpers`, ~line 3284)
- Test: new `src/tasks.checkgate.test.js`
- Modify: `package.json` (register `src/tasks.checkgate.test.js` in `test:unit`)

This is the core of the spec. The gate spawns the project's declared check command inside the *same* bwrap overlay mount the worker ran with (`task.overlayDirs`), asynchronously, with a timeout, and records the outcome. It never blocks the daemon's event loop — everything here is event-driven, following `spawnTaskChild`'s existing async spawn pattern (`src/tasks.js:1220-1296`), never `runOverlayCommandFn`'s synchronous `spawnSync` pattern used by extraction itself.

**Kill mechanism (redesigned after external review — verified empirically, not asserted).** An earlier draft of this task assumed bwrap's `--unshare-pid` namespace teardown kills every process inside the sandbox once the top-level `bwrap` monitor dies from a plain-pid `SIGTERM`/`SIGKILL`. **That assumption was tested directly on this host** (bubblewrap 0.11.2, the exact flags `buildBwrapArgs` emits) and is false: killing the monitor left the inner workload alive as an orphan in 7/7 trials. The actual fix is smaller than a redesign — it's a wiring bug. `spawnTaskChild` (`src/tasks.js:1220-1296`) already spawns the worker with `detached: true` specifically so `sendSignalToProcess` (`src/tasks.js:4174`) can group-kill it via `killFn(-pid, signal)`; the gate's spawn simply never got the same `detached: true`, so its group-kill attempt hits ESRCH (no such process group — the gate's PGID is the daemon's) and silently falls back to a plain-pid signal that only kills the monitor, not the namespace's init. Step 3 below spawns the gate `detached: true` too, reusing the exact mechanism `cancel()` already relies on for workers — no new kill primitive, no new signal-routing code.
- Consumes: `task.overlayDirs: {upperDir, workDir, rwBinds, rwFileBinds}` (set by `assembleBwrapSpawn`, Task 5 reads it, never writes it), `loadProjectConfig` (Task 1), `resolveReadOnlyProjectBinds` (Task 4, reused here for sandbox parity — see Step 3), `buildBwrapArgs`/`defaultDenyList`/`platformSupportsSandbox` (already imported in `tasks.js` from `./sandbox.js`), Task 2's `task.checkStatus`/`checkCommand`/`checkExitCode`/`checkOutputTail`/`checkStartedAt`/`checkEndedAt`/`projectConfigWarning`/`checkGatePid` fields.
- Produces: `startCheckGate(task: Task, ctx): void` — fire-and-forget, called exactly once from `extractChangesetForTaskRecord` (and only for git-tracked targets, per the `isGitTarget` gate in Step 4 below), and registered as `ctx.env.startCheckGate` (a genuine top-level key returned by `buildManagerEnvHelpers`, not a closure buried inside another function's argument object) so Task 7's restart-recovery sweep can call the exact same binding. Task 6's accept/reject gating consumes the `checkStatus` values this function writes (`"running"|"passed"|"failed"|"timeout"`) — do not introduce a different status string without updating Task 6 to match. Task 6's in-flight-gate kill handshake also consumes the new `ctx.env.killGateAndWait(taskId)` (Step 3, exposed via Step 5) to group-kill the running bwrap child and *wait for it to actually exit* — not just fire a signal and immediately proceed — before `releaseOverlay` reclaims the overlay. Task 7's interrupted-gate sweep consumes the `"running"` status specifically as the signal that a gate was in flight when the daemon died, AND re-invokes `startCheckGate` on the same task if the overlay is still live (per the design's "the gate is re-runnable" promise), first best-effort-killing any orphaned process group left by an *unclean* daemon crash (the one path where nothing ever sent a signal at all).

- [ ] **Step 1: Write the failing tests**

Create `src/tasks.checkgate.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { makeManager, fakeChild } from "./tasks.test-helpers.js";

// A bwrap-shaped fake child with separate stdout/stderr streams and a real
// pid, distinct from fakeChild() (which only wires stdout) -- the gate reads
// both streams, so tests need both to exist as EventEmitters.
function fakeGateChild(pid = 9000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function dispatchAndSettleWithChanges({ directory, spawns, sandboxEnabled = true }) {
  const mgr = makeManager({
    spawnFn: (cmd, args, opts) => { const child = spawns.length === 0 ? fakeChild() : fakeGateChild(); spawns.push({ cmd, args, opts, child }); return child; },
    sandboxEnabled,
    // buildManagerOptions() defaults overlayEnabled to false -- without this,
    // task.overlayDirs never gets set, startCheckGate's `!task.overlayDirs`
    // guard always no-ops, and every test below would see only one spawn.
    overlayEnabled: true,
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    platform: "linux",
    runOverlayCommandFn: (command, args) => {
      // Simulate a real changeset: `git diff` (or the sh -c wrapper extraction
      // uses) reports non-empty output so extraction sets changesetStatus to
      // "pending" and startCheckGate() gets a chance to run.
      if (command === "bwrap") return { status: 0, stdout: "diff --git a/f b/f\n+changed\n", stderr: "" };
      if (args?.[0] === "-C") return { status: 0, stdout: "abc123\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const dispatched = mgr.dispatch({ prompt: "hello", directory, model: "opencode-go/minimax-m3", executor: "opencode" });
  spawns[0].child.emit("exit", 0, null); // settles the worker; extraction + startCheckGate run synchronously off this
  return { mgr, dispatched };
}

describe("startCheckGate", () => {
  test("no .taskferry.toml: checkStatus stays 'none', no second spawn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-none-"));
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ directory, spawns });
    assert.equal(spawns.length, 1); // only the worker spawn, no gate spawn
    assert.equal(mgr.status(dispatched.id).checkStatus, undefined); // "none" is never surfaced
  });

  test("a declared check command spawns a second bwrap invocation over the same overlay after extraction", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-spawn-"));
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `check = "npm test"\n`);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ directory, spawns });
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1].cmd, "bwrap");
    assert.ok(spawns[1].args.includes("npm test"));
    assert.equal(mgr.status(dispatched.id).checkStatus, "running");
  });

  test("exit 0 settles checkStatus 'passed' with exit code recorded", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-pass-"));
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `check = "npm test"\n`);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ directory, spawns });
    spawns[1].child.stdout.emit("data", Buffer.from("all good\n"));
    spawns[1].child.emit("exit", 0, null);
    const status = mgr.status(dispatched.id);
    assert.equal(status.checkStatus, "passed");
    assert.equal(status.checkExitCode, 0);
  });

  test("nonzero exit settles checkStatus 'failed' and captures the last 40 lines of combined output", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-fail-"));
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `check = "npm test"\n`);
    const spawns = [];
    const { mgr, dispatched } = dispatchAndSettleWithChanges({ directory, spawns });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    spawns[1].child.stdout.emit("data", Buffer.from(lines));
    spawns[1].child.emit("exit", 1, null);
    const detail = mgr.result(dispatched.id, { fields: ["checkOutputTail"] });
    assert.equal(detail.checkStatus, "failed");
    assert.equal(detail.checkExitCode, 1);
    assert.equal(detail.checkOutputTail.split("\n").length, 40);
    assert.ok(detail.checkOutputTail.startsWith("line 10"));
  });

  test("a timed-out gate is killed and settles checkStatus 'timeout'", { concurrency: false }, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gate-timeout-"));
    fs.writeFileSync(path.join(directory, ".taskferry.toml"), `check = "npm test"\ncheck_timeout_seconds = 5\n`);
    const spawns = [];
    const signals = [];
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => { const child = spawns.length === 0 ? fakeChild() : fakeGateChild(); spawns.push({ cmd, args, opts, child }); return child; },
      sandboxEnabled: true,
      overlayEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      // buildManagerOptions() only forwards `killFn` to createTaskManager,
      // not a `sendSignal` option -- the internal `sendSignal` binding wraps
      // sendSignalToProcess(pid, signal, { killFn: ctx.opts.killFn }), so the
      // fake must be injected at that seam or it's silently ignored and the
      // real default killFn (which throws) fires instead.
      killFn: (pid, signal) => signals.push({ pid, signal }),
      runOverlayCommandFn: (command) => (command === "bwrap" ? { status: 0, stdout: "diff\n", stderr: "" } : { status: 0, stdout: "abc\n", stderr: "" }),
    });
    const dispatched = mgr.dispatch({ prompt: "hello", directory, model: "opencode-go/minimax-m3", executor: "opencode" });
    spawns[0].child.emit("exit", 0, null);
    t.mock.timers.tick(5000);
    assert.ok(signals.some((s) => s.signal === "SIGTERM"));
    // sendSignalToProcess tries the process-group form first (negative pid) --
    // this only reaches the sandboxed workload at all because the gate is
    // spawned `detached: true` (Step 3). A positive-pid-only signal here
    // would mean the fix regressed back to killing just the bwrap monitor.
    assert.ok(signals.some((s) => s.signal === "SIGTERM" && s.pid < 0), `expected a process-group SIGTERM (negative pid), got ${JSON.stringify(signals)}`);
    assert.ok(spawns[1].opts.detached === true, "gate child must be spawned detached so group-kill can reach it");
    spawns[1].child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).checkStatus, "timeout");
  });
});
```

Before finalizing this file, read `src/tasks.test-helpers.js`'s actual `makeManager` signature (which options it forwards to `createTaskManager`, e.g. whether `sendSignal`/`runOverlayCommandFn`/`checkBwrapAvailableFn` are already supported injection points — `tasks.sandbox.test.js` already proves `checkBwrapAvailableFn`/`sandboxEnabled`/`platform` work) and adjust the fake `runOverlayCommandFn` above to match the *real* shell command extraction actually issues (it runs `bwrap ... -- sh -c "git -C <dir> add -A && { git -C <dir> diff --cached <head>; ...}"` per `extractGitDiff` in `src/changeset.js:194` — the fake above simplifies this to "return non-empty stdout for the `bwrap` command", which needs verifying against how `mgr.dispatch`'s `preDispatchHead`-resolution `git rev-parse HEAD` call is distinguished from the extraction call in the same fake `runOverlayCommandFn`; adjust the fake's dispatch logic on `command`/`args[0]` to whatever actually reaches it once run once against the real code, rather than guessing blind).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.checkgate.test.js`
Expected: FAIL (`startCheckGate` doesn't exist, no second spawn ever happens).

- [ ] **Step 3: Implement `startCheckGate` in `src/tasks.js`**

Add these module-level constants near the other `DEFAULT_*` constants (~line 1298):

```js
// SIGTERM -> SIGKILL grace on a timed-out gate, matching cancel()'s own
// default cancelGraceMs (src/args.js's --grace-ms default). Also the bound
// killGateAndWait() (below) uses for the accept/reject kill handshake.
const CHECK_GATE_KILL_GRACE_MS = 5000;
// Cap on the gate's combined stdout+stderr buffer. Appended chunks that
// would push `output` past this cap are not rejected outright (a gate is
// not attacker-controlled input, unlike a client request body); instead
// the buffer is trimmed from the front so it stays under the cap, keeping
// the last N bytes of a chatty test suite and bounding the daemon's
// heap regardless of how long the gate runs.
const CHECK_GATE_OUTPUT_CAP_BYTES = 256 * 1024;
```

(There is intentionally no `DEFAULT_CHECK_TIMEOUT_SECONDS` constant here — the real default lives in `project-config.js` (`DEFAULT_CHECK_TIMEOUT_SECONDS = 900`), is already resolved into `projectConfig.checkTimeoutSeconds` by `loadProjectConfig`, and is what `startCheckGate` reads from. Re-declaring it here would be an unused `no-unused-vars` lint trip and a second source of truth.)

Add one new manager-level Map to `ManagerContext`'s `maps` namespace, next to the existing `tasks`/`waiters`/`advisorSessions` Maps (wherever that object is constructed, alongside `bootstrapManagerContext` — check the real init site before editing): `gateChildren: new Map()`. This tracks each in-flight gate's live `ChildProcess` by task id so `killGateAndWait` (Step 3 below) can signal it and actually wait for it to exit — the exit/error handlers inside `startCheckGate` are the only place with a reference to the real `child` object, so without this map nothing outside `startCheckGate`'s own closure could ever confirm the kill worked.

Add this helper near `extractChangesetForTaskRecord` (~line 4293), and the gate runner itself right after it:

```js
/**
 * Tail-trims combined stdout+stderr to the last `n` lines, per the design's
 * "last ~40 lines of combined output" contract for checkOutputTail.
 * @param {string} text
 * @param {number} [n]
 * @returns {string}
 */
function lastLines(text, n = 40) {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

/**
 * Appends a chunk to the gate's combined stdout+stderr buffer, trimming from
 * the front when the buffer would otherwise exceed CHECK_GATE_OUTPUT_CAP_BYTES.
 * A chatty test suite (e.g. tsc emitting a type error per line, vitest
 * repeating the verbose reporter per file) would otherwise grow the daemon's
 * heap unbounded for up to checkTimeoutSeconds. `tail` is severed
 * byte-exact so a UTF-8 multi-byte sequence straddling the cut point is
 * discarded rather than reported as a malformed tail -- the resulting
 * `checkOutputTail` is a debug aid, not a contractual view.
 * @param {string} tail
 * @param {Buffer|string} chunk
 */
function appendBoundedOutput(tail, chunk) {
  const next = tail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  if (next.length <= CHECK_GATE_OUTPUT_CAP_BYTES) return next;
  return next.slice(next.length - CHECK_GATE_OUTPUT_CAP_BYTES);
}

/**
 * Starts the verification gate for a task whose changeset just extracted
 * with real changes: spawns the project's declared check command inside the
 * SAME bwrap overlay mount the worker ran with (task.overlayDirs), so gate
 * side effects (test caches, build artifacts) land in the overlay's upper --
 * never on the real directory, and never contaminating the diff already
 * written to disk by extraction, which ran first. Fire-and-forget and fully
 * async (spawnFn, not the synchronous runOverlayCommandFn extraction uses):
 * a check command can run up to checkTimeoutSeconds (default 900s) and must
 * never block the daemon's event loop. No-ops (leaves checkStatus at
 * buildDispatchTask's "none" default) when there's no overlay, the task
 * isn't a dispatch-role task, the platform can't sandbox, the task isn't
 * a git-target dispatch (no `preDispatchHead` -> nothing git-tracked to
 * verify against; see Step 4), or the project declares no check command --
 * there is no isolated tree to gate against without an overlay, per the
 * design's non-goal "Gating --no-overlay / non-git dispatches."
 * @param {Task} task
 * @param {{spawnFn: typeof import("node:child_process").spawn, stateDir: string, runtimeDir: string, existsFn: (p: string) => boolean, sandboxDenylist: string[], persistTask: (taskId: string) => void, scheduleActivity: (task: Task, options?: {force?: boolean}) => Promise<unknown>, sendSignal: (pid: number, signal: NodeJS.Signals) => void, platform: NodeJS.Platform, gateChildren: Map<string, import("node:child_process").ChildProcess>}} ctx
 */
function startCheckGate(task, ctx) {
  if (!task.overlayDirs || task.role !== "dispatch" || !platformSupportsSandbox(ctx.platform)) return;
  const projectConfig = loadProjectConfig(task.directory);
  if (projectConfig.parseError) {
    task.projectConfigWarning = projectConfig.parseError;
    ctx.persistTask(task.id);
    return;
  }
  if (!projectConfig.check) return;

  const denyList = [...defaultDenyList(os.homedir(), ctx.stateDir), ...ctx.sandboxDenylist].filter(ctx.existsFn);
  // Sandbox parity (review finding): the worker's read_only_paths binds and
  // the gate's must be identical, or a check command that reads a
  // read-only-mounted path passes for the worker and fails in the gate (or
  // vice versa). Reuse Task 4's exact validated resolver rather than a
  // second, potentially-drifting copy of the mount-order safety logic.
  const { roBinds: readOnlyBinds } = resolveReadOnlyProjectBinds(projectConfig.readOnlyPaths, {
    protectedPaths: [...denyList, ctx.stateDir, ctx.runtimeDir, task.directory],
    existsFn: ctx.existsFn,
  });
  const spawnArgs = buildBwrapArgs({
    directory: task.directory,
    stateDir: ctx.stateDir,
    runtimeDir: ctx.runtimeDir,
    homeDir: os.homedir(),
    denyList,
    extraRoBinds: readOnlyBinds,
    overlay: { upperDir: task.overlayDirs.upperDir, workDir: task.overlayDirs.workDir },
    overlayRwBinds: task.overlayDirs.rwBinds ?? [],
    overlayRwFileBinds: task.overlayDirs.rwFileBinds ?? [],
    // Security (review finding, verified against src/sandbox.js:277-308
    // directly): buildBwrapArgs defaults runtimeDirWritable to true, which
    // would hand the gate's check command a writable bind onto the daemon's
    // control socket -- a worker-controlled check (npm test, a Makefile
    // target) could then connect out and call `taskferry accept --force` on
    // its own pending task. The gate is verification, not a trusted daemon
    // component; it gets read-only access to the runtime dir, same as any
    // other untrusted sandboxed process.
    runtimeDirWritable: false,
  }).concat(["--", "sh", "-c", projectConfig.check]);
  // Known gap, not fixed in this pass: unlike the worker's spawn
  // (buildBwrapBinds), the gate does not forward the worker's
  // extraRwBinds/extraRwPairBinds (executor auth binds, allowedDirs, the
  // sandboxed data home) -- those aren't currently persisted anywhere on
  // `task` for the gate to reuse. A check command that specifically needs
  // one of those (rather than read_only_paths, which IS threaded above)
  // will diverge from the worker's view. Flagged for a follow-up if a real
  // check command hits it; not blocking this plan.

  task.checkStatus = "running";
  task.checkCommand = projectConfig.check;
  task.checkExitCode = null;
  task.checkOutputTail = null;
  task.checkStartedAt = new Date().toISOString();
  task.checkEndedAt = null;
  task.checkGatePid = null;
  ctx.persistTask(task.id);
  void ctx.scheduleActivity(task, { force: true });

  // Strip every TASKFERRY_* env var from the daemon's ambient before handing
  // it to the gate's bwrap child. This is the narrowest fix for the #292
  // leak class when the daemon itself was auto-started by a dispatched ferry
  // (the daemon's ambient carries TASKFERRY_CHILD=1, and a repo's gate
  // command -- e.g. `npm test` -- sees that and branches on it). The gate
  // is an internal spawn, not a dispatched worker, so it doesn't need the
  // envFileVars/caller-denylist machinery sanitizedEnvironment applies to a
  // dispatch's payload env; a per-key filter is sufficient and local to this
  // function.
  const gateEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TASKFERRY_")));

  let output = "";
  let timedOut = false;
  // Node can emit both `error` and `exit` for the same child (e.g. ENOENT
  // on a missing binary fires `error` then `exit` with code null). Without
  // this guard, both paths would independently call settle() and double-
  // persist / double-fire scheduleActivity. The closure variable is set on
  // first entry and skipped thereafter.
  let settled = false;
  let child;
  try {
    // detached: true (review fix, empirically required -- see the "Kill
    // mechanism" note above this task): makes the gate its own process-group
    // leader, the same way spawnTaskChild() already does for workers
    // (src/tasks.js:1237), so sendSignalToProcess's group-kill actually
    // reaches the sandboxed workload instead of only the bwrap monitor.
    child = ctx.spawnFn("bwrap", spawnArgs, { cwd: task.directory, env: gateEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (err) {
    // A synchronous throw (e.g. `bwrap` binary missing) would otherwise
    // escape startCheckGate entirely, leaving the task stuck on
    // checkStatus: "running" forever. Mirror the async `error` handler's
    // field values so the persisted record is the same shape.
    task.checkStatus = "failed";
    task.checkExitCode = null;
    task.checkOutputTail = `spawn error: ${errMessage(err)}`;
    task.checkEndedAt = new Date().toISOString();
    task.checkGatePid = null;
    ctx.persistTask(task.id);
    void ctx.scheduleActivity(task, { force: true });
    return;
  }
  task.checkGatePid = child.pid ?? null;
  // Track the live child by task id so killGateAndWait() (below), called
  // from accept/reject, can find the same process object this closure holds
  // and actually wait for its "exit" event -- see the Kill mechanism note.
  ctx.gateChildren.set(task.id, child);
  ctx.persistTask(task.id);

  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid != null) ctx.sendSignal(child.pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.pid != null) ctx.sendSignal(child.pid, "SIGKILL");
    }, CHECK_GATE_KILL_GRACE_MS);
    killTimer.unref();
  }, projectConfig.checkTimeoutSeconds * 1000);
  timer.unref();

  child.stdout?.on("data", (chunk) => { output = appendBoundedOutput(output, chunk); });
  child.stderr?.on("data", (chunk) => { output = appendBoundedOutput(output, chunk); });

  /** @param {"passed"|"failed"|"timeout"} status @param {number|null} exitCode */
  const settle = (status, exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ctx.gateChildren.delete(task.id);
    // A gate that finishes after an accept/reject already settled the task
    // (changesetStatus moved off "pending") must NOT overwrite the
    // already-decided outcome. Task 6's accept/reject path is responsible
    // for killing the in-flight gate AND awaiting its actual exit (via
    // killGateAndWait, which reads ctx.gateChildren -- this is why the
    // delete() above must run before releaseOverlay can proceed, not just
    // before this function returns) before releaseOverlay reclaims the
    // overlay; this guard is the right side of that handshake -- it
    // preserves the decided outcome even if a late exit event still fires
    // after the kill has already resolved.
    if (task.changesetStatus !== "pending") return;
    task.checkStatus = status;
    task.checkExitCode = exitCode;
    task.checkOutputTail = lastLines(output);
    task.checkEndedAt = new Date().toISOString();
    task.checkGatePid = null;
    ctx.persistTask(task.id);
    void ctx.scheduleActivity(task, { force: true });
  };

  child.on("exit", (code, signal) => {
    if (timedOut) { settle("timeout", code); return; }
    if (signal) { settle("failed", code); return; }
    settle(code === 0 ? "passed" : "failed", code);
  });
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ctx.gateChildren.delete(task.id);
    task.checkStatus = "failed";
    task.checkExitCode = null;
    task.checkOutputTail = `spawn error: ${errMessage(err)}`;
    task.checkEndedAt = new Date().toISOString();
    task.checkGatePid = null;
    ctx.persistTask(task.id);
    void ctx.scheduleActivity(task, { force: true });
  });
}

/**
 * Sends a process-group SIGTERM to a task's in-flight check gate and waits
 * for it to actually exit (escalating to SIGKILL after
 * CHECK_GATE_KILL_GRACE_MS if it hasn't) before resolving. Task 6's
 * accept/reject must await this BEFORE calling releaseOverlay -- sending a
 * signal and immediately proceeding (the earlier draft of this plan) is not
 * a handshake, it's a race: the overlay's upper dir can be chmod'd/rm -rf'd
 * out from under a gate child that is still mid-write. Best-effort bounded:
 * if the child still hasn't exited CHECK_GATE_KILL_GRACE_MS after the
 * SIGKILL, this gives up and resolves anyway rather than hanging
 * accept/reject forever -- a leftover process at that point means something
 * is genuinely wrong (worth investigating via `ps`) and is not worth
 * blocking the user's accept/reject call on indefinitely.
 * @param {string} taskId
 * @param {{gateChildren: Map<string, import("node:child_process").ChildProcess>, sendSignal: (pid: number, signal: NodeJS.Signals) => void}} ctx
 * @returns {Promise<void>}
 */
async function killGateAndWait(taskId, ctx) {
  const child = ctx.gateChildren.get(taskId);
  if (!child || child.pid == null) return; // already exited, or never tracked
  const exited = new Promise((resolve) => child.once("exit", () => resolve()));
  ctx.sendSignal(child.pid, "SIGTERM");
  if (await raceTimeout(exited, CHECK_GATE_KILL_GRACE_MS)) return;
  ctx.sendSignal(child.pid, "SIGKILL");
  await raceTimeout(exited, CHECK_GATE_KILL_GRACE_MS);
}

/**
 * @param {Promise<void>} promise
 * @param {number} ms
 * @returns {Promise<boolean>} true if `promise` settled before the timeout
 */
function raceTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}
```

(A note on `sendSignal` for the timeout-escalation path above: it ultimately calls `sendSignalToProcess` (`src/tasks.js:4174`), which tries `killFn(-pid, signal)` first -- a process-group signal. Because the gate is now spawned `detached: true` (this step), its PGID is its own, so the group-kill actually reaches every process bwrap's namespace started, not just the monitor. This was verified empirically, not assumed: an earlier draft of this plan asserted that bwrap's own `--unshare-pid` namespace teardown alone kills the workload once the monitor dies from a plain-pid signal, and that claim was tested directly on this host (bubblewrap 0.11.2, the exact flags `buildBwrapArgs` emits) -- the inner workload survived as an orphan in 7/7 trials. `detached: true` plus the existing group-kill in `sendSignalToProcess` is the real, verified fix, and it's the exact mechanism `cancel()` already relies on for workers -- no new kill primitive.)

Add the import at the top of `src/tasks.js` (extend the existing `./project-config.js` import from Task 3):

```js
import { loadProjectConfig, verificationPromptBlock } from "./project-config.js";
```

(already present after Task 3 — no separate edit needed here if Task 3 landed first.)

- [ ] **Step 4: Wire the gate into extraction's completion path**

In `extractChangesetForTaskRecord` (~line 4364), change:

```js
  } else if (extracted.hasChanges) {
    finishedTask.changesetStatus = "pending";
  } else {
```

to:

```js
  } else if (extracted.hasChanges) {
    finishedTask.changesetStatus = "pending";
    if (isGitTarget) ctx.startCheckGate(finishedTask);
  } else {
```

(`isGitTarget = finishedTask.preDispatchHead != null` is already computed in this function's scope, just above where the gate wiring goes; the gate is itself git-only, because for a non-git / overlay-only target the gate's `bwrap` overlay mount is the same `merged` view that `applyNonGitChangeset` (`src/changeset.js:433-445`) will rsync onto the real directory on accept -- so anything the gate wrote into the overlay's `upper` (test caches, build artifacts, generated `.tsbuildinfo`) would land on the real tree too, exactly the kind of contamination the gate is supposed to prevent. Skipping the gate for non-git targets matches the design's overlay-only non-goal reasoning and means overlay-only tasks get no verification gate at all. `checkStatus` stays at its default `"none"` for those tasks, and the `none` warning in `runAccept` (Task 6 Step 5) tells the user that's why no gate ran.)

Add `startCheckGate` to `extractChangesetForTaskRecord`'s own `ctx` JSDoc param type (the block above its signature, ~line 4299): append `, startCheckGate: (task: Task) => void` to the object type.

- [ ] **Step 5: Wire `startCheckGate` as a genuine top-level `ctx.env` binding**

**Wiring fix (added after external review — verified against `buildManagerEnvHelpers`'s actual return shape at `src/tasks.js:3261-3290`, not assumed).** An earlier draft of this step nested the `startCheckGate` closure *inside* the argument object passed to `extractChangesetForTaskRecord(finishedTask, {...})` — that object is local to a single call and is never itself returned from `buildManagerEnvHelpers`, so nothing outside that one call site could ever reach it. Task 7's restart-recovery sweep needs to invoke the exact same binding independently (a daemon restart calls it directly, with no `extractChangesetForTaskRecord` call involved), so `startCheckGate` must be its own top-level key on the object `buildManagerEnvHelpers` returns (i.e. a real `ctx.env.startCheckGate`), not a value buried inside another function's parameter object.

In `src/tasks.js`'s `buildManagerEnvHelpers` (~line 3261, the function whose returned object becomes `ctx.env`), the `extractChangesetForTask:` entry currently reads:

```js
    extractChangesetForTask: (finishedTask) => extractChangesetForTaskRecord(finishedTask, { stateDir: ctx.opts.stateDir, runtimeDir: ctx.opts.runtimeDir, existsFn: ctx.opts.existsFn, sandboxDenylist: ctx.opts.sandboxDenylist, runOverlayCommandFn: ctx.opts.runOverlayCommandFn, overlaySleepFn: ctx.opts.overlaySleepFn, persistTask: (taskId) => ctx.helpers.persistTask(taskId), releaseOverlay }),
```

Replace it with a real `startCheckGate` binding defined once, alongside it in the same returned object (not nested inside `extractChangesetForTask`'s own call):

```js
    /** @param {Task} task */
    startCheckGate: (task) => startCheckGate(task, {
      spawnFn: ctx.opts.spawnFn,
      stateDir: ctx.opts.stateDir,
      runtimeDir: ctx.opts.runtimeDir,
      existsFn: ctx.opts.existsFn,
      sandboxDenylist: ctx.opts.sandboxDenylist,
      persistTask: (taskId) => ctx.helpers.persistTask(taskId),
      scheduleActivity: (t, options) => ctx.helpers.scheduleActivity(t, options),
      sendSignal: (pid, signal) => ctx.helpers.sendSignal(pid, signal),
      platform: ctx.opts.platform,
      gateChildren: ctx.maps.gateChildren,
    }),
    /** @param {string} taskId */
    killGateAndWait: (taskId) => killGateAndWait(taskId, { gateChildren: ctx.maps.gateChildren, sendSignal: (pid, signal) => ctx.helpers.sendSignal(pid, signal) }),
    extractChangesetForTask: (finishedTask) => extractChangesetForTaskRecord(finishedTask, { stateDir: ctx.opts.stateDir, runtimeDir: ctx.opts.runtimeDir, existsFn: ctx.opts.existsFn, sandboxDenylist: ctx.opts.sandboxDenylist, runOverlayCommandFn: ctx.opts.runOverlayCommandFn, overlaySleepFn: ctx.opts.overlaySleepFn, persistTask: (taskId) => ctx.helpers.persistTask(taskId), releaseOverlay, startCheckGate: (task) => ctx.env.startCheckGate(task) }),
```

(`extractChangesetForTaskRecord`'s own `ctx` param still needs a `startCheckGate` key — Step 4 above already added `startCheckGate: (task: Task) => void` to its JSDoc typedef — but now it's a one-line passthrough to the real `ctx.env.startCheckGate`, not a second copy of the construction logic. `ctx.maps.gateChildren` is the `Map` added in Step 3's constants section above; verify the actual name/location of the `maps` namespace in current source before applying — mirror wherever `ctx.maps.tasks`/`ctx.maps.waiters` already live.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.checkgate.test.js`
Expected: PASS. If the timeout test's `t.mock.timers` usage doesn't match this Node version's `node:test` mock-timer API, check `node --version` (this repo requires `>=16.9` per `package.json`'s `engines`, but the checked-out runtime may be newer) and adapt to whatever this repo's other timer-dependent tests already use (grep `mock.timers` across `src/*.test.js` for the established pattern before inventing a new one).

- [ ] **Step 7: Register the test file and run the full suite**

Add `src/tasks.checkgate.test.js` to `package.json`'s `test:unit` script.

Run: `npm run test:unit`
Expected: PASS.

```bash
git add package.json src/tasks.js src/tasks.checkgate.test.js
git commit -m "feat(tasks): run the .taskferry.toml check command as a settle-time gate"
```

---

## Task 6: Accept/reject gating (`--force`, fix-forward failure message)

**Files:**
- Modify: `src/tasks.js` (`validateAcceptable` ~line 2558, `acceptTaskChangeset`/`rejectTaskChangeset` ~line 4536/4589 — both now `async`, new `buildCheckGateFailureMessage`)
- Modify: `src/commands.js` (`runAccept` — "no check declared" warning)
- Modify: `src/protocol.js`, `src/daemon.js`, `src/client.js` (RPC error envelope gains a `detail` field so a multi-line check-gate failure message survives the daemon→client hop intact — Step 6)
- Test: `src/tasks.changeset.test.js`, `src/commands.test.js`, `src/daemon.test.js`, `src/client.test.js`, `src/protocol.test.js` (add new cases)

**Interfaces:**
- Consumes: `task.checkStatus`/`checkCommand`/`checkExitCode`/`checkOutputTail` (Task 5), `force` param threaded through in Task 2, `ctx.env.killGateAndWait` (Task 5, threaded through in this task's Step 4).
- Produces: `task.checkOverride: true` when `--force` overrides a blocking gate status (including `running`) — nothing downstream consumes this yet beyond what Task 2 already surfaces in `summarize()`/`computeResultDetail()`.

**`mgr.accept`/`mgr.reject` are now async (review fix — see Step 4).** Every test below that calls `mgr.accept(id, ...)` or `mgr.reject(id)` and reads a field off the return value, or relies on ordering relative to it, needs `await` — write these as `async` test functions. This is a real behavior change from a hypothetical pre-gate `accept`/`reject` (synchronous, since there was nothing to wait for before this feature), not a typo.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.changeset.test.js` (find and reuse whatever helper that file already uses to get a task into `changesetStatus: "pending"` with a live overlay — likely the same `dispatchAndSettleWithChanges`-shaped pattern from Task 5's new test file, or an existing one already in this file; do not duplicate a second copy of that helper if one already exists here):

```js
test("accept refuses a still-running check gate without --force", async () => {
  // Arrange a task with checkStatus: "running" (a real gate mid-flight),
  // then call await mgr.accept(id) with no options and assert it throws/
  // rejects matching /check gate still running/, and
  // await mgr.accept(id, { force: true }) succeeds.
});

test("accept refuses a failed check gate without --force, with the fix-forward message", async () => {
  // checkStatus: "failed", checkExitCode: 1, checkOutputTail: "2 tests failed",
  // sessionId set. Assert the thrown/rejected error's message includes the
  // command, "exit: 1", the output tail, and a `taskferry dispatch
  // --session-id ... --parent-task <id>` resume line.
});

test("accept --force on a failed gate succeeds and records checkOverride: true", async () => {
  // Assert (await mgr.accept(id, { force: true })).applied === true, and a
  // subsequent mgr.status(id).checkOverride === true.
});

test("accept on a passed or absent (checkStatus 'none') gate needs no --force", async () => {
  // checkStatus: "passed" (or task never had a gate at all) accepts normally.
});

test("reject is always allowed regardless of checkStatus, even without --force", async () => {
  // checkStatus: "failed", await mgr.reject(id) succeeds with no force option at all.
});

test("reject while the gate is still running kills the gate and waits for it to exit before releasing the overlay", async () => {
  // Arrange a task with checkStatus: "running" and a real fakeGateChild()
  // (Task 5's helper) registered in ctx.gateChildren, with a killFn fake
  // that records every call AND lets the test control when the fake
  // child's "exit" event fires. Call `const rejectPromise = mgr.reject(id)`
  // (don't await yet), assert killFn was called with a NEGATIVE pid
  // (process-group SIGTERM) before the fake child has emitted "exit", THEN
  // fire the fake child's exit event, THEN `await rejectPromise` and assert
  // it resolved only after that -- proving reject() actually waited for the
  // gate to die instead of racing ahead to releaseOverlay. Also assert the
  // task records changesetStatus: "rejected" and the rejected state doesn't
  // itself re-emit the running checkStatus as the final value -- the task's
  // in-memory checkStatus may still be "running" right up until the fake
  // child's exit fires (the gate's own exit handler is what would flip it),
  // but the task's persisted checkStatus was last written by settle() and
  // is overwritten by neither reject nor releaseOverlay (a deliberate
  // non-decision: the gate's own settle()-side guard
  // `if (task.changesetStatus !== "pending") return;` is what protects the
  // rejected status from being clobbered by a late-arriving gate exit).
});

test("a gate that settles after a reject is a no-op (task stays 'rejected', checkStatus unchanged from whatever it was when reject killed it)", async () => {
  // After await mgr.reject(id) has killed the gate (per the previous test's
  // pattern), fire the fake child's `exit` handler with code 0 and assert:
  // the task's persisted changesetStatus is still "rejected", checkOverride
  // is NOT set on a reject (override is accept-side only), and
  // scheduleActivity was NOT called again on the late exit. This is the
  // test that proves Task 5's `settled` closure AND the
  // `if (task.changesetStatus !== "pending") return;` guard inside settle()
  // together prevent a late-arriving gate exit from clobbering the rejected
  // outcome.
});
```

Write these against whatever this test file's real task-construction helpers actually look like (read the file first) rather than inventing new scaffolding — the point of each test is the assertion on `validateAcceptable`'s new branch, not how the task got into a `checkStatus`-carrying state.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.changeset.test.js`
Expected: FAIL (no gating logic yet; `reject` test may already pass since reject never checked `checkStatus`, which is correct and fine to leave green).

- [ ] **Step 3: Implement the gating in `validateAcceptable` and the failure message**

Add near `validateAcceptable` (~line 2558) in `src/tasks.js`:

```js
/**
 * Builds the fix-forward error message for a check-gate-blocked accept, per
 * the design's §5. `--force` is always offered as the escape hatch; the
 * resume command prefers --session-id when the worker's session survived,
 * falling back to a fresh --directory dispatch otherwise. The "interrupted"
 * branch is the one the design's "the gate is re-runnable" promise cares
 * about: a daemon crash mid-gate marks the task as "interrupted" on the
 * next boot, and the next daemon restart re-runs the gate automatically
 * whenever the overlay survives (Task 7). Render "interrupted" as a
 * re-run notice instead of the dead-looking `exit: null` the generic
 * `exit: ${task.checkExitCode}` line would otherwise produce, so the user
 * doesn't see a null exit and assume the gate's run is salvageable as-is.
 * @param {Task} task
 * @returns {string}
 */
function buildCheckGateFailureMessage(task) {
  const commandLine = `  command: ${task.checkCommand} (from .taskferry.toml)`;
  const exitLine = task.checkStatus === "timeout"
    ? "  timed out"
    : task.checkStatus === "interrupted"
      ? "  interrupted: the daemon died with this gate in flight; the gate will re-run automatically on the next daemon restart"
      : `  exit: ${task.checkExitCode}`;
  const outputTail = task.checkOutputTail
    ? `\n  output tail:\n${task.checkOutputTail.split("\n").map((line) => `    ${line}`).join("\n")}`
    : "";
  const resumeHint = task.sessionId
    ? `  taskferry dispatch --session-id ${task.sessionId} --parent-task ${task.id} \\\n    --prompt "Fix: check gate ${task.checkStatus}. See taskferry result ${task.id} --fields checkOutputTail"`
    : `  taskferry dispatch --directory ${task.directory} --parent-task ${task.id} \\\n    --prompt "Fix: check gate ${task.checkStatus} for task ${task.id}. See taskferry result ${task.id} --fields checkOutputTail"`;
  return `error: check gate ${task.checkStatus} for ${task.id}\n${commandLine}\n${exitLine}${outputTail}\nchangeset NOT accepted. To fix forward, resume the worker session:\n${resumeHint}\nOverride only if you have verified manually: taskferry accept ${task.id} --force`;
}
```

In `validateAcceptable`, add its `force` param and the new checks right before its final `return task.preDispatchHead != null;`:

```js
function validateAcceptable(task, { force = false, ...ctx }) {
  if (task.role === "advisor") {
    throw new Error(`error: task ${task.id} has role "advisor" and cannot be accepted\nhelp: use "taskferry result ${task.id} --diff" to inspect what it wrote -- advisor writes are never applied`);
  }
  if (task.changesetStatus !== "pending") {
    throw new Error(`error: task ${task.id} has no pending changeset (changesetStatus: ${task.changesetStatus ?? "none"})\nhelp: only a task with changesetStatus "pending" can be accepted`);
  }
  if (task.diffPath == null) {
    const overlayLocation = task.overlayDirs ? ` at ${task.overlayDirs.root}` : "";
    throw new Error(
      `error: task ${task.id}'s changeset was never extracted (${task.changesetError ?? "unknown reason"})\n` +
      `help: the overlay was preserved${overlayLocation} -- inspect it there directly, or "taskferry reject ${task.id}" to discard it`
    );
  }
  if (!ctx.existsFn(task.diffPath)) {
    throw new Error(
      `error: task ${task.id}'s diff file at ${task.diffPath} no longer exists\n` +
      `help: the state directory may have been partially cleaned; a pending changeset cannot be applied without its diff. Use "taskferry reject ${task.id}" to discard the pending state, or restore the diff file at the recorded path before retrying.`
    );
  }
  if (task.preDispatchHead == null && !ctx.hasLiveOverlay(task)) {
    throw new Error(
      `error: task ${task.id}'s overlay is gone (likely cleared by a reboot -- /tmp is a tmpfs)\n` +
      `help: a non-git changeset cannot be re-applied without its overlay; use "taskferry result ${task.id} --diff" for the informational diff, then "taskferry reject ${task.id}" to clear the pending state`
    );
  }
  if (!force) {
    if (task.checkStatus === "running") {
      throw new Error(`error: check gate still running for ${task.id}\nhelp: see \`taskferry status ${task.id}\` for progress, then retry accept once it settles, or \`taskferry accept ${task.id} --force\` to override`);
    }
    if (task.checkStatus === "failed" || task.checkStatus === "timeout" || task.checkStatus === "interrupted") {
      throw new Error(buildCheckGateFailureMessage(task));
    }
  }
  return task.preDispatchHead != null;
}
```

(Only the new `!force` block and the `force = false` destructuring default are additions; every existing branch above is unchanged — shown in full so the diff is unambiguous about exact insertion order relative to the existing checks.)

- [ ] **Step 4: Wire `force` into `validateAcceptable` and `checkOverride` into `acceptTaskChangeset`**

The signature change (`function acceptTaskChangeset(taskId, { force = false } = {}, ctx)`) and the `validateAcceptable(task, { force, ... })` call site already landed in Task 2 — this task only adds the gating *behavior* on top of them. Verify before editing: `acceptTaskChangeset`'s declared signature (around `src/tasks.js:4536`) already reads `function acceptTaskChangeset(taskId, { force = false } = {}, ctx)` and the existing `validateAcceptable(task, { existsFn: ctx.existsFn, hasLiveOverlay: ctx.hasLiveOverlay })` call already exists at the top of its body. If Task 2's commit did not land both, undo and fix Task 2 first rather than redoing it here.

**`async` (review fix — this task, not Task 2).** `acceptTaskChangeset`/`rejectTaskChangeset` must both become `async function`s so the kill handshake below can `await` the gate's actual exit before `releaseOverlay` runs — see the "Kill mechanism" note under Task 5. This is a real signature change from whatever Task 2 landed (Task 2 had no reason to make them async, since it only added the `force` parameter). It's low-risk end to end: `src/daemon-server.js:131` already does `const result = await invoke(manager, request);` generically for every RPC method, so a manager method returning a Promise instead of a plain object works with zero daemon-side changes; the CLI's `runAccept`/`runReject` already `await client.request(...)`. The one real consequence: any test in this task (Step 1) or elsewhere that calls `mgr.accept(id, ...)` or `mgr.reject(id)` synchronously and reads `.applied`/`.changesetStatus` off the return value directly must add `await` — go back and add it to Step 1's test bodies once they're actually written, not just this step's prose.

```js
async function acceptTaskChangeset(taskId, { force = false } = {}, ctx) {
  // Signature already landed in Task 2 -- this task only fills in the
  // behavior on top of the { force = false } parameter, plus `async` (see
  // note above) so the kill handshake below can be awaited.
  ctx.ensureStateLoaded();
  const task = ctx.tasks.get(taskId);
  if (!task) throw ctx.noSuchTask(taskId);
  const isGitTarget = validateAcceptable(task, { force, existsFn: ctx.existsFn, hasLiveOverlay: ctx.hasLiveOverlay });
```

(`validateAcceptable` already threw — or `force` already skipped the gate refusal — before any field write, so by the time we reach the apply step the gate is either settled or we explicitly chose to override it. The running-gate handshake below is the remaining case: a non-`--force` accept never gets here on a running gate because `validateAcceptable` refused; a `--force` accept explicitly chose to override and now has to kill the in-flight child AND wait for it to actually exit before `releaseOverlay` (the next call) reclaims the overlay out from under it — see `killGateAndWait` in Task 5.)

Then immediately before the existing `applyChangeset(...)` call (which uses the overlay's `merged` view), insert the in-flight-gate kill handshake:

```js
  if (task.checkStatus === "running") {
    await ctx.killGateAndWait(taskId);
  }
```

(`killGateAndWait` — Task 5's function, threaded through here — is a no-op if the gate already exited between validation and here: it looks the child up in `ctx.gateChildren` and returns immediately if it's not there. `task.checkGatePid` is no longer read directly here; `killGateAndWait` resolves the live child from `taskId`, not the persisted pid, so it always targets the actual tracked process, not a possibly-stale field.)

This requires `killGateAndWait` to be threaded into `acceptTaskChangeset`'s `ctx` object. Update the `@param` typedef on `acceptTaskChangeset` (the JSDoc block above its signature, ~line 4533) to add `killGateAndWait: (taskId: string) => Promise<void>` to the object type; then update the `accept:` factory binding (`src/tasks.js:3399`) to thread `killGateAndWait: (taskId) => ctx.env.killGateAndWait(taskId)` through (Task 5 Step 5 already put `killGateAndWait` on `ctx.env`).

and right after `task.changesetStatus = "accepted";`, add:

```js
  if (force && (task.checkStatus === "failed" || task.checkStatus === "timeout" || task.checkStatus === "interrupted" || task.checkStatus === "running")) {
    task.checkOverride = true;
  }
```

(`"running"` is included so a `--force` accept over an in-flight gate is correctly recorded as an override — matching the `--force` help text Task 2 Step 7 already promises, "covers... is still running.")

before the existing `ctx.persistTask(task.id);` call that follows it, so the override is captured in the same persisted snapshot as the acceptance.

Make the identical in-flight-gate kill handshake change to `rejectTaskChangeset` (`src/tasks.js:4589`, also now `async function rejectTaskChangeset(taskId, ctx)` — see the `async` note above): immediately before its `ctx.persistTask(task.id);` call, add:

```js
  if (task.checkStatus === "running") {
    await ctx.killGateAndWait(taskId);
  }
```

(`reject` is always allowed regardless of `checkStatus` (per the design's §4 "reject is always allowed"), but the kill handshake still applies — `releaseOverlay` reclaims the overlay out from under any in-flight gate just the same as `accept` does. `reject` is the path the user takes when the gate refuses and they don't want to fix-forward, so the gate must be torn down cleanly and its exit awaited: otherwise the bwrap child continues writing into the overlay's `upper` even after `releaseOverlay` chmods/`rm -rf`s it.) This requires `killGateAndWait` to be threaded into `rejectTaskChangeset`'s `ctx` too — update its `@param` typedef (the JSDoc block above its signature, ~line 4586) to add `killGateAndWait: (taskId: string) => Promise<void>`, and update the `reject:` factory binding (`src/tasks.js:3404`) to thread `killGateAndWait: (taskId) => ctx.env.killGateAndWait(taskId)` through, the same way `accept:` does.

Also change `acceptTaskChangeset`'s two return statements to carry `checkStatus` (needed by Step 5's CLI-side "no check declared" warning — the design's §4 accept-semantics table: *"`none`: normal accept flow plus a one-line warning that the repo has no checks"*):

```js
  if (!applied.applied) {
    return { taskId, changesetStatus: /** @type {string} */ (task.changesetStatus), applied: false, reason: applied.reason };
  }
```
stays unchanged (nothing to warn about on a non-applied result), but the final success return:
```js
  return { taskId, changesetStatus: task.changesetStatus, applied: true, checkStatus: task.checkStatus, ...(cleanupFailed ? { cleanupFailed: true } : {}) };
```

- [ ] **Step 5: Warn on the CLI side when an accepted changeset had no check gate at all**

In `src/commands.js`'s `runAccept` (extended from Task 2 Step 8), add the "no checks" warning alongside the existing cleanup-failure warning:

```js
async function runAccept(options, { client }) {
  const accepted = await client.request("task.accept", { taskId: options.taskId, ...(options.force === true && { force: true }) });
  warnIfCleanupFailed("changeset applied", accepted);
  if (accepted.applied && (accepted.checkStatus == null || accepted.checkStatus === "none")) {
    process.stderr.write("warning: changeset applied, but this repo declares no check command in .taskferry.toml -- nothing was verified before landing\n");
  }
  return accepted;
}
```

This is an intentionally narrower interpretation of the design's §2 "accept prints the verdict": a passed gate is the expected/silent case and produces no accept-time output (the verdict is already visible via `taskferry status <id>` and `taskferry result <id> --full`); only anomalies — no gate declared (`"none"`), or a `--force` override (`checkOverride: true`) — warrant stderr output. The `checkOverride: true` case is already conveyed by the gate's own failure message (`buildCheckGateFailureMessage`'s output lists "Override only if you have verified manually" and the user is informed they took the override; if the design's "accept prints the verdict" literal reading is desired later, it can be added without breaking this change. Documenting the narrowing here so the absence of a "passed" verdict line doesn't read as an oversight to the implementer).

Add a matching case to `src/commands.test.js` (or wherever `runAccept`'s existing tests live): a fake `client.request` resolving `{ taskId, changesetStatus: "accepted", applied: true, checkStatus: "none" }` and an assertion that `process.stderr.write` (or whatever this suite's existing stderr-capture convention is — check `warnIfCleanupFailed`'s own test for the pattern) was called with a message matching `/declares no check command/`.

- [ ] **Step 6: Preserve the full failure message across the RPC boundary**

**Review fix (Critical, verified directly against `src/daemon.js:270-280` and `src/client.js:295-321` — not asserted).** `buildCheckGateFailureMessage` (Step 3 above) produces a multi-line message: a command line, an exit/timeout/interrupted line, an indented output tail, and a resume-hint dispatch command. But `responseError` in `daemon.js` collapses any non-`ProtocolError` thrown error down to exactly one line via `lines.find((line) => line.startsWith("error:"))` for `message` and one line via `lines.find((line) => line.startsWith("help:"))` for `help` — everything else in the thrown text is silently dropped before it ever reaches the wire. `client.js`'s `buildRequestError` then reconstructs the CLI-facing `Error` from only those two fields (`${error.message}\nhelp: ${error.help}`). The net effect: a user running `taskferry accept <id>` against a failed gate would see just `error: check gate failed for <id>` and a generic help line — not the command, not the output tail, not the fix-forward resume command that's the entire point of `buildCheckGateFailureMessage`.

Add a `detail` field to the wire error envelope that carries the full original text verbatim, so nothing is lost, while leaving the existing `message`/`help` two-line convention intact for every other error in the codebase (this is additive, not a rewrite of the general-purpose error path).

In `src/protocol.js`, extend `errorResponse`:

```js
/** @param {string | null} id @param {string} code @param {string} message @param {string} help @param {string} [detail] */
export function errorResponse(id, code, message, help, detail) {
  return { version: PROTOCOL_VERSION, ok: false, error: { code, message, help, detail: detail ?? message }, id };
}
```

In `src/daemon.js`'s `responseError`, pass the full original text as `detail`:

```js
function responseError(error, requestId) {
  if (error instanceof ProtocolError) {
    return errorResponse(error.requestId, error.code, error.message, error.help, error.message);
  }
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  const message = lines.find((line) => line.startsWith("error:"))?.slice(6).trim() || lines[0];
  const help = lines.find((line) => line.startsWith("help:"))?.slice(5).trim() || "Retry the request or inspect the daemon logs";
  const code = /unknown task id:/.test(text) ? "UNKNOWN_TASK" : "REQUEST_FAILED";
  return errorResponse(requestId, code, message, help, text);
}
```

In `src/client.js`, `isExactObject`'s call site for `validError` (~line 302) must accept the new key:

```js
function validError(error) {
  return isExactObject(error, ["code", "message", "help", "detail"])
    && typeof error.code === "string"
    && typeof error.message === "string"
    && typeof error.help === "string"
    && typeof error.detail === "string";
}
```

(`isExactObject` requires an exact key-count match, so every error envelope produced above must include `detail` — the `detail: detail ?? message` default in `errorResponse` guarantees that, so no caller of `errorResponse` needs updating individually.)

And `buildRequestError` renders `detail` when it differs from the generic two-line reconstruction (i.e. whenever the original text had more in it than a single `error:` line), falling back to the existing short form otherwise so a plain one-line error doesn't grow a redundant duplicate line:

```js
function buildRequestError(error) {
  const detail = error?.detail;
  const body = detail && detail !== error?.message ? detail : `${error?.message || "daemon request failed"}\nhelp: ${error?.help || "retry the request"}`;
  const err = new Error(body);
  err.code = error?.code || "REQUEST_FAILED";
  return err;
}
```

Add a case to `src/daemon.test.js` (or wherever `responseError` is already tested) throwing a multi-line `buildCheckGateFailureMessage`-shaped error through the RPC round-trip (or a plain `errorResponse`/`buildRequestError` unit pair, whichever this suite's existing convention favors) and asserting the client-side `Error`'s message contains the output-tail and resume-hint lines, not just the first `error:` line.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.changeset.test.js src/commands.test.js src/daemon.test.js src/client.test.js src/protocol.test.js`
Expected: PASS.

- [ ] **Step 8: Run the full unit suite and commit**

Run: `npm run test:unit`
Expected: PASS.

```bash
git add src/tasks.js src/tasks.changeset.test.js src/commands.js src/commands.test.js src/protocol.js src/daemon.js src/client.js
git commit -m "feat(tasks): gate accept on check-gate outcome, add --force override, preserve full RPC error detail"
```

---

## Task 7: Daemon-restart handling for a gate that was mid-flight

**Files:**
- Modify: `src/tasks.js` (`bootstrapManagerContext` ~line 3585; new `markInterruptedGatesFor` near `sweepOrphanedOverlaysFor`; its factory binding near ~line 3345)
- Test: `src/tasks.lifecycle.test.js` (add new case)

**Interfaces:**
- Consumes: `task.checkStatus === "running"` (Task 5's in-flight marker).
- Produces: `task.checkStatus === "interrupted"` for any task whose gate was running when the daemon last exited AND, per the design's "the gate is re-runnable" promise, automatically re-invokes `startCheckGate` on the same task if its overlay is still live (which flips `checkStatus` back to `"running"` and starts a fresh check run). Tasks whose overlay was swept away between the daemon's death and its restart are left at `"interrupted"` only — `Task 6's validateAcceptable` keeps refusing them without `--force`, and the failure message renders the re-run path explicitly (see "interrupted" handling note below).

- [ ] **Step 1: Write the failing test**

**Test-harness fix (review finding, verified against `src/tasks.test-helpers.js:186-237` directly).** `makeManager(options)` always creates its own fresh temp dir via `makeTempDirs()` and seeds it through `seedTestFixtures(stateDir, options.tasksFixture ?? [], options.logs ?? {})` — it does **not** read `options.stateDir` at all (`buildManagerOptions`'s `stateDir` parameter is the freshly-made temp dir, not anything from `options`). An earlier draft of this test manually `fs.mkdtempSync`'d its own `stateDir`, wrote a `tasks.json` into it, then passed `{ stateDir }` to `makeManager` — that file is never read; the manager boots against a different, empty temp dir instead, and the test would silently observe `mgr.status("oc_interrupted1")` as "not found," not "interrupted." The real seeding mechanism is `options.tasksFixture` (an array of task objects), used the same way already-passing tests elsewhere in this file seed persisted state — check `src/tasks.lifecycle.test.js` for the existing pattern before writing this, since the exact field names below (`preDispatchHead`, etc.) need to match what `loadPersistedTasks` actually validates.

Add to `src/tasks.lifecycle.test.js`:

```js
test("a task whose check gate was 'running' when the daemon last exited loads as 'interrupted', not silently 'passed'", () => {
  const mgr = makeManager({
    tasksFixture: [
      { id: "oc_interrupted1", status: "done", directory: os.tmpdir(), checkStatus: "running", checkCommand: "npm test", changesetStatus: "pending" },
    ],
  });
  const status = mgr.status("oc_interrupted1");
  assert.equal(status.checkStatus, "interrupted");
});

test("a task whose check gate had already settled ('passed') is left untouched on daemon restart", () => {
  const mgr = makeManager({
    tasksFixture: [
      { id: "oc_settled1", status: "done", directory: os.tmpdir(), checkStatus: "passed", checkCommand: "npm test", changesetStatus: "pending" },
    ],
  });
  assert.equal(mgr.status("oc_settled1").checkStatus, "passed");
});

test("a task already force-accepted/rejected while its gate was 'running' is left alone, not flipped to 'interrupted'", () => {
  // Review fix (I2): changesetStatus left "accepted"/"rejected" but
  // checkStatus still "running" (the kill signal fired, but no exit event
  // landed before the daemon died) must NOT be reclassified -- the decision
  // is already made. Seed a tasksFixture entry with
  // { checkStatus: "running", changesetStatus: "accepted" } and assert
  // mgr.status(id).checkStatus is unchanged ("running"), not "interrupted".
});

test("a task whose gate was 'running' AND whose overlay is still live is automatically re-run on next daemon restart", () => {
  // Seed an in-flight task with a live overlay and a stubbed startCheckGate
  // factory binding that records every call. After the manager boots,
  // assert: startCheckGate was called exactly once with the same task, and
  // the task's checkStatus IS "running" again (the auto re-run flipped it
  // back from "interrupted" before the test could observe "interrupted").
  // This is the design's "the gate is re-runnable" promise: a daemon crash
  // mid-gate does not silently pass; the next daemon boot re-runs the gate,
  // and the user sees "running" again on `taskferry status <id>` instead of
  // a dead-looking "interrupted" with no further action.
});

test("restart with a live overlay best-effort kills any orphaned gate process before re-running", () => {
  // Review fix: seed a task with checkStatus: "running", a live overlay,
  // and checkGatePid set to a recorded fake pid; inject a killFn fake.
  // After the manager boots, assert killFn was called with the negative of
  // that pid (process-group SIGTERM) BEFORE startCheckGate was invoked --
  // proving the sweep reaps a crash-orphaned gate before mounting a second
  // one over the same overlay.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.lifecycle.test.js`
Expected: FAIL (`checkStatus` stays `"running"` after load).

- [ ] **Step 3: Implement the sweep**

Add near `sweepOverlayEntry`/`sweepOverlayTmpRoot` (~line 4406) in `src/tasks.js`:

```js
/**
 * A daemon that crashed or was force-restarted mid-gate leaves a task
 * recorded with checkStatus: "running" forever -- nothing will ever settle
 * it, since the child that would have called startCheckGate()'s exit/error
 * handlers died with the daemon. Reclassify every such task as "interrupted"
 * on load, then per the design's "the gate is re-runnable" promise, if the
 * task's overlay is still live, automatically re-invoke startCheckGate on
 * it (which flips checkStatus back to "running" and starts a fresh check
 * run -- the user sees the same "running" status they would have seen
 * pre-crash, just on a new daemon). Tasks whose overlay was swept away
 * between the daemon's death and its restart are left at "interrupted"
 * only; Task 6's validateAcceptable keeps refusing them without --force,
 * and the failure message renders the re-run path explicitly (see
 * "interrupted" handling note in Task 6 below).
 *
 * Two review fixes folded in here:
 * (1) `changesetStatus !== "pending"` guard -- without it, a task that was
 *     already force-accepted or rejected WHILE its gate was "running" (the
 *     kill handshake fired, but the exit event that would flip checkStatus
 *     away from "running" hadn't landed yet when the daemon died) gets
 *     flipped to "interrupted" forever on every future restart, and if its
 *     overlay happens to still be live, re-gated against an already-decided
 *     changeset -- whose own settle() then no-ops via its own
 *     `changesetStatus !== "pending"` guard, leaving checkStatus stuck on
 *     "running" again, repeating the whole cycle on the next boot. A task
 *     that's already been decided is not this sweep's concern at all.
 * (2) Best-effort orphan kill before re-invoking startCheckGate -- an
 *     UNCLEAN daemon death (crash, OOM-kill, force-restart) is the one path
 *     where nothing ever sent the gate a kill signal at all (a graceful
 *     accept/reject/shutdown always does, via killGateAndWait). Because the
 *     gate is spawned `detached: true` (Task 5), the persisted
 *     `task.checkGatePid` IS that process group's leader pid, so a
 *     best-effort group-kill against it on restart reaps any surviving
 *     orphan from the previous daemon incarnation before a second gate
 *     mounts the same overlay -- without this, two writers (the orphan and
 *     the fresh re-run) can be live against the same upper/work dir at
 *     once. `sendSignal` already swallows ESRCH (nothing there), so this is
 *     safe to call unconditionally.
 * @param {{tasks: Map<string, Task>, hasLiveOverlay: (task: Task) => boolean, startCheckGate: (task: Task) => void, sendSignal: (pid: number, signal: NodeJS.Signals) => void, persistTask: (taskId: string) => void}} ctx
 */
function markInterruptedGatesFor(ctx) {
  for (const task of ctx.tasks.values()) {
    if (task.checkStatus !== "running") continue;
    if (task.changesetStatus !== "pending") continue;
    task.checkStatus = "interrupted";
    ctx.persistTask(task.id);
    if (ctx.hasLiveOverlay(task)) {
      if (task.checkGatePid != null) ctx.sendSignal(task.checkGatePid, "SIGTERM");
      // Auto re-run: the overlay survived the daemon crash, so the gate
      // can be re-run over the same copy-on-write mount. startCheckGate
      // flips checkStatus back to "running" and persists before spawning,
      // so the brief "interrupted" write above is not user-visible.
      ctx.startCheckGate(task);
    }
  }
}
```

Wire its factory binding near the existing `sweepOrphanedOverlays`/`sweepOrphanedPromptFiles` bindings (~line 3345):

```js
    markInterruptedGates: () => markInterruptedGatesFor({ tasks: ctx.maps.tasks, hasLiveOverlay: (task) => ctx.helpers.hasLiveOverlay(task), startCheckGate: (task) => ctx.env.startCheckGate(task), sendSignal: (pid, signal) => ctx.helpers.sendSignal(pid, signal), persistTask: (taskId) => ctx.helpers.persistTask(taskId) }),
```

(`ctx.env.startCheckGate` is now a real, directly-callable binding — Task 5 Step 5 fixed the earlier draft, which nested `startCheckGate` inside a different function's argument object where `ctx.env` could never actually see it. No more "verify the actual binding shape" hedge needed here; this line is correct as written once Task 5 Step 5 lands.)

Call it in `bootstrapManagerContext` (~line 3585), right after `ctx.helpers.sweepOrphanedOverlays();`:

```js
  // A daemon that died with a check gate mid-flight (checkStatus: "running")
  // leaves that status stuck forever -- nothing will ever call
  // startCheckGate()'s settle handlers again for that task. Reclassify as
  // "interrupted" so accept() (Task 6) keeps refusing it without --force,
  // then auto-re-run any gate whose overlay survived the crash (per the
  // design's "the gate is re-runnable" promise).
  ctx.helpers.markInterruptedGates();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/tasks.lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite and commit**

Run: `npm run test:unit`
Expected: PASS.

```bash
git add src/tasks.js src/tasks.lifecycle.test.js
git commit -m "feat(tasks): mark a check gate interrupted by daemon restart, not silently passed"
```

---

## Task 8: `taskferry init` scaffolder

**Files:**
- Create: `src/init.js`
- Create: `src/init.test.js`
- Modify: `src/cli.js` (route `init` around the daemon client, same as `setup`)
- Modify: `src/command-specs.js` (add the `init` entry)
- Modify: `src/args.js` (add `DEFAULT_OPTIONS.init`)
- Modify: `package.json` (register `src/init.test.js`)

**Interfaces:**
- Produces: `detectCheckCommand(directory, deps?): string|null`, `runInit(directory, deps?): Promise<{path: string, written: boolean, checkCommand: string|null, reason?: string}>`. No other task depends on this one — it's the last piece of the CLI surface and is independently testable end to end.
- `init` deliberately does NOT go through `cli.js`'s `usesWorkspaceRoot()` redirect the way `list`/`watch`/`context`/`home` do. `.taskferry.toml` is meant to live at the project root a user is standing in, not redirected to wherever `--directory` (or its workspace-root resolution) might point — a `taskferry init` invoked from inside a worktree should scaffold the worktree's `.taskferry.toml`, not the main checkout's. The CLI routes `init` straight to `runInit(cwd, ...)` using literal cwd, matching the same "literal cwd" pattern `setup` already uses for its bypass. Verify by reading `src/cli.js`'s `runCli` body before wiring — the `if (parsed.command === "init")` branch must call `runInitCommand(initFn, io, cwd)` with the unmodified `cwd` (or `process.cwd()` if `cwd` isn't exposed), NOT a workspace-root-resolved value.

- [ ] **Step 1: Write the failing tests**

Create `src/init.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { detectCheckCommand, runInit } from "./init.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-init-test-"));
}

describe("detectCheckCommand", () => {
  test("prefers an existing package.json 'check' script outright", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { check: "eslint . && tsc --noEmit", lint: "eslint ." } }));
    assert.equal(detectCheckCommand(dir), "npm run check");
  });

  test("composes lint+typecheck+test from package.json scripts when there's no 'check' script", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }));
    assert.equal(detectCheckCommand(dir), "npm run lint && npm run test");
  });

  test("detects pyproject.toml", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = \"x\"\n");
    assert.equal(detectCheckCommand(dir), "uv run pytest && uv run ruff check .");
  });

  test("detects go.mod", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n");
    assert.equal(detectCheckCommand(dir), "go vet ./... && go test ./...");
  });

  test("detects Cargo.toml", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    assert.equal(detectCheckCommand(dir), "cargo clippy -- -D warnings && cargo test");
  });

  test("nothing recognized -> null", () => {
    assert.equal(detectCheckCommand(tmpDir()), null);
  });
});

describe("runInit", () => {
  test("never overwrites an existing .taskferry.toml", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".taskferry.toml"), "check = \"already here\"\n");
    const result = await runInit(dir);
    assert.equal(result.written, false);
    assert.match(result.reason, /already exists/);
    assert.equal(fs.readFileSync(path.join(dir, ".taskferry.toml"), "utf8"), "check = \"already here\"\n");
  });

  test("no TTY and a detected command: writes a commented fill-in template, does not guess the value in", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    const stdout = { write: () => {} };
    const result = await runInit(dir, { io: { stdin, stdout } });
    assert.equal(result.written, true);
    const content = fs.readFileSync(path.join(dir, ".taskferry.toml"), "utf8");
    assert.match(content, /# check = "go vet/);
    assert.ok(!content.includes("\ncheck ="));
  });

  test("nothing detected: writes the commented template with no proposed value", async () => {
    const dir = tmpDir();
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    const result = await runInit(dir, { io: { stdin, stdout: { write: () => {} } } });
    assert.equal(result.checkCommand, null);
    const content = fs.readFileSync(path.join(dir, ".taskferry.toml"), "utf8");
    assert.match(content, /fill this in/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/init.test.js`
Expected: FAIL (`./init.js` doesn't exist).

- [ ] **Step 3: Implement `src/init.js`**

```js
// src/init.js
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { resolveProjectConfigPath } from "./project-config.js";

/**
 * Sniffs a repo's ecosystem to propose a `.taskferry.toml` `check` command.
 * package.json wins outright if it already declares its own composite
 * "check" script; otherwise the best available combination of lint/
 * typecheck/test scripts. Falls through to one fixed command per other
 * ecosystem marker file. Never parses beyond `package.json`'s top-level
 * `scripts` object -- this is the one place in taskferry that reads a
 * manifest at all, and it stays deliberately shallow (no dependency
 * inspection, no nested config).
 * @param {string} directory
 * @param {{existsFn?: (p: string) => boolean, readFileFn?: (p: string) => string}} [deps]
 * @returns {string|null}
 */
export function detectCheckCommand(directory, { existsFn = fs.existsSync, readFileFn = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const packageJsonPath = path.join(directory, "package.json");
  if (existsFn(packageJsonPath)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileFn(packageJsonPath));
    } catch {
      pkg = null;
    }
    const scripts = pkg?.scripts ?? {};
    if (typeof scripts.check === "string") return "npm run check";
    const composed = ["lint", "typecheck", "test"].filter((name) => typeof scripts[name] === "string");
    if (composed.length) return composed.map((name) => `npm run ${name}`).join(" && ");
  }
  if (existsFn(path.join(directory, "pyproject.toml"))) return "uv run pytest && uv run ruff check .";
  if (existsFn(path.join(directory, "go.mod"))) return "go vet ./... && go test ./...";
  if (existsFn(path.join(directory, "Cargo.toml"))) return "cargo clippy -- -D warnings && cargo test";
  if (existsFn(path.join(directory, "deno.json")) || existsFn(path.join(directory, "deno.jsonc"))) return "deno check . && deno test";
  if (existsFn(path.join(directory, "bunfig.toml"))) return "bun test";
  return null;
}

const TEMPLATE_HEADER = `# taskferry project config -- see docs/config.md#taskferrytoml\n`;

/** @param {string|null} checkCommand @returns {string} */
function renderConfig(checkCommand) {
  const checkLine = checkCommand
    ? `check = ${JSON.stringify(checkCommand)}\n`
    : `# check = "npm run check"  -- fill this in; until it's set, there is no gate\n`;
  return `${TEMPLATE_HEADER}# Command the verification gate runs at settle, and that workers are told to\n# run before declaring done. Absent = no gate; taskferry says so loudly.\n${checkLine}\n# Optional. Gate run is killed after this many seconds and recorded as a\n# timeout. Default 900.\n# check_timeout_seconds = 900\n\n# Optional. Host paths bound read-only into the sandbox for every dispatch\n# from this project. Ignored when sandboxing is off.\n# read_only_paths = ["/path/to/reference-docs"]\n`;
}

/**
 * Scaffolds `.taskferry.toml` in `directory`. Never overwrites an existing
 * file. When a check command is detected and stdin is an interactive TTY,
 * asks for confirmation before writing it in directly; otherwise (no
 * detection, or no TTY to confirm with) writes the commented fill-in
 * template so the file never silently encodes a guess nobody approved.
 * @param {string} directory
 * @param {{existsFn?: (p: string) => boolean, writeFileFn?: (p: string, content: string) => void, io?: {stdin: {isTTY?: boolean}, stdout: {write: (s: string) => unknown}}, detect?: typeof detectCheckCommand}} [deps]
 * @returns {Promise<{path: string, written: boolean, checkCommand: string|null, reason?: string}>}
 */
export async function runInit(directory, {
  existsFn = fs.existsSync,
  writeFileFn = (p, content) => fs.writeFileSync(p, content, { mode: 0o644 }),
  io = process,
  detect = detectCheckCommand,
} = {}) {
  const configPath = resolveProjectConfigPath(directory);
  if (existsFn(configPath)) {
    return { path: configPath, written: false, checkCommand: null, reason: `${configPath} already exists -- taskferry init never overwrites it` };
  }
  const detected = detect(directory);
  if (detected && io.stdin?.isTTY) {
    const rl = readline.createInterface({ input: /** @type {NodeJS.ReadableStream} */ (io.stdin), output: /** @type {NodeJS.WritableStream} */ (io.stdout) });
    let answer;
    try {
      answer = await rl.question(`Detected check command: ${detected}\nWrite .taskferry.toml with this command? [Y/n] `);
    } finally {
      rl.close();
    }
    if (/^n/i.test(answer.trim())) {
      writeFileFn(configPath, renderConfig(null));
      return { path: configPath, written: true, checkCommand: null };
    }
    writeFileFn(configPath, renderConfig(detected));
    return { path: configPath, written: true, checkCommand: detected };
  }
  if (detected) {
    io.stdout.write(`Detected check command: ${detected}\nNo TTY to confirm -- writing .taskferry.toml with a commented fill-in instead. Edit "check" in ${configPath} to enable the gate.\n`);
  }
  writeFileFn(configPath, renderConfig(null));
  return { path: configPath, written: true, checkCommand: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/init.test.js`
Expected: PASS.

- [ ] **Step 5: Wire `init` into the CLI**

In `src/command-specs.js`, add after the `setup` entry:

```js
  init: {
    usage: "taskferry init",
    description: "Scaffold .taskferry.toml for this repo, detecting a check command from the project's ecosystem.",
    options: {},
    examples: ['taskferry init'],
  },
```

In `src/args.js`'s `DEFAULT_OPTIONS`, add:

```js
  init: () => ({}),
```

In `src/cli.js`, import `runInit` alongside `runSetup`:

```js
import { runInit } from "./init.js";
```

Add `init: initFn = runInit` to `runCli`'s destructured options (alongside `setup: setupFn = runSetup`), and route it the same way `setup` bypasses the daemon client:

```js
  if (parsed.command === "setup") {
    return runSetupCommand(setupFn, env, io);
  }

  if (parsed.command === "init") {
    return runInitCommand(initFn, io, cwd);
  }
```

Add the handler function near `runSetupCommand`:

```js
async function runInitCommand(initFn, io, cwd) {
  try {
    const value = await initFn(cwd, { io });
    const { writeToon } = await import("./output.js");
    writeToon(value, io);
    return { exitCode: 0, value };
  } catch (error) {
    const { writeError } = await import("./output.js");
    writeError(error, io);
    return { exitCode: 1 };
  }
}
```

- [ ] **Step 6: Register the test file, run the full suite, and commit**

Add `src/init.test.js` to `package.json`'s `test:unit` script.

Run: `npm run test:unit`
Expected: PASS.

```bash
git add package.json src/init.js src/init.test.js src/cli.js src/command-specs.js src/args.js
git commit -m "feat(cli): add taskferry init to scaffold .taskferry.toml"
```

---

## Task 9: Dogfood — taskferry's own `.taskferry.toml`, `check` script, and closing #292

**Files:**
- Create: `.taskferry.toml` (repo root)
- Modify: `package.json` (`check` script)
- Modify: `docs/security.md` (extend the existing `## TASKFERRY_CHILD` section)

**Interfaces:** none — this task configures the existing pipeline, it doesn't add new code paths.

- [ ] **Step 1: Add taskferry's own `.taskferry.toml`**

```toml
# taskferry project config -- see docs/config.md#taskferrytoml
check = "npm run check"
```

- [ ] **Step 2: Grow `check` to include the test suite it currently lacks**

In `package.json`, `check` is currently:

```json
"check": "git ls-files '*.js' | xargs -P4 -I{} node --check {} && npm run lint && npm run typecheck",
```

Change to:

```json
"check": "git ls-files '*.js' | xargs -P4 -I{} node --check {} && npm run lint && npm run typecheck && npm test",
```

- [ ] **Step 3: Close #292 — document the `TASKFERRY_CHILD` leak and its existing workaround**

In `docs/security.md`'s `## TASKFERRY_CHILD` section (~line 248), add a paragraph after the existing one:

```markdown
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
```

- [ ] **Step 4: Verify locally, then close the loop with a real dogfood dispatch (Task 11 does the actual gated dispatch — this step is a plain local sanity check only)**

Run: `npm run check`
Expected: PASS (lint, typecheck, and now `npm test` all clean on the current worktree).

```bash
git add .taskferry.toml package.json docs/security.md
git commit -m "chore(dogfood): add .taskferry.toml, grow check to include npm test, close #292"
```

---

## Task 10: Documentation

**Files:**
- Modify: `docs/cli-reference.md` (new `## taskferry init` section; `--parent-task`/`--force` additions to the existing `dispatch`/`advisor`/`accept` sections)
- Modify: `docs/config.md` (new `## .taskferry.toml` section, distinct from the existing `~/.config/taskferry/config.json` sections this file already documents)
- Modify: `docs/sourcemap.md` (add `src/project-config.js`, `src/init.js` to the file-by-file listing)
- Modify: `skills/using-taskferry/SKILL.md` (canonical source; mention `.taskferry.toml`/the gate/`--parent-task`/`--force`/`init` wherever it documents dispatch/accept today)

- [ ] **Step 1: `docs/cli-reference.md`**

Add a `## \`taskferry init\`` section (mirroring the existing `## \`taskferry setup\`` section's format at line 363) describing the scaffolder and its ecosystem detection. In the existing `## \`taskferry dispatch ...\`` and `## \`taskferry advisor ...\`` sections, document `--parent-task`. In `## \`taskferry accept <id>\``, document `--force` and the check-gate refusal behavior, cross-referencing the new `.taskferry.toml` section in `docs/config.md`.

- [ ] **Step 2: `docs/config.md`**

Add a new top-level `## \`.taskferry.toml\`` section (after the existing `## Errors` section, or wherever this file's structure reads best once you have it open) covering: location (dispatch's working-tree root), format (TOML), the three fields (`check`, `check_timeout_seconds`, `read_only_paths`) with their defaults, precedence (project file only — no user-level file, taskferry never creates one outside `init`), the always-on prompt injection, the gate lifecycle and `checkStatus` state machine (`none -> running -> passed|failed|timeout`, or `running -> interrupted` on a daemon restart), and the full error-handling table from the design spec (`.superpowers/specs/2026-08-05-check-gate-project-config-design.md`'s "Error handling summary" section — copy it verbatim, it's already accurate).

- [ ] **Step 3: `docs/sourcemap.md`**

In the `## File-by-file` section, add one-line entries for `src/project-config.js` (`.taskferry.toml` loader) and `src/init.js` (`taskferry init` scaffolder), matching this section's existing one-line-per-file format.

- [ ] **Step 4: Update and regenerate the canonical skill**

Edit `skills/using-taskferry/SKILL.md` (the canonical file — never edit `integrations/claude/skills/using-taskferry/SKILL.md` or `integrations/codex/skills/using-taskferry/SKILL.md` directly, they're generated) to mention `.taskferry.toml`'s verification gate, `--parent-task`, `accept --force`, and `taskferry init` wherever it currently documents dispatch/accept.

Run: `npm run skill:generate`

Verify the generated copies match:

Run: `npm run skill:check`
Expected: exits 0 (no diff between canonical and generated copies).

- [ ] **Step 5: Commit**

```bash
git add docs/cli-reference.md docs/config.md docs/sourcemap.md skills/using-taskferry/SKILL.md integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md
git commit -m "docs: document .taskferry.toml, the verification gate, --parent-task, --force, taskferry init"
```

---

## Task 11: Real-exercise verification (the dogfood gated dispatch)

Per this repo's own "a mocked test is not proof at the system boundary" rule (and the design spec's own Testing section, which requires exactly this): every prior task's tests mock `spawnFn`/`runOverlayCommandFn`. None of them prove real `bwrap` can actually mount the overlay a second time and run a real check command inside it. This task is that one real exercise, run directly against this checked-out worktree (not mocked), with both a passing and a deliberately failing case.

**CRITICAL: this task runs against a fully isolated daemon, NOT the shared default-state daemon.** This repo's own `CLAUDE.md` ("Isolate your own taskferry runs when testing or developing taskferry itself") explicitly forbids testing/developing taskferry against the shared `XDG_STATE_HOME`/`XDG_RUNTIME_DIR`/`XDG_CACHE_DIR` defaults — those resolve to `~/.local/state/taskferry`/`/run/user/<uid>/taskferry`/`~/.cache/taskferry` regardless of which git worktree you're in, so every worktree and every concurrent session shares one daemon process, one `tasks.json`, and one lock file. `pkill -f 'node.*src/daemon.js'` (the previous version of this step) would kill every worktree's daemon, and a `taskferry dispatch` running against the shared default state dir could collide with another session's in-flight ferries. The fix: export a unique `TASKFERRY_STATE_DIR`/`TASKFERRY_RUNTIME_DIR`/`TASKFERRY_CACHE_DIR` (matching the pattern `CLAUDE.md` itself shows, under `/tmp/taskferry-dev-<slug>`) before ANY `taskferry` command in this task, and boot the isolated daemon under those vars instead of `pkill`-ing the real one. The shared daemon on stdout is untouched; only the test daemon under `/tmp/taskferry-dev-check-gate-project-config-dogfood` lives and dies here.

**Files:** none created or modified by this task beyond a scratch script deleted at the end — this task's deliverable is the recorded verification transcript in the plan's completion notes (or PR description), not a code change.

- [ ] **Step 1: Confirm bwrap and Linux are actually available here**

Run: `bwrap --version && uname -s`
Expected: a `bubblewrap X.Y.Z` version string >= 0.8, and `Linux`. If this environment can't run bwrap at all, stop here and say so explicitly rather than skipping this task silently — the whole point of Tasks 5-7 is unverifiable without it, and this plan's execution report must say plainly that the real-exercise step could not run, not quietly treat the mocked unit tests as sufficient.

- [ ] **Step 2: Set up the isolated dev state and boot a dedicated daemon for this task**

```bash
export TASKFERRY_DEV_ROOT="/tmp/taskferry-dev-check-gate-project-config-dogfood"
export TASKFERRY_STATE_DIR="${TASKFERRY_DEV_ROOT}/state"
export TASKFERRY_RUNTIME_DIR="${TASKFERRY_DEV_ROOT}/runtime"
export TASKFERRY_CACHE_DIR="${TASKFERRY_DEV_ROOT}/cache"
mkdir -p "$TASKFERRY_STATE_DIR" "$TASKFERRY_RUNTIME_DIR" "$TASKFERRY_CACHE_DIR"

# Boot ONLY the isolated dev daemon. Do NOT pkill -f 'node.*src/daemon.js' --
# that would kill the shared default daemon every other session/worktree is
# relying on. The "first taskferry CLI call" triggers auto-start, but for
# the dogfood we want the daemon to be up before any dispatch to keep the
# verification transcript clean.
taskferry doctor >/dev/null 2>&1 && echo "isolated daemon already up" || true
```

(The `taskferry doctor` invocation above runs under the three exported env vars already, so `paths.js` resolves the state/runtime/cache dirs to the dev root — not a typo, just no need to repeat the env). Verify with `taskferry doctor` (under the exported env) that the daemon's pid is fresh and lives under the dev root (not the shared default). Verify the shared default daemon is untouched by running a `taskferry doctor` from a different shell without the dev-root env vars exported: it should report the SAME pid it did before this task started.

- [ ] **Step 3: Passing case — dispatch a trivial no-op change against this worktree**

```bash
cd /workspace/taskferry.worktrees/check-gate-project-config
TASKFERRY_STATE_DIR="$TASKFERRY_STATE_DIR" TASKFERRY_RUNTIME_DIR="$TASKFERRY_RUNTIME_DIR" TASKFERRY_CACHE_DIR="$TASKFERRY_CACHE_DIR" \
  taskferry dispatch --prompt "Add a single-line comment to the top of README.md, then stop." --directory "$(pwd)"
```

Wait for it (`taskferry wait <id>`), then poll `taskferry status <id> --full` until `checkStatus` leaves `"running"`.
Expected: `checkStatus: "passed"`, `checkExitCode: 0`, `checkCommand: "npm run check"`. `taskferry accept <id>` succeeds without `--force`.

- [ ] **Step 4: Failing case — dispatch a change that breaks `npm run check`**

```bash
cd /workspace/taskferry.worktrees/check-gate-project-config
TASKFERRY_STATE_DIR="$TASKFERRY_STATE_DIR" TASKFERRY_RUNTIME_DIR="$TASKFERRY_RUNTIME_DIR" TASKFERRY_CACHE_DIR="$TASKFERRY_CACHE_DIR" \
  taskferry dispatch --prompt "In src/numbers.js, change the isPositiveInteger function so it always returns false, breaking a real test. Do not fix it or run the test suite yourself -- just make the change and stop." --directory "$(pwd)"
```

Wait for it, poll `taskferry status <id> --full`.
Expected: `checkStatus: "failed"`, non-zero `checkExitCode`, `checkOutputTail` containing real failing-test output. `taskferry accept <id>` (no `--force`) refuses with the fix-forward message from Task 6, rendering a real `sessionId` and `taskId`. `taskferry accept <id> --force` then succeeds and `taskferry status <id> --full` shows `checkOverride: true`. Immediately `taskferry reject <id>` this one instead of actually accepting it into the branch (or accept-then-`git revert` if `--force` was exercised first and left a real broken commit) — this task must not leave the intentionally-broken `isPositiveInteger` change landed in the worktree.

- [ ] **Step 5: Tear down the isolated dev daemon, then record the outcome**

Kill the isolated dev daemon (PID goes away; the shared daemon is untouched):

```bash
pkill -f "${TASKFERRY_DEV_ROOT}.*src/daemon.js" || true
rm -rf "$TASKFERRY_DEV_ROOT"
```

Then confirm `git status` in the worktree shows nothing unexpected left over from either dispatch (no stray accepted broken commit). State plainly in the plan's completion report: whether both cases ran for real, the actual `checkStatus`/`checkExitCode`/`checkOutputTail` observed (not paraphrased), and the exact `taskferry accept` refusal message text produced by Step 4 — this is the evidence this feature actually works end to end, not just that its unit tests pass.

---

## Completion

Once Tasks 1-11 are done: run `npm run check` one final time on the whole branch (now includes `npm test` per Task 9), confirm `git log --oneline` shows one commit per task, and hand off to `superpowers:finishing-a-development-branch` to open the PR — per this repo's own "Feature work always goes through PR review before merging to main" policy, this branch (`check-gate-project-config`) merges only after `/code-review` (pick an effort level scaled to this diff's size — it touches sandboxing, accept/reject state, and the RPC boundary, so `high` at minimum) and, since a PR will exist, that review's findings get posted as a PR comment.
