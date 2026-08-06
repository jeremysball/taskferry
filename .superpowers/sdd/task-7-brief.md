### Task 7: `startTask()` — write-time normalization and executor-driven spawn

**Files:**
- Modify: `src/tasks.js` (`startTask` at line 1409, `classifyTrailingLogFailure`/`startRunningWatcher`'s `classifyProviderFailure` calls from Task 4)
- Test: `src/tasks.test.js`

**Interfaces:**
- Consumes: `launch.executor` (Task 5/6), `executor.buildSpawnArgs`/`executor.normalizeLogEvent`/`executor.sandboxAuthFile` (Tasks 1-3).
- Produces: the spawned child's stdout is normalized before it reaches the log file; the arg-building and sandbox auth-bind blocks are executor-driven instead of opencode-hardcoded.

- [ ] **Step 1: Write a failing test for write-time normalization**

```js
test("startTask pipes stdout through executor.normalizeLogEvent before writing to the log", async () => {
  const child = fakeChild();
  const spawnFn = mock.fn(() => child);
  const manager = makeManager({ spawnFn });
  const fakeExecutor = {
    ...resolveExecutorForTest("opencode"), // see note below -- import resolveExecutor from ../executor.js in the test file
    id: "test-exec",
    normalizeLogEvent: (evt) => (evt.type === "drop-me" ? null : { ...evt, normalized: true }),
  };
  const dispatched = manager.dispatch({ prompt: "hi", directory: process.cwd(), executor: "opencode" });
  // Swap the manager's resolved executor for this one dispatch is not
  // supported by the public API -- instead, inject via defaultExecutor at
  // manager construction for this test:
  const manager2 = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
  const dispatched2 = manager2.dispatch({ prompt: "hi", directory: process.cwd() });
  const logPath = manager2.status(dispatched2.id).logPath;
  assert.ok(child.stdout, "fakeChild must expose a stdout EventEmitter (see Task 9)");
  child.stdout.emit("data", Buffer.from('{"type":"drop-me"}\n{"type":"keep-me"}\n'));
  child.emit("exit", 0, null);
  const contents = fs.readFileSync(logPath, "utf8");
  assert.ok(!contents.includes("drop-me"));
  assert.ok(contents.includes('"keep-me"'));
  assert.ok(contents.includes('"normalized":true'));
});
```

Simplify the above once written against the real `makeManager`/`fakeChild` signatures from Task 9 — the sketch above intentionally shows the *intent* (inject a custom executor via `defaultExecutor`, feed the fake child's `stdout` stream, assert the log file only contains normalized/kept events); adjust exact helper names to match what Task 9 actually lands. Import `resolveExecutor` from `../executor.js` if needed, or build `fakeExecutor` as a plain object literal satisfying the `WorkerExecutor` shape directly (simpler — do this instead of the `resolveExecutorForTest` placeholder above, which does not exist):

```js
test("startTask pipes stdout through executor.normalizeLogEvent before writing to the log", async () => {
  const child = fakeChild();
  const spawnFn = mock.fn(() => child);
  const fakeExecutor = {
    id: "test-exec", taskIdPrefix: "oc", errorBucketPrefix: "test-exec",
    defaultModel: "openai/gpt-5.6-luna", defaultSummaryModel: "opencode/hy3-free",
    summaryAgentName: null, summaryAgentConfig: null, summaryConfigEnvVar: null,
    listModelsFn: async () => "", verifySummaryAgentFn: async () => {},
    buildSpawnArgs: () => ["run", "--dir", process.cwd(), "--auto", "--format", "json", "-m", "x", "--", "hi"],
    buildSummaryPrompt: () => "",
    normalizeLogEvent: (evt) => (evt.type === "drop-me" ? null : { ...evt, normalized: true }),
    sandboxAuthFile: () => ({ extraRoBind: null, sandboxedDataHome: "/tmp/unused" }),
  };
  const manager = makeManager({ spawnFn, defaultExecutor: fakeExecutor });
  const dispatched = manager.dispatch({ prompt: "hi", directory: process.cwd() });
  const logPath = manager.status(dispatched.id).logPath;
  child.stdout.emit("data", Buffer.from('{"type":"drop-me"}\n{"type":"keep-me"}\n'));
  child.emit("exit", 0, null);
  const contents = fs.readFileSync(logPath, "utf8");
  assert.ok(!contents.includes("drop-me"));
  assert.ok(contents.includes('"keep-me"'));
  assert.ok(contents.includes('"normalized":true'));
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --test src/tasks.test.js`
Expected: FAIL — `child.stdout` doesn't exist yet on `fakeChild()` (Task 9 adds it) and `startTask` still pipes stdout straight to the log fd. If Task 9 hasn't landed yet in your working order, land Task 9's `fakeChild()`/`makeManager()` changes first (they're small and this test depends on them) — see the note in Task 9.

- [ ] **Step 3: Rewrite `startTask`'s arg-building to go through the executor**

Replace the top of `startTask` (the `args` construction, lines 1417-1448) with:

```js
  function startTask(task) {
    const launch = pendingLaunches.get(task.id);
    pendingLaunches.delete(task.id);
    if (!launch) return;

    const isSummary = launch.kind === "summary";
    const summaryLaunch = /** @type {SummaryLaunch} */ (launch);
    const dispatchLaunch = /** @type {DispatchLaunch} */ (launch);
    const executor = launch.executor;
    const launchDirectory = isSummary ? SUMMARY_DIR : dispatchLaunch.directory;
    // A prompt over PROMPT_ARGV_SAFE_BYTES can't survive as a single argv
    // element (issue #78: `spawn E2BIG`). Route it through a prompt file
    // instead -- the executor's buildSpawnArgs attaches it however that
    // executor's CLI expects (opencode: `-f`; pi: a positional `@path`).
    const promptFilePath = !isSummary && Buffer.byteLength(dispatchLaunch.prompt, "utf8") > PROMPT_ARGV_SAFE_BYTES
      ? path.join(PROMPT_DIR, `${task.id}.prompt.txt`)
      : null;
    const args = executor.buildSpawnArgs({
      isSummary,
      model: isSummary ? summaryLaunch.model : dispatchLaunch.model,
      variant: isSummary ? undefined : dispatchLaunch.variant,
      launchDirectory,
      promptFilePath,
      snapshotPath: isSummary ? summaryLaunch.snapshotPath : undefined,
      prompt: isSummary ? "" : dispatchLaunch.prompt,
      sessionId: isSummary ? summaryLaunch.summarySessionId ?? null : dispatchLaunch.sessionId ?? null,
    });
```

Note this drops the old inline comments about `--continue --session` and the E2BIG workaround from `startTask` itself — they now live inside each executor's `buildSpawnArgs` (opencode's comment already exists there from Task 1; the E2BIG comment above stays in `startTask` since prompt-file routing itself, independent of which flag attaches it, still happens here).

Keep the rest of the function's scratch-file cleanup (`cleanUpScratchFiles`) unchanged — it already only reads `isSummary`/`summaryLaunch.snapshotPath`/`promptFilePath`, none of which changed shape.

- [ ] **Step 4: Rewrite the sandbox auth-bind block to use `executor.sandboxAuthFile`**

Replace the inline block (lines ~1487-1504 in the original — the `realDataHome`/`realAuthFile`/`sandboxedDataHome`/`extraRoBinds` construction) with:

```js
        const { extraRoBind, sandboxedDataHome } = executor.sandboxAuthFile({ homeDir, runtimeDir, spawnEnv, existsFn });
        /** @type {[string, string][]} */
        const extraRoBinds = [];
        if (extraRoBind) extraRoBinds.push(extraRoBind);
        if (promptFilePath) extraRoBinds.push([PROMPT_DIR, PROMPT_DIR]);
```

And where the spawn happens, replace the hardcoded `"opencode"` command with the executor's own CLI binary name. `WorkerExecutor` doesn't have an explicit "binary name" field in the interface from Task 1 — add one now, since `startTask` needs it and it was missing from the original spec's typedef (a real gap, not present in the Task 1 draft above either — fix both):

Go back and add `/** @property {string} binaryName */` to the `WorkerExecutor` typedef in `src/executor.js` (Task 1's file), and set `binaryName: "opencode"` in `opencodeExecutor()` / `binaryName: "pi"` in `piExecutor()`. Then in `startTask`:

```js
      let spawnCommand = executor.binaryName;
      let spawnArgs = args;
      if (sandboxEnabled && !noSandbox && platformSupportsSandbox(platform)) {
        requireBwrap();
        spawnCommand = "bwrap";
        const homeDir = os.homedir();
        const denyList = defaultDenyList(homeDir, stateDir).filter(existsFn);
        const { extraRoBind, sandboxedDataHome } = executor.sandboxAuthFile({ homeDir, runtimeDir, spawnEnv, existsFn });
        /** @type {[string, string][]} */
        const extraRoBinds = [];
        if (extraRoBind) extraRoBinds.push(extraRoBind);
        if (promptFilePath) extraRoBinds.push([PROMPT_DIR, PROMPT_DIR]);
        /** @type {string[]} */
        const extraRwBinds = [];
        const gitCommonDir = resolveGitCommonDirFn(launchDirectory);
        if (gitCommonDir && existsFn(gitCommonDir) && isOutsideDirectory(launchDirectory, gitCommonDir)) {
          extraRwBinds.push(gitCommonDir);
        }
        for (const dir of [...allowedDirs, ...(isSummary ? [] : dispatchLaunch.allowedDirs || [])]) {
          const resolved = path.isAbsolute(dir) ? dir : path.resolve(launchDirectory, dir);
          if (existsFn(resolved)) extraRwBinds.push(resolved);
        }
        spawnArgs = buildBwrapArgs({ directory: launchDirectory, stateDir, runtimeDir, homeDir, denyList, extraRwBinds, extraRoBinds }).concat(["--", executor.binaryName, ...args]);
        spawnEnv = { ...spawnEnv, XDG_DATA_HOME: sandboxedDataHome };
      }
```

Note `spawnEnv` (declared earlier in the function as `let spawnEnv = isSummary ? summaryLaunch.env : dispatchEnvironment(dispatchLaunch.keyEnvValue);`) must be passed into `executor.sandboxAuthFile` before the `spawnEnv = {...spawnEnv, XDG_DATA_HOME: sandboxedDataHome}` reassignment at the end of the block — this ordering already matches the code above (the `sandboxAuthFile` call reads `spawnEnv` before it's reassigned).

Also note: `opencodeExecutor().sandboxAuthFile` returns `sandboxedDataHome` as `path.join(runtimeDir, "opencode-data")` (its existing value), so this refactor is behavior-preserving for opencode — spot check by rereading Task 1's `opencodeExecutor()` implementation to confirm the returned `sandboxedDataHome` still gets used for `XDG_DATA_HOME` exactly as before.

- [ ] **Step 5: Change the stdout pipe from direct-to-fd to a line-buffered normalizing handler**

Replace:

```js
      child = spawnFn(spawnCommand, spawnArgs, {
        cwd: launchDirectory,
        stdio: ["ignore", logFd, logFd],
        detached: true,
        env: spawnEnv,
      });
      fs.closeSync(logFd);
      logFd = null;
```

with:

```js
      child = spawnFn(spawnCommand, spawnArgs, {
        cwd: launchDirectory,
        stdio: ["ignore", "pipe", logFd],
        detached: true,
        env: spawnEnv,
      });
      // stdout is normalized line-by-line through executor.normalizeLogEvent
      // before it reaches the log file, so every downstream reader
      // (readNarration, classifyProviderFailure, activity.js, ...) keeps
      // seeing exactly taskferry's canonical NDJSON shape regardless of
      // which executor produced it. stderr is unaffected -- it still
      // writes straight to the log fd (logFd, passed to stdio[2] above),
      // so crash dumps and unparseable noise land in the log unfiltered,
      // same as before this change.
      let stdoutCarry = "";
      const capturedLogFd = logFd;
      child.stdout.on("data", (chunk) => {
        stdoutCarry += chunk.toString("utf8");
        let nl;
        while ((nl = stdoutCarry.indexOf("\n")) !== -1) {
          const line = stdoutCarry.slice(0, nl);
          stdoutCarry = stdoutCarry.slice(nl + 1);
          if (!line.trim()) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // matches classifyProviderFailure's existing tolerant treatment of non-JSON noise
          }
          const normalized = executor.normalizeLogEvent(parsed);
          if (normalized == null) continue;
          try {
            fs.writeSync(capturedLogFd, `${JSON.stringify(normalized)}\n`);
          } catch {
            // Log fd closed out from under us (task already settled/cleaned
            // up) -- drop the trailing write rather than crash the handler.
          }
        }
      });
      child.stdout.on("end", () => {
        if (!stdoutCarry.trim()) return;
        try {
          const parsed = JSON.parse(stdoutCarry);
          const normalized = executor.normalizeLogEvent(parsed);
          if (normalized != null) fs.writeSync(capturedLogFd, `${JSON.stringify(normalized)}\n`);
        } catch {
          // trailing partial/malformed line at process end, ignore
        }
      });
```

Remove the old `fs.closeSync(logFd); logFd = null;` pair that immediately followed the old `spawnFn` call — the log fd must now stay open for the lifetime of the child (both the stdout handler above and stderr, which is still wired directly via `stdio[2]`, write to it), and gets closed only when the child actually exits. Add the close where `finishSettlement`/the `child.on("exit"...)` handler currently runs, since that's the first point after this change where nothing further will write to `capturedLogFd`:

```js
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        try {
          fs.closeSync(capturedLogFd);
        } catch {
          // Already closed or the fd table entry is gone; nothing to clean up.
        }
        const timer = escalationTimers.get(task.id);
        // ...rest of the existing handler body, unchanged...
```

And update the `catch (err)` block at the very bottom of `startTask` (the spawn-failure path) to close `capturedLogFd` instead of the now-renamed `logFd` variable if the child never got created — check `logFd != null` still refers to the *same* variable (it does; `capturedLogFd` is just a `const` alias taken right after assignment, `logFd` itself is untouched other than no longer being nulled-and-closed immediately after spawn). Re-read the full `try {...} catch (err) {...}` block after making these edits to confirm `logFd` (not `capturedLogFd`) is still what the `catch` branch closes, since that branch handles the case where `spawnFn` itself threw and `child`/`capturedLogFd` were never reached.

- [ ] **Step 6: Wire `classifyTrailingLogFailure`/`startRunningWatcher` to use `task.executorId`'s real bucket prefix**

Now that `task.executorId` exists (Task 5/6), replace the three `"opencode"` literals added in Task 4 Step 3 with the task's real prefix:

```js
  function classifyTrailingLogFailure(task) {
    if (task.failureReason) return;
    const watcherState = runningWatcherState.get(task.id);
    // ...unchanged...
    if (!text) return;
    const errorBucketPrefix = resolveExecutor(task.executorId).errorBucketPrefix;
    const { failure } = classifyProviderFailure(text.split("\n"), errorBucketPrefix);
    // ...unchanged...
  }
```

```js
          const errorBucketPrefix = resolveExecutor(current.executorId).errorBucketPrefix;
          const linesResult = classifyProviderFailure(lines, errorBucketPrefix);
          const carryResult = !linesResult.failure && carry && !carry.trimStart().startsWith("{")
            ? classifyProviderFailure([carry], errorBucketPrefix)
            : null;
```

(inside `startRunningWatcher`'s interval callback — `current` is that scope's task variable, matching the existing code around it).

- [ ] **Step 7: Run the full test suite**

Run: `node --test src/tasks.test.js`
Expected: PASS, including the write-time normalization test from Step 1 and every pre-existing test (opencode's `normalizeLogEvent` is the identity function, so nothing about opencode's behavior changes).

- [ ] **Step 8: Commit**

```bash
git add src/tasks.js
git commit -m "feat(tasks): drive startTask's spawn args, sandbox auth, and stdout normalization through the resolved executor"
```

---

