#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encode } from "@toon-format/toon";
import { z } from "zod";
import { defaultTaskManager as tasks } from "./tasks.js";

function toon(value) {
  return { content: [{ type: "text", text: encode(value) }] };
}

const server = new McpServer({
  name: "taskferry",
  version: "0.1.0",
});

server.registerTool(
  "taskferry_dispatch",
  {
    title: "Dispatch taskferry task",
    description:
      "Queue an `opencode run` for background execution as a directly-spawned child process (no tmux, no shared visibility into the orchestration layer) and return a task_id immediately. The server starts at most two tasks in each rolling five-second window by default. After dispatching, call taskferry_poll to block until the task finishes or times out; if it times out, call taskferry_tail to read the latest output and report the task's current status to the user. Once the task is done, call taskferry_result to fetch the final result.",
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
    return toon(task);
  }
);

server.registerTool(
  "taskferry_cancel",
  {
    title: "Cancel a queued or running taskferry task",
    description:
      "Cancel a queued task before it starts, or stop a running task by sending SIGTERM to its whole process group (opencode and any subprocess it spawned), escalating to SIGKILL after a grace period if it hasn't exited. A finished task's status is unaffected and returns a note instead of an error.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      grace_ms: z
        .number()
        .optional()
        .describe("Milliseconds to wait after SIGTERM before escalating to SIGKILL. Defaults to 5000."),
    },
  },
  async ({ task_id, grace_ms }) => {
    const c = tasks.cancel(task_id, grace_ms != null ? { graceMs: grace_ms } : undefined);
    return toon(c);
  }
);

server.registerTool(
  "taskferry_poll",
  {
    title: "Block until a taskferry task finishes",
    description:
      "Block on a queued or running task until it exits (or a timeout) and return its status once settled. The closest analog to the built-in Agent tool's auto-resume behavior available over plain MCP request/response, without a poll loop. Capped internally at 45s so the call returns cleanly instead of hitting Claude Code's own MCP tool-call timeout; if status is still queued or running when it returns, call taskferry_poll again. Pass tail_chars to get the trailing narration when the task is still running after the timeout; then call taskferry_tail to read more and report the task's current progress to the user. Always inform the user of the task's status after calling this tool.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds to block. Capped at 45000 regardless of what's passed. Defaults to 45000."),
      tail_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When the poll times out and the task is still running, return this many trailing narration characters. Use this to report progress to the user while the task continues."),
    },
  },
  async ({ task_id, timeout_ms, tail_chars }) => {
    const s = await tasks.poll(task_id, {
      ...(timeout_ms != null ? { timeoutMs: timeout_ms } : {}),
      ...(tail_chars != null ? { tailChars: tail_chars } : {}),
    });
    return toon(s);
  }
);

server.registerTool(
  "taskferry_advisor",
  {
    title: "Ask a bigger model for help, blocking",
    description:
      "Consult a different model mid-task and block until it answers; the same dispatch+poll+result machinery as taskferry_dispatch, glued into one call so the answer comes back inline instead of requiring a separate poll. Use this the way a weaker model consults a stronger one for planning or hard debugging help, not for open-ended background work (use taskferry_dispatch for that). Capped at 45s like taskferry_poll; if it times out, the response includes status: \"running\" plus a task_id and session_id; call taskferry_poll or taskferry_advisor again with that session_id to continue. Pass session_id to continue a prior advisor exchange; if that session has gone stale (idle past the configured TTL) or is unrecognized, a fresh session starts automatically and the response's session_reset is true with previous_session_id set, rather than erroring; never keep piling onto a conversation that's lost cache recency.",
    inputSchema: {
      prompt: z.string().describe("Self-contained question/context for the advisor; taskferry has no access to the caller's own conversation, so include whatever context the advisor needs."),
      directory: z
        .string()
        .describe("Absolute path to the working directory opencode should run in (--dir)."),
      model: z
        .string()
        .describe("provider/model string for the advisor, e.g. 'openai/gpt-5.6-sol' or 'zai/glm-5.2'. Required; unlike taskferry_dispatch, there is no default advisor model."),
      variant: z
        .string()
        .optional()
        .describe("Model variant/reasoning effort (e.g. high, max, minimal) for the advisor model."),
      session_id: z
        .string()
        .optional()
        .describe("Continue a prior advisor exchange. Silently starts a fresh session instead of erroring if this session has expired or is unrecognized; check session_reset in the response."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds to block. Capped at 45000 regardless of what's passed. Defaults to 45000."),
    },
  },
  async ({ prompt, directory, model, variant, session_id, timeout_ms }) => {
    const a = await tasks.advisor({
      prompt,
      directory,
      model,
      variant,
      session_id,
      ...(timeout_ms != null ? { timeout_ms } : {}),
    });
    return toon(a);
  }
);

server.registerTool(
  "taskferry_status",
  {
    title: "Check taskferry task status",
    description:
      "Return structured status for a dispatched task: queued | running | done | crashed | cancelled | unknown, plus exit code and log path once finished. Backed by the child process's real exit event, not log string-matching. Also reports logBytesWritten, logLastWriteAt, and logHasEvent so a task stuck at 'running' with no log activity (e.g. hung on a usage-limit retry) can be told apart from one that's actively producing output.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
    },
  },
  async ({ task_id }) => {
    const s = tasks.status(task_id);
    return toon(s);
  }
);

server.registerTool(
  "taskferry_tail",
  {
    title: "Read the latest taskferry text",
    description:
      "Return the last requested Unicode code points of the most recent parsed text event for a task. Reads locally and never sends task content to a model. Use this after taskferry_poll times out to check what the task is doing, then report its progress to the user.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      chars: z.number().int().positive().max(65536).optional().describe("Number of Unicode code points to return. Defaults to 1000; maximum 65536."),
    },
  },
  async ({ task_id, chars }) => toon(tasks.tail(task_id, chars != null ? { chars } : undefined))
);

server.registerTool(
  "taskferry_summary",
  {
    title: "Summarize observed taskferry progress",
    description:
      "Capture a bounded snapshot of a task's narration and queue an isolated summary task. The snapshot is sent to the configured summary-model provider; do not use this tool for narration containing secrets you do not want to send there.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      max_words: z.number().int().min(75).max(300).optional().describe("Target summary length. Defaults to 200 words; valid range is 75 through 300."),
    },
  },
  async ({ task_id, max_words }) => toon(await tasks.summarize(task_id, max_words != null ? { maxWords: max_words } : undefined))
);

server.registerTool(
  "taskferry_result",
  {
    title: "Fetch taskferry task result",
    description:
      "Return the final assistant message and metadata (tokens, cost, session id) for a finished task, parsed from opencode's own --format json event stream. `message` is only the model's last turn (after all tool calls finish); `narration` includes intermediate step narration too, in order, truncated to 2000 chars by default. Errors politely if the task is still running.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by taskferry_dispatch."),
      full: z
        .boolean()
        .optional()
        .describe("Return the complete, untruncated narration instead of the 2000-char preview. Defaults to false."),
      fields: z
        .array(z.enum(["message", "narration", "tokens", "cost", "sessionId", "exitCode", "signal", "spawnError", "logPath"]))
        .min(1)
        .optional()
        .describe("Return only these result fields, plus taskId and status. Omit for the full backward-compatible result."),
    },
  },
  async ({ task_id, full, fields }) => {
    const r = tasks.result(task_id, { full: !!full, ...(fields ? { fields } : {}) });
    return toon(r);
  }
);

server.registerTool(
  "taskferry_list",
  {
    title: "List taskferry tasks",
    description: "List all known tasks (this server process's lifetime) with their statuses, newest first.",
    inputSchema: {},
  },
  async () => {
    const l = tasks.list();
    return toon(l);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
