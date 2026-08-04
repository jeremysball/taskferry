import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "./args.js";

const CWD = "/workspace/project";
const SUMMARIES_FLAG = "--summaries";
const SUMMARIZE_FLAG = "--summarize";
const FINAL_MARKER_FLAG = "--require-final-marker";
const EXECUTOR_FLAG = "--executor";
const TIMEOUT_MS_FLAG = "--timeout-ms";
const FLUSH_INTERVAL_FLAG = "--flush-interval";

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
  assert.deepEqual(parseArgs(["dispatch", "--prompt", "do it"], { cwd: CWD }), {
    command: "dispatch",
    options: {
      prompt: "do it",
      directory: CWD,
      model: void 0,
      variant: void 0,
      sessionId: void 0,
      finalMarker: void 0,
      noSandbox: false,
      noOverlay: false,
      allowedDirs: void 0,
      executor: void 0,
    },
    help: false,
  });
});

test("parses each command's required arguments and defaults", () => {
  const cwd = CWD;
  assert.equal(parseArgs(["cancel", "oc_1"]).options.taskId, "oc_1");
  assert.deepEqual(parseArgs(["wait", "oc_1"]).options, { taskId: "oc_1", timeoutMs: void 0, tailChars: void 0, full: false, summarize: false });
  assert.equal(parseArgs(["advisor", "--prompt", "help", "--model", "test/model"], { cwd }).options.directory, undefined);
  assert.equal(parseArgs(["status", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["tail", "oc_1"]).options.chars, undefined);
  assert.equal(parseArgs(["summary", "oc_1"]).options.mode, "report");
  assert.equal(parseArgs(["result", "oc_1"]).options.full, false);
  assert.equal(parseArgs(["list"], { cwd }).options.directory, undefined);
  assert.equal(parseArgs(["watch"], { cwd }).options.format, "toon");
  assert.equal(parseArgs(["context"], { cwd }).options.directory, undefined);
  assert.equal(parseArgs(["doctor"]).options.full, false);
});

test("doctor --stats sets options.stats", () => {
  const parsed = parseArgs(["doctor", "--stats"]);
  assert.equal(parsed.options.stats, true);
});

test("doctor with no --stats defaults options.stats to false", () => {
  const parsed = parseArgs(["doctor"]);
  assert.equal(parsed.options.stats, false);
});

test("doctor --stats --full is rejected", () => {
  assert.throws(
    () => parseArgs(["doctor", "--stats", "--full"]),
    (err) => err instanceof UsageError && /--stats cannot be combined with --full/.test(err.message)
  );
});

test("doctor --full --stats is rejected regardless of flag order", () => {
  assert.throws(
    () => parseArgs(["doctor", "--full", "--stats"]),
    (err) => err instanceof UsageError && /--stats cannot be combined with --full/.test(err.message)
  );
});

test("parses every documented command's help without requiring operation arguments", () => {
  for (const command of commands) {
    const parsed = parseArgs([command, "--help"]);
    assert.equal(parsed.command, command);
    assert.equal(parsed.help, true);
    assert.match(parsed.helpText.usage, new RegExp(`taskferry ${command}`));
  }
});

test("advisor's help text frames it as consulting a stronger model", () => {
  const { helpText } = parseArgs(["advisor", "--help"]);
  assert.match(helpText.description, /stronger model/);
});

test("requires command-specific arguments and values", () => {
  assert.throws(() => parseArgs(["dispatch"]), /--prompt is required/);
  assert.throws(() => parseArgs(["cancel"]), /task id is required/);
  assert.throws(() => parseArgs(["advisor", "--prompt", "question"]), /--model is required/);
  assert.throws(() => parseArgs(["result", "id", "--fields"]), /requires a value/);
  assert.throws(() => parseArgs(["tail", "id", "--chars", "0"]), /positive integer/);
});

test("tail --chars accepts up to the new 131072 ceiling and rejects above it", () => {
  assert.equal(parseArgs(["tail", "oc_1", "--chars", "131072"]).options.chars, 131072);
  assert.throws(() => parseArgs(["tail", "oc_1", "--chars", "131073"]), /from 1 through 131072/);
});

test("advisor no longer requires --prompt (context-only invocation is now valid)", () => {
  const parsed = parseArgs(["advisor", "--model", "m"]);
  assert.equal(parsed.options.prompt, undefined);
  assert.equal(parsed.options.model, "m");
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
    diff: false,
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
    SUMMARIES_FLAG,
  ]).options, {
    directory: "/tmp/project",
    format: "ndjson",
    summaries: true,
    taskId: void 0,
    flushIntervalMs: void 0,
    all: false,
  });
  assert.deepEqual(parseArgs(["list", "--all", "--limit", "10"]).options, {
    directory: void 0,
    all: true,
    limit: 10,
  });
});

test("watch --all parses like list --all: directory cleared, all: true, and rejects combining with --directory or --task-id (taskferry#315)", () => {
  assert.deepEqual(parseArgs(["watch", "--all"]).options, {
    directory: void 0,
    all: true,
    format: "toon",
    summaries: false,
    taskId: void 0,
    flushIntervalMs: void 0,
  });
  assert.throws(() => parseArgs(["watch", "--all", "--directory", "/tmp/some-workspace"]), /--all cannot be combined with --directory/);
  assert.throws(() => parseArgs(["watch", "--all", "--task-id", "oc_1"]), /--all cannot be combined with --task-id/);
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
  assert.deepEqual(parseArgs(["watch", "--task-id", "oc_1"], { cwd: CWD }).options, {
    directory: void 0,
    format: "toon",
    summaries: false,
    taskId: "oc_1",
    flushIntervalMs: void 0,
    all: false,
  });
  assert.throws(() => parseArgs(["status", "oc_1", "--task-id", "oc_2"]), /task id is required|unknown flag/);
});

test("rejects empty option values and trailing global arguments as usage errors", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--model", ""]), /--model requires a non-empty value/);
  assert.throws(() => parseArgs(["--version", "extra"]), /unexpected argument: extra/);
  assert.throws(() => parseArgs(["--help", "extra"]), /unexpected argument: extra/);
});

test("parses wait --summarize and rejects it combined with --timeout or --tail-chars", () => {
  assert.deepEqual(parseArgs(["wait", "oc_1", SUMMARIZE_FLAG]).options, {
    taskId: "oc_1",
    timeoutMs: void 0,
    tailChars: void 0,
    full: false,
    summarize: true,
  });
  assert.throws(() => parseArgs(["wait", "oc_1", SUMMARIZE_FLAG, "--timeout", "5000"]), /--summarize cannot be combined with --timeout/);
  assert.throws(() => parseArgs(["wait", "oc_1", SUMMARIZE_FLAG, "--tail-chars", "500"]), /--summarize cannot be combined with --tail-chars/);
});

test("parses dispatch --require-final-marker and rejects invalid regex sources", () => {
  assert.equal(
    parseArgs(["dispatch", "--prompt", "x", FINAL_MARKER_FLAG, "^Status: (DONE|DONE_WITH_CONCERNS)$"]).options.finalMarker,
    "^Status: (DONE|DONE_WITH_CONCERNS)$"
  );
  assert.equal(parseArgs(["dispatch", "--prompt", "x", "--require-final-marker=foo.*bar"]).options.finalMarker, "foo.*bar");
  assert.throws(
    () => parseArgs(["dispatch", "--prompt", "x", FINAL_MARKER_FLAG, "(unclosed"]),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /--require-final-marker is not a valid RegExp/);
      assert.match(error.help, /standard JS RegExp/);
      assert.equal(error.exitCode, 2);
      return true;
    }
  );
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", FINAL_MARKER_FLAG]), /requires a value/);
  assert.throws(() => parseArgs(["wait", "oc_1", FINAL_MARKER_FLAG, "foo"]), /unknown flag --require-final-marker/);
});

test("dispatch accepts --executor pi", () => {
  const { options } = parseArgs(["dispatch", "--prompt", "hi", EXECUTOR_FLAG, "pi"]);
  assert.equal(options.executor, "pi");
});

test("dispatch accepts --executor opencode", () => {
  const { options } = parseArgs(["dispatch", "--prompt", "hi", EXECUTOR_FLAG, "opencode"]);
  assert.equal(options.executor, "opencode");
});

test("dispatch rejects an unknown --executor value", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "hi", EXECUTOR_FLAG, "bogus"]), /must be one of opencode, pi/);
});

test("advisor accepts --executor pi", () => {
  const { options } = parseArgs(["advisor", "--prompt", "hi", "--model", "m", EXECUTOR_FLAG, "pi"]);
  assert.equal(options.executor, "pi");
});

test("advisor rejects an unknown --executor value", () => {
  assert.throws(() => parseArgs(["advisor", "--prompt", "hi", "--model", "m", EXECUTOR_FLAG, "bogus"]), /must be one of opencode, pi/);
});

test("parses dispatch --no-sandbox", () => {
  assert.equal(parseArgs(["dispatch", "--prompt", "x", "--no-sandbox"]).options.noSandbox, true);
  assert.throws(() => parseArgs(["dispatch", "--prompt", "x", "--no-sandbox=1"]), /--no-sandbox does not take a value/);
  assert.throws(() => parseArgs(["wait", "oc_1", "--no-sandbox"]), /unknown flag --no-sandbox/);
});

test("wait --timeout accepts bare milliseconds and duration strings", () => {
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "0"]).options.timeoutMs, 0);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "10000"]).options.timeoutMs, 10000);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "30s"]).options.timeoutMs, 30_000);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "5m"]).options.timeoutMs, 300_000);
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "1h"]).options.timeoutMs, 3_600_000);
});

test("wait --timeout rejects malformed duration strings", () => {
  const cases = ["-1", "1.5m", "5M", "1h30m", " 5m", "5m ", "abc", ""];
  for (const value of cases) {
    assert.throws(() => parseArgs(["wait", "oc_1", "--timeout", value]), UsageError, `expected rejection for "${value}"`);
  }
});

test("--timeout-ms and --timeout_ms both error with a migration message pointing at --timeout", () => {
  const migrationAssert = (args) => assert.throws(
    () => parseArgs(args),
    (error) => error instanceof UsageError
      && /unknown flag/.test(error.message)
      && /use --timeout/.test(error.help)
  );
  migrationAssert(["wait", "oc_1", TIMEOUT_MS_FLAG, "5000"]);
  migrationAssert(["wait", "oc_1", "--timeout_ms", "5000"]);
  migrationAssert(["advisor", "--prompt", "p", "--model", "m", TIMEOUT_MS_FLAG, "5000"]);
});

test("--timeout-ms on a command that doesn't accept --timeout falls through to a plain unknown-flag error", () => {
  // The migration hint targets --timeout, which is only valid on wait/advisor.
  // On status, emitting "use --timeout" as remediation would just produce a
  // second "unknown flag --timeout" error — so the migration branch itself
  // should fall through and emit the standard "Valid flags for status" hint
  // without the misleading "use --timeout" line.
  assert.throws(
    () => parseArgs(["status", "oc_1", TIMEOUT_MS_FLAG, "5000"]),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /unknown flag --timeout-ms/);
      assert.doesNotMatch(error.help, /use --timeout/);
      assert.match(error.help, /Valid flags for status/);
      return true;
    }
  );
  // Same for --timeout_ms.
  assert.throws(
    () => parseArgs(["status", "oc_1", "--timeout_ms", "5000"]),
    (error) => /unknown flag --timeout_ms/.test(error.message)
      && !/use --timeout/.test(error.help)
  );
});

test("wait --timeout accepts a duration just under the setTimeout maximum", () => {
  // Node's setTimeout max is 2^31-1 ms (~24.8 days); values above that are
  // silently clamped to 1ms, which would silently fire the wait timer after
  // ~1ms instead of the requested duration. Just-under stays parseable.
  const justUnderMs = 2_147_483_647;
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", String(justUnderMs)]).options.timeoutMs, justUnderMs);
  // 596h -> 2_145_600_000 ms (just under the max)
  assert.equal(parseArgs(["wait", "oc_1", "--timeout", "596h"]).options.timeoutMs, 596 * 3_600_000);
});

test("wait --timeout rejects a duration exceeding the setTimeout maximum", () => {
  // 1000000h is the exact "looks parseable, silently fires after ~1ms"
  // example: total ~36 trillion ms, well past the 2^31-1 ms setTimeout cap.
  assert.throws(
    () => parseArgs(["wait", "oc_1", "--timeout", "1000000h"]),
    (error) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /must not exceed/);
      assert.match(error.help, /2147483647 milliseconds/);
      return true;
    }
  );
  // Just over the cap in bare-ms form.
  assert.throws(
    () => parseArgs(["wait", "oc_1", "--timeout", "2147483648"]),
    /must not exceed/
  );
});

test("home's default directory is left undefined (resolved later via resolveWorkspaceRoot), for both the empty-argv and bare --help fast-paths", () => {
  assert.equal(parseArgs([], { cwd: CWD }).options.directory, undefined);
  assert.equal(parseArgs(["--help"], { cwd: CWD }).options.directory, undefined);
});

test("dispatch rejects --key-slot as an unknown flag", () => {
  assert.throws(
    () => parseArgs(["dispatch", "--prompt", "do it", "--key-slot", "primary"], { cwd: CWD }),
    /unknown flag --key-slot for `dispatch`/
  );
});

test("dispatch's default directory stays literal cwd, unaffected by the observation-command directory default change", () => {
  assert.equal(parseArgs(["dispatch", "--prompt", "x"], { cwd: CWD }).options.directory, CWD);
});

test("advisor's default directory stays undefined (resolved later to literal cwd, not the workspace root), unaffected by the observation-command directory default change", () => {
  // advisor is grouped with dispatch at the cli/commands layers because
  // tasks.js's advisor() forwards its directory straight into dispatch(),
  // which uses it as both the bwrap sandbox root and the worker's spawn
  // cwd. args.js leaves directory undefined for both dispatch's callers
  // (which get cwd from cli.js) and advisor's callers, so an explicit
  // pin here guards the args-layer shape those downstream layers depend
  // on.
  assert.equal(parseArgs(["advisor", "--prompt", "x", "--model", "m"], { cwd: CWD }).options.directory, undefined);
});

test("parses watch --flush-interval as a duration and requires --summaries", () => {
  assert.equal(
    parseArgs(["watch", SUMMARIES_FLAG, FLUSH_INTERVAL_FLAG, "5m"]).options.flushIntervalMs,
    300000
  );
  assert.equal(
    parseArgs(["watch", SUMMARIES_FLAG, FLUSH_INTERVAL_FLAG, "30000"]).options.flushIntervalMs,
    30000
  );
  assert.throws(
    () => parseArgs(["watch", FLUSH_INTERVAL_FLAG, "5m"]),
    /--flush-interval requires --summaries/
  );
});

test("watch --flush-interval 0 (and 0s) errors with a clear UsageError instead of silently falling back to per-event streaming", () => {
  // A zero-length flush interval is meaningless: streamTaskEvents's
  // truthy check (`flushIntervalMs ? ... : null`) would otherwise treat
  // 0 as "not set" and silently fall back to per-event streaming,
  // hiding the user's intent. args.js rejects it explicitly.
  assert.throws(
    () => parseArgs(["watch", SUMMARIES_FLAG, FLUSH_INTERVAL_FLAG, "0"]),
    /--flush-interval must be greater than zero/
  );
  assert.throws(
    () => parseArgs(["watch", SUMMARIES_FLAG, FLUSH_INTERVAL_FLAG, "0s"]),
    /--flush-interval must be greater than zero/
  );
});

test("dispatch accepts --no-overlay", () => {
  const parsed = parseArgs(["dispatch", "--prompt", "hi", "--no-overlay"]);
  assert.equal(parsed.options.noOverlay, true);
});

test("advisor rejects --no-overlay (overlay is mandatory for the advisor role; review finding #5)", () => {
  // Mirrors args.js's existing unknown-flag UsageError shape (the
  // booleanCommands gate): the remediation lists advisor's valid flags.
  assert.throws(
    () => parseArgs(["advisor", "--prompt", "hi", "--model", "openai/gpt-5.6-sol", "--no-overlay"]),
    /unknown flag --no-overlay/
  );
});

test("advisor accepts --summarize-context", () => {
  const parsed = parseArgs(["advisor", "--model", "m", "--summarize-context"]);
  assert.equal(parsed.options.summarizeContext, true);
});

test("advisor defaults --summarize-context to false", () => {
  const parsed = parseArgs(["advisor", "--model", "m"]);
  assert.equal(parsed.options.summarizeContext, false);
});

test("--summarize-context is rejected on dispatch", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "p", "--summarize-context"]), /unknown flag --summarize-context/);
});

test("result accepts --diff", () => {
  const parsed = parseArgs(["result", "t1", "--diff"]);
  assert.equal(parsed.options.diff, true);
});

test("result rejects --diff combined with --fields", () => {
  assert.throws(() => parseArgs(["result", "t1", "--diff", "--fields", "message"]), /--diff cannot be combined with --fields/);
});

test("result rejects --diff combined with --full (regression: review finding #3)", () => {
  // --full server-side only widens the narration preview; the diff field
  // is independent and gated by `fields: ["diff"]`. The pre-fix
  // if/else-if chain in commands.js silently dropped --full when both
  // were set, which is a confusing failure mode -- reject at parse time
  // instead so the error is loud and early.
  assert.throws(() => parseArgs(["result", "t1", "--diff", "--full"]), /--diff cannot be combined with --full/);
});

test("accept requires a task id", () => {
  assert.throws(() => parseArgs(["accept"]), /task id is required/);
});

test("accept parses a task id positional", () => {
  const parsed = parseArgs(["accept", "t1"]);
  assert.equal(parsed.command, "accept");
  assert.equal(parsed.options.taskId, "t1");
});

test("reject parses a task id positional", () => {
  const parsed = parseArgs(["reject", "t1"]);
  assert.equal(parsed.command, "reject");
  assert.equal(parsed.options.taskId, "t1");
});
