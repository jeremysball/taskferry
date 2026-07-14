import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "server.js");

const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
const client = new Client({ name: "cancel-smoke-test", version: "0.0.1" });
await client.connect(transport);

const dirArg = process.argv[2] || path.join(__dirname, "..");

console.log("== taskferry_dispatch (long-running: sleep 60 via bash) ==");
const dispatchRes = await client.callTool({
  name: "taskferry_dispatch",
  arguments: {
    prompt: "Run 'sleep 60' via bash, then reply SLEEP_DONE. Do not shorten the sleep duration.",
    directory: dirArg,
    model: "opencode-go/minimax-m3",
  },
});
const dispatched = decode(dispatchRes.content[0].text);
console.log(dispatched);
const taskId = dispatched.id;
const pid = dispatched.pid;

console.log("\n== waiting 5s for opencode to actually start the sleep subprocess ==");
await new Promise((r) => setTimeout(r, 5000));

function psTree(pgid) {
  try {
    return execSync(`ps -eo pid,pgid,comm,args --no-headers | awk -v pg=${pgid} '$2==pg'`).toString().trim();
  } catch {
    return "";
  }
}

console.log("process group before cancel:");
console.log(psTree(pid) || "(empty)");

console.log("\n== taskferry_cancel ==");
const cancelRes = await client.callTool({
  name: "taskferry_cancel",
  arguments: { task_id: taskId, grace_ms: 4000 },
});
console.log(decode(cancelRes.content[0].text));

console.log("\n== polling taskferry_status until settled ==");
let last = null;
for (let i = 0; i < 20; i++) {
  const statusRes = await client.callTool({ name: "taskferry_status", arguments: { task_id: taskId } });
  last = decode(statusRes.content[0].text);
  console.log(`[t+${i}s]`, last.status, last.signal ? `signal=${last.signal}` : "");
  if (last.status !== "running" && last.status !== "queued") break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log("\nprocess group after cancel settled:");
console.log(psTree(pid) || "(empty, good)");

await client.close();

const groupGone = psTree(pid) === "";
if (last.status === "cancelled" && groupGone) {
  console.log("\nCANCEL SMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log(`\nCANCEL SMOKE TEST FAILED (status=${last.status}, groupGone=${groupGone})`);
  process.exit(1);
}
