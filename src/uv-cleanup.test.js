// Integration: a sandboxed dispatch creates uv dirs in the namespaced cache
// path and reaps them when the worker settles. A no-overlay sandboxed
// dispatch (the only path that bypasses releaseOverlayForTask) reaps them
// at child settlement. The sync spawn-failure path drains too.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createTaskManager, uvDirNamespace, uvDirPath } from "./tasks.js";
import {
  AXI_TASKS_TEST_DIR,
  AXI_TASKS_CACHE_DIR,
  fakeChild,
  mkdtempTracked,
  trackManager,
  TEST_DEFAULT_MODEL,
} from "./tasks.test-helpers.js";

function makeManagerWithTempDirs(overrides) {
  const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
  const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
  const mgr = trackManager(
    createTaskManager({
      stateDir,
      cacheDir,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      overlayEnabled: false,
      lowerdirStaggerMs: 0,
      resolveGitCommonDirFn: () => null,
      ...overrides,
    })
  );
  return { mgr, stateDir, cacheDir };
}

describe("uv dirs are registered on dispatch and reaped at settlement", () => {
  test("a no-overlay sandboxed dispatch registers both uv dirs and reaps them at child settlement", () => {
    let child = null;
    const { mgr, stateDir, cacheDir } = makeManagerWithTempDirs({
      spawnFn: () => { child = fakeChild(); return child; },
    });

    const dispatched = mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: TEST_DEFAULT_MODEL });
    const uvCacheDir = uvDirPath(cacheDir, stateDir, dispatched.id, "uv-cache");
    const uvToolsDir = uvDirPath(cacheDir, stateDir, dispatched.id, "uv-tools");
    // Namespaced under this daemon's own state dir, exactly one path deep.
    assert.equal(uvCacheDir.includes(uvDirNamespace(stateDir)), true);
    assert.equal(fs.existsSync(uvCacheDir), true);
    assert.equal(fs.existsSync(uvToolsDir), true);

    child.emit("exit", 0, null);

    assert.equal(fs.existsSync(uvCacheDir), false, "uv cache dir should be reaped at settlement");
    assert.equal(fs.existsSync(uvToolsDir), false, "uv tools dir should be reaped at settlement");
  });

  test("the sync spawn-failure path also drains the deferred list", async () => {
    // A synchronous throw from spawnFn (the most common sync failure)
    // lands in spawnTaskChild's catch block. Before this change that catch
    // block did not drain the deferred list, so every sandboxed dispatch
    // that crashed at spawn left its uv dirs on disk forever.
    const cacheDir = mkdtempTracked(AXI_TASKS_CACHE_DIR);
    const stateDir = mkdtempTracked(AXI_TASKS_TEST_DIR);
    const mgr = trackManager(createTaskManager({
      stateDir,
      cacheDir,
      sandboxEnabled: true,
      checkBwrapAvailableFn: () => ({ checked: true, available: true }),
      platform: "linux",
      overlayEnabled: false,
      lowerdirStaggerMs: 0,
      resolveGitCommonDirFn: () => null,
      spawnFn: () => { throw new Error("sandbox spawn ENOENT"); },
      killFn: () => {},
    }));

    const dispatched = mgr.dispatch({ prompt: "hello", directory: os.tmpdir(), model: TEST_DEFAULT_MODEL });
    const uvCacheDir = uvDirPath(cacheDir, stateDir, dispatched.id, "uv-cache");
    const uvToolsDir = uvDirPath(cacheDir, stateDir, dispatched.id, "uv-tools");
    // The dispatch returns before the launch-timer fires. Yield to the
    // event loop long enough for `spawnTaskChild` (which creates the dir,
    // then throws on spawnFn, then drains the deferred list) to complete.
    await new Promise((r) => setImmediate(r));
    assert.equal(mgr.status(dispatched.id).status, "crashed");

    mgr.flushPersist();

    assert.equal(fs.existsSync(uvCacheDir), false, "uv cache dir should be reaped on sync spawn failure");
    assert.equal(fs.existsSync(uvToolsDir), false, "uv tools dir should be reaped on sync spawn failure");
  });
});