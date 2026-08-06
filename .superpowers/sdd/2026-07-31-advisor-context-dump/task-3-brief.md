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

