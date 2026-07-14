import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
});
const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

const dirArg = process.argv[2] || path.join(__dirname, "..");

console.log("== tools/list ==");
const toolList = await client.listTools();
console.log(toolList.tools.map((t) => t.name).join(", "));

console.log("\n== taskferry_dispatch ==");
const dispatchRes = await client.callTool({
  name: "taskferry_dispatch",
  arguments: {
    prompt: "Reply with the word PONG and nothing else.",
    directory: dirArg,
    model: "opencode-go/minimax-m3",
  },
});
const dispatched = decode(dispatchRes.content[0].text);
console.log(dispatched);
const taskId = dispatched.id;

console.log("\n== polling taskferry_status ==");
let last = null;
for (let i = 0; i < 40; i++) {
  const statusRes = await client.callTool({ name: "taskferry_status", arguments: { task_id: taskId } });
  last = decode(statusRes.content[0].text);
  console.log(`[t+${i * 2}s]`, last.status);
  if (last.status !== "running" && last.status !== "queued") break;
  await new Promise((r) => setTimeout(r, 2000));
}

console.log("\n== taskferry_result ==");
const resultRes = await client.callTool({ name: "taskferry_result", arguments: { task_id: taskId } });
const result = decode(resultRes.content[0].text);
console.log(result);

console.log("\n== taskferry_list ==");
const listRes = await client.callTool({ name: "taskferry_list", arguments: {} });
console.log(decode(listRes.content[0].text));

await client.close();

if (last.status === "done" && result.message.trim() === "PONG") {
  console.log("\nSMOKE TEST PASSED");
  process.exit(0);
} else {
  console.log("\nSMOKE TEST FAILED");
  process.exit(1);
}
