import fs from "node:fs";
import os from "node:os";
import { UsageError } from "./args.js";
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
import { normalizeDirectory } from "./paths.js";

// Default timeout for the CLI `wait` command (and `summary --wait`) when no
// explicit --timeout-ms is given. Kept generous (15 min) so real tasks aren't
// cut off, but finite so a hung task doesn't block the caller forever. The
// 45 s MAX_WAIT_MS in tasks.js is for advisor's internal polling — a different,
// much shorter-lived use case.
const DEFAULT_WAIT_TIMEOUT_MS = 900000;

/**
 * Resolve the effective default wait timeout: explicit env var override, or the
 * built-in default. Returns `null` when the env var is set to "0" (opt-out).
 * @param {NodeJS.ProcessEnv} env
 * @returns {number|null}
 */
function resolveWaitDefaultTimeoutMs(env) {
  if (env.TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS === "0") return null;
  const envMs = Number(env.TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS);
  return Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_WAIT_TIMEOUT_MS;
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


export async function runCommand(command, options, { client, io = process, signal, executablePath, cwd = process.cwd(), homeDirectory = os.homedir(), env = process.env, runShellCommand = defaultShellRunner, platform = process.platform, checkSkills = defaultCheckSkills } = {}) {
  switch (command) {
    case "home": {
      const directory = normalizeDirectory(options.directory || cwd);
      const listed = await client.request("task.list", { directory });
      return homeView(projectList(listed), { executablePath, workspace: directory });
    }
    case "version":
      return { name: "taskferry", version: "2.0.0", protocolVersion: 1 };
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
        ...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),
        ...(options.finalMarker === undefined ? {} : { finalMarker: options.finalMarker }),
        ...(options.noSandbox === undefined ? {} : { noSandbox: options.noSandbox }),
        ...(options.allowedDirs === undefined ? {} : { allowedDirs: options.allowedDirs }),
        ...(process.env.CLAUDE_CODE_SESSION_ID ? { originSessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      });
    }
    case "cancel":
      return client.request("task.cancel", {
        taskId: options.taskId,
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      });
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
      const directory = normalizeDirectory(options.directory || cwd);
      return client.request("task.advisor", {
        prompt: options.prompt,
        directory,
        model: options.model,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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
      });
      return options.mode === "report" ? summary : { mode: options.mode, ...summary };
    }
    case "result": {
      const detail = await client.request("task.result", {
        ...(options.full ? { full: true } : {}),
        ...(options.fields ? { fields: options.fields } : {}),
        taskId: options.taskId,
      });
      return leanResult(detail, { full: options.full, fields: options.fields });
    }
    case "list": {
      const params = options.all ? {} : { directory: normalizeDirectory(options.directory || cwd) };
      const listed = await client.request("task.list", params);
      return projectList(listed, { limit: options.limit });
    }
    case "watch":
      return watchCommand(options, { client, io, signal, cwd });
    case "context": {
      const directory = normalizeDirectory(options.directory || cwd);
      const context = await client.request("task.context", { directory });
      return contextForHook(projectContext(context), options.format);
    }
    case "doctor": {
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
        warnings.push(`Filesystem sandboxing is unavailable: bwrap is not installed (${bwrap.reason}). Dispatched tasks run without confinement. Install bubblewrap (e.g. apt install bubblewrap), or opt out explicitly with TASKFERRY_DISABLE_SANDBOX=1.`);
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

function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format }) {
  let settle;
  let abortHandler;
  // `directory` is only known upfront when the caller already had it (plain
  // `watch --directory`); a taskId-scoped `watch --task-id` subscribes by
  // taskId directly (the daemon resolves the directory server-side) and only
  // learns it once the first matching event arrives.
  let resolvedDirectory = directory;
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
      io.stdout.write(`${formatWatchEvent(event, format, io.stdout.isTTY)}\n`);
      if (taskId && TERMINAL_STATUSES.has(event.status)) {
        settle({ directory: resolvedDirectory, watching: false, event });
      }
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
        io.stdout.write(`${formatWatchEvent(event, format, io.stdout.isTTY)}\n`);
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
  });
}

async function watchCommand(options, { client, io, signal, cwd }) {
  const directory = options.directory
    ? normalizeDirectory(options.directory)
    : options.taskId
      ? null
      : normalizeDirectory(cwd);
  return streamTaskEvents({
    client,
    io,
    signal,
    directory,
    taskId: options.taskId,
    summaries: options.summaries,
    format: options.format,
  }).finally(() => {
    if (client.close) client.close();
  });
}
