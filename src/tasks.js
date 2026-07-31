import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskEvents } from "./events.js";
import { createActivityCache, readActivitySnapshot, readDeltaNarration, DEFAULT_SUMMARIZER_TIMEOUT_MS } from "./activity.js";
import { withFileLock } from "./state-lock.js";
import { resolveStateDir, resolveCacheDir, TASKFERRY_PLUMBING_ENV_VARS } from "./paths.js";
import { RESULT_FIELDS } from "./protocol.js";
import { formatToolEventForNarration } from "./narration-format.js";
import { errCode } from "./errors.js";
import { isNonNegativeInteger, isPositiveInteger } from "./numbers.js";
import { buildBwrapArgs, checkBwrapAvailable, checkOverlaySupport, defaultDenyList, platformSupportsSandbox, resolveGitCommonDir, resolveGitDir } from "./sandbox.js";
import { applyChangeset, overlayPaths, resolvePreDispatchHead, subOverlayPaths, cleanupOverlay, defaultRunCommand as defaultOverlayRunCommand, extractGitDiff, extractNonGitDiff } from "./changeset.js";
import { resolveExecutor, opencodeExecutor } from "./executor.js";

/**
 * @typedef {object} SummaryOf
 * @property {string} sourceTaskId
 * @property {string} sourceStatus
 * @property {string} capturedAt
 * @property {number} sourceLogBytes
 * @property {number} summaryInputBytes
 * @property {number} maxWords
 */

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} status
 * @property {string} directory
 * @property {string} model
 * @property {string|null} variant
 * @property {string|null} sessionId
 * @property {string|null} originSessionId
 * @property {number|null} pid
 * @property {string} startedAt
 * @property {string|null} endedAt
 * @property {number|null} exitCode
 * @property {NodeJS.Signals|null} signal
 * @property {string} logPath
 * @property {string} promptPreview
 * @property {number|null} promptTotalChars
 * @property {string|null} spawnError
 * @property {boolean} cancelRequested
 * @property {boolean} internal
 * @property {string|null} [failureReason]
 * @property {string|null} [failureDetail]
 * @property {SummaryOf} [summaryOf]
 * @property {boolean} [incomplete]
 * @property {string|null} [finalMarker]
 * @property {"opencode"|"pi"} [executorId]
 * @property {"dispatch"|"advisor"} [role]
 * @property {"none"|"pending"|"accepted"|"rejected"} [changesetStatus]
 * @property {string|null} [diffPath]
 * @property {{root:string,tmpRoot:string,upperDir:string,workDir:string,rwBinds:Array<{path:string,upperDir:string,workDir:string}>}|null} [overlayDirs]
 * @property {string|null} [preDispatchHead]
 * @property {string|null} [changesetError]
 */

/**
 * @typedef {object} TaskSummary
 * @property {string} id
 * @property {string} status
 * @property {string} directory
 * @property {string} model
 * @property {string|null} sessionId
 * @property {string|null} originSessionId
 * @property {number|null} pid
 * @property {string} startedAt
 * @property {string|null} endedAt
 * @property {number|null} exitCode
 * @property {NodeJS.Signals|null} signal
 * @property {string} logPath
 * @property {string} promptPreview
 * @property {number} [promptTotalChars]
 * @property {SummaryOf} [summaryOf]
 * @property {boolean} cancelRequested
 * @property {string|null} [failureReason]
 * @property {string|null} [failureDetail]
 * @property {string|null} [spawnError]
 * @property {boolean} [incomplete]
 * @property {string|null} [finalMarker]
 * @property {"opencode"|"pi"} [executorId]
 * @property {"dispatch"|"advisor"} [role]
 * @property {"none"|"pending"|"accepted"|"rejected"} [changesetStatus]
 * @property {string|null} [diffPath]
 * @property {{root:string,tmpRoot:string,upperDir:string,workDir:string,rwBinds:Array<{path:string,upperDir:string,workDir:string}>}|null} [overlayDirs]
 * @property {string|null} [preDispatchHead]
 * @property {string|null} [changesetError]
 */

/**
 * @typedef {object} LogActivity
 * @property {number} logBytesWritten
 * @property {string|null} logLastWriteAt
 * @property {boolean} logHasEvent
 */

/**
 * @typedef {TaskSummary & Partial<LogActivity> & {outputTail?: string, outputTailTotalChars?: number, outputTailTruncated?: boolean, timedOut?: boolean, next?: string}} TaskStatus
 */

/**
 * @typedef {object} DispatchLaunch
 * @property {string} prompt
 * @property {string} directory
 * @property {string} model
 * @property {string|null} variant
 * @property {string|null|undefined} [sessionId]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {boolean} [noSandbox]
 * @property {boolean} [noOverlay]
 * @property {"dispatch"|"advisor"} [role]
 * @property {string[]} [allowedDirs]
 * @property {import("./executor.js").WorkerExecutor} executor
 * @property {undefined} [kind]
 * @property {undefined} [snapshotPath]
 */

/**
 * @typedef {object} SummaryLaunch
 * @property {"summary"} kind
 * @property {string} model
 * @property {string} snapshotPath
 * @property {NodeJS.ProcessEnv} [env]   caller env snapshot (cloned at request time, same as dispatch's capturedEnv). Computed into the final env at spawn time by startTask().
 * @property {string} [summarySessionId]  opencode session id to continue on this turn, if any
 * @property {import("./executor.js").WorkerExecutor} executor
 */

/** @typedef {DispatchLaunch|SummaryLaunch} LaunchSpec */

/**
 * @typedef {object} ResultDetail
 * @property {string} taskId
 * @property {string} status
 * @property {string} [message]
 * @property {string} [narration]
 * @property {number} [narrationTotalChars]
 * @property {boolean} [narrationTruncated]
 * @property {number|null} [exitCode]
 * @property {NodeJS.Signals|null} [signal]
 * @property {string|null} [spawnError]
 * @property {string|null} [failureReason]
 * @property {string|null} [failureDetail]
 * @property {string|null} [sessionId]
 * @property {unknown} [tokens]
 * @property {number|null} [cost]
 * @property {string} [logPath]
 * @property {SummaryOf} [summaryOf]
 * @property {string} [next]
 * @property {boolean} [incomplete]
 * @property {string|null} [finalMarker]
 * @property {string|null} [diff]
 * @property {{files: number, additions: number, deletions: number}|null} [diffStat]
 * @property {string|null} [changesetError]
 */

const DEFAULT_STATE_DIR = resolveStateDir(process.env);

// Default timeout for advisor() and the internal activity-summary poll.
// Regular taskferry wait calls have no implicit timeout.
const MAX_WAIT_MS = 45000;

const NARRATION_PREVIEW_CHARS = 2000;
const TASK_MANAGER_RESULT_FIELDS = new Set([...RESULT_FIELDS, "diff", "diffStat"]);
const TAIL_READ_BYTES = 1024 * 1024;
const SUMMARY_INPUT_BYTES = 96 * 1024;
// Linux caps a single execve argv string at 128KiB (MAX_ARG_STRLEN), separate
// from ARG_MAX (the combined argv+env budget). A prompt above this threshold
// passed as `spawn("opencode", [..., "--", prompt])`'s trailing positional
// crashes with `spawn E2BIG` well before ARG_MAX is ever a concern (issue
// #78). Kept a safety margin under the hard 131072-byte cap rather than
// riding the exact limit.
const PROMPT_ARGV_SAFE_BYTES = 96 * 1024;
export const DEFAULT_SUMMARY_MODEL = "opencode/mimo-v2.5-free";

// Ordered most-specific-first: real provider error text often combines
// more than one signal (e.g. "Rate limit exceeded, check your quota"), so
// the first bucket in this order that matches wins, rather than whichever
// pattern happens to be listed first in a flat scan.
//
// payment_required: `insufficient_quota` and `payment required`/`billing`
// are unambiguous billing signals that never mean "retry later works" the
// way a rate-limit message does.
const PAYMENT_REQUIRED_PATTERNS = [
  /insufficient_quota/i,
  /payment.?required/i,
  /\bbilling\b/i,
  /status(_code)?[:\s=]+402\b/i,
];
// authentication_failed: `unauthorized` / `invalid api key` are unambiguous
// auth signals. The bare 401 variant requires a `status`/`status_code`
// prefix rather than matching `\b401\b` on its own: a raw non-JSON log line
// (the noisiest scanning surface this classifier covers) can contain an
// unrelated 3-digit number (a byte count, a line number, a test count)
// that would otherwise false-positive.
const AUTHENTICATION_FAILED_PATTERNS = [
  /unauthorized/i,
  /invalid.api.?key/i,
  /authentication.?failed/i,
  /status(_code)?[:\s=]+401\b/i,
  // pi's own plain-English auth failure text ("No API key found for
  // <provider>.") matches none of the patterns above -- verified live
  // against a real unauthenticated pi dispatch (issue #94 research).
  /no api key/i,
];
// rate_limited: the broadest, most generic bucket, checked last. Bare
// `quota` (without `insufficient_quota` or another payment_required
// signal) lands here deliberately: providers use "quota" for rate/usage
// budgets far more often than for billing failures, so an ambiguous bare
// mention defaults to the safer "transient, retry later" interpretation.
const RATE_LIMITED_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /\bquota\b/i,
];

const PROVIDER_FAILURE_BUCKETS = [
  /** @type {[string, RegExp[]]} */ (["payment_required", PAYMENT_REQUIRED_PATTERNS]),
  /** @type {[string, RegExp[]]} */ (["authentication_failed", AUTHENTICATION_FAILED_PATTERNS]),
  /** @type {[string, RegExp[]]} */ (["rate_limited", RATE_LIMITED_PATTERNS]),
];

const FAILURE_DETAIL_MAX_CHARS = 500;

/** @param {string} text */
function capDetail(text) {
  return text.length > FAILURE_DETAIL_MAX_CHARS ? text.slice(0, FAILURE_DETAIL_MAX_CHARS - 1) + "…" : text;
}

// Maps a classifier bucket to its public-facing name. Opencode's named
// buckets (`rate_limited`, `authentication_failed`, `payment_required`)
// are the historical, shipped names and stay unprefixed for opencode
// tasks -- every downstream caller, doc, and `--full` output keys off
// those exact strings, and renaming them is a backward-incompatible
// change for a Task whose brief is the executor abstraction. Other
// executors (pi, future) get their own prefix (`pi_authentication_failed`,
// etc.) so executor-specific failures stay distinguishable in failureReason
// values. Unknown structured errors (the opencode-class-name bucket
// constructed from evt.error.name) still always uses the prefix -- those
// strings are new and never shipped unprefixed, so there's no caller
// keyed off the bare class name to worry about.
/**
 * @param {string} errorBucketPrefix
 * @param {string} bucket
 * @returns {string}
 */
export function bucketFor(errorBucketPrefix, bucket) {
  if (errorBucketPrefix === "opencode") return bucket;
  return `${errorBucketPrefix}_${bucket}`;
}

// opencode emits one real step_finish per step, each carrying that step's own
// token delta (not a running total), so result() must accumulate across every
// step_finish rather than keeping only the last -- otherwise a multi-step
// task's usage undercounts down to its final step (issue #201). pi's executor
// only ever emits a single step_finish (its usage is already cumulative), so
// summing is a no-op there and needs no executor-specific branch.
/**
 * @param {any} prev
 * @param {any} next
 * @returns {any}
 */
function sumTokens(prev, next) {
  if (!prev) return next;
  /** @param {any} a @param {any} b */
  const sum = (a, b) => (typeof a === "number" || typeof b === "number" ? (a ?? 0) + (b ?? 0) : (a ?? b));
  return {
    ...prev,
    ...next,
    total: sum(prev.total, next.total),
    input: sum(prev.input, next.input),
    output: sum(prev.output, next.output),
    reasoning: sum(prev.reasoning, next.reasoning),
    ...(prev.cache || next.cache
      ? { cache: { write: sum(prev.cache?.write, next.cache?.write), read: sum(prev.cache?.read, next.cache?.read) } }
      : {}),
  };
}

// Scoped to opencode's own structured `type:"error"` events and raw
// non-JSON lines (stderr, crash text), never a `type:"text"` event's
// content. Those events are the model's own narration and routinely
// contain these same words in unrelated, healthy output (writing
// rate-limit-handling code, narrating "the server returned 429, retry
// with backoff"); scanning the whole raw log killed tasks on that
// false-positive surface (GLM-5.2 review of 0d944df..4e75129, finding 1).
/**
 * @param {string[]} lines
 * @param {string} errorBucketPrefix
 * @returns {{failure: {bucket: string, detail: string} | null, hasParseableLine: boolean}}
 */
function classifyProviderFailure(lines, errorBucketPrefix) {
  let hasParseableLine = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
      hasParseableLine = true;
    } catch {
      for (const [bucket, patterns] of PROVIDER_FAILURE_BUCKETS) {
        if (patterns.some((pattern) => pattern.test(line))) {
          return { failure: { bucket: bucketFor(errorBucketPrefix, bucket), detail: capDetail(line) }, hasParseableLine };
        }
      }
      continue;
    }
    if (evt.type !== "error") continue;
    const text = typeof evt.message === "string" ? evt.message : JSON.stringify(evt);
    for (const [bucket, patterns] of PROVIDER_FAILURE_BUCKETS) {
      if (patterns.some((pattern) => pattern.test(text))) {
        return { failure: { bucket: bucketFor(errorBucketPrefix, bucket), detail: capDetail(text) }, hasParseableLine };
      }
    }
    // A structured `type:"error"` event is never noise -- unlike the raw
    // non-JSON line branch above, this is opencode's own error signal, so an
    // event that misses all three named buckets still deserves a reason
    // rather than leaving failureReason/failureDetail null (e.g. a
    // mid-stream "UnknownError: Streaming response failed" with zero model
    // output, oc_mrutsm8i_764c0067). opencode's own error class name
    // (UnknownError, ContextOverflowError, APIError, ...) becomes the
    // bucket; its message becomes the detail.
    const errorName = typeof evt.error?.name === "string" ? evt.error.name : "error";
    const errorMessage = typeof evt.error?.data?.message === "string" ? evt.error.data.message : text;
    return {
      failure: {
        bucket: `${errorBucketPrefix}_${errorName.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`,
        detail: capDetail(errorMessage),
      },
      hasParseableLine,
    };
  }
  return { failure: null, hasParseableLine };
}

/**
 * @param {number} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  return isPositiveInteger(value) ? value : fallback;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function nonNegativeInteger(value, fallback) {
  return isNonNegativeInteger(value) ? value : fallback;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string|undefined} spec
 * @returns {string[]}
 */
export function parseAllowedDirs(spec) {
  if (!spec) return [];
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parses a comma-separated env var denylist. Same comma-list semantics as
 * {@link parseAllowedDirs}, kept under its own name for call-site clarity.
 * @param {string|undefined} spec
 * @returns {string[]}
 */
export function parseEnvDenylist(spec) {
  return parseAllowedDirs(spec);
}

/**
 * @param {string} directory
 * @param {string} candidate
 * @returns {boolean}
 */
export function isOutsideDirectory(directory, candidate) {
  const rel = path.relative(directory, candidate);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

const DEFAULT_MAX_DISPATCHES_PER_WINDOW = 2;
const DEFAULT_DISPATCH_WINDOW_MS = 5000;
const DEFAULT_MAX_CONCURRENT_TASKS = 4;
const DEFAULT_ADVISOR_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_NO_OUTPUT_TIMEOUT_MS = 256000;
const DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS = 400000;
// TASKFERRY_WATCHDOG_POLL_MS is internal plumbing with no config-file
// equivalent (see .superpowers/.completed/specs/2026-07-18-config-file-design.md),
// so this one constant keeps reading process.env directly.
const DEFAULT_WATCHDOG_POLL_MS = positiveInteger(
  Number(process.env.TASKFERRY_WATCHDOG_POLL_MS),
  2000
);
const DEFAULT_WATCHDOG_GRACE_MS = 5000;
const DEFAULT_CANCEL_GRACE_MS = 5000;

/**
 * @param {object} [options]
 * @param {typeof spawn} [options.spawnFn]
 * @param {(pid: number, signal: NodeJS.Signals) => void} [options.killFn]
 * @param {(env: NodeJS.ProcessEnv) => Promise<string>} [options.listModelsFn] - shell-out for the
 *   installed-models list used to validate `TASKFERRY_SUMMARY_MODEL` is available before any summary
 *   call. Defaults to `opencodeExecutor().listModelsFn` -- not `defaultExecutor.listModelsFn` --
 *   because `summarizeTask()` deliberately hardcodes `opencodeExecutor()` for the actual summary
 *   work (separately tracked scope boundary from the dispatch-default executor flip). A default-config
 *   pi install must validate the configured summary model against opencode's list, since that's the
 *   CLI summaries actually run through regardless of which executor dispatches use.
 * @param {import("./executor.js").WorkerExecutor} [options.defaultExecutor] - fallback WorkerExecutor used when
 *   a dispatch doesn't request one explicitly. Per-dispatch selection (Task 6) calls `resolveExecutor(params.executor)`
 *   and overrides this; this option exists so tests and embedders can swap in a different default without the
 *   `dispatch({...})` params surface. Defaults to `resolveExecutor(undefined)` → `piExecutor()`.
 * @param {string} [options.stateDir]
 * @param {Record<string, unknown>} [options.config]
 * @param {number} [options.maxDispatchesPerWindow]
 * @param {number} [options.dispatchWindowMs]
 * @param {number} [options.maxConcurrentTasks]
 * @param {number} [options.advisorSessionTtlMs]
 * @param {number} [options.noOutputTimeoutMs]
 * @param {number} [options.postOutputNoOutputTimeoutMs]
 * @param {number} [options.watchdogPollMs]
 * @param {number} [options.watchdogGraceMs]
 * @param {number} [options.cancelGraceMs]
 * @param {number} [options.maxWaitMs]
 * @param {boolean} [options.activitySummariesEnabled]
 * @param {number} [options.summarizerTimeoutMs]
 * @param {string} [options.activitySummaryModel]
 * @param {number} [options.activityMaxWords]
 * @param {NodeJS.Platform} [options.platform]
 * @param {boolean} [options.sandboxEnabled]
 * @param {string[]} [options.envDenylist] - env var names stripped from every spawned child's
 *   environment, applied last (after the caller-env union), regardless of whether the value
 *   came from the daemon's own ambient environment or the caller.
 * @param {string[]} [options.allowedDirs] - extra directories always bound read-write inside the sandbox,
 *   in addition to the auto-detected git-common-dir for a worktree dispatch directory.
 * @param {(directory: string) => string|null} [options.resolveGitCommonDirFn]
 * @param {(directory: string) => string|null} [options.resolveGitDirFn]
 * @param {boolean} [options.overlayEnabled]
 * @param {() => {supported: boolean, reason?: string}} [options.checkOverlaySupportFn]
  * @param {string} [options.overlayTmpRoot]
 * @param {(command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} [options.runOverlayCommandFn]
 * @param {(path: string) => void} [options.rmOverlayTreeFn]
 * @param {() => {checked: boolean, available: boolean, reason?: string}} [options.checkBwrapAvailableFn]
 * @param {(path: string) => boolean} [options.existsFn]
 * @param {(path: string) => {isDirectory: () => boolean}|null} [options.statFn]
 * @param {(path: string) => string[]} [options.readdirFn]
 * @param {string} [options.runtimeDir]
 * @param {string} [options.cacheDir]
 * @param {(event: object) => void} [options.onEvent]
 */
// Factory rather than a module-level singleton, so tests can construct an
// isolated instance with an injected spawnFn/killFn (no real `opencode`
// process, no real OS signals) and its own state directory, instead of
// sharing process-wide state with every other test or the real server.
export function createTaskManager({
  spawnFn = spawn,
  killFn = (pid, signal) => process.kill(pid, signal),
  stateDir = DEFAULT_STATE_DIR,
  config = {},
  defaultExecutor = resolveExecutor(
    process.env.TASKFERRY_DEFAULT_EXECUTOR || /** @type {string|undefined} */ (config.defaultExecutor)
  ),
  // Defaults to whichever executor is actually the manager's default, so a
  // pi-only install (no opencode CLI on PATH) doesn't ENOENT the first time
  // it touches `taskferry summary` or `watch --summaries`.
  listModelsFn = opencodeExecutor().listModelsFn,
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
  watchdogGraceMs = positiveInteger(
    Number(process.env.TASKFERRY_WATCHDOG_GRACE_MS),
    positiveInteger(/** @type {number} */ (config.watchdogGraceMs), DEFAULT_WATCHDOG_GRACE_MS)
  ),
  cancelGraceMs = positiveInteger(
    Number(process.env.TASKFERRY_CANCEL_GRACE_MS),
    positiveInteger(/** @type {number} */ (config.cancelGraceMs), DEFAULT_CANCEL_GRACE_MS)
  ),
  maxWaitMs = MAX_WAIT_MS,
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
  platform = process.platform,
  sandboxEnabled = process.env.TASKFERRY_DISABLE_SANDBOX !== undefined
    ? !["1", "true"].includes(process.env.TASKFERRY_DISABLE_SANDBOX)
    : (/** @type {boolean|undefined} */ (config.sandboxEnabled) ?? true),
  allowedDirs = parseAllowedDirs(process.env.TASKFERRY_ALLOWED_DIRS ?? /** @type {string|undefined} */ (config.allowedDirs)),
  envDenylist = parseEnvDenylist(process.env.TASKFERRY_ENV_DENYLIST ?? /** @type {string|undefined} */ (config.envDenylist)),
  overlayEnabled = process.env.TASKFERRY_DISABLE_OVERLAY !== undefined
    ? !["1", "true"].includes(process.env.TASKFERRY_DISABLE_OVERLAY)
    : (/** @type {boolean|undefined} */ (config.overlayEnabled) ?? true),
  checkOverlaySupportFn = checkOverlaySupport,
  overlayTmpRoot = os.tmpdir(),
  runOverlayCommandFn = defaultOverlayRunCommand,
  rmOverlayTreeFn,
  resolveGitCommonDirFn = resolveGitCommonDir,
  resolveGitDirFn = resolveGitDir,
  checkBwrapAvailableFn = checkBwrapAvailable,
  existsFn = fs.existsSync,
  statFn = (/** @type {string} */ p) => { try { return fs.statSync(p); } catch { return null; } },
  readdirFn = (/** @type {string} */ p) => fs.readdirSync(p),
  runtimeDir = path.join(stateDir, "run"),
  cacheDir = resolveCacheDir(process.env),
  onEvent,
} = {}) {
  const LOG_DIR = path.join(stateDir, "logs");
  const SUMMARY_DIR = path.join(stateDir, "summaries");
  const PROMPT_DIR = path.join(stateDir, "prompts");
  const TASKS_FILE = path.join(stateDir, "tasks.json");
  const LOCK_FILE = path.join(stateDir, "tasks.lock");
  const dispatchLimit = positiveInteger(maxDispatchesPerWindow, DEFAULT_MAX_DISPATCHES_PER_WINDOW);
  const dispatchWindow = positiveInteger(dispatchWindowMs, DEFAULT_DISPATCH_WINDOW_MS);
  const concurrencyLimit = positiveInteger(maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
  // Summarizer sub-tasks spawned by the activity-refresh path share the
  // launch queue and runningCount with real dispatches. Reserving half the
  // pool stops a burst of lifecycle-triggered summaries from occupying every
  // concurrency slot and starving real dispatches.
  const summaryConcurrencyLimit = Math.max(1, Math.floor(concurrencyLimit / 2));
  const advisorTtl = positiveInteger(advisorSessionTtlMs, DEFAULT_ADVISOR_SESSION_TTL_MS);
  const noOutputTimeout = positiveInteger(noOutputTimeoutMs, DEFAULT_NO_OUTPUT_TIMEOUT_MS);
  const postOutputNoOutputTimeout = positiveInteger(postOutputNoOutputTimeoutMs, DEFAULT_POST_OUTPUT_NO_OUTPUT_TIMEOUT_MS);
  const watchdogPoll = positiveInteger(watchdogPollMs, DEFAULT_WATCHDOG_POLL_MS);
  const watchdogGrace = positiveInteger(watchdogGraceMs, DEFAULT_WATCHDOG_GRACE_MS);
  const cancelGrace = positiveInteger(cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
  const maxWait = positiveInteger(maxWaitMs, MAX_WAIT_MS);
  const summarizerTimeout = nonNegativeInteger(summarizerTimeoutMs, DEFAULT_SUMMARIZER_TIMEOUT_MS);
  const activityWords = positiveInteger(activityMaxWords, 75);
  let eventSequence = 0;
  const taskEvents = createTaskEvents((event) => {
    eventSequence = Math.max(eventSequence, /** @type {{sequence: number}} */ (event).sequence);
    if (onEvent) onEvent(event);
  });

  /** @type {{checked: boolean, available: boolean, reason?: string}|null} */
  let bwrapAvailable = null;
  function requireBwrap() {
    if (bwrapAvailable == null) {
      bwrapAvailable = checkBwrapAvailableFn();
    }
    if (!bwrapAvailable.available) {
      throw new Error(
        "error: bwrap is required for sandboxing but was not found\n" +
        "help: install bubblewrap (e.g. apt install bubblewrap) or opt out with --no-sandbox or TASKFERRY_DISABLE_SANDBOX=1"
      );
    }
  }

  /** @type {{supported: boolean, reason?: string, checkedAt: number}|null} */
  let overlaySupport = null;
  // Re-probe a negative result after this many ms so a transient failure
  // (bwrap version-too-old mid-upgrade, PATH temporarily missing the binary,
  // a freshly-installed package not yet on the daemon's PATH, etc.) can
  // self-heal without a full daemon restart. A positive result is cached
  // forever — once the host supports the overlay, it stays supported unless
  // someone uninstalls bwrap, which is not a transient failure.
  const OVERLAY_SUPPORT_TTL_MS = 60_000;
  function requireOverlaySupport() {
    const now = Date.now();
    if (overlaySupport == null || (!overlaySupport.supported && now - overlaySupport.checkedAt >= OVERLAY_SUPPORT_TTL_MS)) {
      overlaySupport = { ...checkOverlaySupportFn(), checkedAt: now };
    }
    const result = /** @type {{supported: boolean, reason?: string}} */ (overlaySupport);
    if (!result.supported) {
      throw new Error(
        `error: overlay is required for gated dispatch writes but is unsupported (${result.reason})\n` +
        "help: upgrade bubblewrap to >= 0.8, or opt out explicitly with --no-overlay or TASKFERRY_DISABLE_OVERLAY=1 (writes will not be gated)"
      );
    }
  }

  /**
   * Removes a task's overlay using the tmp root recorded when that overlay
   * was created. A failed removal leaves overlayDirs intact for the startup
   * sweep to retry.
   * @param {{overlayDirs?: {root:string,tmpRoot:string}|null}} task
   * @returns {boolean} whether cleanup failed
   */
  function releaseOverlay(task) {
    if (!task.overlayDirs) return false;
    const removal = cleanupOverlay({
      root: task.overlayDirs.root,
      tmpRoot: task.overlayDirs.tmpRoot,
      rmFn: rmOverlayTreeFn,
    });
    if (removal.removed) task.overlayDirs = null;
    return !removal.removed;
  }

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
            overlayRwBinds: finishedTask.overlayDirs.rwBinds ?? [],
            preDispatchHead: /** @type {string} */ (finishedTask.preDispatchHead),
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
      finishedTask.changesetStatus = "pending";
      finishedTask.changesetError = err instanceof Error ? err.message : String(err);
      persistTask(finishedTask.id);
      return;
    }
    finishedTask.diffPath = extracted.diffPath;
    finishedTask.changesetError = null;
    if (finishedTask.role === "advisor") {
      finishedTask.changesetStatus = "rejected";
      releaseOverlay(finishedTask);
    } else if (extracted.hasChanges) {
      finishedTask.changesetStatus = "pending";
    } else {
      finishedTask.changesetStatus = "accepted";
      releaseOverlay(finishedTask);
    }
  }

  const CALLER_ENV_EXCLUDED = new Set(["PATH", "HOME", ...TASKFERRY_PLUMBING_ENV_VARS]);

  /**
   * Builds the final base environment for a spawned child: the daemon's own
   * ambient environment (read fresh at call time), overlaid with the
   * caller-supplied `env` (caller wins, except for CALLER_ENV_EXCLUDED --
   * daemon-controlled plumbing resolved once at the daemon's own startup),
   * with `envDenylist` stripped last regardless of which side the value
   * came from. Applies the same key/value rules as the RPC-level
   * isEnvironment so a programmatic caller that bypasses the socket (no
   * isEnvironment gate) can't smuggle a malformed key past the spawn
   * boundary -- bad keys throw synchronously here, which startTask() catches
   * and surfaces as a spawnError on a crashed task rather than a
   * silently-dropped value. Null or undefined env is treated as empty (as
   * the pre-validation spread did) rather than rejected.
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {NodeJS.ProcessEnv}
   */
  function sanitizedEnvironment(env = {}) {
    const callerEnv = env ?? {};
    const merged = { ...process.env };
    for (const name of Object.keys(callerEnv)) {
      if (name === "" || name.includes("=")) {
        throw new Error(`error: invalid env key in caller-supplied env: ${JSON.stringify(name)}\nhelp: env keys must be non-empty strings without '=' characters`);
      }
      if (typeof callerEnv[name] !== "string") {
        throw new Error(`error: env value for ${JSON.stringify(name)} must be a string, got ${typeof callerEnv[name]}\nhelp: cast values to strings before dispatching`);
      }
      if (CALLER_ENV_EXCLUDED.has(name)) continue;
      merged[name] = callerEnv[name];
    }
    for (const name of envDenylist) delete merged[name];
    return merged;
  }

  /** @param {NodeJS.ProcessEnv} [env] */
  function dispatchEnvironment(env) {
    const result = sanitizedEnvironment(env);
    result.TASKFERRY_CHILD = "1";
    return result;
  }

  /** @param {NodeJS.ProcessEnv} [env] */
  function summaryEnvironment(env) {
    const result = sanitizedEnvironment(env);
    delete result.OPENCODE_CONFIG;
    delete result.OPENCODE_CONFIG_DIR;
    delete result.OPENCODE_CONFIG_CONTENT;
    result.TASKFERRY_CHILD = "1";
    return result;
  }

  for (const dir of [stateDir, LOG_DIR, SUMMARY_DIR, PROMPT_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  // In-memory state is the source of truth for queued and running tasks while this server
  // process is alive: process exit is delivered via the 'exit' event on our
  // own child_process handle, which only exists in the process that spawned
  // it. tasks.json is a best-effort record for taskferry list/debugging across
  // a server restart, not a re-attach mechanism. A restarted server has no
  // handle to a child spawned by its previous instance, so any task still
  // "running" in the file when we reload it is relabeled "unknown" rather
  // than reported as a stale, possibly-wrong "running".
  /** @type {Map<string, Task>} */
  const tasks = new Map();

  // Escalation timers for taskferry cancel, keyed by task id. Kept out of the
  // task object itself: task objects get JSON.stringify'd wholesale in
  // persist(), and a Timeout isn't serializable data.
  /** @type {Map<string, NodeJS.Timeout>} */
  const escalationTimers = new Map();

  // No-output watchdog tickers, keyed by task id. Each one polls the task's
  // log file on a fixed interval; if no parseable event has landed by the
  // configured deadline, failRunningTask() escalates the child. Same
  // "not in the task object" reason as escalationTimers.
  const runningWatchers = new Map();

  // Per-task incremental-scan progress for the running watcher, exposing
  // bytesRead and carry to classifyTrailingLogFailure() at exit time so the
  // trailing reclassification only re-reads bytes the watcher hadn't seen
  // yet, not the whole log from scratch.
  const runningWatcherState = new Map();

  // Pending `wait` callbacks, keyed by task id. Lets a single `taskferry wait`
  // call block until the child's exit event fires (or a timeout elapses)
  // instead of the caller round-tripping taskferry status in a loop. Not
  // persisted or shared across a server restart, same as the tasks map itself.
  /** @type {Map<string, Array<(timedOut?: boolean) => void>>} */
  const waiters = new Map();

  // Advisor session recency, keyed by opencode session id. Process-lifetime
  // only, same as `tasks` and `waiters` -- a taskferry restart means every
  // session id is "unknown," which resolveAdvisorSession() treats identically
  // to "expired" rather than special-casing it. Prevents taskferry advisor
  // from silently resuming a conversation whose prompt cache has gone cold.
  /** @type {Map<string, number>} */
  const advisorSessions = new Map();

  // Queued launches retain full prompts only in memory. Persisted queued tasks
  // become unknown on restart, just like running tasks, rather than launching
  // a prompt the replacement server cannot safely reconstruct.
  /** @type {Map<string, LaunchSpec>} */
  const pendingLaunches = new Map();
  /** @type {string[]} */
  const launchQueue = [];
  /** @type {number[]} */
  const launchTimes = [];
  /** @type {NodeJS.Timeout|null} */
  let launchTimer = null;
  let runningCount = 0;
  // Per-caller cache of provider model listings: keyed by a fingerprint of
  // the caller env's model-relevant vars (provider API keys, opencode
  // config-path overrides, pi agent dir), not by time alone. Two callers
  // with different credentials must not read each other's listings -- the
  // shared single-entry cache used to let caller A's listModelsFn output
  // satisfy caller B's availability check (and let two concurrent populate
  // writes interleave). The 5-minute TTL still applies per entry.
  // `modelsCacheInFlight` coalesces concurrent reads for the same key so
  // the underlying `opencode models` shell-out runs at most once per
  // fingerprint per TTL window.
  /** @type {Map<string, {expiresAt: number, output: string}>} */
  const modelsCache = new Map();
  /** @type {Map<string, Promise<{expiresAt: number, output: string}>>} */
  const modelsCacheInFlight = new Map();
  let activitySummarySubscriptions = 0;
  /** @type {Map<string, Set<boolean>>} */
  const activitySubscriptions = new Map();
  /** @type {Error|null} */
  let stateLoadError = null;

  const activityCache = createActivityCache({
    summariesEnabled: false,
    summarizerTimeoutMs: summarizerTimeout,
    summaryModel: activitySummaryModel,
    maxWords: activityWords,
    snapshot: (task) => readActivitySnapshot(task.logPath || ""),
    summarize: ({ task, maxWords, previousActivity }) => summarizeActivity(task.id, maxWords, previousActivity),
  });

  /**
   * @param {Task} task
   * @param {{force?: boolean}} [options]
   */
  function scheduleActivity(task, { force = false } = {}) {
    if (typeof onEvent !== "function" || task.internal) return Promise.resolve();
    const scheduledStatus = task.status;
    const scheduledDirectory = task.directory;
    const baseEvent = () => ({
      sequence: ++eventSequence,
      type: "task.activity",
      taskId: task.id,
      directory: scheduledDirectory,
      originSessionId: task.originSessionId ?? null,
      status: scheduledStatus,
      previousStatus: null,
      occurredAt: new Date().toISOString(),
    });
    const emit = (/** @type {object} */ event) => {
      if (scheduledStatus === "running" && task.status !== scheduledStatus) return;
      try {
        onEvent(event);
      } catch {
        // Activity is advisory and cannot interrupt task lifecycle.
      }
    };
    const dirVariants = activitySubscriptions.get(scheduledDirectory);
    const variants = dirVariants && dirVariants.size > 0
      ? [...dirVariants]
      : [activitySummariesEnabled && activitySummarySubscriptions > 0];
    const refreshes = variants.map((includeSummary) =>
      activityCache.refresh(task, { force, includeSummary })
        .then((result) => (result ? { includeSummary, activity: result.activity, outputWatermark: result.outputWatermark } : null))
        .catch((err) => ({ includeSummary, summaryFailed: true, summaryError: errMessage(err) }))
    );
    return Promise.all(refreshes).then((results) => {
      /** @type {Record<string, {includeSummary?: boolean, activity?: string, outputWatermark?: number, summaryFailed?: boolean, summaryError?: string}>} */
      const activityVariants = {};
      for (const r of results) {
        if (!r) continue;
        activityVariants[String(r.includeSummary)] = r;
      }
      if (Object.keys(activityVariants).length === 0) return;
      emit({ ...baseEvent(), activityVariants });
    });
  }

  function loadPersisted() {
    try {
      const raw = fs.readFileSync(TASKS_FILE, "utf8");
      /** @type {Task[]} */
      const persisted = JSON.parse(raw);
      for (const t of persisted) {
        const previousStatus = t.status;
        if (t.summaryOf) t.internal = true;
        try {
          t.directory = fs.realpathSync(t.directory);
        } catch {
          // A persisted task may outlive a workspace that has since been removed.
        }
        if (t.status === "running" || t.status === "queued") t.status = "unknown";
        if (t.executorId === undefined) t.executorId = "opencode";
        // Legacy records predate creation-time tmpRoot persistence. Keep their
        // prior live-root cleanup behavior rather than letting releaseOverlay
        // pass undefined into the containment guard; newly-created overlays
        // always carry the exact root that was in effect at creation.
        if (t.overlayDirs && t.overlayDirs.tmpRoot === undefined) t.overlayDirs.tmpRoot = overlayTmpRoot;
        tasks.set(t.id, t);
        if (t.status !== previousStatus) taskEvents.emitState(t, previousStatus);
      }
      fs.chmodSync(TASKS_FILE, 0o600);
    } catch (err) {
      if (errCode(err) !== "ENOENT") stateLoadError = /** @type {Error} */ (err);
    }
  }
  loadPersisted();

  // Scrub prompt scratch files left behind by a daemon crash or forced
  // restart. Each oversized dispatch writes its prompt to PROMPT_DIR as
  // `${task.id}.prompt.txt` (mode 0o600) and removes it from the task's own
  // exit/error paths -- but a SIGKILL of the daemon mid-task skips both
  // cleanup paths and orphans the file forever. Anything in PROMPT_DIR that
  // doesn't belong to a task this process can still run is leftover from such
  // a crash; deleting it at boot keeps the directory from accumulating
  // unread prompt contents across restarts.
  function sweepOrphanedPromptFiles() {
    let entries;
    try {
      entries = fs.readdirSync(PROMPT_DIR);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".prompt.txt")) continue;
      const taskId = entry.slice(0, -".prompt.txt".length);
      const task = tasks.get(taskId);
      if (task?.status === "running" || task?.status === "queued") continue;
      try {
        fs.unlinkSync(path.join(PROMPT_DIR, entry));
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
      }
    }
  }
  sweepOrphanedPromptFiles();

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
    const tmpRoots = new Set([overlayTmpRoot]);
    for (const task of tasks.values()) {
      if (task.overlayDirs?.tmpRoot) tmpRoots.add(task.overlayDirs.tmpRoot);
    }
    for (const tmpRoot of tmpRoots) {
      let entries;
      try {
        entries = fs.readdirSync(tmpRoot);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith("taskferry-cow-")) continue;
        const taskId = entry.slice("taskferry-cow-".length);
        const task = tasks.get(taskId);
        const root = path.join(tmpRoot, entry);
        const ownsThisOverlay = task?.overlayDirs?.root === root;
        if (ownsThisOverlay && task.changesetStatus === "pending") continue;
        const cleanupTarget = ownsThisOverlay
          ? task
          : { overlayDirs: { root, tmpRoot } };
        const cleanupFailed = releaseOverlay(cleanupTarget);
        if (!cleanupFailed && ownsThisOverlay) persistTask(taskId);
      }
    }
  }
  sweepOrphanedOverlays();

  function ensureStateLoaded() {
    if (!stateLoadError) return;
    throw new Error(`error: could not read persisted task state: ${stateLoadError.message}\nhelp: repair ${TASKS_FILE} before using opencode task tools`);
  }

  /**
   * @param {string} taskId
   */
  function persistTask(taskId) {
    withFileLock(LOCK_FILE, () => {
      /** @type {Task[]} */
      let current = [];
      try {
        current = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
      }
      const byId = new Map(current.map((t) => [t.id, t]));
      const local = tasks.get(taskId);
      if (local) byId.set(taskId, local);
      else byId.delete(taskId);
      const all = Array.from(byId.values());
      const temporary = path.join(stateDir, `.tasks-${randomUUID()}.json`);
      // Throwing from a `finally` would mask a real error from the try block
      // above (e.g. a full disk on writeFileSync) with an unrelated cleanup
      // failure. Defer the cleanup error and only surface it once the try
      // block itself has succeeded.
      /** @type {unknown} */
      let cleanupError;
      try {
        fs.writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, TASKS_FILE);
        fs.chmodSync(TASKS_FILE, 0o600);
      } finally {
        try {
          fs.unlinkSync(temporary);
        } catch (err) {
          if (errCode(err) !== "ENOENT") cleanupError = err;
        }
      }
      if (cleanupError) throw cleanupError;
    });
    const task = tasks.get(taskId);
    if (task) taskEvents.emitState(task);
  }

  /** @param {Task} task */
  function failureFields(task) {
    return { failureReason: task.failureReason ?? null, failureDetail: task.failureDetail ?? null };
  }

  /**
   * @param {Task} task
   * @returns {TaskSummary}
   */
  function summarize(task) {
    const { promptPreview, promptTotalChars, id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, incomplete, finalMarker, spawnError, executorId, role, changesetStatus } = task;
    return {
      id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
      ...failureFields(task),
      spawnError: spawnError ?? null,
      promptPreview,
      ...(promptTotalChars != null ? { promptTotalChars } : {}),
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      ...(incomplete === true ? { incomplete: true } : {}),
      ...(finalMarker != null ? { finalMarker } : {}),
      ...(executorId != null ? { executorId } : {}),
      ...(changesetStatus != null && (changesetStatus !== "none" || role === "advisor") ? { role, changesetStatus } : {}),
      ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
      ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
      cancelRequested: !!cancelRequested,
    };
  }

  // Minimal per-row schema for taskferry list: an agent scanning a task list
  // needs id/status/model/startedAt to decide what to poll next, not the full
  // detail (directory, pid, logPath, ...) that summarize() carries for a
  // single-task lookup. failureReason is included despite that otherwise-thin
  // schema because a "crashed" status alone doesn't tell a scanning agent
  // whether the task is worth retrying immediately (a provider failure bucket
  // such as rate_limited, payment_required, or authentication_failed)
  // or not (any other crash) -- omitting it here forces a task.status
  // round-trip per crashed row just to learn that.
  /**
   * @param {Task} task
   * @returns {{id: string, status: string, model: string, startedAt: string, failureReason: string|null}}
   */
  function summarizeRow(task) {
    const { id, status, model, startedAt, failureReason } = task;
    return { id, status, model, startedAt, failureReason: failureReason ?? null };
  }

  /**
   * @param {string} taskId
   * @returns {Error}
   */
  function noSuchTask(taskId) {
    return new Error(`error: unknown task id: ${taskId}\nhelp: run taskferry list to see valid task ids`);
  }

  /**
   * @param {string|undefined} sessionId
   * @returns {{sessionId: string|undefined, reset: boolean, previousSessionId: string|undefined}}
   */
  function resolveAdvisorSession(sessionId) {
    if (!sessionId) return { sessionId: undefined, reset: false, previousSessionId: undefined };
    const lastUsedAt = advisorSessions.get(sessionId);
    if (lastUsedAt != null && Date.now() - lastUsedAt <= advisorTtl) {
      return { sessionId, reset: false, previousSessionId: undefined };
    }
    return { sessionId: undefined, reset: true, previousSessionId: sessionId };
  }

  /** @param {string|undefined} sessionId */
  function touchAdvisorSession(sessionId) {
    if (sessionId) advisorSessions.set(sessionId, Date.now());
  }

  /**
   * @param {object} params
   * @param {string} params.prompt
   * @param {string} params.directory
   * @param {string} [params.model]
   * @param {string} [params.variant]
   * @param {string|undefined} [params.sessionId]
   * @param {string|undefined} [params.originSessionId]
   * @param {NodeJS.ProcessEnv} [params.env]
   * @param {boolean} [params.internal]
   * @param {string|null} [params.finalMarker]
   * @param {boolean} [params.noSandbox]
   * @param {boolean} [params.noOverlay]
   * @param {"dispatch"|"advisor"} [params.role]
   * @param {string[]} [params.allowedDirs] - extra directories bound read-write for this dispatch only, on
   *   top of the manager-level default (see createTaskManager's `allowedDirs` option)
   * @param {string} [params.executor] - "opencode" | "pi". When omitted on a `sessionId` resume, inherits
   *   the executor that originally created the session (a different executor can't continue another CLI's
   *   session file); otherwise defaults to the manager's defaultExecutor (itself the result of
   *   `resolveExecutor(undefined)` at construction). An unknown name throws before any validation runs, so a
   *   misrouted CLI/RPC call fails fast rather than silently picking the default.
   * @returns {TaskSummary & {next: string}}
   */
  function dispatch({ prompt, directory, model, variant, sessionId, internal = false, finalMarker = null, originSessionId, noSandbox = false, noOverlay = false, allowedDirs: dispatchAllowedDirs, executor: executorName, env, role = "dispatch" }) {
    ensureStateLoaded();
    // A resume (--session-id with no --executor) should inherit the executor
    // the session was actually created under, not silently fall back to the
    // manager's default -- a different executor has no way to continue a
    // session file another CLI's binary wrote. When --executor is given
    // explicitly, scope the lookup to tasks that match it too: session ids
    // are only unique per executor, so an explicit --executor pi alongside a
    // sessionId that collides with an unrelated opencode task must not let
    // that opencode task's model leak into this pi dispatch.
    /** @type {Task|null} */
    let priorSessionTask = null;
    if (sessionId) {
      for (const t of tasks.values()) {
        if (
          t.sessionId === sessionId
          && (executorName === undefined || t.executorId === executorName)
          && (!priorSessionTask || t.startedAt > priorSessionTask.startedAt)
        ) {
          priorSessionTask = t;
        }
      }
    }
    // Reuse the manager's single pre-built defaultExecutor instance when the
    // inherited/explicit executor matches it, instead of allocating a fresh
    // WorkerExecutor on every session-inheriting resume.
    const executor =
      executorName !== undefined
        ? (executorName === defaultExecutor.id ? defaultExecutor : resolveExecutor(executorName))
        : priorSessionTask
          ? (priorSessionTask.executorId === defaultExecutor.id ? defaultExecutor : resolveExecutor(priorSessionTask.executorId))
          : defaultExecutor;
    if (!prompt || typeof prompt !== "string") {
      throw new Error("error: prompt is required\nhelp: taskferry dispatch requires a non-empty prompt string");
    }
    if (!directory || !path.isAbsolute(directory)) {
      throw new Error(`error: directory must be an absolute path (got ${JSON.stringify(directory)})\nhelp: pass the full path, e.g. "/workspace/my-repo"`);
    }
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`error: directory does not exist: ${directory}\nhelp: check the path or create the directory first`);
    }
    if (finalMarker != null) {
      if (typeof finalMarker !== "string") {
        throw new Error("error: finalMarker must be a string regex source\nhelp: pass --require-final-marker with a pattern that compiles as a standard JS RegExp");
      }
      try {
        new RegExp(finalMarker);
      } catch (err) {
        throw new Error(`error: --require-final-marker is not a valid RegExp (${errMessage(err)})\nhelp: use standard JS RegExp syntax, e.g. '^Status: (DONE|DONE_WITH_CONCERNS|BLOCKED)$'`, { cause: err });
      }
    }
    let normalizedDirectory;
    try {
      normalizedDirectory = fs.realpathSync(directory);
    } catch (err) {
      throw new Error(`error: directory does not exist: ${directory}\nhelp: check the path or create the directory first (${errMessage(err)})`, { cause: err });
    }

    // Task IDs retain the literal "oc_" prefix for compatibility; WorkerExecutor.taskIdPrefix is not wired in this issue.
    const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const logPath = path.join(LOG_DIR, `${id}.ndjson`);

    // A resume (--session-id with no --model) should inherit the model the
    // session was actually created under, not silently fall back to the
    // hardcoded default -- a different model can mean a different provider,
    // breaking the whole point of resuming that exact session.
    const usingDefaultModel = !model;
    const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;

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
      incomplete: false,
      finalMarker: finalMarker == null ? null : finalMarker,
      role,
      changesetStatus: "none",
      diffPath: null,
      overlayDirs: null,
      preDispatchHead: null,
      changesetError: null,
    };
    tasks.set(id, task);
    persistTask(task.id);
    // Capture the caller env at dispatch time rather than holding the caller's
    // reference directly: later in-place mutations by the caller (or
    // accidental reuse across retries) must not be able to silently change
    // what's already queued for spawn. dispatchEnvironment() still reads
    // process.env fresh at spawn time, so the daemon's own ambient overrides
    // track process state, not the dispatch-time snapshot.
    //
    // Note: this clone is NOT redundant despite what one might guess from
    // sanitizedEnvironment()'s one-pass merge -- it reads Object.keys() and
    // each value lazily at spawn time, so without this snapshot a caller
    // mutating their original env object between queue time and the queued
    // launch's actual spawn would change what reaches the child. Pinned by
    // tasks.test.js's "dispatch()'s queued env is frozen against later
    // caller mutations" gate; removing the clone makes that test fail.
    const capturedEnv = env === undefined ? undefined : { ...env };
    pendingLaunches.set(id, { prompt, directory: normalizedDirectory, model: resolvedModel, variant: task.variant, sessionId, env: capturedEnv, noSandbox: noSandbox === true, noOverlay: noOverlay === true, allowedDirs: dispatchAllowedDirs, executor, role });
    launchQueue.push(id);
    launchQueuedTasks();

    const summary = summarize(task);
    return {
      ...summary,
      next: task.status === "queued"
        ? `Task is queued; run taskferry wait or taskferry status with task id "${id}" to check when it starts`
        : `Run taskferry wait or taskferry status with task id "${id}" to check progress`,
    };
  }

  /**
   * Fingerprint of the caller env's model-relevant subset: which keys and
   * values determine which models a provider exposes to opencode/pi.
   * Includes every `*_API_KEY` suffix (any provider credential a user can
   * name), every `*_BASE_URL` suffix (provider endpoint overrides -- a
   * corporate proxy or self-hosted endpoint exposes a different catalog
   * than the stock API host), the opencode config/model-list/auth
   * overrides (`OPENCODE_CONFIG*`, `OPENCODE_AUTH_CONTENT`,
   * `OPENCODE_MODELS_PATH`, `OPENCODE_MODELS_URL` -- the latter three
   * each verified to change `opencode models` output), and
   * `PI_CODING_AGENT_DIR` (the per-user pi state root whose auth.json
   * gates which providers pi can list). Known gaps: provider vars with
   * no suffix pattern (e.g. `OLLAMA_HOST`, Vertex location/project vars).
   * Intentionally excludes unrelated caller vars -- PATH, LANG, USER,
   * ... -- so trivial cosmetic differences don't fragment the cache into
   * per-call entries.
   * @param {NodeJS.ProcessEnv} env
   * @returns {string}
   */
  function modelsCacheFingerprint(env = {}) {
    /** @type {string[]} */
    const parts = [];
    for (const name of Object.keys(env)) {
      if (
        name.endsWith("_API_KEY")
        || name.endsWith("_BASE_URL")
        || name === "OPENCODE_CONFIG"
        || name === "OPENCODE_CONFIG_DIR"
        || name === "OPENCODE_CONFIG_CONTENT"
        || name === "OPENCODE_AUTH_CONTENT"
        || name === "OPENCODE_MODELS_PATH"
        || name === "OPENCODE_MODELS_URL"
        || name === "PI_CODING_AGENT_DIR"
      ) {
        parts.push(`${name}=${env[name]}`);
      }
    }
    parts.sort();
    return parts.join("\n");
  }

  /**
   * Validate `model` against opencode's installed-models list, NOT against
   * the dispatch-default executor's list. `summarizeTask()` deliberately
   * hardcodes `opencodeExecutor()` for the actual summary work -- a separate
   * scope boundary from the dispatch-default executor flip -- so a model
   * available in pi but not in opencode (e.g. an opencode-only Zen model
   * like the default `opencode/mimo-v2.5-free`) would silently fail the
   * check on a default pi install. The cached `modelsCache` is shared with
   * the check, so a follow-up dispatch doesn't re-shell-out for the list
   * within the 5-minute TTL.
   *
   * @param {string} model
   * @param {NodeJS.ProcessEnv} env
   */
  async function summaryModelAvailable(model, env) {
    const fingerprint = modelsCacheFingerprint(env);
    let entry = modelsCache.get(fingerprint);
    const now = Date.now();
    if (!entry || now >= entry.expiresAt) {
      let inFlight = modelsCacheInFlight.get(fingerprint);
      if (!inFlight) {
        inFlight = (async () => {
          try {
            const output = await listModelsFn(env);
            const result = { expiresAt: Date.now() + 5 * 60 * 1000, output };
            modelsCache.set(fingerprint, result);
            return result;
          } catch (err) {
            throw new Error(`error: could not list available OpenCode models: ${errMessage(err)}\nhelp: verify that opencode is installed and authenticated, then retry taskferry summary`, { cause: err });
          } finally {
            modelsCacheInFlight.delete(fingerprint);
          }
        })();
        modelsCacheInFlight.set(fingerprint, inFlight);
      }
      await inFlight;
      // The populate either set the cache entry (success) or threw (we
      // never reach this line). The non-null assertion is just to placate
      // TypeScript, which can't track the await-vs-set dependency.
      entry = /** @type {{expiresAt: number, output: string}} */ (modelsCache.get(fingerprint));
    }
    if (!entry.output.split("\n").some((line) => line.trim() === model)) {
      throw new Error(`error: summary model is unavailable: ${model}\nhelp: set TASKFERRY_SUMMARY_MODEL to an installed model, then retry taskferry summary`);
    }
  }

  /** Shared upfront readiness check for both the direct `summary --mode
   * activity` path and `watch --summaries`'s subscribe-time gate: throws the
   * same error `summaryModelAvailable` throws, so a caller can fail fast
   * before doing any work. */
  async function checkSummaryModelReady() {
    const env = summaryEnvironment();
    await summaryModelAvailable(activitySummaryModel, env);
  }

  /**
   * Drives a single secondary-model summary call from the activity cache:
   * spawns the summary child, polls it, extracts the session id and message,
   * and -- when the activity cache had a prior summary session on file and
   * the resulting session id doesn't match it -- retries with a fresh
   * session so the summarize call stays a best-effort feature rather than
   * poisoning the underlying task on a stale-cache or unknown-session-id
   * condition. Returns the model output text and the opencode session id of
   * the call that produced it (for the cache to persist for the next turn).
   *
   * @param {string} taskId
   * @param {number} maxWords
   * @param {string|null} [previousActivity]
   * @returns {Promise<{text: string, sessionId: string|null}>}
   */
  async function summarizeActivity(taskId, maxWords, previousActivity) {
    // Run the model-availability check up front, outside the try/catch below
    // -- that catch exists for the stale-session retry logic (a spawn or poll
    // failure is legitimately best-effort), but a genuine "model unavailable"
    // error must propagate instead of being swallowed into an empty result.
    // This duplicates the same check `summarizeTask()` performs internally
    // further down, but `summaryModelAvailable()` self-memoizes its model
    // list for 5 minutes, so the repeat call is a cache hit, not a second
    // real check.
    await checkSummaryModelReady();
    const continueSessionId = activityCache.getSummarySessionId(taskId);
    try {
      const firstStarted = await summarizeTask(taskId, { maxWords, allowPromptFallback: true, previousActivity, respectConcurrencyReserve: true });
      if (!firstStarted.summaryTask?.id) return { text: "", sessionId: null };
      const firstSettled = await poll(firstStarted.summaryTask.id, { timeoutMs: MAX_WAIT_MS });
      const firstSummaryTask = tasks.get(firstStarted.summaryTask.id);
      const firstSessionId = firstSummaryTask?.sessionId || null;
      const firstDetail = result(firstStarted.summaryTask.id, { fields: ["message"] });
      const firstText = firstSettled.status === "done" && typeof firstDetail.message === "string" ? firstDetail.message : "";

      // No continuation was attempted, or the continuation actually took
      // (opencode honored --session and logged the same session id back):
      // trust the first attempt's output.
      const continuationTook = !continueSessionId || (firstSettled.status === "done" && firstSessionId === continueSessionId);
      if (continuationTook) {
        return { text: firstText, sessionId: firstSessionId };
      }

      // Continuation failed: opencode either rejected the stale session id,
      // silently started a new one, or the summary task crashed before
      // logging any session id. Either way, the prior session id is no
      // longer usable for this source task, so we discard the first attempt's
      // (possibly misleading) output and retry with no continuation. This is
      // best-effort by design -- a summary is an advisory feature, never a
      // hard dependency of the underlying task's status.
      const source = tasks.get(taskId);
      if (!source) return { text: "", sessionId: null };
      // The first attempt may still be running (it hit the poll timeout
      // above rather than settling). Cancel it before launching the retry
      // so both don't occupy a concurrency slot at once.
      if (firstSettled.status === "running") {
        try {
          cancel(firstStarted.summaryTask.id);
        } catch {
          // Settled or gone between the poll timeout and here: both fine.
        }
      }
      const retryStarted = await summarizeTask(taskId, {
        maxWords,
        allowPromptFallback: true,
        previousActivity,
        summarySessionId: null,
        lastSummarizedWatermark: 0,
        respectConcurrencyReserve: true,
      });
      if (!retryStarted.summaryTask?.id) {
        // Both attempts failed to even spawn -- signal the failure so the
        // cache clears the bad session id and retries from scratch later.
        activityCache.clearSummaryState(taskId);
        return { text: "", sessionId: null };
      }
      const retrySettled = await poll(retryStarted.summaryTask.id, { timeoutMs: MAX_WAIT_MS });
      const retrySummaryTask = tasks.get(retryStarted.summaryTask.id);
      const retrySessionId = retrySummaryTask?.sessionId || null;
      if (retrySettled.status !== "done") {
        activityCache.clearSummaryState(taskId);
        return { text: "", sessionId: null };
      }
      const retryDetail = result(retryStarted.summaryTask.id, { fields: ["message"] });
      const retryText = typeof retryDetail.message === "string" ? retryDetail.message : "";
      if (!retryText) activityCache.clearSummaryState(taskId);
      return { text: retryText, sessionId: retrySessionId };
    } catch {
      activityCache.clearSummaryState(taskId);
      return { text: "", sessionId: null };
    }
  }

  /** @param {string} taskId @param {number} maxWords @returns {Promise<object>} */
  async function activitySummary(taskId, maxWords) {
    ensureStateLoaded();
    const source = tasks.get(taskId);
    if (!source) throw noSuchTask(taskId);
    if (!Number.isSafeInteger(maxWords) || maxWords < 75 || maxWords > 300) {
      throw new Error("error: max_words must be an integer from 75 through 300\nhelp: run taskferry summary with max_words between 75 and 300");
    }
    const result = await activityCache.refresh(source, { force: true, includeSummary: activitySummariesEnabled, maxWords });
    if (!result) throw new Error("error: activity summary was not refreshed\nhelp: retry the activity summary request");
    return {
      sourceTaskId: taskId,
      sourceStatus: source.status,
      activity: result.activity,
      outputWatermark: result.outputWatermark,
    };
  }

  /** @param {string} taskId @param {{maxWords?: number, mode?: string, env?: NodeJS.ProcessEnv}} [options] */
  function summarizeRequest(taskId, options = {}) {
    if (options.mode === "activity") return activitySummary(taskId, options.maxWords ?? activityWords);
    return summarizeTask(taskId, options);
  }

  /**
   * @param {string} logPath
   * @returns {{narration: string, sourceLogBytes: number, inputBytes: number}}
   */
  function readNarrationExcerpt(logPath) {
    /** @type {number|undefined} */
    let fd;
    try {
      const size = fs.statSync(logPath).size;
      const firstBytes = size <= SUMMARY_INPUT_BYTES ? size : Math.floor(SUMMARY_INPUT_BYTES / 2);
      const lastBytes = size <= SUMMARY_INPUT_BYTES ? 0 : Math.ceil(SUMMARY_INPUT_BYTES / 2);
      fd = fs.openSync(logPath, "r");
      const first = Buffer.alloc(firstBytes);
      fs.readSync(fd, first, 0, firstBytes, 0);
      const firstRaw = first.toString("utf8");
      let narration = parseNarration(firstRaw);
      let inputRaw = firstRaw;
      if (lastBytes) {
        const last = Buffer.alloc(lastBytes);
        fs.readSync(fd, last, 0, lastBytes, size - lastBytes);
        const omittedBytes = size - firstBytes - lastBytes;
        const lastRaw = last.toString("utf8");
        const omission = `[${omittedBytes} bytes omitted from source log]`;
        narration = [narration, omission, parseNarration(lastRaw)].filter(Boolean).join("\n\n");
        inputRaw += lastRaw;
      }
      return { narration, sourceLogBytes: size, inputBytes: Buffer.byteLength(inputRaw) };
    } catch {
      return { narration: "", sourceLogBytes: 0, inputBytes: 0 };
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  /**
   * @param {string} raw
   * @returns {string}
   */
  function parseNarration(raw) {
    /** @type {Map<string, string[]>} */
    const textByMessageId = new Map();
    /** @type {Array<{kind: "text", mid: string}|{kind: "tool", line: string}>} */
    const order = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      /** @type {any} */
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === "text" && typeof evt.part?.text === "string") {
        const mid = evt.part.messageID;
        if (!textByMessageId.has(mid)) {
          textByMessageId.set(mid, []);
          order.push({ kind: "text", mid });
        }
        /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
      } else if (evt.type === "tool_use" && evt.part?.type === "tool") {
        order.push({ kind: "tool", line: formatToolEventForNarration(evt.part) });
      }
    }
    return order
      .map((entry) => (entry.kind === "text" ? /** @type {string[]} */ (textByMessageId.get(entry.mid)).join("") : entry.line))
      .join("\n\n");
  }

  /**
   * @param {string} taskId
   * @param {{maxWords?: number, allowPromptFallback?: boolean, previousActivity?: string|null, summarySessionId?: string|null, lastSummarizedWatermark?: number|null, respectConcurrencyReserve?: boolean, env?: NodeJS.ProcessEnv}} [options]
   */
  async function summarizeTask(taskId, options = {}) {
    const { maxWords = 200, allowPromptFallback = false, previousActivity = null, respectConcurrencyReserve = false, env } = options;
    // `summarySessionId` and `lastSummarizedWatermark` use `undefined` (not
    // `null`) as the "look it up in the activity cache" sentinel, because the
    // activity path's continue-failure retry needs to *force* a fresh launch
    // by passing `null` explicitly -- a `null` here means "ignore whatever is
    // cached and treat this turn as a brand-new session", while an undefined
    // here means "use the cache's current state for this task."
    const { summarySessionId, lastSummarizedWatermark } = options;
    ensureStateLoaded();
    const source = tasks.get(taskId);
    if (!source) throw noSuchTask(taskId);
    if (!Number.isSafeInteger(maxWords) || maxWords < 75 || maxWords > 300) {
      throw new Error("error: max_words must be an integer from 75 through 300\nhelp: run taskferry summary with max_words between 75 and 300");
    }
    // Only the activity-refresh path (summarizeActivity) opts into this
    // reserve check. A direct `taskferry summary` call is an explicit user
    // request and must always run, even with the reserve full.
    if (respectConcurrencyReserve) {
      const countInFlightSummaries = () => {
        let count = 0;
        for (const t of tasks.values()) {
          if (t.summaryOf && (t.status === "running" || t.status === "queued")) count++;
        }
        return count;
      };
      // At a small concurrencyLimit (e.g. 2, giving a reserve of exactly 1),
      // two tasks finishing within moments of each other would otherwise
      // have the second one's summary dropped outright instead of merely
      // delayed. Retry briefly before giving up -- existing summary tasks
      // typically settle in well under this window.
      const RESERVE_RETRY_ATTEMPTS = 4;
      const RESERVE_RETRY_DELAY_MS = 500;
      for (let attempt = 0; attempt < RESERVE_RETRY_ATTEMPTS; attempt++) {
        if (countInFlightSummaries() < summaryConcurrencyLimit) break;
        if (attempt === RESERVE_RETRY_ATTEMPTS - 1) {
          return {
            sourceTaskId: taskId,
            sourceStatus: source.status,
            summary: "summarizer concurrency reserve is full; skipped this refresh",
            next: `Run taskferry summary with task id "${taskId}" once the summarizer queue drains`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, RESERVE_RETRY_DELAY_MS));
      }
    }
    // Resolve the continuation session id and the last-summarized watermark
    // from the activity cache unless the caller (e.g. the activity path's
    // continue-failure fallback) supplies them explicitly. The direct
    // `taskferry summary` path leaves both undefined and inherits whatever the
    // cache last stored for this task.
    let resolvedSummarySessionId = summarySessionId !== undefined
      ? summarySessionId
      : activityCache.getSummarySessionId(taskId);
    let resolvedWatermark = lastSummarizedWatermark !== undefined && lastSummarizedWatermark !== null
      ? lastSummarizedWatermark
      : activityCache.getLastSummarizedWatermark(taskId);

    let currentSize;
    try {
      currentSize = fs.statSync(source.logPath).size;
    } catch {
      currentSize = 0;
    }
    // If the source log shrank (rotation/truncation) the prior session id and
    // watermark no longer refer to anything readable. Drop them and start the
    // next pass fresh — the only safe interpretation of "watermark is in the
    // future relative to the log."
    if (resolvedWatermark > currentSize) {
      activityCache.clearSummaryState(taskId);
      resolvedSummarySessionId = null;
      resolvedWatermark = 0;
    }

    // Build the input narration. Continuing a session only makes sense if we
    // have new bytes since the last summary; otherwise the model would just
    // re-read the same content it already summarized. Fall back to the bounded
    // head+tail excerpt in every other case (first call, no growth, or a
    // failed-continuation retry that wants the model to see the whole log).
    /** @type {{narration: string, sourceLogBytes: number, inputBytes: number}} */
    let snapshot;
    let isDelta = false;
    if (resolvedSummarySessionId && resolvedWatermark > 0 && currentSize > resolvedWatermark) {
      const delta = readDeltaNarration(source.logPath, resolvedWatermark);
      snapshot = delta;
      isDelta = true;
    } else {
      snapshot = readNarrationExcerpt(source.logPath);
    }
    const capturedAt = new Date().toISOString();
    const sourceStatus = source.status;
    if (!snapshot.narration && !allowPromptFallback) {
      return {
        sourceTaskId: taskId,
        sourceStatus,
        summary: "no model text observed yet",
        help: `Run taskferry tail with task id "${taskId}" after the task emits output`,
      };
    }
    if (!snapshot.narration) {
      const prompt = source.promptPreview || "No model output observed yet.";
      snapshot.narration = `Task prompt: ${prompt}`;
      snapshot.inputBytes = Buffer.byteLength(snapshot.narration);
    }
    // Clone the caller env at request time (same defensive snapshot as
    // dispatch() applies, for the same reason: a queued summary launch
    // must not be vulnerable to post-queue caller mutations of the
    // original env object). The summary env itself -- the daemon's ambient
    // overlay plus the OPENCODE_CONFIG* strip -- is computed at spawn time
    // by startTask() below, mirroring how dispatch() defers
    // dispatchEnvironment() until spawn so the spawned summary child sees
    // the daemon's current process.env, not a request-time snapshot.
    const queuedCallerEnv = env === undefined ? undefined : { ...env };
    await summaryModelAvailable(activitySummaryModel, queuedCallerEnv ?? {});

    // Task IDs retain the literal "oc_" prefix for compatibility; WorkerExecutor.taskIdPrefix is not wired in this issue.
    const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const logPath = path.join(LOG_DIR, `${id}.ndjson`);
    const snapshotPath = path.join(SUMMARY_DIR, `${id}.json`);
    /** @type {SummaryOf} */
    const summaryOf = {
      sourceTaskId: taskId,
      sourceStatus,
      capturedAt,
      sourceLogBytes: snapshot.sourceLogBytes,
      summaryInputBytes: snapshot.inputBytes,
      maxWords,
    };
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({
        source: { id: taskId, status: sourceStatus, promptPreview: source.promptPreview, capturedAt },
        narration: snapshot.narration,
        ...(previousActivity ? { previous_summary: previousActivity } : {}),
        ...(isDelta ? { narration_is_delta: true } : {}),
      }, null, 2),
      { mode: 0o600, flag: "wx" }
    );
    /** @type {Task} */
    const task = {
      id,
      status: "queued",
      directory: fs.realpathSync(SUMMARY_DIR),
      model: activitySummaryModel,
      executorId: "opencode", // summaries stay opencode-only in this issue -- see plan Verified Findings #10
      variant: null,
      sessionId: null,
      originSessionId: null,
      pid: null,
      startedAt: capturedAt,
      endedAt: null,
      exitCode: null,
      signal: null,
      logPath,
      promptPreview: "Summarize the attached task transcript.",
      promptTotalChars: null,
      spawnError: null,
      cancelRequested: false,
      internal: true,
      failureReason: null,
      failureDetail: null,
      summaryOf,
    };
    tasks.set(id, task);
    persistTask(task.id);
    pendingLaunches.set(id, {
      kind: "summary",
      model: activitySummaryModel,
      snapshotPath,
      env: queuedCallerEnv,
      executor: opencodeExecutor(),
      ...(resolvedSummarySessionId ? { summarySessionId: resolvedSummarySessionId } : {}),
    });
    launchQueue.push(id);
    launchQueuedTasks();
    return {
      sourceTaskId: taskId,
      sourceStatus,
      capturedAt,
      sourceLogBytes: snapshot.sourceLogBytes,
      summaryInputBytes: snapshot.inputBytes,
      summaryTask: { id, status: task.status, model: task.model },
      next: `Run taskferry wait with task id "${id}", then taskferry result with task id "${id}"`,
    };
  }

  function launchQueuedTasks() {
    if (launchTimer) {
      clearTimeout(launchTimer);
      launchTimer = null;
    }
    const now = Date.now();
    while (launchTimes.length && launchTimes[0] <= now - dispatchWindow) launchTimes.shift();

    while (launchQueue.length && launchTimes.length < dispatchLimit && runningCount < concurrencyLimit) {
      const id = /** @type {string} */ (launchQueue.shift());
      const task = tasks.get(id);
      if (!task || task.status !== "queued") continue;
      launchTimes.push(Date.now());
      startTask(task);
    }

    if (launchQueue.length && !launchTimer) {
      const rateDelay = launchTimes.length >= dispatchLimit ? launchTimes[0] + dispatchWindow - Date.now() : 0;
      const concurrencyDelay = runningCount >= concurrencyLimit ? 250 : 0;
      launchTimer = setTimeout(launchQueuedTasks, Math.max(1, rateDelay, concurrencyDelay));
    }
  }

  /** @param {Task} task */
  function startTask(task) {
    const launch = pendingLaunches.get(task.id);
    pendingLaunches.delete(task.id);
    if (!launch) return;

    const isSummary = launch.kind === "summary";
    const summaryLaunch = /** @type {SummaryLaunch} */ (launch);
    const dispatchLaunch = /** @type {DispatchLaunch} */ (launch);
    const executor = launch.executor;
    const launchDirectory = isSummary ? SUMMARY_DIR : dispatchLaunch.directory;
    // A prompt over PROMPT_ARGV_SAFE_BYTES can't survive as a single argv
    // element (issue #78: `spawn E2BIG`). Route it through a prompt file
    // instead -- the executor's buildSpawnArgs attaches it however that
    // executor's CLI expects (opencode: `-f`; pi: a positional `@path`).
    const promptFilePath = !isSummary && Buffer.byteLength(dispatchLaunch.prompt, "utf8") > PROMPT_ARGV_SAFE_BYTES
      ? path.join(PROMPT_DIR, `${task.id}.prompt.txt`)
      : null;
    const args = executor.buildSpawnArgs({
      isSummary,
      model: isSummary ? summaryLaunch.model : dispatchLaunch.model,
      variant: isSummary ? undefined : dispatchLaunch.variant,
      launchDirectory,
      promptFilePath,
      snapshotPath: isSummary ? summaryLaunch.snapshotPath : undefined,
      prompt: isSummary ? "" : dispatchLaunch.prompt,
      sessionId: isSummary ? summaryLaunch.summarySessionId ?? null : dispatchLaunch.sessionId ?? null,
    });

    const cleanUpScratchFiles = () => {
      if (isSummary && summaryLaunch.snapshotPath) {
        try {
          fs.unlinkSync(summaryLaunch.snapshotPath);
        } catch (err) {
          if (errCode(err) !== "ENOENT") throw err;
        }
      }
      if (promptFilePath) {
        try {
          fs.unlinkSync(promptFilePath);
        } catch (err) {
          if (errCode(err) !== "ENOENT") throw err;
        }
      }
    };

    let logFd;
    let child;
    try {
      if (promptFilePath) fs.writeFileSync(promptFilePath, dispatchLaunch.prompt, { mode: 0o600, flag: "wx" });
      logFd = fs.openSync(task.logPath, "a", 0o600);
      fs.chmodSync(task.logPath, 0o600);
      let spawnEnv = isSummary ? summaryEnvironment(summaryLaunch.env) : dispatchEnvironment(dispatchLaunch.env);
      const noSandbox = !isSummary && dispatchLaunch.noSandbox === true;
      let spawnCommand = executor.binaryName;
      let spawnArgs = args;
      // Summary/report children never get an overlay -- they don't write
      // to the target directory in any sense the changeset model cares
      // about, so the plain v1 bind is correct and unchanged for them.
      const role = isSummary ? null : (dispatchLaunch.role ?? "dispatch");
      // Review finding #5 (dispatch-launch side): overlay-gating lives inside
      // the bwrap block below, so when sandboxing is force-disabled
      // (--no-sandbox / TASKFERRY_DISABLE_SANDBOX=1) or unsupported on this
      // platform (non-Linux) an advisor would silently launch with a plain
      // writable bind on the target -- a path to persist a write,
      // contradicting ADR 0001's "an advisor has no path to persist a write."
      // Fail closed at dispatch-launch time, mirroring the overlay-disabled
      // check inside the sandbox block below, instead of degrading to
      // unsandboxed writes.
      if (role === "advisor" && !(sandboxEnabled && !noSandbox && platformSupportsSandbox(platform))) {
        throw new Error(
          "error: advisor dispatch requires overlay-gated writes, but the sandbox is unavailable\n" +
          "help: advisor writes must be gated by a copy-on-write overlay (docs/adr/0001-cow-overlays-and-diff-gated-writes.md), which requires the bwrap sandbox -- unset TASKFERRY_DISABLE_SANDBOX (or drop --no-sandbox) and run on a supported platform with bubblewrap >= 0.8"
        );
      }
      if (sandboxEnabled && !noSandbox && platformSupportsSandbox(platform)) {
        requireBwrap();
        spawnCommand = "bwrap";
        const homeDir = os.homedir();
        // bwrap's --tmpfs fails ("Read-only file system") if the mount point
        // doesn't already exist under the --ro-bind / / root, so any
        // deny-list entry the user simply doesn't have (e.g. no ~/.aws) must
        // be dropped before it reaches buildBwrapArgs, not passed through.
        const denyList = defaultDenyList(homeDir, stateDir).filter(existsFn);
        // The executor decides which env var overrides point at its
        // sandboxed data home (opencode: XDG_DATA_HOME; pi:
        // PI_CODING_AGENT_DIR) and which destination to ro-bind the real
        // auth file into, so each executor's bound auth destination matches
        // its own environment directory. Threading the dispatch's
        // sessionId + launchDirectory through lets pi scope any sessions
        // bind to just the resumed session's file -- a worker can write
        // its own session, but not touch every other session in the
        // user's pi history.
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
        // A git worktree's real gitdir (objects/refs it shares with the main
        // checkout, plus its own HEAD/index) lives outside `launchDirectory`
        // and is otherwise invisible to the read-write bind on it alone --
        // without this, `git commit` inside the sandbox fails read-only.
        /** @type {string[]} */
        const extraRwBinds = [];
        // The root filesystem is read-only bound by default, so the
        // executor's real-disk data home (cacheDir, not the tmpfs runtime
        // dir -- see resolveCacheDir) needs an explicit read-write bind.
        // bwrap requires the source to already exist, hence the mkdir here
        // rather than leaving it for the sandboxed process to create.
        fs.mkdirSync(sandboxedDataHome, { recursive: true, mode: 0o700 });
        extraRwBinds.push(sandboxedDataHome);

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
          task.overlayDirs = { ...overlayInfo, tmpRoot: overlayTmpRoot, rwBinds: overlayRwBinds };
          task.changesetStatus = "pending";
          task.preDispatchHead = resolvePreDispatchHead(launchDirectory, runOverlayCommandFn);
        }
      }
      // No tmux: the child has no shared session to introspect. It is its own
      // process group so cancellation can stop any subprocesses it creates.
      // stdout is normalized line-by-line through executor.normalizeLogEvent
      // before it reaches the log file, so every downstream reader
      // (readNarration, classifyProviderFailure, activity.js, ...) keeps
      // seeing exactly taskferry's canonical NDJSON shape regardless of
      // which executor produced it. stderr is unaffected -- it still writes
      // straight to the log fd (logFd, passed to stdio[2] below), so crash
      // dumps and unparseable noise land in the log unfiltered, same as
      // before this change. Non-JSON stdout lines (e.g. pi's plain-text
      // auth failure text "No API key found for openai.") are preserved
      // verbatim -- they bypass normalizeLogEvent entirely so a child that
      // emits no parseable JSON events and exits 0 still leaves
      // classifyProviderFailure something to classify (issue #94).
      child = spawnFn(spawnCommand, spawnArgs, {
        cwd: launchDirectory,
        stdio: ["ignore", "pipe", logFd],
        detached: true,
        env: spawnEnv,
      });
      // Capture the fd so the stdout handler can keep writing to it until
      // the child exits; closing it here (as the pre-refactor code did)
      // would break the handler's fs.writeSync before the child has a
      // chance to drain.
      const capturedLogFd = logFd;
      /** @type {string} */
      let stdoutCarry = "";
      // stdio[1] = "pipe" guarantees stdout is non-null for the real
      // child_process.ChildProcess. Test fakes also expose a stdout
      // EventEmitter via fakeChild().
      const childStdout = /** @type {import("node:stream").Readable} */ (child.stdout);
      // Single normalization helper used by both the inline (.on("data"))
      // and trailing-fragment (.on("end")) paths. A throw out of an
      // EventEmitter callback is an unhandled exception -- it propagates
      // up the synchronous emit and crashes the daemon, which orphans
      // every child. Catching the throw here turns "daemon crash" into
      // "task settles with a structured failure reason" by:
      //   1. Writing a canonical taskferry `type:"error"` event with a
      //      stable error class name (`ExecutorNormalizationError`) and
      //      the thrown message so classifyProviderFailure can see it
      //      on the trailing-log path and produce an executor-prefixed
      //      bucket (the structured-error fallthrough branch).
      //   2. Preserving the original line as the error detail so the
      //      diagnostic retains what came off the wire.
      // We do not silently swallow: the error event is observable in
      // the log and the task's failureReason is set by the existing
      // watcher/exit lifecycle. The errorBucketPrefix is read off the
      // executor object captured in this scope (same source as the
      // spawn-time executorId), keeping the structured-error prefix
      // contract identical to every other structured error the
      // classifier sees.
      /**
       * @param {unknown} parsed
       * @param {string} rawLine
       */
      const normalizeAndWrite = (parsed, rawLine) => {
        let normalized;
        try {
          normalized = executor.normalizeLogEvent(parsed);
        } catch (err) {
          const message = errMessage(err);
          const errorEvent = {
            type: "error",
            message: `executor.normalizeLogEvent threw: ${message}`,
            error: {
              name: "ExecutorNormalizationError",
              data: { message, raw: rawLine },
            },
          };
          try {
            fs.writeSync(capturedLogFd, `${JSON.stringify(errorEvent)}\n`);
          } catch {
            // Log fd closed out from under us (task already settled /
            // cleaned up) -- drop the trailing write rather than crash
            // the handler.
          }
          return;
        }
        if (normalized == null) return;
        try {
          fs.writeSync(capturedLogFd, `${JSON.stringify(normalized)}\n`);
        } catch {
          // Log fd closed out from under us (task already settled /
          // cleaned up) -- drop the trailing write rather than crash
          // the handler.
        }
      };
      childStdout.on("data", (chunk) => {
        stdoutCarry += chunk.toString("utf8");
        let nl;
        while ((nl = stdoutCarry.indexOf("\n")) !== -1) {
          const line = stdoutCarry.slice(0, nl);
          stdoutCarry = stdoutCarry.slice(nl + 1);
          if (!line.trim()) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Non-JSON stdout -- preserve verbatim so a non-event-emitting
            // provider (e.g. pi on a missing API key) still has its text
            // routed through classifyProviderFailure. Drop the parsed
            // event classification on the floor: there is no executor
            // event shape to apply, and the line's text is what we need.
            try {
              fs.writeSync(capturedLogFd, `${line}\n`);
            } catch {
              // Log fd closed out from under us (task already settled /
              // cleaned up) -- drop the trailing write rather than crash
              // the handler.
            }
            continue;
          }
          normalizeAndWrite(parsed, line);
        }
      });
      childStdout.on("end", () => {
        const tail = stdoutCarry;
        stdoutCarry = "";
        if (!tail.trim()) return;
        let parsed;
        try {
          parsed = JSON.parse(tail);
        } catch {
          // Trailing partial / malformed line at process end -- preserve
          // verbatim for the same reason as the inline branch above.
          try {
            fs.writeSync(capturedLogFd, `${tail}\n`);
          } catch {
            // Same as the inline branch: fd may already be closed.
          }
          return;
        }
        normalizeAndWrite(parsed, tail);
      });
      let settled = false;
      const finishSettlement = () => {
        try {
          persistTask(task.id);
        } catch {
          // In-memory child settlement is authoritative; a failed best-effort
          // state write must not strand the concurrency slot.
        }
        // Prune the activity cache only after the terminal snapshot above has
        // had a chance to land, so `watch --summaries` still sees the final
        // status transition instead of a cache miss.
        void scheduleActivity(task, { force: true }).then(() => activityCache.evictTask(task.id));
        logHasEventCache.delete(task.logPath);
        try {
          cleanUpScratchFiles();
        } catch (err) {
          // EBUSY/EACCES unlink failures during scratch cleanup must not
          // throw from this child exit handler: no uncaughtException handler
          // upstream, so an unhandled throw crashes the daemon and orphans
          // every other in-flight task.
          console.error(`taskferry: failed to clean up scratch files for task ${task.id}: ${errMessage(err)}`);
        } finally {
          runningCount--;
          settleWaiters(task.id);
          launchQueuedTasks();
        }
      };

      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        // The stdout handler and stderr (wired through stdio[2] -> logFd)
        // share this fd; close it now that nothing else can write.
        try {
          fs.closeSync(capturedLogFd);
        } catch {
          // Already closed (e.g. concurrent exit/error path), or the fd
          // table entry is gone -- nothing to clean up.
        }
        const timer = escalationTimers.get(task.id);
        if (timer) {
          clearTimeout(timer);
          escalationTimers.delete(task.id);
        }
        classifyTrailingLogFailure(task);
        stopRunningWatcher(task.id);
        // A watchdog-killed child (task.failureReason already set) can still exit
        // 0/unsignaled if it traps SIGTERM and shuts down gracefully -- don't let
        // that read as "done" and bury the failureReason behind a healthy status.
        task.status = task.cancelRequested ? "cancelled" : task.failureReason ? "crashed" : code === 0 && !signal ? "done" : "crashed";
        task.exitCode = code;
        task.signal = signal;
        task.endedAt = new Date().toISOString();
        const parsedSessionId = readSessionIdFromLog(task.logPath);
        if (parsedSessionId) task.sessionId = parsedSessionId;
        if (task.status === "done") evaluateOutputCompleteness(task);
        if (task.status === "done" || task.status === "crashed" || task.status === "cancelled") extractChangesetForTask(task);
        // Persist the opencode session id of a successful summary child so the
        // next summarize turn can resume the same prompt-cached conversation
        // via `--continue --session <id>`, and stamp the watermark so the next
        // turn only re-sends narration from this point on. Applies to both the
        // activity-cache path (`watch --summaries`) and the direct
        // `taskferry summary` path -- they share this exit handler, so the
        // direct path gets session continuity for free too.
        if (task.summaryOf && task.status === "done" && parsedSessionId) {
          activityCache.setSummarySessionId(task.summaryOf.sourceTaskId, parsedSessionId);
          const source = tasks.get(task.summaryOf.sourceTaskId);
          if (source) {
            try {
              const size = fs.statSync(source.logPath).size;
              activityCache.setLastSummarizedWatermark(task.summaryOf.sourceTaskId, size);
            } catch {
              // Source log unreadable at settlement time (rotated or deleted).
              // The next summarize call's watermark-vs-size check in
              // summarizeTask() will detect the inconsistency and clear the
              // cache state, so leaving the existing watermark in place is
              // safe.
            }
          }
        }
        finishSettlement();
      });

      child.on("error", (err) => {
        stopRunningWatcher(task.id);
        if (settled) return;
        settled = true;
        // Mirrors the exit handler: the stdout handler shares this fd and
        // stops writing once settled; close it so the OS doesn't keep an
        // entry on its fd table for a task that's about to settle.
        try {
          fs.closeSync(capturedLogFd);
        } catch {
          // Already closed or gone -- nothing to clean up.
        }
        task.status = "crashed";
        task.spawnError = errMessage(err);
        task.endedAt = new Date().toISOString();
        // Spawn failure (e.g. ENOENT) lands here AFTER the sandbox/overlay
        // block already ran: overlayDirs is set, changesetStatus is still
        // "pending", and the overlay would otherwise sit on disk with no
        // extraction ever booked against it. Run the same extraction/cleanup
        // path the exit handler does so the task isn't stranded (review
        // finding -- spawn-failure path missed the cleanup the exit path
        // already does). extractChangesetForTask is internally error-safe
        // (extract+failure paths both go through its own try/catch) and
        // handles an empty overlay the same way the exit path does: no
        // diff produced, status moves to "accepted" (or "rejected" for an
        // advisor), overlayDirs cleared.
        extractChangesetForTask(task);
        finishSettlement();
      });

      task.status = "running";
      task.pid = child.pid ?? null;
      runningCount++;
      persistTask(task.id);
      scheduleActivity(task, { force: true });
      startRunningWatcher(task);
      child.unref();
    } catch (err) {
      if (logFd != null) fs.closeSync(logFd);
      task.status = "crashed";
      task.spawnError = errMessage(err);
      task.endedAt = new Date().toISOString();
      if (child?.pid != null) sendSignal(child.pid, "SIGKILL");
      persistTask(task.id);
      void scheduleActivity(task, { force: true }).then(() => activityCache.evictTask(task.id));
      logHasEventCache.delete(task.logPath);
      try {
        cleanUpScratchFiles();
      } catch (cleanupErr) {
        // Same reasoning as finishSettlement()'s cleanUpScratchFiles() guard
        // above: a non-ENOENT unlink failure here must not throw out of this
        // spawn-failure catch block, which would crash the daemon the same
        // way an unguarded call in the exit handler would.
        console.error(`taskferry: failed to clean up scratch files for task ${task.id}: ${errMessage(cleanupErr)}`);
      }
      settleWaiters(task.id);
    }
  }

  /**
   * @param {string} taskId
   * @param {{graceMs?: number}} [options]
   * @returns {TaskSummary & {note: string}}
   */
  function cancel(taskId, { graceMs = cancelGrace } = {}) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.status === "queued") {
      const index = launchQueue.indexOf(taskId);
      if (index !== -1) launchQueue.splice(index, 1);
      const launch = pendingLaunches.get(taskId);
      pendingLaunches.delete(taskId);
      if (launch?.snapshotPath) {
        try {
          fs.unlinkSync(launch.snapshotPath);
        } catch (err) {
          if (errCode(err) !== "ENOENT") throw err;
        }
      }
      task.status = "cancelled";
      task.endedAt = new Date().toISOString();
      persistTask(task.id);
      void scheduleActivity(task, { force: true }).then(() => activityCache.evictTask(task.id));
      logHasEventCache.delete(task.logPath);
      settleWaiters(taskId);
      if (!launchQueue.length && launchTimer) {
        clearTimeout(launchTimer);
        launchTimer = null;
      }
      return { ...summarize(task), note: "queued task cancelled before launch" };
    }
    if (task.status !== "running") {
      return { ...summarize(task), note: `task is already ${task.status}; nothing to cancel` };
    }
    if (task.pid == null) {
      throw new Error(`error: task ${taskId} has no pid on record; cannot signal it\nhelp: run taskferry status to inspect its recorded state`);
    }

    task.cancelRequested = true;
    // Don't clobber a failureReason the watchdog already set (e.g. it fired
    // a provider failure bucket such as rate_limited just before this
    // cancel() call arrived) --
    // failureReason starts null at task creation, so leaving it alone here
    // preserves that diagnostic instead of erasing it under "cancelled".
    stopRunningWatcher(taskId);
    const existingTimer = escalationTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      escalationTimers.delete(taskId);
    }
    sendSignal(task.pid, "SIGTERM");

    const timer = setTimeout(() => {
      escalationTimers.delete(taskId);
      if (tasks.get(taskId)?.status === "running") {
        sendSignal(/** @type {number} */ (task.pid), "SIGKILL");
      }
    }, graceMs);
    escalationTimers.set(taskId, timer);
    persistTask(task.id);

    return { ...summarize(task), note: `SIGTERM sent to process group ${task.pid}; escalates to SIGKILL after ${graceMs}ms if it hasn't exited` };
  }

  /** @param {Task} task */
  function hasLiveOverlay(task) {
    return task.overlayDirs != null && existsFn(task.overlayDirs.upperDir);
  }

  /**
   * @param {string} taskId
   * @returns {{taskId: string, changesetStatus: string, applied: boolean, reason?: string|null, cleanupFailed?: boolean}}
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
    // The diff file lives under stateDir; a partial cleanup (or a tampered
    // tasks.json) can leave a recorded diffPath whose file is gone. Fail
    // with a clear error instead of letting git apply surface its own
    // misleading "can't open patch" message against a path the user has no
    // reason to suspect.
    if (!existsFn(task.diffPath)) {
      throw new Error(
        `error: task ${taskId}'s diff file at ${task.diffPath} no longer exists\n` +
        `help: the state directory may have been partially cleaned; a pending changeset cannot be applied without its diff. Use "taskferry reject ${taskId}" to discard the pending state, or restore the diff file at the recorded path before retrying.`
      );
    }
    const isGitTarget = task.preDispatchHead != null;
    if (!isGitTarget && !hasLiveOverlay(task)) {
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
      diffPath: task.diffPath,
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
    // Persist before cleanup: a crash between apply and persist would leave
    // the task reading as "pending" after a restart even though the patch
    // was already applied, risking a double-apply on the next accept()
    // retry. The cleanup may still fail (review finding #11), but that
    // failure surfaces in the return value and overlayDirs stays set so the
    // daemon-startup sweep (Task 12) retries the removal.
    persistTask(task.id);
    const cleanupFailed = releaseOverlay(task);
    return { taskId, changesetStatus: task.changesetStatus, applied: true, ...(cleanupFailed ? { cleanupFailed: true } : {}) };
  }

  /**
   * @param {string} taskId
   * @returns {{taskId: string, changesetStatus: string, cleanupFailed?: boolean}}
   */
  function reject(taskId) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.changesetStatus !== "pending") {
      throw new Error(`error: task ${taskId} has no pending changeset (changesetStatus: ${task.changesetStatus ?? "none"})\nhelp: only a task with changesetStatus "pending" can be rejected`);
    }
    task.changesetStatus = "rejected";
    // Persist before cleanup (parallel to accept()'s fix): the status is
    // the committed outcome, the cleanup is the side effect. A crash
    // between cleanup and persist would leave the task reading as
    // "pending" after a restart; the next reject() would re-run the
    // cleanup (idempotent -- rm -rf on a missing path is fine) and then
    // persist, so the pre-fix order is benign for reject(); matching
    // accept()'s order keeps the two paths consistent.
    persistTask(task.id);
    const cleanupFailed = releaseOverlay(task);
    return { taskId, changesetStatus: task.changesetStatus, ...(cleanupFailed ? { cleanupFailed: true } : {}) };
  }

  /** @param {string} taskId */
  function stopRunningWatcher(taskId) {
    const timer = runningWatchers.get(taskId);
    if (timer) {
      clearInterval(timer);
      runningWatchers.delete(taskId);
    }
    runningWatcherState.delete(taskId);
  }

  // Forces a running task to stop for a reason other than user cancellation
  // (watchdog timeout, or provider-exhaustion detection added in Task 6).
  // Mirrors cancel()'s SIGTERM-then-SIGKILL escalation, but records
  // failureReason instead of cancelRequested so the exit handler's status
  // computation (unchanged) still lands on "crashed", distinguishable from a
  // user-requested "cancelled".
  /**
   * @param {Task} task
   * @param {string} failureReason
   * @param {string} [failureDetail]
   */
  function failRunningTask(task, failureReason, failureDetail) {
    if (task.failureReason) return; // already stopping this task
    task.failureReason = failureReason;
    task.failureDetail = failureDetail ?? null;
    stopRunningWatcher(task.id);
    try {
      persistTask(task.id);
    } catch (err) {
      // The child still needs stopping if the state directory became unwritable.
      console.error(`taskferry: failed to persist failing task ${task.id}: ${errMessage(err)}`);
    }
    sendSignal(/** @type {number} */ (task.pid), "SIGTERM");
    const timer = setTimeout(() => {
      escalationTimers.delete(task.id);
      if (tasks.get(task.id)?.status === "running") sendSignal(/** @type {number} */ (task.pid), "SIGKILL");
    }, watchdogGrace);
    escalationTimers.set(task.id, timer);
  }

  // classifyProviderFailure() only ever runs from the watcher's interval
  // tick, so a provider-error event that lands after the last tick but
  // before/at process exit would otherwise never be classified and silently
  // lose the failureReason (issue #81). Rather than re-read the whole log from
  // scratch (the cost startRunningWatcher's incremental byte-offset
  // reader exists to avoid), only the bytes the watcher hadn't seen yet
  // are read here, concatenated with whatever partial line the watcher
  // was still carrying -- which is empty when the watcher had been
  // keeping up, and the whole file otherwise.
  /** @param {Task} task */
  function classifyTrailingLogFailure(task) {
    if (task.failureReason) return; // watcher already classified this task
    const watcherState = runningWatcherState.get(task.id);
    /** @type {number} */
    let bytesRead = watcherState?.bytesRead ?? 0;
    const carry = watcherState?.carry ?? "";
    /** @type {number} */
    let size;
    try {
      size = fs.statSync(task.logPath).size;
    } catch {
      return; // log never created or already gone; nothing to classify
    }
    if (size < bytesRead) bytesRead = 0; // log shrank out from under the watcher; rescan
    if (size === bytesRead && !carry) return; // watcher saw everything
    let text = carry;
    if (size > bytesRead) {
      const chunkSize = size - bytesRead;
      const buf = Buffer.alloc(chunkSize);
      const fd = fs.openSync(task.logPath, "r");
      try {
        fs.readSync(fd, buf, 0, chunkSize, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
      text += buf.toString("utf8");
    }
    if (!text) return; // nothing to classify
    const errorBucketPrefix = resolveExecutor(task.executorId).errorBucketPrefix;
    const { failure } = classifyProviderFailure(text.split("\n"), errorBucketPrefix);
    if (failure) {
      task.failureReason = failure.bucket;
      task.failureDetail = failure.detail;
    }
  }

  /** @param {Task} task */
  function startRunningWatcher(task) {
    let lastActivityMs = Date.now();
    // Tracks how much of the log this watcher has already scanned, so each
    // tick reads and regexes only the bytes appended since the last one
    // instead of the whole file (O(1) amortized per tick, not O(n) per tick
    // / O(n²) over a long-running task). `carry` holds a trailing partial
    // line from the previous read until it's completed by the next chunk.
    let bytesRead = 0;
    let carry = "";
    runningWatcherState.set(task.id, { get bytesRead() { return bytesRead; }, get carry() { return carry; } });
    // Two-phase no-output budget:
    //   - Before the task has produced any parseable log event, the watcher
    //     compares against `noOutputTimeout`. A task that is silent from the
    //     start is most likely genuinely wedged (bad spawn, auth failure,
    //     provider hang) and should die fast.
    //   - The moment the watcher sees its first parseable JSON line in the
    //     log, the latch flips and the deadline jumps to
    //     `postOutputNoOutputTimeout` for the rest of the task's life.
    //     Silence after real work is far more likely a long generation
    //     (opencode writes step-level events, not token deltas, so a long
    //     final answer can produce zero log lines for minutes) than a hang.
    let outputSeen = false;
    let currentNoOutputTimeout = noOutputTimeout;
    const timer = setInterval(() => {
      const current = tasks.get(task.id);
      if (!current || current.status !== "running") {
        stopRunningWatcher(task.id);
        return;
      }
      try {
        const size = fs.statSync(current.logPath).size;
        if (size < bytesRead) {
          // Log shrank or was replaced out from under us; rescan from scratch.
          bytesRead = 0;
          carry = "";
        }
        if (size > bytesRead) {
          const chunkSize = size - bytesRead;
          const buf = Buffer.alloc(chunkSize);
          const fd = fs.openSync(current.logPath, "r");
          try {
            fs.readSync(fd, buf, 0, chunkSize, bytesRead);
          } finally {
            fs.closeSync(fd);
          }
          bytesRead = size;
          const text = carry + buf.toString("utf8");
          const lines = text.split("\n");
          carry = lines.pop() ?? "";
          const errorBucketPrefix = resolveExecutor(current.executorId).errorBucketPrefix;
          const linesResult = classifyProviderFailure(lines, errorBucketPrefix);
          const carryResult = !linesResult.failure && carry && !carry.trimStart().startsWith("{")
            ? classifyProviderFailure([carry], errorBucketPrefix)
            : null;
          const providerFailure = linesResult.failure ?? carryResult?.failure ?? null;
          if (providerFailure) {
            failRunningTask(current, providerFailure.bucket, providerFailure.detail);
            return;
          }
          if (linesResult.hasParseableLine) {
            lastActivityMs = Date.now();
            // Latch the budget escalation: once any parseable JSON line has
            // landed for this task, every subsequent tick compares against
            // `postOutputNoOutputTimeout` regardless of how much later silence
            // follows. This is the only assignment to either flag/variable
            // outside their initializers, so the latch is unconditional.
            if (!outputSeen) {
              outputSeen = true;
              currentNoOutputTimeout = postOutputNoOutputTimeout;
            }
          }
          void scheduleActivity(current);
        }
      } catch {
        // A rotated or removed log is retried on the next watcher tick.
      }
      if (Date.now() - lastActivityMs >= currentNoOutputTimeout) {
        failRunningTask(current, "no_output_timeout", `no output for ${currentNoOutputTimeout}ms (${outputSeen ? "post-output" : "pre-output"} timeout)`);
      }
    }, watchdogPoll);
    // Same as child.unref() in startTask: the watchdog is a background
    // observer, not something that should pin the server's event loop alive.
    // An unref'd interval still fires while the loop is otherwise busy, but
    // lets the process exit if nothing else (real work, child subprocesses,
    // waiters) is keeping it alive -- e.g. tests that cancel a task without
    // firing an 'exit' event.
    timer.unref();
    runningWatchers.set(task.id, timer);
  }

  // Targets the process group (negative pid), which reaches opencode and any
  // subprocess it spawned (e.g. a bash command it's mid-way through running),
  // since dispatch() makes the child a process group leader for exactly this.
  // Falls back to the plain pid if group signaling isn't available (ESRCH on
  // -pid can mean the group is already gone even though a stray pid isn't,
  // though in practice these move together since detached: true makes them
  // the same process).
  /**
   * @param {number} pid
   * @param {NodeJS.Signals} signal
   */
  function sendSignal(pid, signal) {
    try {
      killFn(-pid, signal);
      return;
    } catch (err) {
      if (errCode(err) !== "ESRCH") throw err;
    }
    try {
      killFn(pid, signal);
    } catch (err) {
      if (errCode(err) !== "ESRCH") throw err;
    }
  }

  // Distinguishes "opencode never wrote a byte" (still starting up, or stuck
  // before its first event -- e.g. hung on a usage-limit retry) from "wrote
  // bytes but no parseable event yet" from "at least one event landed". A
  // caller polling taskferry status on a task that's been "running" for a
  // long time can use this to tell a genuinely stuck process apart from one
  // that's just slow, without waiting out a full taskferry wait timeout.
  const LOG_ACTIVITY_SCAN_BYTES = 64 * 1024;
  // A log is append-only, so once a parseable event has landed it's there
  // for good -- cache that fact per log file so a task polled repeatedly
  // while running doesn't pay the open+read+line-by-line-JSON.parse cost on
  // every single status() call after its first event, just the stat.
  /** @type {Set<string>} */
  const logHasEventCache = new Set();
  /**
   * @param {string} logPath
   * @returns {LogActivity}
   */
  function logActivity(logPath) {
    /** @type {fs.Stats|undefined} */
    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch {
      return { logBytesWritten: 0, logLastWriteAt: null, logHasEvent: false };
    }
    if (logHasEventCache.has(logPath)) {
      return { logBytesWritten: stat.size, logLastWriteAt: stat.mtime.toISOString(), logHasEvent: true };
    }
    let hasEvent = false;
    if (stat.size > 0) {
      /** @type {number|undefined} */
      let fd;
      try {
        const bytes = Math.min(stat.size, LOG_ACTIVITY_SCAN_BYTES);
        const buffer = Buffer.alloc(bytes);
        fd = fs.openSync(logPath, "r");
        fs.readSync(fd, buffer, 0, bytes, 0);
        for (const line of buffer.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line);
            hasEvent = true;
            break;
          } catch {
            continue;
          }
        }
      } catch {
        hasEvent = false;
      } finally {
        if (fd != null) fs.closeSync(fd);
      }
    }
    if (hasEvent) logHasEventCache.add(logPath);
    return { logBytesWritten: stat.size, logLastWriteAt: stat.mtime.toISOString(), logHasEvent: hasEvent };
  }

  /**
   * @param {string} taskId
   * @returns {TaskStatus}
   */
  function status(taskId) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    return { ...summarize(task), ...logActivity(task.logPath) };
  }

  /**
   * @param {string} taskId
   * @returns {string}
   */
  function taskDirectory(taskId) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    return task.directory;
  }

  /**
   * @param {string} taskId
   * @param {{timeoutMs?: number, tailChars?: number}} [options]
   * @returns {Promise<TaskStatus>}
   */
  function poll(taskId, { timeoutMs, tailChars } = {}) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (task.status !== "running" && task.status !== "queued") {
      return Promise.resolve(summarize(task));
    }
    return new Promise((resolve) => {
      const settle = (timedOut = false) => {
        const list = waiters.get(taskId);
        if (list) {
          const idx = list.indexOf(settle);
          if (idx !== -1) list.splice(idx, 1);
        }
        if (timer) clearTimeout(timer);
        const current = /** @type {Task} */ (tasks.get(taskId));
        const summary = summarize(current);
        if (!timedOut || current.status !== "running" || tailChars == null) {
          resolve(timedOut ? { ...summary, timedOut: true } : summary);
          return;
        }
        const output = readNarration(current.logPath);
        resolve({
          ...summary,
          timedOut: true,
          outputTail: output.slice(-tailChars),
          outputTailTotalChars: output.length,
          outputTailTruncated: output.length > tailChars,
        });
      };
      const timer = timeoutMs != null ? setTimeout(() => settle(true), timeoutMs) : undefined;
      if (!waiters.has(taskId)) waiters.set(taskId, []);
      /** @type {Array<(timedOut?: boolean) => void>} */ (waiters.get(taskId)).push(settle);
    });
  }

  /**
   * @param {object} [params]
   * @param {string} [params.prompt]
   * @param {string} [params.directory]
   * @param {string} [params.model]
   * @param {string} [params.variant]
   * @param {string} [params.sessionId]
   * @param {number} [params.timeoutMs]
   * @param {string} [params.executor] - optional "opencode" | "pi" forwarded to dispatch().
   * @param {NodeJS.ProcessEnv} [params.env] - caller environment forwarded to the worker.
   */
  async function advisor({ prompt, directory, model, variant, sessionId, timeoutMs, executor, env } = {}) {
    ensureStateLoaded();
    if (!model || typeof model !== "string") {
      throw new Error("error: model is required\nhelp: taskferry advisor requires a provider/model string, e.g. \"openai/gpt-5.6-sol\"");
    }
    const resolved = resolveAdvisorSession(sessionId);
    /** @type {TaskSummary & {next: string}} */
    let dispatched;
    try {
      dispatched = dispatch({ prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), model, variant, sessionId: resolved.sessionId, executor, env, role: "advisor" });
    } catch (err) {
      throw new Error(errMessage(err).replaceAll("taskferry dispatch", "taskferry advisor"), { cause: err });
    }
    const settled = await poll(dispatched.id, { timeoutMs: timeoutMs ?? maxWait });

    const resetFields = resolved.reset ? { previous_session_id: resolved.previousSessionId } : {};

    if (settled.status === "running" || settled.status === "queued") {
      const logSessionId = settled.sessionId || readSessionIdFromLog(dispatched.logPath);
      if (logSessionId) touchAdvisorSession(logSessionId);
      return {
        status: settled.status,
        task_id: dispatched.id,
        session_id: logSessionId ?? null,
        session_reset: resolved.reset,
        ...resetFields,
        note: logSessionId
          ? `still ${settled.status}; call taskferry wait or taskferry advisor again with session_id "${logSessionId}" to continue`
          : `still ${settled.status}; call taskferry wait with task id "${dispatched.id}" to continue (no session_id yet)`,
      };
    }

    const detail = result(dispatched.id, { fields: ["message", "sessionId", "tokens", "cost", "exitCode", "signal", "spawnError"] });
    if (detail.sessionId) touchAdvisorSession(detail.sessionId);

    return {
      status: detail.status,
      task_id: dispatched.id,
      session_id: detail.sessionId ?? null,
      session_reset: resolved.reset,
      ...resetFields,
      message: detail.message,
      ...(detail.status === "done" ? { tokens: detail.tokens, cost: detail.cost } : {}),
      ...(detail.status !== "done" ? { exitCode: detail.exitCode, signal: detail.signal, spawnError: detail.spawnError } : {}),
    };
  }

  /** @param {string} taskId */
  function settleWaiters(taskId) {
    const list = waiters.get(taskId);
    if (!list) return;
    waiters.delete(taskId);
    for (const settle of list.slice()) settle();
  }

  function list() {
    ensureStateLoaded();
    const all = Array.from(tasks.values()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    /** @type {Record<string, number>} */
    const counts = { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 };
    for (const t of all) {
      if (counts[t.status] != null) counts[t.status]++;
    }
    return {
      counts,
      tasks: all.length ? all.map(summarizeRow) : "none found (this server process's lifetime)",
    };
  }

  /**
   * @param {string} logPath
   * @returns {string|null}
   */
  function readSessionIdFromLog(logPath) {
    const CHUNK_SIZE = 64 * 1024;
    let fd;
    try {
      fd = fs.openSync(logPath, "r");
    } catch {
      return null;
    }
    try {
      let carry = "";
      const buf = Buffer.alloc(CHUNK_SIZE);
      for (;;) {
        const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
        if (bytesRead === 0) break;
        carry += buf.toString("utf8", 0, bytesRead);
        let nl;
        while ((nl = carry.indexOf("\n")) !== -1) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.sessionID) return evt.sessionID;
          } catch {
            continue;
          }
        }
      }
      if (carry.trim()) {
        try {
          const evt = JSON.parse(carry);
          if (evt.sessionID) return evt.sessionID;
        } catch {
          // trailing partial/malformed line, ignore
        }
      }
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
    return null;
  }

  /**
   * @param {string} logPath
   * @returns {string}
   */
  function readNarration(logPath) {
    /** @type {Map<string, string[]>} */
    const textByMessageId = new Map();
    /** @type {string[]} */
    const textOrder = [];
    /** @type {string} */
    let raw;
    try {
      raw = fs.readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type !== "text" || !evt.part || typeof evt.part.text !== "string") continue;
        const mid = evt.part.messageID;
        if (!textByMessageId.has(mid)) {
          textByMessageId.set(mid, []);
          textOrder.push(mid);
        }
        /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
      } catch {
        continue;
      }
    }
    return textOrder.map((mid) => /** @type {string[]} */ (textByMessageId.get(mid)).join("")).join("\n\n");
  }

  /**
   * @param {string} logPath
   * @returns {string}
   */
  function readLastText(logPath) {
    /** @type {number|undefined} */
    let fd;
    try {
      const size = fs.statSync(logPath).size;
      const bytes = Math.min(size, TAIL_READ_BYTES);
      const buffer = Buffer.alloc(bytes);
      fd = fs.openSync(logPath, "r");
      fs.readSync(fd, buffer, 0, bytes, size - bytes);
      const lines = buffer.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const evt = JSON.parse(lines[i]);
          if (evt.type === "text" && typeof evt.part?.text === "string") return evt.part.text;
        } catch {
          continue;
        }
      }
    } catch {
      return "";
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
    return "";
  }

  /**
   * @param {string} taskId
   * @param {{chars?: number}} [options]
   */
  function tail(taskId, { chars = 1000 } = {}) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (!Number.isSafeInteger(chars) || chars <= 0 || chars > 65536) {
      throw new Error("error: chars must be a positive integer no greater than 65536\nhelp: run taskferry tail with chars between 1 and 65536");
    }
    const text = readLastText(task.logPath);
    if (!text) {
      return {
        taskId,
        status: task.status,
        text: "none observed yet",
        textTotalChars: 0,
        truncated: false,
        help: `Run taskferry wait with task id "${taskId}" to wait for task output`,
      };
    }
    const codePoints = Array.from(text);
    return {
      taskId,
      status: task.status,
      text: codePoints.length > chars ? codePoints.slice(-chars).join("") : text,
      textTotalChars: codePoints.length,
      truncated: codePoints.length > chars,
    };
  }

  /**
   * @param {ResultDetail} detail
   * @param {string[]|undefined} fields
   * @returns {ResultDetail}
   */
  function projectResult(detail, fields) {
    if (!fields) return detail;
    /** @type {any} */
    const projected = { taskId: detail.taskId, status: detail.status };
    for (const field of fields) projected[field] = /** @type {any} */ (detail)[field] ?? null;
    return projected;
  }

  /**
   * Review finding #13 (root-cause fix): parse stat counts via real git
   * tooling instead of hand-rolling a header scan. `git apply --numstat`
   * reads either git-style (`diff --git`) or plain unified (`diff -ruN`,
   * the format non-git changesets use) diffs and emits one
   * `<adds>\t<dels>\t<path>` line per file, which we just sum. Delegating
   * to git keeps the stat correct for both extraction kinds without
   * re-deriving the parsing rules. Falls back to a zero stat on parse
   * failure (e.g. a plain `diff -ru` without `-N` whose "Only in ..."
   * lines git apply can't grok) -- the diff itself stays readable via
   * `result --diff`, only the human-readable summary is uncomputable.
   * @param {string} diffPath
   * @param {(command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} [runCommand]
   * @returns {{files: number, additions: number, deletions: number}}
   */
  function computeDiffStat(diffPath, runCommand = defaultOverlayRunCommand) {
    const result = runCommand("git", ["apply", "--numstat", diffPath]);
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return { files: 0, additions: 0, deletions: 0 };
    }
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const firstTab = line.indexOf("\t");
      if (firstTab === -1) continue;
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (secondTab === -1) continue;
      const adds = Number(line.slice(0, firstTab));
      const dels = Number(line.slice(firstTab + 1, secondTab));
      if (Number.isNaN(adds) || Number.isNaN(dels)) continue;
      files += 1;
      additions += adds;
      deletions += dels;
    }
    return { files, additions, deletions };
  }

  // Settlement-time check for "done but no real output": an otherwise clean
  // exit whose extracted final message is empty (after trimming) is flagged
  // with task.incomplete = true, and a task dispatched with --require-final-marker
  // is also flagged when the final message doesn't match the persisted pattern.
  // Runs only on "done" status: cancelled/crashed already carry failureReason,
  // and overloading them with a second failure axis muddies the existing
  // "is this an error or not?" branching in callers.
  /**
   * @param {Task} task
   */
  function evaluateOutputCompleteness(task) {
    const message = extractFinalMessage(task.logPath);
    if (!message.trim()) {
      task.incomplete = true;
      return;
    }
    if (task.finalMarker) {
      try {
        if (!new RegExp(task.finalMarker).test(message)) task.incomplete = true;
      } catch {
        // A finalMarker that survived dispatch-time validation shouldn't
        // throw here, but if it does (e.g. an impossible pathological input),
        // fail closed: treat the task as incomplete rather than silently
        // reporting success.
        task.incomplete = true;
      }
    }
  }

  /**
   * @param {string} logPath
   * @returns {string}
   */
  function extractFinalMessage(logPath) {
    let raw;
    try {
      raw = fs.readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
    /** @type {Map<string, string[]>} */
    const textByMessageId = new Map();
    /** @type {string[]} */
    const textOrder = [];
    /** @type {string|null} */
    let finalMessageId = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      /** @type {any} */
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
        const mid = evt.part.messageID;
        if (!textByMessageId.has(mid)) {
          textByMessageId.set(mid, []);
          textOrder.push(mid);
        }
        /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
      }
      if (evt.type === "step_finish" && evt.part && evt.part.reason === "stop") {
        finalMessageId = evt.part.messageID;
      }
    }
    // Same fallback rule as result(): the last messageID seen wins if no
    // explicit step_finish reason "stop" landed (e.g. a crashed run that never
    // reached one). The settlement-time check uses this same fallback so a
    // clean exit with no step_finish still gets its final turn inspected.
    const targetId = finalMessageId ?? textOrder[textOrder.length - 1];
    return targetId && textByMessageId.has(targetId)
      ? /** @type {string[]} */ (textByMessageId.get(targetId)).join("")
      : "";
  }

  /**
   * @param {string} taskId
   * @param {{full?: boolean, fields?: string[]}} [options]
   * @returns {ResultDetail}
   */
  function result(taskId, { full = false, fields } = {}) {
    ensureStateLoaded();
    const task = tasks.get(taskId);
    if (!task) throw noSuchTask(taskId);
    if (fields != null) {
      if (!Array.isArray(fields) || !fields.length || fields.some((field) => !TASK_MANAGER_RESULT_FIELDS.has(field))) {
        throw new Error(`error: fields must contain one or more supported result fields\nhelp: use one of: ${[...TASK_MANAGER_RESULT_FIELDS].join(", ")}`);
      }
      if (full && !fields.includes("narration")) {
        throw new Error("error: full requires narration in fields\nhelp: omit full or include narration in fields");
      }
    }
    if (task.status === "running" || task.status === "queued") {
      return projectResult({ taskId, status: task.status, message: `task is still ${task.status}; poll taskferry status first` }, fields);
    }
    if (task.status === "unknown" && task.summaryOf) {
      return projectResult({
        taskId,
        status: task.status,
        message: "summary task became unknown after the server restarted; its partial output is unavailable",
      }, fields);
    }

    // opencode's own steps look like: text (narration) -> tool_use -> step_finish
    // (reason "tool-calls") -> text -> step_finish (reason "stop"), one messageID
    // per step. Naively joining every text event across every step glues
    // "I'm about to run ls" onto the actual answer with no separator -- neither
    // a clean final answer nor a real transcript. Only the messageID whose step
    // ended in reason "stop" is the model's actual final turn; everything
    // earlier is intermediate narration, kept separately as `narration` so
    // nothing is silently dropped, but not returned as `message`.
    let sessionId = task.sessionId;
    /** @type {unknown} */
    let tokens = null;
    /** @type {number|null} */
    let cost = null;
    /** @type {Map<string, string[]>} */
    const textByMessageId = new Map();
    /** @type {string[]} */
    const textOrder = [];
    /** @type {string|null} */
    let finalMessageId = null;

    let raw;
    try {
      raw = fs.readFileSync(task.logPath, "utf8");
    } catch {
      raw = "";
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      /** @type {any} */
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // non-JSON line (e.g. a crash stack trace on stderr, interleaved into the same fd)
      }
      if (evt.sessionID) sessionId = evt.sessionID;
      if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
        const mid = evt.part.messageID;
        if (!textByMessageId.has(mid)) {
          textByMessageId.set(mid, []);
          textOrder.push(mid);
        }
        /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
      }
      if (evt.type === "step_finish" && evt.part) {
        if (evt.part.tokens) tokens = sumTokens(tokens, evt.part.tokens);
        if (typeof evt.part.cost === "number") cost = (cost ?? 0) + evt.part.cost;
        if (evt.part.reason === "stop") finalMessageId = evt.part.messageID;
      }
    }

    // Fall back to the last messageID seen if no explicit "stop" step_finish
    // was found (e.g. a crashed run that never reached one).
    const targetId = finalMessageId ?? textOrder[textOrder.length - 1];
    const message = targetId && textByMessageId.has(targetId) ? /** @type {string[]} */ (textByMessageId.get(targetId)).join("") : "";
    const fullNarration = textOrder.map((mid) => /** @type {string[]} */ (textByMessageId.get(mid)).join("")).join("\n\n");
    const truncated = !full && fullNarration.length > NARRATION_PREVIEW_CHARS;
    const narration = truncated ? fullNarration.slice(0, NARRATION_PREVIEW_CHARS) + "…" : fullNarration;

    let diffText = null;
    if (task.diffPath && (fields == null || fields.includes("diff"))) {
      try {
        diffText = fs.readFileSync(task.diffPath, "utf8");
      } catch {
        diffText = null;
      }
    }
    // Review finding #13: spec §5.3 requires a diffStat summary (files changed,
    // +/- counts) on result --full. Routed through `git apply --numstat`
    // (see computeDiffStat) so the same parser handles both git and non-git
    // changesets -- the prior hand-rolled scan only counted `diff --git`
    // headers and silently reported files:0 for every non-git result.
    const diffStat = task.diffPath != null && (fields == null || fields.includes("diffStat")) ? computeDiffStat(task.diffPath, runOverlayCommandFn) : null;

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
      sessionId,
      tokens,
      cost,
      message,
      narration,
      narrationTotalChars: fullNarration.length,
      narrationTruncated: truncated,
      ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
      ...(task.incomplete === true ? { incomplete: true } : {}),
      ...(task.finalMarker != null ? { finalMarker: task.finalMarker } : {}),
      ...(task.incomplete === true
        ? { next: `Task ${taskId} exited cleanly but produced no usable final output${task.finalMarker ? ` (--require-final-marker ${JSON.stringify(task.finalMarker)} did not match)` : " (empty message)"}; treat as incomplete` }
        : truncated
          ? { next: `Run taskferry result with full: true on task id "${taskId}" to see the complete narration` }
          : {}),
      logPath: task.logPath,
    }, fields);
  }

  return {
    dispatch,
    cancel,
    accept,
    reject,
    status,
    taskDirectory,
    poll,
    list,
    result,
    tail,
    summarize: summarizeRequest,
    checkSummaryModelReady,
    setActivitySummarySubscriptions: /** @param {number} count */ (count) => {
      activitySummarySubscriptions = Math.max(0, Number.isSafeInteger(count) ? count : 0);
      activityCache.setSummariesEnabled(activitySummariesEnabled && activitySummarySubscriptions > 0);
    },
    /** @param {Map<string, Set<boolean>>} subs */
    setActivitySubscriptions: (subs) => {
      activitySubscriptions.clear();
      for (const [dir, variants] of subs) activitySubscriptions.set(dir, new Set(variants));
      const totalCount = Array.from(subs.values()).reduce((sum, v) => sum + (v.has(true) ? 1 : 0), 0);
      activitySummarySubscriptions = totalCount;
      activityCache.setSummariesEnabled(activitySummariesEnabled && totalCount > 0);
    },
    advisor,
    paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE },
    // Exposed primarily so tests can seed the summary session id and watermark
    // (the activity cache owns the "last successful summary" state shared
    // between the activity path and the direct summarize path).
    activityCache,
  };
}
