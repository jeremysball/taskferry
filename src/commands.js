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

async function watchCommand(options, { client, io, signal, cwd }) {
  const directory = normalizeDirectory(options.directory || cwd);
  let stop;
  const finished = new Promise((resolve, reject) => {
    let settled = false;
    stop = () => {
      if (settled) return;
      settled = true;
      resolve({ directory, watching: false });
    };
    if (signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener("abort", stop, { once: true });
    Promise.resolve(client.subscribe({ directory, ...(options.summaries ? { summaries: true } : {}) }, (event) => {
      io.stdout.write(`${formatWatchEvent(event, options.format)}\n`);
    })).catch((error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  return finished.finally(() => {
    signal?.removeEventListener("abort", stop);
    if (client.close) client.close();
  });
}
