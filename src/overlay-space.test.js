import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_OVERLAY_MIN_FREE_BYTES,
  OVERLAY_SPACE_LOW,
  OverlaySpaceError,
  assertOverlaySpace,
  checkOverlaySpace,
  formatBytes,
  formatOverlaySpaceError,
} from "./overlay-space.js";

const MIB = 1024 * 1024;
const OVERLAY_ROOT = "/tmp/overlay";

/**
 * @param {{freeMiB: number, totalMiB?: number}} options
 */
function statfs({ freeMiB, totalMiB = 1024 }) {
  return {
    bsize: MIB,
    blocks: totalMiB,
    bfree: freeMiB,
    bavail: freeMiB,
  };
}

test("checkOverlaySpace accepts a filesystem with more free space than the reserve", () => {
  const diagnostic = checkOverlaySpace({
    root: OVERLAY_ROOT,
    minFreeBytes: 256 * MIB,
    statfsFn: () => statfs({ freeMiB: 512 }),
    statFn: () => ({ isDirectory: () => true }),
  });

  assert.equal(diagnostic.checked, true);
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.freeBytes, 512 * MIB);
  assert.equal(diagnostic.totalBytes, 1024 * MIB);
  assert.equal(diagnostic.minFreeBytes, 256 * MIB);
  assert.equal(diagnostic.reason, undefined);
});

test("checkOverlaySpace refuses a filesystem below the reserve", () => {
  const diagnostic = checkOverlaySpace({
    root: OVERLAY_ROOT,
    minFreeBytes: 256 * MIB,
    statfsFn: () => statfs({ freeMiB: 100 }),
    statFn: () => ({ isDirectory: () => true }),
  });

  assert.equal(diagnostic.checked, true);
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.reason, "below-reserve");
  assert.match(formatOverlaySpaceError(diagnostic), /overlay storage is low/);
  assert.match(formatOverlaySpaceError(diagnostic), /100\.0 MiB free of 1\.0 GiB/);
  assert.match(formatOverlaySpaceError(diagnostic), /256\.0 MiB reserve/);
});

test("checkOverlaySpace caps the reserve at half of a small filesystem", () => {
  const options = {
    root: OVERLAY_ROOT,
    minFreeBytes: 256 * MIB,
    statfsFn: () => statfs({ freeMiB: 60, totalMiB: 100 }),
    statFn: () => ({ isDirectory: () => true }),
  };
  const accepted = checkOverlaySpace(options);
  assert.equal(accepted.minFreeBytes, 50 * MIB);
  assert.equal(accepted.ok, true);

  const refused = checkOverlaySpace({
    ...options,
    statfsFn: () => statfs({ freeMiB: 40, totalMiB: 100 }),
  });
  assert.equal(refused.minFreeBytes, 50 * MIB);
  assert.equal(refused.ok, false);
});

test("checkOverlaySpace measures the nearest existing ancestor when the root does not exist yet", () => {
  const root = path.join("/tmp", "taskferry-missing", "overlay");
  /** @type {string[]} */
  const statted = [];
  const diagnostic = checkOverlaySpace({
    root,
    minFreeBytes: 256 * MIB,
    statfsFn: (target) => {
      assert.equal(target, "/tmp");
      return statfs({ freeMiB: 512 });
    },
    statFn: (target) => {
      statted.push(target);
      return target === "/tmp" ? { isDirectory: () => true } : null;
    },
  });

  assert.equal(diagnostic.checked, true);
  assert.equal(diagnostic.checkedPath, "/tmp");
  assert.equal(diagnostic.root, root);
  assert.deepEqual(statted, [root, path.dirname(root), "/tmp"]);
});

test("checkOverlaySpace is disabled by a zero reserve without calling statfs", () => {
  let called = false;
  const diagnostic = checkOverlaySpace({
    root: OVERLAY_ROOT,
    minFreeBytes: 0,
    statfsFn: () => {
      called = true;
      return statfs({ freeMiB: 1 });
    },
  });

  assert.equal(called, false);
  assert.equal(diagnostic.checked, false);
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.reason, "disabled");
  assert.equal(diagnostic.minFreeBytes, 0);
});

test("checkOverlaySpace fails open when statfs is unavailable or throws", () => {
  const unavailable = checkOverlaySpace({
    root: OVERLAY_ROOT,
    statfsFn: /** @type {any} */ (null),
    statFn: () => ({ isDirectory: () => true }),
  });
  assert.equal(unavailable.checked, false);
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.reason, "statfs-unavailable");

  const thrown = checkOverlaySpace({
    root: OVERLAY_ROOT,
    statfsFn: () => {
      throw new Error("ENOSYS");
    },
    statFn: () => ({ isDirectory: () => true }),
  });
  assert.equal(thrown.checked, false);
  assert.equal(thrown.ok, true);
  assert.equal(thrown.reason, "statfs-failed");
  assert.equal(thrown.error, "ENOSYS");
});

test("assertOverlaySpace throws a typed error carrying the diagnostic", () => {
  assert.throws(
    () => assertOverlaySpace({
      root: OVERLAY_ROOT,
      minFreeBytes: 256 * MIB,
      statfsFn: () => statfs({ freeMiB: 1 }),
      statFn: () => ({ isDirectory: () => true }),
    }),
    (err) => {
      assert.ok(err instanceof OverlaySpaceError);
      assert.equal(err.code, OVERLAY_SPACE_LOW);
      assert.equal(err.diagnostic.freeBytes, MIB);
      return true;
    },
  );
});

test("formatBytes uses binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(DEFAULT_OVERLAY_MIN_FREE_BYTES), "256.0 MiB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GiB");
  assert.equal(formatBytes(Number.NaN), "unknown");
});
