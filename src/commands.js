import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.js";
import { errCode } from "./errors.js";
import { MAX_BUFFER_BYTES } from "./daemon-server.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import {
  contextForHook,
  homeView,
  leanResult,
  leanStatus,
  projectContext,
  projectDoctorStats,
  projectList,
} from "./output.js";
import { defaultRunCommandAsync as defaultShellRunner, pluginInstalled } from "./setup.js";
import { checkClaudeCodePlaywrightIsolation, checkOpencodePlaywrightIsolation } from "./mcp-isolation.js";
import { checkBwrapAvailableAsync } from "./sandbox.js";
import { normalizeDirectory, resolveWorkspaceRoot } from "./paths.js";
import { loadConfig } from "./config.js";
import { computeDoctorStats } from "./doctor-stats.js";
import { streamTaskEvents, watchCommand } from "./commands-stream.js";
import { ADVISOR_CANNED_PROMPT, gatherAdvisorContext } from "./advisor-context.js";
import { validatePruneOptions } from "./retention.js";

// Default timeout for the CLI `wait` command (and `summary --wait`) when no
// explicit --timeout is given. Kept generous (15 min) so real tasks aren't
// cut off, but finite so a hung task doesn't block the caller forever. The
// 45 s MAX_WAIT_MS in tasks.js is for advisor's internal polling — a different,
// much shorter-lived use case.
const DEFAULT_WAIT_TIMEOUT_MS = 900000;

// Sentinel placeholder a Promise.allSettled slot lands on when its corresponding
// async check threw. Distinct from `null` (which `null` results also use, e.g.
// the bwrap check on non-Linux platforms) so callers can tell "we tried and it
// blew up" apart from "we deliberately skipped this check".
const CHECK_FAILED = "check failed";

// Not the same model tasks.js's own summarizer uses for `task.summary`
// (DEFAULT_SUMMARY_MODEL) -- commands.js is the CLI process and doesn't
// import daemon-internal tasks.js, so this is an independent constant that
// happens to share the same value.
const ADVISOR_SUMMARIZE_MODEL = "opencode/mimo-v2.5-free";
const ADVISOR_SUMMARIZE_TIMEOUT_MS = 120000;

/**
 * @typedef {import("./client.js").ClientTransport} Client
 */

/**
 * @typedef {import("./output.js").IoLike} Io
 */

/**
 * @typedef {object} Deps
 * @property {Client} [client] -- absent for `version`, which answers without the daemon
 * @property {Io} [io]
 * @property {AbortSignal} [signal]
 * @property {string} [executablePath]
 * @property {string} [cwd]
 * @property {string} [homeDirectory]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(command: string, args: readonly string[]) => Promise<import("./setup.js").CommandResult>} [runShellCommand]
 * @property {NodeJS.Platform} [platform]
 * @property {(startDir: string) => string} [resolveWorkspaceRoot]
 */

/**
 * The fully-resolved deps object every handler receives (see
 * resolveRunCommandDeps): every optional input has been defaulted, so the
 * fields handlers destructure are all present.
 * @typedef {object} ResolvedDeps
 * @property {Client} client
 * @property {Io} io
 * @property {AbortSignal} [signal]
 * @property {string} [executablePath]
 * @property {string} cwd
 * @property {string} homeDirectory
 * @property {NodeJS.ProcessEnv} env
 * @property {(command: string, args: readonly string[]) => Promise<import("./setup.js").CommandResult>} runShellCommand
 * @property {NodeJS.Platform} platform
 * @property {(startDir: string) => string} resolveWorkspaceRoot
 */

/**
 * Best-effort condensation of an arbitrary text blob via a throwaway
 * dispatch+wait+result round trip. Never throws: on any failure (dispatch
 * error, timeout, empty result) it returns `text` unchanged, since
 * condensation is a convenience, not a hard dependency of a working
 * advisor call.
 * @param {Pick<Client, "request">} client
 * @param {string} text
 * @param {{env: NodeJS.ProcessEnv, directory: string}} options
 * @returns {Promise<string>}
 */
async function summarizeContextText(client, text, { env, directory }) {
  const prompt = `Condense the following into a dense technical summary preserving key facts, decisions, and code references. Do not add commentary or a preamble.\n\n${text}`;
  try {
    const dispatched = /** @type {{id: string}} */ (await client.request("task.dispatch", {
      env,
      prompt,
      directory,
      model: env.TASKFERRY_ADVISOR_SUMMARIZER_MODEL || ADVISOR_SUMMARIZE_MODEL,
    }));
    await client.request("task.wait", { taskId: dispatched.id, timeoutMs: ADVISOR_SUMMARIZE_TIMEOUT_MS });
    const result = /** @type {{message?: string}} */ (await client.request("task.result", { taskId: dispatched.id, fields: ["message"] }));
    if (typeof result.message === "string" && result.message.length) return result.message;
  } catch {
    // best-effort -- fall through to the raw text below.
  }
  return text;
}

const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

// Single source of truth for the package version: read package.json rather
// than duplicating the string here, where it can (and did) drift for months.
function readPackageVersion() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).version;
}

/**
 * Resolve the effective default wait timeout: explicit env var override, then
 * the config file's `waitDefaultTimeoutMs`, then the built-in default. Returns
 * `null` when the env var is set to "0" (opt-out).
 * @param {NodeJS.ProcessEnv} env
 * @returns {number|null}
 */
function resolveWaitDefaultTimeoutMs(env) {
  if (env.TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS === "0") return null;
  const envMs = Number(env.TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS);
  if (Number.isFinite(envMs) && envMs > 0) return envMs;
  const configMs = Number(loadConfig({ env }).waitDefaultTimeoutMs);
  return Number.isFinite(configMs) && configMs > 0 ? configMs : DEFAULT_WAIT_TIMEOUT_MS;
}

// Checked from `doctor` so a missing Claude plugin install surfaces in the
// integrations output. `runShellCommand` is injected (default: a real `claude`
// invocation) so tests can stub it without spawning a subprocess.
/**
 * @param {(command: string, args: readonly string[]) => Promise<import("./setup.js").CommandResult>} runShellCommand
 * @returns {Promise<{installed: boolean, reason?: string}>}
 */
async function checkClaudeIntegration(runShellCommand) {
  const probe = await runShellCommand("claude", ["plugin", "list", "--json"]);
  if (probe.error) {
    return errCode(probe.error) === "ENOENT"
      ? { installed: false, reason: "claude CLI not found" }
      : { installed: false, reason: `claude plugin list failed: ${probe.error.message}` };
  }
  if (probe.status !== 0) return { installed: false, reason: "claude plugin list failed" };
  return { installed: pluginInstalled(probe.stdout || "") };
}

const SYSTEM_HEALTH_METHOD = "system.health";
const TASK_STATUS_METHOD = "task.status";
const TASK_LIST_METHOD = "task.list";
const TASK_STATS_METHOD = "task.stats";
const TASK_PRUNE_METHOD = "task.prune";

// Whether an option was set to anything other than `undefined`. The dispatch
// helpers use this to decide whether to include a key in the RPC payload --
// the daemon's per-method spec rejects unknown keys, so an explicitly-set
// `undefined` (e.g. `model: undefined` after the caller omitted --model) is
// indistinguishable from a missing key and must be omitted.
/** @param {unknown} value @returns {boolean} */
function isSet(value) {
  return value !== undefined;
}

/**
 * @param {object} options
 * @param {string} [options.directory]
 * @param {ResolvedDeps} deps
 */
async function runHome(options, { client, executablePath, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
  const listed = /** @type {import("./output.js").ListValue} */ (await client.request(TASK_LIST_METHOD, { directory }));
  return homeView(projectList(listed, { limit: Infinity }), { executablePath, workspace: directory });
}

function runVersion() {
  return { name: "taskferry", version: readPackageVersion(), protocolVersion: PROTOCOL_VERSION };
}

// Dispatch forwards these option keys through to task.dispatch verbatim, only
// when the caller set them. The daemon's allowed-params spec rejects unknown
// keys, so an explicitly-undefined value (the args.js default for an omitted
// flag) must be omitted entirely -- see isSet() above.
const DISPATCH_PASSTHROUGH_KEYS = ["model", "variant", "sessionId", "finalMarker", "noSandbox", "noOverlay", "allowedDirs", "rwBind", "roBind", "executor", "class", "parentTaskId", "executorArgs"];

/**
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
function pickDispatchOptions(options) {
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const key of DISPATCH_PASSTHROUGH_KEYS) {
    // `--allowed-dirs` is a deprecated alias for `--rw-bind`; pass both keys
    // through verbatim (as distinct wire params) rather than folding one into
    // the other here -- the daemon's own dispatchTask already unions
    // `allowedDirs` and `rwBind` server-side (see tasks.js's `effectiveRwBind`
    // union in dispatchTask). Collapsing them into a single wire key at this
    // layer, as an earlier version of this function did, meant passing both
    // flags on one dispatch silently dropped whichever key iterated first --
    // the daemon's union could never see two distinct values to union.
    if (isSet(options[key])) picked[key] = options[key];
  }
  return picked;
}

/**
 * @param {object} options
 * @param {string} [options.directory]
 * @param {string} options.prompt
 * @param {ResolvedDeps} deps
 */
async function runDispatch(options, { client, cwd, env }) {
  const directory = normalizeDirectory(options.directory || cwd);
  return client.request("task.dispatch", {
    env,
    prompt: options.prompt,
    directory,
    ...pickDispatchOptions(options),
    ...(process.env.CLAUDE_CODE_SESSION_ID && { originSessionId: process.env.CLAUDE_CODE_SESSION_ID }),
  });
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {number} [options.graceMs]
 * @param {ResolvedDeps} deps
 */
async function runCancel(options, { client }) {
  return client.request("task.cancel", {
    taskId: options.taskId,
    ...(isSet(options.graceMs) && { graceMs: options.graceMs }),
  });
}

/**
 * @param {string} label
 * @param {{cleanupFailed?: boolean, taskId: string}} result
 */
function warnIfCleanupFailed(label, result) {
  if (result.cleanupFailed) process.stderr.write(`warning: ${label}, but overlay cleanup failed -- ${result.taskId}'s overlay dir remains on disk (a daemon restart will sweep it)\n`);
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.force]
 * @param {ResolvedDeps} deps
 */
async function runAccept(options, { client }) {
  const accepted = /** @type {{applied?: boolean, checkStatus?: string|null, cleanupFailed?: boolean, taskId: string, reason?: string|null}} */ (
    await client.request("task.accept", { taskId: options.taskId, ...(options.force === true && { force: true }) })
  );
  // taskferry#414: the RPC succeeded but the patch did not land -- `git apply
  // --3way` failed and the daemon only reports that via `applied: false` plus
  // a `reason` string. Trusting the (previously zero) exit code made callers
  // treat a failed apply as success, so surface it as a hard error instead.
  // The reason text is indented (never prefixed with "error:"/"help:") so
  // output.js's error/help line parsing keeps this error's own headline.
  if (accepted.applied === false) {
    const reason = (accepted.reason || "the target directory rejected the patch").trim();
    const reasonBlock = reason.split("\n").map((line, index) => (index === 0 ? `  reason: ${line}` : `  ${line}`)).join("\n");
    throw new Error(
      `error: changeset for task ${accepted.taskId} failed to apply\n${reasonBlock}\n` +
      `help: the task is still pending -- resolve the reported conflict in the target directory, then retry "taskferry accept ${accepted.taskId}", or discard the changeset with "taskferry reject ${accepted.taskId}"`
    );
  }
  // Review finding #11: a failed cleanup must not be swallowed -- without
  // this, the leftover overlay is invisible until the daemon-restart sweep.
  warnIfCleanupFailed("changeset applied", accepted);
  if (accepted.applied && (accepted.checkStatus == null || accepted.checkStatus === "none")) {
    process.stderr.write("warning: changeset applied, but this repo declares no check command in .taskferry.toml -- nothing was verified before landing\n");
  }
  return accepted;
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {ResolvedDeps} deps
 */
async function runReject(options, { client }) {
  const rejected = /** @type {{cleanupFailed?: boolean, taskId: string}} */ (await client.request("task.reject", { taskId: options.taskId }));
  warnIfCleanupFailed("changeset rejected", rejected);
  return rejected;
}

/**
 * Lists a task's scratch output directory (or reads one file in it). Every
 * dispatch has a per-task writable scratch dir at <stateDir>/outputs/<id>,
 * rw-bound into the sandbox at the same path and exposed as
 * $TASKFERRY_OUTPUT_DIR; this is the surface for deliverables that survive a
 * worker whose final assistant message ended on a tool call. taskferry#423.
 * @param {{taskId: string, path?: string}} options
 * @param {{client: Client}} deps
 * @returns {Promise<{taskId: string, outputDir: string|null, files: Array<{path: string, size: number}>, bytes: number, total: number, truncated: boolean, file?: {content: string|null, size: number, truncated: boolean, error?: string}}>}
 */
/**
 * Lists a task's scratch output directory (or reads one file in it). taskferry#423.
 * @param {Record<string, unknown>} options
 * @param {ResolvedDeps} deps
 */
async function runOutput(options, { client }) {
  return /** @type {unknown} */ (await client.request("task.output", { taskId: options.taskId, ...(typeof options.path === "string" && options.path.length > 0 ? { path: options.path } : {}), ...(typeof options.maxOutputFileBytes === "number" ? { maxOutputFileBytes: options.maxOutputFileBytes } : {}) }));
}

// `wait --summarize` keeps the client open (cli.js's top-level finally owns the
// lifecycle) and re-uses streamTaskEvents to print periodic summaries, then a
// trailing task.status RPC to project the final lean shape.
/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.full]
 * @param {ResolvedDeps} deps
 */
async function runWaitWithSummarize(options, { client, io, signal }) {
  const initial = /** @type {import("./output.js").StatusDetailBase} */ (await client.request(TASK_STATUS_METHOD, { taskId: options.taskId }));
  const streamed = await streamTaskEvents({
    client,
    io,
    signal,
    directory: initial.directory,
    taskId: options.taskId,
    summaries: true,
    format: "toon",
  });
  if (signal?.aborted) {
    // The trailing task.status RPC below isn't cancellable (client.request has no
    // abort support), so on a stalled daemon it would delay exit past the user's
    // Ctrl-C. Skip it and report the last known state instead.
    return leanStatus(streamed.event ? { ...initial, status: streamed.event.status } : initial, { full: options.full });
  }
  const detail = /** @type {import("./output.js").StatusDetailBase} */ (await client.request(TASK_STATUS_METHOD, { taskId: options.taskId }));
  return leanStatus(detail, { full: options.full });
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {number} [options.timeoutMs]
 * @param {number} [options.tailChars]
 * @param {boolean} [options.full]
 * @param {ResolvedDeps} deps
 */
async function runWaitWithoutSummarize(options, { client, env }) {
  const waitTimeoutMs = options.timeoutMs ?? resolveWaitDefaultTimeoutMs(env);
  const detail = /** @type {import("./output.js").StatusDetailBase} */ (await client.request("task.wait", {
    taskId: options.taskId,
    ...(waitTimeoutMs != null && { timeoutMs: waitTimeoutMs }),
    ...(isSet(options.tailChars) && { tailChars: options.tailChars }),
  }));
  return leanStatus(detail, { full: options.full });
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.summarize]
 * @param {ResolvedDeps} deps
 */
async function runWait(options, deps) {
  if (options.summarize) return runWaitWithSummarize(options, deps);
  return runWaitWithoutSummarize(options, deps);
}

// Build the prompt advisor's RPC receives: the caller's own --prompt leads
// (when given), then the canned pushback framing, then the auto-attached
// context tail. With the canned prompt first, a model reliably answered its
// "push back on the ferry's plan" framing instead of the caller's actual
// ask, even though the ask was present later in the same text (confirmed
// live: two separate models both did this on 2026-07-31, e.g.
// openai/gpt-5.6-sol was fine standalone but cheapestinference/glm-5.2 and
// cheapestinference/kimi-k2.7 answered the canned framing when it came first).
/**
 * @param {object} options
 * @param {string} [options.prompt]
 * @param {{source: string, text: string}|null} [finalContext]
 * @returns {string}
 */
function assembleAdvisorPrompt(options, finalContext) {
  const contextBlock = finalContext
    ? [`\n--- attached context (${finalContext.source}, ${finalContext.text.length} chars) ---\n${finalContext.text}\n---`]
    : [];
  return [
    ...(options.prompt ? [options.prompt] : []),
    ADVISOR_CANNED_PROMPT,
    ...contextBlock,
  ].join("\n");
}

/**
 * @param {Client} client
 * @param {{source: string, text: string}|null} gathered
 * @param {object} options
 * @param {boolean} [options.summarizeContext]
 * @param {object} deps
 * @param {NodeJS.ProcessEnv} deps.env
 * @param {string} deps.directory
 * @returns {Promise<{source: string, text: string}|null>}
 */
async function maybeCondenseContext(client, gathered, options, { env, directory }) {
  if (!gathered || !options.summarizeContext) return gathered;
  // Only relabel the source when condensation actually changed the text --
  // summarizeContextText() returns the input unchanged on any failure, and
  // the fallback test in Step 5 expects that case to still read as plain
  // "ferry-log", not "summarized ferry-log".
  const condensed = await summarizeContextText(client, gathered.text, { env, directory });
  return condensed === gathered.text ? gathered : { source: `summarized ${gathered.source}`, text: condensed };
}

/**
 * @param {object} options
 * @param {string} [options.directory]
 * @param {string} [options.prompt]
 * @param {string} [options.model]
 * @param {string} [options.variant]
 * @param {string} [options.sessionId]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.executor]
 * @param {string} [options.class]
 * @param {string} [options.parentTaskId]
 * @param {string[]} [options.executorArgs]
 * @param {boolean} [options.summarizeContext]
 * @param {ResolvedDeps} deps
 */
// eslint-disable-next-line sonarjs/cyclomatic-complexity -- passthrough of optional dispatch keys dominates complexity
async function runAdvisor(options, { client, env, cwd, homeDirectory }) {
  // advisor is grouped with dispatch (literal cwd), not with the
  // observation commands: tasks.js's advisor() forwards its directory
  // straight into dispatch(), which uses it as both the bwrap sandbox
  // root and the worker's spawn cwd -- so widening advisor's default
  // to the workspace root would silently expand its sandbox from
  // "the cwd you ran it in" to "the whole repo root".
  const directory = normalizeDirectory(options.directory || cwd);
  const gathered = await gatherAdvisorContext({ client, env, cwd, homeDirectory });
  if (!gathered && !options.prompt) {
    throw new UsageError(
      "advisor needs context or an explicit --prompt: no context source found",
      "Neither CLAUDE_CODE_SESSION_ID nor TASKFERRY_TASK_ID is set in the environment, so advisor has nothing to auto-attach -- pass --prompt explicitly, or run this from a Claude Code session or a taskferry-dispatched worker"
    );
  }
  const finalContext = await maybeCondenseContext(client, gathered, options, { env, directory });
  const assembledPrompt = assembleAdvisorPrompt(options, finalContext);
  return client.request("task.advisor", {
    env,
    prompt: assembledPrompt,
    directory,
    model: options.model,
    ...(isSet(options.variant) && { variant: options.variant }),
    ...(isSet(options.sessionId) && { sessionId: options.sessionId }),
    ...(isSet(options.timeoutMs) && { timeoutMs: options.timeoutMs }),
    ...(isSet(options.executor) && { executor: options.executor }),
    ...(isSet(options.class) && { class: options.class }),
    ...(isSet(options.parentTaskId) && { parentTaskId: options.parentTaskId }),
    ...(isSet(options.executorArgs) && { executorArgs: options.executorArgs }),
  });
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.full]
 * @param {ResolvedDeps} deps
 */
async function runStatus(options, { client }) {
  const detail = /** @type {import("./output.js").StatusDetailBase} */ (await client.request(TASK_STATUS_METHOD, { taskId: options.taskId }));
  return leanStatus(detail, { full: options.full });
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {number} [options.chars]
 * @param {ResolvedDeps} deps
 */
async function runTail(options, { client }) {
  return client.request("task.tail", {
    taskId: options.taskId,
    ...(isSet(options.chars) && { chars: options.chars }),
  });
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.full]
 * @param {{client: Client, env: NodeJS.ProcessEnv}} deps
 */
async function runSummaryWait(options, { client, env }) {
  const waitTimeoutMs = resolveWaitDefaultTimeoutMs(env);
  const waited = /** @type {import("./output.js").StatusDetailBase} */ (await client.request("task.wait", {
    taskId: options.taskId,
    ...(waitTimeoutMs != null && { timeoutMs: waitTimeoutMs }),
  }));
  if (waited.status === "running" || waited.status === "queued") {
    return {
      ...leanStatus(waited, { full: options.full }),
      note: `Task has not settled yet (status: ${waited.status}); run taskferry summary --wait again to keep waiting, or omit --wait to summarize the in-progress task`,
    };
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.wait]
 * @param {number} [options.maxWords]
 * @param {"report"|"activity"} [options.mode]
 * @param {boolean} [options.full]
 * @param {ResolvedDeps} deps
 */
async function runSummary(options, { client, env }) {
  if (options.wait) {
    const stillRunning = await runSummaryWait(options, { client, env });
    if (stillRunning) return stillRunning;
  }
  // env is omitted on the activity path: protocol.js rejects env +
  // mode "activity" because the activity path reads the cached task
  // activity and spawns nothing, so there is no process to forward
  // caller env into. Report mode (the default) and any future mode
  // keep forwarding env exactly as before.
  const isActivity = options.mode === "activity";
  const summary = /** @type {Record<string, unknown>} */ (await client.request("task.summary", {
    taskId: options.taskId,
    ...(isSet(options.maxWords) && { maxWords: options.maxWords }),
    ...(isActivity && { mode: options.mode }),
    ...(isActivity ? null : { env }),
  }));
  return isActivity ? { mode: options.mode, ...summary } : summary;
}

/**
 * @param {object} options
 * @param {string} options.taskId
 * @param {boolean} [options.diff]
 * @param {string[]} [options.fields]
 * @param {boolean} [options.full]
 * @param {ResolvedDeps} deps
 */
async function runResult(options, { client }) {
  // `options.diff` and `options.full` are mutually exclusive (args.js rejects
  // the combination at parse time), so the if/else-if below is deterministic:
  // --diff takes the fields:["diff"] branch, --full takes the full:true
  // branch, neither passes {}. leanResult() still receives `full: options.full`
  // so the local-narrowing step mirrors the server-side contract regardless
  // of which branch was taken above.
  const fields = options.diff ? ["diff"] : options.fields;
  let detail;
  try {
    detail = /** @type {import("./output.js").ResultDetailBase} */ (await client.request("task.result", {
      taskId: options.taskId,
      ...(fields && { fields }),
      ...(options.full && !options.diff && { full: true }),
    }));
  } catch (error) {
    // taskferry#414: when the requested fields include the diff, that diff
    // covers the whole target directory against its pre-dispatch HEAD --
    // unrelated uncommitted changes in the directory count toward the
    // daemon's response cap, not just the task's own edits. Rewrite the
    // daemon's opaque size error into one that names the cause and the way
    // out, but only attribute it to the diff when the diff was actually
    // requested -- a plain `--fields message` or `--full` overflow on
    // narration alone has nothing to do with the target directory's tree.
    if (errCode(error) === "RESPONSE_TOO_LARGE") {
      const diffRequested = !fields || fields.includes("diff");
      const capMiB = MAX_BUFFER_BYTES / (1024 * 1024);
      const help = diffRequested
        ? `help: the payload includes the task's diff, which covers the whole target directory against its pre-dispatch HEAD -- unrelated uncommitted changes in that directory count toward the cap, not just the task's own edits. Commit or shelve the unrelated working-tree changes and retry, or fetch a narrower set of fields instead (e.g. "taskferry result ${options.taskId} --fields message,tokens")`
        : `help: fetch a narrower set of fields instead (e.g. "taskferry result ${options.taskId} --fields message,tokens")`;
      throw new Error(
        `error: the result payload for task ${options.taskId} exceeds the daemon's response size cap (${capMiB} MiB)\n${help}`,
        { cause: error }
      );
    }
    throw error;
  }
  return leanResult(detail, /** @type {{full?: boolean, fields?: string[]}} */ ({ full: options.full, fields }));
}

/**
 * @param {object} options
 * @param {boolean} [options.all]
 * @param {string} [options.directory]
 * @param {number} [options.limit]
 * @param {ResolvedDeps} deps
 */
async function runList(options, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  const params = options.all ? {} : { directory: normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd)) };
  const listed = /** @type {import("./output.js").ListValue} */ (await client.request(TASK_LIST_METHOD, params));
  return projectList(listed, { limit: options.limit });
}

/**
 * @param {object} options
 * @param {boolean} [options.all]
 * @param {string} [options.directory]
 * @param {string} [options.taskId]
 * @param {boolean} [options.summaries]
 * @param {"toon"|"ndjson"} [options.format]
 * @param {number} [options.flushIntervalMs]
 * @param {ResolvedDeps} deps
 */
async function runWatch(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  return watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
}

/**
 * @param {object} options
 * @param {string} [options.directory]
 * @param {"toon"|"claude-hook"|"codex-hook"} [options.format]
 * @param {ResolvedDeps} deps
 */
async function runContext(options, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
  const context = /** @type {import("./output.js").ListValue} */ (await client.request("task.context", { directory }));
  return contextForHook(projectContext(context), options.format);
}

function failedCheck(reason = CHECK_FAILED) {
  return { checked: false, reason };
}

/**
 * @param {ResolvedDeps} deps
 * @returns {Promise<DoctorChecks>}
 */
async function runDoctorChecks({ client, homeDirectory, env, runShellCommand, platform }) {
  const checks = await Promise.allSettled([
    client.request(SYSTEM_HEALTH_METHOD, {}),
    checkClaudeIntegration(runShellCommand),
    checkOpencodePlaywrightIsolation(homeDirectory, env),
    checkClaudeCodePlaywrightIsolation(homeDirectory),
    platform === "linux" ? checkBwrapAvailableAsync(runShellCommand) : Promise.resolve(null),
  ]);
  return {
    health: checks[0].status === "fulfilled" ? /** @type {object} */ (checks[0].value) : {},
    claude: checks[1].status === "fulfilled" ? checks[1].value : { installed: false, reason: CHECK_FAILED },
    opencodeMCP: checks[2].status === "fulfilled" ? checks[2].value : failedCheck(),
    claudeCodeMCP: checks[3].status === "fulfilled" ? checks[3].value : failedCheck(),
    bwrap: checks[4].status === "fulfilled" ? checks[4].value : bwrapFailureForPlatform(platform),
  };
}

/**
 * @param {NodeJS.Platform} platform
 * @returns {{checked: boolean, reason: string}|null}
 */
function bwrapFailureForPlatform(platform) {
  return platform === "linux" ? failedCheck() : null;
}

// Each check kind produces at most one warning; the shared phrase anchors the
// three messages to the same root cause ("shared browser profile crashes
// dispatch / bwrap missing breaks sandbox") so adding a new check only needs
// to slot in another helper here.
const SHARED_BROWSER_CRASH_PHRASE = "concurrent dispatches sharing one browser profile crash with SIGKILL";

/**
 * @param {{checked: boolean, isolated?: boolean, path?: string}} opencodeMCP
 * @returns {string|null}
 */
function opencodeMcpWarning(opencodeMCP) {
  if (!opencodeMCP.checked || opencodeMCP.isolated) return null;
  return `Playwright MCP for opencode is not isolated (${opencodeMCP.path}): ${SHARED_BROWSER_CRASH_PHRASE}. Run taskferry setup to fix, or add --isolated to its command manually.`;
}

/**
 * @param {{checked: boolean, isolated?: boolean, path?: string, reason?: string}} claudeCodeMCP
 * @returns {string|null}
 */
function claudeCodeMcpWarning(claudeCodeMCP) {
  if (!claudeCodeMCP.checked || claudeCodeMCP.isolated) return null;
  const pathFragment = claudeCodeMCP.path ? ` (${claudeCodeMCP.path})` : "";
  const reasonFragment = claudeCodeMCP.reason && !claudeCodeMCP.path ? `, or ${claudeCodeMCP.reason.toLowerCase()}` : "";
  return `Playwright MCP for Claude Code is not isolated${pathFragment}: ${SHARED_BROWSER_CRASH_PHRASE}. Run taskferry setup to fix${reasonFragment}.`;
}

/**
 * @param {{available?: boolean, reason?: string}|null} bwrap
 * @returns {string|null}
 */
function bwrapWarning(bwrap) {
  if (!bwrap || bwrap.available) return null;
  return `Filesystem sandboxing is unavailable: bwrap is not installed (${bwrap.reason}). Dispatches will fail with a spawnError instead of running unconfined. Install bubblewrap (e.g. apt install bubblewrap), or opt out explicitly with TASKFERRY_DISABLE_SANDBOX=1.`;
}

/**
 * @param {object} checked
 * @param {{checked: boolean, isolated?: boolean, path?: string}} checked.opencodeMCP
 * @param {{checked: boolean, isolated?: boolean, path?: string, reason?: string}} checked.claudeCodeMCP
 * @param {{available?: boolean, reason?: string}|null} checked.bwrap
 * @param {NodeJS.Platform} platform
 * @returns {{warnings: string[], info: string[]}}
 */
function collectDoctorDiagnostics(checked, platform) {
  const warnings = [
    opencodeMcpWarning(checked.opencodeMCP),
    claudeCodeMcpWarning(checked.claudeCodeMCP),
    bwrapWarning(checked.bwrap),
  ].filter((message) => message !== null);
  const info = platform !== "linux"
    ? ["Filesystem sandboxing (bwrap) is only available on Linux; dispatched tasks on this platform run unconfined."]
    : [];
  return { warnings, info };
}

/**
 * @typedef {object} DoctorChecks
 * @property {object} health
 * @property {{installed: boolean, reason?: string}} claude
 * @property {{checked: boolean, isolated?: boolean, path?: string, reason?: string}} opencodeMCP
 * @property {{checked: boolean, isolated?: boolean, path?: string, reason?: string}} claudeCodeMCP
 * @property {{checked: boolean, available?: boolean, reason?: string}|null} bwrap
 */

/**
 * @param {object} options
 * @param {boolean} [options.full]
 * @param {DoctorChecks} checked
 * @param {object} diagnostics
 * @param {string[]} diagnostics.warnings
 * @param {string[]} diagnostics.info
 */
function shapeDoctorResult(options, checked, diagnostics) {
  const { health, claude, opencodeMCP, claudeCodeMCP } = checked;
  return {
    ...health,
    ...(options.full && { cliVersion: "2.0.0", protocolVersion: 1 }),
    integrations: { claude, playwrightMcpIsolation: { opencode: opencodeMCP, claudeCode: claudeCodeMCP } },
    ...(diagnostics.warnings.length > 0 && { warnings: diagnostics.warnings }),
    ...(diagnostics.info.length > 0 && { info: diagnostics.info }),
  };
}

/**
 * @param {Client} client
 */
async function runDoctorStats(client) {
  // Aggregated server-side (task.stats), not shipped as raw rows to aggregate
  // here: with enough task history the full unfiltered row list alone blows
  // past the daemon's outbound message cap and the connection is silently
  // torn down with no error frame (taskferry#doctor-stats-connection-closed).
  try {
    const stats = /** @type {import("./output.js").DoctorStatsInput} */ (await client.request(TASK_STATS_METHOD, {}));
    return projectDoctorStats(stats);
  } catch (error) {
    // Version-skew fallback: a still-running pre-PR daemon (whose self-restart
    // defers while tasks are running/queued) rejects task.stats as
    // UNKNOWN_METHOD. The PR's stated goal is to eliminate "daemon connection
    // closed" for `doctor --stats`, so the command must not hard-fail during
    // the upgrade window -- reconstruct the same aggregated result from
    // task.list on the client side, the way the pre-PR code path did. Once
    // the upgrade completes and the daemon restarts, the new path takes over.
    if (errCode(error) !== "UNKNOWN_METHOD") throw error;
    const listed = /** @type {{tasks?: import("./doctor-stats.js").DoctorStatsRow[]}} */ (await client.request(TASK_LIST_METHOD, {}));
    return projectDoctorStats(computeDoctorStats(Array.isArray(listed?.tasks) ? listed.tasks : []));
  }
}

/**
 * @param {object} options
 * @param {boolean} [options.stats]
 * @param {boolean} [options.full]
 * @param {ResolvedDeps} deps
 */
async function runDoctor(options, deps) {
  if (options.stats) return runDoctorStats(deps.client);
  const checked = await runDoctorChecks(deps);
  const diagnostics = collectDoctorDiagnostics(checked, deps.platform);
  return shapeDoctorResult(options, checked, diagnostics);
}

/**
 * Prunes aged-out terminal tasks from the daemon's store.
 *
 * Deliberately routed through the daemon rather than editing tasks.json here:
 * the daemon holds the authoritative task map in memory and flushes it on a
 * coalesced timer, so a CLI-side rewrite of the file is silently overwritten
 * the next time any task changes state.
 *
 * @param {object} options
 * @param {number} [options.keepDays]
 * @param {boolean} [options.dryRun]
 * @param {ResolvedDeps} deps
 */
async function runPrune(options, deps) {
  validatePruneOptions(options);
  return /** @type {unknown} */ (await deps.client.request(TASK_PRUNE_METHOD, {
    ...(typeof options.keepDays === "number" ? { keepDays: options.keepDays } : {}), dryRun: options.dryRun === true,
  }));
}

// Per-command dispatch table. Adding a new command means writing one handler
// here and registering it below -- the top-level switch is gone. Each handler
// has its own per-command options shape, so the table is typed loosely and
// the per-handler JSDoc carries the real signature.
/** @type {Record<string, (options: Record<string, unknown>, deps: ResolvedDeps) => unknown>} */
const HANDLERS = {
  home: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runHome),
  version: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runVersion),
  dispatch: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runDispatch),
  cancel: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runCancel),
  accept: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runAccept),
  reject: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runReject),
  output: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runOutput),
  wait: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runWait),
  advisor: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runAdvisor),
  status: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runStatus),
  tail: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runTail),
  summary: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runSummary),
  result: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runResult),
  list: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runList),
  watch: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runWatch),
  context: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runContext),
  doctor: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runDoctor),
  prune: /** @type {(options: Record<string, unknown>, deps: ResolvedDeps) => unknown} */ (runPrune),
};

// Resolve the default values for the per-command deps once so every handler
// sees a fully-populated deps object instead of threading `?? process.cwd()`
// (etc.) through every call.
/**
 * @param {Deps} deps
 * @returns {ResolvedDeps}
 */
function resolveRunCommandDeps(deps) {
  return {
    // No default: `client` is genuinely absent for `version`, the one
    // handler that answers without the daemon (see Deps.client above).
    // ResolvedDeps declares it required because every other handler does
    // require it; the field-level cast documents that one exception rather
    // than widening the type for every handler, and the other nine fields
    // below stay fully typechecked.
    client: /** @type {Client} */ (deps.client),
    io: deps.io ?? process,
    signal: deps.signal,
    executablePath: deps.executablePath,
    cwd: deps.cwd ?? process.cwd(),
    homeDirectory: deps.homeDirectory ?? os.homedir(),
    env: deps.env ?? process.env,
    runShellCommand: deps.runShellCommand ?? defaultShellRunner,
    platform: deps.platform ?? process.platform,
    resolveWorkspaceRoot: deps.resolveWorkspaceRoot ?? resolveWorkspaceRoot,
  };
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} options
 * @param {Deps} [deps]
 */
export async function runCommand(command, options, deps = /** @type {Deps} */ ({})) {
  if (!Object.hasOwn(HANDLERS, command)) throw new Error(`unknown command: ${command}`);
  const handler = HANDLERS[command];
  return handler(options, resolveRunCommandDeps(deps));
}