import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import {
  contextForHook,
  homeView,
  leanResult,
  leanStatus,
  projectContext,
  projectList,
} from "./output.js";
import { defaultRunCommandAsync as defaultShellRunner, pluginInstalled } from "./setup.js";
import { checkClaudeCodePlaywrightIsolation, checkOpencodePlaywrightIsolation } from "./mcp-isolation.js";
import { checkBwrapAvailableAsync } from "./sandbox.js";
import { checkSkills as defaultCheckSkills } from "../scripts/generate-skill.js";
import { normalizeDirectory, resolveWorkspaceRoot } from "./paths.js";
import { loadConfig } from "./config.js";
import { computeDoctorStats } from "./doctor-stats.js";
import { streamTaskEvents, watchCommand } from "./commands-stream.js";
import { ADVISOR_CANNED_PROMPT, gatherAdvisorContext } from "./advisor-context.js";

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
 * Best-effort condensation of an arbitrary text blob via a throwaway
 * dispatch+wait+result round trip. Never throws: on any failure (dispatch
 * error, timeout, empty result) it returns `text` unchanged, since
 * condensation is a convenience, not a hard dependency of a working
 * advisor call.
 * @param {{request: (method: string, params: object) => Promise<any>}} client
 * @param {string} text
 * @param {{env: NodeJS.ProcessEnv, directory: string}} options
 * @returns {Promise<string>}
 */
async function summarizeContextText(client, text, { env, directory }) {
  const prompt = `Condense the following into a dense technical summary preserving key facts, decisions, and code references. Do not add commentary or a preamble.\n\n${text}`;
  try {
    const dispatched = await client.request("task.dispatch", {
      env,
      prompt,
      directory,
      model: env.TASKFERRY_ADVISOR_SUMMARIZER_MODEL || ADVISOR_SUMMARIZE_MODEL,
    });
    await client.request("task.wait", { taskId: dispatched.id, timeoutMs: ADVISOR_SUMMARIZE_TIMEOUT_MS });
    const result = await client.request("task.result", { taskId: dispatched.id, fields: ["message"] });
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
async function checkClaudeIntegration(runShellCommand) {
  const probe = await runShellCommand("claude", ["plugin", "list", "--json"]);
  if (probe.error) {
    return probe.error.code === "ENOENT"
      ? { installed: false, reason: "claude CLI not found" }
      : { installed: false, reason: `claude plugin list failed: ${probe.error.message}` };
  }
  if (probe.status !== 0) return { installed: false, reason: "claude plugin list failed" };
  return { installed: pluginInstalled(probe.stdout || "") };
}

const SYSTEM_HEALTH_METHOD = "system.health";
const TASK_STATUS_METHOD = "task.status";
const TASK_LIST_METHOD = "task.list";

// Whether an option was set to anything other than `undefined`. The dispatch
// helpers use this to decide whether to include a key in the RPC payload --
// the daemon's per-method spec rejects unknown keys, so an explicitly-set
// `undefined` (e.g. `model: undefined` after the caller omitted --model) is
// indistinguishable from a missing key and must be omitted.
function isSet(value) {
  return value !== undefined;
}

async function runHome(options, { client, executablePath, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
  const listed = await client.request(TASK_LIST_METHOD, { directory });
  return homeView(projectList(listed, { limit: Infinity }), { executablePath, workspace: directory });
}

function runVersion() {
  return { name: "taskferry", version: readPackageVersion(), protocolVersion: PROTOCOL_VERSION };
}

async function ensureSkillSync(checkSkills) {
  try {
    checkSkills();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `taskferry's own skill files are out of sync: ${message}`,
      "Run `npm run skill:generate` in the taskferry repo, then retry dispatch"
    );
  }
}

// Dispatch forwards these option keys through to task.dispatch verbatim, only
// when the caller set them. The daemon's allowed-params spec rejects unknown
// keys, so an explicitly-undefined value (the args.js default for an omitted
// flag) must be omitted entirely -- see isSet() above.
const DISPATCH_PASSTHROUGH_KEYS = ["model", "variant", "sessionId", "finalMarker", "noSandbox", "noOverlay", "allowedDirs", "executor", "class"];

function pickDispatchOptions(options) {
  const picked = {};
  for (const key of DISPATCH_PASSTHROUGH_KEYS) {
    if (isSet(options[key])) picked[key] = options[key];
  }
  return picked;
}

async function runDispatch(options, { client, cwd, env, checkSkills }) {
  await ensureSkillSync(checkSkills);
  const directory = normalizeDirectory(options.directory || cwd);
  return client.request("task.dispatch", {
    env,
    prompt: options.prompt,
    directory,
    ...pickDispatchOptions(options),
    ...(process.env.CLAUDE_CODE_SESSION_ID && { originSessionId: process.env.CLAUDE_CODE_SESSION_ID }),
  });
}

async function runCancel(options, { client }) {
  return client.request("task.cancel", {
    taskId: options.taskId,
    ...(isSet(options.graceMs) && { graceMs: options.graceMs }),
  });
}

function warnIfCleanupFailed(label, result) {
  if (result.cleanupFailed) process.stderr.write(`warning: ${label}, but overlay cleanup failed -- ${result.taskId}'s overlay dir remains on disk (a daemon restart will sweep it)\n`);
}

async function runAccept(options, { client }) {
  const accepted = await client.request("task.accept", { taskId: options.taskId });
  // Review finding #11: a failed cleanup must not be swallowed -- without
  // this, the leftover overlay is invisible until the daemon-restart sweep.
  warnIfCleanupFailed("changeset applied", accepted);
  return accepted;
}

async function runReject(options, { client }) {
  const rejected = await client.request("task.reject", { taskId: options.taskId });
  warnIfCleanupFailed("changeset rejected", rejected);
  return rejected;
}

// `wait --summarize` keeps the client open (cli.js's top-level finally owns the
// lifecycle) and re-uses streamTaskEvents to print periodic summaries, then a
// trailing task.status RPC to project the final lean shape.
async function runWaitWithSummarize(options, { client, io, signal }) {
  const initial = await client.request(TASK_STATUS_METHOD, { taskId: options.taskId });
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
  const detail = await client.request(TASK_STATUS_METHOD, { taskId: options.taskId });
  return leanStatus(detail, { full: options.full });
}

async function runWaitWithoutSummarize(options, { client, env }) {
  const waitTimeoutMs = options.timeoutMs ?? resolveWaitDefaultTimeoutMs(env);
  const detail = await client.request("task.wait", {
    taskId: options.taskId,
    ...(waitTimeoutMs != null && { timeoutMs: waitTimeoutMs }),
    ...(isSet(options.tailChars) && { tailChars: options.tailChars }),
  });
  return leanStatus(detail, { full: options.full });
}

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

async function maybeCondenseContext(client, gathered, options, { env, directory }) {
  if (!gathered || !options.summarizeContext) return gathered;
  // Only relabel the source when condensation actually changed the text --
  // summarizeContextText() returns the input unchanged on any failure, and
  // the fallback test in Step 5 expects that case to still read as plain
  // "ferry-log", not "summarized ferry-log".
  const condensed = await summarizeContextText(client, gathered.text, { env, directory });
  return condensed === gathered.text ? gathered : { source: `summarized ${gathered.source}`, text: condensed };
}

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
  });
}

async function runStatus(options, { client }) {
  const detail = await client.request(TASK_STATUS_METHOD, { taskId: options.taskId });
  return leanStatus(detail, { full: options.full });
}

async function runTail(options, { client }) {
  return client.request("task.tail", {
    taskId: options.taskId,
    ...(isSet(options.chars) && { chars: options.chars }),
  });
}

async function runSummaryWait(options, { client, env }) {
  const waitTimeoutMs = resolveWaitDefaultTimeoutMs(env);
  const waited = await client.request("task.wait", {
    taskId: options.taskId,
    ...(waitTimeoutMs != null && { timeoutMs: waitTimeoutMs }),
  });
  if (waited.status === "running" || waited.status === "queued") {
    return {
      ...leanStatus(waited, { full: options.full }),
      note: `Task has not settled yet (status: ${waited.status}); run taskferry summary --wait again to keep waiting, or omit --wait to summarize the in-progress task`,
    };
  }
  return null;
}

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
  const summary = await client.request("task.summary", {
    taskId: options.taskId,
    ...(isSet(options.maxWords) && { maxWords: options.maxWords }),
    ...(isActivity && { mode: options.mode }),
    ...(isActivity ? null : { env }),
  });
  return isActivity ? { mode: options.mode, ...summary } : summary;
}

async function runResult(options, { client }) {
  // `options.diff` and `options.full` are mutually exclusive (args.js rejects
  // the combination at parse time), so the if/else-if below is deterministic:
  // --diff takes the fields:["diff"] branch, --full takes the full:true
  // branch, neither passes {}. leanResult() still receives `full: options.full`
  // so the local-narrowing step mirrors the server-side contract regardless
  // of which branch was taken above.
  const fields = options.diff ? ["diff"] : options.fields;
  const detail = await client.request("task.result", {
    taskId: options.taskId,
    ...(fields && { fields }),
    ...(options.full && !options.diff && { full: true }),
  });
  return leanResult(detail, { full: options.full, fields });
}

async function runList(options, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  const params = options.all ? {} : { directory: normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd)) };
  const listed = await client.request(TASK_LIST_METHOD, params);
  return projectList(listed, { limit: options.limit });
}

async function runWatch(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  return watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
}

async function runContext(options, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn }) {
  const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
  const context = await client.request("task.context", { directory });
  return contextForHook(projectContext(context), options.format);
}

function failedCheck(reason = CHECK_FAILED) {
  return { checked: false, reason };
}

async function runDoctorChecks({ client, homeDirectory, env, runShellCommand, platform }) {
  const checks = await Promise.allSettled([
    client.request(SYSTEM_HEALTH_METHOD, {}),
    checkClaudeIntegration(runShellCommand),
    checkOpencodePlaywrightIsolation(homeDirectory, env),
    checkClaudeCodePlaywrightIsolation(homeDirectory),
    platform === "linux" ? checkBwrapAvailableAsync(runShellCommand) : Promise.resolve(null),
  ]);
  return {
    health: checks[0].status === "fulfilled" ? checks[0].value : {},
    claude: checks[1].status === "fulfilled" ? checks[1].value : { installed: false, reason: CHECK_FAILED },
    opencodeMCP: checks[2].status === "fulfilled" ? checks[2].value : failedCheck(),
    claudeCodeMCP: checks[3].status === "fulfilled" ? checks[3].value : failedCheck(),
    bwrap: checks[4].status === "fulfilled" ? checks[4].value : bwrapFailureForPlatform(platform),
  };
}

function bwrapFailureForPlatform(platform) {
  return platform === "linux" ? failedCheck() : null;
}

// Each check kind produces at most one warning; the shared phrase anchors the
// three messages to the same root cause ("shared browser profile crashes
// dispatch / bwrap missing breaks sandbox") so adding a new check only needs
// to slot in another helper here.
const SHARED_BROWSER_CRASH_PHRASE = "concurrent dispatches sharing one browser profile crash with SIGKILL";

function opencodeMcpWarning(opencodeMCP) {
  if (!opencodeMCP.checked || opencodeMCP.isolated) return null;
  return `Playwright MCP for opencode is not isolated (${opencodeMCP.path}): ${SHARED_BROWSER_CRASH_PHRASE}. Run taskferry setup to fix, or add --isolated to its command manually.`;
}

function claudeCodeMcpWarning(claudeCodeMCP) {
  if (!claudeCodeMCP.checked || claudeCodeMCP.isolated) return null;
  const pathFragment = claudeCodeMCP.path ? ` (${claudeCodeMCP.path})` : "";
  const reasonFragment = claudeCodeMCP.reason && !claudeCodeMCP.path ? `, or ${claudeCodeMCP.reason.toLowerCase()}` : "";
  return `Playwright MCP for Claude Code is not isolated${pathFragment}: ${SHARED_BROWSER_CRASH_PHRASE}. Run taskferry setup to fix${reasonFragment}.`;
}

function bwrapWarning(bwrap) {
  if (!bwrap || bwrap.available) return null;
  return `Filesystem sandboxing is unavailable: bwrap is not installed (${bwrap.reason}). Dispatches will fail with a spawnError instead of running unconfined. Install bubblewrap (e.g. apt install bubblewrap), or opt out explicitly with TASKFERRY_DISABLE_SANDBOX=1.`;
}

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

async function runDoctorStats(client) {
  const listed = await client.request(TASK_LIST_METHOD, {});
  return computeDoctorStats(Array.isArray(listed.tasks) ? listed.tasks : []);
}

async function runDoctor(options, deps) {
  if (options.stats) return runDoctorStats(deps.client);
  const checked = await runDoctorChecks(deps);
  const diagnostics = collectDoctorDiagnostics(checked, deps.platform);
  return shapeDoctorResult(options, checked, diagnostics);
}

// Per-command dispatch table. Adding a new command means writing one handler
// here and registering it below -- the top-level switch is gone.
const HANDLERS = { home: runHome, version: runVersion, dispatch: runDispatch, cancel: runCancel, accept: runAccept, reject: runReject, wait: runWait, advisor: runAdvisor, status: runStatus, tail: runTail, summary: runSummary, result: runResult, list: runList, watch: runWatch, context: runContext, doctor: runDoctor };

// Resolve the default values for the per-command deps once so every handler
// sees a fully-populated deps object instead of threading `?? process.cwd()`
// (etc.) through every call.
function resolveRunCommandDeps(deps) {
  return {
    client: deps.client,
    io: deps.io ?? process,
    signal: deps.signal,
    executablePath: deps.executablePath,
    cwd: deps.cwd ?? process.cwd(),
    homeDirectory: deps.homeDirectory ?? os.homedir(),
    env: deps.env ?? process.env,
    runShellCommand: deps.runShellCommand ?? defaultShellRunner,
    platform: deps.platform ?? process.platform,
    checkSkills: deps.checkSkills ?? defaultCheckSkills,
    resolveWorkspaceRoot: deps.resolveWorkspaceRoot ?? resolveWorkspaceRoot,
  };
}

export async function runCommand(command, options, deps = {}) {
  if (!Object.hasOwn(HANDLERS, command)) throw new Error(`unknown command: ${command}`);
  const handler = HANDLERS[command];
  return handler(options, resolveRunCommandDeps(deps));
}