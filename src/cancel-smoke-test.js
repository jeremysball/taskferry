import { decode } from "@toon-format/toon";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(__dirname, "cli.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-cancel-smoke-"));
const env = {
  ...process.env,
  TASKFERRY_STATE_DIR: path.join(root, "state"),
  TASKFERRY_RUNTIME_DIR: path.join(root, "run"),
};
const dirArg = process.argv[2] || path.join(__dirname, "..");

function taskferry(args) {
  const output = execFileSync(process.execPath, [cliEntry, ...args], { env, encoding: "utf8" });
  return decode(output);
}

function daemonPid() {
  return taskferry(["doctor", "--full"]).pid;
}

function stopDaemon() {
  try {
    process.kill(daemonPid(), "SIGTERM");
  } catch {
    // already gone
  }
}

function psTree(pgid) {
  try {
    return execSync(`ps -eo pid,pgid,comm,args --no-headers | awk -v pg=${pgid} '$2==pg'`).toString().trim();
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
  "--model", "opencode-go/minimax-m3",
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
  last = taskferry(["wait", taskId, "--timeout-ms", "10000"]);
  console.log(`[attempt ${i + 1}]`, last.status, last.signal ? `signal=${last.signal}` : "");
}

console.log("\nprocess group after cancel settled:");
const remaining = psTree(pid);
console.log(remaining || "(empty, good)");

const groupGone = remaining === "";
check("task settled as cancelled", last?.status === "cancelled");
check("the complete process group was killed", groupGone);

stopDaemon();
fs.rmSync(root, { recursive: true, force: true });

if (ok) {
  console.log("\nCANCEL SMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log(`\nCANCEL SMOKE TEST FAILED (status=${last?.status}, groupGone=${groupGone})`);
  process.exit(1);
}
