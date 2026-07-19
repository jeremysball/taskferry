import os from "node:os";
import path from "node:path";

export function resolveStateDir(env = process.env) {
  return env.TASKFERRY_STATE_DIR
    || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "taskferry");
}

export function resolveRuntimeDir({ env = process.env, stateDir = resolveStateDir(env) } = {}) {
  if (env.TASKFERRY_RUNTIME_DIR) return env.TASKFERRY_RUNTIME_DIR;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "taskferry");
  return path.join(stateDir, "run");
}
