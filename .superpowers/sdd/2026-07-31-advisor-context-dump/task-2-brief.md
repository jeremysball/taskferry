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

