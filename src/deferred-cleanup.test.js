/* eslint-disable sonarjs/no-duplicate-string, sonarjs/no-built-in-override, sonarjs/shorthand-property-grouping */
// Deferred file cleanup: paths registered against a task and reaped when the
// ferry settles, rather than when its child process exits. The distinction
// is the whole feature -- see src/deferred-cleanup.js for why child exit
// is too early and an in-process closure is too fragile.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeferredCleanupReapable, registerDeferredCleanup, runDeferredCleanup, confinePath } from "./deferred-cleanup.js";
import { sweepDeferredCleanupFor, sweepOrphanedUvDirsFor, uvDirNamespace, uvDirPath, uvDirRootsFor } from "./tasks.js";

const A = "/tmp/deferred-a";
const B = "/tmp/deferred-b";
const FAKE_CACHE = "/tmp/fake-cache-uv";
const SETTLED = "settled";
const UNKNOWN = "unknown";
const OTHER_DAEMON = "other-daemon";
// A and B both live directly under /tmp, so it is the root every drain in
// the runDeferredCleanup block below confines to.
const ROOTS = [path.dirname(A)];

describe("registerDeferredCleanup", () => {
  test("creates the list lazily and dedupes repeat registrations", () => {
    const task = {};
    registerDeferredCleanup(task, A, B);
    registerDeferredCleanup(task, A);
    assert.deepEqual(task.deferredCleanup, [A, B]);
  });

  test("rejects a relative path rather than storing something rm -rf will resolve against cwd", () => {
    const task = {};
    assert.throws(() => registerDeferredCleanup(task, "relative/dir"), /must be absolute/);
    assert.equal(task.deferredCleanup, undefined);
  });
});

describe("runDeferredCleanup", () => {
  test("removes every registered path and clears the list", () => {
    const removed = [];
    const task = {};
    registerDeferredCleanup(task, A, B);
    const result = runDeferredCleanup(task, { rmFn: (target) => removed.push(target), allowedRoots: ROOTS });
    assert.deepEqual(removed, [A, B]);
    assert.deepEqual(result.removed, [A, B]);
    assert.equal(task.deferredCleanup, undefined);
  });

  test("keeps a failed path on the list so a later drain retries it", () => {
    const task = {};
    registerDeferredCleanup(task, A, B);
    const result = runDeferredCleanup(task, {
      rmFn: (target) => { if (target === A) throw new Error("EBUSY: device or resource busy"); },
      allowedRoots: ROOTS,
    });
    assert.deepEqual(task.deferredCleanup, [A]);
    assert.deepEqual(result.removed, [B]);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /EBUSY/);

    runDeferredCleanup(task, { rmFn: () => {}, allowedRoots: ROOTS });
    assert.equal(task.deferredCleanup, undefined);
  });

  test("counts an already-missing path as removed", () => {
    const task = {};
    registerDeferredCleanup(task, A);
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    const result = runDeferredCleanup(task, { rmFn: () => { throw enoent; }, allowedRoots: ROOTS });
    assert.deepEqual(result.removed, [A]);
    assert.equal(task.deferredCleanup, undefined);
  });

  test("drops a malformed entry instead of retrying it forever", () => {
    // tasks.json is a plain file an operator can hand-edit, and this
    // function calls rm -rf on what it finds there.
    const task = { deferredCleanup: ["not/absolute", 42] };
    const result = runDeferredCleanup(task, { rmFn: () => { throw new Error("must not be called"); }, allowedRoots: ROOTS });
    assert.equal(result.removed.length, 0);
    assert.equal(result.refused.length, 2);
    assert.equal(task.deferredCleanup, undefined);
  });

  test("is a no-op on a task that never registered anything", () => {
    const task = { id: "t1" };
    const result = runDeferredCleanup(task, { rmFn: () => { throw new Error("must not be called"); }, allowedRoots: ROOTS });
    assert.deepEqual(result, { removed: [], failed: [], refused: [] });
    assert.equal("deferredCleanup" in task, false);
  });

  test("refuses and drops a path outside the allowed roots", () => {
    const task = {};
    registerDeferredCleanup(task, A, "/etc/passwd");
    const removed = [];
    const result = runDeferredCleanup(task, {
      rmFn: (target) => { removed.push(target); },
      allowedRoots: [path.dirname(A)],
    });
    assert.deepEqual(result.refused.map((r) => r.path), ["/etc/passwd"]);
    assert.deepEqual(removed, [A]);
    assert.equal(task.deferredCleanup, undefined);
  });
});

describe("confinePath", () => {
  test("accepts an inner path and drops the root itself", () => {
    const root = "/tmp/confine-root";
    const inside = path.join(root, "deep", "x");
    assert.equal(confinePath(inside, [root]).ok, true);
    assert.equal(confinePath(root, [root]).ok, false);
  });

  test("refuses .. traversal", () => {
    const root = "/tmp/confine-root";
    const escape = path.join(root, "..", "etc", "passwd");
    const verdict = confinePath(escape, [root]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /not strictly inside/);
  });

  test("refuses a relative path", () => {
    const verdict = confinePath("./relative", ["/tmp/x"]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /absolute/);
  });

  test("treats a missing path lexically (tmpfs reboot case)", () => {
    const missing = path.join("/tmp", `nonexistent-${Date.now()}`, "deep");
    const root = path.dirname(missing);
    assert.equal(confinePath(missing, [root]).ok, true);
  });
});

describe("confinement fails closed", () => {
  test("a drain with no allowed roots refuses everything and leaves the list for a configured drain", () => {
    const task = {};
    registerDeferredCleanup(task, A, B);
    for (const allowedRoots of [undefined, []]) {
      const result = runDeferredCleanup(task, { rmFn: () => { throw new Error("must not be called"); }, allowedRoots });
      assert.deepEqual(result.refused.map((r) => r.path), [A, B]);
      assert.deepEqual(task.deferredCleanup, [A, B]);
    }
  });

  test("a realpath failure other than ENOENT refuses instead of falling back to lexical resolution", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores directory permissions, so realpath never sees EACCES");
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "confine-eacces-"));
    const sealed = path.join(root, "sealed");
    fs.mkdirSync(path.join(sealed, "inner"), { recursive: true });
    fs.chmodSync(sealed, 0o000);
    try {
      const verdict = confinePath(path.join(sealed, "inner"), [root]);
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /realpath failed: EACCES/);
    } finally {
      fs.chmodSync(sealed, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a child whose name merely starts with .. is inside, not an escape", () => {
    const root = "/tmp/confine-root";
    assert.equal(confinePath(path.join(root, "..foo"), [root]).ok, true);
  });
});

describe("isDeferredCleanupReapable", () => {
  test("a pending changeset is never reapable: its overlay is live and its gate is re-runnable", () => {
    assert.equal(isDeferredCleanupReapable({ status: "done", changesetStatus: "pending" }), false);
  });

  test("a running or queued task is never reapable", () => {
    assert.equal(isDeferredCleanupReapable({ status: "running" }), false);
    assert.equal(isDeferredCleanupReapable({ status: "queued" }), false);
  });

  test("a settled task with a resolved changeset is reapable", () => {
    for (const status of ["done", "crashed", "cancelled"]) {
      for (const changesetStatus of ["none", "accepted", "rejected", undefined]) {
        assert.equal(isDeferredCleanupReapable({ status, changesetStatus }), true, `${status}/${changesetStatus}`);
      }
    }
  });
});

describe("sweepDeferredCleanupFor", () => {
  test("drains settled tasks a killed daemon never got to, and leaves pending ones alone", () => {
    const persisted = [];
    const tasks = new Map([
      ["settled", { id: "settled", status: "done", changesetStatus: "accepted", deferredCleanup: ["/tmp/settled"] }],
      ["pending", { id: "pending", status: "done", changesetStatus: "pending", deferredCleanup: ["/tmp/pending"] }],
      ["running", { id: "running", status: "running", deferredCleanup: ["/tmp/running"] }],
      ["empty", { id: "empty", status: "done" }],
    ]);
    sweepDeferredCleanupFor({
      tasks,
      persistedTasks: new Map(),
      persistTask: (id) => persisted.push(id),
      allowedRoots: uvDirRootsFor(FAKE_CACHE, "/tmp/some-state-dir"),
    });
    assert.deepEqual(persisted, ["settled"]);
    assert.equal(tasks.get("settled").deferredCleanup, undefined);
    assert.deepEqual(tasks.get("pending").deferredCleanup, ["/tmp/pending"]);
    assert.deepEqual(tasks.get("running").deferredCleanup, ["/tmp/running"]);
  });

  test("skips drain when persistedTasks was unreadable (fail-closed)", () => {
    const persisted = [];
    const tasks = new Map([
      ["settled", { id: "settled", status: "done", changesetStatus: "accepted", deferredCleanup: ["/tmp/settled"] }],
    ]);
    sweepDeferredCleanupFor({
      tasks,
      persistedTasks: null,
      failClosed: true,
      persistTask: (id) => persisted.push(id),
      allowedRoots: uvDirRootsFor(FAKE_CACHE, "/tmp/some-state-dir"),
    });
    assert.deepEqual(persisted, []);
    assert.deepEqual(tasks.get("settled").deferredCleanup, ["/tmp/settled"]);
  });

  test("refuses a hand-edited entry pointing outside the cache root", () => {
    const persisted = [];
    const tasks = new Map([
      ["settled", { id: "settled", status: "done", changesetStatus: "accepted", deferredCleanup: ["/etc/passwd", "/tmp/legit"] }],
    ]);
    sweepDeferredCleanupFor({
      tasks,
      persistedTasks: new Map(),
      persistTask: (id) => persisted.push(id),
      allowedRoots: uvDirRootsFor(FAKE_CACHE, "/tmp/some-state-dir"),
    });
    // Both entries live on the task list at boot, but only the legit one is
    // reaped. The /etc/passwd entry is refused and dropped permanently.
    assert.equal(tasks.get("settled").deferredCleanup, undefined);
  });
});

describe("sweepOrphanedUvDirsFor", () => {
  test("reclaims settled and unknown ids, keeps live tasks and another daemon's namespaces", () => {
    const entries = {
      "uv-cache": [SETTLED, "pending", "running", UNKNOWN, OTHER_DAEMON, ".", ".."],
      "uv-tools": [SETTLED, UNKNOWN],
    };
    const tasks = new Map([
      [SETTLED, { id: SETTLED, status: "done", changesetStatus: "accepted" }],
      ["pending", { id: "pending", status: "done", changesetStatus: "pending" }],
      ["running", { id: "running", status: "running" }],
    ]);
    const persistedTasks = new Map([[OTHER_DAEMON, { id: OTHER_DAEMON }]]);
    const removed = [];
    const ownNs = uvDirNamespace("/tmp/some-state-dir");
    sweepOrphanedUvDirsFor({
      cacheDir: FAKE_CACHE,
      stateDir: "/tmp/some-state-dir",
      tasks,
      persistedTasks,
      readdirFn: (dir) => {
        if (path.basename(dir) === ownNs) {
          const bucket = path.basename(path.dirname(dir));
          return entries[bucket] ?? [];
        }
        return [];
      },
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    assert.deepEqual(removed.sort(), [
      `uv-cache/${ownNs}/settled`,
      `uv-cache/${ownNs}/unknown`,
      `uv-tools/${ownNs}/settled`,
      `uv-tools/${ownNs}/unknown`,
    ]);
  });

  test("a missing bucket directory is not an error", () => {
    assert.doesNotThrow(() => sweepOrphanedUvDirsFor({
      cacheDir: path.join(os.tmpdir(), "axi-no-such-cache-dir"),
      stateDir: "/tmp/some-state-dir",
      tasks: new Map(),
      persistedTasks: new Map(),
      readdirFn: (dir) => fs.readdirSync(dir),
    }));
  });

  test("another state dir's namespace survives this daemon's sweep", () => {
    // Two state dirs share a cacheDir. Theirs has live tasks recorded on
    // disk in their tasks.json (which this daemon has never seen), and ours
    // has nothing of theirs. None of theirs should be reaped.
    const otherId = `oc_other_${process.pid}`;
    const ownId = `oc_own_${process.pid}`;
    const ownNamespace = uvDirNamespace("/tmp/our-state");
    const otherNamespace = uvDirNamespace("/tmp/their-state");
    const removed = [];
    const tasks = new Map();
    sweepOrphanedUvDirsFor({
      cacheDir: FAKE_CACHE,
      stateDir: "/tmp/our-state",
      tasks,
      persistedTasks: new Map(),
      readdirFn: (dir) => {
        if (dir === path.join(FAKE_CACHE, "uv-cache", ownNamespace)) return [ownId];
        if (dir === path.join(FAKE_CACHE, "uv-cache", otherNamespace)) return [otherId];
        return [];
      },
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    // The own namespace's `ownId` is reapable (not in tasks or persistedTasks).
    // The other daemon's namespace is never even read.
    assert.equal(removed.length, 1);
    assert.equal(removed[0], path.join("uv-cache", ownNamespace, ownId));
    assert.equal(removed.some((p) => p.includes(otherNamespace)), false);
    assert.equal(removed.some((p) => p.includes(otherId)), false);
  });

  test("corrupt / unreadable persisted state: fail closed (skip namespaced pass)", () => {
    const removed = [];
    const ownId = `oc_failclosed_${process.pid}`;
    const tasks = new Map();
    sweepOrphanedUvDirsFor({
      cacheDir: FAKE_CACHE,
      stateDir: "/tmp/our-state",
      tasks,
      persistedTasks: null,
      failClosed: true,
      readdirFn: (dir) => {
        if (dir === path.join(FAKE_CACHE, "uv-cache", uvDirNamespace("/tmp/our-state"))) return [ownId];
        return [];
      },
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    assert.deepEqual(removed, []);
  });

  test("legacy flat dirs older than the age floor are reaped", () => {
    const ownNamespace = uvDirNamespace("/tmp/our-state");
    const removed = [];
    const foreignNamespace = uvDirNamespace("/tmp/another-daemons-state");
    const legacyId = `oc_mlegacy_${process.pid.toString(16)}`;
    sweepOrphanedUvDirsFor({
      cacheDir: FAKE_CACHE,
      stateDir: "/tmp/our-state",
      tasks: new Map(),
      persistedTasks: new Map(),
      legacySweepAgeMs: 1000,
      readdirFn: (dir) => {
        if (dir === FAKE_CACHE) return ["uv-cache", "uv-tools"];
        if (dir === path.join(FAKE_CACHE, "uv-cache")) return [legacyId, ownNamespace, foreignNamespace];
        if (dir === path.join(FAKE_CACHE, "uv-tools")) return [legacyId, ownNamespace, foreignNamespace];
        return [];
      },
      lstatFn: (_target) => ({ mtimeMs: Date.now() - 60_000_000 }),
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    assert.deepEqual(removed.sort(), [`uv-cache/${legacyId}`, `uv-tools/${legacyId}`]);
  });

  test("legacy flat dirs newer than the age floor are kept", () => {
    const ownNamespace = uvDirNamespace("/tmp/our-state");
    const removed = [];
    const legacyId = `oc_mfresh_${process.pid.toString(16)}`;
    sweepOrphanedUvDirsFor({
      cacheDir: FAKE_CACHE,
      stateDir: "/tmp/our-state",
      tasks: new Map(),
      persistedTasks: new Map(),
      legacySweepAgeMs: 10 * 86_400_000,
      readdirFn: (dir) => {
        if (dir === FAKE_CACHE) return ["uv-cache"];
        if (dir === path.join(FAKE_CACHE, "uv-cache")) return [legacyId, ownNamespace];
        return [];
      },
      lstatFn: (_target) => ({ mtimeMs: Date.now() - 1000 }),
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    assert.deepEqual(removed, []);
  });

  test("a legacy flat dir whose mtime cannot be read is kept, not reaped past the age floor", () => {
    const removed = [];
    const legacyId = `oc_mstat_${process.pid.toString(16)}`;
    sweepOrphanedUvDirsFor({
      cacheDir: FAKE_CACHE,
      stateDir: "/tmp/our-state",
      tasks: new Map(),
      persistedTasks: new Map(),
      legacySweepAgeMs: 10 * 86_400_000,
      readdirFn: (dir) => (dir === path.join(FAKE_CACHE, "uv-cache") ? [legacyId] : []),
      lstatFn: () => { throw Object.assign(new Error("EACCES: permission denied, lstat"), { code: "EACCES" }); },
      removeDirFn: (target) => removed.push(path.relative(FAKE_CACHE, target)),
    });
    assert.deepEqual(removed, []);
  });
});

describe("uv path helpers", () => {
  test("uvDirNamespace is deterministic and state-dir-scoped", () => {
    assert.equal(uvDirNamespace("/tmp/x"), uvDirNamespace("/tmp/x"));
    assert.notEqual(uvDirNamespace("/tmp/x"), uvDirNamespace("/tmp/y"));
  });

  test("uvDirPath places a task's dir under the daemon's namespace", () => {
    const stateDir = "/tmp/our-state";
    const p = uvDirPath("/cache", stateDir, "taskid", "uv-cache");
    assert.equal(p, path.join("/cache", "uv-cache", uvDirNamespace(stateDir), "taskid"));
  });

  test("uvDirRootsFor returns both buckets' namespaced roots", () => {
    const roots = uvDirRootsFor("/cache", "/tmp/our-state");
    assert.equal(roots.length, 2);
    assert.equal(roots[0], path.join("/cache", "uv-cache", uvDirNamespace("/tmp/our-state")));
    assert.equal(roots[1], path.join("/cache", "uv-tools", uvDirNamespace("/tmp/our-state")));
  });

  test("uvDirPath throws on an unknown bucket", () => {
    assert.throws(() => uvDirPath("/cache", "/tmp/x", "task", "garbage"), /unknown uv dir bucket/);
  });
});