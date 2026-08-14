// Shared test scaffolding for the per-area `src/tasks*.test.js` files.
// Extracted from the old monolithic `src/tasks.test.js` so each split file
// can import what it needs without redefining the same fixtures, and so
// `makeManager()`'s option-plumbing can live below the test files' 80-line
// function cap. The values exported here are pure fixtures: the same bytes
// every test was already importing from the original file's module scope.
//
// `src/tasks.test-helpers.js` is intentionally not a `*.test.js` file: it
// declares no `describe`/`test` blocks, so `node --test` won't try to
// collect it, and its `makeManager()` body stays subject to the regular
// (non-test-file-ignored) ESLint complexity/line rules. That's why the
// option-resolution helper functions live here too -- each kept under the
// 15-cyclomatic / 80-line-per-function cap.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { after } from "node:test";
import { createTaskManager, DEFAULT_SUMMARY_MODEL, parseEnvDenylist } from "./tasks.js";

const trackedTempDirs = [];
const trackedManagers = [];

// Snapshot each named env var and restore it in `t.after` exactly as found,
// so a test can mutate `process.env` without leaving its values absent (or
// stringified) for later tests in the file. The restore uses
// `prior[name] !== undefined` rather than a separate "was it present" flag:
// Node env values are always strings, so a key that was never set reads back
// as `undefined` and a key set to any value (including a stringified
// "undefined") reads back as a string -- presence is fully derivable from the
// prior value, and a separate flag would be redundant state to keep in sync.
// A blanket delete would instead leave the process's real PATH/HOME absent
// for every later test, which is what let a subsequent test's
// `process.env.HOME = realHome` (realHome already undefined) stringify into
// the literal "undefined" -- the HOME the variants-cache warm spawn then
// handed real opencode.
export function preserveEnvVars(t, names) {
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (prior[name] !== undefined) process.env[name] = prior[name];
      else delete process.env[name];
    }
  });
  return prior;
}

export function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

// createTaskManager() debounces its tasks.json write ~250ms after the last
// change (PERSIST_DEBOUNCE_MS in tasks.js). Without this, a manager whose
// last dispatch/event happened just before this file's tests finish can
// still have that write pending when the trackedTempDirs cleanup below
// deletes its stateDir out from under it, logging a spurious
// "failed to persist task state: ENOENT" to stderr. Flushing every tracked
// manager synchronously first (before removing any directory) closes that
// race regardless of how fast or slow the rest of the file ran.
export function trackManager(manager, { autoModel = true } = {}) {
  trackedManagers.push(manager);
  if (autoModel) {
    const realDispatch = manager.dispatch;
    manager.dispatch = (opts) => {
      if (opts.model == null && opts.sessionId == null) {
        return realDispatch({ ...opts, model: TEST_DEFAULT_MODEL });
      }
      return realDispatch(opts);
    };
  }
  return manager;
}

after(() => {
  for (const manager of trackedManagers) {
    try {
      manager.flushPersist();
    } catch {
      // Best-effort: a manager that never wrote anything, or whose stateDir
      // is already gone for an unrelated reason, has nothing to flush.
    }
  }
  for (const dir of trackedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: force:true only suppresses ENOENT, not EACCES/EPERM
      // (e.g. a test left a mode-000 or overlayfs-kernel-owned work dir
      // behind). Don't let one unremovable dir abort cleanup for the rest.
    }
  }
});

export { DEFAULT_SUMMARY_MODEL };
export const EXTENSION_CONFIG_ERROR = 'Error: Extension "/x/y.js" error: Provider y: "baseUrl" is required when defining models.';
export const NO_API_KEY_FOUND = "No API key found for openai.";
export const AXI_TASKS_TEST_DIR = "axi-tasks-test-";
export const AXI_TASKS_CACHE_DIR = "axi-tasks-cache-";
export const TASKS_STATE_FILE = "tasks.json";
export const AXI_TASKS_OVERLAY_DIR = "axi-tasks-overlay-";
export const AMBIENT_VALUE = "ambient-value";
export const FAKE_SECRETS_ENV_PATH = "/fake/secrets.env";
export const LUNA_MODEL = "openai/gpt-5.6-luna";
export const MIMIMAX_MODEL = "opencode-go/minimax-m3";
export const UNUSED_TMP = "/tmp/unused";
export const SPAWN_OPENCODE_ENOENT = "spawn opencode ENOENT";
export const SOL_MODEL = "openai/gpt-5.6-sol";
export const WS_REPO = "/workspace/repo";
export const AXI_GIT_COMMON_DIR = "axi-git-common-dir-";
export const AXI_ALLOWED_DIR = "axi-allowed-dir-";
export const OPENCODE_DATA = "opencode-data";
export const INVESTIGATED_TEXT = "Investigated the issue";
export const SOURCE_LOG = "source.ndjson";
export const OVERLAY_SRC = "--overlay-src";
export const DIFF_LINE = "diff --git a/x b/x\n";
export const SPAWN_BWRAP_TIMEOUT = "spawn bwrap ETIMEDOUT";
export const AXI_TASKS_ORPHAN = "axi-tasks-orphan-";
export const OVERLAY_DIR_PENDING = "taskferry-cow-t_pending";
export const FINAL_ANSWER = "Final answer";
export const STATUS_DONE_RE = "^Status: DONE$";
export const QUOTA_ERROR = "insufficient_quota: out of credits";
export const RATE_LIMIT_ERROR = "rate_limit_exceeded: please retry after 60s";
export const RATE_LIMIT_PLAIN = "rate limit exceeded";
export const UNAUTHORIZED_ERROR = "Unauthorized: invalid API key provided";
export const USAGE_LIMIT_ERROR = "usage_limit_exceeded: monthly quota reached";
export const UNAUTHORIZED_SHORT = "Unauthorized: invalid api key";
export const EBUSY_ERROR = "EBUSY: resource busy or locked";
export const NOT_REACHED = "not reached in this test";
export const SHARD_QUESTION = "how should I shard this counter?";
export const SHARD_ANSWER = "Shard by key, sum on read.";
export const MINIMAX_MODEL = "minimax/MiniMax-M2.7";
export const LONG_QUESTION = "long question";
export const OCCUPYING_TASK = "occupying task";
export const CONTINUE_FLAG = "--continue";
export const TOOL_CALLS = "tool-calls";
export const NONE_OBSERVED = "none observed yet";
export const SRCA_LOG = "srcA.ndjson";
export const SRCB_LOG = "srcB.ndjson";
export const DID_A = "did the A thing";
export const DID_B = "did the B thing";
export const READING_CONFIG = "Reading the config";
export const FROM_CALLER = "from-caller";
export const SRC1_LOG = "src1.ndjson";
export const DID_THING = "did the thing";
export const CAPTURED_DISPATCH = "captured-at-dispatch-time";
export const MIMO_MODEL = "opencode/mimo-v2.5-free";
// Used only by trackManager()'s auto-fill below -- an arbitrary,
// obviously-synthetic model string, not a real provider/model. Real
// dispatches still require --model per Task 5; this exists purely so
// the ~230 test call sites that don't care which model gets used don't
// need individual edits.
export const TEST_DEFAULT_MODEL = "taskferry-test/auto-default";
export const AXI_TASKS_CACHE_PI = "axi-tasks-cache-pi-";

// A fake ChildProcess: an EventEmitter with the pid/unref surface dispatch()
// touches. Tests drive completion by calling fakeChild.emit("exit", ...) or
// .emit("error", ...) themselves -- nothing here runs asynchronously on its
// own, so tests don't need to wait on a real subprocess.
export function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  return child;
}

export function baseTask(overrides = {}) {
  return {
    id: "t_base",
    status: "done",
    directory: "/tmp/somewhere",
    model: LUNA_MODEL,
    variant: "high",
    sessionId: "ses_base",
    pid: 12345,
    startedAt: "2026-07-13T10:00:00.000Z",
    endedAt: "2026-07-13T10:01:00.000Z",
    exitCode: 0,
    signal: null,
    logPath: null,
    promptPreview: "do the thing",
    spawnError: null,
    cancelRequested: false,
    ...overrides,
  };
}

// A fake WorkerExecutor with pi-shaped defaults (pi is resolveExecutor's
// default), so a test that only cares about one or two fields passes just
// those as overrides instead of hand-writing a full executor literal at
// every call site. The next WorkerExecutor shape change -- like the
// extraRoBind -> extraRoBinds rename that prompted this helper -- then
// touches this one object instead of the dozen+ test literals that copy
// it. defaultSummaryModel defaults to MINIMAX_MODEL, the real pi
// executor's summary model; listModelsFn defaults to the empty string,
// matching what the pi-shaped fakes below all inject. normalizeLogEvent
// defaults to identity, and sandboxAuthFile to the byte-for-byte common
// stub shared by most call sites (override with an extraRwPairBinds-adding
// version if the test exercises the resumed-session bind path).
export function makeFakeExecutor(overrides = {}) {
  return {
    id: "pi",
    taskIdPrefix: "pi",
    errorBucketPrefix: "pi",
    defaultSummaryModel: MINIMAX_MODEL,
    binaryName: "pi",
    listModelsFn: async () => "",
    buildSpawnArgs: () => [],
    buildSummaryPrompt: () => "",
    normalizeLogEvent: (parsed) => parsed,
    sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: UNUSED_TMP, sandboxEnv: {} }),
    ...overrides,
  };
}

// makeFakeExecutor's defaults are pi-shaped (see above), but the opencode
// fakes all override the same five identity fields -- id, taskIdPrefix,
// errorBucketPrefix, defaultSummaryModel, and binaryName -- to opencode's
// values. This wrapper pre-applies that opencode-shaped identity so a call
// site passes only the behavior fields it actually exercises (buildSpawnArgs,
// normalizeLogEvent, ...) instead of repeating the five-field block.
export function makeFakeOpencodeExecutor(overrides = {}) {
  return makeFakeExecutor({
    id: "opencode",
    taskIdPrefix: "oc",
    errorBucketPrefix: "opencode",
    defaultSummaryModel: MIMO_MODEL,
    binaryName: "opencode",
    ...overrides,
  });
}

// Each of these is thrown by makeManager's default delegate for the matching
// lifecycle hook, so a test that forgot to inject it fails loudly at first
// use (rather than silently getting a no-op and asserting against stale
// state). The closure shape preserves the original "throw a specific string"
// error message that some tests match on.
function defaultSpawnFn() {
  return () => { throw new Error("spawnFn was not injected for this test"); };
}
function defaultKillFn() {
  return () => { throw new Error("killFn was not injected for this test"); };
}
function defaultListModelsFn() {
  return () => `${DEFAULT_SUMMARY_MODEL}\n`;
}
function defaultOpenCodeListModelVariantsFn() {
  // Mirrors defaultSpawnFn/defaultListModelsFn above: the opencode variants
  // warm-up shell-out (`opencode models --verbose`) is real subprocess work
  // that must be injected per-test, not fired for real from every
  // makeManager() construction in the suite.
  return async () => new Map();
}

function makeTempDirs() {
  // Sandboxing always mkdir's the resolved sandboxedDataHome (real disk, not
  // tmpfs -- see resolveCacheDir), so give every test an isolated temp
  // cacheDir by default instead of falling through to the real ~/.cache.
  // createTaskManager() runs sweepOrphanedOverlays() synchronously at
  // construction, scanning overlayTmpRoot for real "taskferry-cow-*" dirs --
  // its default is the real os.tmpdir(). Without an isolated default here,
  // any test that doesn't explicitly pass its own overlayTmpRoot ends up
  // scanning (and acting on) whatever a real, concurrently-running daemon
  // has actually left in /tmp on this host.
  return {
    stateDir: mkdtempTracked(AXI_TASKS_TEST_DIR),
    defaultCacheDir: mkdtempTracked(AXI_TASKS_CACHE_DIR),
    defaultOverlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
  };
}

function seedTestFixtures(stateDir, tasksFixture, logs) {
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const fixtureTasks = typeof tasksFixture === "function" ? tasksFixture(logDir) : tasksFixture;
  fs.writeFileSync(path.join(stateDir, TASKS_STATE_FILE), JSON.stringify(fixtureTasks, null, 2));
  for (const [name, content] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logDir, name), content);
  }
}

// Each optional field on the test seam follows the same shape: when the
// caller passed a value, forward it under the same key (with one carve-out
// for envDenylistSpec, which the manager expects pre-parsed as envDenylist).
// This helper collapses what was a 20-line `...(x != null ? { x } : {})`
// chain in the old monolithic makeManager() into a one-line per-field call,
// which is what brought its cyclomatic complexity from 33 down to 10.
// `inputKey` is the field name on the caller's options object;
// `outputKey` is the field name on the createTaskManager options. They
// are usually the same, but the envDenylistSpec -> envDenylist rename
// (the caller passes a comma-separated string; the manager expects a
// pre-parsed array) is the one place they differ.
function passthroughIfSet(options, inputKey, outputKey, transform) {
  const value = options[inputKey];
  if (value == null) return {};
  return { [outputKey]: transform ? transform(value) : value };
}

// Builds the per-test options object that gets spread over the createTaskManager
// call. Pulled out of makeManager() so the function body itself can stay
// under the 10-cyclomatic-complexity cap (each `??` chain and default-param
// adds 1, and the inline form was at 11 -- the eslint-config rule).
// `tasksFixture`/`logs` seed tasks.json and logs/ *before* the manager
// loads them (createTaskManager's loadPersisted() runs synchronously in
// the constructor, same as the old module-level code did at import time).
// `tasksFixture` may be an array or `(logDir) => array` for fixtures whose
// logPath needs to point inside the real log dir.
//
// The boolean toggles (sandboxEnabled, overlayEnabled) are defaulted to
// `false` rather than left as `undefined` so they override the manager's
// own env-driven defaults (`resolveBooleanToggle` falls back to a
// default of `true` for overlayEnabled when its input is `undefined` --
// the original makeManager()'s `= false` default param kept that
// override honest, and we need to preserve it for the bwrap argv-shape
// tests in tasks.sandbox.test.js, which assume the dispatch directory
// is a plain --bind, not a copy-on-write --overlay).
function buildManagerOptions(options, stateDir, defaultCacheDir, defaultOverlayTmpRoot) {
  return {
    stateDir,
    sandboxEnabled: options.sandboxEnabled ?? false,
    overlayEnabled: options.overlayEnabled ?? false,
    // Defaulted to 0 (disabled) rather than left undefined: the manager's
    // own DEFAULT_LOWERDIR_STAGGER_MS (3000ms) would otherwise silently
    // serialize every dispatch test that assumes synchronous, immediate,
    // concurrent launches. Tests exercising the stagger itself override
    // this explicitly via options.lowerdirStaggerMs.
    lowerdirStaggerMs: options.lowerdirStaggerMs ?? 0,
    cacheDir: options.cacheDir ?? defaultCacheDir,
    overlayTmpRoot: options.overlayTmpRoot ?? defaultOverlayTmpRoot,
    spawnFn: options.spawnFn ?? defaultSpawnFn(),
    killFn: options.killFn ?? defaultKillFn(),
    listModelsFn: options.listModelsFn ?? defaultListModelsFn(),
    opencodeListModelVariantsFn: options.opencodeListModelVariantsFn ?? defaultOpenCodeListModelVariantsFn(),
    ...passthroughIfSet({ defaultExecutor: options.defaultExecutor }, "defaultExecutor", "defaultExecutor"),
    ...passthroughIfSet({ defaultVariant: options.defaultVariant }, "defaultVariant", "defaultVariant"),
    ...passthroughIfSet({ opencodeVariantsTable: options.opencodeVariantsTable }, "opencodeVariantsTable", "opencodeVariantsTable"),
    ...passthroughIfSet({ config: options.config }, "config", "config"),
    ...passthroughIfSet({ checkBwrapAvailableFn: options.checkBwrapAvailableFn }, "checkBwrapAvailableFn", "checkBwrapAvailableFn"),
    ...passthroughIfSet({ existsFn: options.existsFn }, "existsFn", "existsFn"),
    ...passthroughIfSet({ statFn: options.statFn }, "statFn", "statFn"),
    ...passthroughIfSet({ lstatFn: options.lstatFn }, "lstatFn", "lstatFn"),
    ...passthroughIfSet({ readdirFn: options.readdirFn }, "readdirFn", "readdirFn"),
    ...passthroughIfSet({ runtimeDir: options.runtimeDir }, "runtimeDir", "runtimeDir"),
    ...passthroughIfSet({ platform: options.platform }, "platform", "platform"),
    ...passthroughIfSet({ onEvent: options.onEvent }, "onEvent", "onEvent"),
    ...passthroughIfSet({ resolveWorkspaceRootFn: options.resolveWorkspaceRootFn }, "resolveWorkspaceRootFn", "resolveWorkspaceRootFn"),
    ...passthroughIfSet({ maxDispatchesPerWindow: options.maxDispatchesPerWindow }, "maxDispatchesPerWindow", "maxDispatchesPerWindow"),
    ...passthroughIfSet({ dispatchWindowMs: options.dispatchWindowMs }, "dispatchWindowMs", "dispatchWindowMs"),
    ...passthroughIfSet({ advisorSessionTtlMs: options.advisorSessionTtlMs }, "advisorSessionTtlMs", "advisorSessionTtlMs"),
    ...passthroughIfSet({ maxConcurrentTasks: options.maxConcurrentTasks }, "maxConcurrentTasks", "maxConcurrentTasks"),
    ...passthroughIfSet({ noOutputTimeoutMs: options.noOutputTimeoutMs }, "noOutputTimeoutMs", "noOutputTimeoutMs"),
    ...passthroughIfSet({ postOutputNoOutputTimeoutMs: options.postOutputNoOutputTimeoutMs }, "postOutputNoOutputTimeoutMs", "postOutputNoOutputTimeoutMs"),
    ...passthroughIfSet({ preOutputMaxMs: options.preOutputMaxMs }, "preOutputMaxMs", "preOutputMaxMs"),
    ...passthroughIfSet({ watchdogPollMs: options.watchdogPollMs }, "watchdogPollMs", "watchdogPollMs"),
    ...passthroughIfSet({ maxWaitMs: options.maxWaitMs }, "maxWaitMs", "maxWaitMs"),
    ...passthroughIfSet({ envDenylistSpec: options.envDenylistSpec }, "envDenylistSpec", "envDenylist", (spec) => parseEnvDenylist(spec)),
    ...passthroughIfSet({ envFileVars: options.envFileVars }, "envFileVars", "envFileVars"),
    ...passthroughIfSet({ sandboxDenylist: options.sandboxDenylist }, "sandboxDenylist", "sandboxDenylist"),
    ...passthroughIfSet({ allowedDirs: options.allowedDirs }, "allowedDirs", "allowedDirs"),
    ...passthroughIfSet({ rwBind: options.rwBind }, "rwBind", "rwBind"),
    ...passthroughIfSet({ roBind: options.roBind }, "roBind", "roBind"),
    ...passthroughIfSet({ providerLimits: options.providerLimits }, "providerLimits", "providerLimits"),
    ...passthroughIfSet({ resolveGitCommonDirFn: options.resolveGitCommonDirFn }, "resolveGitCommonDirFn", "resolveGitCommonDirFn"),
    ...passthroughIfSet({ resolveGitDirFn: options.resolveGitDirFn }, "resolveGitDirFn", "resolveGitDirFn"),
    ...passthroughIfSet({ checkOverlaySupportFn: options.checkOverlaySupportFn }, "checkOverlaySupportFn", "checkOverlaySupportFn"),
    ...passthroughIfSet({ runOverlayCommandFn: options.runOverlayCommandFn }, "runOverlayCommandFn", "runOverlayCommandFn"),
    ...passthroughIfSet({ rmOverlayTreeFn: options.rmOverlayTreeFn }, "rmOverlayTreeFn", "rmOverlayTreeFn"),
    ...passthroughIfSet({ overlaySleepFn: options.overlaySleepFn }, "overlaySleepFn", "overlaySleepFn"),
  };
}

// Builds an isolated task manager backed by a temp state dir and, unless
// overridden, fake spawnFn/killFn so no test ever touches a real `opencode`
// process or a real OS signal.
export function makeManager(options = {}) {
  const { stateDir, defaultCacheDir, defaultOverlayTmpRoot } = makeTempDirs();
  seedTestFixtures(stateDir, options.tasksFixture ?? [], options.logs ?? {});
  return trackManager(
    createTaskManager(buildManagerOptions(options, stateDir, defaultCacheDir, defaultOverlayTmpRoot)),
    { autoModel: options.autoModel !== false }
  );
}
