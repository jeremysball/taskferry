import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decode } from "@toon-format/toon";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { runCli } from "./cli.js";

function capturedIo({ stdin } = {}) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
      ...(stdin !== undefined ? { stdin } : {}),
    },
    output: () => ({ stdout, stderr, value: decode(stdout.trim()) }),
  };
}

// A piped (non-TTY) stdin: Readable.from() makes it async-iterable, matching
// what runCli's `for await (const chunk of io.stdin)` consumes.
function fakePipedStdin(content) {
  const stream = Readable.from([content]);
  stream.isTTY = false;
  return stream;
}

// An interactive (TTY) stdin with nothing piped into it -- runCli must reject
// `--prompt -` here rather than hang waiting for input that will never come.
function fakeTtyStdin() {
  const stream = Readable.from([]);
  stream.isTTY = true;
  return stream;
}

function fakeClient(responses = {}) {
  const calls = [];
  return {
    calls,
    client: {
      request: async (method, params) => {
        calls.push({ method, params });
        const response = responses[method];
        if (response instanceof Error) throw response;
        return typeof response === "function" ? response(params) : response;
      },
      close() {},
    },
  };
}

const counts = { queued: 0, running: 1, done: 1, crashed: 0, cancelled: 0, unknown: 0 };

test("rejects usage errors as TOON without contacting the daemon", async () => {
  let connected = false;
  const capture = capturedIo();
  const result = await runCli(["status", "one", "--unknown"], {
    io: capture.io,
    connectClient: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
  assert.equal(capture.output().stderr, "");
  assert.equal(capture.output().value.error, "unknown flag --unknown for `status`");
  assert.match(capture.output().value.help, /taskferry status/);
});

test("renders operational daemon errors as TOON on stdout with exit code 1", async () => {
  const capture = capturedIo();
  const { client } = fakeClient({
    "task.status": new Error("error: unknown task id: missing\nhelp: run `taskferry list` to see valid task ids"),
  });
  const result = await runCli(["status", "missing"], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(capture.output().value, {
    error: "unknown task id: missing",
    help: "run `taskferry list` to see valid task ids",
  });
  assert.equal(capture.output().stderr, "");
});

test("dispatch --prompt - reads the prompt from piped stdin, stripping one trailing newline", async () => {
  const capture = capturedIo({ stdin: fakePipedStdin("large prompt content\n") });
  const { client, calls } = fakeClient({
    "task.dispatch": { id: "oc_1", status: "queued" },
  });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].params.prompt, "large prompt content");
});

test("advisor --prompt - reads the prompt from piped stdin", async () => {
  const capture = capturedIo({ stdin: fakePipedStdin("advisor question\n") });
  const { client, calls } = fakeClient({
    "task.advisor": { id: "oc_1", status: "queued" },
  });
  const result = await runCli(["advisor", "--prompt", "-", "--model", "opencode/some-model"], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].params.prompt, "advisor question");
});

test("dispatch --prompt - rejects with a usage error and never contacts the daemon when stdin is a TTY", async () => {
  let connected = false;
  const capture = capturedIo({ stdin: fakeTtyStdin() });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
  assert.match(capture.output().value.error, /stdin/i);
  assert.match(capture.output().value.help, /Pipe a prompt into the command/);
  assert.match(capture.output().value.help, /taskferry dispatch --prompt -/);
});

test("dispatch --prompt - rejects with a usage error when piped stdin is empty", async () => {
  let connected = false;
  const capture = capturedIo({ stdin: fakePipedStdin("") });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
  assert.match(capture.output().value.error, /empty/i);
  assert.match(capture.output().value.help, /Pipe a prompt into the command/);
});

test("advisor --prompt - surfaces the same actionable help, with the advisor command name, when stdin is a TTY", async () => {
  const capture = capturedIo({ stdin: fakeTtyStdin() });
  const result = await runCli(["advisor", "--prompt", "-", "--model", "opencode/some-model"], {
    io: capture.io,
    connectClient: async () => {
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.match(capture.output().value.help, /Pipe a prompt into the command/);
  assert.match(capture.output().value.help, /taskferry advisor --prompt -/);
});

test("dispatch --prompt - strips a CRLF terminator from piped stdin (Windows-originated files)", async () => {
  const capture = capturedIo({ stdin: fakePipedStdin("prompt with CRLF terminator\r\n") });
  const { client, calls } = fakeClient({
    "task.dispatch": { id: "oc_1", status: "queued" },
  });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].params.prompt, "prompt with CRLF terminator");
});

test("dispatch --prompt - surfaces a multi-word help sentence, not just the bare command name (regression for help: dispatch)", async () => {
  const capture = capturedIo({ stdin: fakeTtyStdin() });
  await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => { throw new Error("must not connect"); },
  });

  const help = capture.output().value.help;
  assert.notEqual(help, "dispatch");
  assert.notEqual(help, "advisor");
  assert.match(help, /taskferry dispatch/);
  assert.ok(help.length > 8, "help must be a real sentence, not a bare token");
});

test("dispatch --prompt - with no trailing terminator still surfaces the prompt verbatim (no spurious stripping)", async () => {
  const capture = capturedIo({ stdin: fakePipedStdin("prompt without trailing newline") });
  const { client, calls } = fakeClient({
    "task.dispatch": { id: "oc_1", status: "queued" },
  });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].params.prompt, "prompt without trailing newline");
});

test("dispatch --prompt - treats CRLF-only piped content as empty (matches the LF-only empty path)", async () => {
  let connected = false;
  const capture = capturedIo({ stdin: fakePipedStdin("\r\n") });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
  assert.match(capture.output().value.error, /empty/i);
});

test("dispatch --prompt - keeps an interior CRLF in the prompt (only strips the trailing terminator)", async () => {
  const capture = capturedIo({ stdin: fakePipedStdin("line one\r\nline two\r\n") });
  const { client, calls } = fakeClient({
    "task.dispatch": { id: "oc_1", status: "queued" },
  });
  const result = await runCli(["dispatch", "--prompt", "-"], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].params.prompt, "line one\r\nline two");
});

test("no arguments show executable, description, workspace tasks, counts, and next actions", async () => {
  const capture = capturedIo();
  const workspace = process.cwd();
  const { client, calls } = fakeClient({
    "task.list": {
      directory: workspace,
      counts,
      tasks: [{ id: "oc_1", status: "running", model: "test/model", startedAt: "2026-07-15T00:00:00.000Z", failureReason: null }],
    },
  });
  const result = await runCli([], {
    cwd: workspace,
    executablePath: path.join(os.homedir(), ".local/bin/taskferry"),
    io: capture.io,
    connectClient: async () => client,
  });

  const value = capture.output().value;
  assert.equal(result.exitCode, 0);
  assert.equal(value.bin, "~/.local/bin/taskferry");
  assert.match(value.description, /background OpenCode tasks/);
  assert.deepEqual(value.counts, counts);
  assert.deepEqual(value.tasks, [{ id: "oc_1", status: "running", model: "test/model", startedAt: "2026-07-15T00:00:00.000Z" }]);
  assert.ok(value.next.some((line) => line.includes("taskferry wait <id>")));
  assert.deepEqual(calls, [{ method: "task.list", params: { directory: workspace } }]);
});

test("explicit empty workspace output is definitive and uses four-field rows", async () => {
  const capture = capturedIo();
  const workspace = process.cwd();
  const { client } = fakeClient({
    "task.list": {
      directory: workspace,
      counts: { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 },
      tasks: "none found in this workspace",
    },
  });
  const result = await runCli(["list", "--directory", workspace], {
    io: capture.io,
    connectClient: async () => client,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capture.output().value.tasks, "none found in this workspace");
  assert.deepEqual(capture.output().value.counts, { queued: 0, running: 0, done: 0, crashed: 0, cancelled: 0, unknown: 0 });
});

test("normalizes workspace paths before contacting the daemon", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-cli-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, "dir");
  const capture = capturedIo();
  const { client, calls } = fakeClient({
    "task.list": { counts, tasks: "none found in this workspace" },
  });

  await runCli(["list", "--directory", link], { io: capture.io, connectClient: async () => client });
  assert.deepEqual(calls[0], { method: "task.list", params: { directory: real } });
});

test("rejects an invalid workspace before connecting to the daemon", async () => {
  let connected = false;
  const capture = capturedIo();
  const result = await runCli(["list", "--directory", path.join(os.tmpdir(), "missing-taskferry-workspace")], {
    io: capture.io,
    connectClient: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
  assert.match(capture.output().value.error, /directory does not exist/);
});

test("rejects a file path as a workspace before connecting to the daemon", async () => {
  let connected = false;
  const capture = capturedIo();
  const result = await runCli(["list", "--directory", path.join(process.cwd(), "package.json")], {
    io: capture.io,
    connectClient: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(connected, false);
  assert.match(capture.output().value.error, /not a directory/);
});

test("projects status and result output using the former MCP lean projections", async () => {
  const capture = capturedIo();
  const status = {
    id: "oc_1",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
    directory: "/workspace/project",
    model: "test/model",
    sessionId: null,
    logPath: "/tmp/task.log",
    outputTail: "latest",
    outputTailTotalChars: 6,
    outputTailTruncated: false,
  };
  const detail = {
    taskId: "oc_1",
    status: "done",
    message: "answer",
    narration: "internal steps",
    narrationTruncated: false,
    narrationTotalChars: 14,
    exitCode: 0,
    signal: null,
    sessionId: "ses_1",
  };
  const { client, calls } = fakeClient({ "task.status": status, "task.result": detail });

  let result = await runCli(["status", "oc_1"], { io: capture.io, connectClient: async () => client });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(capture.output().value, {
    id: "oc_1",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
    outputTail: "latest",
    outputTailTotalChars: 6,
    outputTailTruncated: false,
    next: 'Run taskferry wait or taskferry status with task id "oc_1" to check progress; pass --full for directory/model/log path details',
  });

  const secondCapture = capturedIo();
  result = await runCli(["result", "oc_1"], { io: secondCapture.io, connectClient: async () => client });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(secondCapture.output().value, {
    taskId: "oc_1",
    status: "done",
    message: "answer",
    narrationTotalChars: 14,
    exitCode: 0,
    signal: null,
    sessionId: "ses_1",
    next: 'Run taskferry result --full or --fields narration with task id "oc_1" to see intermediate step narration (14 chars total)',
  });
  assert.deepEqual(calls, [
    { method: "task.status", params: { taskId: "oc_1" } },
    { method: "task.result", params: { taskId: "oc_1" } },
  ]);
});

test("doctor is a structured health check and --full preserves extra daemon fields", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-cli-doctor-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const capture = capturedIo();
  const { client, calls } = fakeClient({
    "system.health": { healthy: true, pid: 123, version: 1, socketPath: "/tmp/taskferry.sock" },
  });
  const runShellCommand = () => ({
    status: 0,
    stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
    stderr: "",
    error: undefined,
  });
  const result = await runCli(["doctor", "--full"], { io: capture.io, connectClient: async () => client, runShellCommand, homeDirectory: home, env: {} });

  assert.equal(result.exitCode, 0);
  assert.equal(capture.output().value.healthy, true);
  assert.equal(capture.output().value.socketPath, "/tmp/taskferry.sock");
  assert.deepEqual(capture.output().value.integrations, {
    claude: { installed: true },
    playwrightMcpIsolation: { opencode: { checked: false, reason: "no opencode config with a playwright MCP entry found" }, claudeCode: { checked: false, reason: "~/.claude.json not found" } },
  });
  assert.equal(capture.output().value.warnings, undefined);
  assert.deepEqual(calls, [{ method: "system.health", params: {} }]);
});

test("summary --wait reports a not-settled note instead of summarizing when the task is still active", async () => {
  const capture = capturedIo();
  const { client, calls } = fakeClient({
    "task.wait": { id: "oc_1", status: "running", startedAt: "2026-07-15T00:00:00.000Z" },
  });
  const result = await runCli(["summary", "oc_1", "--wait"], { io: capture.io, connectClient: async () => client });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capture.output().value, {
    id: "oc_1",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
    next: 'Run taskferry wait or taskferry status with task id "oc_1" to check progress; pass --full for directory/model/log path details',
    note: 'Task has not settled yet (status: running); run taskferry summary --wait again to keep waiting, or omit --wait to summarize the in-progress task',
  });
  assert.deepEqual(calls, [{ method: "task.wait", params: { taskId: "oc_1", timeoutMs: 900000 } }]);
});

test("summary --wait proceeds to summarize once task.wait reports a settled status", async () => {
  const capture = capturedIo();
  const { client, calls } = fakeClient({
    "task.wait": { id: "oc_1", status: "done", startedAt: "2026-07-15T00:00:00.000Z" },
    "task.summary": { text: "it worked" },
  });
  const result = await runCli(["summary", "oc_1", "--wait"], { io: capture.io, connectClient: async () => client });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capture.output().value, { text: "it worked" });
  assert.deepEqual(calls, [
    { method: "task.wait", params: { taskId: "oc_1", timeoutMs: 900000 } },
    { method: "task.summary", params: { taskId: "oc_1" } },
  ]);
});

test("runs setup without connecting to the daemon", async () => {
  const capture = capturedIo();
  let called = false;
  const result = await runCli(["setup"], {
    io: capture.io,
    setup: () => {
      called = true;
      return { cli: { path: "/home/test/.local/bin/taskferry" }, path: "available" };
    },
    connectClient: async () => { throw new Error("setup must not connect"); },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(called, true);
  assert.equal(capture.output().value.path, "available");
});

test("surfaces setup failures on stderr and never connects to the daemon", async () => {
  const capture = capturedIo();
  let called = false;
  const result = await runCli(["setup"], {
    io: capture.io,
    setup: () => {
      called = true;
      throw new Error("boom");
    },
    connectClient: async () => { throw new Error("setup must not connect"); },
  });

  assert.equal(called, true);
  assert.equal(result.exitCode, 1);
  assert.equal(capture.output().stdout, "");
  assert.match(capture.output().stderr, /error: boom\n/);
  assert.match(capture.output().stderr, /help: fix the reported dependency or filesystem problem, then rerun node src\/cli\.js setup\n/);
});

test("colors setup failures on stderr only when stderr is a TTY", async () => {
  let stderr = "";
  const io = {
    stdout: { write: () => {} },
    stderr: { isTTY: true, write: (text) => { stderr += text; } },
  };
  const result = await runCli(["setup"], {
    io,
    setup: () => { throw new Error("boom"); },
    connectClient: async () => { throw new Error("setup must not connect"); },
  });

  assert.equal(result.exitCode, 1);
  assert.ok(stderr.includes("\x1b[31merror: boom\x1b[0m\n"));
  assert.ok(stderr.includes("\x1b[2mhelp: fix the reported dependency or filesystem problem, then rerun node src/cli.js setup\x1b[0m\n"));
});

test("executes main() when invoked through a symlink to src/cli.js", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-cli-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realCli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const link = path.join(root, "taskferry");
  fs.symlinkSync(realCli, link, "file");

  const result = execFileSync(process.execPath, [link, "--version"], {
    cwd: path.dirname(realCli),
    encoding: "utf8",
  });
  const value = decode(result.trim());
  assert.equal(value.name, "taskferry");
  assert.equal(typeof value.version, "string");
  assert.equal(value.version.length > 0, true);
});
