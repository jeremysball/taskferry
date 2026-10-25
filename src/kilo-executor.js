/** @typedef {import("./executor.js").SpawnLaunchContext} SpawnLaunchContext */
/** @typedef {import("./executor.js").WorkerExecutor} WorkerExecutor */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  appendPromptFileArgs,
  buildSummaryPrompt,
  identityLogEvent,
  instructionsDestFor,
  listModelsOutput,
  pushSafeRoBind,
  pushXdgAuthBind,
  resolveConfigDirBinds,
} from "./executor-shared.js";

const execFileAsync = promisify(execFile);

/**
 * The kilo executor runs a ferry on the kilo CLI.
 *
 * kilo's `--format json` event stream is the same shape opencode emits: a
 * `text` event per assistant message part and a `step_finish` event carrying
 * `part.tokens` (input, output, reasoning, cache read and write) and
 * `part.cost`. So the shared log parser in tasks.js reads a kilo stream with
 * no per-executor handling, and `normalizeLogEvent` is the identity.
 *
 * The executor object itself is not shared with the opencode executor. The
 * two differ in the binary, the model and session flags, the version probe,
 * the credential binds and the environment keys, so a factory over them would
 * be a bag of hooks with no logic left in it. What is the same between them
 * lives in executor-shared.js: the sandbox bind walk, the summary prompt,
 * the model listing call and the log normalizer.
 *
 * There is no version probe here, and that is deliberate. opencode probes
 * its CLI because opencode 1.x and 2.x take different flags and opencode
 * ignores a flag it does not recognize, so a stale argv would run quietly
 * wrong. kilo has one argv shape and rejects a flag it does not know, so the
 * failure is loud and comes from kilo itself.
 *
 * What differs from opencode is the launch surface and the credentials:
 * kilo keeps its config in `~/.config/kilo`, and every provider kilo reaches
 * through an environment variable (LLM_GATEWAY_API_KEY and friends) is
 * inherited by the sandbox from the daemon's environment. A host that keeps
 * kilo's own login in `~/.kilocode/cli/config.json` gets that file bound
 * read-only at its own path, so a dispatch cannot rewrite the credential.
 * Stored provider credentials are mapped from the host data home into the
 * task's redirected data home through the same read-only bind mechanism.
 *
 * kilo's `step_finish` event carries that request's usage, with the cache
 * read counted separately from the input. A real two-step run on 2026-10-19
 * reported step one as input 17621 with no cache read, and step two as input
 * 285 with a cache read of 17664. A step's context is therefore input plus
 * cache read plus cache write, and summing the steps gives the billed total,
 * which is a different number from the context.
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
    listModelsFn: async (env) => listModelsOutput("kilo", ["models"], env, { execFileFn }),
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
    // kilo's event stream already carries opencode's event shape.
    normalizeLogEvent: identityLogEvent,
    /**
     * Bind what a sandboxed kilo needs to resolve the same models it would
     * unsandboxed: its config directory (read-only, so a dispatch cannot
     * rewrite the fleet's provider definitions), provider auth and gateway token.
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

      pushXdgAuthBind(extraRoBinds, "kilo", homeDir, sandboxedDataHome, { existsFn, lstatFn });

      // kilo's own login, on the hosts that keep one. A credential path, so
      // the symlink guard applies: a link here would hand the worker a
      // different file's contents. It is bound read-only at its own path, so
      // a dispatch cannot rewrite the credential.
      const realKiloToken = path.join(homeDir, ".kilocode", "cli", "config.json");
      pushSafeRoBind(extraRoBinds, realKiloToken, realKiloToken, existsFn, lstatFn);

      // the fleet's kilo config: provider definitions, themes, tui settings.
      // The walk itself is shared with the opencode executor: same symlink
      // rules, same .gitignore skip, same per-entry resolution.
      const realConfigDir = path.join(spawnEnv.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "kilo");
      extraRoBinds.push(
        ...resolveConfigDirBinds({ realConfigDir, sandboxedConfigDir, existsFn, lstatFn, readdirFn, realpathFn }),
      );

      return {
        sandboxedDataHome,
        extraRoBinds,
        // Where an explicitly listed instructions file is mapped; see the
        // opencode executor for why the config walk leaves AGENTS.md unbound.
        instructionsDest: instructionsDestFor(sandboxedConfigDir),
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
    buildSummaryPrompt,
  };
}
