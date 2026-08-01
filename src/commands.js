import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import {
  contextForHook,
  formatWatchEvent,
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

// Default timeout for the CLI `wait` command (and `summary --wait`) when no
// explicit --timeout is given. Kept generous (15 min) so real tasks aren't
// cut off, but finite so a hung task doesn't block the caller forever. The
// 45 s MAX_WAIT_MS in tasks.js is for advisor's internal polling — a different,
// much shorter-lived use case.
const DEFAULT_WAIT_TIMEOUT_MS = 900000;

// Default budget for advisor's auto-attached context: ~30k tokens, well
// under any provider's context window even after the canned prompt and the
// caller's own --prompt are added on top.
const DEFAULT_ADVISOR_CONTEXT_CHARS = 120000;

/**
 * Resolve the effective advisor context budget: explicit env var override,
 * then the config file's `advisorContextChars`, then the built-in default.
 * Mirrors resolveWaitDefaultTimeoutMs()'s resolution order.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolveAdvisorContextChars(env) {
  const envChars = Number(env.TASKFERRY_ADVISOR_CONTEXT_CHARS);
  if (Number.isFinite(envChars) && envChars > 0) return envChars;
  const configChars = Number(loadConfig({ env }).advisorContextChars);
  return Number.isFinite(configChars) && configChars > 0 ? configChars : DEFAULT_ADVISOR_CONTEXT_CHARS;
}

/**
 * The Claude Code project-directory slug for a given absolute cwd: the path
 * with every separator replaced by "-" (e.g. "/workspace/taskferry" ->
 * "-workspace-taskferry"), matching the convention Claude Code itself uses
 * under ~/.claude/projects/.
 * @param {string} cwd
 * @returns {string}
 */
function claudeProjectSlug(cwd) {
  return cwd.split(path.sep).join("-");
}

/**
 * @param {string} homeDirectory
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
function claudeTranscriptPath(homeDirectory, cwd, sessionId) {
  return path.join(homeDirectory, ".claude", "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Reads the last `maxChars` Unicode code points of `filePath` without
 * loading the whole file into memory -- a real transcript can be large.
 * UTF-8 code points are at most 4 bytes, so reading `maxChars * 4` bytes
 * from the tail guarantees enough raw bytes to yield `maxChars` code
 * points once decoded.
 * @param {string} filePath
 * @param {number} maxChars
 * @returns {string}
 */
function readTailChars(filePath, maxChars) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `advisor could not read the Claude session transcript at ${filePath}: ${message}`,
      "CLAUDE_CODE_SESSION_ID was set but its transcript file wasn't readable -- pass --prompt explicitly to skip auto-context, or check the transcript path"
    );
  }
  const bytes = Math.min(size, maxChars * 4);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
  } finally {
    fs.closeSync(fd);
  }
  const codePoints = Array.from(buffer.toString("utf8"));
  return codePoints.length > maxChars ? codePoints.slice(-maxChars).join("") : codePoints.join("");
}

const ADVISOR_TAIL_CHARS_CAP = 131072;

const ADVISOR_CANNED_PROMPT = `You are an advisor reviewing the in-progress work of a cheaper dispatcher agent. The text that follows is a tail of its session log: its current task, what it has read, what it has decided, and what it is about to do next. Treat it as suspect, not as a draft to refine.

Your reply goes directly back to that autonomous agent mid-task; it will not be read by a human first. Do not summarize what the ferry did and do not validate its choices for politeness. Push back.

Interrogate its assumptions: list each one the ferry is acting on without verifying, and say whether it is load-bearing. Hunt for blind spots: what did it not read, not run, not check, and where is a known foot-gun pattern it is about to step on (silent error swallow, mock-green-real-fail, off-by-one on the boundary it is touching, an unverified config default). Propose concrete alternatives: for each decision it is about to lock in, name at least one it has not considered, with the file and approximate line, not just an abstraction. Rank so the single highest-leverage change comes first.

Format: bulleted, terse, no preamble, no closing summary. Short sentences. Reference code as \`path/to/file.js:NNN\`. Prefer "should" and "must" over "you might consider." If there is nothing material to add, reply \`no change, proceed\` and stop.`;

/**
 * Resolves advisor's auto-attached context: a Claude session transcript
 * tail when CLAUDE_CODE_SESSION_ID is set (this call came directly from a
 * Claude Code session), else the calling ferry's own task.tail when
 * TASKFERRY_TASK_ID is set (this call came from inside a taskferry-spawned
 * worker), else null (no source available).
 * @param {object} params
 * @param {{request: (method: string, params: object) => Promise<any>}} params.client
 * @param {NodeJS.ProcessEnv} params.env
 * @param {string} params.cwd
 * @param {string} params.homeDirectory
 * @returns {Promise<{source: string, text: string} | null>}
 */
async function gatherAdvisorContext({ client, env, cwd, homeDirectory }) {
  const budget = resolveAdvisorContextChars(env);
  if (env.CLAUDE_CODE_SESSION_ID) {
    const transcriptPath = claudeTranscriptPath(homeDirectory, cwd, env.CLAUDE_CODE_SESSION_ID);
    const text = readTailChars(transcriptPath, budget);
    return { source: "claude-session", text };
  }
  if (env.TASKFERRY_TASK_ID) {
    const tailed = await client.request("task.tail", { taskId: env.TASKFERRY_TASK_ID, chars: Math.min(budget, ADVISOR_TAIL_CHARS_CAP) });
    const text = tailed.text === "none observed yet" ? "" : tailed.text;
    return { source: "ferry-log", text };
  }
  return null;
}

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
      prompt,
      directory,
      model: env.TASKFERRY_ADVISOR_SUMMARIZER_MODEL || ADVISOR_SUMMARIZE_MODEL,
      env,
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


export { resolveAdvisorContextChars, claudeTranscriptPath, readTailChars };

export async function runCommand(command, options, { client, io = process, signal, executablePath, cwd = process.cwd(), homeDirectory = os.homedir(), env = process.env, runShellCommand = defaultShellRunner, platform = process.platform, checkSkills = defaultCheckSkills, resolveWorkspaceRoot: resolveWorkspaceRootFn = resolveWorkspaceRoot } = {}) {
  switch (command) {
    case "home": {
      const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
      const listed = await client.request("task.list", { directory });
      return homeView(projectList(listed), { executablePath, workspace: directory });
    }
    case "version":
      return { name: "taskferry", version: readPackageVersion(), protocolVersion: PROTOCOL_VERSION };
    case "dispatch": {
      try {
        checkSkills();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UsageError(
          `taskferry's own skill files are out of sync: ${message}`,
          "Run `npm run skill:generate` in the taskferry repo, then retry dispatch"
        );
      }
      const directory = normalizeDirectory(options.directory || cwd);
      return client.request("task.dispatch", {
        prompt: options.prompt,
        directory,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.finalMarker === undefined ? {} : { finalMarker: options.finalMarker }),
        ...(options.noSandbox === undefined ? {} : { noSandbox: options.noSandbox }),
        ...(options.noOverlay === undefined ? {} : { noOverlay: options.noOverlay }),
        ...(options.allowedDirs === undefined ? {} : { allowedDirs: options.allowedDirs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
        env,
        ...(process.env.CLAUDE_CODE_SESSION_ID ? { originSessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      });
    }
    case "cancel":
      return client.request("task.cancel", {
        taskId: options.taskId,
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      });
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
    case "wait": {
      if (options.summarize) {
        // do not close the client here: cli.js's top-level finally owns the
        // lifecycle, and the trailing task.status RPC below needs the same
        // open connection. (Unlike watchCommand, which closes after its single stream.)
        const initial = await client.request("task.status", { taskId: options.taskId });
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
        const detail = await client.request("task.status", { taskId: options.taskId });
        return leanStatus(detail, { full: options.full });
      }
      const waitTimeoutMs = options.timeoutMs ?? resolveWaitDefaultTimeoutMs(env);
      const detail = await client.request("task.wait", {
        taskId: options.taskId,
        ...(waitTimeoutMs != null ? { timeoutMs: waitTimeoutMs } : {}),
        ...(options.tailChars === undefined ? {} : { tailChars: options.tailChars }),
      });
      return leanStatus(detail, { full: options.full });
    }
    case "advisor": {
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
      let finalContext = gathered;
      if (gathered && options.summarizeContext) {
        // Only relabel the source when condensation actually changed the
        // text -- summarizeContextText() returns the input unchanged on
        // any failure, and the fallback test in Step 5 expects that case
        // to still read as plain "ferry-log", not "summarized ferry-log".
        const condensed = await summarizeContextText(client, gathered.text, { env, directory });
        finalContext = condensed === gathered.text ? gathered : { source: `summarized ${gathered.source}`, text: condensed };
      }
      // The caller's own --prompt leads the assembled text (when given), with
      // the canned pushback framing and auto-attached context appended after
      // it -- not the other way around. With the canned prompt first, a
      // model reliably answered its "push back on the ferry's plan" framing
      // instead of the caller's actual ask, even though the ask was present
      // later in the same text (confirmed live: two separate models both did
      // this on 2026-07-31, e.g. openai/gpt-5.6-sol was fine standalone but
      // cheapestinference/glm-5.2 and cheapestinference/kimi-k2.7 answered
      // the canned framing when it came first).
      const assembledPrompt = [
        ...(options.prompt ? [options.prompt] : []),
        ADVISOR_CANNED_PROMPT,
        ...(finalContext ? [`\n--- attached context (${finalContext.source}, ${finalContext.text.length} chars) ---\n${finalContext.text}\n---`] : []),
      ].join("\n");
      return client.request("task.advisor", {
        prompt: assembledPrompt,
        directory,
        model: options.model,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
        env,
      });
    }
    case "status": {
      const detail = await client.request("task.status", { taskId: options.taskId });
      return leanStatus(detail, { full: options.full });
    }
    case "tail":
      return client.request("task.tail", {
        taskId: options.taskId,
        ...(options.chars === undefined ? {} : { chars: options.chars }),
      });
    case "summary": {
      if (options.wait) {
        const waitTimeoutMs = resolveWaitDefaultTimeoutMs(env);
        const waited = await client.request("task.wait", {
          taskId: options.taskId,
          ...(waitTimeoutMs != null ? { timeoutMs: waitTimeoutMs } : {}),
        });
        if (waited.status === "running" || waited.status === "queued") {
          return {
            ...leanStatus(waited, { full: options.full }),
            note: `Task has not settled yet (status: ${waited.status}); run taskferry summary --wait again to keep waiting, or omit --wait to summarize the in-progress task`,
          };
        }
      }
      const summary = await client.request("task.summary", {
        taskId: options.taskId,
        ...(options.maxWords === undefined ? {} : { maxWords: options.maxWords }),
        ...(options.mode === "activity" ? { mode: options.mode } : {}),
        // env is omitted on the activity path: protocol.js rejects env +
        // mode "activity" because the activity path reads the cached task
        // activity and spawns nothing, so there is no process to forward
        // caller env into. Report mode (the default) and any future mode
        // keep forwarding env exactly as before.
        ...(options.mode === "activity" ? {} : { env }),
      });
      return options.mode === "report" ? summary : { mode: options.mode, ...summary };
    }
    case "result": {
      // `options.diff` and `options.full` are mutually exclusive (args.js
      // rejects the combination at parse time), so the if/else-if below is
      // deterministic: --diff takes the fields:["diff"] branch, --full takes
      // the full:true branch, neither passes {}. leanResult() still receives
      // `full: options.full` so the local-narrowing step mirrors the
      // server-side contract regardless of which branch was taken above.
      const detail = await client.request("task.result", {
        ...(options.diff ? { fields: ["diff"] } : options.full ? { full: true } : {}),
        ...(!options.diff && options.fields ? { fields: options.fields } : {}),
        taskId: options.taskId,
      });
      return leanResult(detail, { full: options.full, fields: options.diff ? ["diff"] : options.fields });
    }
    case "list": {
      const params = options.all ? {} : { directory: normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd)) };
      const listed = await client.request("task.list", params);
      return projectList(listed, { limit: options.limit });
    }
    case "watch":
      return watchCommand(options, { client, io, signal, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn });
    case "context": {
      const directory = normalizeDirectory(options.directory || resolveWorkspaceRootFn(cwd));
      const context = await client.request("task.context", { directory });
      return contextForHook(projectContext(context), options.format);
    }
    case "doctor": {
      if (options.stats) {
        const listed = await client.request("task.list", {});
        return computeDoctorStats(listed.tasks);
      }
      const checks = await Promise.allSettled([
        client.request("system.health", {}),
        checkClaudeIntegration(runShellCommand),
        checkOpencodePlaywrightIsolation(homeDirectory, env),
        checkClaudeCodePlaywrightIsolation(homeDirectory),
        platform === "linux" ? checkBwrapAvailableAsync(runShellCommand) : Promise.resolve(null),
      ]);
      const health = checks[0].status === "fulfilled" ? checks[0].value : {};
      const claude = checks[1].status === "fulfilled" ? checks[1].value : { installed: false, reason: "check failed" };
      const opencodeMCP = checks[2].status === "fulfilled" ? checks[2].value : { checked: false, reason: "check failed" };
      const claudeCodeMCP = checks[3].status === "fulfilled" ? checks[3].value : { checked: false, reason: "check failed" };
      const bwrap = checks[4].status === "fulfilled" ? checks[4].value : (platform === "linux" ? { checked: false, available: false, reason: "check failed" } : null);
      const warnings = [];
      const info = [];
      if (opencodeMCP.checked && !opencodeMCP.isolated) {
        warnings.push(`Playwright MCP for opencode is not isolated (${opencodeMCP.path}): concurrent dispatches sharing one browser profile crash with SIGKILL. Run taskferry setup to fix, or add --isolated to its command manually.`);
      }
      if (claudeCodeMCP.checked && !claudeCodeMCP.isolated) {
        warnings.push(`Playwright MCP for Claude Code is not isolated${claudeCodeMCP.path ? ` (${claudeCodeMCP.path})` : ""}: concurrent dispatches sharing one browser profile crash with SIGKILL. Run taskferry setup to fix${claudeCodeMCP.reason && !claudeCodeMCP.path ? `, or ${claudeCodeMCP.reason.toLowerCase()}` : ""}.`);
      }
      if (bwrap && !bwrap.available) {
        warnings.push(`Filesystem sandboxing is unavailable: bwrap is not installed (${bwrap.reason}). Dispatches will fail with a spawnError instead of running unconfined. Install bubblewrap (e.g. apt install bubblewrap), or opt out explicitly with TASKFERRY_DISABLE_SANDBOX=1.`);
      }
      if (platform !== "linux") {
        info.push("Filesystem sandboxing (bwrap) is only available on Linux; dispatched tasks on this platform run unconfined.");
      }
      return {
        ...health,
        ...(options.full ? { cliVersion: "2.0.0", protocolVersion: 1 } : {}),
        integrations: { claude, playwrightMcpIsolation: { opencode: opencodeMCP, claudeCode: claudeCodeMCP } },
        ...(warnings.length ? { warnings } : {}),
        ...(info.length ? { info } : {}),
      };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

const TERMINAL_STATUSES = new Set(["done", "crashed", "cancelled", "unknown"]);

function terminalEventFromStatus(detail) {
  return {
    type: "task.state",
    taskId: detail.id,
    directory: detail.directory,
    status: detail.status,
    previousStatus: null,
    occurredAt: new Date().toISOString(),
    activity: null,
    outputWatermark: null,
    originSessionId: detail.originSessionId ?? null,
  };
}

function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format, flushIntervalMs }) {
  let settle;
  let abortHandler;
  // `directory` is only known upfront when the caller already had it (plain
  // `watch --directory`); a taskId-scoped `watch --task-id` subscribes by
  // taskId directly (the daemon resolves the directory server-side) and only
  // learns it once the first matching event arrives.
  let resolvedDirectory = directory;
  // Defensive: the args layer rejects `--flush-interval 0`, so this
  // code path normally sees only positive values, but use `> 0` instead
  // of truthy so any future caller that bypasses args.js can't
  // accidentally fall back to unbuffered per-event streaming on a zero
  // interval (the silent bug this check exists to prevent).
  const buffered = flushIntervalMs && flushIntervalMs > 0 ? new Map() : null;
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
    // On abort (SIGINT/SIGTERM or injected AbortSignal) flush any
    // buffered events first, otherwise up to one `--flush-interval`
    // window's worth of events would be silently dropped on a clean
    // (exit code 0) abort. The setInterval is cleared in the `.finally`
    // below, so this is the only path that emits them on the abort
    // boundary.
    abortHandler = () => {
      if (buffered && buffered.size > 0) flush();
      settle();
    };
    if (signal?.aborted) {
      if (buffered && buffered.size > 0) flush();
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
