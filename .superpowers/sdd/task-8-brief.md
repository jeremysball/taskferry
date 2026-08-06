### Task 8: CLI / RPC wiring — `--executor` on `dispatch` and `advisor`

**Files:**
- Modify: `src/args.js`, `src/commands.js`, `src/protocol.js`, `src/daemon.js`
- Test: `src/args.test.js`, `src/protocol.test.js` (or wherever each already has coverage — check for existing files with `rg -n "describe" src/args.test.js src/protocol.test.js` first and match their pattern)

**Interfaces:**
- Consumes: nothing new from other tasks — this is pure CLI/RPC plumbing.
- Produces: `taskferry dispatch --executor pi ...` / `taskferry advisor --executor pi ...` reach `manager.dispatch({..., executor: "pi"})` end to end.

- [ ] **Step 1: `src/args.js` — add the flag to both command specs, defaults, and validation**

In `commandSpecs.dispatch.options` and `commandSpecs.advisor.options`, add:

```js
      "--executor <opencode|pi>": "worker backend to dispatch through, default opencode",
```

In `defaultOptions()`:

```js
    case "dispatch":
      return { prompt: undefined, directory: cwd, model: undefined, variant: undefined, sessionId: undefined, keySlot: undefined, finalMarker: undefined, noSandbox: false, allowedDirs: undefined, executor: undefined };
    case "advisor":
      return { prompt: undefined, model: undefined, directory: cwd, variant: undefined, sessionId: undefined, timeoutMs: undefined, executor: undefined };
```

In the `values` flag-name map:

```js
    const values = {
      "--prompt": "prompt",
      "--directory": "directory",
      "--model": "model",
      "--variant": "variant",
      "--session-id": "sessionId",
      "--key-slot": "keySlot",
      "--grace-ms": "graceMs",
      "--timeout-ms": "timeoutMs",
      "--tail-chars": "tailChars",
      "--chars": "chars",
      "--mode": "mode",
      "--max-words": "maxWords",
      "--fields": "fields",
      "--limit": "limit",
      "--format": "format",
      "--task-id": "taskId",
      "--require-final-marker": "finalMarker",
      "--allowed-dirs": "allowedDirs",
      "--executor": "executor",
    };
```

Add validation alongside the existing `format`/`mode` enum checks:

```js
    } else if (key === "mode" && !["report", "activity"].includes(value)) {
      throw new UsageError(`${name} must be one of report, activity`, "Use --mode report or --mode activity");
    } else if (key === "executor" && !["opencode", "pi"].includes(value)) {
      throw new UsageError(`${name} must be one of opencode, pi`, "Use --executor opencode or --executor pi");
    } else if (key === "finalMarker") {
```

And add `"--executor"` to `commandAllows()`'s flags map for both `dispatch` and `advisor`:

```js
  const flags = {
    dispatch: ["--prompt", "--directory", "--model", "--variant", "--session-id", "--key-slot", "--require-final-marker", "--allowed-dirs", "--executor"],
    cancel: ["--grace-ms"],
    wait: ["--timeout-ms", "--tail-chars"],
    advisor: ["--prompt", "--model", "--directory", "--variant", "--session-id", "--timeout-ms", "--executor"],
    // ...rest unchanged...
```

- [ ] **Step 2: `src/commands.js` — forward `options.executor`**

In the `dispatch` case's `client.request("task.dispatch", {...})` body:

```js
      return client.request("task.dispatch", {
        prompt: options.prompt,
        directory,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.keySlot === undefined ? {} : { keySlot: options.keySlot }),
        ...(options.finalMarker === undefined ? {} : { finalMarker: options.finalMarker }),
        ...(options.noSandbox === undefined ? {} : { noSandbox: options.noSandbox }),
        ...(options.allowedDirs === undefined ? {} : { allowedDirs: options.allowedDirs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
        ...(process.env.CLAUDE_CODE_SESSION_ID ? { originSessionId: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      });
```

In the `advisor` case's `client.request("task.advisor", {...})` body:

```js
    case "advisor": {
      const directory = normalizeDirectory(options.directory || cwd);
      return client.request("task.advisor", {
        prompt: options.prompt,
        directory,
        model: options.model,
        ...(options.variant === undefined ? {} : { variant: options.variant }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.executor === undefined ? {} : { executor: options.executor }),
      });
    }
```

- [ ] **Step 3: `src/protocol.js` — allow and validate `executor`**

```js
    case "task.dispatch":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "keySlot", "finalMarker", "originSessionId", "noSandbox", "allowedDirs", "executor"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && optional(params.model, isNonEmptyString)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.keySlot, isNonEmptyString)
        && optional(params.finalMarker, isNonEmptyString)
        && optional(params.originSessionId, isNonEmptyString)
        && optional(params.noSandbox, (value) => typeof value === "boolean")
        && optional(params.allowedDirs, (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry)))
        && optional(params.executor, (value) => value === "opencode" || value === "pi");
```

```js
    case "task.advisor":
      return hasOnly(params, ["prompt", "directory", "model", "variant", "sessionId", "timeoutMs", "executor"])
        && isNonEmptyString(params.prompt)
        && isAbsolutePath(params.directory)
        && isNonEmptyString(params.model)
        && optional(params.variant, isNonEmptyString)
        && optional(params.sessionId, isNonEmptyString)
        && optional(params.timeoutMs, nonNegativeInteger)
        && optional(params.executor, (value) => value === "opencode" || value === "pi");
```

- [ ] **Step 4: `src/daemon.js` — forward `executor` in the `task.advisor` case**

```js
    case "task.advisor":
      return manager.advisor({
        prompt: params.prompt,
        directory: params.directory,
        model: params.model,
        ...(params.variant !== undefined ? { variant: params.variant } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.executor !== undefined ? { executor: params.executor } : {}),
      });
```

(`task.dispatch`'s case needs no change — `manager.dispatch(params)` already forwards the whole object, and Task 6's `dispatch()` already destructures `executor` out of its params.)

- [ ] **Step 5: Add/extend tests for each layer**

Check what test files already exist and cover these modules first:

```bash
fd -e test.js . src | rg 'args|protocol|commands|daemon'
```

For whichever file(s) cover `parseArgs`, add:

```js
test("dispatch accepts --executor pi", () => {
  const { options } = parseArgs(["dispatch", "--prompt", "hi", "--executor", "pi"]);
  assert.equal(options.executor, "pi");
});

test("dispatch rejects an unknown --executor value", () => {
  assert.throws(() => parseArgs(["dispatch", "--prompt", "hi", "--executor", "bogus"]), /must be one of opencode, pi/);
});

test("advisor accepts --executor pi", () => {
  const { options } = parseArgs(["advisor", "--prompt", "hi", "--model", "m", "--executor", "pi"]);
  assert.equal(options.executor, "pi");
});
```

For whichever file covers `parseRequestLine`/`validParams`, add:

```js
test("task.dispatch accepts an optional executor param", () => {
  const line = JSON.stringify({ version: 1, id: "r1", method: "task.dispatch", params: { prompt: "hi", directory: "/tmp", executor: "pi" } });
  assert.doesNotThrow(() => parseRequestLine(line));
});

test("task.dispatch rejects an invalid executor param", () => {
  const line = JSON.stringify({ version: 1, id: "r1", method: "task.dispatch", params: { prompt: "hi", directory: "/tmp", executor: "bogus" } });
  assert.throws(() => parseRequestLine(line), /INVALID_PARAMS/);
});

test("task.advisor accepts an optional executor param", () => {
  const line = JSON.stringify({ version: 1, id: "r1", method: "task.advisor", params: { prompt: "hi", directory: "/tmp", model: "m", executor: "opencode" } });
  assert.doesNotThrow(() => parseRequestLine(line));
});
```

Match each new test's exact assertion style (`assert.doesNotThrow` vs. checking a return value, error message format) to what the existing tests in that same file already do — read a couple of neighboring tests before writing these.

- [ ] **Step 6: Run the full suite**

Run: `node --test src/`
Expected: PASS across all modified files.

- [ ] **Step 7: Commit**

```bash
git add src/args.js src/commands.js src/protocol.js src/daemon.js src/*.test.js
git commit -m "feat(cli): add --executor flag to dispatch and advisor, wire through RPC"
```

---

