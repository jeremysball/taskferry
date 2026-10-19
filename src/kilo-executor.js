/** @typedef {import("./executor.js").SpawnLaunchContext} SpawnLaunchContext */
/** @typedef {import("./executor.js").WorkerExecutor} WorkerExecutor */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  SUMMARY_ISOLATION_PROMPT,
  appendPromptFileArgs,
  identityLogEvent,
  isSafeBindSource,
  listModelsOutput,
  resolveConfigBindSource,
} from "./executor-shared.js";

const execFileAsync = promisify(execFile);
const LIST_MODELS_TIMEOUT_MS = 30000;

/**
 * The kilo executor runs a ferry on the kilo CLI.
 *
 * kilo's `--format json` event stream is the same shape opencode emits: a
 * `text` event per assistant message part and a `step_finish` event carrying
 * `part.tokens` (input, output, reasoning, cache read and write) and
 * `part.cost`. So the shared log parser in tasks.js reads a kilo stream with
 * no per-executor handling, and `normalizeLogEvent` is the identity.
 *
 * What differs from opencode is the launch surface and the credentials:
 * kilo keeps its config in `~/.config/kilo`, and every provider kilo reaches
 * through an environment variable (LLM_GATEWAY_API_KEY and friends) is
 * inherited by the sandbox from the daemon's environment. A host that keeps
 * kilo's own login in `~/.kilocode/cli/config.json` gets that file bound
 * read-only at its own path, so a dispatch cannot rewrite the credential.
 *
 * @param {{execFileFn?: typeof execFileAsync}} [options]
 * @returns {WorkerExecutor}
 */
export function kiloExecutor({ execFileFn = execFileAsync } = {}) {
  return {
    id: "kilo",
    taskIdPrefix: "kilo",
    errorBucketPrefix: "kilo",
    // The summary pass runs on the cheap flash tier with a 1M window: a
    // summary of a 175k context has to fit in the summarizer, which is the
    // same reason kilo's own compaction buffer is 25000. taskferry's summary
    // path currently pins every summary to the opencode executor, so this
    // field is not read yet; it states which model a kilo summary would use.
    defaultSummaryModel: "llmgateway/glm-5.3-flash",
    binaryName: "kilo",
    /** @type {(env: NodeJS.ProcessEnv) => Promise<string>} */
    listModelsFn: async (env) =>
      listModelsOutput("kilo", ["models"], env, { execFileFn, timeout: LIST_MODELS_TIMEOUT_MS }),
    /** @param {SpawnLaunchContext} ctx @returns {string[]} */
    buildSpawnArgs(ctx) {
      const args = ["run", "--auto", "--format", "json"];
      if (ctx.model) args.push("--model", ctx.model);
      if (ctx.sessionId) args.push("--session", ctx.sessionId);
      if (!ctx.isSummary && ctx.variant) args.push("--variant", ctx.variant);
      // A summary run summarizes the session snapshot, so the snapshot is the
      // attachment. Without it the run would report on nothing at all.
      if (ctx.isSummary && ctx.snapshotPath) args.push("-f", ctx.snapshotPath);
      return appendPromptFileArgs(args, ctx);
    },
    buildSummaryPrompt() {
      return SUMMARY_ISOLATION_PROMPT;
    },
    // kilo's event stream already carries opencode's event shape.
    normalizeLogEvent: identityLogEvent,
    /**
     * Bind what a sandboxed kilo needs to resolve the same models it would
     * unsandboxed: its config directory (read-only, so a dispatch cannot
     * rewrite the fleet's provider definitions) and the kilo gateway token.
     * kilo's session database, logs and storage land in the per-task data
     * home, so two concurrent dispatches never share one kilo.db.
     * @param {{homeDir: string, dataDir: string, taskId: string, spawnEnv: NodeJS.ProcessEnv, existsFn: (file: string) => boolean, lstatFn?: (file: string) => {isSymbolicLink: () => boolean, isFile?: () => boolean, nlink?: number}, readdirFn: (dir: string) => string[], realpathFn?: (file: string) => string, sessionId?: string|null, launchDirectory?: string|null}} args
     */
    sandboxAuthFile({ homeDir, dataDir, taskId, spawnEnv, existsFn, lstatFn = fs.lstatSync, readdirFn, realpathFn = fs.realpathSync }) {
      const sandboxedDataHome = path.join(dataDir, "kilo-data", taskId);
      const sandboxedConfigHome = path.join(sandboxedDataHome, "config");
      const sandboxedConfigDir = path.join(sandboxedConfigHome, "kilo");
      /** @type {[string, string][]} */
      const extraRoBinds = [];

      // kilo's own login, on the hosts that keep one. A credential path, so
      // the symlink guard applies: a link here would hand the worker a
      // different file's contents. It is bound read-only at its own path, so
      // a dispatch cannot rewrite the credential.
      const realKiloToken = path.join(homeDir, ".kilocode", "cli", "config.json");
      if (existsFn(realKiloToken) && isSafeBindSource(realKiloToken, lstatFn)) {
        extraRoBinds.push([realKiloToken, realKiloToken]);
      }

      // the fleet's kilo config: provider definitions, themes, tui settings.
      const realConfigDir = path.join(spawnEnv.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "kilo");
      if (existsFn(realConfigDir) && isSafeBindSource(realConfigDir, lstatFn)) {
        for (const entry of readdirFn(realConfigDir)) {
          // the same skip the opencode executor makes: the config directory
          // holds a .gitignore for the hosts that keep their config in a
          // repository, and it has no business inside the sandbox.
          if (entry === ".gitignore") continue;
          const fullPath = path.join(realConfigDir, entry);
          const bindSource = resolveConfigBindSource(fullPath, lstatFn, realpathFn);
          if (bindSource) extraRoBinds.push([bindSource, path.join(sandboxedConfigDir, entry)]);
        }
      }

      return {
        sandboxedDataHome,
        extraRoBinds,
        // kilo keeps its state under XDG_STATE_HOME, its session database
        // under XDG_DATA_HOME, and its cache under XDG_CACHE_HOME. Without
        // those set it finds the host's ~/.local/state/kilo and ~/.cache/kilo
        // read-only inside the sandbox and falls back to a directory that is
        // not this task's, so all three point inside the per-task data home.
        sandboxEnv: {
          XDG_DATA_HOME: sandboxedDataHome,
          XDG_STATE_HOME: path.join(sandboxedDataHome, "state"),
          XDG_CACHE_HOME: path.join(sandboxedDataHome, "cache"),
          XDG_CONFIG_HOME: sandboxedConfigHome,
        },
      };
    },
  };
}
