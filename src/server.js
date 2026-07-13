#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tasks from "./tasks.js";

const server = new McpServer({
  name: "opencode-cc-tool",
  version: "0.1.0",
});

server.registerTool(
  "opencode_dispatch",
  {
    title: "Dispatch opencode task",
    description:
      "Start an `opencode run` in the background as a directly-spawned child process (no tmux, no shared visibility into the orchestration layer) and return a task_id immediately. Poll with opencode_status, then read opencode_result once done.",
    inputSchema: {
      prompt: z.string().describe("The message/prompt to send to opencode."),
      directory: z
        .string()
        .describe("Absolute path to the working directory opencode should run in (--dir)."),
      model: z
        .string()
        .optional()
        .describe(
          "provider/model string, e.g. 'opencode-go/minimax-m3' (economy) or 'openai/gpt-5.6-sol' (hard debugging/architecture). Defaults to 'openai/gpt-5.6-luna' --variant high."
        ),
      variant: z
        .string()
        .optional()
        .describe("Model variant/reasoning effort (e.g. high, max, minimal). Only applied when model is also given."),
      session_id: z
        .string()
        .optional()
        .describe("Resume an existing opencode session id instead of starting fresh (passes --continue --session)."),
    },
  },
  async ({ prompt, directory, model, variant, session_id }) => {
    const task = tasks.dispatch({ prompt, directory, model, variant, sessionId: session_id });
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
  }
);

server.registerTool(
  "opencode_status",
  {
    title: "Check opencode task status",
    description:
      "Return structured status for a dispatched task: running | done | crashed | unknown, plus exit code and log path once finished. Backed by the child process's real exit event, not log string-matching.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by opencode_dispatch."),
    },
  },
  async ({ task_id }) => {
    const s = tasks.status(task_id);
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  }
);

server.registerTool(
  "opencode_result",
  {
    title: "Fetch opencode task result",
    description:
      "Return the final assistant message and metadata (tokens, cost, session id) for a finished task, parsed from opencode's own --format json event stream. `message` is only the model's last turn (after all tool calls finish); `narration` includes intermediate step narration too, in order. Errors politely if the task is still running.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by opencode_dispatch."),
    },
  },
  async ({ task_id }) => {
    const r = tasks.result(task_id);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

server.registerTool(
  "opencode_list",
  {
    title: "List opencode tasks",
    description: "List all known tasks (this server process's lifetime) with their statuses, newest first.",
    inputSchema: {},
  },
  async () => {
    const l = tasks.list();
    return { content: [{ type: "text", text: JSON.stringify(l, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
