import { decode } from "@toon-format/toon";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { rmRoot, scratchGitRepo, stopDaemonAndWait } from "./smoke-test-support.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(scriptDir, "cli.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-smoke-"));
const env = {
  ...process.env,
  TASKFERRY_STATE_DIR: path.join(root, "state"),
  TASKFERRY_RUNTIME_DIR: path.join(root, "run"),
};
const dirArg = process.argv[2] || scratchGitRepo(root);

function taskferry(args) {
  const output = execFileSync(process.execPath, [cliEntry, ...args], { env, encoding: "utf8" });
  return decode(output);
}

function daemonPid() {
  return taskferry(["doctor", "--full"]).pid;
}

function stopDaemon() {
  let pid;
  try {
    pid = daemonPid();
  } catch {
    return; // already gone
  }
  stopDaemonAndWait(pid);
}

const DIRECTORY_FLAG = "--directory";

let ok = true;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) ok = false;
}

console.log("== no-args output (home view) ==");
const home = taskferry([]);
console.log(home);
check("home view reports a workspace", typeof home.workspace === "string" && home.workspace.length > 0);
check("home view reports task counts", typeof home.counts === "object");

console.log("\n== dispatch ==");
const dispatched = taskferry(["dispatch", "--prompt", "Reply with the word PONG and nothing else.", DIRECTORY_FLAG, dirArg, "--model", "meta/muse-spark-1.2-contributor", "--variant", "low", "--executor", "opencode"]);
console.log(dispatched);
const taskId = dispatched.id;
check("dispatch returned a task id", typeof taskId === "string" && taskId.length > 0);

console.log("\n== daemon survives after the dispatch CLI exits ==");
const pidAfterDispatch = daemonPid();
check("daemon still answers doctor after the dispatch process exited", Number.isInteger(pidAfterDispatch));
let daemonAlive = true;
try {
  process.kill(pidAfterDispatch, 0);
} catch {
  daemonAlive = false;
}
check("daemon process is alive", daemonAlive);

console.log("\n== waiting for settlement (taskferry wait, looping past its internal cap) ==");
let last = null;
for (let i = 0; i < 3 && (!last || last.status === "running" || last.status === "queued"); i++) {
  last = taskferry(["wait", taskId, "--timeout", "45000", "--tail-chars", "500"]);
  console.log(`[attempt ${i + 1}]`, last.status);
}
check("task settled", last.status === "done");

console.log("\n== result ==");
const result = taskferry(["result", taskId]);
console.log(result);
check("result message is PONG", result.message?.trim() === "PONG");

console.log("\n== list ==");
const list = taskferry(["list", DIRECTORY_FLAG, dirArg]);
console.log(list);
check("list includes the dispatched task", Array.isArray(list.tasks) && list.tasks.some((row) => row.id === taskId));

console.log("\n== watch events ==");
const watchLines = [];
const watch = spawn(process.execPath, [cliEntry, "watch", DIRECTORY_FLAG, dirArg, "--format", "ndjson"], { env });
const rl = readline.createInterface({ input: watch.stdout });
rl.on("line", (line) => watchLines.push(line));
await new Promise((resolve) => setTimeout(resolve, 500));
const secondDispatch = taskferry(["dispatch", "--prompt", "Reply with the word PONG and nothing else.", DIRECTORY_FLAG, dirArg, "--model", "meta/muse-spark-1.2-contributor", "--variant", "low", "--executor", "opencode"]);
let watchExitCode = null;
const watchExited = new Promise((resolve) => watch.once("exit", (code) => {
  watchExitCode = code;
  resolve();
}));
await Promise.race([
  new Promise((resolve) => setTimeout(resolve, 15000)),
  new Promise((resolve) => {
    const timer = setInterval(() => {
      if (watchLines.some((line) => line.includes(secondDispatch.id))) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  }),
]);
watch.kill("SIGTERM");
await watchExited;
rl.close();
console.log(`captured ${watchLines.length} event line(s), watch exit code ${watchExitCode}`);
check("watch observed at least one event for the workspace", watchLines.length > 0);
check("watch process exited cleanly after SIGTERM", watchExitCode === 0);
taskferry(["cancel", secondDispatch.id]); // no-op if it already settled; frees it either way

stopDaemon();
rmRoot(root);

if (ok) {
  console.log("\nSMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log("\nSMOKE TEST FAILED");
  process.exit(1);
}
