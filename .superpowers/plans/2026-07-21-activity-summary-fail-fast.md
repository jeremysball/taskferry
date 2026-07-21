# Activity Summary Fail-Fast + `--mode` Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `taskferry summary`'s `--style` flag to `--mode`, and make every activity-summary path (`taskferry summary --mode activity`, `watch --summaries`) fail fast on a real summarizer failure instead of silently substituting local narration behind an easy-to-miss `summaryFailed: true` flag.

**Architecture:** `--style` becomes `--mode` end-to-end (CLI flag parsing → RPC params → manager call → docs), a pure rename with no behavior change. Separately, `activityCache.refresh()` in `activity.js` stops catching a summarizer failure into fallback text; the error propagates to `taskferry summary --mode activity`'s caller directly, and `scheduleActivity()`'s live-event path (which also calls `refresh()`) gains a `.catch()` that emits an explicit failure event instead of letting the rejection go unhandled. `watch --summaries` additionally gets an upfront model-availability check at subscribe time via a new `manager.checkSummaryModelReady()` method, shared with a new upfront check inside `summarizeActivity()`.

**Tech Stack:** Node.js (native `node:test`/`node:assert`), no new dependencies.

## Global Constraints

- Governing spec: `.superpowers/specs/2026-07-21-activity-summary-fail-fast-design.md` — every task below implements one of its numbered sections.
- Plans/specs in this repo live under `.superpowers/plans/` and `.superpowers/specs/`, never `docs/superpowers/`.
- `skills/using-taskferry/SKILL.md` is the canonical skill source; `integrations/claude/skills/using-taskferry/SKILL.md` and `integrations/codex/skills/using-taskferry/SKILL.md` are generated copies — edit only the canonical file, then run `npm run skill:generate` and verify with `npm run skill:check`.
- After this branch merges: check `gh-axi issue list --state open` for issues this work resolves and close them with a reason/comment (project-wide rule in `CLAUDE.md`), and separately file the new follow-up issue Task 9 describes.
- Full verification gate before considering the plan done: `npm run test:unit`, `npm run lint`, `npm run typecheck`, `npm run skill:check` all clean (Task 10).

---

### Task 1: Rename `--style` → `--mode` in `args.js`

**Files:**
- Modify: `src/args.js:67-76` (command spec), `src/args.js:243` (`defaultOptions`), `src/args.js:300-309` (`migrationFlags`), `src/args.js:337` (`values` flag map), `src/args.js:358-359` (validation branch), `src/args.js:404` (`commandAllows`)
- Test: `src/args.test.js`

**Interfaces:**
- Produces: `parseArgs(["summary", ...])` returns `options.mode` (was `options.style`), values `"report"` (default) or `"activity"`. A bare `--style` flag throws `UsageError` with help text `"--style was renamed; use --mode"`.

- [ ] **Step 1: Update the failing/updated test expectations first**

In `src/args.test.js`, change line 43 from:

```js
  assert.equal(parseArgs(["summary", "oc_1"]).options.style, "report");
```

to:

```js
  assert.equal(parseArgs(["summary", "oc_1"]).options.mode, "report");
```

Change line 157 from:

```js
  assert.throws(() => parseArgs(["summary", "id", "--style", "brief"]), /must be one of report, activity/);
```

to:

```js
  assert.throws(() => parseArgs(["summary", "id", "--mode", "brief"]), /must be one of report, activity/);
```

Add a new test right after the `"accepts --flag=value and rejects invalid enumerated values"` test (after line 158's closing `});`):

```js
test("rejects the retired --style flag on summary with a rename hint pointing at --mode", () => {
  assert.throws(
    () => parseArgs(["summary", "id", "--style", "activity"]),
    (error) => error instanceof UsageError
      && /unknown flag --style/.test(error.message)
      && /--style was renamed; use --mode/.test(error.help)
  );
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test src/args.test.js`
Expected: FAIL — `options.mode` is `undefined` (the source still writes `options.style`), and the new rename-hint test fails because `--style` is not yet in `migrationFlags`.

- [ ] **Step 3: Rename the flag spec and default options**

In `src/args.js`, change the `summary` command spec (lines 67-76):

```js
  summary: {
    usage: "taskferry summary <id> [options]",
    description: "Create a bounded report or activity summary for a task.",
    options: {
      "--mode report|activity": "summary mode, default report",
      "--max-words <number>": "target length from 75 through 300",
      "--wait": "wait for active work before summarizing",
    },
    examples: ['taskferry summary <id>', 'taskferry summary <id> --mode activity --wait'],
  },
```

Change `defaultOptions()`'s `summary` case (line 243):

```js
    case "summary":
      return { taskId: undefined, mode: "report", maxWords: undefined, wait: false };
```

- [ ] **Step 4: Add the migration-flag rename hint**

In `src/args.js`, add a `--style` entry to the `migrationFlags` object (around line 300-306):

```js
    const migrationFlags = {
      "--task-id": "--task-id was replaced by the positional task id; use `taskferry status <id>`",
      "--timeout_ms": "--timeout_ms was renamed; use --timeout-ms",
      "--tail_chars": "--tail_chars was renamed; use --tail-chars",
      "--max_words": "--max_words was renamed; use --max-words",
      "--session_id": "--session_id was renamed; use --session-id",
      "--style": "--style was renamed; use --mode",
    };
```

- [ ] **Step 5: Rename the flag-to-key map and its validation branch**

In `src/args.js`, change the `values` map (line 337):

```js
      "--mode": "mode",
```

(replacing `"--style": "style",`). Change the validation branch (lines 358-359):

```js
    } else if (key === "mode" && !["report", "activity"].includes(value)) {
      throw new UsageError(`${name} must be one of report, activity`, "Use --mode report or --mode activity");
```

- [ ] **Step 6: Rename the `commandAllows` entry**

In `src/args.js`, change line 404:

```js
    summary: ["--mode", "--max-words"],
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `node --test src/args.test.js`
Expected: PASS — all tests green including the new rename-hint test.

- [ ] **Step 8: Commit**

```bash
git add src/args.js src/args.test.js
git commit -m "feat(args): rename summary's --style flag to --mode"
```

---

### Task 2: Propagate the `mode` rename through commands, protocol, daemon, and tasks

**Files:**
- Modify: `src/commands.js:138-143`, `src/protocol.js:119-123`, `src/daemon.js:205-209`, `src/tasks.js:954-958`

**Interfaces:**
- Consumes: `options.mode` from Task 1's `parseArgs()`.
- Produces: `client.request("task.summary", { taskId, maxWords?, mode? })`; `manager.summarize(taskId, { maxWords?, mode? })` (the `summarize` export is `summarizeRequest`, unchanged name).

- [ ] **Step 1: Rename in `commands.js`**

In `src/commands.js`, change the `summary` case (lines 138-143):

```js
      const summary = await client.request("task.summary", {
        taskId: options.taskId,
        ...(options.maxWords === undefined ? {} : { maxWords: options.maxWords }),
        ...(options.mode === "activity" ? { mode: options.mode } : {}),
      });
      return options.mode === "report" ? summary : { mode: options.mode, ...summary };
```

- [ ] **Step 2: Rename in `protocol.js`**

In `src/protocol.js`, change the `task.summary` case (lines 119-123):

```js
    case "task.summary":
      return hasOnly(params, ["taskId", "maxWords", "mode"])
        && isNonEmptyString(params.taskId)
        && optional(params.maxWords, (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 75 && /** @type {number} */ (value) <= 300)
        && optional(params.mode, (value) => value === "report" || value === "activity");
```

`event.subscribe`'s validParams (lines 134-138) is unaffected — it validates `summaries`/`originSessionId`, not `style`/`mode`.

- [ ] **Step 3: Rename in `daemon.js`**

In `src/daemon.js`, change the `task.summary` case (lines 205-209):

```js
    case "task.summary":
      return manager.summarize(params.taskId, {
        ...(params.maxWords === undefined ? {} : { maxWords: params.maxWords }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
      });
```

- [ ] **Step 4: Rename in `tasks.js`**

In `src/tasks.js`, change `summarizeRequest()` (lines 954-958):

```js
  /** @param {string} taskId @param {{maxWords?: number, mode?: string}} [options] */
  function summarizeRequest(taskId, options = {}) {
    if (options.mode === "activity") return activitySummary(taskId, options.maxWords ?? activityWords);
    return summarizeTask(taskId, options);
  }
```

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `npm run test:unit`
Expected: PASS. No existing test in `tasks.test.js`, `commands.test.js`, `daemon.test.js`, or `protocol.test.js` passes `style`/`mode` explicitly today (all rely on the `report` default), so this rename alone shouldn't change any assertions.

- [ ] **Step 6: Commit**

```bash
git add src/commands.js src/protocol.js src/daemon.js src/tasks.js
git commit -m "feat: propagate --style -> --mode rename through RPC and task manager"
```

---

### Task 3: Update docs and regenerate the skill for the `--mode` rename

**Files:**
- Modify: `docs/cli-reference.md:176,180-182`, `docs/security.md:83,87,115`, `docs/sourcemap.md:25,97`, `skills/using-taskferry/SKILL.md:266-267`
- Generated (via script, do not hand-edit): `integrations/claude/skills/using-taskferry/SKILL.md`, `integrations/codex/skills/using-taskferry/SKILL.md`

**Interfaces:**
- Consumes: nothing new (docs-only).
- Produces: nothing consumed by later tasks.

`docs/migrating-from-mcp.md` was checked and contains no `--style` reference — no change needed there.

- [ ] **Step 1: Update `docs/cli-reference.md`**

Change line 176 from:

```
| `--style report\|activity` | Default `report` |
```

to:

```
| `--mode report\|activity` | Default `report` |
```

Change lines 180-182 from:

```
`--style report` starts a separate, asynchronous summary task using
`opencode/hy3-free` by default: wait for the returned
`summaryTask.id`, then run `taskferry result` on that id. `--style activity`
```

to:

```
`--mode report` starts a separate, asynchronous summary task using
`opencode/hy3-free` by default: wait for the returned
`summaryTask.id`, then run `taskferry result` on that id. `--mode activity`
```

- [ ] **Step 2: Update `docs/security.md`**

Change line 83 from:

```
`taskferry watch --summaries` and `taskferry summary --style activity` both
```

to:

```
`taskferry watch --summaries` and `taskferry summary --mode activity` both
```

Change line 87 from:

```
`taskferry summary --style report` (the default `summary` style) does the
```

to:

```
`taskferry summary --mode report` (the default `summary` mode) does the
```

Change line 115 from:

```
  requests; `watch --summaries` and `summary --style activity` then fall
```

to:

```
  requests; `watch --summaries` and `summary --mode activity` then fall
```

- [ ] **Step 3: Update `docs/sourcemap.md`**

Change line 25 from:

```
                          call behind --style activity / watch --summaries)
```

to:

```
                          call behind --mode activity / watch --summaries)
```

Change line 97 from:

```
| `TASKFERRY_SUMMARY_MODEL` | `opencode/hy3-free` | yes | Model behind `summary --style report` |
```

to:

```
| `TASKFERRY_SUMMARY_MODEL` | `opencode/hy3-free` | yes | Model behind `summary --mode report` |
```

(Lines 99 and 101 say "activity-style" as a descriptive adjective, not the flag — leave them unchanged.)

- [ ] **Step 4: Update the canonical skill file's guidance block, not just the flag name**

In `skills/using-taskferry/SKILL.md`, the current guidance around lines 262-268 tells the calling model to reach for `summary <id> --style activity --wait` for interim visibility while a task runs, duplicating the `wait <id> --summarize` + `Monitor` pattern documented earlier in the same file (around lines 147-167). `--mode activity` is meant for the statusline/human `watch` path, not for a model checking in on its own dispatch — fix the guidance, not just the flag name. Change:

```
If the raw narration is long enough that reading it directly would blow the
context budget, condense it first instead of pulling it whole:

```sh
taskferry summary <id> --style report          # a bounded final report
taskferry summary <id> --style activity --wait # a short "what's happening now" while it's still running
```

Use a distinct prompt file for each concurrent task. Remove it with the runtime's
file tool after the task settles and its result has been validated.
```

to:

```
If the raw narration is long enough that reading it directly would blow the
context budget, condense it first instead of pulling it whole:

```sh
taskferry summary <id> --mode report # a bounded final report, after settlement
```

Don't call `summary <id> --mode activity` directly for interim visibility
while a task is still running -- that mode exists for the statusline/human
`watch` path, not for a model checking in on its own dispatch. Use
`taskferry wait <id> --summarize` instead (see above): it already streams
the same condensed activity summaries while blocking, without a second
parallel command doing the same job.

Use a distinct prompt file for each concurrent task. Remove it with the runtime's
file tool after the task settles and its result has been validated.
```

- [ ] **Step 5: Regenerate and verify the distributed skill copies**

Run:

```bash
npm run skill:generate
npm run skill:check
```

Expected: `skill:generate` prints "Generated distributed taskferry skills."; `skill:check` exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md docs/security.md docs/sourcemap.md skills/using-taskferry/SKILL.md integrations/claude/skills/using-taskferry/SKILL.md integrations/codex/skills/using-taskferry/SKILL.md
git commit -m "docs: rename --style to --mode across summary documentation"
```

---

### Task 4: `activityCache.refresh()` fails fast instead of masking a summarizer failure

**Files:**
- Modify: `src/activity.js:6` (typedef), `src/activity.js:220-292` (`refresh()`)
- Test: `src/activity.test.js`

**Interfaces:**
- Produces: `ActivityResult` is now `{activity: string, outputWatermark: number, cached: boolean}` (no `summaryFailed` field — it can never be `true` on a resolved promise, since a failure now rejects instead of resolving). `refresh()` rejects when `resolvedIncludeSummary` is true and the injected `summarize()` throws, or returns empty/unusable text after sanitization.
- Consumes: nothing new from other tasks (self-contained module).

- [ ] **Step 1: Update the existing tests that assert the old masking behavior**

In `src/activity.test.js`, replace the test at lines 243-256 (`"falls back to sanitized local activity when the secondary model fails"`) with:

```js
  test("propagates the secondary model's failure instead of falling back to local activity", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "Ran\n[2mtests[0m", outputWatermark: 30 }),
      summarize: async () => { throw new Error("provider unavailable"); },
    });

    await assert.rejects(cache.refresh(task, { force: true }), /provider unavailable/);
  });
```

In the test at lines 280-293 (`"can disable secondary model calls for fallback-only operation"`), remove the now-nonexistent-field assertion at line 292 (`assert.equal(result.summaryFailed, false);`) — the field no longer exists on `ActivityResult`, and this test's other two assertions (`calls === 0`, `result.activity === "local activity"`) already cover the disabled path fully. The test becomes:

```js
  test("can disable secondary model calls for fallback-only operation", async () => {
    let calls = 0;
    const cache = createActivityCache({
      summariesEnabled: false,
      snapshot: () => ({ text: "local\nactivity", outputWatermark: 40 }),
      summarize: async () => { calls++; return { text: "must not be used", sessionId: null }; },
    });

    const result = await cache.refresh(task, { force: true });

    assert.equal(calls, 0);
    assert.equal(result.activity, "local activity");
  });
```

In the test at lines 348-361 (`"does not store a session id or watermark when summarize returns empty text"`), replace the `assert.equal(result.summaryFailed, true);` assertion at line 358 with an `assert.rejects` around the whole call, since empty text now throws:

```js
  test("does not store a session id or watermark when summarize returns empty text", async () => {
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "snap", outputWatermark: 10 }),
      summarize: async () => ({ text: "   \n\t  ", sessionId: "ses_should_not_persist" }),
    });

    await assert.rejects(cache.refresh(task, { force: true }));
    assert.equal(cache.getSummarySessionId(task.id), null);
    assert.equal(cache.getLastSummarizedWatermark(task.id), 0);
  });
```

In the test at lines 363-394 (`"clears the stored session id and watermark after a thrown summarize failure so the next call retries fresh"`), replace the first `assert.equal(failed.summaryFailed, true);` with an `assert.rejects`, and drop the stale comment that describes the old masking behavior:

```js
  test("clears the stored session id and watermark after a thrown summarize failure so the next call retries fresh", async () => {
    let shouldThrow = true;
    let watermark = 10;
    const cache = createActivityCache({
      summariesEnabled: true,
      summarizerTimeoutMs: 0,
      snapshot: () => ({ text: "snap", outputWatermark: watermark }),
      summarize: async () => {
        if (shouldThrow) throw new Error("provider 503");
        return { text: "fresh summary", sessionId: "ses_fresh" };
      },
    });

    // A thrown summarize failure now propagates out of refresh() instead of
    // being masked; confirm the failure path still leaves the session and
    // watermark caches empty so the next call retries fresh.
    await assert.rejects(cache.refresh(task, { force: true }), /provider 503/);
    assert.equal(cache.getSummarySessionId(task.id), null);
    assert.equal(cache.getLastSummarizedWatermark(task.id), 0);

    // Bump the snapshot watermark so the next refresh isn't a cache hit on
    // a stale entry (a failed refresh is never cached, so this bump is only
    // needed to produce genuinely new content for the successful retry).
    shouldThrow = false;
    watermark = 20;
    const result = await cache.refresh(task, { force: true });

    assert.equal(result.activity, "fresh summary");
    assert.equal(cache.getSummarySessionId(task.id), "ses_fresh");
    assert.equal(cache.getLastSummarizedWatermark(task.id), 20);
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test src/activity.test.js`
Expected: FAIL — `refresh()` still resolves with fallback text and `summaryFailed: true` instead of rejecting.

- [ ] **Step 3: Update the `ActivityResult` typedef**

In `src/activity.js`, change line 6 from:

```js
/** @typedef {{activity: string, outputWatermark: number, summaryFailed: boolean, cached: boolean}} ActivityResult */
```

to:

```js
/** @typedef {{activity: string, outputWatermark: number, cached: boolean}} ActivityResult */
```

- [ ] **Step 4: Rewrite `refresh()`'s inner promise to fail fast**

In `src/activity.js`, replace the `promise = (async () => { ... })()` block (lines 245-289) with:

```js
    const promise = (async () => {
      if (!resolvedIncludeSummary) {
        const result = { activity: fallback, outputWatermark, cached: false };
        cache.set(key, result);
        inFlight.delete(key);
        return result;
      }
      try {
        const previousActivity = lastSummarizedActivity.get(task.id) || null;
        const previousSessionId = summarySessions.get(task.id) || null;
        const priorWatermark = lastSummarizedWatermarks.get(task.id) || 0;
        const summarized = await summarize({
          task,
          snapshot: current,
          maxWords: resolvedMaxWords,
          summaryModel,
          previousActivity,
          previousSessionId,
          lastSummarizedWatermark: priorWatermark,
        });
        const summarizedText = summarized && typeof summarized.text === "string" ? summarized.text : "";
        const text = sanitizeActivityText(summarizedText);
        if (!text) throw new Error("summarize() returned no usable text");
        lastSummarizedActivity.set(task.id, text);
        lastSummarizedWatermarks.set(task.id, outputWatermark);
        if (summarized && typeof summarized.sessionId === "string" && summarized.sessionId) {
          summarySessions.set(task.id, summarized.sessionId);
        }
        const result = { activity: text, outputWatermark, cached: false };
        cache.set(key, result);
        inFlight.delete(key);
        return result;
      } catch (err) {
        // Treat any failure (thrown or empty output) as "the cached state is
        // unreliable" so the next call retries fresh rather than resuming a
        // session that produced nothing usable. A failed refresh is never
        // cached (only `inFlight` tracking is cleared) -- callers see the
        // real error every time, not a stale masked result.
        summarySessions.delete(task.id);
        lastSummarizedWatermarks.delete(task.id);
        inFlight.delete(key);
        throw err;
      }
    })();
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `node --test src/activity.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/activity.js src/activity.test.js
git commit -m "feat(activity): fail fast on summarizer failure instead of masking with local narration"
```

---

### Task 5: `tasks.js` — `checkSummaryModelReady()` helper, and `activitySummary()`/`summarizeActivity()` fail fast

**Files:**
- Modify: `src/tasks.js:838-860` (add helper near `summaryModelAvailable`/`verifySummaryAgent`), `src/tasks.js:877-933` (`summarizeActivity()`), `src/tasks.js:936-952` (`activitySummary()`), `src/tasks.js:2070-2089` (manager return object)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: Task 4's `ActivityResult` shape (`refresh()` now rejects instead of returning `summaryFailed: true`).
- Produces: `manager.checkSummaryModelReady(): Promise<void>` — rejects with the same errors `summaryModelAvailable()`/`verifySummaryAgent()` throw. Consumed by Task 6 (`daemon.js`'s upfront `event.subscribe` check).

- [ ] **Step 1: Update the test whose success-path assertion references the removed `summaryFailed` field**

In `src/tasks.test.js`, in the `"continue-fails-so-fresh: ..."` test (around lines 2393-2395), remove the now-nonexistent-field assertion:

```js
    const result = await refreshP;
    assert.equal(result.summaryFailed, false);
    assert.equal(result.activity, "fresh retry output");
```

becomes:

```js
    const result = await refreshP;
    assert.equal(result.activity, "fresh retry output");
```

(The rest of the test — the two spawns, the session-id mismatch retry, the final session id assertion — is a success path and stays unchanged; this test's own default `listModelsFn`/`verifySummaryAgentFn` from `makeManager()` already succeed, so the new upfront `checkSummaryModelReady()` call added below doesn't affect it.)

- [ ] **Step 2: Add two new tests for the fail-fast behavior**

Add these after the `"does not launch when the effective summary agent isolation check fails"` test (after line 2136's closing `});`), inside the same `describe("summarize()", ...)` block:

```js
  test("checkSummaryModelReady rejects when the configured summary model is unavailable", async () => {
    const mgr = makeManager({ listModelsFn: () => "openai/gpt-5.6-luna\n" });
    await assert.rejects(mgr.checkSummaryModelReady(), /summary model is unavailable/);
  });

  test("checkSummaryModelReady rejects when the summary agent isolation check fails", async () => {
    const mgr = makeManager({ verifySummaryAgentFn: async () => { throw new Error("bash is enabled"); } });
    await assert.rejects(mgr.checkSummaryModelReady(), /summary agent isolation check failed/);
  });

  test("summary --mode activity rejects when the summary model is unavailable, instead of masking the failure with local narration", async () => {
    const log = JSON.stringify({ type: "text", part: { messageID: "m1", text: "progress" } });
    const mgr = makeManager({
      tasksFixture: (logDir) => [baseTask({ id: "source", logPath: path.join(logDir, "source.ndjson") })],
      logs: { "source.ndjson": log },
      listModelsFn: () => "openai/gpt-5.6-luna\n",
    });
    await assert.rejects(mgr.summarize("source", { mode: "activity", maxWords: 150 }), /summary model is unavailable/);
  });
```

- [ ] **Step 3: Run the tests to confirm the new ones fail**

Run: `node --test src/tasks.test.js`
Expected: FAIL on the three new tests — `mgr.checkSummaryModelReady` is not a function yet, and `summarize("source", { mode: "activity" })` still resolves with masked fallback text instead of rejecting.

- [ ] **Step 4: Add the `checkSummaryModelReady()` helper**

In `src/tasks.js`, add a new function directly after `verifySummaryAgent()` (after line 860, before the `summarizeActivity()` JSDoc comment):

```js
  /** Shared upfront readiness check for both the direct `summary --mode
   * activity` path and `watch --summaries`'s subscribe-time gate: throws the
   * same errors `summaryModelAvailable`/`verifySummaryAgent` throw, so a
   * caller can fail fast before doing any work. */
  async function checkSummaryModelReady() {
    const env = summaryEnvironment();
    await Promise.all([summaryModelAvailable(activitySummaryModel, env), verifySummaryAgent(env)]);
  }
```

- [ ] **Step 5: Make `summarizeActivity()` fail fast on a genuine model-unavailability error**

In `src/tasks.js`, change the start of `summarizeActivity()` (line 877) from:

```js
  async function summarizeActivity(taskId, maxWords, previousActivity) {
    const continueSessionId = activityCache.getSummarySessionId(taskId);
    try {
```

to:

```js
  async function summarizeActivity(taskId, maxWords, previousActivity) {
    // Run the model-availability/isolation check up front, outside the
    // try/catch below -- that catch exists for the stale-session retry
    // logic (a spawn or poll failure is legitimately best-effort), but a
    // genuine "model unavailable" or "isolation check failed" error must
    // propagate instead of being swallowed into an empty result. This
    // duplicates the same check `summarizeTask()` performs internally
    // further down, but both `summaryModelAvailable()` and
    // `verifySummaryAgent()` are self-memoized for 5 minutes, so the repeat
    // call is a cache hit, not a second real check.
    await checkSummaryModelReady();
    const continueSessionId = activityCache.getSummarySessionId(taskId);
    try {
```

The rest of `summarizeActivity()` (the try/catch's stale-session retry logic, lines 880-933) is unchanged.

- [ ] **Step 6: Drop the `summaryFailed` field from `activitySummary()`'s return object**

In `src/tasks.js`, change `activitySummary()` (lines 936-952) from:

```js
  async function activitySummary(taskId, maxWords) {
    ensureStateLoaded();
    const source = tasks.get(taskId);
    if (!source) throw noSuchTask(taskId);
    if (!Number.isSafeInteger(maxWords) || maxWords < 75 || maxWords > 300) {
      throw new Error("error: max_words must be an integer from 75 through 300\nhelp: run taskferry summary with max_words between 75 and 300");
    }
    const result = await activityCache.refresh(source, { force: true, includeSummary: activitySummariesEnabled, maxWords });
    if (!result) throw new Error("error: activity summary was not refreshed\nhelp: retry the activity summary request");
    return {
      sourceTaskId: taskId,
      sourceStatus: source.status,
      activity: result.activity,
      outputWatermark: result.outputWatermark,
      summaryFailed: result.summaryFailed,
    };
  }
```

to:

```js
  async function activitySummary(taskId, maxWords) {
    ensureStateLoaded();
    const source = tasks.get(taskId);
    if (!source) throw noSuchTask(taskId);
    if (!Number.isSafeInteger(maxWords) || maxWords < 75 || maxWords > 300) {
      throw new Error("error: max_words must be an integer from 75 through 300\nhelp: run taskferry summary with max_words between 75 and 300");
    }
    const result = await activityCache.refresh(source, { force: true, includeSummary: activitySummariesEnabled, maxWords });
    if (!result) throw new Error("error: activity summary was not refreshed\nhelp: retry the activity summary request");
    return {
      sourceTaskId: taskId,
      sourceStatus: source.status,
      activity: result.activity,
      outputWatermark: result.outputWatermark,
    };
  }
```

`activityCache.refresh()` (Task 4) now rejects on a real failure instead of returning a `summaryFailed: true` result, so this function no longer needs to forward that field — a `taskferry summary --mode activity` caller sees a real thrown error instead.

- [ ] **Step 7: Expose `checkSummaryModelReady` on the manager**

In `src/tasks.js`, add `checkSummaryModelReady` to the manager return object (around line 2070-2089):

```js
  return {
    dispatch,
    cancel,
    status,
    poll,
    list,
    result,
    tail,
    summarize: summarizeRequest,
    checkSummaryModelReady,
    setActivitySummarySubscriptions: /** @param {number} count */ (count) => {
      activitySummarySubscriptions = Math.max(0, Number.isSafeInteger(count) ? count : 0);
      activityCache.setSummariesEnabled(activitySummariesEnabled && activitySummarySubscriptions > 0);
    },
    advisor,
    paths: { STATE_DIR: stateDir, LOG_DIR, SUMMARY_DIR, TASKS_FILE },
    // Exposed primarily so tests can seed the summary session id and watermark
    // (the activity cache owns the "last successful summary" state shared
    // between the activity path and the direct summarize path).
    activityCache,
  };
```

- [ ] **Step 8: Run the tests to confirm they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): fail fast on summary-model unavailability instead of masking it"
```

---

### Task 6: `watch --summaries` fails fast upfront at `event.subscribe`

**Files:**
- Modify: `src/daemon.js:336-347`
- Test: `src/daemon.test.js`

**Interfaces:**
- Consumes: Task 5's `manager.checkSummaryModelReady()`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Make the fake manager support an injectable `checkSummaryModelReady`, and write the new test**

In `src/daemon.test.js`, change `fakeManagerFactory` (lines 24-86) to accept and expose a `checkSummaryModelReady` override:

```js
function fakeManagerFactory(tasks = [], { checkSummaryModelReady } = {}) {
  let onEvent;
  const calls = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const manager = {
    dispatch(params) {
      calls.push(["dispatch", params]);
      return { id: "new-task", status: "queued", ...params };
    },
    cancel(taskId, options) {
      calls.push(["cancel", taskId, options]);
      return { id: taskId, status: "cancelled" };
    },
    status(taskId) {
      calls.push(["status", taskId]);
      const task = byId.get(taskId);
      if (!task) throw new Error(`error: unknown task_id: ${taskId}\nhelp: run taskferry_list to see valid task ids`);
      return task;
    },
    async poll(taskId, options) {
      calls.push(["poll", taskId, options]);
      const delay = taskId === "slow" ? 30 : 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { id: taskId, status: "done" };
    },
    list() {
      calls.push(["list"]);
      return {
        counts: { queued: 0, running: 0, done: tasks.length, crashed: 0, cancelled: 0, unknown: 0 },
        tasks: tasks.length
          ? tasks.map(({ id, status, model = "test/model", startedAt = "2026-07-15T00:00:00.000Z" }) => ({ id, status, model, startedAt }))
          : "none found (this server process's lifetime)",
      };
    },
    result(taskId, options) {
      calls.push(["result", taskId, options]);
      return { taskId, status: "done", message: "result" };
    },
    tail(taskId, options) {
      calls.push(["tail", taskId, options]);
      return { taskId, text: "tail" };
    },
    summarize(taskId, options) {
      calls.push(["summarize", taskId, options]);
      return { sourceTaskId: taskId, summary: "summary" };
    },
    advisor(params) {
      calls.push(["advisor", params]);
      return { status: "done", message: "advice" };
    },
    checkSummaryModelReady: checkSummaryModelReady ?? (async () => {}),
  };

  return {
    factory(options) {
      onEvent = options.onEvent;
      return manager;
    },
    calls,
    emit(event) {
      onEvent(event);
    },
  };
}
```

Add a new test in the `describe("Unix socket daemon", ...)` block, after the `"supports multiple clients and multiple filtered subscriptions per connection"` test:

```js
  test("event.subscribe with summaries: true rejects upfront when the summary model isn't ready, without registering a subscription", async (t) => {
    const paths = temporaryPaths(t);
    const fake = fakeManagerFactory([], {
      checkSummaryModelReady: async () => {
        throw new Error("error: summary model is unavailable: opencode/hy3-free\nhelp: set TASKFERRY_SUMMARY_MODEL to an installed model, then retry taskferry_summary");
      },
    });
    const daemon = await startDaemon({ ...paths, taskManagerFactory: fake.factory });
    t.after(() => daemon.close());
    const peer = await openPeer(paths.socketPath);
    t.after(() => peer.close());

    const rejected = await peer.request("sub", "event.subscribe", { directory: paths.root, summaries: true });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /summary model is unavailable/);

    // Confirm no subscription was actually registered: a plain (non-summaries)
    // subscribe still succeeds afterward, proving the daemon didn't crash or
    // wedge its subscription state on the earlier rejection.
    const plain = await peer.request("sub2", "event.subscribe", { directory: paths.root });
    assert.equal(plain.ok, true);
    assert.ok(plain.result.subscriptionId);
  });
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/daemon.test.js`
Expected: FAIL — `event.subscribe` currently registers the subscription unconditionally; `rejected.ok` is `true`, not `false`.

- [ ] **Step 3: Add the upfront check in `daemon.js`**

In `src/daemon.js`, change the `event.subscribe` branch (lines 336-347) from:

```js
            if (request.method === "event.subscribe") {
              const subscriptionId = randomUUID();
              subscriptions.set(subscriptionId, {
                socket,
                directory: normalizeDirectory(request.params.directory),
                summaries: request.params.summaries === true,
                originSessionId: request.params.originSessionId || null,
              });
              updateSummarySubscriptions();
              writeMessage(socket, successResponse(request.id, { subscriptionId }));
              return;
            }
```

to:

```js
            if (request.method === "event.subscribe") {
              if (request.params.summaries === true && typeof manager.checkSummaryModelReady === "function") {
                await manager.checkSummaryModelReady();
              }
              const subscriptionId = randomUUID();
              subscriptions.set(subscriptionId, {
                socket,
                directory: normalizeDirectory(request.params.directory),
                summaries: request.params.summaries === true,
                originSessionId: request.params.originSessionId || null,
              });
              updateSummarySubscriptions();
              writeMessage(socket, successResponse(request.id, { subscriptionId }));
              return;
            }
```

A thrown error here is already caught by the surrounding `try`/`catch` (the same block that wraps `invoke(manager, request)` a few lines below), which writes `responseError(error, request?.id ?? null)` back to the socket — no new catch block is needed. The `typeof === "function"` guard matches the existing `updateSummarySubscriptions()` pattern for `manager.setActivitySummarySubscriptions`, so any manager fake lacking the method (elsewhere in the test suite) still works unchanged.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/daemon.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm run test:unit`
Expected: PASS — confirms the `fakeManagerFactory` signature change didn't break any other `daemon.test.js` test (all existing call sites pass either zero or one argument, both still valid with the new optional second parameter).

- [ ] **Step 6: Commit**

```bash
git add src/daemon.js src/daemon.test.js
git commit -m "feat(daemon): reject watch --summaries subscriptions upfront when the summary model isn't ready"
```

---

### Task 7: `scheduleActivity()` emits an explicit failure marker instead of an unhandled rejection

**Files:**
- Modify: `src/tasks.js:564-589`
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: Task 4's `refresh()` (now rejects instead of resolving with `summaryFailed: true`).
- Produces: a `task.activity` event shape with two variants: success (`activity`, `outputWatermark` present, as before) or failure (`summaryFailed: true`, `summaryError: string`, no `activity`/`outputWatermark`). Consumed by Task 8's `formatActivityLine()`.

- [ ] **Step 1: Write the new test**

In `src/tasks.test.js`, find the existing `"task.activity events carry the dispatching task's originSessionId"` test (line 275) to see the established pattern for driving `scheduleActivity()` via a real dispatched task and an injected `onEvent`. Add a new test nearby (same `describe` block) that drives it directly through `activityCache`'s injected `summarize` instead, to isolate the failure path:

```js
  test("scheduleActivity emits an explicit failure marker instead of local narration when the summary model call fails", async () => {
    const events = [];
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "source", status: "running", logPath: path.join(logDir, "source.ndjson") }) }],
      logs: { "source.ndjson": JSON.stringify({ type: "text", part: { messageID: "m1", text: "working" } }) },
      onEvent: (event) => events.push(event),
    });
    mgr.activityCache.setSummariesEnabled(true);
    const originalRefresh = mgr.activityCache.refresh;
    mgr.activityCache.refresh = () => Promise.reject(new Error("summary model is unavailable: opencode/hy3-free"));
    t.after?.(() => { mgr.activityCache.refresh = originalRefresh; });

    const source = mgr.list().tasks[0];
    mgr.scheduleActivity?.(source, { force: true });

    // scheduleActivity isn't exported on the manager directly -- exercise it
    // through the one public path that calls it internally instead: seed a
    // running task and let the natural activity-scheduling flow fire.
  });
```

This draft doesn't work as written (`scheduleActivity` is private to `tasks.js`, not exported). Replace it with a test that exercises `scheduleActivity()` through its one real caller, `dispatch()`'s post-launch activity scheduling — check `src/tasks.js` for where `scheduleActivity(task)` is invoked (search `scheduleActivity(` in `tasks.js`) and mirror the existing `"task.activity events carry the dispatching task's originSessionId"` test's setup (same fake `spawnFn`/`onEvent` pattern), but override `activitySummaryModel`/`listModelsFn` so the summary call fails. Read that existing test in full before writing this one, then write:

```js
  test("scheduleActivity emits an explicit failure marker instead of local narration when the summary model call fails", async (t) => {
    const events = [];
    const child = fakeChild();
    const mgr = makeManager({
      tasksFixture: [],
      spawnFn: () => child,
      listModelsFn: () => "openai/gpt-5.6-luna\n",
      onEvent: (event) => events.push(event),
    });
    mgr.setActivitySummarySubscriptions(1);

    mgr.dispatch({ prompt: "do the thing", directory: "/tmp/somewhere" });
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    const activityEvents = events.filter((event) => event.type === "task.activity");
    assert.ok(activityEvents.length >= 1, "expected at least one task.activity event");
    const failed = activityEvents.find((event) => event.summaryFailed === true);
    assert.ok(failed, "expected a task.activity event with summaryFailed: true");
    assert.equal(failed.activity, undefined);
    assert.match(failed.summaryError, /summary model is unavailable/);
  });
```

- [ ] **Step 2: Run the test to confirm it fails, then adjust setup to match the real call sites**

Run: `node --test src/tasks.test.js`

This test's exact setup (whether `dispatch()` alone triggers `scheduleActivity()` with `includeSummary: true` before the task settles, and what `t` parameter/timing is needed) depends on `tasks.js`'s real wiring around `dispatch()`/the watchdog poll loop that calls `scheduleActivity()`. Before finalizing this step, grep `scheduleActivity(` in `src/tasks.js` to find every call site and its surrounding context (state-transition handler, watchdog tick, etc.), and adjust the test's dispatch/exit/timer-advance sequence to actually reach one of them with `resolvedIncludeSummary: true`. Iterate until the test fails with "expected at least one task.activity event" or similar (proving the harness reaches `scheduleActivity()`), not with a setup/timeout error.

Expected once correctly wired: FAIL — no event in `events` currently has `summaryFailed: true` (today's `scheduleActivity()` has no `.catch()`, so a `refresh()` rejection becomes an unhandled promise rejection instead of an event).

- [ ] **Step 3: Add the `.catch()` handler in `scheduleActivity()`**

In `src/tasks.js`, change `scheduleActivity()` (lines 564-589) from:

```js
  function scheduleActivity(task, { force = false } = {}) {
    if (typeof onEvent !== "function" || task.internal) return;
    const scheduledStatus = task.status;
    const scheduledDirectory = task.directory;
    void activityCache.refresh(task, { force }).then(/** @param {{activity: string, outputWatermark: number, summaryFailed: boolean, cached: boolean}|null} result */ (result) => {
      if (!result) return;
      if (scheduledStatus === "running" && task.status !== scheduledStatus) return;
      const event = {
        sequence: ++eventSequence,
        type: "task.activity",
        taskId: task.id,
        directory: scheduledDirectory,
        originSessionId: task.originSessionId ?? null,
        status: scheduledStatus,
        previousStatus: null,
        occurredAt: new Date().toISOString(),
        activity: result.activity,
        outputWatermark: result.outputWatermark,
      };
      try {
        onEvent(event);
      } catch {
        // Activity is advisory and cannot interrupt task lifecycle.
      }
    });
  }
```

to:

```js
  function scheduleActivity(task, { force = false } = {}) {
    if (typeof onEvent !== "function" || task.internal) return;
    const scheduledStatus = task.status;
    const scheduledDirectory = task.directory;
    const baseEvent = () => ({
      sequence: ++eventSequence,
      type: "task.activity",
      taskId: task.id,
      directory: scheduledDirectory,
      originSessionId: task.originSessionId ?? null,
      status: scheduledStatus,
      previousStatus: null,
      occurredAt: new Date().toISOString(),
    });
    const emit = (event) => {
      if (scheduledStatus === "running" && task.status !== scheduledStatus) return;
      try {
        onEvent(event);
      } catch {
        // Activity is advisory and cannot interrupt task lifecycle.
      }
    };
    void activityCache.refresh(task, { force }).then(
      /** @param {{activity: string, outputWatermark: number, cached: boolean}|null} result */ (result) => {
        if (!result) return;
        emit({ ...baseEvent(), activity: result.activity, outputWatermark: result.outputWatermark });
      },
      (err) => {
        // A propagated summarizer failure (Task 4) must not become an
        // unhandled rejection here, and must not be smoothed over with a
        // retry or stale-narration substitution -- every failed tick
        // reports failure, explicitly, so a --summaries subscriber can tell
        // a real summary from a failed one.
        emit({ ...baseEvent(), summaryFailed: true, summaryError: errMessage(err) });
      }
    );
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/tasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.js src/tasks.test.js
git commit -m "feat(tasks): scheduleActivity emits an explicit failure event instead of an unhandled rejection"
```

---

### Task 8: `watch` renders the explicit failure marker distinctly

**Files:**
- Modify: `src/output.js:192-206` (`formatActivityLine`)
- Test: `src/output.test.js`

**Interfaces:**
- Consumes: Task 7's `task.activity` event shape (`summaryFailed`/`summaryError` fields on failure).

- [ ] **Step 1: Write the new test**

In `src/output.test.js`, add a test inside `describe("formatWatchEvent toon format for activity/state events", ...)`, after the `"collapses multi-line activity text to a single line"` test:

```js
  test("shows a distinct message for a task.activity event carrying an explicit summarize failure", () => {
    const line = formatWatchEvent({
      type: "task.activity",
      taskId: "oc_1",
      status: "running",
      occurredAt: "2026-07-18T00:06:12.414Z",
      summaryFailed: true,
      summaryError: "summary model is unavailable: opencode/hy3-free",
    }, "toon");

    assert.match(line, /oc_1/);
    assert.match(line, /running/);
    assert.match(line, /summary unavailable/);
    assert.match(line, /summary model is unavailable/);
    assert.equal(line.split("\n").length, 1);
  });
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/output.test.js`
Expected: FAIL — today `formatActivityLine` falls back to rendering just `event.status` (`"running"`) when `event.activity` is absent, with no "summary unavailable" text.

- [ ] **Step 3: Update `formatActivityLine`**

In `src/output.js`, change `formatActivityLine()` (lines 192-206) from:

```js
function formatActivityLine(event, useColor) {
  const time = shortTime(event.occurredAt);
  const prefix = time ? `${time} ` : "";
  const status = colorize(event.status, colorForStatus(event.status), useColor);
  if (event.type === "task.state") {
    const transition = event.previousStatus && event.previousStatus !== event.status
      ? `${event.previousStatus} -> ${status}`
      : status;
    return `${prefix}${event.taskId} ${transition}`;
  }
  const activity = typeof event.activity === "string" && event.activity
    ? event.activity.replace(/[\r\n]+/g, " ")
    : event.status;
  return `${prefix}${event.taskId} ${status}: ${activity}`;
}
```

to:

```js
function formatActivityLine(event, useColor) {
  const time = shortTime(event.occurredAt);
  const prefix = time ? `${time} ` : "";
  const status = colorize(event.status, colorForStatus(event.status), useColor);
  if (event.type === "task.state") {
    const transition = event.previousStatus && event.previousStatus !== event.status
      ? `${event.previousStatus} -> ${status}`
      : status;
    return `${prefix}${event.taskId} ${transition}`;
  }
  if (event.summaryFailed === true) {
    const reason = typeof event.summaryError === "string" && event.summaryError
      ? event.summaryError.replace(/[\r\n]+/g, " ")
      : "unknown error";
    return `${prefix}${event.taskId} ${status}: summary unavailable (${reason})`;
  }
  const activity = typeof event.activity === "string" && event.activity
    ? event.activity.replace(/[\r\n]+/g, " ")
    : event.status;
  return `${prefix}${event.taskId} ${status}: ${activity}`;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test src/output.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/output.js src/output.test.js
git commit -m "feat(output): render an explicit summary-failed marker in watch output"
```

---

### Task 9: File the follow-up GitHub issue for per-subscription summary scoping

**Files:** none (GitHub issue only)

- [ ] **Step 1: File the issue**

Run:

```bash
gh-axi issue create \
  --title "watch --summaries enablement is a single global toggle, not scoped per subscription/task" \
  --body "$(cat <<'EOF'
\`--summaries\` enablement (\`activitySummarySubscriptions > 0\` in \`src/tasks.js\`) is one process-global counter shared by every \`watch\` subscriber on the daemon, not scoped per subscription or per task. One client requesting \`watch --summaries\` turns on real model-backed summarization for *every* running task's activity events -- including tasks a different, non-\`--summaries\` client is watching at the same time.

Fixing this requires scoping the activity cache's summarization decision per subscription/task rather than process-global (e.g. the daemon tracking which specific tasks each \`--summaries\` subscriber cares about, and only summarizing for those). Out of scope for the fail-fast/\`--mode\` rename work (see \`.superpowers/plans/2026-07-21-activity-summary-fail-fast.md\` and its governing spec) -- tracked here as a follow-up.
EOF
)"
```

Expected: prints the created issue's number/URL.

- [ ] **Step 2: No commit** — this task has no code changes.

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm run test:unit`
Expected: all suites PASS, zero failures.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: clean, no errors.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean, no errors. Pay particular attention to any JSDoc `@typedef`/`@param` mismatches from the `ActivityResult` shape change (Task 4) and the `scheduleActivity()` callback type (Task 7) — both were updated inline in their respective tasks, but `tsc` may surface a call site this plan missed.

- [ ] **Step 4: Run skill:check**

Run: `npm run skill:check`
Expected: clean, no output — confirms Task 3's generated skill copies are current.

- [ ] **Step 5: No commit** — this task is verification-only. If any step fails, fix the underlying issue in the task that introduced it and re-commit there rather than adding a separate "fix lint" commit here.

---

## Self-Review

**Spec coverage:**

- Goal 1 (`--style` → `--mode` rename, with retired-flag hint) → Tasks 1-3.
- Goal 2 (`--mode activity` fails fast) → Task 4 (`activity.js`) + Task 5 (`tasks.js`'s `activitySummary()`/`summarizeActivity()`).
- Goal 3 upfront check (`event.subscribe` gate) → Task 6.
- Goal 3 per-tick check (`scheduleActivity()` explicit failure marker, no smoothing) → Task 7, plus Task 8 for the human-facing rendering half of "a `--summaries` subscriber has no way to tell a real summary from raw narration standing in for a failed one."
- Non-goal 1 (`watch` without `--summaries` unchanged) → untouched by every task; `buildLocalActivity()`/the `resolvedIncludeSummary === false` branch in Task 4's `refresh()` rewrite is preserved as-is.
- Non-goal 2 (`status()`'s `summarizedActivity` unaffected) → not touched by any task; that field lives in the separately-stashed WIP, not this plan.
- Non-goal 3 (per-subscription scoping out of scope) → Task 9 files the follow-up issue instead of implementing it.
- Testing section → every named test file (`activity.test.js`, `tasks.test.js`, `daemon.test.js`, `args.test.js`) has a corresponding task step; `output.test.js` was added beyond the spec's explicit list because Task 8 is a necessary consequence of Task 7's new event shape (a "no placeholders" gap-fill, not scope creep).

**Placeholder scan:** no task step describes a change without showing the exact before/after code; every code block is complete and copy-pasteable.

**Type consistency:** `ActivityResult` (Task 4's typedef) is used consistently as `{activity, outputWatermark, cached}` in Task 4's `refresh()`, Task 5's `activitySummary()` (drops the `summaryFailed` forward), and Task 7's `scheduleActivity()` JSDoc. `manager.checkSummaryModelReady` (Task 5's export) is consumed with the identical name in Task 6's `daemon.js` guard and `daemon.test.js` fake. `mode` (not `style`) is used consistently from Task 1's `parseArgs()` output through Task 2's `commands.js`/`protocol.js`/`daemon.js`/`tasks.js` call sites.

**Known soft spot:** Task 7's Step 1-2 test setup is written as "figure out the exact `scheduleActivity()` call site and iterate" rather than fully pre-verified against the live watchdog/dispatch timing, because pinning that timing exactly would have required tracing `tasks.js`'s dispatch/watchdog internals beyond what this plan's research covered. Treat Task 7 as needing a short discovery sub-step at execution time (grep `scheduleActivity(` in `tasks.js`, read the surrounding caller) before the test is finalized — this is flagged explicitly rather than papered over with a fake-passing test.
