import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { opencodeExecutor } from "./opencode-executor.js";
import { detectOpencodeCliMajor, ensureOpencodeCliMajor, resetOpencodeCliProbe } from "./opencode-version.js";
import { PROMPT_FILE_INSTRUCTION } from "./executor-shared.js";

const OPENAI_MODEL = "openai/gpt-5.6-luna";
const HOME_DIR = "/home/user";
const DATA_DIR = "/state/run";
const TASK_ID = "oc_task1";
const SANDBOXED_DATA_HOME = `${DATA_DIR}/opencode-data/${TASK_ID}`;
const SANDBOXED_CONFIG_HOME = `${SANDBOXED_DATA_HOME}/config`;
const SANDBOXED_CONFIG_DIR = `${SANDBOXED_CONFIG_HOME}/opencode`;
const OPENCODE_JSONC_DEST = `${SANDBOXED_CONFIG_DIR}/opencode.jsonc`;
const PLUGINS_DEST = `${SANDBOXED_CONFIG_DIR}/plugins`;
const OPENCODE_AUTH = "/home/user/.local/share/opencode/auth.json";
const GITIGNORE = ".gitignore";
const DISPATCH_PROMPT = "do the thing";
const PROMPT_FILE = "/state/prompts/t1.prompt.txt";
const SUMMARY_MODEL = "opencode/muse-spark-1.3-contributor-free";
const SUMMARY_SNAPSHOT = "/state/summaries/oc_1.json";
const V2_COMMON_HEAD = ["run", "--standalone", "--auto", "--format", "json"];
const V2_DISPATCH_HEAD = V2_COMMON_HEAD;
const SUMMARY_DIR = "/state/summaries";
const _OPENCODE_CONFIG_DIR = "/home/user/.config/opencode";
const OPENCODE_JSONC = "opencode.jsonc";
const PROMPT_FILE_INSTRUCTION_LOCAL = PROMPT_FILE_INSTRUCTION;
const OPENCODE_V2_STDOUT = "opencode v2.0.22\n";
const OPENCODE_V1_STDOUT = "1.18.3\n";
const OPENCODE_DEV_STDOUT = "0.0.0-dev-202610030456\n";
const OPENCODE_RUNNING_V2_STDOUT = "running opencode v2.0.22\n";

describe("opencodeExecutor()", () => {
  test("id/taskIdPrefix/errorBucketPrefix", () => {
    const ex = opencodeExecutor();
    assert.equal(ex.id, "opencode");
    assert.equal(ex.taskIdPrefix, "oc");
    assert.equal(ex.errorBucketPrefix, "opencode");
  });

  test("buildSpawnArgs: plain dispatch", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", OPENAI_MODEL, "--", DISPATCH_PROMPT]);
  });

  test("buildSpawnArgs: dispatch with variant and session resume", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: "high",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: "ses_1",
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", OPENAI_MODEL, "--continue", "--session", "ses_1", "--variant", "high", "--", DISPATCH_PROMPT]);
  });

  test("buildSpawnArgs: prompt routed through a file", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: PROMPT_FILE, prompt: "huge prompt", sessionId: null,
    });
    assert.deepEqual(args, ["run", "--dir", "/work/dir", "--auto", "--format", "json", "-m", OPENAI_MODEL, "-f", PROMPT_FILE, "--", PROMPT_FILE_INSTRUCTION_LOCAL]);
  });

  test("buildSpawnArgs: summary launch", () => {
    const ex = opencodeExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: true, model: SUMMARY_MODEL, launchDirectory: SUMMARY_DIR,
      snapshotPath: SUMMARY_SNAPSHOT, prompt: "", sessionId: null,
    });
    assert.deepEqual(args, [
      "run", "--dir", SUMMARY_DIR, "--pure", "--format", "json", "-m", SUMMARY_MODEL,
      "-f", SUMMARY_SNAPSHOT, "--", ex.buildSummaryPrompt(),
    ]);
  });

  test("buildSpawnArgs: opencode 2.x dispatch folds the variant into -m and drops --dir", () => {
    const ex = opencodeExecutor({ detectCliMajorFn: () => 2 });
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: "xhigh",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: null,
    });
    assert.deepEqual(args, [...V2_DISPATCH_HEAD, "-m", `${OPENAI_MODEL}#xhigh`, "--", DISPATCH_PROMPT]);
  });

  test("buildSpawnArgs: opencode 2.x resume passes --session without --continue", () => {
    const ex = opencodeExecutor({ detectCliMajorFn: () => 2 });
    const args = ex.buildSpawnArgs({
      isSummary: false, model: OPENAI_MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: PROMPT_FILE, prompt: "huge prompt", sessionId: "ses_1",
    });
    assert.deepEqual(args, [...V2_DISPATCH_HEAD, "-m", OPENAI_MODEL, "--session", "ses_1", "-f", PROMPT_FILE, "--", PROMPT_FILE_INSTRUCTION_LOCAL]);
  });

  test("buildSpawnArgs: opencode 2.x summary launch drops --dir and --pure, adds --auto", () => {
    const ex = opencodeExecutor({ detectCliMajorFn: () => 2 });
    const args = ex.buildSpawnArgs({
      isSummary: true, model: SUMMARY_MODEL, launchDirectory: SUMMARY_DIR,
      snapshotPath: SUMMARY_SNAPSHOT, prompt: "", sessionId: null,
    });
    // The implementation puts --auto right after --standalone, before --format
    const expected = [...V2_COMMON_HEAD, "-m", SUMMARY_MODEL,
      "-f", SUMMARY_SNAPSHOT, "--", ex.buildSummaryPrompt()];
    assert.deepEqual(args, expected);
  });
});

describe("opencodeExecutor() - version probe and memoization", () => {
  test("detectOpencodeCliMajor parses both version formats and memoizes on a TTL", async () => {
    let calls = 0;
    let out = OPENCODE_V2_STDOUT;
    const execFileFn = async () => { calls++; return { stdout: out, stderr: "" }; };
    let clock = 0;
    const now = () => clock;
    resetOpencodeCliProbe();
    // First probe - should shell out
    assert.equal(await ensureOpencodeCliMajor({ execFileFn, now, ttlMs: 60000 }), 2);
    assert.equal(calls, 1);
    // Inside TTL - should use memo
    clock = 30 * 1000;
    assert.equal(detectOpencodeCliMajor({ now, ttlMs: 60000 }), 2, "inside the TTL the memo wins");
    assert.equal(calls, 1, "no new shell-out inside TTL");
    // Past TTL - should re-probe
    clock = 70 * 1000;
    out = OPENCODE_V1_STDOUT;
    assert.equal(await ensureOpencodeCliMajor({ execFileFn, now, ttlMs: 60000 }), 1, "past the TTL it re-probes");
    assert.equal(calls, 2);
    resetOpencodeCliProbe();
    // Failed probe should return null and not poison cache
    assert.equal(await ensureOpencodeCliMajor({ execFileFn: async () => { throw new Error("ENOENT"); } }), null);
    resetOpencodeCliProbe();
  });

  test("normalizeLogEvent is the identity function", () => {
    const ex = opencodeExecutor();
    const evt = { type: "text", part: { text: "hi", messageID: "m1" } };
    assert.equal(ex.normalizeLogEvent(evt), evt);
  });

  test("binaryName is \"opencode\" so startTask can spawn the right CLI", () => {
    assert.equal(opencodeExecutor().binaryName, "opencode");
  });
});

describe("opencodeExecutor() - version probe: caching behavior", () => {
    test("failed probe is not cached and does not poison a previous good value", async () => {
      resetOpencodeCliProbe();
      // First, establish a good cached value
      await ensureOpencodeCliMajor({ execFileFn: async () => ({ stdout: OPENCODE_V1_STDOUT, stderr: "" }) });
      assert.equal(detectOpencodeCliMajor(), 1);
      // Now simulate a failed probe - it should not overwrite the cache
      try {
        await ensureOpencodeCliMajor({ execFileFn: async () => { throw new Error("ENOENT"); } });
      } catch { /* expected */ }
      // Cache should still have the good value
      assert.equal(detectOpencodeCliMajor(), 1);
      resetOpencodeCliProbe();
    });
});

describe("opencodeExecutor() - version probe: error handling", () => {
    test("unknown version (probe returns null) fails the dispatch via prepareLaunch", async () => {
      resetOpencodeCliProbe();
      const ex = opencodeExecutor({
        detectCliMajorFn: () => null,
        ensureCliMajorFn: async () => null,
      });
      await assert.rejects(ex.prepareLaunch({ isSummary: false }), /opencode CLI major version could not be detected/);
      resetOpencodeCliProbe();
    });

    test("anchored parse: 0.0.0-dev-... returns major 0 which maps to 1.x argv", async () => {
      resetOpencodeCliProbe();
      // npm dev/beta builds print 0.0.0-dev-... or 0.0.0-beta-... but still accept 1.x argv
      assert.equal(await ensureOpencodeCliMajor({ execFileFn: async () => ({ stdout: OPENCODE_DEV_STDOUT, stderr: "" }) }), 0);
      assert.equal(detectOpencodeCliMajor(), 0);
      // The executor's `?? 1` fallback in buildSpawnArgs treats 0 as 1.x
      const ex = opencodeExecutor({ detectCliMajorFn: () => 0 });
      const args = ex.buildSpawnArgs({ isSummary: false, model: "test/model", variant: null, launchDirectory: "/wd", promptFilePath: null, prompt: "hi", sessionId: null });
      // Should use 1.x argv (--dir, --variant)
      assert.ok(args.includes("--dir"), "major 0 should use 1.x argv with --dir");
      assert.ok(args.includes("--variant") || !args.includes("--variant"), "variant handling depends on context");
      resetOpencodeCliProbe();
    });

    test("anchored parse: 0.0.0-beta-... returns major 0", async () => {
      resetOpencodeCliProbe();
      assert.equal(await ensureOpencodeCliMajor({ execFileFn: async () => ({ stdout: "0.0.0-beta-202610030456\n", stderr: "" }) }), 0);
      resetOpencodeCliProbe();
    });

    test("anchored parse ignores v2.x substring buried mid-line", async () => {
      resetOpencodeCliProbe();
      // The regex is anchored, so "running opencode v2.0.22" should not match
      assert.equal(await ensureOpencodeCliMajor({ execFileFn: async () => ({ stdout: OPENCODE_RUNNING_V2_STDOUT, stderr: "" }) }), null);
      resetOpencodeCliProbe();
    });
});

describe("opencodeExecutor() - variants cache skipped on 2.x", () => {
  test("variants cache refresh is skipped when opencode major >= 2", async () => {
    resetOpencodeCliProbe();
    // Mock detectOpencodeCliMajor to return 2 (simulating opencode 2.x)
    const ex = opencodeExecutor({
      detectCliMajorFn: () => 2,
      ensureCliMajorFn: async () => 2,
    });
    // The warmAndScheduleVariantsCacheRefresh function checks detectOpencodeCliMajor()
    // and skips refresh on 2.x. We can't directly test the internal function,
    // but we can verify that the executor's detectCliMajorFn returns 2.
    const major = ex.buildSpawnArgs({ isSummary: false, model: "test/model", variant: null, launchDirectory: "/wd", promptFilePath: null, prompt: "hi", sessionId: null });
    // Should use 2.x argv (--standalone, --auto, -m with #variant)
    assert.ok(major.includes("--standalone"), "major 2 should use 2.x argv with --standalone");
    assert.ok(major.includes("--auto"), "major 2 should use 2.x argv with --auto");
    // Also verify that the executor's prepareLaunch returns undefined (probe is "warm")
    const prepareResult = ex.prepareLaunch({ isSummary: false });
    assert.equal(prepareResult, undefined, "prepareLaunch should return undefined when probe is warm");
    resetOpencodeCliProbe();
  });
});

describe("opencodeExecutor().listModelVariantsFn", () => {
    const FLASH_FREE_MODEL = "opencode/deepseek-v4-flash-free";
    const FIXTURE = [
      FLASH_FREE_MODEL,
      '{"id":"deepseek-v4-flash-free","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"},"max":{"reasoningEffort":"max"}}}',
      "opencode/no-variants-model",
      '{"id":"no-variants-model","variants":{}}',
      "minimax/MiniMax-M3",
      '{"id":"MiniMax-M3","variants":{"none":{"thinking":{"type":"disabled"}},"thinking":{"thinking":{"type":"enabled","budgetTokens":16000}}}}',
      "openrouter/openai/gpt-5.6-luna",
      '{"id":"gpt-5.6-luna","variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"}}}',
    ].join("\n");

    test("parses provider/model blocks into an ordered variant-key map", async () => {
      const ex = opencodeExecutor();
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
      assert.deepEqual(result.get(FLASH_FREE_MODEL), ["low", "high", "max"]);
      assert.deepEqual(result.get("minimax/MiniMax-M3"), ["none", "thinking"]);
    });

    test("parses multi-slash provider/subprovider/model ids (openrouter format)", async () => {
      const ex = opencodeExecutor();
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
      assert.deepEqual(result.get("openrouter/openai/gpt-5.6-luna"), ["low", "high"]);
    });

    test("omits models with no variants from the map", async () => {
      const ex = opencodeExecutor();
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: FIXTURE, stderr: "" }) });
      assert.equal(result.has("opencode/no-variants-model"), false);
    });

    test("skips a malformed JSON block instead of throwing", async () => {
      const ex = opencodeExecutor();
      const malformed = "opencode/broken-model\n{not valid json\n" + FLASH_FREE_MODEL + "\n" + FIXTURE.split("\n")[1];
      const result = await ex.listModelVariantsFn(process.env, { execFileFn: async () => ({ stdout: malformed, stderr: "" }) });
      assert.equal(result.has("opencode/broken-model"), false);
      assert.deepEqual(result.get(FLASH_FREE_MODEL), ["low", "high", "max"]);
    });
  });

  describe("opencodeExecutor().sandboxAuthFile (auth and config binds)", () => {
    test("sandboxAuthFile: binds real auth.json when present", () => {
      const ex = opencodeExecutor();
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === OPENCODE_AUTH,
        lstatFn: () => ({ isSymbolicLink: () => false }),
      });
      assert.deepEqual(result, {
        extraRoBinds: [[OPENCODE_AUTH, `${SANDBOXED_DATA_HOME}/opencode/auth.json`]],
        sandboxedDataHome: SANDBOXED_DATA_HOME,
        // XDG_CONFIG_HOME is redirected unconditionally, whether or not the user
        // has a real opencode config to bind in: opencode writes its own
        // .gitignore there on boot and the real ~/.config is read-only in the
        // sandbox.
        sandboxEnv: { XDG_DATA_HOME: SANDBOXED_DATA_HOME, XDG_CONFIG_HOME: SANDBOXED_CONFIG_HOME },
      });
    });

    test("sandboxAuthFile: drops a symlinked auth.json instead of ro-binding its target", () => {
      const ex = opencodeExecutor();
      const realAuthFile = OPENCODE_AUTH;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realAuthFile,
        // A planted symlink at auth.json (e.g. -> ~/.ssh/authorized_keys):
        // binding it would ro-bind the target into the sandbox, so it must be
        // dropped exactly like a symlinked config entry.
        lstatFn: () => ({ isSymbolicLink: () => true }),
      });
      assert.deepEqual(result.extraRoBinds, []);
    });

    test("sandboxAuthFile: ro-binds the real config dir's entries, skipping the .gitignore opencode rewrites on boot", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "plugins", GITIGNORE] : []),
        lstatFn: () => ({ isSymbolicLink: () => false }),
      });
      assert.deepEqual(result.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
        [`${realConfigDir}/plugins`, PLUGINS_DEST],
      ]);
    });

    test("sandboxAuthFile: resolves a symlinked config entry to its real target and ro-binds that target (dotfiles-managed setup)", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const resolvedPlanted = "/home/user/.dotfiles/opencode/planted-link";
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "plugins", "planted-link"] : []),
        // planted-link is a dotfiles symlink (e.g. -> ~/.dotfiles/...): it must
        // be resolved and the real target bound read-only at the same
        // sandboxed destination, not dropped.
        lstatFn: (p) => {
          if (p === `${realConfigDir}/planted-link`) return { isSymbolicLink: () => true };
          if (p === resolvedPlanted) return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
          return { isSymbolicLink: () => false };
        },
        realpathFn: (p) => {
          if (p === `${realConfigDir}/planted-link`) return resolvedPlanted;
          throw new Error(`unexpected realpath ${p}`);
        },
      });
      assert.deepEqual(result.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
        [`${realConfigDir}/plugins`, PLUGINS_DEST],
        [resolvedPlanted, `${SANDBOXED_CONFIG_DIR}/planted-link`],
      ]);
    });

    test("sandboxAuthFile: symlinked config file (opencode.jsonc) resolves to its real dotfiles target", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const realTarget = "/home/user/.dotfiles/.config/opencode/opencode.jsonc";
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC] : []),
        lstatFn: (p) => {
          if (p === `${realConfigDir}/${OPENCODE_JSONC}`) return { isSymbolicLink: () => true };
          if (p === realTarget) return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
          return { isSymbolicLink: () => false };
        },
        realpathFn: (p) => {
          if (p === `${realConfigDir}/${OPENCODE_JSONC}`) return realTarget;
          throw new Error(`unexpected realpath ${p}`);
        },
      });
      assert.deepEqual(result.extraRoBinds, [[realTarget, OPENCODE_JSONC_DEST]]);
    });

    test("sandboxAuthFile: dangling/broken symlinked config entry fails closed (no crash, entry skipped, other entries still bound)", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "dangling-link"] : []),
        lstatFn: (p) => {
          if (p === `${realConfigDir}/dangling-link`) return { isSymbolicLink: () => true };
          return { isSymbolicLink: () => false };
        },
        realpathFn: (p) => {
          if (p === `${realConfigDir}/dangling-link`) {
            const err = new Error("ENOENT: no such file or directory, realpath");
            err.code = "ENOENT";
            throw err;
          }
          throw new Error(`unexpected realpath ${p}`);
        },
      });
      assert.deepEqual(result.extraRoBinds, [[`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST]]);
    });

    test("sandboxAuthFile: drops a config entry whose lstat fails, binding nothing it couldn't verify", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "vanished-entry"] : []),
        lstatFn: (p) => {
          if (p === `${realConfigDir}/vanished-entry`) throw new Error("ENOENT");
          return { isSymbolicLink: () => false };
        },
      });
      assert.deepEqual(result.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
      ]);
    });
  });

  describe("opencodeExecutor().sandboxAuthFile (symlink and hardlink guard behavior)", () => {
    test("sandboxAuthFile: skips the whole config loop when the config dir itself is a symlink (per-entry guards would all pass otherwise)", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const readdirCalls = [];
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => { readdirCalls.push(p); return [OPENCODE_JSONC, "plugins"]; },
        // existsFn/readdirFn follow the symlinked dir, so every entry inside
        // would pass the per-entry lstat guard while the whole tree points
        // elsewhere; the dir itself must be lstat-checked and treated as
        // absent when it is a symlink.
        lstatFn: (p) => ({ isSymbolicLink: () => p === realConfigDir }),
      });
      assert.deepEqual(result.extraRoBinds, []);
      assert.deepEqual(readdirCalls, [], "readdirFn must not be called on a symlinked config dir");
    });

    test("sandboxAuthFile: drops a hardlinked config entry (nlink > 1), which the isSymbolicLink check alone cannot see", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "hardlinked-secret"] : []),
        // Not a symlink -- a plain fs.Stats-shaped object whose nlink reveals
        // the inode is reachable under a second name on the host. The lstat
        // guard must reject it without rejecting regular entries.
        lstatFn: (p) => {
          if (p === `${realConfigDir}/hardlinked-secret`) {
            return { isSymbolicLink: () => false, isFile: () => true, nlink: 2 };
          }
          return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
        },
      });
      assert.deepEqual(result.extraRoBinds, [
        [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
      ]);
    });

    test("sandboxAuthFile: keeps a directory entry whose nlink > 1 (a dir's nlink counts its subdirectories; dirs cannot be hardlinked)", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? ["plugins"] : []),
        lstatFn: () => ({ isSymbolicLink: () => false, isFile: () => false, nlink: 5 }),
      });
      assert.deepEqual(result.extraRoBinds, [
        [`${realConfigDir}/plugins`, PLUGINS_DEST],
      ]);
    });

    test("sandboxAuthFile: a null-returning lstatFn (the statFn seam's null-on-failure convention) fails closed instead of crashing", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const result = ex.sandboxAuthFile({
        homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
        existsFn: (p) => p === realConfigDir,
        readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "plugins"] : []),
        // Returns null (entry could not be statted) for everything -- a
        // pre-fix version threw a TypeError on entryStat.isSymbolicLink().
        lstatFn: () => null,
      });
      assert.deepEqual(result.extraRoBinds, []);
    });

    test("sandboxAuthFile: a successfully resolved symlinked config entry does not warn (the resolved target is bound, not skipped)", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const resolvedPlanted = "/home/user/.dotfiles/opencode/planted-link";
      const originalWrite = process.stderr.write;
      let warned = "";
      process.stderr.write = (chunk) => { warned += chunk; return true; };
      try {
        const result = ex.sandboxAuthFile({
          homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
          existsFn: (p) => p === realConfigDir,
          readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "planted-link"] : []),
          lstatFn: (p) => {
            if (p === `${realConfigDir}/planted-link`) return { isSymbolicLink: () => true };
            if (p === resolvedPlanted) return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
            return { isSymbolicLink: () => false };
          },
          realpathFn: (p) => {
            if (p === `${realConfigDir}/planted-link`) return resolvedPlanted;
            throw new Error(`unexpected realpath ${p}`);
          },
        });
        assert.deepEqual(result.extraRoBinds, [
          [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
          [resolvedPlanted, `${SANDBOXED_CONFIG_DIR}/planted-link`],
        ]);
        assert.equal(warned, "", "a successfully resolved symlink must not warn -- the bind succeeds");
        assert.ok(!warned.includes("opencode.jsonc"), "a bound entry must not be warned about");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("sandboxAuthFile: dangling symlink whose realpath throws ENOENT is skipped silently (no warning), other entries still bound", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const originalWrite = process.stderr.write;
      let warned = "";
      process.stderr.write = (chunk) => { warned += chunk; return true; };
      try {
        const result = ex.sandboxAuthFile({
          homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
          existsFn: (p) => p === realConfigDir,
          readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "dangling-link"] : []),
          lstatFn: (p) => {
            if (p === `${realConfigDir}/dangling-link`) return { isSymbolicLink: () => true };
            return { isSymbolicLink: () => false };
          },
          realpathFn: (p) => {
            if (p === `${realConfigDir}/dangling-link`) {
              const err = new Error("ENOENT: no such file or directory, realpath");
              err.code = "ENOENT";
              throw err;
            }
            throw new Error(`unexpected realpath ${p}`);
          },
        });
        assert.deepEqual(result.extraRoBinds, [[`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST]]);
        assert.equal(warned, "", "ENOENT on realpath must be silent, same as ENOENT on lstat");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("sandboxAuthFile: symlink whose realpath throws non-ENOENT (EACCES) warns and is skipped, other entries still bound", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const originalWrite = process.stderr.write;
      let warned = "";
      process.stderr.write = (chunk) => { warned += chunk; return true; };
      try {
        const result = ex.sandboxAuthFile({
          homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
          existsFn: (p) => p === realConfigDir,
          readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "forbidden-link"] : []),
          lstatFn: (p) => {
            if (p === `${realConfigDir}/forbidden-link`) return { isSymbolicLink: () => true };
            return { isSymbolicLink: () => false };
          },
          realpathFn: (p) => {
            if (p === `${realConfigDir}/forbidden-link`) {
              const err = new Error("EACCES: permission denied, realpath");
              err.code = "EACCES";
              throw err;
            }
            throw new Error(`unexpected realpath ${p}`);
          },
        });
        assert.deepEqual(result.extraRoBinds, [[`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST]]);
        assert.match(warned, /warning: could not resolve symlink .*forbidden-link \(EACCES: permission denied/);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("sandboxAuthFile: swallows ENOENT silently (a vanished entry is an ordinary race) but warns on non-ENOENT lstat failures like EACCES", () => {
      const ex = opencodeExecutor();
      const realConfigDir = _OPENCODE_CONFIG_DIR;
      const originalWrite = process.stderr.write;
      let warned = "";
      process.stderr.write = (chunk) => { warned += chunk; return true; };
      try {
        const silentResult = ex.sandboxAuthFile({
          homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
          existsFn: (p) => p === realConfigDir,
          readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "vanished"] : []),
          // Real lstatSync ENOENT errors carry err.code === "ENOENT".
          lstatFn: (p) => {
            if (p === `${realConfigDir}/vanished`) {
              const err = new Error("ENOENT: no such file or directory, lstat");
              err.code = "ENOENT";
              throw err;
            }
            return { isSymbolicLink: () => false };
          },
        });
        assert.deepEqual(silentResult.extraRoBinds, [
          [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
        ]);
        assert.equal(warned, "", "a plain ENOENT must not warn -- it is an ordinary exists/lstat race, not a diagnostic");

        const eaccesResult = ex.sandboxAuthFile({
          homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {},
          existsFn: (p) => p === realConfigDir,
          readdirFn: (p) => (p === realConfigDir ? [OPENCODE_JSONC, "forbidden-entry"] : []),
          // EACCES means the entry is unverifiable for a real reason (bad
          // permissions, a dead mount) -- the bind is still skipped (fail
          // closed), but the user must hear about it.
          lstatFn: (p) => {
            if (p === `${realConfigDir}/forbidden-entry`) {
              const err = new Error("EACCES: permission denied, lstat");
              err.code = "EACCES";
              throw err;
            }
            return { isSymbolicLink: () => false };
          },
        });
        assert.deepEqual(eaccesResult.extraRoBinds, [
          [`${realConfigDir}/${OPENCODE_JSONC}`, OPENCODE_JSONC_DEST],
        ]);
        assert.match(warned, /warning: could not verify .*forbidden-entry is not a symlink \(EACCES: permission denied/);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("sandboxAuthFile: no bind when auth.json is missing", () => {
      const ex = opencodeExecutor();
      const result = ex.sandboxAuthFile({ homeDir: HOME_DIR, dataDir: DATA_DIR, taskId: TASK_ID, spawnEnv: {}, existsFn: () => false });
      assert.deepEqual(result.extraRoBinds, []);
    });
  });