# Per-Provider Concurrency & Dispatch-Rate Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a config entry (or env var) declare a per-provider concurrency and dispatch-rate ceiling, and make the launch scheduler enforce it per-provider — round-robin across provider-specific queues instead of one shared FIFO — while keeping the existing global `maxConcurrentTasks`/`maxDispatchesPerWindow` as a workspace-wide ceiling on top.

**Architecture:** The single shared scheduler state (`launchQueue`/`launchTimes`/`runningCount`) in `src/tasks.js` splits into a `providerQueues: Map<string, ProviderQueue>` (one `{launchQueue, launchTimes, runningCount}` bucket per provider, keyed by the substring of `task.model` before its first `/`) plus a retained global `launchTimes`/`runningCount` ledger. `drainLaunchQueue()` becomes a round-robin pass over `providerQueues` instead of a single FIFO shift. `config.js` gains a `providerLimits` nested-object field; `tasks.js` gains a `TASKFERRY_PROVIDER_LIMITS` env grammar parser and the option-resolution wiring that turns either source into the `Map<string, {concurrencyLimit, dispatchLimit}>` the scheduler reads.

**Tech Stack:** Node.js, `node:test` + `node:assert/strict`, existing `tasks.test-helpers.js` fixtures (`makeManager`, `fakeChild`, `trackManager`, `mkdtempTracked`).

**Reference spec:** `.superpowers/specs/2026-08-08-provider-concurrency-limits-design.md` — read it before starting; this plan implements it section by section and cites section numbers below. Move that spec to `.superpowers/.completed/specs/` in Task 5 once everything lands.

## Global Constraints

- Provider key = substring of `task.model` before the first `/` (spec §1). No per-model granularity.
- The global `maxConcurrentTasks`/`maxDispatchesPerWindow` ceiling is retained and enforced in addition to any per-provider limit — a task must clear both (spec §2).
- No per-provider `dispatchWindowMs` — every provider's rate window reuses the single global `dispatchWindowMs` (spec §4).
- `providerLimits` (config-file and env forms) is read once at daemon startup, same as every other daemon-side numeric field — no hot-reload (spec §5).
- TPM/token-rate tracking, per-model granularity, and observability surfacing in `taskferry status`/`doctor` are explicitly out of scope (spec §6).
- Every new/changed function keeps the existing dependency-injection test style — no new function should make it harder to construct an isolated `makeManager()` in tests.

---

## File Structure

- Modify `src/config.js`: add `providerLimits` to `CONFIG_FIELD_TYPES`, add a dedicated `validateProviderLimits()` nested-object validator (same pattern as the existing `defaultExecutor` special-case).
- Modify `src/config.test.js`: add `providerLimits` validation coverage under `describe("loadConfig()", ...)`.
- Modify `src/tasks.js`: add `parseProviderLimitsEnv()` near `parseAllowedDirs`/`parseEnvDenylist`; add `providerOf()`, `providerLimitsFromConfig()`, `resolveProviderLimitsOption()`; wire `providerLimits` through `resolveTaskManagerOptions()` → `initManagerLimits()`; replace the scheduler's `launchQueue: string[]` with `providerQueues: Map<string, ProviderQueue>` in `initManagerMaps()`/`initManagerSchedulers()`; rewrite `drainLaunchQueue()`/`scheduleNextLaunch()`/`runLaunchQueuedTasks()` for round-robin; update `queueDispatchLaunch()` and `cancelTask()` to route through provider buckets; update `incRunning`/`decRunning` to take the task and update both the global and provider-bucket counters; update every JSDoc typedef and wiring call site that referenced `launchQueue: string[]`.
- Modify `src/tasks.parse.test.js`: add `parseProviderLimitsEnv()` unit tests.
- Modify `src/tasks.test-helpers.js`: add a `providerLimits` passthrough option to `buildManagerOptions()` so tests can pass it to `makeManager()`.
- Modify `src/tasks.dispatch.test.js`: add provider-scoped scheduler tests (round-robin skip-ahead, provider cap independent of global headroom, global ceiling still binding, cancel removes from the right provider bucket).
- Modify `docs/config.md`: new `providerLimits` field row, worked example, and a short subsection on the per-provider vs. global-ceiling interaction.
- Modify `docs/sourcemap.md`: refresh `tasks.js`'s row for the provider-keyed scheduler.

---

## Task 1: `config.js` validates a `providerLimits` field

**Files:**
- Modify: `src/config.js:24-97`
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `providerLimits` becomes a recognized `config.json` key. A config file with `{"providerLimits": {"minimax": {"maxConcurrentTasks": 4, "maxDispatchesPerWindow": 10}}}` passes validation; `loadConfig()` returns it verbatim (still a plain nested object — normalization into the scheduler's `Map` shape happens in Task 3, inside `tasks.js`, not here).

- [ ] **Step 1: Write the failing tests**

Add to `src/config.test.js`, inside the existing `describe("loadConfig()", ...)` block (after the `overlayEnabled` tests, before its closing `});`):

```js
  test("accepts a valid providerLimits value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxConcurrentTasks: 4, maxDispatchesPerWindow: 10 }, ollama: { maxConcurrentTasks: 3 } } }));
    assert.deepEqual(loadConfig({ configPath }), { providerLimits: { minimax: { maxConcurrentTasks: 4, maxDispatchesPerWindow: 10 }, ollama: { maxConcurrentTasks: 3 } } });
  });

  test("rejects a providerLimits value that isn't an object", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: "minimax:4" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits".*must be a object.*\nhelp:/s);
  });

  test("rejects a providerLimits array", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: [1, 2] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits".*must be a JSON object.*\nhelp:/s);
  });

  test("rejects a providerLimits entry that isn't an object", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: 4 } }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits\.minimax".*must be a JSON object.*\nhelp:/s);
  });

  test("rejects an unrecognized key inside a providerLimits entry", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxRpm: 10 } } }));
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized key "providerLimits\.minimax\.maxRpm".*\nhelp:/s);
  });

  test("rejects a non-positive-integer providerLimits value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxConcurrentTasks: 0 } } }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits\.minimax\.maxConcurrentTasks".*must be a positive integer.*\nhelp:/s);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "providerLimits"`
Expected: FAIL — `providerLimits` is not a recognized config key yet, so every test throws the wrong error message (the "unrecognized config key" error instead of the specific ones being asserted).

- [ ] **Step 3: Implement the validator**

In `src/config.js`, add `providerLimits: "object",` to `CONFIG_FIELD_TYPES` (after `profilingEnabled: "boolean",`):

```js
const CONFIG_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
  dispatchWindowMs: "number",
  noOutputTimeoutMs: "number",
  postOutputNoOutputTimeoutMs: "number",
  preOutputMaxMs: "number",
  summaryModel: "string",
  activitySummariesEnabled: "boolean",
  summarizerTimeoutMs: "number",
  activityMaxWords: "number",
  advisorSessionTtlMs: "number",
  watchdogGraceMs: "number",
  lowerdirStaggerMs: "number",
  sandboxEnabled: "boolean",
  overlayEnabled: "boolean",
  allowedDirs: "string",
  envDenylist: "string",
  sandboxDenylist: "string",
  waitDefaultTimeoutMs: "number",
  cancelGraceMs: "number",
  defaultExecutor: "string",
  advisorContextChars: "number",
  envFile: "string",
  profilingEnabled: "boolean",
  providerLimits: "object",
};

const PROVIDER_LIMIT_FIELD_TYPES = {
  maxConcurrentTasks: "number",
  maxDispatchesPerWindow: "number",
};

/**
 * Validates `config.json`'s `providerLimits` field: a flat map of provider
 * name -> {maxConcurrentTasks?, maxDispatchesPerWindow?}, both optional
 * positive integers. Mirrors the top-level object/key/type checks in
 * {@link parseAndValidateConfig} one level deeper, since `providerLimits`
 * is the one config field shaped as a nested object rather than a scalar.
 * @param {unknown} providerLimits
 * @param {string} configPath
 */
function validateProviderLimits(providerLimits, configPath) {
  if (providerLimits === null || typeof providerLimits !== "object" || Array.isArray(providerLimits)) {
    throw new Error(`error: config key "providerLimits" in ${configPath} must be a JSON object\nhelp: use {"provider": {"maxConcurrentTasks": N, "maxDispatchesPerWindow": N}, ...}`);
  }
  for (const [provider, limits] of Object.entries(providerLimits)) {
    if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
      throw new Error(`error: config key "providerLimits.${provider}" in ${configPath} must be a JSON object\nhelp: use {"maxConcurrentTasks": N, "maxDispatchesPerWindow": N}`);
    }
    for (const key of Object.keys(limits)) {
      if (!Object.hasOwn(PROVIDER_LIMIT_FIELD_TYPES, key)) {
        throw new Error(`error: unrecognized key "providerLimits.${provider}.${key}" in ${configPath}\nhelp: recognized keys are: ${Object.keys(PROVIDER_LIMIT_FIELD_TYPES).join(", ")}`);
      }
      const value = /** @type {Record<string, unknown>} */ (limits)[key];
      if (typeof value !== PROVIDER_LIMIT_FIELD_TYPES[key] || !Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
        throw new Error(`error: config key "providerLimits.${provider}.${key}" in ${configPath} must be a positive integer (got ${JSON.stringify(value)})\nhelp: fix the value's type in ${configPath}`);
      }
    }
  }
}
```

Then, in `parseAndValidateConfig()`, right after the existing `defaultExecutor` special-case block (`if (parsed.defaultExecutor !== undefined && ...) { throw ...; }`), add:

```js
  if (parsed.providerLimits !== undefined) validateProviderLimits(parsed.providerLimits, configPath);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "providerLimits"`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full config test file to check for regressions**

Run: `npm test src/config.test.js`
Expected: PASS, all tests (existing + new)

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js
git commit -m "feat(config): validate a providerLimits nested-object field"
```

---

## Task 2: `TASKFERRY_PROVIDER_LIMITS` env grammar parser

**Files:**
- Modify: `src/tasks.js` (add near `parseAllowedDirs`/`parseEnvDenylist`, around line 536-551)
- Test: `src/tasks.parse.test.js`

**Interfaces:**
- Produces: `export function parseProviderLimitsEnv(spec: string|undefined): Map<string, {concurrencyLimit: number, dispatchLimit: number}>` — parses the `provider:maxConcurrentTasks[:maxDispatchesPerWindow]` comma-separated grammar (spec §4). `dispatchLimit` defaults to `Infinity` when the third field is omitted. Throws a two-line `error:`/`help:` message on any malformed entry (empty provider name, non-integer/non-positive limit, more than 3 colon-separated fields).

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.parse.test.js` (after the existing `parseEnvDenylist()` describe block; import `parseProviderLimitsEnv` alongside the existing imports at the top of the file):

```js
import { parseEnvDenylist, parseSandboxDenylist, parseProviderLimitsEnv } from "./tasks.js";

describe("parseProviderLimitsEnv()", () => {
  test("returns an empty Map for undefined or empty input", () => {
    assert.deepEqual(parseProviderLimitsEnv(undefined), new Map());
    assert.deepEqual(parseProviderLimitsEnv(""), new Map());
  });

  test("parses a single provider:concurrency entry with an unbounded dispatch limit", () => {
    const result = parseProviderLimitsEnv("minimax:4");
    assert.deepEqual(result, new Map([["minimax", { concurrencyLimit: 4, dispatchLimit: Infinity }]]));
  });

  test("parses a provider:concurrency:dispatchesPerWindow entry", () => {
    const result = parseProviderLimitsEnv("minimax:4:10");
    assert.deepEqual(result, new Map([["minimax", { concurrencyLimit: 4, dispatchLimit: 10 }]]));
  });

  test("parses multiple comma-separated entries, trimming whitespace", () => {
    const result = parseProviderLimitsEnv("minimax:4:10, ollama:3");
    assert.deepEqual(result, new Map([
      ["minimax", { concurrencyLimit: 4, dispatchLimit: 10 }],
      ["ollama", { concurrencyLimit: 3, dispatchLimit: Infinity }],
    ]));
  });

  test("throws error:/help: on an empty provider name", () => {
    assert.throws(() => parseProviderLimitsEnv(":4"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry ":4": empty provider name\nhelp:/);
  });

  test("throws error:/help: on a non-integer concurrency limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:four"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry "minimax:four": maxConcurrentTasks must be a positive integer\nhelp:/);
  });

  test("throws error:/help: on a zero concurrency limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:0"), /maxConcurrentTasks must be a positive integer/);
  });

  test("throws error:/help: on a non-integer dispatch-window limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:4:x"), /maxDispatchesPerWindow must be a positive integer/);
  });

  test("throws error:/help: on more than three colon-separated fields", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:4:10:20"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry "minimax:4:10:20"\nhelp:/);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "parseProviderLimitsEnv"`
Expected: FAIL — `parseProviderLimitsEnv` is not exported from `tasks.js` yet.

- [ ] **Step 3: Implement `parseProviderLimitsEnv`**

In `src/tasks.js`, right after `parseEnvDenylist` (the function ending at line 551, `export function parseEnvDenylist(spec) { return parseAllowedDirs(spec); }`), add:

```js
/**
 * Parses `TASKFERRY_PROVIDER_LIMITS`'s comma-separated grammar:
 * `provider:maxConcurrentTasks[:maxDispatchesPerWindow]` per entry. A
 * provider's `dispatchLimit` is `Infinity` (unbounded) when the third
 * field is omitted -- see the design spec's §4. Throws a two-line
 * `error:`/`help:` message on any malformed entry, matching config.js's
 * no-silent-typo-tolerance posture, since a malformed provider limit is a
 * daemon-startup-time config error, not a runtime one.
 * @param {string|undefined} spec
 * @returns {Map<string, {concurrencyLimit: number, dispatchLimit: number}>}
 */
export function parseProviderLimitsEnv(spec) {
  const map = new Map();
  if (!spec) return map;
  for (const entry of spec.split(",").map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    const help = "help: use provider:maxConcurrentTasks[:maxDispatchesPerWindow], comma-separated";
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}"\n${help}`);
    }
    const [provider, concurrencyStr, dispatchStr] = parts;
    if (!provider) {
      throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}": empty provider name\n${help}`);
    }
    const concurrencyLimit = Number(concurrencyStr);
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit <= 0) {
      throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}": maxConcurrentTasks must be a positive integer\n${help}`);
    }
    let dispatchLimit = Infinity;
    if (dispatchStr !== undefined) {
      dispatchLimit = Number(dispatchStr);
      if (!Number.isInteger(dispatchLimit) || dispatchLimit <= 0) {
        throw new Error(`error: malformed TASKFERRY_PROVIDER_LIMITS entry "${entry}": maxDispatchesPerWindow must be a positive integer\n${help}`);
      }
    }
    map.set(provider, { concurrencyLimit, dispatchLimit });
  }
  return map;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "parseProviderLimitsEnv"`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.parse.test.js
git commit -m "feat(tasks): parse TASKFERRY_PROVIDER_LIMITS grammar"
```

---

## Task 3: Provider-scoped queue data model and option-resolution wiring

**Files:**
- Modify: `src/tasks.js` — `initManagerMaps()` (~line 3587), `initManagerSchedulers()` (~line 3610), `initManagerLimits()` (~line 3483), `resolveTaskManagerOptions()` (~line 3411) and its helpers, `queueDispatchLaunch()` (~line 1879), `cancelTask()` (~line 5812), the `incRunning`/`decRunning` call sites (~lines 1134, 1341) and their wiring definition (~line 3808), and the JSDoc typedefs at ~lines 623-624, 1700-1706, 1909-1925.
- Modify: `src/tasks.test-helpers.js:229-273` (`buildManagerOptions`)

**Interfaces:**
- Produces: `providerOf(model: string): string`; `ProviderQueue` typedef `{launchQueue: string[], launchTimes: number[], runningCount: number}`; `ctx.maps.providerQueues: Map<string, ProviderQueue>` (replaces `ctx.maps.launchQueue`); `ctx.limits.providerLimits: Map<string, {concurrencyLimit: number, dispatchLimit: number}>`.
- Consumes: `parseProviderLimitsEnv` (Task 2), `validateProviderLimits`-validated `config.providerLimits` (Task 1).

This task is a structural rename/refactor across many call sites — nothing new is independently testable mid-way, so its test cycle is "the full existing suite stays green" rather than a single new unit test. Task 4 adds the new behavioral tests once the drain algorithm itself is rewritten.

- [ ] **Step 1: Confirm the baseline is green**

Run: `npm test src/tasks.dispatch.test.js src/tasks.checkgate.test.js src/tasks.js`
Expected: PASS (establishes the "before" state so a later regression is attributable to this task, not pre-existing).

- [ ] **Step 2: Add `providerOf()` and the `ProviderQueue` typedef**

In `src/tasks.js`, near `parseProviderLimitsEnv` (added in Task 2), add:

```js
/**
 * @typedef {{launchQueue: string[], launchTimes: number[], runningCount: number}} ProviderQueue
 */

/**
 * Derives a task's provider key from its `model` string
 * ("provider/model"), used to route scheduler state per-provider (design
 * spec §1). Falls back to the whole string when there's no "/" -- every
 * real dispatch always sets a "provider/model"-shaped model, so this is
 * defensive only.
 * @param {string} model
 * @returns {string}
 */
function providerOf(model) {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}

/**
 * The zero-limit sentinel used when a provider has no `providerLimits`
 * entry: both axes unbounded, so only the global ceiling applies to it.
 * @type {{concurrencyLimit: number, dispatchLimit: number}}
 */
const UNLIMITED_PROVIDER = { concurrencyLimit: Infinity, dispatchLimit: Infinity };
```

- [ ] **Step 3: Add config→Map normalization and the option-resolution helper**

Add, right after `providerOf`/`UNLIMITED_PROVIDER`:

```js
/**
 * Converts `config.json`'s validated `providerLimits` object (per Task 1's
 * `validateProviderLimits`) into the `Map<string, {concurrencyLimit,
 * dispatchLimit}>` shape the scheduler reads. An omitted per-provider key
 * means unlimited for that axis (`Infinity`), not zero.
 * @param {Record<string, {maxConcurrentTasks?: number, maxDispatchesPerWindow?: number}>|undefined} configValue
 * @returns {Map<string, {concurrencyLimit: number, dispatchLimit: number}>}
 */
function providerLimitsFromConfig(configValue) {
  const map = new Map();
  if (!configValue) return map;
  for (const [provider, limits] of Object.entries(configValue)) {
    map.set(provider, {
      concurrencyLimit: limits.maxConcurrentTasks ?? Infinity,
      dispatchLimit: limits.maxDispatchesPerWindow ?? Infinity,
    });
  }
  return map;
}

/**
 * Resolves `providerLimits` via the same caller -> env -> config -> default
 * chain every other option uses, with one difference: setting the env var
 * replaces the config file's entire map wholesale (same semantics
 * `TASKFERRY_ENV_FILE=""` already uses for `envFile` -- "explicit empty
 * overrides, doesn't fall through"), never merged key-by-key.
 * @param {Record<string, any>} rawOptions
 */
function resolveProviderLimitsOption(rawOptions) {
  if (rawOptions.providerLimits !== undefined) return { providerLimits: rawOptions.providerLimits };
  if (process.env.TASKFERRY_PROVIDER_LIMITS !== undefined) {
    return { providerLimits: parseProviderLimitsEnv(process.env.TASKFERRY_PROVIDER_LIMITS) };
  }
  const config = rawOptions.config || {};
  return { providerLimits: providerLimitsFromConfig(/** @type {any} */ (config.providerLimits)) };
}
```

- [ ] **Step 4: Wire `resolveProviderLimitsOption` into `resolveTaskManagerOptions`**

Modify `resolveTaskManagerOptions` (~line 3411-3420):

```js
function resolveTaskManagerOptions(rawOptions = {}) {
  return {
    ...resolveCoreOptions(rawOptions),
    ...resolveTimeoutOptions(rawOptions),
    ...resolveToggleOptions(rawOptions),
    ...resolveStringOptions(rawOptions),
    ...resolveEnvFileOptions(rawOptions),
    ...resolveFilesystemOptions(rawOptions),
    ...resolveProviderLimitsOption(rawOptions),
  };
}
```

- [ ] **Step 5: Expose `providerLimits` on `ctx.limits`**

Modify `initManagerLimits` (~line 3483-3505) — add one line to the returned object, right after `concurrencyLimit`:

```js
    concurrencyLimit: positiveInteger(opts.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS),
    providerLimits: opts.providerLimits,
```

- [ ] **Step 6: Replace `launchQueue`/`launchTimes` with `providerQueues` in `initManagerMaps`**

Modify `initManagerMaps` (~line 3587-3604):

```js
function initManagerMaps() {
  return {
    tasks: new Map(),
    escalationTimers: new Map(),
    runningWatchers: new Map(),
    runningWatcherState: new Map(),
    waiters: new Map(),
    advisorSessions: new Map(),
    pendingLaunches: new Map(),
    providerQueues: new Map(),
    launchTimes: [],
    modelsCache: new Map(),
    modelsCacheInFlight: new Map(),
    activitySubscriptions: new Map(),
    logHasEventCache: new Set(),
    gateChildren: new Map(),
  };
}
```

(`launchQueue: []` is removed; `launchTimes: []` is retained as the *global* ledger; `providerQueues: new Map()` is new.)

- [ ] **Step 7: Update `initManagerSchedulers`**

Modify (~line 3607-3624; the JSDoc `@param` types change too):

```js
/**
 * @param {{launchTimer: NodeJS.Timeout|null, runningCount: number, eventSequence: number, activitySummarySubscriptions: number, lastLaunchAt: number}} state
 * @param {{launchTimes: number[], providerQueues: Map<string, ProviderQueue>}} maps
 */
function initManagerSchedulers(state, maps) {
  return {
    // Getter/setter pair lets the module-level launch helpers
    // read/write `launchTimer` and `runningCount` (the factory's own
    // `let` bindings) without closing over the factory, while
    // `launchTimes`/`providerQueues` are shared by reference.
    launchScheduler: {
      launchTimes: maps.launchTimes,
      providerQueues: maps.providerQueues,
      get runningCount() { return state.runningCount; },
      get launchTimer() { return state.launchTimer; },
      set launchTimer(v) { state.launchTimer = v; },
      get lastLaunchAt() { return state.lastLaunchAt; },
      set lastLaunchAt(v) { state.lastLaunchAt = v; },
      // Round-robin cursor into providerQueues' iteration order, advanced
      // by the drain algorithm so a heavy provider's backlog doesn't
      // starve a lighter one's when the global ceiling binds (design
      // spec §3). Plain mutable property: this object is created once
      // per manager and lives for the daemon's lifetime, so it needs no
      // getter/setter indirection the way `state`'s `let` bindings do.
      cursor: 0,
    },
```

Leave the rest of the function (the `activityScheduleState` block that follows) untouched.

- [ ] **Step 8: Route `queueDispatchLaunch` through provider buckets**

Modify `queueDispatchLaunch` (~line 1879-1898):

```js
/**
 * @param {{tasks: Map<string, Task>, persistTask: (taskId: string) => void, pendingLaunches: Map<string, LaunchSpec>, providerQueues: Map<string, ProviderQueue>, launchQueuedTasks: () => void}} ctx
 * @param {{id: string, task: Task, prompt: string, sessionId: string|undefined, env: NodeJS.ProcessEnv|undefined, noSandbox: boolean, noOverlay: boolean, allowedDirs: string[]|undefined, executor: import("./executor.js").WorkerExecutor, role: "dispatch"|"advisor"}} params
 */
function queueDispatchLaunch(ctx, { id, task, prompt, sessionId, env, noSandbox, noOverlay, allowedDirs, executor, role }) {
  ctx.tasks.set(id, task);
  ctx.persistTask(task.id);
  const capturedEnv = env === undefined ? undefined : { ...env };
  ctx.pendingLaunches.set(id, {
    prompt,
    sessionId,
    allowedDirs,
    executor,
    role,
    directory: task.directory,
    model: task.model,
    variant: task.variant,
    env: capturedEnv,
    noSandbox: noSandbox === true,
    noOverlay: noOverlay === true,
  });
  const provider = providerOf(task.model);
  let providerQueue = ctx.providerQueues.get(provider);
  if (!providerQueue) {
    providerQueue = { launchQueue: [], launchTimes: [], runningCount: 0 };
    ctx.providerQueues.set(provider, providerQueue);
  }
  providerQueue.launchQueue.push(id);
  ctx.launchQueuedTasks();
}
```

Update the `DispatchContext` typedef (~line 1700-1706), changing `@property {string[]} launchQueue` to `@property {Map<string, ProviderQueue>} providerQueues`. Do the same for the `SummarizeTaskContext`-shaped typedef at ~line 1909-1925 (its `@property {string[]} launchQueue` line, ~1923).

- [ ] **Step 9: Update the two wiring call sites that build `queueDispatchLaunch`'s ctx**

Both are single-line object literals inside `createTaskManager`'s returned API. Find and update each (`rg -n "launchQueue: ctx.maps.launchQueue" src/tasks.js` to confirm exactly two hits before and zero after):

At ~line 3799 (`summarizeTask:` wiring), change the substring:
```
pendingLaunches: ctx.maps.pendingLaunches, launchQueue: ctx.maps.launchQueue, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(),
```
to:
```
pendingLaunches: ctx.maps.pendingLaunches, providerQueues: ctx.maps.providerQueues, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks(),
```

At ~line 3895 (`dispatch:` wiring), change the same substring the same way:
```
pendingLaunches: ctx.maps.pendingLaunches, launchQueue: ctx.maps.launchQueue, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks() }),
```
to:
```
pendingLaunches: ctx.maps.pendingLaunches, providerQueues: ctx.maps.providerQueues, launchQueuedTasks: () => ctx.helpers.launchQueuedTasks() }),
```

- [ ] **Step 10: Route `cancelTask` through the task's own provider bucket**

Update the `cancelTask` JSDoc `ctx` type (~line 5809), changing `launchScheduler: {launchQueue: string[], launchTimer: NodeJS.Timeout|null}` to `launchScheduler: {providerQueues: Map<string, ProviderQueue>, launchTimer: NodeJS.Timeout|null}`.

Modify the queued-cancel branch (~line 5816-5832):

```js
  if (task.status === "queued") {
    const providerQueue = ctx.launchScheduler.providerQueues.get(providerOf(task.model));
    if (providerQueue) {
      const index = providerQueue.launchQueue.indexOf(taskId);
      if (index !== -1) providerQueue.launchQueue.splice(index, 1);
    }
    const launch = ctx.pendingLaunches.get(taskId);
    ctx.pendingLaunches.delete(taskId);
    if (launch?.snapshotPath) removeFileIfPresent(launch.snapshotPath);
    task.status = "cancelled";
    task.endedAt = new Date().toISOString();
    ctx.persistTask(task.id);
    void ctx.scheduleActivity(task, { force: true }).then(() => ctx.activityCache.evictTask(task.id));
    ctx.logHasEventCache.delete(task.logPath);
    ctx.settleWaiters(taskId);
    const anyQueued = [...ctx.launchScheduler.providerQueues.values()].some((q) => q.launchQueue.length);
    if (!anyQueued && ctx.launchScheduler.launchTimer) {
      clearTimeout(ctx.launchScheduler.launchTimer);
      ctx.launchScheduler.launchTimer = null;
    }
    return { ...summarize(task), note: "queued task cancelled before launch" };
  }
```

- [ ] **Step 11: Update the `cancel:` wiring's `launchScheduler` getter**

At ~line 3856, change the substring:
```
launchScheduler: { get launchQueue() { return ctx.maps.launchQueue; }, get launchTimer() { return ctx.state.launchTimer; }, set launchTimer(value) { ctx.state.launchTimer = value; } },
```
to:
```
launchScheduler: { get providerQueues() { return ctx.maps.providerQueues; }, get launchTimer() { return ctx.state.launchTimer; }, set launchTimer(value) { ctx.state.launchTimer = value; } },
```

- [ ] **Step 12: Make `incRunning`/`decRunning` provider-aware**

Update the JSDoc typedef at ~line 623-624:
```js
 * @property {(task: Task) => void} decRunning
 * @property {(task: Task) => void} incRunning
```

Update the two call sites. At ~line 1134 (inside the child-settle finally-block):
```js
    ctx.decRunning(task);
```
At ~line 1341 (inside `startTaskFor`, right after `task.pid = child.pid ?? null;`):
```js
    ctx.incRunning(task);
```

Update the wiring definition at ~line 3808 (the `startTask:` object literal). Change this substring:
```
decRunning: () => { ctx.state.runningCount--; }, incRunning: () => { ctx.state.runningCount++; },
```
to:
```
decRunning: (task) => { ctx.state.runningCount--; const q = ctx.maps.providerQueues.get(providerOf(task.model)); if (q) q.runningCount--; }, incRunning: (task) => { ctx.state.runningCount++; const q = ctx.maps.providerQueues.get(providerOf(task.model)); if (q) q.runningCount++; },
```

- [ ] **Step 13: Add a `providerLimits` passthrough to the test helper**

Modify `src/tasks.test-helpers.js`'s `buildManagerOptions` (~line 265, right after the `allowedDirs` passthrough line):

```js
    ...passthroughIfSet({ providerLimits: options.providerLimits }, "providerLimits", "providerLimits"),
```

- [ ] **Step 14: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS. Every existing scheduler test still passes because with zero `providerLimits` entries configured, every provider bucket's own limits resolve to `UNLIMITED_PROVIDER` (Task 4 wires this default in), so behavior is identical to today's FIFO-over-one-queue scheduler for the single-provider case every existing test exercises.

Note: this step will only fully pass once Task 4's drain-algorithm rewrite lands — `drainLaunchQueue`/`scheduleNextLaunch`/`runLaunchQueuedTasks` still reference `sched.launchQueue` (now undefined) until that task rewires them. If you're executing this plan task-by-task, expect this step to fail here and pass again after Task 4; note that in the task's completion report rather than treating it as a blocker specific to this task's own changes.

- [ ] **Step 15: Commit**

```bash
git add src/tasks.js src/tasks.test-helpers.js
git commit -m "refactor(tasks): route scheduler state through per-provider queues"
```

---

## Task 4: Round-robin drain algorithm and provider-scoped scheduling tests

**Files:**
- Modify: `src/tasks.js` — `pruneStaleLaunchTimes` (unchanged, reused as-is), `drainLaunchQueue`, `scheduleNextLaunch`, `runLaunchQueuedTasks` (~lines 2723-2796), and the `launchQueuedTasks:` wiring (~line 3801).
- Test: `src/tasks.dispatch.test.js`

**Interfaces:**
- Consumes: `ProviderQueue`, `UNLIMITED_PROVIDER`, `providerOf` (Task 3).
- Produces: `drainLaunchQueue(sched, ctx)` now round-robins over `sched.providerQueues` instead of shifting a single `sched.launchQueue`; `ctx` gains a required `providerLimits: Map<string, {concurrencyLimit, dispatchLimit}>` field.

- [ ] **Step 1: Write the failing tests**

Add to `src/tasks.dispatch.test.js`, after the existing `describe("dispatch queue", ...)` block (before `describe("lowerdir launch stagger ...")`):

```js
describe("per-provider concurrency and dispatch-rate limits", () => {
  test("a provider at its own dispatch-rate cap is skipped so another provider's queued task still launches (round-robin, taskferry#235)", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 10,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: { "opencode-go": { maxConcurrentTasks: 1 } },
      spawnFn: () => {
        const c = fakeChild(9200 + children.length);
        children.push(c);
        return c;
      },
    });

    const first = mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const second = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const third = mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: LUNA_MODEL });

    assert.equal(mgr.status(first.id).status, "running", "opencode-go's first task launches");
    assert.equal(mgr.status(second.id).status, "queued", "opencode-go's second task is capped at maxConcurrentTasks: 1");
    assert.equal(mgr.status(third.id).status, "running", "openai's task launches despite opencode-go's queue being blocked");
  });

  test("global maxConcurrentTasks still caps total launches even when every provider has headroom under its own limit", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: { "opencode-go": { maxConcurrentTasks: 5 }, openai: { maxConcurrentTasks: 5 } },
      spawnFn: () => {
        const c = fakeChild(9300 + children.length);
        children.push(c);
        return c;
      },
    });

    const first = mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const second = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: LUNA_MODEL });

    assert.equal(mgr.status(first.id).status, "running");
    assert.equal(mgr.status(second.id).status, "queued", "global maxConcurrentTasks: 1 still binds across providers");

    children[0].emit("exit", 0, null);
    assert.equal(mgr.status(second.id).status, "running", "freeing the global slot lets the other provider's task launch");
  });

  test("an unconfigured provider is unlimited on its own axis (only the global ceiling applies)", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 4,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      providerLimits: { "opencode-go": { maxConcurrentTasks: 1 } },
      spawnFn: () => {
        const c = fakeChild(9400 + children.length);
        children.push(c);
        return c;
      },
    });

    const dispatched = [
      mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: LUNA_MODEL }),
      mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: LUNA_MODEL }),
      mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: LUNA_MODEL }),
    ];
    for (const d of dispatched) assert.equal(mgr.status(d.id).status, "running", "openai has no providerLimits entry, so only the global cap (4) applies");
  });

  test("cancelling a queued task removes it from its own provider's queue, not another provider's", () => {
    const children = [];
    const mgr = makeManager({
      maxConcurrentTasks: 1,
      maxDispatchesPerWindow: 10,
      dispatchWindowMs: 60000,
      spawnFn: () => {
        const c = fakeChild(9500 + children.length);
        children.push(c);
        return c;
      },
    });

    mgr.dispatch({ prompt: "p0", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const queuedA = mgr.dispatch({ prompt: "p1", directory: os.tmpdir(), model: MIMIMAX_MODEL });
    const queuedB = mgr.dispatch({ prompt: "p2", directory: os.tmpdir(), model: LUNA_MODEL });

    const cancelled = mgr.cancel(queuedA.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(mgr.status(queuedB.id).status, "queued", "cancelling opencode-go's queued task must not touch openai's queued task");

    children[0].emit("exit", 0, null);
    assert.equal(mgr.status(queuedB.id).status, "running", "openai's queued task still launches once the global slot frees");
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "per-provider concurrency"`
Expected: FAIL — `drainLaunchQueue` still reads `sched.launchQueue` (removed in Task 3), so every dispatch throws or silently never launches.

- [ ] **Step 3: Rewrite the drain algorithm**

Replace `drainLaunchQueue`, `scheduleNextLaunch`, and `runLaunchQueuedTasks` (~lines 2746-2796) with:

```js
/**
 * One round-robin pass over every provider queue, starting from the
 * scheduler's rotating cursor: attempts to launch at most one task per
 * provider per pass, skipping (not blocking on) a provider that has no
 * queued work or is at its own concurrency/rate cap, then repeats passes
 * until nothing more can launch this tick (global cap/rate window
 * exhausted, the lowerdir stagger hasn't elapsed, or every remaining
 * provider is empty or capped). A stale queue entry (task vanished from
 * `tasks`, or is no longer `queued`) is dropped and doesn't count as a
 * pass's launch. See the design spec's §2-3 for the rationale.
 * @param {{launchTimes: number[], providerQueues: Map<string, ProviderQueue>, runningCount: number, lastLaunchAt: number, cursor: number}} sched
 * @param {{dispatchLimit: number, concurrencyLimit: number, lowerdirStagger: number, providerLimits: Map<string, {concurrencyLimit: number, dispatchLimit: number}>, tasks: Map<string, Task>, startTask: (task: Task) => void}} ctx
 */
function drainLaunchQueue(sched, ctx) {
  for (;;) {
    if (sched.launchTimes.length >= ctx.dispatchLimit) return;
    if (sched.runningCount >= ctx.concurrencyLimit) return;
    if (Date.now() - sched.lastLaunchAt < ctx.lowerdirStagger) return;
    const providers = Array.from(sched.providerQueues.keys());
    if (!providers.length) return;
    let launchedThisPass = false;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[(sched.cursor + i) % providers.length];
      const providerQueue = /** @type {ProviderQueue} */ (sched.providerQueues.get(provider));
      while (providerQueue.launchQueue.length) {
        const id = providerQueue.launchQueue[0];
        const task = ctx.tasks.get(id);
        if (!task || task.status !== "queued") { providerQueue.launchQueue.shift(); continue; }
        break;
      }
      if (!providerQueue.launchQueue.length) continue;
      const providerLimit = ctx.providerLimits.get(provider) ?? UNLIMITED_PROVIDER;
      if (providerQueue.launchTimes.length >= providerLimit.dispatchLimit) continue;
      if (providerQueue.runningCount >= providerLimit.concurrencyLimit) continue;
      const id = /** @type {string} */ (providerQueue.launchQueue.shift());
      const task = /** @type {Task} */ (ctx.tasks.get(id));
      const launchedAt = Date.now();
      sched.launchTimes.push(launchedAt);
      providerQueue.launchTimes.push(launchedAt);
      sched.lastLaunchAt = launchedAt;
      ctx.startTask(task);
      sched.cursor = (sched.cursor + i + 1) % providers.length;
      launchedThisPass = true;
      break;
    }
    if (!launchedThisPass) return;
  }
}

/**
 * Arms the next launch tick when any provider queue is non-empty and no
 * timer is already pending, backing off for the longest of: the global
 * rate-window delay, the soonest provider-specific rate-window delay
 * among providers still queued, a fixed 250ms concurrency-poll delay, or
 * the remaining lowerdir stagger delay (design spec §3).
 * @param {{launchTimer: NodeJS.Timeout|null, launchTimes: number[], providerQueues: Map<string, ProviderQueue>, runningCount: number, lastLaunchAt: number}} sched
 * @param {{dispatchLimit: number, dispatchWindow: number, concurrencyLimit: number, lowerdirStagger: number, providerLimits: Map<string, {concurrencyLimit: number, dispatchLimit: number}>, reschedule: () => void}} ctx
 */
function scheduleNextLaunch(sched, ctx) {
  const hasQueued = [...sched.providerQueues.values()].some((q) => q.launchQueue.length);
  if (!hasQueued || sched.launchTimer) return;
  const rateDelay = sched.launchTimes.length >= ctx.dispatchLimit ? sched.launchTimes[0] + ctx.dispatchWindow - Date.now() : 0;
  const concurrencyDelay = sched.runningCount >= ctx.concurrencyLimit ? 250 : 0;
  const staggerDelay = Math.max(0, sched.lastLaunchAt + ctx.lowerdirStagger - Date.now());
  let providerRateDelay = Infinity;
  for (const [provider, queue] of sched.providerQueues) {
    if (!queue.launchQueue.length) continue;
    const limit = ctx.providerLimits.get(provider) ?? UNLIMITED_PROVIDER;
    const delay = queue.launchTimes.length >= limit.dispatchLimit ? queue.launchTimes[0] + ctx.dispatchWindow - Date.now() : 0;
    providerRateDelay = Math.min(providerRateDelay, delay);
  }
  if (providerRateDelay === Infinity) providerRateDelay = 0;
  sched.launchTimer = setTimeout(ctx.reschedule, Math.max(1, rateDelay, concurrencyDelay, staggerDelay, providerRateDelay));
}

/**
 * Runs one launch-queue tick: cancel any pending timer, prune stale window
 * timestamps (global and every provider bucket's own), drain as many
 * queued tasks as the limits allow, then re-arm a timer if any provider
 * queue still has work.
 * @param {{launchTimer: NodeJS.Timeout|null, launchTimes: number[], providerQueues: Map<string, ProviderQueue>, runningCount: number, lastLaunchAt: number, cursor: number}} sched
 * @param {{dispatchLimit: number, dispatchWindow: number, concurrencyLimit: number, lowerdirStagger: number, providerLimits: Map<string, {concurrencyLimit: number, dispatchLimit: number}>, tasks: Map<string, Task>, startTask: (task: Task) => void, reschedule: () => void}} ctx
 */
function runLaunchQueuedTasks(sched, ctx) {
  if (sched.launchTimer) {
    clearTimeout(sched.launchTimer);
    sched.launchTimer = null;
  }
  pruneStaleLaunchTimes(sched.launchTimes, ctx.dispatchWindow);
  for (const queue of sched.providerQueues.values()) pruneStaleLaunchTimes(queue.launchTimes, ctx.dispatchWindow);
  drainLaunchQueue(sched, ctx);
  scheduleNextLaunch(sched, ctx);
}
```

- [ ] **Step 4: Wire `providerLimits` into the `launchQueuedTasks:` call site**

At ~line 3801, change the substring:
```
launchQueuedTasks: () => { runLaunchQueuedTasks(ctx.schedulers.launchScheduler, { dispatchLimit: ctx.limits.dispatchLimit, dispatchWindow: ctx.limits.dispatchWindow, concurrencyLimit: ctx.limits.concurrencyLimit, lowerdirStagger: ctx.limits.lowerdirStagger, tasks: ctx.maps.tasks, startTask: (task) => ctx.helpers.startTask(task), reschedule: () => ctx.helpers.launchQueuedTasks() }); },
```
to:
```
launchQueuedTasks: () => { runLaunchQueuedTasks(ctx.schedulers.launchScheduler, { dispatchLimit: ctx.limits.dispatchLimit, dispatchWindow: ctx.limits.dispatchWindow, concurrencyLimit: ctx.limits.concurrencyLimit, lowerdirStagger: ctx.limits.lowerdirStagger, providerLimits: ctx.limits.providerLimits, tasks: ctx.maps.tasks, startTask: (task) => ctx.helpers.startTask(task), reschedule: () => ctx.helpers.launchQueuedTasks() }); },
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm test -- --test-name-pattern "per-provider concurrency"`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — this closes out Task 3 Step 14's deferred verification too. Pay particular attention to `tasks.dispatch.test.js`'s `dispatch queue`, `lowerdir launch stagger`, and `active-task concurrency cap` describe blocks (single-provider scenarios that must behave identically to before), and `tasks.checkgate.test.js`/`tasks.watchdog.test.js` (which dispatch tasks incidentally and must not regress on cancel/settle wiring).

- [ ] **Step 7: Run the typecheck and lint gates**

Run: `npm run typecheck && npm run lint`
Expected: PASS. The `ProviderQueue` typedef and the `Map<string, ProviderQueue>` types introduced across Tasks 3-4 must satisfy `tsc --noEmit` under this repo's `strict`+`checkJs` config.

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js src/tasks.dispatch.test.js
git commit -m "feat(tasks): round-robin the launch scheduler across per-provider queues"
```

---

## Task 5: Documentation and spec archival

**Files:**
- Modify: `docs/config.md`
- Modify: `docs/sourcemap.md`
- Move: `.superpowers/specs/2026-08-08-provider-concurrency-limits-design.md` → `.superpowers/.completed/specs/2026-08-08-provider-concurrency-limits-design.md`

- [ ] **Step 1: Add the `providerLimits` field row to `docs/config.md`**

In the fields table (~line 33-58), add a row right after `lowerdirStaggerMs`:

```
| `providerLimits` | `TASKFERRY_PROVIDER_LIMITS` | object (provider -> `{maxConcurrentTasks?, maxDispatchesPerWindow?}`) | `{}` (no per-provider limit; only the global ceiling applies) |
```

Then, after the `envFile` explanatory paragraphs (before the `## Precedence` heading, ~line 95), add a new subsection:

```markdown
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
```

- [ ] **Step 2: Confirm `providerLimits` is covered by the "No hot-reload" section**

`docs/config.md`'s existing "No hot-reload" section (~line 110-119) already describes "Daemon-side config fields... read once, at daemon startup" generically; no wording change needed there, since `providerLimits` is one more field in that same bucket. Just double check no example list in that section explicitly enumerates fields in a way that would now look incomplete (it doesn't — it names `maxConcurrentTasks`/`noOutputTimeoutMs` as examples, not an exhaustive list).

- [ ] **Step 3: Update `docs/sourcemap.md`'s `tasks.js` row**

Find the `tasks.js` row (search for `| \`tasks.js\` |`) and add a clause describing the provider-keyed scheduler, next to the existing description of `createTaskManager()`'s dispatch/launch responsibilities — e.g. append (adjust exact wording to fit the row's existing style and current line-count number, which will have shifted from this plan's changes):

```
, launch scheduling keyed per-provider (`providerOf()` derives a provider key from `task.model`'s `provider/model` prefix; `providerQueues: Map<string, ProviderQueue>` holds one `{launchQueue, launchTimes, runningCount}` bucket per provider, round-robined by `drainLaunchQueue()` alongside the retained global `launchTimes`/`runningCount` ceiling -- see `docs/config.md#providerLimits`)
```

Also update the file's line-count number in that row to match `wc -l src/tasks.js` after Tasks 1-4 land.

- [ ] **Step 4: Move the spec to completed**

```bash
mkdir -p .superpowers/.completed/specs
git mv .superpowers/specs/2026-08-08-provider-concurrency-limits-design.md .superpowers/.completed/specs/2026-08-08-provider-concurrency-limits-design.md
```

- [ ] **Step 5: Run the full check gate**

Run: `npm run check`
Expected: PASS (lint, typecheck, skill:check, and the full test suite all green).

- [ ] **Step 6: Commit**

```bash
git add docs/config.md docs/sourcemap.md .superpowers/.completed/specs/2026-08-08-provider-concurrency-limits-design.md .superpowers/specs/2026-08-08-provider-concurrency-limits-design.md
git commit -m "docs: document providerLimits and archive its design spec"
```

---

## Task 6: Open the PR

- [ ] **Step 1: Push the branch and open a PR**

Follow `superpowers:finishing-a-development-branch` (per this repo's CLAUDE.md: feature work always goes through PR review before merging to main). Summarize the change referencing `taskferry#235`, and note in the PR body that TPM/token-rate enforcement is explicitly out of scope (tracked separately, per the design spec's §6 Non-goals).

- [ ] **Step 2: Route the PR through code review**

Per this repo's CLAUDE.md, use `ferrying-code-review` (never the built-in `/code-review` directly) at an effort level matched to this change's size — this touches scheduler concurrency logic and daemon-startup config validation, so treat it as at least `high`, not the tool's default.
