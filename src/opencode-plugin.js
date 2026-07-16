import fs from "node:fs";
import { connectClient } from "./client.js";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["done", "crashed", "cancelled"]);
const TOAST_VARIANTS = {
  queued: "info",
  running: "info",
  done: "success",
  crashed: "error",
  cancelled: "warning",
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function rowFromTask(task) {
  return {
    taskId: task.taskId ?? task.id,
    status: task.status,
    activity: typeof task.activity === "string" ? task.activity : null,
  };
}

function formatRow(row) {
  const activity = row.activity ? `: ${row.activity.replace(/[\r\n]+/g, " ")}` : "";
  return `- ${row.status} · ${row.taskId}${activity}`;
}

function contextBlock(rows) {
  if (!rows.length) return "";
  const visible = rows.slice(0, 5);
  const omitted = rows.length - visible.length;
  return [
    "Taskferry tasks:",
    ...visible.map(formatRow),
    ...(omitted ? [`+${omitted} more`] : []),
  ].join("\n");
}

function toastVariant(status) {
  return TOAST_VARIANTS[status] || "warning";
}

/**
 * @param {object} input
 * @param {object} input.client OpenCode's plugin client
 * @param {string} input.directory OpenCode's project directory
 * @param {typeof connectClient} [options.connectClientFn]
 * @param {(directory: string) => string} [options.realpathFn]
 */
export async function createOpenCodePlugin(
  { client, directory },
  { connectClientFn = connectClient, realpathFn = fs.realpathSync } = {}
) {
  if (process.env.TASKFERRY_CHILD === "1") return {};

  const normalizedDirectory = realpathFn(directory);
  const activeTasks = new Map();
  const unseenTerminalTasks = new Map();
  let daemonClient = null;
  let disposed = false;

  const logFailure = async (operation, error) => {
    try {
      await client?.app?.log?.({
        body: {
          service: "taskferry",
          level: "error",
          message: `Taskferry ${operation} failed: ${errorMessage(error)}`,
        },
      });
    } catch {
      // Logging must not turn a daemon failure into an OpenCode failure.
    }
  };

  const rememberTask = (task) => {
    const row = rowFromTask(task);
    if (!row.taskId || typeof row.status !== "string") return;
    if (ACTIVE_STATUSES.has(row.status)) {
      activeTasks.set(row.taskId, row);
      unseenTerminalTasks.delete(row.taskId);
    } else if (TERMINAL_STATUSES.has(row.status)) {
      activeTasks.delete(row.taskId);
      unseenTerminalTasks.set(row.taskId, row);
    }
  };

  const showToast = async (event) => {
    if (!event.taskId || typeof event.status !== "string") return;
    try {
      await client?.tui?.showToast?.({
        body: {
          title: `Taskferry(${event.status} · ${event.taskId})`,
          message: typeof event.activity === "string" && event.activity
            ? event.activity.replace(/[\r\n]+/g, " ")
            : `Task ${event.status}`,
          variant: toastVariant(event.status),
        },
      });
    } catch (error) {
      await logFailure("toast", error);
    }
  };

  const onDaemonEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "task.state") {
      rememberTask(event);
      void showToast(event);
    } else if (event.type === "task.activity") {
      if (typeof event.activity !== "string") return;
      const target = activeTasks.has(event.taskId) ? activeTasks : unseenTerminalTasks;
      const current = target.get(event.taskId);
      if (current) target.set(event.taskId, { ...current, activity: event.activity });
    }
  };

  try {
    daemonClient = await connectClientFn();
    await daemonClient.subscribe({ directory: normalizedDirectory }, onDaemonEvent);
  } catch (error) {
    await logFailure("daemon connection", error);
    if (daemonClient) daemonClient.close();
    daemonClient = null;
  }

  if (daemonClient) {
    try {
      const context = await daemonClient.request("task.context", { directory: normalizedDirectory });
      for (const task of Array.isArray(context?.tasks) ? context.tasks : []) rememberTask(task);
    } catch (error) {
      await logFailure("initial context", error);
    }
  }

  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (daemonClient) {
        const clientToClose = daemonClient;
        daemonClient = null;
        await clientToClose.close();
      }
    },

    event: async () => {},

    "experimental.chat.system.transform": async (input, output) => {
      if (!daemonClient || !Array.isArray(output?.system)) return;
      const rows = [...activeTasks.values(), ...unseenTerminalTasks.values()];
      const block = contextBlock(rows);
      if (!block) return;
      output.system.push(block);

      // This hook runs immediately before OpenCode sends the system prompt to
      // the selected model. Only rows that actually entered that prompt are
      // consumed; merely observing a daemon event leaves them available.
      if (input?.model && typeof input.model === "object") {
        const visibleTerminalIds = rows.slice(0, 5)
          .filter((row) => TERMINAL_STATUSES.has(row.status))
          .map((row) => row.taskId);
        for (const taskId of visibleTerminalIds) unseenTerminalTasks.delete(taskId);
      }
    },
  };
}

export default async function taskferryPlugin(input) {
  return createOpenCodePlugin(input);
}
