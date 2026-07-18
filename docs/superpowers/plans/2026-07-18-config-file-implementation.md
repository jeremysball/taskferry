# Config file for user-facing options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users set the 14 tunable `TASKFERRY_*` options in a JSON config file at `~/.config/taskferry/config.json` instead of only via env vars, while 5 internal/plumbing env vars stay env-only, and a bad config file fails fast with a clear error instead of a silent daemon-startup timeout.

**Architecture:** A new `src/config.js` module exposes `loadConfig()`, which reads and validates the JSON file (missing file → `{}`, malformed/unrecognized/wrong-typed fields → throw). `src/tasks.js`'s `createTaskManager()` gains a `config` option; each of the 14 affected option defaults changes from `env-or-default` to `env-or-config-or-default`, reusing the existing `positiveInteger`/`nonNegativeInteger` validators as the config/default fallback chain. `src/client.js::ensureDaemonStarted` calls `loadConfig()` synchronously right before spawning the daemon, so a bad config surfaces in well under a second instead of after a 5s "daemon did not become ready" timeout. `src/daemon.js`'s `main()` (the real process entrypoint, hit on both first-spawn and self-restart) calls `loadConfig()` independently for its own startup.

**Tech Stack:** Node.js (ESM, `"type": "module"`), `node:test` + `node:assert/strict` for tests, no new dependencies.

## Global Constraints

- Config file location: `$XDG_CONFIG_HOME/taskferry/config.json`, defaulting to `~/.config/taskferry/config.json` when `XDG_CONFIG_HOME` is unset. No env var override for the config file path itself (not in scope — the spec doesn't request one, matching the existing unoverridden `opencode` plugin path pattern in `setup.js`).
- JSON, top-level flat object, all fields optional. A missing file is `{}`, not an error.
- Precedence per field: `TASKFERRY_*` env var (if set) > config file value (if present) > built-in default.
- Fail-fast validation in `loadConfig()`: malformed JSON, an unrecognized top-level key, or a field with the wrong type all throw `Error` with the existing two-line `error: ...\nhelp: ...` message style used elsewhere in this codebase.
- 14 config keys (all camelCase): `maxConcurrentTasks`, `maxDispatchesPerWindow`, `dispatchWindowMs`, `noOutputTimeoutMs`, `postOutputNoOutputTimeoutMs`, `summaryModel`, `activitySummariesEnabled`, `summarizerTimeoutMs`, `activityMaxWords`, `advisorSessionTtlMs`, `keySlots`, `providerKeyEnv`, `summaryKeySlot`, `summaryProviderKeyEnv`.
- Stays env-only, no config equivalent: `TASKFERRY_STATE_DIR`, `TASKFERRY_RUNTIME_DIR`, `TASKFERRY_SOCKET_PATH`, `TASKFERRY_WATCHDOG_POLL_MS`, `TASKFERRY_CHILD`.
- No `taskferry config` CLI subcommand and no hot-reload — explicit descopes from the spec's brainstorming session. Do not add either.
- Out of scope: any change to `keySlots`' comma-separated `name:ENV_VAR_NAME` grammar itself — `config.js` reuses `tasks.js`'s existing `parseKeySlots()` for validation, unchanged.

---

## File Structure

- **Create** `src/config.js` — `resolveConfigPath()`, `loadConfig()`. Owns file location, JSON parsing, and all field-type/unrecognized-key validation. Imports `parseKeySlots` from `tasks.js` to validate the `keySlots` field's grammar.
- **Create** `src/config.test.js` — unit tests for `loadConfig()`.
- **Modify** `src/tasks.js` — export `parseKeySlots` (currently unexported, needed by `config.js`); replace the module-level `DEFAULT_*` constants that read `process.env` directly with plain hardcoded fallback constants; add a `config` option to `createTaskManager()`; change the 14 affected option defaults to the `env > config > default` chain; replace the module-level `SUMMARY_MODEL` constant (used both as a default and directly inside `summarize()`) with a `DEFAULT_SUMMARY_MODEL` constant plus using the resolved `activitySummaryModel` closure variable everywhere `SUMMARY_MODEL` was used directly.
- **Modify** `src/tasks.test.js` — add precedence tests (env overrides config, config used when env unset, default used when both unset).
- **Modify** `src/client.js` — import `loadConfig`; add a `loadConfigFn` option to `ensureDaemonStarted()`; call it synchronously right before `spawnDaemonFn`, inside the existing lock callback.
- **Modify** `src/daemon.test.js` — add a test that `ensureDaemonStarted` propagates a `loadConfig()` error without calling `spawnDaemonFn`.
- **Modify** `src/daemon.js` — import `loadConfig`; `main()` passes `{ config: loadConfig() }` into `startDaemon()`'s `taskManagerOptions`.
- **Create** `docs/config.md` — file location, full field table, precedence rule, fail-fast behavior, an example `config.json`.
- **Modify** `docs/sourcemap.md` — env var table: mark which vars now have a config-file equivalent, add the currently-missing `TASKFERRY_ACTIVITY_MAX_WORDS` row, and add a doc-index pointer to `docs/config.md`.
- **Modify** `package.json` — add `src/config.test.js` to the `test:unit` script.

---

## Task 1: `config.js` — file loading and validation

**Files:**
- Modify: `src/tasks.js:311` (export `parseKeySlots`)
- Create: `src/config.js`
- Test: `src/config.test.js`

**Interfaces:**
- Consumes: `parseKeySlots(spec: string | undefined): Map<string, string>` from `src/tasks.js` (throws `Error` with `error:`/`help:` text on a malformed entry).
- Produces: `resolveConfigPath(env?: NodeJS.ProcessEnv): string` and `loadConfig(options?: { env?: NodeJS.ProcessEnv, configPath?: string }): Record<string, unknown>`, both exported from `src/config.js`. Later tasks import `loadConfig` from `"./config.js"`.

- [ ] **Step 1: Export `parseKeySlots` from `tasks.js`**

In `src/tasks.js`, change line 311 from:

```js
function parseKeySlots(spec) {
```

to:

```js
export function parseKeySlots(spec) {
```

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `npm run test:unit`
Expected: all existing tests still PASS (exporting a previously-private function is not a breaking change).

- [ ] **Step 3: Write the failing tests for `config.js`**

Create `src/config.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, loadConfig } from "./config.js";

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-config-test-"));
}

function writeConfig(dir, content) {
  const configDir = path.join(dir, "taskferry");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe("resolveConfigPath()", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    const result = resolveConfigPath({ XDG_CONFIG_HOME: "/xdg-config" });
    assert.equal(result, path.join("/xdg-config", "taskferry", "config.json"));
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const result = resolveConfigPath({});
    assert.equal(result, path.join(os.homedir(), ".config", "taskferry", "config.json"));
  });
});

describe("loadConfig()", () => {
  test("returns {} when the file is missing", () => {
    const dir = tmpConfigDir();
    const configPath = path.join(dir, "taskferry", "config.json");
    assert.deepEqual(loadConfig({ configPath }), {});
  });

  test("returns the parsed object for a valid file", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ maxConcurrentTasks: 8, summaryModel: "opencode/hy3-free" }));
    assert.deepEqual(loadConfig({ configPath }), { maxConcurrentTasks: 8, summaryModel: "opencode/hy3-free" });
  });

  test("throws with error:/help: on malformed JSON", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, "{ not json");
    assert.throws(() => loadConfig({ configPath }), /error: could not parse.*\nhelp:/s);
  });

  test("throws on a non-object top-level value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, "[1, 2, 3]");
    assert.throws(() => loadConfig({ configPath }), /error: .*must contain a JSON object.*\nhelp:/s);
  });

  test("throws on an unrecognized top-level key", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ notARealKey: 1 }));
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized config key "notARealKey".*\nhelp:/s);
  });

  test("throws on a wrong-typed field", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ maxConcurrentTasks: "4" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "maxConcurrentTasks".*must be a number.*\nhelp:/s);
  });

  test("keySlots reuses parseKeySlots's validation and error text", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ keySlots: "malformed-no-colon" }));
    assert.throws(() => loadConfig({ configPath }), /error: malformed TASKFERRY_KEY_SLOTS entry:.*\nhelp:/s);
  });

  test("accepts a valid keySlots value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ keySlots: "primary:OPENCODE_GO_API_KEY" }));
    assert.deepEqual(loadConfig({ configPath }), { keySlots: "primary:OPENCODE_GO_API_KEY" });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test src/config.test.js`
Expected: FAIL — `Cannot find module './config.js'` (the module doesn't exist yet).

- [ ] **Step 5: Implement `src/config.js`**

Create `src/config.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseKeySlots } from "./tasks.js";

const CONFIG_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  dispatchWindowMs: "number",
  noOutputTimeoutMs: "number",
  postOutputNoOutputTimeoutMs: "number",
  summaryModel: "string",
  activitySummariesEnabled: "boolean",
  summarizerTimeoutMs: "number",
  activityMaxWords: "number",
  advisorSessionTtlMs: "number",
  keySlots: "string",
  providerKeyEnv: "string",
  summaryKeySlot: "string",
  summaryProviderKeyEnv: "string",
};

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveConfigPath(env = process.env) {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "taskferry",
    "config.json"
  );
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.configPath]
 * @returns {Record<string, unknown>}
 */
export function loadConfig({ env = process.env, configPath = resolveConfigPath(env) } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`error: could not parse ${configPath}: ${err.message}\nhelp: fix the JSON syntax, or delete the file to use built-in defaults`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`error: ${configPath} must contain a JSON object\nhelp: use a flat {"key": value, ...} object with the recognized config keys`);
  }

  for (const key of Object.keys(parsed)) {
    if (!(key in CONFIG_FIELD_TYPES)) {
      throw new Error(`error: unrecognized config key "${key}" in ${configPath}\nhelp: recognized keys are: ${Object.keys(CONFIG_FIELD_TYPES).join(", ")}`);
    }
    const expectedType = CONFIG_FIELD_TYPES[key];
    const value = parsed[key];
    if (typeof value !== expectedType) {
      throw new Error(`error: config key "${key}" in ${configPath} must be a ${expectedType} (got ${JSON.stringify(value)})\nhelp: fix the value's type in ${configPath}`);
    }
  }

  if (parsed.keySlots !== undefined) parseKeySlots(parsed.keySlots);

  return parsed;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test src/config.test.js`
Expected: PASS (all 9 tests).

- [ ] **Step 7: Add `config.test.js` to the `test:unit` script**

In `package.json`, change:

```json
"test:unit": "node --test src/tasks.test.js src/events.test.js src/protocol.test.js src/state-lock.test.js src/daemon.test.js src/args.test.js src/cli.test.js src/commands.test.js src/integrations.test.js src/opencode-plugin.test.js src/activity.test.js src/output.test.js src/setup.test.js",
```

to:

```json
"test:unit": "node --test src/tasks.test.js src/events.test.js src/protocol.test.js src/state-lock.test.js src/daemon.test.js src/args.test.js src/cli.test.js src/commands.test.js src/integrations.test.js src/opencode-plugin.test.js src/activity.test.js src/output.test.js src/setup.test.js src/config.test.js",
```

- [ ] **Step 8: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS (existing suite + the 9 new `config.test.js` tests).

- [ ] **Step 9: Commit**

```bash
git add src/config.js src/config.test.js src/tasks.js package.json
git commit -m "feat(config): add config.js for loading and validating config.json"
```

---

## Task 2: Wire config precedence into `tasks.js`

**Files:**
- Modify: `src/tasks.js:131-145` (module-level constants), `src/tasks.js:328-431` (`DEFAULT_*` constants and `createTaskManager` option defaults), `src/tasks.js:1121,1150,1172` (`SUMMARY_MODEL` usages inside `summarize()`)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: nothing new from other files — this task only changes `createTaskManager`'s own option-resolution logic. `config` is a plain `Record<string, unknown>` (the shape `loadConfig()` in Task 1 returns), passed in by the caller (Task 4 wires this from `daemon.js`).
- Produces: `createTaskManager({ config, ...otherOptions })` — a new `config` option, defaulting to `{}`, consumed internally. No change to any other exported name or return shape.

- [ ] **Step 1: Write the failing precedence tests**

Read `src/tasks.test.js:1-40` (imports/helpers) and `src/tasks.test.js:423-460` first — the latter is the existing pattern for verifying `maxConcurrentTasks`: dispatch more tasks than the limit and assert how many stay `queued`. `createTaskManager` doesn't expose its internal concurrency limit directly, so tests must observe it through dispatch-queueing behavior, matching that existing pattern. Add these three tests immediately below that existing block, following the same `mgr`-style setup:

```js
describe("config file precedence (maxConcurrentTasks)", () => {
  function managerWithLimit(t, { env, config }) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-cfg-precedence-"));
    const originalEnv = process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
    if (env === undefined) delete process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
    else process.env.TASKFERRY_MAX_CONCURRENT_TASKS = env;
    t.after(() => {
      if (originalEnv === undefined) delete process.env.TASKFERRY_MAX_CONCURRENT_TASKS;
      else process.env.TASKFERRY_MAX_CONCURRENT_TASKS = originalEnv;
    });
    return createTaskManager({ stateDir, spawnFn: () => fakeChild(), killFn: () => {}, config });
  }

  test("env var wins over config when both are set", (t) => {
    const mgr = managerWithLimit(t, { env: "1", config: { maxConcurrentTasks: 5 } });
    mgr.dispatch({ prompt: "a", directory: process.cwd(), model: "m" });
    const second = mgr.dispatch({ prompt: "b", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(second.taskId).status, "queued");
  });

  test("config value used when env var is unset", (t) => {
    const mgr = managerWithLimit(t, { env: undefined, config: { maxConcurrentTasks: 1 } });
    mgr.dispatch({ prompt: "a", directory: process.cwd(), model: "m" });
    const second = mgr.dispatch({ prompt: "b", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(second.taskId).status, "queued");
  });

  test("built-in default used when both env and config are unset", (t) => {
    const mgr = managerWithLimit(t, { env: undefined, config: {} });
    for (let i = 0; i < 4; i++) mgr.dispatch({ prompt: `p${i}`, directory: process.cwd(), model: "m" });
    const fifth = mgr.dispatch({ prompt: "p5", directory: process.cwd(), model: "m" });
    assert.equal(mgr.status(fifth.taskId).status, "queued");
  });
});
```

Confirm `fakeChild` and the `fs`/`os`/`path` imports already exist at the top of `src/tasks.test.js` (they do, per the file's existing helpers around line 20-30) before relying on them unqualified.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: the three new tests FAIL — `createTaskManager` doesn't accept/use a `config` option yet, so all three managers use the hardcoded default of 4 regardless of `config`, making the "config value used when env unset" test observe `first two dispatches running, not queued` (limit still 4, not 1).

- [ ] **Step 3: Replace the module-level `DEFAULT_*` constants (drop the direct `process.env` reads)**

In `src/tasks.js`, replace lines 328-356:

```js
const DEFAULT_MAX_DISPATCHES_PER_WINDOW = positiveInteger(
  Number(process.env.TASKFERRY_MAX_DISPATCHES_PER_WINDOW),
  2
);
const DEFAULT_DISPATCH_WINDOW_MS = positiveInteger(
  Number(process.env.TASKFERRY_DISPATCH_WINDOW_MS),
  5000
);
const DEFAULT_MAX_CONCURRENT_TASKS = positiveInteger(
  Number(process.env.TASKFERRY_MAX_CONCURRENT_TASKS),
  4
);
const DEFAULT_ADVISOR_SESSION_TTL_MS = positiveInteger(
  Number(process.env.TASKFERRY_ADVISOR_SESSION_TTL_MS),
  30 * 60 * 1000
);
const DEFAULT_NO_OUTPUT_TIMEOUT_MS = positiveInteger(
  Number(process.env.TASKFERRY_NO_OUTPUT_TIMEOUT_MS),
  256000
);
const DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS = positiveInteger(
  Number(process.env.TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS),
  400000
);
const DEFAULT_WATCHDOG_POLL_MS = positiveInteger(
  Number(process.env.TASKFERRY_WATCHDOG_POLL_MS),
  2000
);
const WATCHDOG_KILL_GRACE_MS = 5000;
```

with:

```js
// Plain built-in defaults now (no longer read process.env directly): the
// env > config > default chain is resolved per-option in createTaskManager's
// parameter defaults below, where both process.env and the config option
// are in scope.
const DEFAULT_MAX_DISPATCHES_PER_WINDOW = 2;
const DEFAULT_DISPATCH_WINDOW_MS = 5000;
const DEFAULT_MAX_CONCURRENT_TASKS = 4;
const DEFAULT_ADVISOR_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_NO_OUTPUT_TIMEOUT_MS = 256000;
const DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS = 400000;
// TASKFERRY_WATCHDOG_POLL_MS is internal plumbing with no config-file
// equivalent (see docs/superpowers/specs/2026-07-18-config-file-design.md),
// so this one constant keeps reading process.env directly.
const DEFAULT_WATCHDOG_POLL_MS = positiveInteger(
  Number(process.env.TASKFERRY_WATCHDOG_POLL_MS),
  2000
);
const WATCHDOG_KILL_GRACE_MS = 5000;
```

- [ ] **Step 4: Replace the `SUMMARY_MODEL` module constant**

In `src/tasks.js`, change line 142 from:

```js
const SUMMARY_MODEL = process.env.TASKFERRY_SUMMARY_MODEL || "opencode/hy3-free";
```

to:

```js
const DEFAULT_SUMMARY_MODEL = "opencode/hy3-free";
```

- [ ] **Step 5: Add the `config` option and rewrite the 14 affected parameter defaults**

In `src/tasks.js`, in the `createTaskManager({ ... } = {})` destructuring (starting at line 388), add a `config = {}` parameter and change the defaults for the 14 affected options. Add this JSDoc line after `@param {string} [options.stateDir]` (around line 364):

```js
 * @param {Record<string, unknown>} [options.config]
```

Then change the parameter list. Before (lines 413-430):

```js
  stateDir = DEFAULT_STATE_DIR,
  maxDispatchesPerWindow = DEFAULT_MAX_DISPATCHES_PER_WINDOW,
  dispatchWindowMs = DEFAULT_DISPATCH_WINDOW_MS,
  maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS,
  advisorSessionTtlMs = DEFAULT_ADVISOR_SESSION_TTL_MS,
  noOutputTimeoutMs = DEFAULT_NO_OUTPUT_TIMEOUT_MS,
  postOutputNoOutputTimeoutMs = DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS,
  watchdogPollMs = DEFAULT_WATCHDOG_POLL_MS,
  maxWaitMs = MAX_WAIT_MS,
  keySlotsSpec = process.env.TASKFERRY_KEY_SLOTS,
  providerKeyEnvName = process.env.TASKFERRY_PROVIDER_KEY_ENV || null,
  summaryKeySlot = process.env.TASKFERRY_SUMMARY_KEY_SLOT || null,
  summaryProviderKeyEnvName = process.env.TASKFERRY_SUMMARY_PROVIDER_KEY_ENV || null,
  activitySummariesEnabled = process.env.TASKFERRY_ACTIVITY_SUMMARIES !== "0",
  summarizerTimeoutMs = Number(process.env.TASKFERRY_SUMMARIZER_TIMEOUT_MS),
  activitySummaryModel = SUMMARY_MODEL,
  activityMaxWords = Number(process.env.TASKFERRY_ACTIVITY_MAX_WORDS) || 75,
  onEvent,
```

After:

```js
  stateDir = DEFAULT_STATE_DIR,
  config = {},
  maxDispatchesPerWindow = positiveInteger(
    Number(process.env.TASKFERRY_MAX_DISPATCHES_PER_WINDOW),
    positiveInteger(/** @type {number} */ (config.maxDispatchesPerWindow), DEFAULT_MAX_DISPATCHES_PER_WINDOW)
  ),
  dispatchWindowMs = positiveInteger(
    Number(process.env.TASKFERRY_DISPATCH_WINDOW_MS),
    positiveInteger(/** @type {number} */ (config.dispatchWindowMs), DEFAULT_DISPATCH_WINDOW_MS)
  ),
  maxConcurrentTasks = positiveInteger(
    Number(process.env.TASKFERRY_MAX_CONCURRENT_TASKS),
    positiveInteger(/** @type {number} */ (config.maxConcurrentTasks), DEFAULT_MAX_CONCURRENT_TASKS)
  ),
  advisorSessionTtlMs = positiveInteger(
    Number(process.env.TASKFERRY_ADVISOR_SESSION_TTL_MS),
    positiveInteger(/** @type {number} */ (config.advisorSessionTtlMs), DEFAULT_ADVISOR_SESSION_TTL_MS)
  ),
  noOutputTimeoutMs = positiveInteger(
    Number(process.env.TASKFERRY_NO_OUTPUT_TIMEOUT_MS),
    positiveInteger(/** @type {number} */ (config.noOutputTimeoutMs), DEFAULT_NO_OUTPUT_TIMEOUT_MS)
  ),
  postOutputNoOutputTimeoutMs = positiveInteger(
    Number(process.env.TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS),
    positiveInteger(/** @type {number} */ (config.postOutputNoOutputTimeoutMs), DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS)
  ),
  watchdogPollMs = DEFAULT_WATCHDOG_POLL_MS,
  maxWaitMs = MAX_WAIT_MS,
  keySlotsSpec = process.env.TASKFERRY_KEY_SLOTS ?? /** @type {string|undefined} */ (config.keySlots),
  providerKeyEnvName = process.env.TASKFERRY_PROVIDER_KEY_ENV || /** @type {string|undefined} */ (config.providerKeyEnv) || null,
  summaryKeySlot = process.env.TASKFERRY_SUMMARY_KEY_SLOT || /** @type {string|undefined} */ (config.summaryKeySlot) || null,
  summaryProviderKeyEnvName = process.env.TASKFERRY_SUMMARY_PROVIDER_KEY_ENV || /** @type {string|undefined} */ (config.summaryProviderKeyEnv) || null,
  activitySummariesEnabled = process.env.TASKFERRY_ACTIVITY_SUMMARIES !== undefined
    ? process.env.TASKFERRY_ACTIVITY_SUMMARIES !== "0"
    : (/** @type {boolean|undefined} */ (config.activitySummariesEnabled) ?? true),
  summarizerTimeoutMs = nonNegativeInteger(
    Number(process.env.TASKFERRY_SUMMARIZER_TIMEOUT_MS),
    nonNegativeInteger(/** @type {number} */ (config.summarizerTimeoutMs), DEFAULT_SUMMARIZER_TIMEOUT_MS)
  ),
  activitySummaryModel = process.env.TASKFERRY_SUMMARY_MODEL || /** @type {string|undefined} */ (config.summaryModel) || DEFAULT_SUMMARY_MODEL,
  activityMaxWords = positiveInteger(
    Number(process.env.TASKFERRY_ACTIVITY_MAX_WORDS),
    positiveInteger(/** @type {number} */ (config.activityMaxWords), 75)
  ),
  onEvent,
```

- [ ] **Step 6: Replace the remaining `SUMMARY_MODEL` usages inside `summarize()`**

In `src/tasks.js`, find the three remaining bare `SUMMARY_MODEL` references inside the `summarize()` closure (around lines 1121, 1150, 1172 before this edit — re-locate with `rg -n "\bSUMMARY_MODEL\b" src/tasks.js` since line numbers shift after Step 5) and replace each with `activitySummaryModel` (the resolved closure variable, already in scope since `summarize()` is defined inside `createTaskManager()`):

```js
await Promise.all([summaryModelAvailable(activitySummaryModel, env), verifySummaryAgent(env)]);
```

```js
      model: activitySummaryModel,
```

(appears twice — once in the `task` object being persisted, once in the `pendingLaunches.set(id, { kind: "summary", model: activitySummaryModel, ... })` call). Verify with `rg -n "SUMMARY_MODEL" src/tasks.js` afterward — only `DEFAULT_SUMMARY_MODEL` should remain (and the unrelated `TASKFERRY_SUMMARY_MODEL` string inside the "summary model is unavailable" error message at the old line 861, which stays as literal user-facing text since it refers to the env var name a user would set, not the constant).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS, including the three new precedence tests from Step 1.

- [ ] **Step 8: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS. This also exercises every existing `tasks.test.js` test that depends on `TASKFERRY_SUMMARY_MODEL`/`TASKFERRY_ACTIVITY_MAX_WORDS`/etc. defaults, confirming Step 3-6 didn't change default behavior when no config is passed.

- [ ] **Step 9: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): resolve 14 options through env > config > default precedence"
```

---

## Task 3: Surface config errors on daemon auto-start (`client.js`)

**Files:**
- Modify: `src/client.js:1-97` (`ensureDaemonStarted`)
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.js` (Task 1).
- Produces: `ensureDaemonStarted()` gains a `loadConfigFn` option (defaulting to the real `loadConfig`), called synchronously right before `spawnDaemonFn`. No change to its existing return value (`true`/`false`) or other options.

- [ ] **Step 1: Write the failing test**

In `src/daemon.test.js`, near the existing `ensureDaemonStarted` test at line 535 (`"uses withFileLock so racing auto-start attempts spawn only one daemon"`), read that test's setup first, then add:

```js
  test("propagates a loadConfig() error without calling spawnDaemonFn", (t) => {
    const paths = temporaryPaths(t);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    let spawns = 0;
    const options = {
      ...paths,
      startupTimeoutMs: 100,
      retryDelayMs: 1,
      isDaemonReadySync: () => false,
      spawnDaemonFn: () => {
        spawns++;
      },
      loadConfigFn: () => {
        throw new Error("error: could not parse /fake/config.json: bad json\nhelp: fix it");
      },
    };

    assert.throws(() => ensureDaemonStarted(options), /error: could not parse \/fake\/config\.json/);
    assert.equal(spawns, 0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/daemon.test.js`
Expected: FAIL — `ensureDaemonStarted` doesn't accept a `loadConfigFn` option yet, so the injected throwing function is never called; the test fails because it either doesn't throw the expected message or (more likely) throws the unrelated "daemon did not become ready" timeout error instead.

- [ ] **Step 3: Implement the change in `client.js`**

In `src/client.js`, add the import at the top:

```js
import { loadConfig } from "./config.js";
```

Then change `ensureDaemonStarted` (lines 66-97) from:

```js
export function ensureDaemonStarted({
  env = process.env,
  stateDir = stateDirectory(env),
  runtimeDir = runtimeDirectory(env, stateDir),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, "daemon.sock"),
  startupTimeoutMs = 5000,
  retryDelayMs = 25,
  withLockFn = withFileLock,
  isDaemonReadySync = daemonReadySync,
  spawnDaemonFn = spawnDaemon,
} = {}) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const lockPath = path.join(runtimeDir, "daemon-start.lock");
  return withLockFn(lockPath, () => {
    if (isDaemonReadySync(socketPath)) return false;
    spawnDaemonFn({ env, stateDir, runtimeDir, socketPath });
```

to:

```js
export function ensureDaemonStarted({
  env = process.env,
  stateDir = stateDirectory(env),
  runtimeDir = runtimeDirectory(env, stateDir),
  socketPath = env.TASKFERRY_SOCKET_PATH || path.join(runtimeDir, "daemon.sock"),
  startupTimeoutMs = 5000,
  retryDelayMs = 25,
  withLockFn = withFileLock,
  isDaemonReadySync = daemonReadySync,
  spawnDaemonFn = spawnDaemon,
  loadConfigFn = loadConfig,
} = {}) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const lockPath = path.join(runtimeDir, "daemon-start.lock");
  return withLockFn(lockPath, () => {
    if (isDaemonReadySync(socketPath)) return false;
    // Validate config before spawning: the daemon is spawned detached with
    // stdio "ignore" (see spawnDaemon below), so an error thrown inside
    // daemon.js at startup is otherwise invisible until the generic
    // "daemon did not become ready" timeout below fires. Loading here makes
    // a bad config.json surface immediately with the real error instead.
    loadConfigFn({ env });
    spawnDaemonFn({ env, stateDir, runtimeDir, socketPath });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/daemon.test.js`
Expected: PASS, including the new test and the pre-existing `ensureDaemonStarted` tests (they don't pass `loadConfigFn`, so they use the real `loadConfig`, which returns `{}` for a nonexistent config file in the test's temp `HOME`/`XDG_CONFIG_HOME` — confirm this by checking whether existing daemon tests set `env` to a real `process.env` copy or an isolated fixture; if isolated, no real `~/.config/taskferry/config.json` on the test machine can leak in, so `loadConfig` safely returns `{}`).

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client.js src/daemon.test.js
git commit -m "fix(client): surface config errors before spawning the daemon, not after a 5s timeout"
```

---

## Task 4: Daemon's own config load, plus docs

**Files:**
- Modify: `src/daemon.js:1-20,428-436` (imports, `main()`)
- Create: `docs/config.md`
- Modify: `docs/sourcemap.md:60-98`

**Interfaces:**
- Consumes: `loadConfig` from `src/config.js` (Task 1); `startDaemon({ taskManagerOptions })` (existing, unchanged shape — `taskManagerOptions.config` now flows through to `createTaskManager`'s `config` option from Task 2).
- Produces: no new exports. `main()`'s behavior change (loads config, passes it through) is only reachable by running `daemon.js` directly, so it's verified by an integration-style check in Step 2, not a new unit test (unit tests already cover `startDaemon`'s `taskManagerOptions` passthrough and `createTaskManager`'s `config` handling separately, in Task 2).

- [ ] **Step 1: Wire `loadConfig()` into `daemon.js`'s `main()`**

In `src/daemon.js`, add the import near the top (after the existing `createTaskManager` import at line 9):

```js
import { loadConfig } from "./config.js";
```

Then change `main()` (lines 428-436) from:

```js
async function main() {
  const daemon = await startDaemon();
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
```

to:

```js
async function main() {
  const daemon = await startDaemon({ taskManagerOptions: { config: loadConfig() } });
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
```

This covers both real daemon-startup paths: the first-spawn path from `client.js::spawnDaemon` (`node daemon.js`, which runs `main()`) and the self-restart-on-source-change path (`spawnReplacement` in `startDaemon`, which also runs `node daemon.js`, hitting `main()` again as a fresh process). A bad config on either path throws inside `main()`, is caught by the existing `main().catch(...)` at the bottom of the file, written to stderr, and exits with code 1 — the same crash-and-report path any other daemon startup error already takes.

- [ ] **Step 2: Manually verify the daemon crashes cleanly on a bad config**

Run:

```bash
mkdir -p /tmp/axi-config-smoke/taskferry
echo '{ not json' > /tmp/axi-config-smoke/taskferry/config.json
XDG_CONFIG_HOME=/tmp/axi-config-smoke TASKFERRY_STATE_DIR=/tmp/axi-config-smoke/state node src/daemon.js; echo "exit code: $?"
```

Expected: the process prints `error: could not parse /tmp/axi-config-smoke/taskferry/config.json: ...` to stderr and exits with `exit code: 1` (not a hang, not a silent exit 0). Clean up afterward:

```bash
rm -rf /tmp/axi-config-smoke
```

- [ ] **Step 3: Write `docs/config.md`**

Create `docs/config.md`:

```markdown
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
naming the file and the offending key.
```

- [ ] **Step 4: Update `docs/sourcemap.md`'s env var table**

In `docs/sourcemap.md`, add a new row to the doc index table (after the row for `skills/using-taskferry/SKILL.md`, around line 74):

```markdown
| User-tunable options via a JSON config file (as an alternative to env vars) | `docs/config.md` |
```

Then replace the env var table (lines 81-98) from:

```markdown
| Var | Default | Purpose |
|---|---|---|
| `TASKFERRY_STATE_DIR` | `$XDG_STATE_HOME/taskferry` or `~/.local/state/taskferry` | Task state, logs, summary prompts |
| `TASKFERRY_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/taskferry` or `<state-dir>/run` | Socket + lock files |
| `TASKFERRY_SOCKET_PATH` | `<runtime-dir>/daemon.sock` | Explicit socket override |
| `TASKFERRY_MAX_CONCURRENT_TASKS` | `4` | Running-task concurrency cap |
| `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS` | `2` / `5000` | Dispatch burst-rate limit |
| `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` | `256000` (~4.3 min) | Pre-output-seen watchdog deadline |
| `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` | `400000` (~6.7 min) | Watchdog deadline once a task has produced its first log event |
| `TASKFERRY_WATCHDOG_POLL_MS` | `2000` | Watchdog check interval |
| `TASKFERRY_KEY_SLOTS` | — | Named provider-key slot registry; see `docs/security.md` |
| `TASKFERRY_PROVIDER_KEY_ENV` | — | Source env var a key slot copies from |
| `TASKFERRY_SUMMARY_MODEL` | `opencode/hy3-free` | Model behind `summary --style report` |
| `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` | — | Key-slot wiring specific to the summary model |
| `TASKFERRY_ACTIVITY_SUMMARIES` | — | Enables `watch --summaries` / activity-style model calls |
| `TASKFERRY_SUMMARIZER_TIMEOUT_MS` | `180000` | Throttle between activity-summary model calls |
| `TASKFERRY_ADVISOR_SESSION_TTL_MS` | `1800000` (30 min) | Advisor session idle expiry before auto-reset |
| `TASKFERRY_CHILD` | — | Set on the daemon's own spawned children; see `docs/security.md` |
```

to:

```markdown
Vars marked "config.json" also have a config-file equivalent — see
`docs/config.md` — where the env var, if set, still takes precedence.

| Var | Default | Config file? | Purpose |
|---|---|---|---|
| `TASKFERRY_STATE_DIR` | `$XDG_STATE_HOME/taskferry` or `~/.local/state/taskferry` | no | Task state, logs, summary prompts |
| `TASKFERRY_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/taskferry` or `<state-dir>/run` | no | Socket + lock files |
| `TASKFERRY_SOCKET_PATH` | `<runtime-dir>/daemon.sock` | no | Explicit socket override |
| `TASKFERRY_MAX_CONCURRENT_TASKS` | `4` | yes | Running-task concurrency cap |
| `TASKFERRY_MAX_DISPATCHES_PER_WINDOW` / `TASKFERRY_DISPATCH_WINDOW_MS` | `2` / `5000` | yes | Dispatch burst-rate limit |
| `TASKFERRY_NO_OUTPUT_TIMEOUT_MS` | `256000` (~4.3 min) | yes | Pre-output-seen watchdog deadline |
| `TASKFERRY_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS` | `400000` (~6.7 min) | yes | Watchdog deadline once a task has produced its first log event |
| `TASKFERRY_WATCHDOG_POLL_MS` | `2000` | no | Watchdog check interval |
| `TASKFERRY_KEY_SLOTS` | — | yes | Named provider-key slot registry; see `docs/security.md` |
| `TASKFERRY_PROVIDER_KEY_ENV` | — | yes | Source env var a key slot copies from |
| `TASKFERRY_SUMMARY_MODEL` | `opencode/hy3-free` | yes | Model behind `summary --style report` |
| `TASKFERRY_SUMMARY_KEY_SLOT` / `TASKFERRY_SUMMARY_PROVIDER_KEY_ENV` | — | yes | Key-slot wiring specific to the summary model |
| `TASKFERRY_ACTIVITY_SUMMARIES` | — | yes | Enables `watch --summaries` / activity-style model calls |
| `TASKFERRY_SUMMARIZER_TIMEOUT_MS` | `180000` | yes | Throttle between activity-summary model calls |
| `TASKFERRY_ACTIVITY_MAX_WORDS` | `75` | yes | Max words in an activity-style summary |
| `TASKFERRY_ADVISOR_SESSION_TTL_MS` | `1800000` (30 min) | yes | Advisor session idle expiry before auto-reset |
| `TASKFERRY_CHILD` | — | no | Set on the daemon's own spawned children; see `docs/security.md` |
```

- [ ] **Step 5: Run the full unit suite one more time**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Restart the taskferry daemon**

Per this repo's `CLAUDE.md`, the daemon doesn't hot-reload — restart it after this `src/tasks.js`/`src/daemon.js` change lands, so a running daemon picks up the new precedence logic:

```bash
taskferry doctor --full
```

Note the daemon's `pid` from the output, then:

```bash
kill <pid>
```

The next `taskferry` command auto-spawns a fresh daemon on the new code.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.js docs/config.md docs/sourcemap.md
git commit -m "docs(config): document the config file; wire loadConfig into daemon startup"
```

---

## Self-Review Notes

- **Spec coverage:** file location/format (Task 1), which options move + precedence (Task 2), validation (Task 1), first-run error surfacing (Task 3 + Task 4 Step 1-2), testing (Tasks 1-3), docs (Task 4 Step 3-4) — all spec sections have a task. The spec's explicit descopes (`taskferry config` subcommand, hot-reload) have no task, by design.
- **Type consistency:** `config` is threaded as the same shape end-to-end — `loadConfig()` returns `Record<string, unknown>` (Task 1), `createTaskManager({ config })` consumes it with per-field casts at the point of use (Task 2), `daemon.js`'s `taskManagerOptions.config` passes it through unchanged (Task 4), `client.js`'s `loadConfigFn` returns the same shape but its result is discarded (only used to trigger the throw) since the daemon process itself calls `loadConfig()` again independently on its own startup (Task 4) — no double-parsing bug, just an intentional pre-check.
- **No placeholders:** every step shows exact before/after code or an exact shell command with expected output.
