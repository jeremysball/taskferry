import { decode } from "@toon-format/toon";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(__dirname, "cli.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-poll-smoke-"));
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

console.log("== case 1: taskferry wait resolves on real completion (short task, long-ish cap) ==");
const d1 = taskferry(["dispatch", "--prompt", "Reply with the word PONG and nothing else.", "--directory", dirArg, "--model", "opencode-go/minimax-m3"]);
const t1Start = Date.now();
const w1 = taskferry(["wait", d1.id, "--timeout-ms", "30000"]);
const t1Elapsed = Date.now() - t1Start;
console.log(`resolved after ${t1Elapsed}ms:`, w1.status, w1.exitCode);

console.log("\n== case 2: taskferry wait hits its cap and returns 'running' (long task, short cap) ==");
const d2 = taskferry([
  "dispatch",
  "--prompt", "Run 'sleep 30' via bash, then reply SLEEP_DONE. Do not shorten the sleep duration.",
  "--directory", dirArg,
  "--model", "opencode-go/minimax-m3",
]);
const t2Start = Date.now();
const w2 = taskferry(["wait", d2.id, "--timeout-ms", "3000"]);
const t2Elapsed = Date.now() - t2Start;
console.log(`returned after ${t2Elapsed}ms:`, w2.status);

console.log("\n== cleaning up the long task ==");
const cancelResult = taskferry(["cancel", d2.id, "--grace-ms", "3000"]);
console.log(cancelResult.note);
await new Promise((r) => setTimeout(r, 2000));
const finalStatus = taskferry(["status", d2.id]);
console.log("final status:", finalStatus.status);

stopDaemon();
fs.rmSync(root, { recursive: true, force: true });

const case1Ok = w1.status === "done" && t1Elapsed < 30000;
const case2Ok = w2.status === "running" && t2Elapsed >= 2900 && t2Elapsed < 5000;
const cleanupOk = finalStatus.status === "cancelled";

if (case1Ok && case2Ok && cleanupOk) {
  console.log("\nPOLL SMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log(`\nPOLL SMOKE TEST FAILED (case1Ok=${case1Ok} case2Ok=${case2Ok} cleanupOk=${cleanupOk})`);
  process.exit(1);
}
