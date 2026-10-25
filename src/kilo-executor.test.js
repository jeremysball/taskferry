import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { kiloExecutor } from "./kilo-executor.js";
import { KNOWN_EXECUTORS, resolveExecutor } from "./executor.js";
import { PROMPT_FILE_INSTRUCTION } from "./executor-shared.js";

const MODEL = "llmgateway/glm-5.3-flash";
const HOME_DIR = "/home/user";
const DATA_DIR = "/state/run";
const TASK_ID = "kilo_task1";
const SANDBOXED_DATA_HOME = `${DATA_DIR}/kilo-data/${TASK_ID}`;
const SANDBOXED_CONFIG_HOME = `${SANDBOXED_DATA_HOME}/config`;
const SANDBOXED_CONFIG_DIR = `${SANDBOXED_CONFIG_HOME}/kilo`;
const PROMPT_FILE = "/state/prompts/t1.prompt.txt";
const DISPATCH_PROMPT = "do the thing";
const KILO_CONFIG_DIR = "/home/user/.config/kilo";
const KILO_CONFIG_NAME = "kilo.jsonc";
const KILO_CONFIG_FILE = `${KILO_CONFIG_DIR}/${KILO_CONFIG_NAME}`;
const KILO_TOKEN_FILE = "/home/user/.kilocode/cli/config.json";
const TWO_STEP_SESSION = "ses_two_step";
const STEP_FINISH_PART_TYPE = "step-finish";

// A real `kilo run --format json` capture (2026-10-19, kilo 7.8.12, one
// step on llmgateway/glm-5.3-flash). The shared log parser in tasks.js reads
// `text` events for the narration and `step_finish` events for the tokens
// and the cost, so kilo's stream has to carry those fields with those names.
// A kilo release that renames them breaks every kilo dispatch's reported
// usage, so the shape is pinned here.
const KILO_EVENT_STREAM = [
  JSON.stringify({
    type: "step_start",
    timestamp: 1792439025354,
    sessionID: "ses_eaa4f1f5effestLnT4ZOBLoq55",
    part: { id: "prt_1", sessionID: "ses_eaa4f1f5effestLnT4ZOBLoq55", messageID: "msg_1", type: "step-start" },
  }),
  JSON.stringify({
    type: "text",
    timestamp: 1792439025354,
    sessionID: "ses_eaa4f1f5effestLnT4ZOBLoq55",
    part: { id: "prt_2", sessionID: "ses_eaa4f1f5effestLnT4ZOBLoq55", messageID: "msg_1", type: "text", text: "OK", time: { start: 1792439025323, end: 1792439025327 } },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: 1792439025354,
    sessionID: "ses_eaa4f1f5effestLnT4ZOBLoq55",
    part: {
      id: "prt_3",
      sessionID: "ses_eaa4f1f5effestLnT4ZOBLoq55",
      messageID: "msg_1",
      type: STEP_FINISH_PART_TYPE,
      reason: "stop",
      cost: 0.00430876,
      tokens: { total: 47740, input: 47676, output: 2, reasoning: 62, cache: { read: 0, write: 0 } },
    },
  }),
].join("\n");


// A real two-step `kilo run --format json` capture (2026-10-19, kilo
// 7.8.12, llmgateway/glm-5.3-flash, one shell tool call). Step one reports
// the whole prompt as input with no cache read; step two reports 285 input
// tokens and reads 17664 back from the cache. So a step's usage is that
// request's, not a running total, and a step's context is its input plus its
// cache read plus its cache write.
const KILO_TWO_STEP_STREAM = [
  JSON.stringify({
    type: "step_finish",
    timestamp: 1792441000000,
    sessionID: TWO_STEP_SESSION,
    part: {
      id: "prt_t1",
      sessionID: TWO_STEP_SESSION,
      messageID: "msg_t1",
      type: STEP_FINISH_PART_TYPE,
      reason: "tool-calls",
      cost: 0.00160157,
      tokens: { total: 17631, input: 17621, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: 1792441005000,
    sessionID: TWO_STEP_SESSION,
    part: {
      id: "prt_t2",
      sessionID: TWO_STEP_SESSION,
      messageID: "msg_t2",
      type: STEP_FINISH_PART_TYPE,
      reason: "stop",
      cost: 0.00038397,
      tokens: { total: 17952, input: 285, output: 3, reasoning: 0, cache: { read: 17664, write: 0 } },
    },
  }),
].join("\n");

describe("kiloExecutor()", () => {
  test("identity", () => {
    const ex = kiloExecutor();
    assert.equal(ex.id, "kilo");
    assert.equal(ex.taskIdPrefix, "kilo");
    assert.equal(ex.errorBucketPrefix, "kilo");
    assert.equal(ex.binaryName, "kilo");
  });

  test("buildSpawnArgs: plain dispatch", () => {
    const ex = kiloExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: null,
    });
    assert.deepEqual(args, ["run", "--auto", "--format", "json", "--model", MODEL, "--", DISPATCH_PROMPT]);
  });

  test("buildSpawnArgs: prompt file is attached, not inlined", () => {
    const ex = kiloExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: PROMPT_FILE, prompt: "ignored", sessionId: null,
    });
    assert.ok(args.includes("-f"), "the prompt file is attached with -f");
    assert.ok(args.includes(PROMPT_FILE), "the prompt file path is passed");
    assert.ok(args.includes(PROMPT_FILE_INSTRUCTION), "the attachment instruction is the message");
    assert.ok(!args.includes("ignored"), "the inline prompt is not sent when a file carries it");
  });

  test("buildSpawnArgs: session resume, variant, and executor args", () => {
    const ex = kiloExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: false, model: MODEL, variant: "high",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: DISPATCH_PROMPT, sessionId: "ses_1",
      executorArgs: ["--pure"],
    });
    assert.ok(args.includes("--session"));
    assert.ok(args.includes("ses_1"));
    assert.ok(args.includes("--variant"));
    assert.ok(args.includes("high"));
    assert.ok(args.includes("--pure"));
  });

  test("buildSpawnArgs: a summary run drops the variant and the executor args", () => {
    const ex = kiloExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: true, model: MODEL, variant: "high",
      launchDirectory: "/work/dir", promptFilePath: null, prompt: "ignored", sessionId: null,
      executorArgs: ["--pure"],
    });
    assert.ok(!args.includes("--variant"), "a summary run does not pin an effort level");
    assert.ok(!args.includes("--pure"), "a summary run does not inherit the dispatch's executor args");
    assert.ok(args.includes(ex.buildSummaryPrompt()));
  });

  test("buildSpawnArgs: a summary run attaches the session snapshot", () => {
    const ex = kiloExecutor();
    const args = ex.buildSpawnArgs({
      isSummary: true, model: MODEL, variant: null,
      launchDirectory: "/work/dir", promptFilePath: null, prompt: "ignored", sessionId: null,
      snapshotPath: "/state/summaries/s1.json",
    });
    assert.ok(args.includes("-f"), "the snapshot is attached with -f");
    assert.ok(args.includes("/state/summaries/s1.json"), "the snapshot path is passed");
    assert.ok(args.includes(ex.buildSummaryPrompt()), "the isolation prompt is the message");
  });

test("kilo reports each step's own usage, so a context is measured per step", () => {
    const steps = KILO_TWO_STEP_STREAM.split("\n").map((line) => JSON.parse(line));
    assert.equal(steps.length, 2, "the fixture has two steps");
    const [first, second] = steps.map((s) => s.part.tokens);
    assert.equal(first.cache.read, 0, "the first step read nothing from the cache");
    assert.ok(first.input > 10000, "the first step carried the whole prompt as input");
    assert.equal(second.input, 285, "the second step's input is small");
    assert.equal(second.cache.read, 17664, "the second step read the prompt back from the cache");
    // The context of the last step is its input plus its cache read, which is
    // about the size of the first step's prompt. The sum of both steps is the
    // billed total, and it is a different number from the context.
    const lastContext = second.input + second.cache.read + second.cache.write;
    const billedTotal = first.input + first.cache.read + first.cache.write + second.input + second.cache.read + second.cache.write;
    assert.ok(lastContext < billedTotal, `the context (${lastContext}) is not the billed total (${billedTotal})`);
    assert.ok(Math.abs(lastContext - first.input) < 1000, "the last step's context matches the first step's prompt size");
  });

  test("normalizeLogEvent is the identity: kilo's stream is opencode-shaped", () => {
    const ex = kiloExecutor();
    const parsed = { sessionId: null, tokens: null, cost: null };
    assert.equal(ex.normalizeLogEvent(parsed), parsed);
  });

  test("kilo's event stream carries the fields the shared log parser reads", () => {
    const events = KILO_EVENT_STREAM.split("\n").map((line) => JSON.parse(line));
    const text = events.find((e) => e.type === "text");
    const finish = events.find((e) => e.type === "step_finish");
    assert.ok(text, "the stream has a text event");
    assert.equal(typeof text.part.text, "string");
    assert.equal(typeof text.part.messageID, "string");
    assert.ok(finish, "the stream has a step_finish event");
    assert.equal(finish.part.reason, "stop");
    assert.equal(typeof finish.part.cost, "number");
    assert.equal(typeof finish.part.tokens.input, "number");
    assert.equal(typeof finish.part.tokens.output, "number");
    assert.equal(typeof finish.part.tokens.cache.read, "number");
    assert.equal(typeof finish.part.tokens.cache.write, "number");
    assert.equal(typeof events[0].sessionID, "string");
  });

  test("sandboxAuthFile: config entries and the gateway token are bound read-only", () => {
    const ex = kiloExecutor();
    const binds = [];
    const res = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      taskId: TASK_ID,
      spawnEnv: { XDG_CONFIG_HOME: "/home/user/.config" },
      existsFn: (p) => [KILO_CONFIG_DIR, KILO_CONFIG_FILE, KILO_TOKEN_FILE].includes(p),
      lstatFn: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
      readdirFn: () => [KILO_CONFIG_NAME, "tui.json", ".gitignore"],
      realpathFn: (p) => p,
    });
    assert.equal(res.sandboxedDataHome, SANDBOXED_DATA_HOME);
    assert.deepEqual(res.sandboxEnv, {
      XDG_DATA_HOME: SANDBOXED_DATA_HOME,
      XDG_STATE_HOME: `${SANDBOXED_DATA_HOME}/state`,
      XDG_CACHE_HOME: `${SANDBOXED_DATA_HOME}/cache`,
      XDG_CONFIG_HOME: SANDBOXED_CONFIG_HOME,
    });
    for (const [src, dest] of res.extraRoBinds) binds.push(`${src} -> ${dest}`);
    assert.ok(
      binds.includes(`${KILO_CONFIG_FILE} -> ${SANDBOXED_CONFIG_DIR}/kilo.jsonc`),
      `the fleet kilo config is bound into the sandbox, got: ${binds.join(" | ")}`,
    );
    assert.ok(
      binds.includes(`${KILO_TOKEN_FILE} -> ${KILO_TOKEN_FILE}`),
      "the kilo gateway token is bound at its own path",
    );
    assert.ok(
      !binds.some((b) => b.includes(".gitignore")),
      `the config directory's .gitignore is not bound into the sandbox, got: ${binds.join(" | ")}`,
    );
  });

  test("sandboxAuthFile: a symlinked config entry resolves to its target", () => {
    const ex = kiloExecutor();
    const res = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      taskId: TASK_ID,
      spawnEnv: {},
      existsFn: (p) => p === KILO_CONFIG_DIR || p === KILO_CONFIG_FILE,
      lstatFn: (p) => {
        if (p === KILO_CONFIG_FILE) return { isSymbolicLink: () => true };
        if (p === KILO_CONFIG_DIR) return { isSymbolicLink: () => false, isDirectory: () => true };
        return { isSymbolicLink: () => false, isFile: () => true, nlink: 1 };
      },
      readdirFn: () => [KILO_CONFIG_NAME],
      realpathFn: () => "/home/user/.dotfiles/.config/kilo/kilo.jsonc",
    });
    const sources = res.extraRoBinds.map(([src]) => src);
    assert.ok(
      sources.includes("/home/user/.dotfiles/.config/kilo/kilo.jsonc"),
      `a dotfiles-managed symlink resolves to its target, got: ${sources.join(" | ")}`,
    );
  });

  test("sandboxAuthFile: does not auto-bind the global instructions files (AGENTS.md, CLAUDE.md), and reports instructionsDest for an explicit --ro-bind mapping", () => {
    const ex = kiloExecutor();
    const res = ex.sandboxAuthFile({
      homeDir: HOME_DIR,
      dataDir: DATA_DIR,
      taskId: TASK_ID,
      spawnEnv: {},
      existsFn: (p) => p === KILO_CONFIG_DIR,
      lstatFn: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
      readdirFn: () => [KILO_CONFIG_NAME, "AGENTS.md", "CLAUDE.md", "tui.json"],
      realpathFn: (p) => p,
    });
    assert.deepEqual(res.extraRoBinds.map(([, dest]) => dest), [
      `${SANDBOXED_CONFIG_DIR}/kilo.jsonc`,
      `${SANDBOXED_CONFIG_DIR}/tui.json`,
    ]);
    assert.equal(res.instructionsDest, `${SANDBOXED_CONFIG_DIR}/AGENTS.md`);
  });

  test("the executor registry knows kilo", () => {
    assert.ok(KNOWN_EXECUTORS.includes("kilo"));
    assert.equal(resolveExecutor("kilo").id, "kilo");
  });
});

describe("kilo provider auth mapping", () => {
  for (const xdgDataHome of [undefined, "/custom/share"]) {
    test(`sandboxAuthFile: maps provider auth from ${xdgDataHome || "the default data home"}`, () => {
      const dataHome = xdgDataHome || `${HOME_DIR}/.local/share`;
      const authFile = `${dataHome}/kilo/auth.json`;
      const res = kiloExecutor().sandboxAuthFile({
        homeDir: HOME_DIR,
        dataDir: DATA_DIR,
        taskId: TASK_ID,
        spawnEnv: { XDG_DATA_HOME: xdgDataHome },
        existsFn: (p) => p === authFile,
        lstatFn: () => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1 }),
        readdirFn: () => [],
      });
      assert.deepEqual(res.extraRoBinds, [[authFile, `${SANDBOXED_DATA_HOME}/kilo/auth.json`]]);
      assert.equal(res.sandboxEnv.XDG_DATA_HOME, SANDBOXED_DATA_HOME);
      assert.equal(res.instructionsDest, `${SANDBOXED_CONFIG_DIR}/AGENTS.md`);
    });
  }

  for (const kind of ["missing", "symlink", "hardlink", "unreadable"]) {
    test(`sandboxAuthFile: skips provider auth when ${kind}`, () => {
      const authFile = `${HOME_DIR}/.local/share/kilo/auth.json`;
      let checkUnsafe = false;
      const args = {
        homeDir: HOME_DIR,
        dataDir: DATA_DIR,
        taskId: TASK_ID,
        spawnEnv: {},
        existsFn: (p) => p === authFile && (!checkUnsafe || kind !== "missing"),
        lstatFn: () => {
          if (checkUnsafe && kind === "unreadable") throw new Error("EACCES");
          return { isSymbolicLink: () => checkUnsafe && kind === "symlink", isFile: () => true, nlink: checkUnsafe && kind === "hardlink" ? 2 : 1 };
        },
        readdirFn: () => [],
      };
      const ex = kiloExecutor();
      assert.deepEqual(ex.sandboxAuthFile(args).extraRoBinds, [[authFile, `${SANDBOXED_DATA_HOME}/kilo/auth.json`]]);
      checkUnsafe = true;
      assert.deepEqual(ex.sandboxAuthFile(args).extraRoBinds, []);
    });
  }
});
