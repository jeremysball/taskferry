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
import { applyChangeset, overlayPaths, resolvePreDispatchHead, subOverlayPaths, subFilePaths, cleanupOverlay, defaultRunCommand as defaultOverlayRunCommand, extractGitDiff, extractNonGitDiff } from "./changeset.js";
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
 * @property {{root:string,tmpRoot:string,upperDir:string,workDir:string,rwBinds:Array<{path:string,upperDir:string,workDir:string}>,rwFileBinds:Array<{path:string,bindSrc:string}>}|null} [overlayDirs]
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
 * @property {{root:string,tmpRoot:string,upperDir:string,workDir:string,rwBinds:Array<{path:string,upperDir:string,workDir:string}>,rwFileBinds:Array<{path:string,bindSrc:string}>}|null} [overlayDirs]
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

/** @param {string} text @returns {boolean} */
function isParseableJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Unlink a file, tolerating it already being gone (ENOENT). @param {string} filePath */
function removeFileIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

// Boot failures: the child exited non-zero having produced zero parseable
// events -- opencode/pi died during startup (a malformed provider extension,
// a broken config) before ever reaching the model. classifyProviderFailure
// deliberately matches only the curated provider patterns on raw non-JSON
// lines, so such a crash used to settle with failureReason/failureDetail
// null and `taskferry list` showed hundreds of bare "crashed" rows with no
// diagnostic (real incident: a provider extension missing its baseUrl
// brick-crashed every dispatch for ~20 hours before anyone could name the
// cause). Surface the last Error: line of the bounded log tail (or the last
// non-JSON line when nothing is Error-prefixed) as the detail instead.
// Settlement-path only: the running watcher and classifyTrailingLogFailure
// keep their curated-pattern behavior untouched, so raw stderr noise can
// never preemptively kill a healthy running task -- this classification
// only applies once the child is already dead and provably never worked.
const BOOT_FAILURE_SCAN_BYTES = 64 * 1024;
/**
 * @param {string} logPath
 * @returns {{bucket: string, detail: string} | null}
 */
function extractBootFailureDetail(logPath) {
  /** @type {number|undefined} */
  let fd;
  try {
    const size = fs.statSync(logPath).size;
    if (size === 0) return null;
    const bytes = Math.min(size, BOOT_FAILURE_SCAN_BYTES);
    const buffer = Buffer.alloc(bytes);
    fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
    const lines = buffer.toString("utf8").split("\n");
    // A read starting mid-file can begin inside a line; that partial first
    // line is not a real line of the log, so it is never evidence. (A read
    // from offset 0 starts on a real line and keeps everything.)
    if (size > BOOT_FAILURE_SCAN_BYTES) lines.shift();
    /** @type {string|null} */
    let lastError = null;
    /** @type {string|null} */
    let lastNonJson = null;
    for (const line of lines) {
      const trimmed = line.trim();
      // Parseable event lines are owned by the curated classifier and are
      // never boot-failure evidence. (A startsWith("{") test is not enough
      // here: an unparseable brace-starting stderr dump -- an object literal,
      // not JSON -- is evidence and must not be skipped.)
      if (!trimmed || isParseableJson(trimmed)) continue;
      if (/^error\b[:\s]/i.test(trimmed)) lastError = trimmed;
      else lastNonJson = trimmed;
    }
    const detail = lastError ?? lastNonJson;
    return detail ? { bucket: "boot_failure", detail: capDetail(detail) } : null;
  } catch {
    return null; // log unreadable or gone; nothing to surface
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// Whole-log answer to "did this child ever emit an event," for the boot-crash
// gate at settlement. logActivity()'s cached 64KiB head scan is the right
// approximation for cheap repeated status polling, but wrong here: a single
// event line larger than 64KiB (a long answer is one NDJSON line) fails
// JSON.parse on the truncated head fragment and leaves a task that did real
// work looking eventless, which would stamp boot_failure on a healthy run.
// Settlement happens once per task, so pay for a whole-log scan with early
// exit: healthy logs parse their first line, boot-crash logs are tiny by
// nature (the child died immediately), and an eventless log that still grew
// large is bounded by the pre-output watchdog kill.
/**
 * @param {string} logPath
 * @returns {boolean}
 */
function logHasAnyEvent(logPath) {
  /** @type {string|undefined} */
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() && isParseableJson(line)) return true;
  }
  return false;
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
  const sum = (a, b) => {
    if (typeof a === "number" || typeof b === "number") return (a ?? 0) + (b ?? 0);
    return a ?? b;
  };
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
    const classified = line.trim() ? classifyProviderLine(line, errorBucketPrefix) : null;
    if (!classified) continue;
    if (classified.hasParseableLine) hasParseableLine = true;
    if (classified.failure) {
      return { failure: classified.failure, hasParseableLine };
    }
  }
  return { failure: null, hasParseableLine };
}

/**
 * Classify a single log line into a failure bucket, or null when the line
 * is not boot-crash evidence. Parseable `type:"text"` events and unknown
 * non-JSON stderr lines yield null (skip); everything else yields a failure
 * tuple carrying whether this line was parseable.
 * @param {string} line
 * @param {string} errorBucketPrefix
 * @returns {{failure: {bucket: string, detail: string} | null, hasParseableLine: boolean} | null}
 */
function classifyProviderLine(line, errorBucketPrefix) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    // Non-JSON output: boot-failure evidence if it matches a curated bucket.
    for (const [bucket, patterns] of PROVIDER_FAILURE_BUCKETS) {
      if (patterns.some((pattern) => pattern.test(line))) {
        return { failure: { bucket: bucketFor(errorBucketPrefix, bucket), detail: capDetail(line) }, hasParseableLine: false };
      }
    }
    return null;
  }
  if (evt.type !== "error") return { failure: null, hasParseableLine: true };
  const text = typeof evt.message === "string" ? evt.message : JSON.stringify(evt);
  for (const [bucket, patterns] of PROVIDER_FAILURE_BUCKETS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return { failure: { bucket: bucketFor(errorBucketPrefix, bucket), detail: capDetail(text) }, hasParseableLine: true };
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
    hasParseableLine: true,
  };
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

/**
 * The closure dependencies that `startTask`'s helper pipeline needs threaded
 * in from `createTaskManager`. Every value here is a reference to (or a thin
 * mutator over) a `createTaskManager` closure binding -- no helper reads the
 * outer factory's variables directly, so each helper is a genuine standalone
 * module-level function rather than a hidden closure over the factory.
 * @typedef {object} StartTaskContext
 * @property {string} SUMMARY_DIR
 * @property {string} PROMPT_DIR
 * @property {typeof import("node:child_process").spawn} spawnFn
 * @property {(command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} runOverlayCommandFn
 * @property {boolean} sandboxEnabled
 * @property {NodeJS.Platform} platform
 * @property {boolean} overlayEnabled
 * @property {string} overlayTmpRoot
 * @property {string[]} allowedDirs
 * @property {string} stateDir
 * @property {string} cacheDir
 * @property {string} runtimeDir
 * @property {(path: string) => boolean} existsFn
 * @property {(path: string) => {isDirectory: () => boolean}|null} statFn
 * @property {(path: string) => string[]} readdirFn
 * @property {(directory: string) => string|null} resolveGitCommonDirFn
 * @property {(directory: string) => string|null} resolveGitDirFn
 * @property {() => void} requireBwrap
 * @property {() => void} requireOverlaySupport
 * @property {(env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv} dispatchEnvironment
 * @property {(env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv} summaryEnvironment
 * @property {(taskId: string) => void} settleWaiters
 * @property {() => void} launchQueuedTasks
 * @property {(taskId: string) => void} persistTask
 * @property {(task: Task, opts?: {force?: boolean}) => Promise<unknown>} scheduleActivity
 * @property {(task: Task) => void} classifyTrailingLogFailure
 * @property {(task: Task) => void} startRunningWatcher
 * @property {(taskId: string) => void} stopRunningWatcher
 * @property {(taskId: string) => string|null} readSessionIdFromLog
 * @property {(task: Task) => void} evaluateOutputCompleteness
 * @property {(task: Task) => void} extractChangesetForTask
 * @property {(pid: number, signal: NodeJS.Signals) => void} sendSignal
 * @property {{evictTask: (id: string) => void, setSummarySessionId: (srcTaskId: string, sessionId: string) => void, setLastSummarizedWatermark: (srcTaskId: string, bytes: number) => void}} activityCache
 * @property {Set<string>} logHasEventCache
 * @property {Map<string, NodeJS.Timeout>} escalationTimers
 * @property {Map<string, Task>} tasks
 * @property {() => void} decRunning
 * @property {() => void} incRunning
 */

/**
 * Mutable state shared between a spawned child's stdout/exit/error handlers.
 * Threading it explicitly (rather than closing over a single `startTask`
 * frame) is what lets each lifecycle step live as its own standalone helper.
 * @typedef {object} SharedChildState
 * @property {boolean} settled
 * @property {number} capturedLogFd
 * @property {string} stdoutCarry
 * @property {import("node:child_process").ChildProcess} child
 * @property {Task} task
 * @property {import("./executor.js").WorkerExecutor} executor
 * @property {() => void} cleanUpScratchFiles
 */

/**
 * Resolves the executor's spawn args for a launch from the pre-parsed launch
 * metadata, keeping `resolveStartTaskLaunch` itself flat. Every `isSummary`
 * ternary mirrors the monolithic launch-wiring exactly: summary launches
 * carry a snapshot path and no prompt file; dispatch launches carry a prompt
 * and a variant, and thread the session id (falling back to null when the
 * caller supplied none).
 * @param {import("./executor.js").WorkerExecutor} executor
 * @param {{isSummary: boolean, summaryLaunch: SummaryLaunch, dispatchLaunch: DispatchLaunch, launchDirectory: string, promptFilePath: string|null}} p
 * @returns {string[]}
 */
function buildLaunchSpawnArgs(executor, { isSummary, summaryLaunch, dispatchLaunch, launchDirectory, promptFilePath }) {
  return executor.buildSpawnArgs({
    isSummary,
    launchDirectory,
    promptFilePath,
    model: isSummary ? summaryLaunch.model : dispatchLaunch.model,
    variant: isSummary ? undefined : dispatchLaunch.variant,
    snapshotPath: isSummary ? summaryLaunch.snapshotPath : undefined,
    prompt: isSummary ? "" : dispatchLaunch.prompt,
    sessionId: isSummary ? summaryLaunch.summarySessionId ?? null : dispatchLaunch.sessionId ?? null,
  });
}

/**
 * Resolves the per-launch metadata a dispatch needs before it can spawn:
 * which kind of launch this is (summary vs dispatch), the target directory,
 * whether the prompt must be routed through a prompt file to dodge the argv
 * E2BIG limit (issue #78), and the executor's buildSpawnArgs output. Also
 * returns the closure that cleans up scratch files (the summary snapshot and
 * any prompt file) on settlement -- shared by every settle path.
 * @param {Task} task
 * @param {LaunchSpec} launch
 * @param {{SUMMARY_DIR: string, PROMPT_DIR: string}} ctx
 * @returns {{isSummary: boolean, summaryLaunch: SummaryLaunch, dispatchLaunch: DispatchLaunch, executor: import("./executor.js").WorkerExecutor, launchDirectory: string, promptFilePath: string|null, args: string[], cleanUpScratchFiles: () => void}}
 */
function resolveStartTaskLaunch(task, launch, ctx) {
  const isSummary = launch.kind === "summary";
  const summaryLaunch = /** @type {SummaryLaunch} */ (launch);
  const dispatchLaunch = /** @type {DispatchLaunch} */ (launch);
  const executor = launch.executor;
  const launchDirectory = isSummary ? ctx.SUMMARY_DIR : dispatchLaunch.directory;
  // A prompt over PROMPT_ARGV_SAFE_BYTES can't survive as a single argv
  // element (issue #78: `spawn E2BIG`). Route it through a prompt file
  // instead -- the executor's buildSpawnArgs attaches it however that
  // executor's CLI expects (opencode: `-f`; pi: a positional `@path`).
  const promptFilePath = !isSummary && Buffer.byteLength(dispatchLaunch.prompt, "utf8") > PROMPT_ARGV_SAFE_BYTES
    ? path.join(ctx.PROMPT_DIR, `${task.id}.prompt.txt`)
    : null;
  const args = buildLaunchSpawnArgs(executor, { isSummary, summaryLaunch, dispatchLaunch, launchDirectory, promptFilePath });
  const cleanUpScratchFiles = () => {
    if (isSummary && summaryLaunch.snapshotPath) removeFileIfPresent(summaryLaunch.snapshotPath);
    if (promptFilePath) removeFileIfPresent(promptFilePath);
  };
  return { isSummary, summaryLaunch, dispatchLaunch, executor, launchDirectory, promptFilePath, args, cleanUpScratchFiles };
}

/**
 * Computes the pre-spawn plan shared by every launch path before sandboxing
 * is applied: the base child env (summary vs dispatch variant), the
 * sandbox-disable flag, the executor's raw command/args, and the role. Also
 * enforces the fail-closed advisor check (review finding #5): an advisor may
 * never launch with a plain, unoverlayed writable bind, so when sandboxing is
 * unavailable it throws here instead of degrading to unsandboxed writes.
 * @param {StartTaskContext} ctx
 * @param {ReturnType<typeof resolveStartTaskLaunch>} launchInfo
 * @returns {{noSandbox: boolean, spawnCommand: string, spawnArgs: string[], spawnEnv: NodeJS.ProcessEnv, role: "dispatch"|"advisor"|null}}
 */
function resolveSpawnPlan(ctx, launchInfo) {
  const { isSummary, summaryLaunch, dispatchLaunch, executor, args } = launchInfo;
  const spawnEnv = isSummary ? ctx.summaryEnvironment(summaryLaunch.env) : ctx.dispatchEnvironment(dispatchLaunch.env);
  const noSandbox = !isSummary && dispatchLaunch.noSandbox === true;
  const spawnCommand = executor.binaryName;
  const spawnArgs = args;
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
  if (role === "advisor" && !(ctx.sandboxEnabled && !noSandbox && platformSupportsSandbox(ctx.platform))) {
    throw new Error(
      "error: advisor dispatch requires overlay-gated writes, but the sandbox is unavailable\n" +
      "help: advisor writes must be gated by a copy-on-write overlay (docs/adr/0001-cow-overlays-and-diff-gated-writes.md), which requires the bwrap sandbox -- unset TASKFERRY_DISABLE_SANDBOX (or drop --no-sandbox) and run on a supported platform with bubblewrap >= 0.8"
    );
  }
  return { noSandbox, spawnCommand, spawnArgs, spawnEnv, role };
}

/**
 * When sandboxing is active, replaces the plain spawn command with the bwrap
 * invocation: builds the deny-list, ro-binds the executor's auth file and (for
 * a dispatch) creates the copy-on-write overlay tree, wires the git-common-dir
 * and allowed-dirs rw binds, and assembles buildBwrapArgs. Side effects on the
 * task mirror the original dispatch pipeline: the overlay the worker will run
 * with is persisted onto `task` (review finding #1) so settlement-time
 * extraction re-mounts the same sub-overlays, and the pre-dispatch HEAD is
 * captured while the overlay is freshly created. When sandboxing is disabled
 * (or unsupported on this platform) it returns the plan's plain command
 * unchanged.
 * @param {StartTaskContext} ctx
 * @param {ReturnType<typeof resolveStartTaskLaunch>} launchInfo
 * @param {ReturnType<typeof resolveSpawnPlan>} plan
 * @param {Task} task
 * @returns {{spawnCommand: string, spawnArgs: string[], spawnEnv: NodeJS.ProcessEnv}}
 */
function buildSandboxedSpawn(ctx, launchInfo, plan, task) {
  const { noSandbox, spawnEnv, role, spawnCommand, spawnArgs } = plan;
  if (!(ctx.sandboxEnabled && !noSandbox && platformSupportsSandbox(ctx.platform))) {
    return { spawnCommand, spawnArgs, spawnEnv };
  }
  const binds = buildBwrapBinds(ctx, launchInfo, task, spawnEnv, role);
  const assembled = assembleBwrapSpawn(ctx, launchInfo, binds, task);
  // bwrap owns the process group: the child is spawned through bwrap with the
  // sandboxed argv it assembled, so cancellation/signalling still targets the
  // whole group.
  return { spawnCommand: "bwrap", spawnArgs: assembled.spawnArgs, spawnEnv: assembled.spawnEnv };
}

/**
 * Creates the copy-on-write overlay tree for a dispatch launch following the
 * exclusive-root mkdir protocol (review finding #12): the non-recursive mkdir
 * fails closed (EEXIST -> spawnError via the outer catch) if the path already
 * exists -- e.g. a pre-planted symlink. Returns null when no overlay is
 * wanted. An advisor dispatched with overlay globally disabled fails closed
 * here (review finding #5); a regular dispatch without an overlay gets a
 * warning that its writes land ungated.
 * @param {StartTaskContext} ctx
 * @param {ReturnType<typeof resolveStartTaskLaunch>} launchInfo
 * @param {Task} task
 * @param {"dispatch"|"advisor"|null} role
 * @returns {{root: string, upperDir: string, workDir: string}|null}
 */
function createOverlayIfNeeded(ctx, launchInfo, task, role) {
  const { isSummary, dispatchLaunch, launchDirectory } = launchInfo;
  const wantsOverlay = !isSummary && ctx.overlayEnabled && dispatchLaunch.noOverlay !== true;
  if (wantsOverlay) {
    ctx.requireOverlaySupport();
    const overlayInfo = overlayPaths(task.id, ctx.overlayTmpRoot);
    fs.mkdirSync(ctx.overlayTmpRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlayInfo.root, { mode: 0o700 });
    fs.mkdirSync(overlayInfo.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlayInfo.workDir, { recursive: true, mode: 0o700 });
    return overlayInfo;
  }
  if (role === "advisor") {
    // Review finding #5: an advisor without an overlay gets a plain writable
    // bind -- a path to persist writes, contradicting ADR 0001.
    throw new Error(
      "error: advisor dispatch requires overlay-gated writes, but overlay is disabled\n" +
      "help: unset TASKFERRY_DISABLE_OVERLAY or set overlayEnabled: true in config -- advisor writes must be gated, see docs/adr/0001-cow-overlays-and-diff-gated-writes.md"
    );
  }
  if (!isSummary) {
    process.stderr.write(`warning: overlay disabled -- writes land directly on ${launchDirectory}, not gated by accept/reject\n`);
  }
  return null;
}

/**
 * Computes the bwrap bind set for a sandboxed dispatch: the deny-list (with
 * entries the user simply doesn't have dropped, since bwrap --tmpfs fails if
 * the mount point doesn't exist), the executor's ro-bind auth file, the
 * executor data-home rw bind (overlayfs needs the source to pre-exist, hence
 * the mkdir), the optional copy-on-write overlay tree, the git-common-dir
 * flows, and the allowed-dirs rw binds. Overlay creation follows the
 * exclusive-root mkdir protocol (review finding #12) and the advisor-overlay
 * fail-closed checks (review finding #5); see createOverlayIfNeeded.
 * @param {StartTaskContext} ctx
 * @param {ReturnType<typeof resolveStartTaskLaunch>} launchInfo
 * @param {Task} task
 * @param {NodeJS.ProcessEnv} spawnEnv
 * @param {"dispatch"|"advisor"|null} role
 * @returns {{homeDir: string, denyList: string[], extraRoBinds: [string, string][], extraRwBinds: string[], overlayInfo: {root: string, upperDir: string, workDir: string}|null, overlayRwBinds: Array<{path: string, upperDir: string, workDir: string}>, overlayRwFileBinds: Array<{path: string, bindSrc: string}>, executorRwPairBinds: [string, string][], sandboxEnv: NodeJS.ProcessEnv, spawnEnv: NodeJS.ProcessEnv, role: "dispatch"|"advisor"|null}}
 */
function buildBwrapBinds(ctx, launchInfo, task, spawnEnv, role) {
  const { isSummary, dispatchLaunch, executor, launchDirectory, promptFilePath } = launchInfo;
  ctx.requireBwrap();
  const homeDir = os.homedir();
  const denyList = defaultDenyList(homeDir, ctx.stateDir).filter(ctx.existsFn);
  // The executor decides which env var overrides point at its sandboxed data
  // home (opencode: XDG_DATA_HOME; pi: PI_CODING_AGENT_DIR) and which
  // destination to ro-bind the real auth file into, so each executor's bound
  // auth destination matches its own environment directory.
  const {
    extraRoBinds: executorRoBinds,
    extraRwPairBinds: executorRwPairBinds = [],
    sandboxedDataHome,
    sandboxEnv,
  } = executor.sandboxAuthFile({
    homeDir,
    dataDir: ctx.cacheDir,
    spawnEnv,
    existsFn: ctx.existsFn,
    statFn: ctx.statFn,
    readdirFn: ctx.readdirFn,
    ...(isSummary ? {} : { sessionId: dispatchLaunch.sessionId ?? null, launchDirectory: launchDirectory || null }),
  });
  /** @type {[string, string][]} */
  const extraRoBinds = [...executorRoBinds];
  if (promptFilePath) extraRoBinds.push([ctx.PROMPT_DIR, ctx.PROMPT_DIR]);
  /** @type {string[]} */
  const extraRwBinds = [];
  // The root filesystem is read-only bound by default, so the executor's
  // real-disk data home (cacheDir, not the tmpfs runtime dir) needs an
  // explicit read-write bind. bwrap requires the source to already exist,
  // hence the mkdir here rather than leaving it for the sandboxed process.
  fs.mkdirSync(sandboxedDataHome, { recursive: true, mode: 0o700 });
  extraRwBinds.push(sandboxedDataHome);
  const overlayInfo = createOverlayIfNeeded(ctx, launchInfo, task, role);
  const gitBinds = buildGitBinds(ctx, launchDirectory, overlayInfo, extraRwBinds);
  for (const dir of [...ctx.allowedDirs, ...(isSummary ? [] : dispatchLaunch.allowedDirs || [])]) {
    const resolved = path.isAbsolute(dir) ? dir : path.resolve(launchDirectory, dir);
    if (ctx.existsFn(resolved)) extraRwBinds.push(resolved);
  }
  return {
    homeDir, denyList, extraRoBinds, extraRwBinds, overlayInfo, executorRwPairBinds, sandboxEnv, spawnEnv, role,
    overlayRwBinds: gitBinds.overlayRwBinds,
    overlayRwFileBinds: gitBinds.overlayRwFileBinds,
  };
}

/**
 * Builds the write-through binds for a git dispatch directory whose real
 * gitdir lives outside the read-write mount: the gitdir (or git-common-dir)
 * becomes a rw overlay sub-mount or a scratch-copied file bind, depending on
 * whether the target is a directory or a file (overlayfs is directory-only).
 * A git worktree's real gitdir (objects/refs it shares with the main
 * checkout, plus its own HEAD/index) lives outside `launchDirectory` and is
 * otherwise invisible to the read-write bind on it alone -- without this,
 * `git commit` inside the sandbox fails read-only.
 * @param {StartTaskContext} ctx
 * @param {string} launchDirectory
 * @param {{root: string, upperDir: string, workDir: string}|null} overlayInfo
 * @param {string[]} extraRwBinds
 * @returns {{overlayRwBinds: Array<{path: string, upperDir: string, workDir: string}>, overlayRwFileBinds: Array<{path: string, bindSrc: string}>}}
 */
function buildGitBinds(ctx, launchDirectory, overlayInfo, extraRwBinds) {
  /** @type {Array<{path: string, upperDir: string, workDir: string}>} */
  const overlayRwBinds = [];
  /** @type {Array<{path: string, bindSrc: string}>} */
  const overlayRwFileBinds = [];
  const gitCommonDir = ctx.resolveGitCommonDirFn(launchDirectory);
  if (gitCommonDir && ctx.existsFn(gitCommonDir) && isOutsideDirectory(launchDirectory, gitCommonDir)) {
    const gitDir = ctx.resolveGitDirFn(launchDirectory);
    /** @param {string} p */
    const addWritable = (p) => {
      if (overlayInfo) {
        if (ctx.statFn(p)?.isDirectory()) {
          const sub = subOverlayPaths(overlayInfo.root, p);
          fs.mkdirSync(sub.upperDir, { recursive: true, mode: 0o700 });
          fs.mkdirSync(sub.workDir, { recursive: true, mode: 0o700 });
          overlayRwBinds.push(sub);
        } else {
          // Overlayfs mounts are directory-only (bwrap dies with "Can't mkdir
          // <file>: Not a directory"), so a writable FILE gets a scratch copy
          // under the overlay root bound rw onto the host path instead.
          const bind = subFilePaths(overlayInfo.root, p);
          fs.mkdirSync(path.dirname(bind.bindSrc), { recursive: true, mode: 0o700 });
          fs.copyFileSync(p, bind.bindSrc);
          overlayRwFileBinds.push(bind);
        }
      } else {
        extraRwBinds.push(p);
      }
    };
    if (gitDir && ctx.existsFn(gitDir) && gitDir !== gitCommonDir) {
      addWritable(gitDir);
      for (const rel of ["objects", "refs", path.join("logs", "refs")]) {
        const resolved = path.join(gitCommonDir, rel);
        fs.mkdirSync(resolved, { recursive: true });
        addWritable(resolved);
      }
      const packedRefs = path.join(gitCommonDir, "packed-refs");
      if (ctx.existsFn(packedRefs)) addWritable(packedRefs);
    } else {
      addWritable(gitCommonDir);
    }
  }
  return { overlayRwBinds, overlayRwFileBinds };
}

/**
 * Assembles the final bwrap argv from the computed binds, merges the sandbox
 * env over the spawn env, and -- when an overlay was created for a dispatch --
 * persists the overlay + rw binds onto the task (review finding #1) and
 * captures the pre-dispatch HEAD while the overlay is freshly created.
 * @param {StartTaskContext} ctx
 * @param {ReturnType<typeof resolveStartTaskLaunch>} launchInfo
 * @param {ReturnType<typeof buildBwrapBinds>} binds
 * @param {Task} task
 * @returns {{spawnArgs: string[], spawnEnv: NodeJS.ProcessEnv}}
 */
function assembleBwrapSpawn(ctx, launchInfo, binds, task) {
  const { executor, args, launchDirectory, isSummary } = launchInfo;
  const spawnArgs = buildBwrapArgs({
    directory: launchDirectory,
    stateDir: ctx.stateDir,
    runtimeDir: ctx.runtimeDir,
    homeDir: binds.homeDir,
    denyList: binds.denyList,
    extraRwBinds: binds.extraRwBinds,
    extraRwPairBinds: binds.executorRwPairBinds,
    extraRoBinds: binds.extraRoBinds,
    ...(binds.overlayInfo ? { overlay: { upperDir: binds.overlayInfo.upperDir, workDir: binds.overlayInfo.workDir }, overlayRwBinds: binds.overlayRwBinds, overlayRwFileBinds: binds.overlayRwFileBinds } : {}),
    runtimeDirWritable: binds.role !== "advisor",
  }).concat(["--", executor.binaryName, ...args]);
  const spawnEnv = { ...binds.spawnEnv, ...binds.sandboxEnv };
  if (binds.overlayInfo && !isSummary) {
    // rwBinds persisted onto the task (review finding #1): settlement-time
    // extraction (Task 10) must re-mount the exact git-common-dir sub-overlays
    // the worker ran with, so the diff sees the worker's writes.
    task.overlayDirs = { ...binds.overlayInfo, tmpRoot: ctx.overlayTmpRoot, rwBinds: binds.overlayRwBinds, rwFileBinds: binds.overlayRwFileBinds };
    task.changesetStatus = "pending";
    task.preDispatchHead = resolvePreDispatchHead(launchDirectory, ctx.runOverlayCommandFn);
  }
  return { spawnArgs, spawnEnv };
}

/**
 * Writes a normalized log event (or a structured ExecutorNormalizationError
 * when the executor's normalizeLogEvent throws) to the captured log fd. A
 * throw out of an EventEmitter callback is an unhandled exception that would
 * crash the daemon and orphan every child, so the throw is caught here and
 * turned into a canonical `type:"error"` event instead.
 * @param {SharedChildState} shared
 * @param {unknown} parsed
 * @param {string} rawLine
 */
function writeNormalizedLogLine(shared, parsed, rawLine) {
  let normalized;
  try {
    normalized = shared.executor.normalizeLogEvent(parsed);
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
      fs.writeSync(shared.capturedLogFd, `${JSON.stringify(errorEvent)}\n`);
    } catch {
      // Log fd closed out from under us (task already settled / cleaned up)
    }
    return;
  }
  if (normalized == null) return;
  try {
    fs.writeSync(shared.capturedLogFd, `${JSON.stringify(normalized)}\n`);
  } catch {
    // Log fd closed out from under us (task already settled / cleaned up)
  }
}

/**
 * Inline stdout handler: buffers until a newline, then routes each complete
 * line through writeNormalizedLogLine, preserving verbatim any non-JSON
 * stdout (so non-event-emitting providers still have text to classify).
 * @param {SharedChildState} shared
 * @param {Buffer} chunk
 */
function onChildData(shared, chunk) {
  shared.stdoutCarry += chunk.toString("utf8");
  let nl;
  while ((nl = shared.stdoutCarry.indexOf("\n")) !== -1) {
    const line = shared.stdoutCarry.slice(0, nl);
    shared.stdoutCarry = shared.stdoutCarry.slice(nl + 1);
    if (!line.trim()) continue;
    let parsed;
    let isJson = true;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON stdout -- preserve verbatim so classifyProviderFailure has
      // the line's text even without a parseable event shape.
      isJson = false;
      try {
        fs.writeSync(shared.capturedLogFd, `${line}\n`);
      } catch {
        // Log fd closed out from under us (task already settled / cleaned up)
      }
    }
    if (isJson) writeNormalizedLogLine(shared, parsed, line);
  }
}

/**
 * Trailing-fragment stdout handler: a final partial/malformed line at process
 * end is preserved verbatim for the same reason as the inline branch above.
 * @param {SharedChildState} shared
 */
function onChildEnd(shared) {
  const tail = shared.stdoutCarry;
  shared.stdoutCarry = "";
  if (!tail.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(tail);
  } catch {
    // Trailing partial / malformed line at process end -- preserve verbatim.
    try {
      fs.writeSync(shared.capturedLogFd, `${tail}\n`);
    } catch {
      // Same as the inline branch: fd may already be closed.
    }
    return;
  }
  writeNormalizedLogLine(shared, parsed, tail);
}

/**
 * The shared settle path for a launched child: persists the terminal state,
 * prunes the activity cache, evicts the log-event cache, cleans up scratch
 * files, and releases the concurrency slot (decrementing runningCount and
 * kicking the launch queue so the next queued task can start).
 * @param {StartTaskContext} ctx
 * @param {SharedChildState} shared
 */
function finishChildSettlement(ctx, shared) {
  const task = shared.task;
  try {
    ctx.persistTask(task.id);
  } catch {
    // In-memory child settlement is authoritative; a failed best-effort
    // state write must not strand the concurrency slot.
  }
  // Prune the activity cache only after the terminal snapshot above has had
  // a chance to land, so `watch --summaries` still sees the final status
  // transition instead of a cache miss.
  void ctx.scheduleActivity(task, { force: true }).then(() => ctx.activityCache.evictTask(task.id));
  ctx.logHasEventCache.delete(task.logPath);
  try {
    shared.cleanUpScratchFiles();
  } catch (err) {
    // EBUSY/EACCES unlink failures during scratch cleanup must not throw from
    // this child exit handler: no uncaughtException handler upstream, so an
    // unhandled throw crashes the daemon and orphans every other in-flight task.
    console.error(`taskferry: failed to clean up scratch files for task ${task.id}: ${errMessage(err)}`);
  } finally {
    ctx.decRunning();
    ctx.settleWaiters(task.id);
    ctx.launchQueuedTasks();
  }
}

/**
 * Child exit handler: marks settled, closes the shared log fd, clears the
 * escalation timer, classifies trailing failures, computes the terminal
 * status (including boot-crash surfacing), stamps session/exit metadata, runs
 * output-completeness and changeset extraction for terminal states, carries a
 * successful summary child's session id forward, then settles the task.
 * @param {StartTaskContext} ctx
 * @param {SharedChildState} shared
 * @param {number|null} code
 * @param {NodeJS.Signals|null} signal
 */
function onChildExit(ctx, shared, code, signal) {
  const task = shared.task;
  if (shared.settled) return;
  shared.settled = true;
  // The stdout handler and stderr (wired through stdio[2] -> logFd) share
  // this fd; close it now that nothing else can write.
  try {
    fs.closeSync(shared.capturedLogFd);
  } catch {
    // Already closed (e.g. concurrent exit/error path), or the fd table
    // entry is gone -- nothing to clean up.
  }
  const timer = ctx.escalationTimers.get(task.id);
  if (timer) {
    clearTimeout(timer);
    ctx.escalationTimers.delete(task.id);
  }
  ctx.classifyTrailingLogFailure(task);
  ctx.stopRunningWatcher(task.id);
  task.status = resolveChildExitStatus(task, code, signal);
  surfaceBootCrashFailure(task, code);
  task.exitCode = code;
  task.signal = signal;
  task.endedAt = new Date().toISOString();
  const parsedSessionId = ctx.readSessionIdFromLog(task.logPath);
  if (parsedSessionId) task.sessionId = parsedSessionId;
  if (task.status === "done") ctx.evaluateOutputCompleteness(task);
  if (task.status === "done" || task.status === "crashed" || task.status === "cancelled") ctx.extractChangesetForTask(task);
  carrySummarySession(ctx, task, parsedSessionId);
  finishChildSettlement(ctx, shared);
}

/**
 * Computes a child's terminal status from its exit code/signal: a pending
 * cancel wins, a pre-set failureReason (e.g. from the watchdog) is preserved
 * as "crashed", and a clean zero exit with no signal is "done". A
 * watchdog-killed child (task.failureReason already set) can still exit
 * 0/unsignaled if it traps SIGTERM and shuts down gracefully -- don't let
 * that read as "done" and bury the failureReason behind a healthy status.
 * @param {Task} task
 * @param {number|null} code
 * @param {NodeJS.Signals|null} signal
 * @returns {"cancelled"|"crashed"|"done"}
 */
function resolveChildExitStatus(task, code, signal) {
  if (task.cancelRequested) return "cancelled";
  if (task.failureReason) return "crashed";
  if (code === 0 && !signal) return "done";
  return "crashed";
}

/**
 * Boot-crash surfacing: an explicit non-zero exit (signal deaths stay
 * unclassified: code is null there, and an external kill is not a boot
 * failure even when it lands during startup), nothing set by the curated
 * classifier, and not a single parseable event anywhere in the log -- the
 * child never did any work, so its raw capture becomes failureReason/detail.
 * Skipped once any event exists: raw stderr after real work started is
 * ambiguous and stays the curated classifier's job.
 * @param {Task} task
 * @param {number|null} code
 */
function surfaceBootCrashFailure(task, code) {
  const explicitNonZeroExit = code != null && code !== 0;
  if (task.status === "crashed" && !task.failureReason && explicitNonZeroExit && !logHasAnyEvent(task.logPath)) {
    const bootFailure = extractBootFailureDetail(task.logPath);
    if (bootFailure) {
      task.failureReason = bucketFor(resolveExecutor(task.executorId).errorBucketPrefix, bootFailure.bucket);
      task.failureDetail = bootFailure.detail;
    }
  }
}

/**
 * Persists the opencode session id of a successful summary child so the next
 * summarize turn can resume the same prompt-cached conversation via
 * `--continue --session <id>`, and stamps the watermark so the next turn only
 * re-sends narration from this point on. Applies to both the activity-cache
 * path (`watch --summaries`) and the direct `taskferry summary` path -- they
 * share this exit handler, so the direct path gets session continuity too.
 * @param {StartTaskContext} ctx
 * @param {Task} task
 * @param {string|null} parsedSessionId
 */
function carrySummarySession(ctx, task, parsedSessionId) {
  if (task.summaryOf && task.status === "done" && parsedSessionId) {
    ctx.activityCache.setSummarySessionId(task.summaryOf.sourceTaskId, parsedSessionId);
    const source = ctx.tasks.get(task.summaryOf.sourceTaskId);
    if (source) {
      try {
        const size = fs.statSync(source.logPath).size;
        ctx.activityCache.setLastSummarizedWatermark(task.summaryOf.sourceTaskId, size);
      } catch {
        // Source log unreadable at settlement time (rotated or deleted). The
        // next summarize call's watermark-vs-size check detects the
        // inconsistency and clears the cache state.
      }
    }
  }
}

/**
 * Child spawn-error handler: mirrors the exit handler (close the shared fd,
 * mark settled, stamp crash metadata) and runs the same extraction/cleanup
 * path so a spawn-failed task -- whose overlay was already created -- is not
 * stranded on disk with no extraction ever booked against it.
 * @param {StartTaskContext} ctx
 * @param {SharedChildState} shared
 * @param {Error} err
 */
function onChildError(ctx, shared, err) {
  const task = shared.task;
  ctx.stopRunningWatcher(task.id);
  if (shared.settled) return;
  shared.settled = true;
  // Mirrors the exit handler: the stdout handler shares this fd and stops
  // writing once settled; close it so the OS doesn't keep an entry on its fd
  // table for a task that's about to settle.
  try {
    fs.closeSync(shared.capturedLogFd);
  } catch {
    // Already closed or gone -- nothing to clean up.
  }
  task.status = "crashed";
  task.spawnError = errMessage(err);
  task.endedAt = new Date().toISOString();
  // Spawn failure (e.g. ENOENT) lands here AFTER the sandbox/overlay block
  // already ran: overlayDirs is set, changesetStatus is still "pending", and
  // the overlay would otherwise sit on disk with no extraction ever booked
  // against it. extractChangesetForTask is internally error-safe and handles
  // an empty overlay the same way the exit path does.
  ctx.extractChangesetForTask(task);
  finishChildSettlement(ctx, shared);
}

/**
 * Opens the task's log, computes the spawn plan, applies sandboxing/overlay
 * setup, spawns the child, wires the stdout/exit/error handlers, and performs
 * post-spawn bookkeeping (status/pid/running count/persist/watcher). Any sync
 * throw along the way -- prompt-file write, log open, sandbox or overlay
 * setup, or spawn itself -- is caught and turned into a crashed task with a
 * spawnError, mirroring the original dispatch pipeline's error handling.
 * @param {StartTaskContext} ctx
 * @param {ReturnType<typeof resolveStartTaskLaunch>} launchInfo
 * @param {Task} task
 */
function spawnTaskChild(ctx, launchInfo, task) {
  const { dispatchLaunch, executor, launchDirectory, promptFilePath, cleanUpScratchFiles } = launchInfo;
  let logFd;
  let child;
  try {
    if (promptFilePath) fs.writeFileSync(promptFilePath, dispatchLaunch.prompt, { mode: 0o600, flag: "wx" });
    logFd = fs.openSync(task.logPath, "a", 0o600);
    fs.chmodSync(task.logPath, 0o600);
    const plan = resolveSpawnPlan(ctx, launchInfo);
    const sandbox = buildSandboxedSpawn(ctx, launchInfo, plan, task);
    // No tmux: the child has no shared session to introspect. It is its own
    // process group so cancellation can stop any subprocesses it creates.
    // stdout is normalized line-by-line through executor.normalizeLogEvent
    // before it reaches the log file; stderr writes straight to the log fd.
    child = ctx.spawnFn(sandbox.spawnCommand, sandbox.spawnArgs, {
      cwd: launchDirectory,
      stdio: ["ignore", "pipe", logFd],
      detached: true,
      env: sandbox.spawnEnv,
    });
    // Capture the fd so the stdout handler can keep writing to it until the
    // child exits; closing it here (as the pre-refactor code did) would break
    // the handler's fs.writeSync before the child has a chance to drain.
    const shared = /** @type {SharedChildState} */ ({
      settled: false,
      capturedLogFd: logFd,
      stdoutCarry: "",
      child,
      task,
      executor,
      cleanUpScratchFiles,
    });
    // stdio[1] = "pipe" guarantees stdout is non-null for the real
    // child_process.ChildProcess. Test fakes also expose a stdout
    // EventEmitter via fakeChild().
    const childStdout = /** @type {import("node:stream").Readable} */ (child.stdout);
    childStdout.on("data", (chunk) => onChildData(shared, chunk));
    childStdout.on("end", () => onChildEnd(shared));
    child.on("exit", (code, signal) => onChildExit(ctx, shared, code, signal));
    child.on("error", (err) => onChildError(ctx, shared, err));
    task.status = "running";
    task.pid = child.pid ?? null;
    ctx.incRunning();
    ctx.persistTask(task.id);
    ctx.scheduleActivity(task, { force: true });
    ctx.startRunningWatcher(task);
    child.unref();
  } catch (err) {
    if (logFd != null) fs.closeSync(logFd);
    task.status = "crashed";
    task.spawnError = errMessage(err);
    task.endedAt = new Date().toISOString();
    if (child?.pid != null) ctx.sendSignal(child.pid, "SIGKILL");
    // Mirrors the child.on("error") spawn-failure path above: a sync throw
    // from spawnFn (or resolvePreDispatchHead / any other code in this try
    // block after overlay creation) lands here AFTER overlayDirs was set, so
    // the overlay would otherwise sit on the tmpfs with no extraction ever
    // booked against it. extractChangesetForTask is internally error-safe and
    // on an empty overlay produces the correct terminal state. Doing this
    // BEFORE the explicit persistTask() below ensures the durable record
    // reflects the post-extract changesetStatus.
    ctx.extractChangesetForTask(task);
    ctx.persistTask(task.id);
    void ctx.scheduleActivity(task, { force: true }).then(() => ctx.activityCache.evictTask(task.id));
    ctx.logHasEventCache.delete(task.logPath);
    try {
      cleanUpScratchFiles();
    } catch (cleanupErr) {
      // Same reasoning as finishChildSettlement's cleanUpScratchFiles guard
      // above: a non-ENOENT unlink failure here must not throw out of this
      // spawn-failure catch block, which would crash the daemon the same way
      // an unguarded call in the exit handler would.
      console.error(`taskferry: failed to clean up scratch files for task ${task.id}: ${errMessage(cleanupErr)}`);
    }
    ctx.settleWaiters(task.id);
  }
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
 * The subset of `createTaskManager`'s closure that `result`'s extracted
 * helper pipeline needs threaded in explicitly. Keeping the factory's inner
 * `result` a thin wrapper and moving the heavy lifting to module-level
 * functions (the same extraction pattern the `startTask` helpers use) lets
 * each helper stay under the family's complexity / max-lines-per-function
 * ceilings on its own instead of concentrating them in one 99-line method.
 * @typedef {object} ResultContext
 * @property {(task: Task) => {failureReason: string|null, failureDetail: string|null}} failureFields
 * @property {(diffPath: string, runCommand: (command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}) => {files: number, additions: number, deletions: number}} computeDiffStat
 * @property {(command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} runOverlayCommandFn
 */

/**
 * Validate the `--fields`/`--full` projection options before any detail
 * building runs. Mirrors the user-facing error strings the CLI surfaces for
 * an unsupported field list or a `--full` request that omits `narration`.
 * @param {boolean} full
 * @param {string[]} [fields]
 */
function validateResultFields(full, fields) {
  if (fields != null) {
    if (!Array.isArray(fields) || !fields.length || fields.some((field) => !TASK_MANAGER_RESULT_FIELDS.has(field))) {
      throw new Error(`error: fields must contain one or more supported result fields\nhelp: use one of: ${[...TASK_MANAGER_RESULT_FIELDS].join(", ")}`);
    }
    if (full && !fields.includes("narration")) {
      throw new Error("error: full requires narration in fields\nhelp: omit full or include narration in fields");
    }
  }
}

/**
 * Parse a task log's NDJSON lines into the accumulated session/usage/step
 * state that `result` reports. Extracted out of `result` because the loop's
 * branching (text events keyed by messageID, step_finish usage accumulation,
 * `stop`-reason tracking) is the single largest cyclomatic contributor to the
 * old monolithic function. `sumTokens` is module-level, so it needs no ctx.
 * @param {string} raw
 * @param {string|null} initialSessionId
 * @returns {{sessionId: string|null, tokens: unknown, cost: number|null, textByMessageId: Map<string, string[]>, textOrder: string[], finalMessageId: string|null}}
 */
function parseTaskLog(raw, initialSessionId) {
  const parsed = {
    sessionId: initialSessionId,
    tokens: null,
    cost: null,
    textByMessageId: new Map(),
    textOrder: [],
    finalMessageId: null,
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    consumeLogLine(line, parsed);
  }
  return parsed;
}

/**
 * Parse and dispatch a single NDJSON line into the running `parsed` state.
 * Decomposed out of the loop (which otherwise carried the bulk of `result`'s
 * cognitive/cyclomatic cost) so each event-type handler stays flat. Non-JSON
 * lines (e.g. a crash stack trace on stderr, interleaved into the same fd)
 * are skipped.
 * @param {string} line
 * @param {{sessionId: string|null, tokens: unknown, cost: number|null, textByMessageId: Map<string, string[]>, textOrder: string[], finalMessageId: string|null}} parsed
 */
function consumeLogLine(line, parsed) {
  /** @type {any} */
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  if (evt.sessionID) parsed.sessionId = evt.sessionID;
  if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
    accumulateTextEvent(evt, parsed);
  }
  if (evt.type === "step_finish" && evt.part) {
    accumulateStepFinishEvent(evt, parsed);
  }
}

/**
 * Accumulate a text event under its messageID (creating the bucket on first
 * sight and recording order), matching how `result` glues one step's narration.
 * @param {any} evt
 * @param {{textByMessageId: Map<string, string[]>, textOrder: string[]}} parsed
 */
function accumulateTextEvent(evt, parsed) {
  const mid = evt.part.messageID;
  if (!parsed.textByMessageId.has(mid)) {
    parsed.textByMessageId.set(mid, []);
    parsed.textOrder.push(mid);
  }
  /** @type {string[]} */ (parsed.textByMessageId.get(mid)).push(evt.part.text);
}

/**
 * Accumulate a step_finish event's usage/token/cost deltas and record the
 * messageID whose step ended in reason "stop" as the final turn.
 * @param {any} evt
 * @param {{tokens: unknown, cost: number|null, finalMessageId: string|null}} parsed
 */
function accumulateStepFinishEvent(evt, parsed) {
  if (evt.part.tokens) parsed.tokens = sumTokens(parsed.tokens, evt.part.tokens);
  if (typeof evt.part.cost === "number") parsed.cost = (parsed.cost ?? 0) + evt.part.cost;
  if (evt.part.reason === "stop") parsed.finalMessageId = evt.part.messageID;
}

/**
 * Shape the final `message`/`narration` pair from the parsed log state.
 * `message` is only the messageID whose step ended in `stop` (falling back to
 * the last messageID seen for crashed runs); everything earlier is kept as
 * `narration`, preview-truncated unless `--full` is set.
 * @param {{textByMessageId: Map<string, string[]>, textOrder: string[], finalMessageId: string|null}} parsed
 * @param {boolean} full
 * @returns {{message: string, narration: string, narrationTotalChars: number, narrationTruncated: boolean}}
 */
function shapeNarration(parsed, full) {
  const { textByMessageId, textOrder, finalMessageId } = parsed;
  const targetId = finalMessageId ?? textOrder[textOrder.length - 1];
  const message = targetId && textByMessageId.has(targetId) ? /** @type {string[]} */ (textByMessageId.get(targetId)).join("") : "";
  const fullNarration = textOrder.map((mid) => /** @type {string[]} */ (textByMessageId.get(mid)).join("")).join("\n\n");
  const truncated = !full && fullNarration.length > NARRATION_PREVIEW_CHARS;
  const narration = truncated ? fullNarration.slice(0, NARRATION_PREVIEW_CHARS) + "…" : fullNarration;
  return { message, narration, narrationTotalChars: fullNarration.length, narrationTruncated: truncated };
}

/**
 * Read the task's diff and diffStat. `diff` is copied from disk verbatim;
 * `diffStat` is routed through `computeDiffStat` (the same `git apply
 * --numstat` parser used for both git and non-git changesets), independently
 * of whether `diff` itself was requested, matching the original projection
 * rules.
 * @param {Task} task
 * @param {ResultContext} ctx
 * @param {string[]} [fields]
 * @returns {{diffText: string|null, diffStat: {files: number, additions: number, deletions: number}|null}}
 */
function readTaskDiff(task, ctx, fields) {
  let diffText = null;
  if (task.diffPath && (fields == null || fields.includes("diff"))) {
    try {
      diffText = fs.readFileSync(task.diffPath, "utf8");
    } catch {
      diffText = null;
    }
  }
  const diffStat = task.diffPath != null && (fields == null || fields.includes("diffStat")) ? ctx.computeDiffStat(task.diffPath, ctx.runOverlayCommandFn) : null;
  return { diffText, diffStat };
}

/**
 * Build the full `ResultDetail` for an already-finished (not running/queued)
 * task from its parsed log, narration, and diff. The conditional extra fields
 * (`summaryOf`/`incomplete`/`finalMarker`) and the `next` guidance stay here;
 * the heavy parsing/reading work is delegated to the helpers above so no
 * single function crosses the complexity ceiling.
 * @param {Task} task
 * @param {{taskId: string, full: boolean, fields?: string[]}} options
 * @param {ResultContext} ctx
 * @returns {ResultDetail}
 */
function computeResultDetail(task, { taskId, full, fields }, ctx) {
  let raw;
  try {
    raw = fs.readFileSync(task.logPath, "utf8");
  } catch {
    raw = "";
  }
  const parsed = parseTaskLog(raw, task.sessionId);
  const narration = shapeNarration(parsed, full);
  const { diffText, diffStat } = readTaskDiff(task, ctx, fields);
  const next = resultNextAction(task, taskId, narration.narrationTruncated);
  return {
    taskId,
    status: task.status,
    exitCode: task.exitCode,
    signal: task.signal,
    spawnError: task.spawnError,
    ...ctx.failureFields(task),
    diff: diffText,
    diffStat,
    changesetError: task.changesetError ?? null,
    sessionId: parsed.sessionId,
    tokens: parsed.tokens,
    cost: parsed.cost,
    message: narration.message,
    narration: narration.narration,
    narrationTotalChars: narration.narrationTotalChars,
    narrationTruncated: narration.narrationTruncated,
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(task.incomplete === true ? { incomplete: true } : {}),
    ...(task.finalMarker != null ? { finalMarker: task.finalMarker } : {}),
    ...(next ? { next } : {}),
    logPath: task.logPath,
  };
}

/**
 * The `next` hint a non-`--full` result surfaces: a clean-but-empty exit
 * (optionally with the required-final-marker mismatch called out) reads as
 * incomplete, otherwise a truncated narration points at `--full`.
 * @param {Task} task
 * @param {string} taskId
 * @param {boolean} narrationTruncated
 * @returns {string | null}
 */
function resultNextAction(task, taskId, narrationTruncated) {
  if (task.incomplete === true) {
    const markerNote = task.finalMarker
      ? ` (--require-final-marker ${JSON.stringify(task.finalMarker)} did not match)`
      : " (empty message)";
    return `Task ${taskId} exited cleanly but produced no usable final output${markerNote}; treat as incomplete`;
  }
  if (narrationTruncated) {
    return `Run taskferry result with full: true on task id "${taskId}" to see the complete narration`;
  }
  return null;
}

/**
 * The subset of `createTaskManager`'s closure that `dispatch`'s extracted
 * helper pipeline needs threaded in explicitly -- the same convention the
 * `startTask`/`result` extractions use. `dispatch` is the actual spawn path
 * for every task this tool runs, so its helpers preserve the exact
 * sequencing of side-effecting operations (task-record persistence,
 * pending-launch registration, queue push, and the launch trigger) rather
 * than reordering anything.
 * @typedef {object} DispatchContext
 * @property {Map<string, Task>} tasks
 * @property {(taskId: string) => void} persistTask
 * @property {Map<string, LaunchSpec>} pendingLaunches
 * @property {string[]} launchQueue
 * @property {() => void} launchQueuedTasks
 */

/**
 * On a `sessionId` resume, finds the most recent matching prior task so the
 * dispatch can inherit the executor (and, downstream, the model) the session
 * was actually created under instead of silently falling back to the
 * manager's default. When `--executor` is given explicitly the lookup is
 * scoped to tasks that match it too: session ids are only unique per
 * executor, so an explicit `--executor pi` alongside a sessionId that
 * collides with an unrelated opencode task must not let that opencode task's
 * model leak into this pi dispatch. Equivalent to the original compound
 * condition, decomposed per-field so the expression stays under the
 * expression-complexity ceiling.
 * @param {Map<string, Task>} tasks
 * @param {string|undefined} sessionId
 * @param {string|undefined} executorName
 * @returns {Task|null}
 */
function resolvePriorSessionTask(tasks, sessionId, executorName) {
  /** @type {Task|null} */
  let priorSessionTask = null;
  if (sessionId) {
    for (const t of tasks.values()) {
      if (t.sessionId !== sessionId || (executorName !== undefined && t.executorId !== executorName)) continue;
      if (!priorSessionTask || t.startedAt > priorSessionTask.startedAt) {
        priorSessionTask = t;
      }
    }
  }
  return priorSessionTask;
}

/**
 * Reuses the manager's single pre-built defaultExecutor instance when the
 * inherited/explicit executor matches it, instead of allocating a fresh
 * WorkerExecutor on every session-inheriting resume.
 * @param {Task|null} priorSessionTask
 * @param {string|undefined} executorName
 * @param {import("./executor.js").WorkerExecutor} defaultExecutor
 * @returns {import("./executor.js").WorkerExecutor}
 */
function resolveDispatchExecutor(priorSessionTask, executorName, defaultExecutor) {
  if (executorName !== undefined) {
    return executorName === defaultExecutor.id ? defaultExecutor : resolveExecutor(executorName);
  }
  if (priorSessionTask) {
    return priorSessionTask.executorId === defaultExecutor.id ? defaultExecutor : resolveExecutor(priorSessionTask.executorId);
  }
  return defaultExecutor;
}

/**
 * Validates a dispatch's prompt/directory arguments, matching the
 * user-facing error strings the CLI surfaces for a missing prompt, a
 * non-absolute path, or a nonexistent directory.
 * @param {{prompt: string, directory: string}} params
 */
function validateDispatchParameters({ prompt, directory }) {
  if (!prompt || typeof prompt !== "string") {
    throw new Error("error: prompt is required\nhelp: taskferry dispatch requires a non-empty prompt string");
  }
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error(`error: directory must be an absolute path (got ${JSON.stringify(directory)})\nhelp: pass the full path, e.g. "/workspace/my-repo"`);
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`error: directory does not exist: ${directory}\nhelp: check the path or create the directory first`);
  }
}

/**
 * Validates `--require-final-marker` (a regex source that must compile as a
 * standard JS RegExp) when one is supplied.
 * @param {string|null} finalMarker
 */
function validateDispatchFinalMarker(finalMarker) {
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
}

/**
 * Resolves the dispatch target directory to its real path. Runs after the
 * prompt/finalMarker validation (preserving the original throw order) and
 * surfaces the same user-facing guidance when resolution fails.
 * @param {string} directory
 * @returns {string}
 */
function resolveDispatchDirectory(directory) {
  try {
    return fs.realpathSync(directory);
  } catch (err) {
    throw new Error(`error: directory does not exist: ${directory}\nhelp: check the path or create the directory first (${errMessage(err)})`, { cause: err });
  }
}

/**
 * Builds the queued `Task` record for a dispatch. Task IDs retain the literal
 * `oc_` prefix for compatibility. A resume with no `--model` inherits the
 * model the session was created under (a different model can mean a different
 * provider, breaking the whole point of resuming that exact session).
 * @param {{id: string, directory: string, prompt: string, model: string|undefined, executor: import("./executor.js").WorkerExecutor, priorSessionTask: Task|null, variant: string|undefined, sessionId: string|undefined, originSessionId: string|undefined, internal: boolean, finalMarker: string|null, role: "dispatch"|"advisor", logPath: string}} params
 * @returns {Task}
 */
function buildDispatchTask({ id, directory, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath }) {
  const usingDefaultModel = !model;
  const resolvedModel = model || priorSessionTask?.model || executor.defaultModel;
  return {
    id,
    directory,
    logPath,
    role,
    status: "queued",
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
    promptPreview: prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt,
    promptTotalChars: prompt.length > 200 ? prompt.length : null,
    spawnError: null,
    cancelRequested: false,
    internal: internal === true,
    failureReason: null,
    failureDetail: null,
    incomplete: false,
    finalMarker: finalMarker == null ? null : finalMarker,
    changesetStatus: "none",
    diffPath: null,
    overlayDirs: null,
    preDispatchHead: null,
    changesetError: null,
  };
}

/**
 * Commits a queued dispatch to the manager's shared state in the exact order
 * the monolithic `dispatch` always used: persist the task record, snapshot
 * the caller's env at queue time (freezing it against later caller
 * mutations), register the pending launch, push the queue, and trigger
 * launch. The env snapshot is not redundant with `sanitizedEnvironment()`'s
 * one-pass merge -- that reads Object.keys() and each value lazily at spawn
 * time, so without this snapshot a caller mutating their original env object
 * between queue time and the queued launch's actual spawn would change what
 * reaches the child. Pinned by tasks.test.js's "dispatch()'s queued env is
 * frozen against later caller mutations" gate.
 * @param {DispatchContext} ctx
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
  ctx.launchQueue.push(id);
  ctx.launchQueuedTasks();
}


/**
 * The subset of `createTaskManager`'s closure that `summarizeTask`'s
 * extracted helper pipeline needs threaded in explicitly -- the same
 * convention the `startTask`/`result`/`dispatch` extractions use. Each
 * helper reads only what it is handed, so the task's fault lines (reserve
 * enforcement, session/watermark resolution, narration building, and the
 * summary launch itself) each stay a standalone module-level function rather
 * than one monolithic 142-line method.
 * @typedef {object} SummarizeTaskContext
 * @property {() => void} ensureStateLoaded
 * @property {Map<string, Task>} tasks
 * @property {(taskId: string) => Error} noSuchTask
 * @property {number} summaryConcurrencyLimit
 * @property {{getSummarySessionId: (taskId: string) => string|null, getLastSummarizedWatermark: (taskId: string) => number, clearSummaryState: (taskId: string) => void}} activityCache
 * @property {string} activitySummaryModel
 * @property {(model: string, env: NodeJS.ProcessEnv) => Promise<void>} summaryModelAvailable
 * @property {(logPath: string) => {narration: string, sourceLogBytes: number, inputBytes: number}} readNarrationExcerpt
 * @property {string} LOG_DIR
 * @property {string} SUMMARY_DIR
 * @property {(taskId: string) => void} persistTask
 * @property {Map<string, LaunchSpec>} pendingLaunches
 * @property {() => import("./executor.js").WorkerExecutor} opencodeExecutor
 * @property {string[]} launchQueue
 * @property {() => void} launchQueuedTasks
 */

/**
 * Enforce the summarizer concurrency reserve when the caller opts in (the
 * activity-refresh path). Returns `undefined` to let the launch proceed, or
 * the early-return result object when the reserve stays full through the
 * brief retry window. A direct `taskferry summary` call never opts in and
 * always runs, matching the original semantics. At a small concurrencyLimit
 * two tasks finishing within moments of each other would otherwise have the
 * second one's summary dropped outright instead of merely delayed, so retry
 * briefly before giving up.
 * @param {SummarizeTaskContext} ctx
 * @param {{taskId: string, source: Task, respectConcurrencyReserve: boolean}} opts
 * @returns {Promise<{sourceTaskId: string, sourceStatus: string, summary: string, next: string}|undefined>}
 */
async function enforceSummaryReserve(ctx, { taskId, source, respectConcurrencyReserve }) {
  if (!respectConcurrencyReserve) return undefined;
  const countInFlightSummaries = () => {
    let count = 0;
    for (const t of ctx.tasks.values()) {
      if (t.summaryOf && (t.status === "running" || t.status === "queued")) count++;
    }
    return count;
  };
  const RESERVE_RETRY_ATTEMPTS = 4;
  const RESERVE_RETRY_DELAY_MS = 500;
  for (let attempt = 0; attempt < RESERVE_RETRY_ATTEMPTS; attempt++) {
    if (countInFlightSummaries() < ctx.summaryConcurrencyLimit) return undefined;
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
  return undefined;
}

/**
 * Resolve the continuation session id and last-summarized watermark for a
 * task, falling back to the activity cache when the caller doesn't supply
 * explicit values, and stat the source log. If the log shrank (rotation or
 * truncation) the cached session/watermark no longer refer to readable
 * bytes, so the state is cleared and the next pass restarts fresh -- the
 * only safe interpretation of "watermark is in the future relative to the
 * log."
 * @param {SummarizeTaskContext} ctx
 * @param {Task} source
 * @param {string} taskId
 * @param {{summarySessionId?: string|null, lastSummarizedWatermark?: number|null}} options
 * @returns {{resolvedSummarySessionId: string|null, resolvedWatermark: number, currentSize: number}}
 */
function resolveSummarySession(ctx, source, taskId, { summarySessionId, lastSummarizedWatermark }) {
  let resolvedSummarySessionId = summarySessionId !== undefined
    ? summarySessionId
    : ctx.activityCache.getSummarySessionId(taskId);
  let resolvedWatermark = lastSummarizedWatermark !== undefined && lastSummarizedWatermark !== null
    ? lastSummarizedWatermark
    : ctx.activityCache.getLastSummarizedWatermark(taskId);
  let currentSize;
  try {
    currentSize = fs.statSync(source.logPath).size;
  } catch {
    currentSize = 0;
  }
  if (resolvedWatermark > currentSize) {
    ctx.activityCache.clearSummaryState(taskId);
    resolvedSummarySessionId = null;
    resolvedWatermark = 0;
  }
  return { resolvedSummarySessionId, resolvedWatermark, currentSize };
}

/**
 * Build the input narration for the summary launch: a delta of only the new
 * bytes since the last watermark when a session is being continued, otherwise
 * the bounded head+tail excerpt. Early-returns (via `skip`) with the "no
 * model text" result when the log has no narration and prompt fallback is
 * disallowed; otherwise falls back to the task's prompt preview as the
 * narration.
 * @param {SummarizeTaskContext} ctx
 * @param {Task} source
 * @param {string} taskId
 * @param {{resolvedSummarySessionId: string|null, resolvedWatermark: number, currentSize: number}} session
 * @param {boolean} allowPromptFallback
 * @returns {{snapshot: {narration: string, sourceLogBytes: number, inputBytes: number}, isDelta: boolean, skip?: {sourceTaskId: string, sourceStatus: string, summary: string, help: string}}}
 */
function buildSummarySnapshot(ctx, source, taskId, { resolvedSummarySessionId, resolvedWatermark, currentSize }, allowPromptFallback) {
  /** @type {{narration: string, sourceLogBytes: number, inputBytes: number}} */
  let snapshot;
  let isDelta = false;
  if (resolvedSummarySessionId && resolvedWatermark > 0 && currentSize > resolvedWatermark) {
    const delta = readDeltaNarration(source.logPath, resolvedWatermark);
    snapshot = delta;
    isDelta = true;
  } else {
    snapshot = ctx.readNarrationExcerpt(source.logPath);
  }
  if (!snapshot.narration && !allowPromptFallback) {
    return {
      snapshot,
      isDelta,
      skip: {
        sourceTaskId: taskId,
        sourceStatus: source.status,
        summary: "no model text observed yet",
        help: `Run taskferry tail with task id "${taskId}" after the task emits output`,
      },
    };
  }
  if (!snapshot.narration) {
    const prompt = source.promptPreview || "No model output observed yet.";
    snapshot.narration = `Task prompt: ${prompt}`;
    snapshot.inputBytes = Buffer.byteLength(snapshot.narration);
  }
  return { snapshot, isDelta };
}

/**
 * Create and enqueue the summary child task: build the unique id/log/snapshot
 * paths, write the snapshot JSON (mode 0600, exclusive-create), register the
 * queued Task, persist it, stage the summary LaunchSpec, push it onto the
 * queue, and trigger the launch. Returns the success result object exactly as
 * the original method did. The summary env itself is recomputed at spawn time
 * by startTask, so only the defensive caller-env clone is staged here.
 * @param {SummarizeTaskContext} ctx
 * @param {{taskId: string, source: Task, snapshot: {narration: string, sourceLogBytes: number, inputBytes: number}, isDelta: boolean, capturedAt: string, sourceStatus: string, maxWords: number, previousActivity: string|null, resolvedSummarySessionId: string|null, queuedCallerEnv: NodeJS.ProcessEnv|undefined}} p
 * @returns {{sourceTaskId: string, sourceStatus: string, capturedAt: string, sourceLogBytes: number, summaryInputBytes: number, summaryTask: {id: string, status: string, model: string}, next: string}}
 */
function launchSummaryTask(ctx, p) {
  const { taskId, source, snapshot, isDelta, capturedAt, sourceStatus, maxWords, previousActivity, resolvedSummarySessionId, queuedCallerEnv } = p;
  const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const logPath = path.join(ctx.LOG_DIR, `${id}.ndjson`);
  const snapshotPath = path.join(ctx.SUMMARY_DIR, `${id}.json`);
  /** @type {SummaryOf} */
  const summaryOf = {
    sourceStatus,
    capturedAt,
    maxWords,
    sourceTaskId: taskId,
    sourceLogBytes: snapshot.sourceLogBytes,
    summaryInputBytes: snapshot.inputBytes,
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
    logPath,
    summaryOf,
    status: "queued",
    directory: fs.realpathSync(ctx.SUMMARY_DIR),
    model: ctx.activitySummaryModel,
    executorId: "opencode", // summaries stay opencode-only in this issue -- see plan Verified Findings #10
    variant: null,
    sessionId: null,
    originSessionId: null,
    pid: null,
    startedAt: capturedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    promptPreview: "Summarize the attached task transcript.",
    promptTotalChars: null,
    spawnError: null,
    cancelRequested: false,
    internal: true,
    failureReason: null,
    failureDetail: null,
  };
  ctx.tasks.set(id, task);
  ctx.persistTask(task.id);
  ctx.pendingLaunches.set(id, {
    kind: "summary",
    model: ctx.activitySummaryModel,
    snapshotPath,
    env: queuedCallerEnv,
    executor: ctx.opencodeExecutor(),
    ...(resolvedSummarySessionId ? { summarySessionId: resolvedSummarySessionId } : {}),
  });
  ctx.launchQueue.push(id);
  ctx.launchQueuedTasks();
  return {
    sourceStatus,
    capturedAt,
    sourceTaskId: taskId,
    sourceLogBytes: snapshot.sourceLogBytes,
    summaryInputBytes: snapshot.inputBytes,
    summaryTask: { id, status: task.status, model: task.model },
    next: `Run taskferry wait with task id "${id}", then taskferry result with task id "${id}"`,
  };
}

/**
 * The subset of `createTaskManager`'s closure that `summarizeActivity`'s
 * extracted helper pipeline needs threaded in explicitly -- the same
 * convention the `summarizeTask`/`startTask`/`result`/`dispatch` extractions
 * use. The retry-on-stale-session flow is best-effort by design (a summary is
 * an advisory feature, never a hard dependency of the underlying task's
 * status), so the helpers only touch the activity cache and the summary-task
 * lifecycle.
 * @typedef {object} SummarizeActivityContext
 * @property {() => Promise<void>} checkSummaryModelReady
 * @property {{getSummarySessionId: (taskId: string) => string|null, clearSummaryState: (taskId: string) => void}} activityCache
 * @property {(taskId: string, options: object) => Promise<{summaryTask?: {id: string}}>} summarizeTask
 * @property {(taskId: string, options: object) => Promise<{status: string, sessionId?: string|null}>} poll
 * @property {Map<string, Task>} tasks
 * @property {(taskId: string, options: object) => {message?: string}} result
 * @property {(taskId: string) => void} cancel
 * @property {number} MAX_WAIT_MS
 */

/**
 * Run a single summarize attempt and reduce its three-step shape (spawn,
 * poll, read the message) into one result. Used both for the first attempt
 * and for the stale-session continuation retry; the retry simply passes
 * explicit `summarySessionId: null` / `lastSummarizedWatermark: 0` to force a
 * fresh no-continuation launch. Returns `{spawned: false}` when the launch
 * never produced a summary task (so the caller can clear the bad session
 * state), otherwise the settled status, session id, and message text.
 * @param {SummarizeActivityContext} ctx
 * @param {{taskId: string, maxWords: number, previousActivity: string|null|undefined, summarySessionId?: string|null, lastSummarizedWatermark?: number|null}} opts
 * @returns {Promise<{spawned: false}|{spawned: true, settled: {status: string, sessionId?: string|null}, sessionId: string|null, text: string, summaryTaskId: string}>}
 */
async function runSummarizeActivityAttempt(ctx, { taskId, maxWords, previousActivity, summarySessionId, lastSummarizedWatermark }) {
  const started = await ctx.summarizeTask(taskId, {
    maxWords,
    allowPromptFallback: true,
    previousActivity,
    ...(summarySessionId !== undefined ? { summarySessionId } : {}),
    ...(lastSummarizedWatermark !== undefined ? { lastSummarizedWatermark } : {}),
    respectConcurrencyReserve: true,
  });
  if (!started.summaryTask?.id) return { spawned: false };
  const settled = await ctx.poll(started.summaryTask.id, { timeoutMs: ctx.MAX_WAIT_MS });
  const summaryTask = ctx.tasks.get(started.summaryTask.id);
  const sessionId = summaryTask?.sessionId || null;
  const detail = ctx.result(started.summaryTask.id, { fields: ["message"] });
  const text = settled.status === "done" && typeof detail.message === "string" ? detail.message : "";
  return { settled, sessionId, text, spawned: true, summaryTaskId: started.summaryTask.id };
}

/**
 * The stale-session continuation path: the first attempt took but opencode
 * rejected the cached session id (or silently started a new one / crashed
 * before logging one), so the prior session id is no longer usable for this
 * source task. Discard the first attempt's possibly-misleading output, cancel
 * it if it is still occupying a concurrency slot, and relaunch with no
 * continuation. Every failed outcome clears the cached summary state so the
 * next pass retries from scratch. Best-effort by design.
 * @param {SummarizeActivityContext} ctx
 * @param {{taskId: string, maxWords: number, previousActivity: string|null|undefined, first: {spawned: true, settled: {status: string, sessionId?: string|null}, sessionId: string|null, text: string, summaryTaskId: string}}} opts
 * @returns {Promise<{text: string, sessionId: string|null}>}
 */
async function runContinuationRetry(ctx, { taskId, maxWords, previousActivity, first }) {
  const source = ctx.tasks.get(taskId);
  if (!source) return { text: "", sessionId: null };
  // The first attempt may still be running (it hit the poll timeout rather
  // than settling). Cancel it before launching the retry so both don't occupy
  // a concurrency slot at once.
  if (first.settled.status === "running") {
    try {
      ctx.cancel(first.summaryTaskId);
    } catch {
      // Settled or gone between the poll timeout and here: both fine.
    }
  }
  const retry = await runSummarizeActivityAttempt(ctx, { taskId, maxWords, previousActivity, summarySessionId: null, lastSummarizedWatermark: 0 });
  if (!retry.spawned || retry.settled.status !== "done" || !retry.text) {
    // Both attempts failed to even spawn, or the retry settled without a
    // usable summary. Signal the failure so the cache clears the bad session
    // id and retries from scratch later.
    ctx.activityCache.clearSummaryState(taskId);
    return { text: "", sessionId: null };
  }
  return { text: retry.text, sessionId: retry.sessionId };
}

/**
 * Run the first summarize attempt, then decide whether continuation is even
 * worth attempting. Continuation is skipped when there was no cached session
 * id to continue, or when opencode actually honored the requested `--session`
 * (logged the same session id back) -- in both cases the first attempt's
 * output is trusted. Otherwise fall through to the stale-session retry.
 * @param {SummarizeActivityContext} ctx
 * @param {{taskId: string, maxWords: number, previousActivity: string|null|undefined, continueSessionId: string|null}} opts
 * @returns {Promise<{text: string, sessionId: string|null}>}
 */
async function summarizeActivityAttempt(ctx, { taskId, maxWords, previousActivity, continueSessionId }) {
  const first = await runSummarizeActivityAttempt(ctx, { taskId, maxWords, previousActivity });
  if (!first.spawned) return { text: "", sessionId: null };
  // No continuation was attempted, or the continuation actually took
  // (opencode honored --session and logged the same session id back): trust
  // the first attempt's output.
  const continuationTook = !continueSessionId || (first.settled.status === "done" && first.sessionId === continueSessionId);
  if (continuationTook) return { text: first.text, sessionId: first.sessionId };
  return runContinuationRetry(ctx, { taskId, maxWords, previousActivity, first });
}

/**
 * The module-level body of `createTaskManager`'s `summarizeActivity` method.
 * Run the model-availability check up front (outside the try/catch below --
 * that catch exists for the stale-session retry logic, while a genuine
 * "model unavailable" error must propagate instead of being swallowed into an
 * empty result), then attempt the summary with an optional stale-session
 * retry. Any unexpected failure clears the cached session state and returns an
 * empty result.
 * @param {SummarizeActivityContext} ctx
 * @param {string} taskId
 * @param {number} maxWords
 * @param {string|null} [previousActivity]
 * @returns {Promise<{text: string, sessionId: string|null}>}
 */
async function runSummarizeActivity(ctx, taskId, maxWords, previousActivity) {
  await ctx.checkSummaryModelReady();
  const continueSessionId = ctx.activityCache.getSummarySessionId(taskId);
  try {
    return await summarizeActivityAttempt(ctx, { taskId, maxWords, previousActivity, continueSessionId });
  } catch {
    ctx.activityCache.clearSummaryState(taskId);
    return { text: "", sessionId: null };
  }
}

/**
 * The subset of `createTaskManager`'s closure that the `advisor` extraction
 * needs threaded in explicitly. Advisor reuses `dispatch` (with `role:
 * "advisor"`), `poll`, `result`, and the advisor-session helpers, plus the
 * errMessage rewrap and the max-wait poll deadline.
 * @typedef {object} AdvisorContext
 * @property {() => void} ensureStateLoaded
 * @property {(sessionId: string|undefined) => {sessionId: string|undefined, reset: boolean, previousSessionId: string|undefined}} resolveAdvisorSession
 * @property {(params: {prompt: string, directory: string, model?: string, variant?: string, sessionId?: string|undefined, executor?: string, env?: NodeJS.ProcessEnv, role: "advisor"}) => TaskSummary & {next: string}} dispatch
 * @property {(err: unknown) => string} errMessage
 * @property {(taskId: string, options: object) => Promise<{status: string, sessionId?: string|null}>} poll
 * @property {number} maxWait
 * @property {(logPath: string) => string|null} readSessionIdFromLog
 * @property {(sessionId: string|undefined) => void} touchAdvisorSession
 * @property {(taskId: string, options: object) => {status: string, message?: string, sessionId?: string|null, tokens?: unknown, cost?: number|null, exitCode?: number|null, signal?: NodeJS.Signals|null, spawnError?: string|null}} result
 */

/**
 * Dispatch an advisor-role task, rewrapping any dispatch error so the
 * advisory's error text references `taskferry advisor` rather than `taskferry
 * dispatch`. Overlay is mandatory for the advisor role, so it is not a
 * parameter here -- the role itself carries that guarantee.
 * @param {AdvisorContext} ctx
 * @param {{prompt?: string, directory?: string, model?: string, variant?: string, sessionId?: string|undefined, executor?: string, env?: NodeJS.ProcessEnv}} params
 * @returns {TaskSummary & {next: string}}
 */
function dispatchAdvisorTask(ctx, params) {
  const { prompt, directory, model, variant, sessionId, executor, env } = params;
  try {
    return ctx.dispatch({ model, variant, sessionId, executor, env, prompt: /** @type {string} */ (prompt), directory: /** @type {string} */ (directory), role: "advisor" });
  } catch (err) {
    throw new Error(ctx.errMessage(err).replaceAll("taskferry dispatch", "taskferry advisor"), { cause: err });
  }
}

/**
 * Accumulates a single parseable log line's narration contribution. Text
 * parts are concatenated per message id so a message split across multiple
 * events reads as one block; tool-use parts are recorded in order.
 * @param {any} evt
 * @param {Map<string, string[]>} textByMessageId
 * @param {Array<{kind: "text", mid: string}|{kind: "tool", line: string}>} order
 */
function collectNarrationLine(evt, textByMessageId, order) {
  if (evt.type === "text" && typeof evt.part?.text === "string") {
    const mid = evt.part.messageID;
    if (!textByMessageId.has(mid)) {
      textByMessageId.set(mid, []);
      order.push({ kind: "text", mid });
    }
    /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
  }
  if (evt.type === "tool_use" && evt.part?.type === "tool") {
    order.push({ kind: "tool", line: formatToolEventForNarration(evt.part) });
  }
}

/**
 * Reads up to `bytes` from the head of a log and reports whether any
 * complete parseable JSON event line was present. A read failure or a
 * closed-out fd is treated as "no event" rather than thrown.
 * @param {string} logPath
 * @param {number} bytes
 * @returns {boolean}
 */
function scanLogForEvent(logPath, bytes) {
  /** @type {number|undefined} */
  let fd;
  try {
    const buffer = Buffer.alloc(bytes);
    fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, bytes, 0);
    for (const line of buffer.toString("utf8").split("\n")) {
      if (line.trim() && isParseableJson(line)) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** Return the first truthy sessionID parsed from `text`, or null. @param {string} text @returns {string|null} */
function sessionIdInJson(text) {
  try {
    const evt = JSON.parse(text);
    return evt.sessionID ? evt.sessionID : null;
  } catch {
    return null;
  }
}

/**
 * Shape the response for an advisor task that is still running or queued.
 * When a session id is known (from the poll result or the log), keep it warm
 * in the advisor-session map so a follow-up call can continue it.
 * @param {AdvisorContext} ctx
 * @param {{settled: {status: string, sessionId?: string|null}, dispatched: TaskSummary & {next: string}, resolved: {reset: boolean, previousSessionId: string|undefined}}} p
 * @returns {object}
 */
function buildAdvisorActiveResponse(ctx, { settled, dispatched, resolved }) {
  const logSessionId = settled.sessionId || ctx.readSessionIdFromLog(dispatched.logPath);
  if (logSessionId) ctx.touchAdvisorSession(logSessionId);
  const resetFields = resolved.reset ? { previous_session_id: resolved.previousSessionId } : {};
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

/**
 * Shape the response for an advisor task that has settled. Reads the full
 * result (message/sessionId/tokens/cost/exitCode/signal/spawnError), keeps a
 * returned session id warm, and projects the tokens/cost only on `done` and
 * the failure fields only on any other status.
 * @param {AdvisorContext} ctx
 * @param {{dispatched: TaskSummary & {next: string}, resolved: {reset: boolean, previousSessionId: string|undefined}}} p
 * @returns {object}
 */
function buildAdvisorSettledResponse(ctx, { dispatched, resolved }) {
  const detail = ctx.result(dispatched.id, { fields: ["message", "sessionId", "tokens", "cost", "exitCode", "signal", "spawnError"] });
  if (detail.sessionId) ctx.touchAdvisorSession(detail.sessionId);
  const resetFields = resolved.reset ? { previous_session_id: resolved.previousSessionId } : {};
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

/**
 * The module-level body of `createTaskManager`'s `advisor` method. Validate
 * the model, resolve the advisor session (possibly forcing a reset), dispatch
 * the advisor-role task, poll it to settlement, and shape either the
 * still-active or settled response.
 * @param {AdvisorContext} ctx
 * @param {{prompt?: string, directory?: string, model?: string, variant?: string, sessionId?: string, timeoutMs?: number, executor?: string, env?: NodeJS.ProcessEnv}} params
 * @returns {Promise<object>}
 */
async function runAdvisor(ctx, { prompt, directory, model, variant, sessionId, timeoutMs, executor, env } = {}) {
  ctx.ensureStateLoaded();
  if (!model || typeof model !== "string") {
    throw new Error("error: model is required\nhelp: taskferry advisor requires a provider/model string, e.g. \"openai/gpt-5.6-sol\"");
  }
  const resolved = ctx.resolveAdvisorSession(sessionId);
  const dispatched = dispatchAdvisorTask(ctx, { prompt, directory, model, variant, executor, env, sessionId: resolved.sessionId });
  const settled = await ctx.poll(dispatched.id, { timeoutMs: timeoutMs ?? ctx.maxWait });
  if (settled.status === "running" || settled.status === "queued") {
    return buildAdvisorActiveResponse(ctx, { settled, dispatched, resolved });
  }
  return buildAdvisorSettledResponse(ctx, { dispatched, resolved });
}

/**
 * Drains complete `\n`-terminated lines out of `carry`, returning the first
 * session id found (with the still-pending remainder) or the remainder alone.
 * @param {string} carry
 * @returns {{sessionId: string|null, remainder: string}}
 */
function extractSessionId(carry) {
  let nl;
  while ((nl = carry.indexOf("\n")) !== -1) {
    const line = carry.slice(0, nl);
    carry = carry.slice(nl + 1);
    const sessionId = line.trim() ? sessionIdInJson(line) : null;
    if (sessionId) return { sessionId, remainder: carry };
  }
  return { sessionId: null, remainder: carry };
}

/**
 * Parse a `git apply --numstat` line (`adds\tdels\tpath`) into its two
 * numeric columns, or null when the line is empty or malformed.
 * @param {string} line
 * @returns {{additions: number, deletions: number} | null}
 */
function parseNumstatLine(line) {
  if (!line) return null;
  const firstTab = line.indexOf("\t");
  if (firstTab === -1) return null;
  const secondTab = line.indexOf("\t", firstTab + 1);
  if (secondTab === -1) return null;
  const adds = Number(line.slice(0, firstTab));
  const dels = Number(line.slice(firstTab + 1, secondTab));
  if (Number.isNaN(adds) || Number.isNaN(dels)) return null;
  return { additions: adds, deletions: dels };
}

/**
 * Accumulates one parseable log line's contribution to final-message
 * extraction: text parts by message id, and (when a `step_finish` stop event
 * lands) returns that message id as the final turn.
 * @param {any} evt
 * @param {Map<string, string[]>} textByMessageId
 * @param {string[]} textOrder
 * @returns {string|null}
 */
function collectFinalMessageLine(evt, textByMessageId, textOrder) {
  if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
    const mid = evt.part.messageID;
    if (!textByMessageId.has(mid)) {
      textByMessageId.set(mid, []);
      textOrder.push(mid);
    }
    /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
  }
  if (evt.type === "step_finish" && evt.part && evt.part.reason === "stop") {
    return evt.part.messageID;
  }
  return null;
}

// sharing process-wide state with every other test or the real server.

/**
 * Loads the persisted task records from TASKS_FILE into the manager's live
 * `tasks` map at boot, normalizing each record in place. Extracted out of
 * `createTaskManager`'s `loadPersisted` closure. `setStateLoadError` writes
 * back to the factory's `stateLoadError` binding on a non-ENOENT read
 * failure, matching the original behavior of keeping a broken store from
 * killing the daemon but making every subsequent state-dependent call fail
 * loudly.
 * @param {{TASKS_FILE: string, overlayTmpRoot: string, tasks: Map<string, Task>, taskEvents: {emitState: (task: Task, previousStatus?: string) => void}, setStateLoadError: (err: Error) => void}} ctx
 */
function loadPersistedTasks(ctx) {
  try {
    const raw = fs.readFileSync(ctx.TASKS_FILE, "utf8");
    /** @type {Task[]} */
    const persisted = JSON.parse(raw);
    for (const t of persisted) loadPersistedTask(ctx, t);
    fs.chmodSync(ctx.TASKS_FILE, 0o600);
  } catch (err) {
    if (errCode(err) !== "ENOENT") ctx.setStateLoadError(/** @type {Error} */ (err));
  }
}

/**
 * Normalizes and registers a single persisted task record. The pre-persistence
 * normalization (realpath the directory, degrade running/queued to unknown,
 * default the executor, backfill legacy tmpRoots) is unchanged from the
 * original `loadPersisted` loop body.
 * @param {{overlayTmpRoot: string, tasks: Map<string, Task>, taskEvents: {emitState: (task: Task, previousStatus?: string) => void}}} ctx
 * @param {Task} t
 */
function loadPersistedTask(ctx, t) {
  const previousStatus = t.status;
  if (t.summaryOf) t.internal = true;
  try {
    t.directory = fs.realpathSync(t.directory);
  } catch {
    // A persisted task may outlive a workspace that has since been removed.
  }
  if (t.status === "running" || t.status === "queued") t.status = "unknown";
  if (t.executorId === undefined) t.executorId = "opencode";
  if (t.overlayDirs && t.overlayDirs.tmpRoot === undefined) t.overlayDirs.tmpRoot = ctx.overlayTmpRoot;
  ctx.tasks.set(t.id, t);
  if (t.status !== previousStatus) ctx.taskEvents.emitState(t, previousStatus);
}

/**
 * Collects the set of overlay tmp roots that might contain orphans: the
 * daemon's own overlayTmpRoot plus every root a live task record references.
 * Mirrors the original sweep's root-gathering loop.
 * @param {Map<string, Task>} tasks
 * @param {string} overlayTmpRoot
 * @returns {Set<string>}
 */
function collectOverlayTmpRoots(tasks, overlayTmpRoot) {
  const tmpRoots = new Set([overlayTmpRoot]);
  for (const task of tasks.values()) {
    if (task.overlayDirs?.tmpRoot) tmpRoots.add(task.overlayDirs.tmpRoot);
  }
  return tmpRoots;
}

/**
 * Sweeps every orphaned overlay directory under one tmp root. Extracted from
 * `sweepOrphanedOverlays`' inner loop so each nesting level of the original
 * double loop stays its own standalone helper.
 * @param {{tasks: Map<string, Task>, releaseOverlay: (task: {overlayDirs?: {root: string, tmpRoot: string}|null}) => boolean, persistTask: (taskId: string) => void}} ctx
 * @param {string} tmpRoot
 */
function sweepOverlayTmpRoot(ctx, tmpRoot) {
  let entries;
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const entry of entries) sweepOverlayEntry(ctx, entry, tmpRoot);
}

/**
 * Decides whether a single tmp-root entry is an orphaned overlay and cleans
 * it up if so. A task whose changesetStatus is still "pending" owns its
 * overlay and must never be swept; only unknown ids and already-resolved
 * tasks with a leftover overlayDirs are orphans.
 * @param {{tasks: Map<string, Task>, releaseOverlay: (task: {overlayDirs?: {root: string, tmpRoot: string}|null}) => boolean, persistTask: (taskId: string) => void}} ctx
 * @param {string} entry
 * @param {string} tmpRoot
 */
function sweepOverlayEntry(ctx, entry, tmpRoot) {
  const taskId = entry.startsWith("taskferry-cow-") ? entry.slice("taskferry-cow-".length) : null;
  const task = taskId ? ctx.tasks.get(taskId) : undefined;
  const root = path.join(tmpRoot, entry);
  const ownsThisOverlay = task?.overlayDirs?.root === root;
  const isOwnedPending = ownsThisOverlay && task.changesetStatus === "pending";
  if (!taskId || isOwnedPending) return;
  const cleanupTarget = ownsThisOverlay ? task : { overlayDirs: { root, tmpRoot } };
  const cleanupFailed = ctx.releaseOverlay(cleanupTarget);
  if (!cleanupFailed && ownsThisOverlay) ctx.persistTask(taskId);
}

/**
 * Builds the conditional extra fields for a summarized task (the optional
 * fields the direct summarize path only includes when present). Extracted
 * from `summarize`'s single return statement, which had accumulated eight
 * conditional spreads and driven the function past the cyclomatic ceiling.
 * @param {Task} task
 */
function summarizeOptionalFields(task) {
  const { promptTotalChars, incomplete, finalMarker, executorId } = task;
  return {
    ...(promptTotalChars != null ? { promptTotalChars } : {}),
    ...(task.summaryOf ? { summaryOf: task.summaryOf } : {}),
    ...(incomplete === true ? { incomplete: true } : {}),
    ...(finalMarker != null ? { finalMarker } : {}),
    ...(executorId != null ? { executorId } : {}),
    ...(task.overlayDirs != null ? { overlayDirs: task.overlayDirs } : {}),
    ...(task.changesetError != null ? { changesetError: task.changesetError } : {}),
  };
}

/**
 * Builds the changeset-related conditional field of a summary: only an
 * advisor, or a task whose changeset status is anything other than "none",
 * carries the `role`/`changesetStatus` pair. Split out of
 * `summarizeOptionalFields` because this spread's nested condition kept that
 * helper's cyclomatic count one above the ceiling.
 * @param {Task} task
 */
function summarizeChangesetFields(task) {
  const { changesetStatus, role } = task;
  return changesetStatus != null && (changesetStatus !== "none" || role === "advisor")
    ? { role, changesetStatus }
    : {};
}

/**
 * Prunes launch-timestamps older than the dispatch window off the front of
 * the tracking array, so the rate-limit accounting never counts launches
 * from before the current window.
 * @param {number[]} launchTimes
 * @param {number} dispatchWindow
 */
function pruneStaleLaunchTimes(launchTimes, dispatchWindow) {
  const now = Date.now();
  while (launchTimes.length && launchTimes[0] <= now - dispatchWindow) launchTimes.shift();
}

/**
 * Launches queued tasks while both the per-window dispatch limit and the
 * concurrency limit have headroom. A task that vanished from `tasks` (or is
 * no longer queued) is skipped but still consumed from the queue, matching
 * the original loop.
 * @param {{launchTimes: number[], launchQueue: string[], runningCount: number}} sched
 * @param {{dispatchLimit: number, concurrencyLimit: number, tasks: Map<string, Task>, startTask: (task: Task) => void}} ctx
 */
function drainLaunchQueue(sched, ctx) {
  while (sched.launchQueue.length && sched.launchTimes.length < ctx.dispatchLimit && sched.runningCount < ctx.concurrencyLimit) {
    const id = /** @type {string} */ (sched.launchQueue.shift());
    const task = ctx.tasks.get(id);
    if (!task || task.status !== "queued") continue;
    sched.launchTimes.push(Date.now());
    ctx.startTask(task);
  }
}

/**
 * Arms the next launch tick when the queue is non-empty and no timer is
 * already pending, backing off for the remaining dispatch-window rate delay
 * or a fixed 250ms concurrency delay, whichever is longer.
 * @param {{launchTimer: NodeJS.Timeout|null, launchTimes: number[], launchQueue: string[], runningCount: number}} sched
 * @param {{dispatchLimit: number, dispatchWindow: number, concurrencyLimit: number, reschedule: () => void}} ctx
 */
function scheduleNextLaunch(sched, ctx) {
  if (!sched.launchQueue.length || sched.launchTimer) return;
  const rateDelay = sched.launchTimes.length >= ctx.dispatchLimit ? sched.launchTimes[0] + ctx.dispatchWindow - Date.now() : 0;
  const concurrencyDelay = sched.runningCount >= ctx.concurrencyLimit ? 250 : 0;
  sched.launchTimer = setTimeout(ctx.reschedule, Math.max(1, rateDelay, concurrencyDelay));
}

/**
 * Runs one launch-queue tick: cancel any pending timer, prune stale window
 * timestamps, drain as many queued tasks as the limits allow, then re-arm a
 * timer if the queue still has work. Threads the factory's mutable scheduler
 * state via `sched` so the module-level helpers can read/write `launchTimer`
 * and `runningCount` without closing over the factory.
 * @param {{launchTimer: NodeJS.Timeout|null, launchTimes: number[], launchQueue: string[], runningCount: number}} sched
 * @param {{dispatchLimit: number, dispatchWindow: number, concurrencyLimit: number, tasks: Map<string, Task>, startTask: (task: Task) => void, reschedule: () => void}} ctx
 */
function runLaunchQueuedTasks(sched, ctx) {
  if (sched.launchTimer) {
    clearTimeout(sched.launchTimer);
    sched.launchTimer = null;
  }
  pruneStaleLaunchTimes(sched.launchTimes, ctx.dispatchWindow);
  drainLaunchQueue(sched, ctx);
  scheduleNextLaunch(sched, ctx);
}

/**
 * Validates that a task is in a state where its pending changeset can be
 * accepted, throwing the same user-facing errors the original `accept` raised
 * inline for each guard. Returns whether the target is a git target (i.e. has
 * a persisted pre-dispatch head) so the caller can route the apply.
 * @param {Task} task
 * @param {{existsFn: (path: string) => boolean, hasLiveOverlay: (task: Task) => boolean}} ctx
 * @returns {boolean}
 */
function validateAcceptable(task, ctx) {
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
  return task.preDispatchHead != null;
}

/**
 * Reads the bytes appended to a running task's log since the last watcher
 * tick, updating the shared watch state (bytesRead/carry) and classifying any
 * provider failure in the new chunk. Returns true when a provider failure was
 * found and the task has already been failed (so the tick can bail before the
 * no-output check). Extracted from the watchdog interval's body to keep the
 * interval callback's complexity under the family's ceilings.
 * @param {{bytesRead: number, carry: string, outputSeen: boolean, currentNoOutputTimeout: number, lastActivityMs: number}} state
 * @param {Task} current
 * @param {{failRunningTask: (task: Task, reason: string, detail?: string) => void, scheduleActivity: (task: Task) => Promise<unknown>, postOutputNoOutputTimeout: number}} ctx
 * @returns {boolean}
 */
/**
 * Classifies a freshly-read log chunk (plus the trailing carry line) into a
 * provider failure and whether the chunk contained any parseable JSON line.
 * The carry line is only classified on its own when the main lines yielded no
 * failure and the carry isn't the head of a JSON object (which would be an
 * in-progress line split across ticks).
 * @param {string[]} lines
 * @param {string} carry
 * @param {string} errorBucketPrefix
 * @returns {{failure: {bucket: string, detail: string}|null, hasParseableLine: boolean}}
 */
function resolveChunkProviderFailure(lines, carry, errorBucketPrefix) {
  const linesResult = classifyProviderFailure(lines, errorBucketPrefix);
  const carryResult = !linesResult.failure && carry && !carry.trimStart().startsWith("{")
    ? classifyProviderFailure([carry], errorBucketPrefix)
    : null;
  return {
    failure: linesResult.failure ?? carryResult?.failure ?? null,
    hasParseableLine: linesResult.hasParseableLine,
  };
}

/**
 * Reads the bytes appended to a running task's log since the last watcher
 * tick, updating the shared watch state (bytesRead/carry) and classifying any
 * provider failure in the new chunk. Returns true when a provider failure was
 * found and the task has already been failed (so the tick can bail before the
 * no-output check). Extracted from the watchdog interval's body to keep the
 * interval callback's complexity under the family's ceilings.
 * @param {{bytesRead: number, carry: string, outputSeen: boolean, currentNoOutputTimeout: number, lastActivityMs: number}} state
 * @param {Task} current
 * @param {{failRunningTask: (task: Task, reason: string, detail?: string) => void, scheduleActivity: (task: Task) => Promise<unknown>, postOutputNoOutputTimeout: number}} ctx
 * @returns {boolean}
 */
function consumeWatchdogLogChunk(state, current, ctx) {
  let size;
  try {
    size = fs.statSync(current.logPath).size;
  } catch {
    return false;
  }
  if (size < state.bytesRead) {
    // Log shrank or was replaced out from under us; rescan from scratch.
    state.bytesRead = 0;
    state.carry = "";
  }
  if (size <= state.bytesRead) return false;
  const chunkSize = size - state.bytesRead;
  const buf = Buffer.alloc(chunkSize);
  const fd = fs.openSync(current.logPath, "r");
  try {
    fs.readSync(fd, buf, 0, chunkSize, state.bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  state.bytesRead = size;
  const text = state.carry + buf.toString("utf8");
  const lines = text.split("\n");
  state.carry = lines.pop() ?? "";
  const { failure, hasParseableLine } = resolveChunkProviderFailure(
    lines,
    state.carry,
    resolveExecutor(current.executorId).errorBucketPrefix
  );
  if (failure) {
    ctx.failRunningTask(current, failure.bucket, failure.detail);
    return true;
  }
  if (hasParseableLine) {
    state.lastActivityMs = Date.now();
    if (!state.outputSeen) {
      state.outputSeen = true;
      state.currentNoOutputTimeout = ctx.postOutputNoOutputTimeout;
    }
  }
  void ctx.scheduleActivity(current);
  return false;
}

/**
 * One watchdog tick: re-read the current task, and if it's no longer running
 * tear the watcher down; otherwise consume any new log bytes (failing the
 * task on a provider failure) and enforce the no-output timeout. Errors from
 * log reads (rotated/removed log) are swallowed and retried next tick.
 * @param {{bytesRead: number, carry: string, outputSeen: boolean, currentNoOutputTimeout: number, lastActivityMs: number}} state
 * @param {{taskId: string, tasks: Map<string, Task>, stopRunningWatcher: (taskId: string) => void, failRunningTask: (task: Task, reason: string, detail?: string) => void, scheduleActivity: (task: Task) => Promise<unknown>, postOutputNoOutputTimeout: number}} ctx
 */
function watchdogTick(state, ctx) {
  const current = ctx.tasks.get(ctx.taskId);
  if (!current || current.status !== "running") {
    ctx.stopRunningWatcher(ctx.taskId);
    return;
  }
  try {
    if (consumeWatchdogLogChunk(state, current, ctx)) return;
  } catch {
    // A rotated or removed log is retried on the next watcher tick.
  }
  if (Date.now() - state.lastActivityMs >= state.currentNoOutputTimeout) {
    ctx.failRunningTask(current, "no_output_timeout", `no output for ${state.currentNoOutputTimeout}ms (${state.outputSeen ? "post-output" : "pre-output"} timeout)`);
  }
}


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
            stateDir,
            runtimeDir,
            denyList,
            diffPath,
            directory: finishedTask.directory,
            overlay: { upperDir: finishedTask.overlayDirs.upperDir, workDir: finishedTask.overlayDirs.workDir },
            overlayRwBinds: finishedTask.overlayDirs.rwBinds ?? [],
            overlayRwFileBinds: finishedTask.overlayDirs.rwFileBinds ?? [],
            preDispatchHead: /** @type {string} */ (finishedTask.preDispatchHead),
            homeDir: os.homedir(),
            runCommand: runOverlayCommandFn,
          })
        : extractNonGitDiff({
            stateDir,
            runtimeDir,
            denyList,
            diffPath,
            directory: finishedTask.directory,
            overlay: finishedTask.overlayDirs,
            homeDir: os.homedir(),
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
  // Mutable scheduler state handed to the module-level launch helpers. The
  // getter/setter pair lets the helpers read/write `launchTimer` and
  // `runningCount` (the factory's own `let` bindings) without closing over
  // the factory, while `launchTimes`/`launchQueue` are shared by reference.
  const launchScheduler = {
    launchTimes,
    launchQueue,
    get runningCount() { return runningCount; },
    get launchTimer() { return launchTimer; },
    set launchTimer(v) { launchTimer = v; },
  };
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
    const baseEvent = () => {
      ++eventSequence;
      const sequence = eventSequence;
      return {
        sequence,
        type: "task.activity",
        taskId: task.id,
        directory: scheduledDirectory,
        originSessionId: task.originSessionId ?? null,
        status: scheduledStatus,
        previousStatus: null,
        occurredAt: new Date().toISOString(),
      };
    };
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

  loadPersistedTasks({
    TASKS_FILE,
    overlayTmpRoot,
    tasks,
    taskEvents,
    setStateLoadError: (err) => {
      stateLoadError = err;
    },
  });

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
      const isActive = task?.status === "running" || task?.status === "queued";
      if (!isActive) removeFileIfPresent(path.join(PROMPT_DIR, entry));
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
    const tmpRoots = collectOverlayTmpRoots(tasks, overlayTmpRoot);
    for (const tmpRoot of tmpRoots) {
      sweepOverlayTmpRoot({ tasks, releaseOverlay, persistTask }, tmpRoot);
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
   * @param {string|undefined} sessionId
   * @returns {{sessionId: string|undefined, reset: boolean, previousSessionId: string|undefined}}
   */
  function resolveAdvisorSession(sessionId) {
    const effectiveSessionId = sessionId ? sessionId : undefined;
    const lastUsedAt = effectiveSessionId ? advisorSessions.get(effectiveSessionId) : undefined;
    const fresh = effectiveSessionId != null && lastUsedAt != null && Date.now() - lastUsedAt <= advisorTtl;
    const reset = effectiveSessionId != null && !fresh;
    const previousSessionId = reset ? effectiveSessionId : undefined;
    return { sessionId: fresh ? effectiveSessionId : undefined, reset, previousSessionId };
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
    const priorSessionTask = resolvePriorSessionTask(tasks, sessionId, executorName);
    const executor = resolveDispatchExecutor(priorSessionTask, executorName, defaultExecutor);
    validateDispatchParameters({ prompt, directory });
    validateDispatchFinalMarker(finalMarker);
    const normalizedDirectory = resolveDispatchDirectory(directory);
    // Task IDs retain the literal "oc_" prefix for compatibility; WorkerExecutor.taskIdPrefix is not wired in this issue.
    const id = `oc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const logPath = path.join(LOG_DIR, `${id}.ndjson`);
    const task = buildDispatchTask({ id, prompt, model, executor, priorSessionTask, variant, sessionId, originSessionId, internal, finalMarker, role, logPath, directory: normalizedDirectory });
    queueDispatchLaunch({ tasks, persistTask, pendingLaunches, launchQueue, launchQueuedTasks }, { id, task, prompt, sessionId, env, noSandbox, noOverlay, executor, role, allowedDirs: dispatchAllowedDirs });
    const summary = summarize(task);
    return {
      ...summary,
      next: task.status === "queued"
        ? `Task is queued; run taskferry wait or taskferry status with task id "${id}" to check when it starts`
        : `Run taskferry wait or taskferry status with task id "${id}" to check progress`,
    };
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
    // Thin wrapper over the extracted module-level pipeline (see
    // `runSummarizeActivity`/`summarizeActivityAttempt`/`runContinuationRetry`
    // /`runSummarizeActivityAttempt`), threading the handful of closure
    // dependencies it needs in explicitly.
    const ctx = {
      checkSummaryModelReady,
      activityCache,
      summarizeTask,
      poll,
      tasks,
      result,
      cancel,
      MAX_WAIT_MS,
    };
    return runSummarizeActivity(ctx, taskId, maxWords, previousActivity);
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
   * @param {string} taskId
   * @param {{maxWords?: number, allowPromptFallback?: boolean, previousActivity?: string|null, summarySessionId?: string|null, lastSummarizedWatermark?: number|null, respectConcurrencyReserve?: boolean, env?: NodeJS.ProcessEnv}} [options]
   * @returns {Promise<{sourceTaskId: string, sourceStatus: string, summary?: string, help?: string, capturedAt?: string, sourceLogBytes?: number, summaryInputBytes?: number, next?: string, summaryTask?: {id: string, status: string, model: string}}>}
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
    const ctx = {
      ensureStateLoaded,
      tasks,
      noSuchTask,
      summaryConcurrencyLimit,
      activityCache,
      activitySummaryModel,
      summaryModelAvailable,
      readNarrationExcerpt,
      LOG_DIR,
      SUMMARY_DIR,
      persistTask,
      pendingLaunches,
      opencodeExecutor,
      launchQueue,
      launchQueuedTasks,
    };
    // Only the activity-refresh path (summarizeActivity) opts into the
    // reserve check. A direct `taskferry summary` call is an explicit user
    // request and must always run, even with the reserve full.
    const reserveSkip = await enforceSummaryReserve(ctx, { taskId, source, respectConcurrencyReserve });
    if (reserveSkip) return reserveSkip;

    // Resolve the continuation session id and last-summarized watermark (from
    // explicit options or the activity cache) and stat the source log, then
    // build the input narration. Clone the caller env defensively at request
    // time (same as dispatch()) so a queued summary launch isn't vulnerable
    // to post-queue caller mutations.
    const session = resolveSummarySession(ctx, source, taskId, { summarySessionId, lastSummarizedWatermark });
    const snapshotResult = buildSummarySnapshot(ctx, source, taskId, session, allowPromptFallback);
    if (snapshotResult.skip) return snapshotResult.skip;
    const { snapshot, isDelta } = snapshotResult;
    const capturedAt = new Date().toISOString();
    const sourceStatus = source.status;
    const queuedCallerEnv = env === undefined ? undefined : { ...env };
    await summaryModelAvailable(activitySummaryModel, queuedCallerEnv ?? {});

    return launchSummaryTask(ctx, {
      taskId,
      source,
      snapshot,
      isDelta,
      capturedAt,
      sourceStatus,
      maxWords,
      previousActivity,
      queuedCallerEnv,
      resolvedSummarySessionId: session.resolvedSummarySessionId,
    });
  }

  function launchQueuedTasks() {
    runLaunchQueuedTasks(launchScheduler, {
      dispatchLimit,
      dispatchWindow,
      concurrencyLimit,
      tasks,
      startTask,
      reschedule: launchQueuedTasks,
    });
  }

  /** @param {Task} task */
  /**
   * Spawns a queued launch's worker process. The launch's pre-parsed
   * metadata (target dir, prompt-file routing, buildSpawnArgs output) comes
   * from resolveStartTaskLaunch; the actual spawn + child lifecycle is
   * delegated to the module-level helpers below, which take every factory
   * closure dependency explicitly via `ctx`.
   * @param {Task} task
   */
  function startTask(task) {
    const launch = pendingLaunches.get(task.id);
    pendingLaunches.delete(task.id);
    if (!launch) return;
    const ctx = {
      SUMMARY_DIR,
      PROMPT_DIR,
      spawnFn,
      runOverlayCommandFn,
      sandboxEnabled,
      platform,
      overlayEnabled,
      overlayTmpRoot,
      allowedDirs,
      stateDir,
      cacheDir,
      runtimeDir,
      existsFn,
      statFn,
      readdirFn,
      resolveGitCommonDirFn,
      resolveGitDirFn,
      requireBwrap,
      requireOverlaySupport,
      dispatchEnvironment,
      summaryEnvironment,
      settleWaiters,
      launchQueuedTasks,
      persistTask,
      scheduleActivity,
      classifyTrailingLogFailure,
      startRunningWatcher,
      stopRunningWatcher,
      readSessionIdFromLog,
      evaluateOutputCompleteness,
      extractChangesetForTask,
      sendSignal,
      activityCache,
      logHasEventCache,
      escalationTimers,
      tasks,
      decRunning: () => { runningCount--; },
      incRunning: () => { runningCount++; },
    };
    const launchInfo = resolveStartTaskLaunch(task, launch, ctx);
    spawnTaskChild(ctx, launchInfo, task);
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
      if (launch?.snapshotPath) removeFileIfPresent(launch.snapshotPath);
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
    const isGitTarget = validateAcceptable(task, { existsFn, hasLiveOverlay });
    const denyList = defaultDenyList(os.homedir(), stateDir).filter(existsFn);
    const applied = applyChangeset({
      isGitTarget,
      stateDir,
      runtimeDir,
      denyList,
      directory: task.directory,
      // validateAcceptable() threw above if diffPath were null, but that
      // narrowing lives inside the helper, so assert the invariant here.
      diffPath: /** @type {string} */ (task.diffPath),
      overlay: task.overlayDirs ?? undefined,
      homeDir: os.homedir(),
      runCommand: runOverlayCommandFn,
    });
    if (!applied.applied) {
      // validateAcceptable() threw above if changesetStatus weren't pending,
      // so it is non-undefined here; assert it for the type checker.
      return { taskId, changesetStatus: /** @type {string} */ (task.changesetStatus), applied: false, reason: applied.reason };
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
    // If cleanup succeeded, releaseOverlay() cleared overlayDirs in memory
    // (review finding #11). Persist once more so the durable task record
    // reflects the cleared overlay metadata instead of claiming an overlay
    // still exists for an overlay that was just removed. If cleanup failed,
    // overlayDirs stays set on disk and the startup sweep (Task 12) retries
    // the removal on the next daemon start -- consistent with the pre-fix
    // behavior for the cleanup-failure path.
    if (!cleanupFailed) persistTask(task.id);
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
    // If cleanup succeeded, releaseOverlay() cleared overlayDirs in memory;
    // persist once more so the durable task record reflects the cleared
    // overlay metadata (parallel to accept()).
    if (!cleanupFailed) persistTask(task.id);
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
    // Mutable per-task watch state threaded into the module-level watchdog
    // helpers so each tick reads and regexes only the bytes appended since
    // the last one instead of the whole file (O(1) amortized per tick, not
    // O(n) per tick / O(n²) over a long-running task). `carry` holds a
    // trailing partial line from the previous read until it's completed by
    // the next chunk.
    const watchState = {
      bytesRead: 0,
      carry: "",
      outputSeen: false,
      currentNoOutputTimeout: noOutputTimeout,
      lastActivityMs: Date.now(),
    };
    runningWatcherState.set(task.id, {
      get bytesRead() { return watchState.bytesRead; },
      get carry() { return watchState.carry; },
    });
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
    const timer = setInterval(() => {
      watchdogTick(watchState, {
        taskId: task.id,
        tasks,
        stopRunningWatcher,
        failRunningTask,
        scheduleActivity,
        postOutputNoOutputTimeout,
      });
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
      hasEvent = scanLogForEvent(logPath, Math.min(stat.size, LOG_ACTIVITY_SCAN_BYTES));
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
      if (!waiters.has(taskId)) {
        waiters.set(taskId, []);
      }
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
    // Thin wrapper over the extracted module-level pipeline (see
    // `runAdvisor`/`dispatchAdvisorTask`/`buildAdvisorActiveResponse`/
    // `buildAdvisorSettledResponse`), threading the closure dependencies it
    // needs in explicitly. `role: "advisor"` keeps overlay mandatory.
    const ctx = {
      ensureStateLoaded,
      resolveAdvisorSession,
      dispatch,
      errMessage,
      poll,
      maxWait,
      readSessionIdFromLog,
      touchAdvisorSession,
      result,
    };
    return runAdvisor(ctx, { prompt, directory, model, variant, sessionId, timeoutMs, executor, env });
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
      /** @type {any} */
      let evt;
      let parsed = false;
      try {
        evt = JSON.parse(line);
        parsed = true;
      } catch {
        // Not a text event line -- not narration.
      }
      if (parsed && evt.type === "text" && evt.part && typeof evt.part.text === "string") {
        const mid = evt.part.messageID;
        if (!textByMessageId.has(mid)) {
          textByMessageId.set(mid, []);
          textOrder.push(mid);
        }
        /** @type {string[]} */ (textByMessageId.get(mid)).push(evt.part.text);
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
        const line = lines[i].trim();
        if (!line) continue;
        const evt = isParseableJson(line) ? JSON.parse(line) : null;
        if (evt && evt.type === "text" && typeof evt.part?.text === "string") return evt.part.text;
      }
    } catch {
      return "";
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
    return "";
  }

  /**
   * @param {string} logPath
   * @returns {string}
   */
  function readRawCaptureTail(logPath) {
    /** @type {number|undefined} */
    let fd;
    try {
      const size = fs.statSync(logPath).size;
      if (size === 0) return "";
      const bytes = Math.min(size, TAIL_READ_BYTES);
      const buffer = Buffer.alloc(bytes);
      fd = fs.openSync(logPath, "r");
      fs.readSync(fd, buffer, 0, bytes, size - bytes);
      return buffer
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim())
        .join("\n");
    } catch {
      return "";
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
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
    let text = readLastText(task.logPath);
    // Eventless crash: narration is never coming (the log has no parseable
    // events at all, checked over the whole log), so the raw capture IS the
    // task's output -- show it instead of "none observed yet", which reads
    // as "still waiting". Deliberately broader than the settlement gate
    // (no failureReason requirement): tail is display-only, and a
    // watchdog-killed eventless task's stderr is just as much its only
    // output as a boot crash's is.
    if (!text && task.status === "crashed" && !logHasAnyEvent(task.logPath)) {
      text = readRawCaptureTail(task.logPath);
    }
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
   * re-deriving the parsing rules. Falls back to a zero stat on any
   * non-zero exit status (e.g. a plain `diff -ru` without `-N` whose
   * "Only in ..." lines git apply can't grok, or parsing stdout from a
   * failed invocation that would have given a misleading non-zero count);
   * the diff itself stays readable via `result --diff`, only the
   * human-readable summary is uncomputable.
   * @param {string} diffPath
   * @param {(command: string, args: string[]) => {status: number|null, stdout: string, stderr: string, error?: Error}} [runCommand]
   * @returns {{files: number, additions: number, deletions: number}}
   */
  function computeDiffStat(diffPath, runCommand = defaultOverlayRunCommand) {
    const result = runCommand("git", ["apply", "--numstat", diffPath]);
    // `git apply --numstat` exits 0 on success and a non-zero status on
    // any failure (corrupt patch, parse error, etc.). Treat any non-zero
    // status as "the stat is uncomputable" and return the zero fallback
    // rather than parsing partial stdout from a failed invocation.
    if (result.error || result.status !== 0) {
      return { files: 0, additions: 0, deletions: 0 };
    }
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of result.stdout.split("\n")) {
      const parsed = parseNumstatLine(line);
      if (!parsed) continue;
      files += 1;
      additions += parsed.additions;
      deletions += parsed.deletions;
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
      let parsed = false;
      try {
        evt = JSON.parse(line);
        parsed = true;
      } catch {
        // Not a parseable event line -- not final-message evidence.
      }
      if (parsed) {
        const stepId = collectFinalMessageLine(evt, textByMessageId, textOrder);
        if (stepId) finalMessageId = stepId;
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
    validateResultFields(full, fields);
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
    // opencode's steps are text (narration) -> tool_use -> step_finish per
    // messageID; only the messageID whose step ended in reason "stop" is the
    // model's final turn. Everything earlier is intermediate narration, kept
    // separately (not returned as `message`) so nothing is silently dropped.
    // See parseTaskLog / shapeNarration for the decomposition below.
    const ctx = {
      failureFields,
      computeDiffStat,
      runOverlayCommandFn,
    };
    return projectResult(computeResultDetail(task, { taskId, full, fields }, ctx), fields);
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
    advisor,
    checkSummaryModelReady,
    // Exposed primarily so tests can seed the summary session id and watermark
    // (the activity cache owns the "last successful summary" state shared
    // between the activity path and the direct summarize path).
    activityCache,
    summarize: summarizeRequest,
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
    paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE },
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
      const result = extractSessionId(carry);
      if (result.sessionId) return result.sessionId;
      carry = result.remainder;
    }
    return carry.trim() ? sessionIdInJson(carry) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
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
    let parsed = false;
    try {
      evt = JSON.parse(line);
      parsed = true;
    } catch {
      // Not a parseable event line -- not narration.
    }
    if (parsed) collectNarrationLine(evt, textByMessageId, order);
  }
  return order
    .map((entry) => (entry.kind === "text" ? /** @type {string[]} */ (textByMessageId.get(entry.mid)).join("") : entry.line))
    .join("\n\n");
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
  const suffixNames = ["_API_KEY", "_BASE_URL"];
  const exactNames = [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_MODELS_PATH",
    "OPENCODE_MODELS_URL",
    "PI_CODING_AGENT_DIR",
  ];
  /** @type {string[]} */
  const parts = [];
  for (const name of Object.keys(env)) {
    if (suffixNames.some((suffix) => name.endsWith(suffix)) || exactNames.includes(name)) {
      parts.push(`${name}=${env[name]}`);
    }
  }
  parts.sort();
  return parts.join("\n");
}

/**
 * @param {string} taskId
 * @returns {Error}
 */
function noSuchTask(taskId) {
  return new Error(`error: unknown task id: ${taskId}\nhelp: run taskferry list to see valid task ids`);
}

/**
 * @param {Task} task
 * @returns {{id: string, status: string, model: string, startedAt: string, failureReason: string|null}}
 */
function summarizeRow(task) {
  const { id, status, model, startedAt, failureReason } = task;
  return { id, status, model, startedAt, failureReason: failureReason ?? null };
}

/**
 * @param {Task} task
 * @returns {TaskSummary}
 */
function summarize(task) {
  const { promptPreview, id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath, cancelRequested, spawnError } = task;
  return {
    id, status, directory, model, sessionId, originSessionId, pid, startedAt, endedAt, exitCode, signal, logPath,
    ...failureFields(task),
    spawnError: spawnError ?? null,
    promptPreview,
    ...summarizeOptionalFields(task),
    ...summarizeChangesetFields(task),
    cancelRequested: !!cancelRequested,
  };
}

/** @param {Task} task */
function failureFields(task) {
  return { failureReason: task.failureReason ?? null, failureDetail: task.failureDetail ?? null };
}
