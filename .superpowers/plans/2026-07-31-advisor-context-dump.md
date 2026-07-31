# `advisor` Auto-Context-Dump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `taskferry advisor` auto-attach the caller's own recent context (a Claude session transcript, or a ferry's own taskferry task log) wrapped in a directive canned prompt, so a weaker ferry can consult a stronger model with zero prompt-writing effort, while keeping `advisor`'s existing blocking behavior unchanged.

**Architecture:** All new logic lives client-side in `commands.js`'s `case "advisor"` — context resolution, prompt assembly, and the optional condensation round-trip are pure orchestration over RPCs the daemon already exposes (`task.tail`, `task.dispatch`, `task.wait`, `task.result`, `task.advisor`). The only daemon-side (`tasks.js`) changes are a new `TASKFERRY_TASK_ID` env var stamped on spawned children (so a ferry can identify itself) and raising `task.tail`'s existing `chars` ceiling.

**Tech Stack:** Node.js (no new dependencies). Full design rationale: `.superpowers/specs/2026-07-31-advisor-context-dump-design.md`.

## Global Constraints

- Default context budget: 120,000 chars, overridable via `TASKFERRY_ADVISOR_CONTEXT_CHARS` env var or `advisorContextChars` config key.
- `task.tail`'s `chars` ceiling rises from 65536 to 131072 in all three enforcement points (`args.js`, `protocol.js`, `tasks.js`).
- `--model` stays required on `advisor`; `--prompt` becomes optional.
- No enforcement of "the model must actually be stronger" — positioning only.
- `--summarize-context` defaults to off.
- Every new/changed test file must pass with `node --test src/<file>.test.js` before that task's commit.

---

### Task 1: Raise the shared `task.tail`/`--tail-chars` ceiling to 131072

**Files:**
- Modify: `src/args.js:84`, `src/args.js:419`
- Modify: `src/protocol.js:142`
- Modify: `src/tasks.js:3098-3099`
- Test: `src/args.test.js`, `src/protocol.test.js`, `src/tasks.test.js`

**Interfaces:**
- Produces: the shared ceiling constant `131072`, used verbatim by later tasks (Task 3's `ADVISOR_TAIL_CHARS_CAP` in `commands.js` clamps to this same number).

- [ ] **Step 1: Write the failing tests**

In `src/args.test.js`, add near the other `tail`/`wait` tests:

```js
test("tail --chars accepts up to the new 131072 ceiling and rejects above it", () => {
  assert.equal(parseArgs(["tail", "oc_1", "--chars", "131072"]).options.chars, 131072);
  assert.throws(() => parseArgs(["tail", "oc_1", "--chars", "131073"]), /from 1 through 131072/);
});
```

In `src/protocol.test.js`, add near the other `task.tail`/`task.dispatch` tests:

```js
test("task.tail accepts chars up to 131072", () => {
  const parsed = parseRequestLine(request("task.tail", { taskId: "t1", chars: 131072 }));
  assert.equal(parsed.params.chars, 131072);
});

test("task.tail rejects chars above 131072", () => {
  assert.throws(() => parseRequestLine(request("task.tail", { taskId: "t1", chars: 131073 })), /invalid params/i);
});
```

In `src/tasks.test.js`, add right after the existing `test("validates the requested suffix length", ...)` inside `describe("tail()", ...)`:

```js
  test("accepts a request up to the 131072 ceiling and rejects above it", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.doesNotThrow(() => mgr.tail("t1", { chars: 131072 }));
    assert.throws(() => mgr.tail("t1", { chars: 131073 }), /chars must be a positive integer no greater than 131072/);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test src/args.test.js src/protocol.test.js src/tasks.test.js`
Expected: the three new tests FAIL (old ceiling is still 65536, so `131072` is rejected and the "no greater than 131072" message doesn't exist yet).

- [ ] **Step 3: Raise the ceiling in all three enforcement points**

In `src/args.js`, change line 84's help text:

```js
    options: { "--chars <number>": "characters to return, default 1000, maximum 131072" },
```

And line 419:

```js
      value = parseNumber(value, name, key === "tailChars" || key === "chars" ? { min: 1, max: 131072 } : key === "maxWords" ? { min: 75, max: 300 } : { min: key === "limit" ? 1 : 0 });
```

In `src/protocol.js`, change line 142:

```js
        && optional(params.chars, (value) => positiveInteger(value) && value <= 131072);
```

In `src/tasks.js`, change lines 3098-3099:

```js
    if (!Number.isSafeInteger(chars) || chars <= 0 || chars > 131072) {
      throw new Error("error: chars must be a positive integer no greater than 131072\nhelp: run taskferry tail with chars between 1 and 131072");
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `node --test src/args.test.js src/protocol.test.js src/tasks.test.js`
Expected: PASS, all three new tests plus the full existing suites in these three files.

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/protocol.js src/tasks.js src/args.test.js src/protocol.test.js src/tasks.test.js
git commit -m "feat(tail): raise the chars ceiling from 65536 to 131072"
```

---

### Task 2: Stamp `TASKFERRY_TASK_ID` on every spawned dispatch/advisor child

**Files:**
- Modify: `src/tasks.js:818-824` (`dispatchEnvironment`), `src/tasks.js:1887` (call site)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `task.id` (already in scope at the `startTask()` call site as the `task` parameter).
- Produces: `env.TASKFERRY_TASK_ID` on every spawned dispatch/advisor child's environment — consumed by Task 4's `commands.js` context resolution as the "is this call coming from inside a ferry" signal.

- [ ] **Step 1: Write the failing test**

In `src/tasks.test.js`, add right after the existing `test("TASKFERRY_CHILD survives even when denylisted", ...)` block:

```js
  test("TASKFERRY_TASK_ID is stamped with the spawned task's own id, for both dispatch and advisor roles", async () => {
    let dispatchOpts = null;
    let advisorOpts = null;
    const mgr = makeManager({
      spawnFn: (cmd, args, opts) => {
        if (!dispatchOpts) dispatchOpts = opts; else advisorOpts = opts;
        const child = fakeChild();
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
    });

    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    assert.equal(dispatchOpts.env.TASKFERRY_TASK_ID, dispatched.id);

    const advised = await mgr.advisor({ prompt: "hello", directory: os.tmpdir(), model: "openai/gpt-5.6-sol" });
    assert.equal(advisorOpts.env.TASKFERRY_TASK_ID, advised.task_id);
  });

  test("TASKFERRY_TASK_ID is absent from summary spawns", async () => {
    let capturedOpts = null;
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "Investigated the issue" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
    });

    await mgr.summarize("source", { maxWords: 150 });

    assert.equal("TASKFERRY_TASK_ID" in capturedOpts.env, false);
  });
```

This mirrors the existing `describe("summarize()", ...)` block's `test("uses --pure and a private attachment", ...)` fixture pattern in this same file — confirm the `makeManager`/`baseTask`/`fakeChild` signatures still match that pattern before pasting, since this test file defines its own local helpers rather than importing shared ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `capturedOpts.env.TASKFERRY_TASK_ID` is `undefined`.

- [ ] **Step 3: Stamp the var in `dispatchEnvironment()` and pass the task id at the call site**

In `src/tasks.js`, change the `dispatchEnvironment` function (around line 818):

```js
  /** @param {NodeJS.ProcessEnv} [env] @param {string} [taskId] */
  function dispatchEnvironment(env, taskId) {
    const result = sanitizedEnvironment(env);
    result.TASKFERRY_CHILD = "1";
    result.TASKFERRY_TASK_ID = taskId;
    return result;
  }
```

And the call site at line 1887:

```js
      let spawnEnv = isSummary ? summaryEnvironment(summaryLaunch.env) : dispatchEnvironment(dispatchLaunch.env, task.id);
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): stamp TASKFERRY_TASK_ID on spawned dispatch/advisor children"
```

---

### Task 3: Add `advisorContextChars` config field and the pure context-gathering helpers

**Files:**
- Modify: `src/config.js` (`CONFIG_FIELD_TYPES`)
- Modify: `src/commands.js` (new module-scope helpers, no wiring into `case "advisor"` yet)
- Test: `src/commands.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (for Task 4 to wire in):
  - `resolveAdvisorContextChars(env)` → `number` (the effective budget).
  - `claudeTranscriptPath(homeDirectory, cwd, sessionId)` → `string` (absolute path).
  - `readTailChars(filePath, maxChars)` → `string` (throws `UsageError` on an unreadable file).

- [ ] **Step 1: Add the config field**

In `src/config.js`, add to `CONFIG_FIELD_TYPES`:

```js
  waitDefaultTimeoutMs: "number",
  cancelGraceMs: "number",
  defaultExecutor: "string",
  advisorContextChars: "number",
};
```

(Insert `advisorContextChars: "number",` as the last entry, right after `defaultExecutor`.)

- [ ] **Step 2: Write the failing tests for the helpers**

In `src/commands.test.js`, `describe` and `UsageError` aren't imported yet — update the import block at the top of the file to:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, resolveAdvisorContextChars, claudeTranscriptPath, readTailChars } from "./commands.js";
import { UsageError } from "./args.js";
```

Add a new `describe` block:

```js
describe("advisor context helpers", () => {
  test("resolveAdvisorContextChars() defaults to 120000", () => {
    assert.equal(resolveAdvisorContextChars({}), 120000);
  });

  test("resolveAdvisorContextChars() honors TASKFERRY_ADVISOR_CONTEXT_CHARS", () => {
    assert.equal(resolveAdvisorContextChars({ TASKFERRY_ADVISOR_CONTEXT_CHARS: "50000" }), 50000);
  });

  test("resolveAdvisorContextChars() falls back to the config file when the env var is unset", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-advisor-config-"));
    const configDir = path.join(dir, "taskferry");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ advisorContextChars: 75000 }));
    assert.equal(resolveAdvisorContextChars({ XDG_CONFIG_HOME: dir }), 75000);
  });

  test("claudeTranscriptPath() slugifies cwd the same way the account's project dirs are named", () => {
    const result = claudeTranscriptPath("/home/user", "/workspace/taskferry", "sess-1");
    assert.equal(result, path.join("/home/user", ".claude", "projects", "-workspace-taskferry", "sess-1.jsonl"));
  });

  test("readTailChars() returns the last N characters of a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-tail-chars-"));
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(filePath, "0123456789");
    assert.equal(readTailChars(filePath, 4), "6789");
  });

  test("readTailChars() returns the whole file when it's shorter than the budget", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-tail-chars-"));
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(filePath, "short");
    assert.equal(readTailChars(filePath, 4000), "short");
  });

  test("readTailChars() throws a UsageError naming the path when the file doesn't exist", () => {
    assert.throws(() => readTailChars("/nonexistent/transcript.jsonl", 100), (err) => err instanceof UsageError && /\/nonexistent\/transcript\.jsonl/.test(err.message));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `resolveAdvisorContextChars`/`claudeTranscriptPath`/`readTailChars` are not exported yet.

- [ ] **Step 4: Implement the helpers in `commands.js`**

Add `import path from "node:path";` to the top of `src/commands.js` (it currently imports `fs` and `os` but not `path`).

Add these module-scope declarations after `DEFAULT_WAIT_TIMEOUT_MS` (around line 27):

```js
// Default budget for advisor's auto-attached context: ~30k tokens, well
// under any provider's context window even after the canned prompt and the
// caller's own --prompt are added on top.
const DEFAULT_ADVISOR_CONTEXT_CHARS = 120000;

/**
 * Resolve the effective advisor context budget: explicit env var override,
 * then the config file's `advisorContextChars`, then the built-in default.
 * Mirrors resolveWaitDefaultTimeoutMs()'s resolution order.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolveAdvisorContextChars(env) {
  const envChars = Number(env.TASKFERRY_ADVISOR_CONTEXT_CHARS);
  if (Number.isFinite(envChars) && envChars > 0) return envChars;
  const configChars = Number(loadConfig({ env }).advisorContextChars);
  return Number.isFinite(configChars) && configChars > 0 ? configChars : DEFAULT_ADVISOR_CONTEXT_CHARS;
}

/**
 * The Claude Code project-directory slug for a given absolute cwd: the path
 * with every separator replaced by "-" (e.g. "/workspace/taskferry" ->
 * "-workspace-taskferry"), matching the convention Claude Code itself uses
 * under ~/.claude/projects/.
 * @param {string} cwd
 * @returns {string}
 */
function claudeProjectSlug(cwd) {
  return cwd.split(path.sep).join("-");
}

/**
 * @param {string} homeDirectory
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
function claudeTranscriptPath(homeDirectory, cwd, sessionId) {
  return path.join(homeDirectory, ".claude", "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Reads the last `maxChars` Unicode code points of `filePath` without
 * loading the whole file into memory -- a real transcript can be large.
 * UTF-8 code points are at most 4 bytes, so reading `maxChars * 4` bytes
 * from the tail guarantees enough raw bytes to yield `maxChars` code
 * points once decoded.
 * @param {string} filePath
 * @param {number} maxChars
 * @returns {string}
 */
function readTailChars(filePath, maxChars) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `advisor could not read the Claude session transcript at ${filePath}: ${message}`,
      "CLAUDE_CODE_SESSION_ID was set but its transcript file wasn't readable -- pass --prompt explicitly to skip auto-context, or check the transcript path"
    );
  }
  const bytes = Math.min(size, maxChars * 4);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
  } finally {
    fs.closeSync(fd);
  }
  const codePoints = Array.from(buffer.toString("utf8"));
  return codePoints.length > maxChars ? codePoints.slice(-maxChars).join("") : codePoints.join("");
}
```

Add these three names to `commands.js`'s exports (find the existing `export async function runCommand(...)` line and add the new exports right above it):

```js
export { resolveAdvisorContextChars, claudeTranscriptPath, readTailChars };

export async function runCommand(command, options, { ... }) {
```

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `node --test src/commands.test.js`
Expected: PASS, all new tests plus the full existing `commands.test.js` suite.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/commands.js src/commands.test.js
git commit -m "feat(commands): add advisorContextChars config and the pure advisor-context helpers"
```

---

### Task 4: Wire context resolution into `advisor`, make `--prompt` optional

**Files:**
- Modify: `src/args.js` (`--prompt` requirement, `defaultOptions`)
- Modify: `src/commands.js` (`case "advisor"`, new `ADVISOR_CANNED_PROMPT` constant, new `gatherAdvisorContext()` helper)
- Test: `src/args.test.js`, `src/commands.test.js`

**Interfaces:**
- Consumes: `resolveAdvisorContextChars`, `claudeTranscriptPath`, `readTailChars` (Task 3); `env.TASKFERRY_TASK_ID` (Task 2); the raised `task.tail` ceiling (Task 1).
- Produces: `gatherAdvisorContext({ client, env, cwd, homeDirectory })` → `Promise<{ source: string, text: string } | null>`, consumed by Task 5's `--summarize-context` wiring in the same `case "advisor"` block.

- [ ] **Step 1: Write the failing args.js test**

In `src/args.test.js`, add:

```js
test("advisor no longer requires --prompt (context-only invocation is now valid)", () => {
  const parsed = parseArgs(["advisor", "--model", "m"]);
  assert.equal(parsed.options.prompt, undefined);
  assert.equal(parsed.options.model, "m");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/args.test.js`
Expected: FAIL — `parseArgs(["advisor", "--model", "m"])` still throws `--prompt is required`.

- [ ] **Step 3: Split the `--prompt` requirement so only `dispatch` keeps it**

In `src/args.js`, change line 450:

```js
    if (command === "dispatch" && !options.prompt) throw usageError("--prompt is required", command);
```

- [ ] **Step 4: Run the args.js test again to verify it passes**

Run: `node --test src/args.test.js`
Expected: PASS. Also re-run the full file to confirm the existing `assert.throws(() => parseArgs(["dispatch"]), /--prompt is required/);` (line 64) and `assert.throws(() => parseArgs(["advisor", "--prompt", "question"]), /--model is required/);` (line 66) still pass unchanged.

- [ ] **Step 5: Write the failing commands.test.js tests for context resolution**

First, fix the three existing advisor tests in `src/commands.test.js` so they don't pick up whatever's ambient in the real test process's `process.env` (which may well have `CLAUDE_CODE_SESSION_ID` set, since these tests can run inside a live Claude Code session):

Change the client call in `test("advisor does NOT resolve via resolveWorkspaceRoot ...")` (around line 466):

```js
  await runCommand("advisor", { directory: undefined, prompt: "p", model: "m" }, { client, cwd, resolveWorkspaceRoot: resolveWorkspaceRootFn, env: {} });
```

Change `test("advisor forwards executor to the RPC payload when set")` (around line 625):

```js
  await runCommand("advisor", { prompt: "hi", directory: root, model: "m", executor: "pi" }, { client, cwd: root, env: {} });
```

`test("advisor forwards the caller's env to the RPC payload")` (around line 694) already passes `env: injectedEnv` (`{ FOO: "bar" }`), which has neither `CLAUDE_CODE_SESSION_ID` nor `TASKFERRY_TASK_ID` set, so it's already safe — leave it unchanged, but add a comment above the `injectedEnv` declaration noting it deliberately doubles as the "no context source" case for this reason.

Now add new tests. Insert after the (now-safe) `test("advisor forwards the caller's env to the RPC payload", ...)` block:

```js
test("advisor fails fast with no --prompt and no context source in env", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const client = { request: async () => { throw new Error("must not reach the daemon"); } };

  await assert.rejects(
    runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, env: {} }),
    (err) => err instanceof UsageError && /no context source/.test(err.message)
  );
});

test("advisor auto-attaches a Claude session transcript tail when CLAUDE_CODE_SESSION_ID is set and no --prompt is given", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-home-"));
  const slug = root.split(path.sep).join("-");
  const projectDir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "sess-1.jsonl"), '{"role":"user","text":"do the thing"}\n');

  let capturedPrompt;
  const client = { request: async (method, params) => { capturedPrompt = params.prompt; return { status: "done", message: "advice" }; } };

  await runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, homeDirectory: home, env: { CLAUDE_CODE_SESSION_ID: "sess-1" } });

  assert.match(capturedPrompt, /do the thing/);
  assert.match(capturedPrompt, /attached context \(claude-session/);
});

test("advisor fails fast when CLAUDE_CODE_SESSION_ID is set but the transcript file is missing", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-home-"));
  const client = { request: async () => { throw new Error("must not reach the daemon"); } };

  await assert.rejects(
    runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, homeDirectory: home, env: { CLAUDE_CODE_SESSION_ID: "sess-missing" } }),
    (err) => err instanceof UsageError && /transcript/.test(err.message)
  );
});

test("advisor fetches its own task.tail when TASKFERRY_TASK_ID is set and no --prompt is given", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      if (method === "task.tail") {
        assert.equal(params.taskId, "oc_self");
        return { taskId: "oc_self", status: "running", text: "ferry log tail text", textTotalChars: 20, truncated: false };
      }
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m" }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.match(capturedPrompt, /ferry log tail text/);
  assert.match(capturedPrompt, /attached context \(ferry-log/);
});

test("advisor with an explicit --prompt still attaches context when a source is available", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      if (method === "task.tail") return { taskId: "oc_self", status: "running", text: "ferry log tail text", textTotalChars: 20, truncated: false };
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m", prompt: "also check the retry logic" }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.match(capturedPrompt, /ferry log tail text/);
  assert.match(capturedPrompt, /also check the retry logic/);
});

test("advisor with an explicit --prompt and no context source sends the canned prompt plus the caller's prompt only", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedPrompt;
  const client = { request: async (method, params) => { capturedPrompt = params.prompt; return { status: "done", message: "advice" }; } };

  await runCommand("advisor", { directory: root, model: "m", prompt: "just answer this" }, { client, cwd: root, env: {} });

  assert.match(capturedPrompt, /just answer this/);
  assert.doesNotMatch(capturedPrompt, /attached context/);
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `case "advisor"` doesn't gather context yet, so the "must not reach the daemon" client throws on the plain RPC call, prompts don't contain the expected substrings, etc.

- [ ] **Step 7: Implement `gatherAdvisorContext()` and wire it into `case "advisor"`**

Add the canned prompt constant and `gatherAdvisorContext()` in `src/commands.js`, right after the helpers added in Task 3:

```js
const ADVISOR_TAIL_CHARS_CAP = 131072;

const ADVISOR_CANNED_PROMPT = `You are an advisor reviewing the in-progress work of a cheaper dispatcher agent. The text that follows is a tail of its session log: its current task, what it has read, what it has decided, and what it is about to do next. Treat it as suspect, not as a draft to refine.

Your reply goes directly back to that autonomous agent mid-task; it will not be read by a human first. Do not summarize what the ferry did and do not validate its choices for politeness. Push back.

Interrogate its assumptions: list each one the ferry is acting on without verifying, and say whether it is load-bearing. Hunt for blind spots: what did it not read, not run, not check, and where is a known foot-gun pattern it is about to step on (silent error swallow, mock-green-real-fail, off-by-one on the boundary it is touching, an unverified config default). Propose concrete alternatives: for each decision it is about to lock in, name at least one it has not considered, with the file and approximate line, not just an abstraction. Rank so the single highest-leverage change comes first.

Format: bulleted, terse, no preamble, no closing summary. Short sentences. Reference code as \`path/to/file.js:NNN\`. Prefer "should" and "must" over "you might consider." If there is nothing material to add, reply \`no change, proceed\` and stop.`;

/**
 * Resolves advisor's auto-attached context: a Claude session transcript
 * tail when CLAUDE_CODE_SESSION_ID is set (this call came directly from a
 * Claude Code session), else the calling ferry's own task.tail when
 * TASKFERRY_TASK_ID is set (this call came from inside a taskferry-spawned
 * worker), else null (no source available).
 * @param {object} params
 * @param {{request: (method: string, params: object) => Promise<any>}} params.client
 * @param {NodeJS.ProcessEnv} params.env
 * @param {string} params.cwd
 * @param {string} params.homeDirectory
 * @returns {Promise<{source: string, text: string} | null>}
 */
async function gatherAdvisorContext({ client, env, cwd, homeDirectory }) {
  const budget = resolveAdvisorContextChars(env);
  if (env.CLAUDE_CODE_SESSION_ID) {
    const transcriptPath = claudeTranscriptPath(homeDirectory, cwd, env.CLAUDE_CODE_SESSION_ID);
    const text = readTailChars(transcriptPath, budget);
    return { source: "claude-session", text };
  }
  if (env.TASKFERRY_TASK_ID) {
    const tailed = await client.request("task.tail", { taskId: env.TASKFERRY_TASK_ID, chars: Math.min(budget, ADVISOR_TAIL_CHARS_CAP) });
    const text = tailed.text === "none observed yet" ? "" : tailed.text;
    return { source: "ferry-log", text };
  }
  return null;
}
```

Now replace `case "advisor"` in `runCommand()` (currently around line 151) with:

```js
    case "advisor": {
      // advisor is grouped with dispatch (literal cwd), not with the
      // observation commands: tasks.js's advisor() forwards its directory
      // straight into dispatch(), which uses it as both the bwrap sandbox
      // root and the worker's spawn cwd -- so widening advisor's default
      // to the workspace root would silently expand its sandbox from
      // "the cwd you ran it in" to "the whole repo root".
      const directory = normalizeDirectory(options.directory || cwd);
      const gathered = await gatherAdvisorContext({ client, env, cwd, homeDirectory });
      if (!gathered && !options.prompt) {
        throw new UsageError(
          "advisor needs context or an explicit --prompt: no context source found",
          "Neither CLAUDE_CODE_SESSION_ID nor TASKFERRY_TASK_ID is set in the environment, so advisor has nothing to auto-attach -- pass --prompt explicitly, or run this from a Claude Code session or a taskferry-dispatched worker"
        );
      }
      const assembledPrompt = [
        ADVISOR_CANNED_PROMPT,
        ...(gathered ? [`\n--- attached context (${gathered.source}, ${gathered.text.length} chars) ---\n${gathered.text}\n---`] : []),
        ...(options.prompt ? [`\n${options.prompt}`] : []),
      ].join("\n");
      return client.request("task.advisor", {
        prompt: assembledPrompt,
        directory,
        model: options.model,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
        env,
      });
    }
```

- [ ] **Step 8: Run the tests again to verify they pass**

Run: `node --test src/args.test.js src/commands.test.js`
Expected: PASS, all new tests plus the full existing suites in both files.

- [ ] **Step 9: Commit**

```bash
git add src/args.js src/commands.js src/args.test.js src/commands.test.js
git commit -m "feat(advisor): auto-attach caller context and make --prompt optional"
```

---

### Task 5: `--summarize-context` flag and the arbitrary-text condenser

**Files:**
- Modify: `src/args.js` (`booleanCommands`, `booleanKeyOverrides`, `defaultOptions`, `commandAllows`, advisor's `commandSpecs` entry)
- Modify: `src/commands.js` (`summarizeContextText()` helper, wire into `case "advisor"`)
- Test: `src/args.test.js`, `src/commands.test.js`

**Interfaces:**
- Consumes: `gatherAdvisorContext()` (Task 4).
- Produces: `summarizeContextText(client, text, { env, directory })` → `Promise<string>` (best-effort; returns `text` unchanged on any failure).

- [ ] **Step 1: Write the failing args.js tests**

In `src/args.test.js`, add:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `--summarize-context` is an unrecognized flag on `advisor` too right now.

- [ ] **Step 3: Add the flag to `args.js`**

In `src/args.js`'s `booleanCommands` map (around line 371-380), add:

```js
    const booleanCommands = {
      "--full": ["wait", "status", "result", "doctor"],
      "--all": ["list"],
      "--wait": ["summary"],
      "--summaries": ["watch"],
      "--summarize": ["wait"],
      "--summarize-context": ["advisor"],
      "--no-sandbox": ["dispatch"],
      "--no-overlay": ["dispatch"], // advisor deliberately excluded -- review finding #5
      "--diff": ["result"],
    };
    const booleanKeyOverrides = { "--no-sandbox": "noSandbox", "--no-overlay": "noOverlay", "--summarize-context": "summarizeContext" };
```

In `defaultOptions()`'s `case "advisor"` (around line 272-273):

```js
    case "advisor":
      return { prompt: undefined, model: undefined, directory: undefined, variant: undefined, sessionId: undefined, timeoutMs: undefined, executor: undefined, summarizeContext: false };
```

In `commandAllows()`'s `advisor` entry (around line 492):

```js
    advisor: ["--prompt", "--model", "--directory", "--variant", "--session-id", "--timeout", "--executor", "--summarize-context"],
```

- [ ] **Step 4: Run the args.js tests again to verify they pass**

Run: `node --test src/args.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing commands.test.js tests**

Add to `src/commands.test.js`:

```js
test("advisor --summarize-context condenses the gathered context via a dispatch+wait+result round trip", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const calls = [];
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      calls.push(method);
      if (method === "task.tail") return { taskId: "oc_self", status: "running", text: "verbose ferry log text", textTotalChars: 20, truncated: false };
      if (method === "task.dispatch") return { id: "oc_summarizer", status: "queued" };
      if (method === "task.wait") return { id: "oc_summarizer", status: "done" };
      if (method === "task.result") return { message: "condensed summary" };
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m", summarizeContext: true }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.deepEqual(calls, ["task.tail", "task.dispatch", "task.wait", "task.result", "task.advisor"]);
  assert.match(capturedPrompt, /condensed summary/);
  assert.match(capturedPrompt, /attached context \(summarized ferry-log/);
  assert.doesNotMatch(capturedPrompt, /verbose ferry log text/);
});

test("advisor --summarize-context falls back to the raw text when the condense dispatch fails", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let capturedPrompt;
  const client = {
    request: async (method, params) => {
      if (method === "task.tail") return { taskId: "oc_self", status: "running", text: "verbose ferry log text", textTotalChars: 20, truncated: false };
      if (method === "task.dispatch") throw new Error("daemon unavailable");
      capturedPrompt = params.prompt;
      return { status: "done", message: "advice" };
    },
  };

  await runCommand("advisor", { directory: root, model: "m", summarizeContext: true }, { client, cwd: root, env: { TASKFERRY_TASK_ID: "oc_self" } });

  assert.match(capturedPrompt, /verbose ferry log text/);
  assert.match(capturedPrompt, /attached context \(ferry-log/);
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test src/commands.test.js`
Expected: FAIL — `case "advisor"` doesn't know about `options.summarizeContext` yet.

- [ ] **Step 7: Implement `summarizeContextText()` and wire it in**

Add to `src/commands.js`, after `gatherAdvisorContext()`:

```js
// Not the same model tasks.js's own summarizer uses for `task.summary`
// (DEFAULT_SUMMARY_MODEL) -- commands.js is the CLI process and doesn't
// import daemon-internal tasks.js, so this is an independent constant that
// happens to share the same value.
const ADVISOR_SUMMARIZE_MODEL = "opencode/mimo-v2.5-free";
const ADVISOR_SUMMARIZE_TIMEOUT_MS = 120000;

/**
 * Best-effort condensation of an arbitrary text blob via a throwaway
 * dispatch+wait+result round trip. Never throws: on any failure (dispatch
 * error, timeout, empty result) it returns `text` unchanged, since
 * condensation is a convenience, not a hard dependency of a working
 * advisor call.
 * @param {{request: (method: string, params: object) => Promise<any>}} client
 * @param {string} text
 * @param {{env: NodeJS.ProcessEnv, directory: string}} options
 * @returns {Promise<string>}
 */
async function summarizeContextText(client, text, { env, directory }) {
  const prompt = `Condense the following into a dense technical summary preserving key facts, decisions, and code references. Do not add commentary or a preamble.\n\n${text}`;
  try {
    const dispatched = await client.request("task.dispatch", {
      prompt,
      directory,
      model: env.TASKFERRY_ADVISOR_SUMMARIZER_MODEL || ADVISOR_SUMMARIZE_MODEL,
      env,
    });
    await client.request("task.wait", { taskId: dispatched.id, timeoutMs: ADVISOR_SUMMARIZE_TIMEOUT_MS });
    const result = await client.request("task.result", { taskId: dispatched.id, fields: ["message"] });
    if (typeof result.message === "string" && result.message.length) return result.message;
  } catch {
    // best-effort -- fall through to the raw text below.
  }
  return text;
}
```

In `case "advisor"`, replace the `gathered`/`assembledPrompt` block introduced in Task 4's Step 7 with:

```js
      const directory = normalizeDirectory(options.directory || cwd);
      const gathered = await gatherAdvisorContext({ client, env, cwd, homeDirectory });
      if (!gathered && !options.prompt) {
        throw new UsageError(
          "advisor needs context or an explicit --prompt: no context source found",
          "Neither CLAUDE_CODE_SESSION_ID nor TASKFERRY_TASK_ID is set in the environment, so advisor has nothing to auto-attach -- pass --prompt explicitly, or run this from a Claude Code session or a taskferry-dispatched worker"
        );
      }
      let finalContext = gathered;
      if (gathered && options.summarizeContext) {
        // Only relabel the source when condensation actually changed the
        // text -- summarizeContextText() returns the input unchanged on
        // any failure, and the fallback test in Step 5 expects that case
        // to still read as plain "ferry-log", not "summarized ferry-log".
        const condensed = await summarizeContextText(client, gathered.text, { env, directory });
        finalContext = condensed === gathered.text ? gathered : { source: `summarized ${gathered.source}`, text: condensed };
      }
      const assembledPrompt = [
        ADVISOR_CANNED_PROMPT,
        ...(finalContext ? [`\n--- attached context (${finalContext.source}, ${finalContext.text.length} chars) ---\n${finalContext.text}\n---`] : []),
        ...(options.prompt ? [`\n${options.prompt}`] : []),
      ].join("\n");
```

The `client.request("task.advisor", ...)` return statement right after it (from Task 4) is unchanged.

- [ ] **Step 8: Run the tests again to verify they pass**

Run: `node --test src/args.test.js src/commands.test.js`
Expected: PASS, all new tests plus the full existing suites.

- [ ] **Step 9: Update advisor's help text for the new flag**

In `src/args.js`'s `commandSpecs.advisor.options`, add:

```js
      "--summarize-context": "condense the auto-attached context through a throwaway model call before sending it (off by default)",
```

- [ ] **Step 10: Commit**

```bash
git add src/args.js src/commands.js src/args.test.js src/commands.test.js
git commit -m "feat(advisor): add --summarize-context to condense auto-attached context"
```

---

### Task 6: Reframe `advisor`'s positioning in help text (requirement a)

**Files:**
- Modify: `src/args.js` (`commandSpecs.advisor`)
- Test: `src/args.test.js`

**Interfaces:**
- Consumes: nothing (pure text change).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the failing test**

In `src/args.test.js`, add:

```js
test("advisor's help text frames it as consulting a stronger model", () => {
  const { helpText } = parseArgs(["advisor", "--help"]);
  assert.match(helpText.description, /stronger model/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/args.test.js`
Expected: FAIL — the current description ("Ask a model for advice and wait for its response.") doesn't mention "stronger model".

- [ ] **Step 3: Update the `advisor` entry in `commandSpecs`**

Replace the whole `advisor` entry in `src/args.js`:

```js
  advisor: {
    usage: "taskferry advisor --model <id> [--prompt <text>] [options]",
    description: "Consult a stronger model for a second opinion and block until it answers. With no --prompt, auto-attaches the caller's own recent context (a Claude Code session transcript, or the calling ferry's own task log) and asks for structured, actionable pushback.",
    options: {
      "--model <id>": "required",
      "--prompt <text>": "optional; auto-attaches context and asks for methodical review when omitted",
      "--directory <path>": "defaults to the current workspace",
      "--variant <name>": "optional model reasoning variant",
      "--session-id <id>": "continue a recent advisor session",
      "--timeout <duration>": "maximum wait, e.g. 10000 (ms), 30s, 5m, 1h",
      "--executor <opencode|pi>": "worker backend to dispatch through, default pi",
      "--summarize-context": "condense the auto-attached context through a throwaway model call before sending it (off by default)",
    },
    examples: [
      'taskferry advisor --model openai/gpt-5.6-sol',
      'taskferry advisor --prompt "How should I split this module?" --model openai/gpt-5.6-sol',
      'taskferry advisor --prompt "Review this design" --model zai/glm-5.2 --timeout 30s',
    ],
  },
```

(This merges the `--summarize-context` option line added in Task 5's Step 9 — if that step already landed, just confirm the merged entry above matches exactly rather than duplicating the key.)

- [ ] **Step 4: Run the test again to verify it passes**

Run: `node --test src/args.test.js`
Expected: PASS, plus the full existing `args.test.js` suite (in particular the "parses every documented command's help without requiring operation arguments" test, which asserts `helpText.usage` matches `taskferry advisor` — still true).

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "docs(advisor): reframe help text as consulting a stronger model"
```

---

### Task 7: Update `docs/sourcemap.md` and `docs/config.md`

**Files:**
- Modify: `docs/sourcemap.md`
- Modify: `docs/config.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (terminal task).

- [ ] **Step 1: Update `docs/sourcemap.md`'s file-by-file table rows**

In `docs/sourcemap.md`, update the `args.js` row (line 44) to append this sentence: "`advisor`'s `--prompt` is optional (the runtime requirement moved to `commands.js`); `--summarize-context` toggles best-effort context condensation."

Update the `commands.js` row (line 45) to append: "`advisor` auto-attaches the caller's own context before dispatching: a Claude session transcript tail when `CLAUDE_CODE_SESSION_ID` is set, or the calling ferry's own `task.tail` when `TASKFERRY_TASK_ID` is set (stamped on every spawned child by `tasks.js`), wrapped in a fixed canned prompt (`ADVISOR_CANNED_PROMPT`) — see `gatherAdvisorContext()`/`summarizeContextText()`."

Update the `protocol.js` row (line 49) to append: "`task.tail`'s `chars` ceiling is 131072 (raised from 65536 to fit advisor's default 120k-char context budget)."

Update the `config.js` row (line 58) to append: "`advisorContextChars` controls advisor's auto-attached context budget."

- [ ] **Step 2: Add the two new env vars to the `TASKFERRY_*` table**

In `docs/sourcemap.md`'s env var table, add two rows right after the `TASKFERRY_ADVISOR_SESSION_TTL_MS` row:

```
| `TASKFERRY_ADVISOR_CONTEXT_CHARS` | `120000` | yes (`advisorContextChars`) | Budget for advisor's auto-attached context (Claude transcript tail or ferry task log tail) |
| `TASKFERRY_ADVISOR_SUMMARIZER_MODEL` | `opencode/mimo-v2.5-free` | no | Model used by `advisor --summarize-context`'s condense-then-attach round trip |
```

- [ ] **Step 3: Update `docs/config.md`'s field table**

In `docs/config.md`, add a row after the `defaultExecutor` row:

```
| `advisorContextChars` | `TASKFERRY_ADVISOR_CONTEXT_CHARS` | number | `120000` |
```

- [ ] **Step 4: Verify the docs render sensibly**

Run: `rg -n "advisorContextChars|TASKFERRY_ADVISOR_CONTEXT_CHARS|TASKFERRY_ADVISOR_SUMMARIZER_MODEL" docs/sourcemap.md docs/config.md`
Expected: each name appears in both files where added, no leftover placeholder text.

- [ ] **Step 5: Commit**

```bash
git add docs/sourcemap.md docs/config.md
git commit -m "docs: document advisor's auto-context-dump feature"
```

---

## Final Verification

- [ ] Run the full suite once more end to end: `npm test` (or `node --test src/`)
- [ ] `taskferry advisor --model opencode/deepseek-v4-flash-free` from inside this repo (a real Claude Code session, so `CLAUDE_CODE_SESSION_ID` is genuinely set) and confirm it returns advice without requiring `--prompt`.
- [ ] `taskferry advisor --model opencode/deepseek-v4-flash-free --prompt "reply with PONG"` still works exactly as before (context now prepended, but the explicit prompt still drives the ask).
