import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskManager } from "./tasks.js";
import { resolveExecutor } from "./executor.js";
import { ensureOpencodeCliMajor, resetOpencodeCliProbe } from "./opencode-version.js";
import { trackManager, makeManager, fakeChild, LUNA_MODEL, mkdtempTracked, AXI_TASKS_TEST_DIR, AXI_TASKS_CACHE_DIR, AXI_TASKS_OVERLAY_DIR, pinOpencodeCliMajor, waitFor } from "./tasks.test-helpers.js";

describe("opencode variants cache warm-up", () => {
  beforeEach(async () => {
    resetOpencodeCliProbe();
    await ensureOpencodeCliMajor({ execFileFn: async () => ({ stdout: "1.0.0" }) });
  });

  test("non-opencode managers defer catalog discovery until an opencode dispatch needs it", async () => {
    let listed = 0;
    const mgr = makeManager({
      defaultExecutor: resolveExecutor("pi"),
      opencodeListModelVariantsFn: async () => { listed++; return new Map([[LUNA_MODEL, ["high"]]]); },
    });
    await new Promise(resolve => setImmediate(resolve));
    const beforeDispatch = listed;
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listed, 1, "an opencode override must start catalog discovery");
    assert.equal(beforeDispatch, 0, "pi-only startup must not discover an opencode catalog");
    mgr.dispatch({ prompt: "again", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listed, 1, "repeated dispatches must share the existing refresh schedule");
  });

  test("2.x warm-up caches the catalog and dispatch defaults to #max", async (t) => {
    t.after(() => pinOpencodeCliMajor());
    resetOpencodeCliProbe();
    await ensureOpencodeCliMajor({ execFileFn: async () => ({ stdout: "2.1.3" }) });
    pinOpencodeCliMajor(() => 2);
    let captured;
    let listedMajor;
    const mgr = makeManager({
      defaultExecutor: resolveExecutor("opencode"),
      opencodeCliMajorFn: () => 2,
      opencodeListModelVariantsFn: async (_env, options) => {
        listedMajor = options.major;
        return new Map([[LUNA_MODEL, ["none", "high", "max"]]]);
      },
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listedMajor, 2, "2.x startup must refresh the catalog");
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured[captured.indexOf("-m") + 1], `${LUNA_MODEL}#max`);
  });

  test("createTaskManager refreshes a stale cache through the opencode discovery seam", async () => {
    let called = 0;
    trackManager(createTaskManager({
      defaultExecutor: resolveExecutor("opencode"),
      stateDir: mkdtempTracked(AXI_TASKS_TEST_DIR),
      cacheDir: mkdtempTracked(AXI_TASKS_CACHE_DIR),
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: () => fakeChild(),
      killFn: () => {},
      listModelsFn: async () => "",
      opencodeListModelVariantsFn: async () => { called++; return new Map(); },
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(called, 1);
  });

  test("warm-up fingerprints envFileVars just like dispatch when choosing the highest variant", async () => {
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const cacheFile = path.join(cacheDir, "opencode-variants.json");
    let captured;
    const mgr = trackManager(createTaskManager({
      cacheDir,
      defaultExecutor: resolveExecutor("opencode"),
      stateDir: mkdtempTracked(AXI_TASKS_TEST_DIR),
      sandboxEnabled: false,
      overlayEnabled: false,
      overlayTmpRoot: mkdtempTracked(AXI_TASKS_OVERLAY_DIR),
      lowerdirStaggerMs: 0,
      spawnFn: (_cmd, args) => { captured = args; return fakeChild(); },
      killFn: () => {},
      envFileVars: { FAKE_TF_TEST_API_KEY: "from-env-file" },
      opencodeListModelVariantsFn: async () => new Map([[LUNA_MODEL, ["low", "high", "max"]]]),
    }));
    await waitFor(() => fs.existsSync(cacheFile), "warm should write the variants cache");
    mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: LUNA_MODEL, executor: "opencode" });
    assert.equal(captured[captured.indexOf("--variant") + 1], "max");
  });
});
