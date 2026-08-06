import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock, withFileLockAsync } from "./state-lock.js";

const trackedTmpDirs = [];
after(() => {
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


function tmpLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-lock-test-"));
  trackedTmpDirs.push(dir);
  return path.join(dir, "state.lock");
}

describe("withFileLock()", () => {
  test("runs fn and removes the lock file afterward", () => {
    const lockPath = tmpLockPath();
    const result = withFileLock(lockPath, () => 42);
    assert.equal(result, 42);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("removes the lock file even if fn throws, and rethrows", () => {
    const lockPath = tmpLockPath();
    assert.throws(() => withFileLock(lockPath, () => { throw new Error("boom"); }), /boom/);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("reclaims a stale lock file and proceeds", () => {
    const lockPath = tmpLockPath();
    fs.writeFileSync(lockPath, "");
    const oldMs = Date.now() / 1000 - 3600;
    fs.utimesSync(lockPath, oldMs, oldMs);
    const result = withFileLock(lockPath, () => "ran", { staleMs: 100, retryMs: 10, timeoutMs: 500 });
    assert.equal(result, "ran");
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("throws a structured timeout error when a fresh lock file is never released", () => {
    const lockPath = tmpLockPath();
    fs.writeFileSync(lockPath, "");
    assert.throws(
      () => withFileLock(lockPath, () => "unreachable", { staleMs: 60000, retryMs: 10, timeoutMs: 60 }),
      /error: timed out waiting for lock/
    );
    fs.unlinkSync(lockPath); // test-owned cleanup; withFileLock never acquired it
  });

  test("does not remove a lock file that was replaced by another owner", () => {
    const lockPath = tmpLockPath();

    withFileLock(lockPath, () => {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, "replacement-owner", { mode: 0o600 });
    });

    assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement-owner");
    fs.unlinkSync(lockPath);
  });
});

// Note: a genuine same-process *concurrent* contention test isn't feasible
// here -- acquireLock()'s retry loop blocks the JS thread synchronously via
// Atomics.wait with no yield back to the event loop, so a second same-
// process caller contending on a lock held across an async gap starves the
// very continuation that would release it (a same-process-only artifact;
// each real daemon-spawn race is a separate OS process with its own event
// loop, so this doesn't arise in production). These tests instead cover the
// async-fn contract directly: acquire/await/release around a real await
// point, and correctness across sequential (non-contending) calls.
describe("withFileLockAsync()", () => {
  test("awaits fn, releases the lock file afterward, and returns its resolved value", async () => {
    const lockPath = tmpLockPath();
    const result = await withFileLockAsync(lockPath, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("removes the lock file even if the async fn rejects, and rethrows", async () => {
    const lockPath = tmpLockPath();
    await assert.rejects(
      () => withFileLockAsync(lockPath, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(fs.existsSync(lockPath), false);
  });

  test("two sequential calls on the same lock path both succeed", async () => {
    const lockPath = tmpLockPath();
    const first = await withFileLockAsync(lockPath, async () => "first");
    const second = await withFileLockAsync(lockPath, async () => "second");
    assert.equal(first, "first");
    assert.equal(second, "second");
    assert.equal(fs.existsSync(lockPath), false);
  });
});
