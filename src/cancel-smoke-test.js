import { decode } from "@toon-format/toon";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmRoot, stopDaemonAndWait } from "./smoke-test-support.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(scriptDir, "cli.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-cancel-smoke-"));
const env = {
  ...process.env,
  TASKFERRY_STATE_DIR: path.join(root, "state"),
  TASKFERRY_RUNTIME_DIR: path.join(root, "run"),
};
const dirArg = process.argv[2] || path.join(scriptDir, "..");

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

function psTree(pgid) {
  try {
    const output = execFileSync("ps", ["-eo", "pid,pgid,comm,args", "--no-headers"], { encoding: "utf8" });
    return output
      .split("\n")
      .filter((line) => line.trim().split(/\s+/)[1] === String(pgid))
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

let ok = true;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) ok = false;
}

console.log("== dispatch (long-running: sleep 60 via bash) ==");
const dispatched = taskferry([
  "dispatch",
  "--prompt", "Run 'sleep 60' via bash, then reply SLEEP_DONE. Do not shorten the sleep duration.",
  "--directory", dirArg,
  "--model", "minimax/MiniMax-M3",
]);
console.log(dispatched);
const taskId = dispatched.id;

console.log("\n== waiting 5s for opencode to actually start the sleep subprocess ==");
await new Promise((r) => setTimeout(r, 5000));

const statusBeforeCancel = taskferry(["status", taskId, "--full"]);
const pid = statusBeforeCancel.pid;
console.log("process group before cancel:");
console.log(psTree(pid) || "(empty)");
check("task has a recorded pid before cancel", Number.isInteger(pid));

console.log("\n== cancel ==");
const cancelResult = taskferry(["cancel", taskId, "--grace-ms", "4000"]);
console.log(cancelResult);

console.log("\n== waiting for settlement (taskferry wait) ==");
let last = null;
for (let i = 0; i < 3 && (!last || last.status === "running" || last.status === "queued"); i++) {
  last = taskferry(["wait", taskId, "--timeout", "10000"]);
  console.log(`[attempt ${i + 1}]`, last.status, last.signal ? `signal=${last.signal}` : "");
}

console.log("\nprocess group after cancel settled:");
const remaining = psTree(pid);
console.log(remaining || "(empty, good)");

const groupGone = remaining === "";
check("task settled as cancelled", last?.status === "cancelled");
check("the complete process group was killed", groupGone);

stopDaemon();
rmRoot(root);

if (ok) {
  console.log("\nCANCEL SMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log(`\nCANCEL SMOKE TEST FAILED (status=${last?.status}, groupGone=${groupGone})`);
  process.exit(1);
}
