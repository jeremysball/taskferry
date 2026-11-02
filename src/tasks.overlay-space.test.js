import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fakeChild,
  makeFakeOpencodeExecutor,
  makeManager,
  mkdtempTracked,
  preserveEnvVars,
  waitFor,
} from "./tasks.test-helpers.js";

const MIB = 1024 * 1024;
const MODEL = "opencode/test-model";

/**
 * @param {{freeMiB: number, totalMiB?: number}} options
 */
function statfs({ freeMiB, totalMiB = 1024 }) {
  return { bsize: MIB, blocks: totalMiB, bfree: freeMiB, bavail: freeMiB };
}

function executor() {
  return makeFakeOpencodeExecutor({ buildSpawnArgs: () => ["run", "--format", "json"] });
}

function sandboxOptions() {
  return {
    sandboxEnabled: true,
    overlayEnabled: true,
    platform: "linux",
    checkBwrapAvailableFn: () => ({ checked: true, available: true }),
    checkOverlaySupportFn: () => ({ supported: true }),
  };
}

/**
 * @param {object} [overrides]
 */
function overlayManager(overrides = {}) {
  return makeManager({
    ...sandboxOptions(),
    defaultExecutor: executor(),
    statFn: () => ({ isDirectory: () => true }),
    ...overrides,
  });
}

test("dispatch refuses a low overlay filesystem before creating a task or output dir", () => {
  let spawned = false;
  const mgr = overlayManager({
    statfsFn: () => statfs({ freeMiB: 10 }),
    spawnFn: () => {
      spawned = true;
      throw new Error("spawn must not run past a rejected preflight");
    },
  });

  assert.throws(
    () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MODEL }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, "OVERLAY_SPACE_LOW");
      assert.match(err.message, /overlay storage is low/);
      return true;
    },
  );
  assert.equal(spawned, false);
  assert.equal(mgr.list().tasks, "none found (this server process's lifetime)");
  const outputs = path.join(mgr.paths.STATE_DIR, "outputs");
  assert.equal(fs.existsSync(outputs) && fs.readdirSync(outputs).length > 0, false);
});

test("--no-overlay skips the preflight and launches without an overlay", () => {
  const child = fakeChild(5150);
  let spawned = null;
  const mgr = overlayManager({
    statfsFn: () => statfs({ freeMiB: 1 }),
    spawnFn: (cmd, args) => {
      spawned = { cmd, args };
      return child;
    },
  });

  const task = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MODEL, noOverlay: true });
  assert.ok(spawned);
  assert.equal(mgr.status(task.id).status, "running");
  assert.equal(task.overlayDirs ?? null, null);
  child.stdout.emit("end");
  child.emit("exit", 0, null);
});

test("a whitespace-only TASKFERRY_OVERLAY_MIN_FREE_BYTES does not silently disable the preflight", (t) => {
  preserveEnvVars(t, ["TASKFERRY_OVERLAY_MIN_FREE_BYTES"]);
  process.env.TASKFERRY_OVERLAY_MIN_FREE_BYTES = "   ";
  let spawned = false;
  const mgr = overlayManager({
    statfsFn: () => statfs({ freeMiB: 10 }),
    spawnFn: () => {
      spawned = true;
      return fakeChild();
    },
  });

  assert.throws(
    () => mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MODEL }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, "OVERLAY_SPACE_LOW");
      return true;
    },
  );
  assert.equal(spawned, false);
});

test("a launch-time free-space drop crashes the task without spawning and the daemon survives", () => {
  let calls = 0;
  let spawned = false;
  const mgr = overlayManager({
    statfsFn: () => {
      calls++;
      return calls === 1 ? statfs({ freeMiB: 512 }) : statfs({ freeMiB: 1 });
    },
    spawnFn: () => {
      spawned = true;
      return fakeChild();
    },
  });

  const task = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MODEL });
  assert.equal(spawned, false);
  const status = mgr.status(task.id);
  assert.equal(status.status, "crashed");
  assert.equal(status.failureReason, "OVERLAY_SPACE_LOW");
  assert.match(status.spawnError, /overlay storage is low/);
});

test("a generic overlay mkdir failure still fails the task cleanly with the preflight disabled", () => {
  const dir = mkdtempTracked("overlay-space-bad-root-");
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "");
  const mgr = overlayManager({
    overlayTmpRoot: path.join(blocker, "overlay"),
    overlayMinFreeBytes: 0,
    statfsFn: () => {
      throw new Error("statfs must not run when the preflight is disabled");
    },
    spawnFn: () => {
      throw new Error("spawn must not run when overlay creation fails");
    },
  });

  const task = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MODEL });
  const status = mgr.status(task.id);
  assert.equal(status.status, "crashed");
  assert.match(status.spawnError, /ENOTDIR/);
});

test("a synchronous argv build failure fails the queued task instead of escaping the launch path", async () => {
  const mgr = overlayManager({
    statfsFn: () => statfs({ freeMiB: 512 }),
    defaultExecutor: makeFakeOpencodeExecutor({
      buildSpawnArgs: () => {
        throw new Error("buildSpawnArgs boom");
      },
    }),
    spawnFn: () => {
      throw new Error("spawn must not run when argv building fails");
    },
  });

  const task = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), model: MODEL });
  await waitFor(() => mgr.status(task.id).status === "crashed", "task did not crash after the argv throw");
  const status = mgr.status(task.id);
  assert.match(status.spawnError, /buildSpawnArgs boom/);
});
