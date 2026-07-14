import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decode } from "@toon-format/toon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeStateDir() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-server-test-"));
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "done.ndjson");
  fs.writeFileSync(logPath, [
    JSON.stringify({ type: "text", part: { messageID: "m1", text: "latest text" } }),
    JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
  ].join("\n"));
  fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify([{
    id: "done",
    status: "done",
    directory: os.tmpdir(),
    model: "openai/gpt-5.6-luna",
    variant: "high",
    sessionId: null,
    pid: null,
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: "2026-07-14T00:01:00.000Z",
    exitCode: 0,
    signal: null,
    logPath,
    promptPreview: "test",
    promptTotalChars: null,
    spawnError: null,
    cancelRequested: false,
  }]));
  return stateDir;
}

test("registers summary and tail tools with schemas and returns projected TOON data", async () => {
  const stateDir = makeStateDir();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "server.js")],
    env: { ...process.env, TASKFERRY_STATE_DIR: stateDir },
  });
  const client = new Client({ name: "server-test", version: "0.0.1" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.has("taskferry_tail"), true);
    assert.equal(byName.has("taskferry_summary"), true);
    assert.equal(byName.get("taskferry_tail").inputSchema.properties.chars.maximum, 65536);
    assert.equal(byName.get("taskferry_summary").inputSchema.properties.max_words.minimum, 75);
    assert.equal(byName.get("taskferry_summary").inputSchema.properties.max_words.maximum, 300);
    assert.equal(byName.get("taskferry_result").inputSchema.properties.fields.minItems, 1);

    const tail = await client.callTool({ name: "taskferry_tail", arguments: { task_id: "done", chars: 4 } });
    assert.deepEqual(decode(tail.content[0].text), {
      taskId: "done",
      status: "done",
      text: "text",
      textTotalChars: 11,
      truncated: true,
    });

    const result = await client.callTool({ name: "taskferry_result", arguments: { task_id: "done", fields: ["message"] } });
    assert.deepEqual(decode(result.content[0].text), {
      taskId: "done",
      status: "done",
      message: "latest text",
    });
  } finally {
    await client.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
