// Shared teardown helpers for the three `*-smoke-test.js` scripts (real CLI
// + daemon, no mocks).
//
// `stopDaemon()` used to fire SIGTERM and return immediately, racing the
// daemon's own async shutdown (`daemon.close()` -> `process.exit(0)` in
// src/daemon.js's `main()`). `stopDaemonAndWait()` polls for the pid to
// actually disappear before the caller proceeds to clean up its temp dir.
//
// Separately (and this was the actual cause of the observed EACCES, not the
// SIGTERM race above): a sandboxed dispatch's overlay mount leaves behind a
// kernel-owned overlayfs "workdir" at permission mode 0000 once torn down --
// standard overlayfs behavior, not a taskferry bug. `fs.rmSync(recursive)`
// doesn't chmod an inaccessible-but-owned directory before descending into
// it, so it throws EACCES on that 0000 dir every time, not intermittently --
// retrying the same `fs.rmSync` call changes nothing. GNU `rm -rf` already
// does the chmod-then-recurse dance for exactly this case, so `rmRoot()`
// shells out to it instead of reimplementing that logic in JS.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sends SIGTERM to `pid` and blocks (synchronously) until it actually exits,
 * up to `timeoutMs`. A missing/already-gone pid is a silent no-op.
 * @param {number|undefined} pid
 * @param {{timeoutMs?: number, pollMs?: number}} [options]
 */
export function stopDaemonAndWait(pid, { timeoutMs = 5000, pollMs = 50 } = {}) {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid) && Date.now() < deadline) sleepSync(pollMs);
}

/**
 * Recursively removes `root`, including any kernel-zeroed (mode 0000)
 * overlayfs workdirs a sandboxed dispatch left behind (see module doc
 * comment above for why `fs.rmSync` can't do this on its own).
 * @param {string} root
 */
export function rmRoot(root) {
  execFileSync("rm", ["-rf", root]);
}

/**
 * Creates a throwaway git repo (one commit, no `.taskferry.toml`) under
 * `root` for the smoke tests to dispatch into, instead of defaulting to the
 * real taskferry checkout. Dispatching into the live repo picks up its own
 * `.taskferry.toml` `check` command (`npm run check`) via `dispatchTask()`'s
 * prompt augmentation, which turns a trivial "reply PONG" smoke-test prompt
 * into "run the full lint/typecheck/test suite first" -- taking far longer
 * than the smoke tests' wait timeouts and failing the settlement checks for
 * reasons that have nothing to do with what's actually being tested.
 * @param {string} root
 * @returns {string} the scratch repo's directory
 */
export function scratchGitRepo(root) {
  const dir = path.join(root, "scratch-repo");
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "smoke-test@localhost");
  git("config", "user.name", "smoke test");
  fs.writeFileSync(path.join(dir, "README.md"), "taskferry smoke-test scratch repo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}
