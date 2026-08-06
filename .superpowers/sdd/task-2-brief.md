### Task 2: `piExecutor()` — spawn args, models, sandbox auth

**Files:**
- Modify: `src/executor.js`
- Modify: `src/executor.test.js`

**Interfaces:**
- Consumes: the `WorkerExecutor`/`SpawnLaunchContext` shapes from Task 1.
- Produces: `piExecutor()`, and updates `resolveExecutor("pi")` to return it.

- [ ] **Step 1: Add `piExecutor()`'s non-normalization fields to `src/executor.js`**

```js
function splitProviderModel(model) {
  const slash = model.indexOf("/");
  if (slash === -1) return { provider: null, modelName: model };
  return { provider: model.slice(0, slash), modelName: model.slice(slash + 1) };
}

/** @returns {import("./executor.js").WorkerExecutor} */
export function piExecutor() {
  return {
    id: "pi",
    taskIdPrefix: "pi",
    errorBucketPrefix: "pi",
    defaultModel: "minimax/MiniMax-M2.7",
    defaultSummaryModel: "minimax/MiniMax-M2.7",
    summaryAgentName: null,
    summaryAgentConfig: null,
    summaryConfigEnvVar: null,
    listModelsFn: async (env) => (await execFileAsync("pi", ["--list-models"], { encoding: "utf8", timeout: SUMMARY_PREFLIGHT_TIMEOUT_MS, env })).stdout,
    // pi has no opencode-style named-agent tool-isolation mechanism; the
    // summary prompt's own isolation instruction (buildSummaryPrompt) is the
    // only boundary. This is a real reduction in defense-in-depth versus
    // opencode's `--agent taskferry-summary --tool bash: deny` preflight --
    // unreachable in this issue anyway (summaries stay opencode-only, see
    // the plan's Verified Findings #10), kept as a documented no-op for
    // interface completeness.
    verifySummaryAgentFn: async () => {},
    buildSpawnArgs(ctx) {
      const { provider, modelName } = splitProviderModel(ctx.model);
      const args = provider ? ["--provider", provider, "--model", modelName] : ["--model", modelName];
      args.push("--mode", "json");
      if (ctx.sessionId) args.push("--session", ctx.sessionId);
      if (ctx.isSummary) {
        args.push("-p", this.buildSummaryPrompt(), `@${ctx.snapshotPath}`);
      } else if (ctx.promptFilePath) {
        args.push("-p", "Follow the instructions in the attached prompt file exactly.", `@${ctx.promptFilePath}`);
      } else {
        args.push("-p", ctx.prompt);
      }
      return args;
    },
    buildSummaryPrompt() {
      return SUMMARY_ISOLATION_PROMPT;
    },
    normalizeLogEvent: piNormalizeLogEvent, // Task 3
    sandboxAuthFile({ runtimeDir, spawnEnv, existsFn }) {
      const realAuthDir = spawnEnv.PI_CODING_AGENT_DIR || path.join(homeDir_unused_placeholder());
      return { extraRoBind: null, sandboxedDataHome: path.join(runtimeDir, "pi-data") }; // completed in Step 2 below
    },
  };
}
```

That `sandboxAuthFile` body is a placeholder to be replaced in Step 2 below (kept separate so the diff for the real implementation is easy to review on its own) — do not leave the `homeDir_unused_placeholder()` call in the committed code; Step 2 replaces the whole method body.

- [ ] **Step 2: Implement `piExecutor().sandboxAuthFile` for real**

Replace the placeholder body from Step 1 with:

```js
    sandboxAuthFile({ homeDir, runtimeDir, spawnEnv, existsFn }) {
      // Verified: a real pi dispatch with PI_CODING_AGENT_DIR set to a fresh
      // dir wrote auth.json directly at $PI_CODING_AGENT_DIR/auth.json (not
      // namespaced under a provider subdir). When unset, pi's own default
      // resolves under the real home dir; taskferry doesn't need to
      // replicate that default exactly here since sandboxAuthFile always
      // receives spawnEnv, which dispatchEnvironment() populates from
      // process.env -- an ambient PI_CODING_AGENT_DIR, if the operator set
      // one, flows through unchanged.
      const realAuthDir = spawnEnv.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi");
      const realAuthFile = path.join(realAuthDir, "auth.json");
      const sandboxedDataHome = path.join(runtimeDir, "pi-data");
      return {
        extraRoBind: existsFn(realAuthFile) ? [realAuthFile, path.join(sandboxedDataHome, "auth.json")] : null,
        sandboxedDataHome,
      };
    },
```

Also update `resolveExecutor`:

```js
export function resolveExecutor(name) {
  if (name === undefined || name === "opencode") return opencodeExecutor();
  if (name === "pi") return piExecutor();
  throw new Error(`unknown executor: ${name}`);
}
```

- [ ] **Step 3: Add tests for `piExecutor()`'s non-normalization fields**

```js
describe("piExecutor()", () => {
  test("id/taskIdPrefix/errorBucketPrefix/defaultModel", () => {
    const ex = piExecutor();
    assert.equal(ex.id, "pi");
    assert.equal(ex.taskIdPrefix, "pi");
    assert.equal(ex.errorBucketPrefix, "pi");
    assert.equal(ex.defaultModel, "minimax/MiniMax-M2.7");
  });

  test("buildSpawnArgs: plain dispatch splits provider/model", () => {
    const ex = piExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "minimax/MiniMax-M2.7", launchDirectory: "/work/dir",
      promptFilePath: null, prompt: "Reply with exactly: PONG", sessionId: null,
    });
    assert.deepEqual(args, ["--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json", "-p", "Reply with exactly: PONG"]);
  });

  test("buildSpawnArgs: session resume uses --session alone, no --continue", () => {
    const ex = piExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "minimax/MiniMax-M2.7", launchDirectory: "/work/dir",
      promptFilePath: null, prompt: "continue", sessionId: "019f90ee-7230-74cf-8f30-15da5b6903b7",
    });
    assert.deepEqual(args, [
      "--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json",
      "--session", "019f90ee-7230-74cf-8f30-15da5b6903b7", "-p", "continue",
    ]);
    assert.ok(!args.includes("--continue"));
  });

  test("buildSpawnArgs: model with no provider prefix omits --provider", () => {
    const ex = piExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "gpt-4o", launchDirectory: "/work/dir",
      promptFilePath: null, prompt: "hi", sessionId: null,
    });
    assert.deepEqual(args, ["--model", "gpt-4o", "--mode", "json", "-p", "hi"]);
  });

  test("buildSpawnArgs: prompt routed through a file uses @path, not -f", () => {
    const ex = piExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: "minimax/MiniMax-M2.7", launchDirectory: "/work/dir",
      promptFilePath: "/state/prompts/t1.prompt.txt", prompt: "huge", sessionId: null,
    });
    assert.deepEqual(args, [
      "--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json",
      "-p", "Follow the instructions in the attached prompt file exactly.", "@/state/prompts/t1.prompt.txt",
    ]);
  });

  test("buildSpawnArgs: summary launch uses @snapshotPath, not -f", () => {
    const ex = piExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: true, model: "minimax/MiniMax-M2.7", launchDirectory: "/state/summaries",
      snapshotPath: "/state/summaries/pi_1.json", prompt: "", sessionId: null,
    });
    assert.deepEqual(args, [
      "--provider", "minimax", "--model", "MiniMax-M2.7", "--mode", "json",
      "-p", ex.buildSummaryPrompt(), "@/state/summaries/pi_1.json",
    ]);
  });

  test("sandboxAuthFile: binds $PI_CODING_AGENT_DIR/auth.json when present", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: { PI_CODING_AGENT_DIR: "/home/user/.local/state/pi" },
      existsFn: (p) => p === "/home/user/.local/state/pi/auth.json",
    });
    assert.deepEqual(result, {
      extraRoBind: ["/home/user/.local/state/pi/auth.json", "/state/run/pi-data/auth.json"],
      sandboxedDataHome: "/state/run/pi-data",
    });
  });

  test("sandboxAuthFile: falls back to ~/.pi when PI_CODING_AGENT_DIR unset", () => {
    const ex = piExecutor();
    const result = ex.sandboxAuthFile({
      homeDir: "/home/user", runtimeDir: "/state/run", spawnEnv: {},
      existsFn: (p) => p === "/home/user/.pi/auth.json",
    });
    assert.deepEqual(result.extraRoBind, ["/home/user/.pi/auth.json", "/state/run/pi-data/auth.json"]);
  });

  test("resolveExecutor(\"pi\") resolves to piExecutor", () => {
    assert.equal(resolveExecutor("pi").id, "pi");
  });
});
```

- [ ] **Step 4: Run tests (expect failure — `piNormalizeLogEvent` doesn't exist yet)**

Run: `node --test src/executor.test.js`
Expected: FAIL — `piNormalizeLogEvent is not defined` (or similar ReferenceError). This is expected; Task 3 defines it. Confirm every other new test in this step passes by reading the failure output — only the reference error should appear, no assertion failures.

- [ ] **Step 5: Commit**

```bash
git add src/executor.js src/executor.test.js
git commit -m "feat(executor): add piExecutor spawn args, list-models, and sandbox auth"
```

---

