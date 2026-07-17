import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "./args.js";

const commands = [
  "dispatch",
  "cancel",
  "wait",
  "advisor",
  "status",
  "tail",
  "summary",
  "result",
  "list",
  "watch",
  "context",
  "doctor",
];

test("parses dispatch and applies its argument defaults", () => {
  assert.deepEqual(parseArgs(["dispatch", "--prompt", "do it"], { cwd: "/workspace/project" }), {
    command: "dispatch",
    options: {
      prompt: "do it",
      directory: "/workspace/project",
      model: undefined,
      variant: undefined,
      sessionId: undefined,
      keySlot: undefined,
    },
    help: false,
  });
});

test("parses each command's required arguments and defaults", () => {
  const cwd = "/workspace/project";
  assert.equal(parseArgs(["cancel", "oc_1"]).options.taskId, "oc_1");
  assert.deepEqual(parseArgs(["wait", "oc_1"]).options, { taskId: "oc_1", timeoutMs: undefined, tailChars: undefined, full: false });
  assert.equal(parseArgs(["advisor", "--prompt", "help", "--model", "test/model"], { cwd }).options.directory, cwd);
  assert.equal(parseArgs(["status", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["tail", "oc_1"]).options.chars, undefined);
  assert.equal(parseArgs(["summary", "oc_1"]).options.style, "report");
  assert.equal(parseArgs(["result", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["list"], { cwd }).options.directory, cwd);
  assert.equal(parseArgs(["watch"], { cwd }).options.format, "toon");
  assert.equal(parseArgs(["context"], { cwd }).options.format, "toon");
  assert.equal(parseArgs(["doctor"]).options.full, false);
});

test("parses every documented command's help without requiring operation arguments", () => {
  for (const command of commands) {
    const parsed = parseArgs([command, "--help"]);
    assert.equal(parsed.command, command);
    assert.equal(parsed.help, true);
    assert.match(parsed.helpText.usage, new RegExp(`taskferry ${command}`));
  }
});

test("requires command-specific arguments and values", () => {
  assert.throws(() => parseArgs(["dispatch"]), /--prompt is required/);
  assert.throws(() => parseArgs(["cancel"]), /task id is required/);
  assert.throws(() => parseArgs(["advisor", "--prompt", "question"]), /--model is required/);
  assert.throws(() => parseArgs(["result", "id", "--fields"]), /requires a value/);
  assert.throws(() => parseArgs(["tail", "id", "--chars", "0"]), /positive integer/);
});

test("rejects unknown flags and extra positional arguments before daemon access", () => {
  assert.throws(() => parseArgs(["list", "--stat"]), (error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /unknown flag --stat/);
    assert.match(error.help, /--directory/);
    assert.equal(error.exitCode, 2);
    return true;
  });
  assert.throws(() => parseArgs(["status", "one", "two"]), /unexpected argument: two/);
  assert.deepEqual(parseArgs(["setup"]), {
    command: "setup",
    options: {},
    help: false,
  });
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--full"]), /unknown flag --full/);
  assert.throws(() => parseArgs(["list", "--wait"]), /unknown flag --wait/);
});

test("rejects retired MCP names with one-step migration hints", () => {
  assert.throws(() => parseArgs(["taskferry_poll", "oc_1"]), (error) => {
    assert.match(error.message, /taskferry_poll/);
    assert.match(error.help, /taskferry wait oc_1/);
    return true;
  });
  assert.throws(() => parseArgs(["taskferry_dispatch"]), (error) => {
    assert.match(error.help, /taskferry dispatch/);
    return true;
  });
});

test("parses workspace, stream, and result options with their constrained values", () => {
  assert.deepEqual(parseArgs([
    "result",
    "oc_1",
    "--full",
    "--fields",
    "message,narration",
  ]).options, {
    taskId: "oc_1",
    full: true,
    fields: ["message", "narration"],
  });
  assert.deepEqual(parseArgs([
    "watch",
    "--directory",
    "/tmp/project",
    "--format",
    "ndjson",
    "--summaries",
  ]).options, {
    directory: "/tmp/project",
    format: "ndjson",
    summaries: true,
  });
  assert.deepEqual(parseArgs(["list", "--all", "--limit", "10"]).options, {
    directory: undefined,
    all: true,
    limit: 10,
  });
});

test("accepts --flag=value and rejects invalid enumerated values", () => {
  assert.equal(parseArgs(["dispatch", "--prompt=hello"]).options.prompt, "hello");
  assert.throws(() => parseArgs(["watch", "--format", "json"]), /must be one of toon, claude-monitor, ndjson/);
  assert.throws(() => parseArgs(["summary", "id", "--style", "brief"]), /must be one of report, activity/);
});

test("rejects empty option values and trailing global arguments as usage errors", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--model", ""]), /--model requires a non-empty value/);
  assert.throws(() => parseArgs(["--version", "extra"]), /unexpected argument: extra/);
  assert.throws(() => parseArgs(["--help", "extra"]), /unexpected argument: extra/);
});
