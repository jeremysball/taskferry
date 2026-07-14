import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "server.js");

const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
const client = new Client({ name: "wait-smoke-test", version: "0.0.1" });
await client.connect(transport);

const dirArg = process.argv[2] || path.join(__dirname, "..");

console.log("== case 1: taskferry_wait resolves on real completion (short task, long-ish cap) ==");
const d1 = decode(
  (await client.callTool({
    name: "taskferry_dispatch",
    arguments: { prompt: "Reply with the word PONG and nothing else.", directory: dirArg, model: "opencode-go/minimax-m3" },
  })).content[0].text
);
const t1Start = Date.now();
const w1 = decode(
  (await client.callTool({ name: "taskferry_wait", arguments: { task_id: d1.id, timeout_ms: 30000 } })).content[0].text
);
const t1Elapsed = Date.now() - t1Start;
console.log(`resolved after ${t1Elapsed}ms:`, w1.status, w1.exitCode);

console.log("\n== case 2: taskferry_wait hits its cap and returns 'running' (long task, short cap) ==");
const d2 = decode(
  (await client.callTool({
    name: "taskferry_dispatch",
    arguments: {
      prompt: "Run 'sleep 30' via bash, then reply SLEEP_DONE. Do not shorten the sleep duration.",
      directory: dirArg,
      model: "opencode-go/minimax-m3",
    },
  })).content[0].text
);
const t2Start = Date.now();
const w2 = decode(
  (await client.callTool({ name: "taskferry_wait", arguments: { task_id: d2.id, timeout_ms: 3000 } })).content[0].text
);
const t2Elapsed = Date.now() - t2Start;
console.log(`returned after ${t2Elapsed}ms:`, w2.status);

console.log("\n== cleaning up the long task ==");
const cancelRes = decode(
  (await client.callTool({ name: "taskferry_cancel", arguments: { task_id: d2.id, grace_ms: 3000 } })).content[0].text
);
console.log(cancelRes.note);
await new Promise((r) => setTimeout(r, 2000));
const finalStatus = decode(
  (await client.callTool({ name: "taskferry_status", arguments: { task_id: d2.id } })).content[0].text
);
console.log("final status:", finalStatus.status);

await client.close();

const case1Ok = w1.status === "done" && t1Elapsed < 30000;
const case2Ok = w2.status === "running" && t2Elapsed >= 2900 && t2Elapsed < 5000;
const cleanupOk = finalStatus.status === "cancelled";

if (case1Ok && case2Ok && cleanupOk) {
  console.log("\nWAIT SMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log(`\nWAIT SMOKE TEST FAILED (case1Ok=${case1Ok} case2Ok=${case2Ok} cleanupOk=${cleanupOk})`);
  process.exit(1);
}
