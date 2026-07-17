import fs from "node:fs";
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

export function normalizeDirectory(directory) {
  let normalized;
  try {
    normalized = fs.realpathSync(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `directory does not exist: ${directory}`,
      `Use an existing directory path for --directory (${message})`
    );
  }
  if (!fs.statSync(normalized).isDirectory()) {
    throw new UsageError(
      `path is not a directory: ${directory}`,
      "Use --directory with a workspace directory, not a file"
    );
  }
  return normalized;
}

export async function runCommand(command, options, { client, io = process, signal, executablePath, cwd = process.cwd() } = {}) {
  switch (command) {
    case "home": {
      const directory = normalizeDirectory(options.directory || cwd);
      const listed = await client.request("task.list", { directory });
      return homeView(projectList(listed), { executablePath, workspace: directory });
    }
    case "version":
      return { name: "taskferry", version: "2.0.0", protocolVersion: 1 };
    case "dispatch": {
      const directory = normalizeDirectory(options.directory || cwd);
      return client.request("task.dispatch", {
        prompt: options.prompt,
        directory,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),
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
        await streamTaskEvents({
          client,
          io,
          signal,
          directory: initial.directory,
          taskId: options.taskId,
          summaries: true,
          format: "toon",
        });
        const detail = await client.request("task.status", { taskId: options.taskId });
        return leanStatus(detail, { full: options.full });
      }
      const detail = await client.request("task.wait", {
        taskId: options.taskId,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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
        const waited = await client.request("task.wait", { taskId: options.taskId });
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
        ...(options.style === "activity" ? { style: options.style } : {}),
      });
      return options.style === "report" ? summary : { style: options.style, ...summary };
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
      const health = await client.request("system.health", {});
      return options.full ? { ...health, cliVersion: "2.0.0", protocolVersion: 1 } : health;
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
  };
}

function streamTaskEvents({ client, io, signal, directory, taskId, summaries, format }) {
  let settle;
  let abortHandler;
  const finished = new Promise((resolve, reject) => {
    let settled = false;
    settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result ?? { directory, watching: false });
    };
    abortHandler = () => settle();
    if (signal?.aborted) {
      settle();
      return;
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
    Promise.resolve(client.subscribe({ directory, ...(summaries ? { summaries: true } : {}) }, (event) => {
      if (taskId && event.taskId !== taskId) return;
      io.stdout.write(`${formatWatchEvent(event, format)}\n`);
      if (taskId && TERMINAL_STATUSES.has(event.status)) {
        settle({ directory, watching: false, event });
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
        io.stdout.write(`${formatWatchEvent(event, format)}\n`);
        settle({ directory, watching: false, event });
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
      ? normalizeDirectory((await client.request("task.status", { taskId: options.taskId })).directory)
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
