import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { ensureOpencodeCliMajor, detectOpencodeCliMajor, resetOpencodeCliProbe } from "./opencode-version.js";
import { opencodeExecutor } from "./opencode-executor.js";
import { readVariantsCache, hashFingerprint, VARIANTS_CACHE_SCHEMA } from "./variants-cache.js";
import { makeManager, fakeChild, mkdtempTracked, waitForCaptured } from "./tasks.test-helpers.js";

const TTL_MS = 1000;
const V2_VERSION = "opencode v2.0.22";
const DISPATCH_CTX = { isSummary: false, model: "openai/gpt-x", variant: null, launchDirectory: "/work/dir", promptFilePath: null, prompt: "hi", sessionId: null };

/** @param {string} stdout */
function versionPrints(stdout) {
  let calls = 0;
  const execFileFn = async () => { calls += 1; return { stdout, stderr: "" }; };
  return { execFileFn: /** @type {any} */ (execFileFn), calls: () => calls };
}

/** Seed the module memo with `major` through a real (faked-exec) probe. @param {number} major */
async function seedMajor(major) {
  resetOpencodeCliProbe();
  await ensureOpencodeCliMajor({ execFileFn: versionPrints(`${major}.0.0`).execFileFn });
}

beforeEach(() => resetOpencodeCliProbe());

describe("ensureOpencodeCliMajor()", () => {
  for (const [stdout, major] of [[`${V2_VERSION}\n`, 2], ["1.18.29\n", 1], ["0.0.0-dev-202610030456\n", 0]]) {
    test(`parses ${JSON.stringify(stdout)} as major ${major}`, async () => {
      assert.equal(await ensureOpencodeCliMajor({ execFileFn: versionPrints(stdout).execFileFn }), major);
    });
  }

  test("unparseable output is unknown (null), never a guessed major", async () => {
    assert.equal(await ensureOpencodeCliMajor({ execFileFn: versionPrints("command not found: opencode").execFileFn }), null);
  });

  test("a failed probe is not cached: the next call probes again", async () => {
    let calls = 0;
    const execFileFn = /** @type {any} */ (async () => {
      calls += 1;
      if (calls === 1) throw new Error("spawn opencode ENOENT");
      return { stdout: V2_VERSION, stderr: "" };
    });
    assert.equal(await ensureOpencodeCliMajor({ execFileFn }), null);
    assert.equal(detectOpencodeCliMajor(), null);
    assert.equal(await ensureOpencodeCliMajor({ execFileFn }), 2);
    assert.equal(calls, 2);
  });

  test("a good probe is served from the memo inside the TTL and re-probed once it lapses", async () => {
    let t = 0;
    const now = () => t;
    const probe = versionPrints("1.18.29");
    const opts = { execFileFn: probe.execFileFn, ttlMs: TTL_MS, now };
    await ensureOpencodeCliMajor(opts);
    t = TTL_MS - 1;
    await ensureOpencodeCliMajor(opts);
    assert.equal(probe.calls(), 1);
    t = TTL_MS;
    await ensureOpencodeCliMajor(opts);
    assert.equal(probe.calls(), 2);
  });

  test("concurrent callers share one in-flight probe", async () => {
    const probe = versionPrints(V2_VERSION);
    const results = await Promise.all([1, 2, 3].map(() => ensureOpencodeCliMajor({ execFileFn: probe.execFileFn })));
    assert.deepEqual(results, [2, 2, 2]);
    assert.equal(probe.calls(), 1);
  });
});

describe("opencodeExecutor() version handling", () => {
  test("prepareLaunch rejects with a named error when the version is unknown, instead of guessing an argv", async () => {
    const ex = opencodeExecutor({ detectCliMajorFn: () => null, ensureCliMajorFn: async () => null });
    await assert.rejects(Promise.resolve(ex.prepareLaunch()), /opencode CLI major version could not be detected/);
  });

  test("an explicit variant replaces a #variant suffix already on the 2.x model id instead of appending a second one", () => {
    const args = opencodeExecutor({ detectCliMajorFn: () => 2 }).buildSpawnArgs({ ...DISPATCH_CTX, model: "openai/gpt-x#high", variant: "max" });
    assert.equal(args[args.indexOf("-m") + 1], "openai/gpt-x#max");
  });

  test("a 0.0.0-dev build (major 0) gets the 1.x argv, which those builds still accept", () => {
    const args = opencodeExecutor({ detectCliMajorFn: () => 0 }).buildSpawnArgs(DISPATCH_CTX);
    assert.ok(args.includes("--dir"), `expected the 1.x --dir flag in ${JSON.stringify(args)}`);
    assert.ok(!args.includes("--standalone"));
  });
});

describe("readVariantsCache() opencode major gating", () => {
  /** @param {string} cacheDir @param {Record<string, unknown>} extra */
  function readFixture(cacheDir, extra) {
    const body = JSON.stringify({ schema: VARIANTS_CACHE_SCHEMA, fingerprint: hashFingerprint({}), models: { "openai/gpt-x": ["high", "max"] }, ...extra });
    return readVariantsCache({ cacheDir, env: {}, statFn: () => ({ mtimeMs: Date.now() }), readFileFn: () => body });
  }

  test("a cache with no opencodeMajor field was built on 1.x and is not served on 2.x", async () => {
    await seedMajor(2);
    assert.equal(readFixture("/vc/legacy-on-2", {}), null);
  });

  test("a 1.x cache stays rejected on 2.x even after the 1.x read was memoized", async () => {
    const statMtime = Date.now();
    const body = JSON.stringify({ schema: VARIANTS_CACHE_SCHEMA, fingerprint: hashFingerprint({}), opencodeMajor: 1, models: { "openai/gpt-x": ["max"] } });
    const read = () => readVariantsCache({ cacheDir: "/vc/memo-upgrade", env: {}, statFn: () => ({ mtimeMs: statMtime }), readFileFn: () => body });
    await seedMajor(1);
    assert.notEqual(read(), null);
    await seedMajor(2);
    assert.equal(read(), null);
  });
});

describe("manager-level opencode 2.x", () => {
  test("an opencode dispatch on a pinned 2.x CLI spawns the 2.x run argv", async () => {
    let captured = null;
    const mgr = makeManager({
      opencodeCliMajorFn: () => 2,
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
    });
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode", model: "openai/gpt-x", variant: "max" });
    const args = await waitForCaptured(() => captured);
    assert.ok(args.includes("--standalone"), `expected --standalone in ${JSON.stringify(args)}`);
    assert.ok(!args.includes("--dir"));
    assert.equal(args[args.indexOf("-m") + 1], "openai/gpt-x#max");
  });

  for (const [major, expectRefresh] of [[2, false], [1, true]]) {
    test(`the boot variants refresh ${expectRefresh ? "runs" : "is skipped"} on a pinned ${major}.x CLI`, async () => {
      let refreshed = false;
      makeManager({
        opencodeCliMajorFn: () => major,
        cacheDir: mkdtempTracked("axi-tasks-variants-boot-"),
        opencodeListModelVariantsFn: async () => { refreshed = true; return new Map(); },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(refreshed, expectRefresh);
    });
  }
});
