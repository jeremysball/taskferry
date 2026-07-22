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
      finalMarker: undefined,
      noSandbox: false,
    },
    help: false,
  });
});

test("parses each command's required arguments and defaults", () => {
  const cwd = "/workspace/project";
  assert.equal(parseArgs(["cancel", "oc_1"]).options.taskId, "oc_1");
  assert.deepEqual(parseArgs(["wait", "oc_1"]).options, { taskId: "oc_1", timeoutMs: undefined, tailChars: undefined, full: false, summarize: false });
  assert.equal(parseArgs(["advisor", "--prompt", "help", "--model", "test/model"], { cwd }).options.directory, cwd);
  assert.equal(parseArgs(["status", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["tail", "oc_1"]).options.chars, undefined);
  assert.equal(parseArgs(["summary", "oc_1"]).options.mode, "report");
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

test("parses the setup command with no arguments and rejects extras and flags", () => {
  assert.deepEqual(parseArgs(["setup"]), {
    command: "setup",
    options: {},
    help: false,
  });

  const helpParsed = parseArgs(["setup", "--help"]);
  assert.equal(helpParsed.command, "setup");
  assert.deepEqual(helpParsed.options, {});
  assert.equal(helpParsed.help, true);
  assert.match(helpParsed.helpText.usage, /taskferry setup/);

  assert.throws(() => parseArgs(["setup", "extra"]), /unexpected argument/);
  assert.throws(() => parseArgs(["setup", "--bogus"]), /unknown flag --bogus/);
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
  assert.ok(parseArgs([
    "result",
    "oc_1",
    "--fields",
    "failureDetail",
  ]).options.fields.includes("failureDetail"));
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
    taskId: undefined,
  });
  assert.deepEqual(parseArgs(["list", "--all", "--limit", "10"]).options, {
    directory: undefined,
    all: true,
    limit: 10,
  });
});

test("accepts --flag=value and rejects invalid enumerated values", () => {
  assert.equal(parseArgs(["dispatch", "--prompt=hello"]).options.prompt, "hello");
  assert.throws(() => parseArgs(["watch", "--format", "json"]), /must be one of toon, ndjson/);
  assert.throws(() => parseArgs(["summary", "id", "--mode", "brief"]), /must be one of report, activity/);
});

test("rejects the retired --style flag on summary with a rename hint pointing at --mode", () => {
  assert.throws(
    () => parseArgs(["summary", "id", "--style", "activity"]),
    (error) => error instanceof UsageError
      && /unknown flag --style/.test(error.message)
      && /--style was renamed; use --mode/.test(error.help)
  );
});

test("parses watch --task-id and rejects it for commands that don't take it", () => {
  assert.deepEqual(parseArgs(["watch", "--task-id", "oc_1"], { cwd: "/workspace/project" }).options, {
    directory: undefined,
    format: "toon",
    summaries: false,
    taskId: "oc_1",
  });
  assert.throws(() => parseArgs(["status", "oc_1", "--task-id", "oc_2"]), /task id is required|unknown flag/);
});

test("rejects empty option values and trailing global arguments as usage errors", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--model", ""]), /--model requires a non-empty value/);
  assert.throws(() => parseArgs(["--version", "extra"]), /unexpected argument: extra/);
  assert.throws(() => parseArgs(["--help", "extra"]), /unexpected argument: extra/);
});

test("parses wait --summarize and rejects it combined with --timeout-ms or --tail-chars", () => {
  assert.deepEqual(parseArgs(["wait", "oc_1", "--summarize"]).options, {
    taskId: "oc_1",
    timeoutMs: undefined,
    tailChars: undefined,
    full: false,
    summarize: true,
  });
  assert.throws(() => parseArgs(["wait", "oc_1", "--summarize", "--timeout-ms", "5000"]), /--summarize cannot be combined with --timeout-ms/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--summarize", "--tail-chars", "500"]), /--summarize cannot be combined with --tail-chars/);
});

test("parses dispatch --require-final-marker and rejects invalid regex sources", () => {
  assert.equal(
    parseArgs(["dispatch", "--prompt", "x", "--require-final-marker", "^Status: (DONE|DONE_WITH_CONCERNS)$"]).options.finalMarker,
    "^Status: (DONE|DONE_WITH_CONCERNS)$"
  );
  assert.equal(parseArgs(["dispatch", "--prompt", "x", "--require-final-marker=foo.*bar"]).options.finalMarker, "foo.*bar");
  assert.throws(
    () => parseArgs(["dispatch", "--prompt", "x", "--require-final-marker", "(unclosed"]),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /--require-final-marker is not a valid RegExp/);
      assert.match(error.help, /standard JS RegExp/);
      assert.equal(error.exitCode, 2);
      return true;
    }
  );
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--require-final-marker"]), /requires a value/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--require-final-marker", "foo"]), /unknown flag --require-final-marker/);
});

test("parses dispatch --no-sandbox", () => {
  assert.equal(parseArgs(["dispatch", "--prompt", "x", "--no-sandbox"]).options.noSandbox, true);
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--no-sandbox=1"]), /--no-sandbox does not take a value/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--no-sandbox"]), /unknown flag --no-sandbox/);
});
