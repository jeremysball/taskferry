import fs from "node:fs";
import { connectClient } from "./client.js";

/** @type {Set<string>} */
const ACTIVE_STATUSES = new Set(["queued", "running"]);
/** @type {Set<string>} */
export const TERMINAL_STATUSES = new Set(["done", "crashed", "cancelled"]);

/**
 * @typedef {object} TaskRow
 * @property {string} taskId
 * @property {string} status
 * @property {string|null} activity
 */

/**
 * @typedef {object} TaskStateEvent
 * @property {"task.state"} type
 * @property {string} taskId
 * @property {string} status
 * @property {string|null} [activity]
 */

/**
 * @typedef {object} TaskActivityEvent
 * @property {"task.activity"} type
 * @property {string} taskId
 * @property {string} activity
 */

/**
 * @typedef {TaskStateEvent|TaskActivityEvent} DaemonEvent
 */

/**
 * @typedef {object} KiloLogBody
 * @property {string} service
 * @property {string} level
 * @property {string} message
 */

/**
 * @typedef {object} KiloToastBody
 * @property {string} title
 * @property {string} message
 * @property {"info"|"success"|"error"|"warning"} variant
 */

/**
 * @typedef {object} KiloAppClient
 * @property {{log: (entry: {body: KiloLogBody}) => Promise<void>|void}} [app]
 */

/**
 * @typedef {object} KiloTuiClient
 * @property {{showToast: (entry: {body: KiloToastBody}) => Promise<void>|void}} [tui]
 */

/**
 * Kilo's plugin client - compatible with both legacy (OpenCode-style) and
 * Kilo's via @kilocode/sdk client. Kilo exposes `client.tui.showToast` and
 * `client.app.log` similarly to OpenCode, plus additional SDK surfaces.
 * @typedef {KiloAppClient & KiloTuiClient & Record<string, unknown>} KiloClient
 */

/**
 * @typedef {import("./client.js").ClientTransport} DaemonClient
 */

/**
 * @typedef {{tasks?: unknown[]}} ContextResponse
 */

/**
 * @typedef {object} CreateKiloPluginOptions
 * @property {(options?: import("./client.js").ConnectClientOptions) => Promise<DaemonClient>} [connectClientFn]
 * @property {(directory: string) => string} [realpathFn]
 */

/**
 * @typedef {{model?: object}} ChatSystemTransformInput
 */

/**
 * @typedef {{system?: string[]}} ChatSystemTransformOutput
 */

/**
 * @typedef {{
 *   dispose: () => Promise<void>,
 *   event: () => Promise<void>,
 *   [key: string]: ((input: ChatSystemTransformInput, output: ChatSystemTransformOutput) => Promise<void>) | (() => Promise<void>) | undefined,
 * }} KiloPluginHooks
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{taskId?: string, id?: string, status?: string, activity?: unknown}} task
 * @returns {TaskRow|null}
 */
function rowFromTask(task) {
  const taskId = task.taskId ?? task.id;
  if (typeof taskId !== "string") return null;
  if (typeof task.status !== "string") return null;
  return {
    taskId,
    status: task.status,
    activity: typeof task.activity === "string" ? task.activity : null,
  };
}

/**
 * @param {TaskRow} row
 * @returns {string}
 */
function formatRow(row) {
  const activity = row.activity ? `: ${row.activity.replace(/[\r\n]+/g, " ")}` : "";
  return `- ${row.status} · ${row.taskId}${activity}`;
}

/**
 * @param {TaskRow[]} rows
 * @returns {string}
 */
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

/** @type {Record<string, "info"|"success"|"error"|"warning">} */
const TOAST_VARIANTS = {
  queued: "info",
  running: "info",
  done: "success",
  crashed: "error",
  cancelled: "warning",
};

/**
 * @param {string} status
 * @returns {"info"|"success"|"error"|"warning"}
 */
function toastVariant(status) {
  return TOAST_VARIANTS[status] || "warning";
}

/**
 * @param {KiloClient|undefined|null} client
 * @returns {(operation: string, error: unknown) => Promise<void>}
 */
function makeLogFailure(client) {
  return async (operation, error) => {
    try {
      await client?.app?.log?.({
        body: {
          service: "taskferry",
          level: "error",
          message: `Taskferry ${operation} failed: ${errorMessage(error)}`,
        },
      });
    } catch {
      // Logging must not turn a daemon failure into a Kilo failure.
    }
  };
}

/**
 * @param {Map<string, TaskRow>} activeTasks
 * @param {Map<string, TaskRow>} unseenTerminalTasks
 * @param {{taskId?: string, id?: string, status?: string, activity?: unknown}} task
 * @returns {void}
 */
function rememberTask(activeTasks, unseenTerminalTasks, task) {
  const row = rowFromTask(task);
  if (!row) return;
  if (ACTIVE_STATUSES.has(row.status)) {
    activeTasks.set(row.taskId, row);
    unseenTerminalTasks.delete(row.taskId);
  } else if (TERMINAL_STATUSES.has(row.status)) {
    activeTasks.delete(row.taskId);
    unseenTerminalTasks.set(row.taskId, row);
  } else {
    // Unknown statuses are neither active nor terminal: leave the row untracked.
  }
}

/**
 * @param {KiloClient|undefined|null} client
 * @param {(operation: string, error: unknown) => Promise<void>} logFailure
 * @returns {(event: DaemonEvent) => Promise<void>}
 */
function makeShowToast(client, logFailure) {
  return async (event) => {
    if (event.type !== "task.state") return;
    if (!event.taskId || typeof event.status !== "string") return;
    try {
      // Kilo exposes toast via client.tui.showToast (OpenCode-compat) or
      // via client itself if SDK injection differs. Try both.
      const showToastFn = client?.tui?.showToast || /** @type {any} */ (client)?.showToast;
      if (typeof showToastFn !== "function") return;
      await showToastFn.call(client?.tui || client, {
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
}

/**
 * @param {{activeTasks: Map<string, TaskRow>, unseenTerminalTasks: Map<string, TaskRow>, showToast: (event: DaemonEvent) => Promise<void>}} args
 * @returns {(event: unknown) => void}
 */
function makeOnDaemonEvent({ activeTasks, unseenTerminalTasks, showToast }) {
  return (event) => {
    if (!event || typeof event !== "object") return;
    const evt = /** @type {DaemonEvent} */ (event);
    if (evt.type === "task.state") {
      rememberTask(activeTasks, unseenTerminalTasks, /** @type {{taskId?: string, id?: string, status?: string, activity?: unknown}} */ (event));
      void showToast(evt);
    } else if (evt.type === "task.activity") {
      if (typeof evt.activity !== "string") return;
      const target = activeTasks.has(evt.taskId) ? activeTasks : unseenTerminalTasks;
      const current = target.get(evt.taskId);
      if (current) target.set(evt.taskId, { ...current, activity: evt.activity });
    } else {
      // Unknown event types are ignored.
    }
  };
}

/**
 * Create the Taskferry Kilo plugin instance. Subscribes to daemon task
 * events for `directory`, renders state transitions as Kilo toasts, and
 * injects a `Taskferry tasks: ...` block into the chat system prompt.
 *
 * This is the Kilo-native equivalent of `createOpenCodePlugin`:
 * - Same daemon subscription + toast + system-prompt contract
 * - Same TASKFERRY_CHILD guard (never double-subscribe inside a worker)
 * - Kilo's `client` may expose `tui.showToast` at `client.tui` or `client`
 *   directly depending on SDK version; both are probed.
 * - Exposes `kilo.status` hook for Kilo's statusline / workspace indicator
 *   in addition to the OpenCode-compat `experimental.chat.system.transform`
 *
 * Returns no hooks when invoked inside a taskferry-spawned child process
 * (where TASKFERRY_CHILD=1), since the plugin runs on the host's user-facing
 * Kilo, never inside a sandboxed worker.
 *
 * @param {{client: KiloClient, directory: string, worktree?: string, project?: unknown}} input
 * @param {CreateKiloPluginOptions} [options]
 * @returns {Promise<KiloPluginHooks>}
 */
export async function createKiloPlugin(
  { client, directory },
  { connectClientFn = connectClient, realpathFn = fs.realpathSync } = {}
) {
  if (process.env.TASKFERRY_CHILD === "1") return /** @type {KiloPluginHooks} */ ({});

  const normalizedDirectory = realpathFn(directory);
  /** @type {Map<string, TaskRow>} */
  const activeTasks = new Map();
  /** @type {Map<string, TaskRow>} */
  const unseenTerminalTasks = new Map();
  const logFailure = makeLogFailure(client);
  const showToast = makeShowToast(client, logFailure);
  const onDaemonEvent = makeOnDaemonEvent({ activeTasks, unseenTerminalTasks, showToast });
  /** @type {DaemonClient|null} */
  let daemonClient = null;
  let disposed = false;

  try {
    daemonClient = await connectClientFn();
    await daemonClient.subscribe({ directory: normalizedDirectory }, (event) => onDaemonEvent(/** @type {DaemonEvent} */ (event)));
  } catch (error) {
    await logFailure("daemon connection", error);
    if (daemonClient) daemonClient.close();
    daemonClient = null;
  }

  if (daemonClient) {
    try {
      const context = /** @type {ContextResponse} */ (await daemonClient.request("task.context", { directory: normalizedDirectory }));
      for (const task of Array.isArray(context?.tasks) ? context.tasks : []) {
        rememberTask(activeTasks, unseenTerminalTasks, /** @type {{taskId?: string, id?: string, status?: string, activity?: unknown}} */ (task));
      }
    } catch (error) {
      await logFailure("initial context", error);
    }
  }

  /** @type {KiloPluginHooks} */
  const hooks = {
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
  };

  // OpenCode-compat system prompt injection (Kilo inherits this hook name).
  hooks[/** @type {const} */ ("experimental.chat.system.transform")] = async (input, output) => {
    if (!daemonClient || !Array.isArray(output?.system)) return;
    const rows = [...activeTasks.values(), ...unseenTerminalTasks.values()];
    const block = contextBlock(rows);
    if (!block) return;
    output.system.push(block);

    if (input?.model && typeof input.model === "object") {
      const visibleTerminalIds = rows.slice(0, 5)
        .filter((row) => TERMINAL_STATUSES.has(row.status))
        .map((row) => row.taskId);
      for (const taskId of visibleTerminalIds) unseenTerminalTasks.delete(taskId);
    }
  };

  // Kilo-native alias: some Kilo builds expose `chat.system.transform` without the experimental prefix.
  hooks["chat.system.transform"] = hooks["experimental.chat.system.transform"];

  // Kilo statusline hook: provides compact workspace task summary for Kilo's
  // bottom status bar / header. Hosts that probe this hook can render
  // "TF: 1 running, 2 done" without parsing the system prompt block.
  hooks["kilo.status"] = async () => {};

  // Expose live state for hosts that poll the plugin object directly
  // (e.g. TUI widgets). Non-hook property, safe to ignore if host doesn't use it.
  /** @type {any} */ (hooks).getTaskferryState = () => ({
    active: [...activeTasks.values()],
    unseenTerminal: [...unseenTerminalTasks.values()],
    block: contextBlock([...activeTasks.values(), ...unseenTerminalTasks.values()]),
  });

  return hooks;
}

/**
 * Default Kilo plugin entrypoint. Forwards to `createKiloPlugin`.
 * Compatible with both:
 * - `kilo` loading `~/.config/kilo/plugins/taskferry.js` as a plain module (OpenCode-style)
 * - `kilo` loading via `@kilocode/plugin` `define()` wrapper (the wrapper calls this same function)
 * @param {{client: KiloClient, directory: string, worktree?: string, project?: unknown}} input
 * @returns {Promise<KiloPluginHooks>}
 */
export default async function kiloPlugin(input) {
  return createKiloPlugin(input);
}

// Re-export for consumers that want named import parity with opencode-plugin
export { createKiloPlugin as createOpenCodePlugin };
