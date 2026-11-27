// src/changeset.integration.test.js -- new file
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildBwrapArgs, checkOverlaySupport } from "./sandbox.js";
import { applyChangeset, cleanupOverlay, extractGitDiff, extractNonGitDiff, overlayPaths, resolveHeadDrift, resolvePreDispatchHead, subFilePaths, subOverlayPaths } from "./changeset.js";
import { resolveOverlayTmpRoot } from "./paths.js";
import { makeManager, fakeChild } from "./tasks.test-helpers.js";

const trackedTmpDirs = [];
const trackedOverlays = [];
after(() => {
  for (const overlay of trackedOverlays) {
    const cleaned = cleanupOverlay(overlay);
    assert.equal(cleaned.removed, true, `overlay cleanup failed: ${cleaned.reason}`);
  }
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


// Fixture literals lifted to module scope so the sonarjs
// no-duplicate-string rule stays quiet (each appears once, in its constant)
// and every case points at the same strings.
const TMP_ROOT_PREFIX = "axi-int-tmp-";
const RUN_ROOT_PREFIX = "axi-int-run-";
const TRACKED_FILE = "tracked.txt";
const OBJECT_TEMPFILE = "object tempfile";
const CHANGED_CONTENT = "base\nchanged\n";
const GIT_EMAIL = "user.email=t@t";
const GIT_NAME = "user.name=t";
const DRIFT_TEST_FILE = "line2.txt";
const DRIFT_WORKER_BRANCH = "worker-sim";
// These fixtures are throwaway git repos under a tmp dir, so they trivially
// satisfy the global pre-commit hook's primary-checkout check (toplevel ==
// the repo's own first worktree-list entry). --no-verify skips that (and
// every other global hook gate) for these scratch commits only; it has no
// bearing on real commits made elsewhere.
const NO_VERIFY = "--no-verify";

// A missing overlay capability is an environment fact, not a test failure.
const support = process.platform === "linux" ? checkOverlaySupport() : { supported: false, reason: "not linux" };
const skip = support.reason ? { skip: `overlay integration skipped: ${support.reason}` } : undefined;

function isWritableDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Runs one real bwrap invocation against a directory mounted as a CoW
// overlay (plus any sub-overlays), executing `script` inside.
function runInOverlay({ directory, overlay, overlayRwBinds = [], overlayRwFileBinds = [], script, runtimeDir, homeDir }) {
  // socketPath: null -- these tests exercise overlay round-trips, not daemon
  // connectivity, and the fresh temp runtimeDir has no daemon.sock for bwrap
  // to bind (bwrap fails if the bind source doesn't exist).
  const args = buildBwrapArgs({ stateDir: os.tmpdir(), denyList: [], overlay: { upperDir: overlay.upperDir, workDir: overlay.workDir }, socketPath: null, directory, runtimeDir, homeDir, overlayRwBinds, overlayRwFileBinds });
  return spawnSync("bwrap", [...args, "--", "sh", "-c", script], { encoding: "utf8" });
}

describe("overlay round trips (real bwrap)", () => {
  test("git target: sandboxed write + commit extracts as one flattened diff, applies, cleans up", skip ? undefined : () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-git-"));
    trackedTmpDirs.push(directory);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_ROOT_PREFIX));
    trackedTmpDirs.push(tmpRoot);
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
    trackedTmpDirs.push(runtimeDir);
    spawnSync("git", ["init", "-q", directory]);
    fs.writeFileSync(path.join(directory, TRACKED_FILE), "base\n");
    spawnSync("git", ["-C", directory, "add", "-A"]);
    spawnSync("git", ["-C", directory, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base", NO_VERIFY]);
    const preDispatchHead = resolvePreDispatchHead(directory);
    assert.ok(preDispatchHead, "fixture repo must have a HEAD");

    const overlay = overlayPaths("int_git", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    // A worker that both edits and commits: the commit must flatten into the
    // same working-tree-style diff (spec §2), anchored on preDispatchHead.
    const ran = runInOverlay({
      directory, overlay, runtimeDir, homeDir: os.homedir(),
      script: `echo changed >> ${directory}/tracked.txt && echo new > ${directory}/added.txt && git -C ${directory} add -A && git -C ${directory} -c user.email=t@t -c user.name=t commit -qm worker --no-verify`,
    });
    assert.equal(ran.status, 0, `sandboxed worker script failed: ${ran.stderr}`);
    // The real directory must be untouched before accept -- the whole point.
    assert.equal(fs.readFileSync(path.join(directory, TRACKED_FILE), "utf8"), "base\n");
    assert.equal(fs.existsSync(path.join(directory, "added.txt")), false);

    const diffPath = path.join(tmpRoot, "int_git.patch");
    const extracted = extractGitDiff({ directory, overlay, preDispatchHead, runtimeDir, diffPath, overlayRwBinds: [], stateDir: tmpRoot, homeDir: os.homedir(), denyList: [] });
    assert.equal(extracted.hasChanges, true);
    assert.match(fs.readFileSync(diffPath, "utf8"), /\+changed/);
    assert.match(fs.readFileSync(diffPath, "utf8"), /added\.txt/);

    const applied = applyChangeset({ directory, diffPath, isGitTarget: true });
    assert.deepEqual(applied, { applied: true, reason: null });
    assert.equal(fs.readFileSync(path.join(directory, TRACKED_FILE), "utf8"), CHANGED_CONTENT);
    assert.equal(fs.existsSync(path.join(directory, "added.txt")), true);
    // Applied as a working-tree diff, NOT replayed as the worker's commit.
    const log = spawnSync("git", ["-C", directory, "log", "--oneline"], { encoding: "utf8" }).stdout;
    assert.ok(!log.includes("worker"), "the worker's commit must not land as a commit");

    const removal = cleanupOverlay({ root: overlay.root, tmpRoot });
    assert.equal(removal.removed, true);
    assert.equal(fs.existsSync(overlay.root), false);
  });

  test("worktree-shaped target: git-common-dir sub-overlays capture .git-metadata writes (regression: review finding #1)", skip ? undefined : () => {
    // A real linked worktree: its private admin dir + shared objects/refs
    // live outside the working directory, so commits need sub-overlays
    // (Task 9's overlayRwBinds). Extraction must re-mount those same
    // sub-overlays or the commit's metadata writes are invisible.
    const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-main-"));
    trackedTmpDirs.push(mainRepo);
    spawnSync("git", ["init", "-q", mainRepo]);
    fs.writeFileSync(path.join(mainRepo, "f.txt"), "one\n");
    spawnSync("git", ["-C", mainRepo, "add", "-A"]);
    spawnSync("git", ["-C", mainRepo, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base", NO_VERIFY]);
    const worktree = path.join((() => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-wt-")); trackedTmpDirs.push(p); return p; })(), "wt");
    spawnSync("git", ["-C", mainRepo, "worktree", "add", "-q", worktree, "-b", "wt-branch"]);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_ROOT_PREFIX));
    trackedTmpDirs.push(tmpRoot);
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
    trackedTmpDirs.push(runtimeDir);
    const preDispatchHead = resolvePreDispatchHead(worktree);
    const overlay = overlayPaths("int_subovl", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    // Mirror Task 9's sub-overlay selection for a linked worktree.
    const gitCommonDir = path.join(mainRepo, ".git");
    const gitDir = path.join(gitCommonDir, "worktrees", path.basename(worktree));
    const overlayRwBinds = [gitDir, path.join(gitCommonDir, "objects"), path.join(gitCommonDir, "refs"), path.join(gitCommonDir, "logs", "refs")]
      .map((p) => { const sub = subOverlayPaths(overlay.root, p); fs.mkdirSync(sub.upperDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(sub.workDir, { recursive: true, mode: 0o700 }); return sub; });

    const ran = runInOverlay({
      overlay, overlayRwBinds, runtimeDir,
      directory: worktree, homeDir: os.homedir(),
      script: `echo two >> ${worktree}/f.txt && git -C ${worktree} add -A && git -C ${worktree} -c user.email=t@t -c user.name=t commit -qm wt-worker --no-verify`,
    });
    assert.equal(ran.status, 0, `sandboxed worktree commit failed: ${ran.stderr}`);
    // The shared object store must NOT have gained the worker's commit yet.
    assert.ok(!spawnSync("git", ["-C", mainRepo, "log", "--all", "--oneline"], { encoding: "utf8" }).stdout.includes("wt-worker"));

    const diffPath = path.join(tmpRoot, "int_subovl.patch");
    const extracted = extractGitDiff({ directory: worktree, stateDir: tmpRoot, homeDir: os.homedir(), denyList: [], overlay, overlayRwBinds, preDispatchHead, runtimeDir, diffPath });
    assert.equal(extracted.hasChanges, true, "with overlayRwBinds re-mounted, the flattened commit diff must be visible");
    assert.match(fs.readFileSync(diffPath, "utf8"), /\+two/);
    cleanupOverlay({ root: overlay.root, tmpRoot });
  });

  test("worktree-shaped target: git-common-dir FILE (packed-refs) scratch-copy bind is visible inside the sandbox and re-mounted for extraction", skip ? undefined : () => {
    // Companion to the sub-overlay test above, but for a writable
    // git-common-dir FILE (overlayfs can't mount a directory overlay onto a
    // plain file, hence the separate subFilePaths()/overlayRwFileBinds
    // mechanism). Proves the scratch-copy bind is actually visible at the
    // real host path *inside* the bwrap namespace -- the earlier unit tests
    // only assert on the constructed bwrap argv, never a real invocation.
    const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-filebind-main-"));
    trackedTmpDirs.push(mainRepo);
    spawnSync("git", ["init", "-q", mainRepo]);
    fs.writeFileSync(path.join(mainRepo, "f.txt"), "one\n");
    spawnSync("git", ["-C", mainRepo, "add", "-A"]);
    spawnSync("git", ["-C", mainRepo, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base", NO_VERIFY]);
    const worktree = path.join((() => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-filebind-wt-")); trackedTmpDirs.push(p); return p; })(), "wt");
    spawnSync("git", ["-C", mainRepo, "worktree", "add", "-q", worktree, "-b", "wt-filebind-branch"]);
    // pack-refs forces packed-refs into existence so it's the writable file
    // under test, mirroring the real trigger for this whole mechanism.
    spawnSync("git", ["-C", mainRepo, "pack-refs", "--all"]);
    const packedRefs = path.join(mainRepo, ".git", "packed-refs");
    assert.ok(fs.existsSync(packedRefs), "fixture repo must have a real packed-refs file");
    const originalContent = fs.readFileSync(packedRefs, "utf8");

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_ROOT_PREFIX));
    trackedTmpDirs.push(tmpRoot);
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
    trackedTmpDirs.push(runtimeDir);
    const preDispatchHead = resolvePreDispatchHead(worktree);
    const overlay = overlayPaths("int_filebind", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });

    const gitCommonDir = path.join(mainRepo, ".git");
    const gitDir = path.join(gitCommonDir, "worktrees", path.basename(worktree));
    const overlayRwBinds = [gitDir, path.join(gitCommonDir, "objects"), path.join(gitCommonDir, "refs"), path.join(gitCommonDir, "logs", "refs")]
      .map((p) => { const sub = subOverlayPaths(overlay.root, p); fs.mkdirSync(sub.upperDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(sub.workDir, { recursive: true, mode: 0o700 }); return sub; });
    const fileBind = subFilePaths(overlay.root, packedRefs);
    fs.mkdirSync(path.dirname(fileBind.bindSrc), { recursive: true, mode: 0o700 });
    fs.copyFileSync(packedRefs, fileBind.bindSrc);
    const overlayRwFileBinds = [fileBind];

    const ran = runInOverlay({
      overlay, overlayRwBinds, overlayRwFileBinds, runtimeDir,
      directory: worktree, homeDir: os.homedir(),
      // Proves the bind is visible at the real host path from inside the
      // sandbox, then mutates it -- the write must land on the scratch copy,
      // never the real host file (checked below, outside the sandbox).
      script: `test -f ${packedRefs} && echo aaaa2222aaaa2222aaaa2222aaaa2222aaaa2222 refs/heads/wt-filebind-branch >> ${packedRefs} && echo two >> ${worktree}/f.txt && git -C ${worktree} add -A && git -C ${worktree} -c user.email=t@t -c user.name=t commit -qm wt-worker --no-verify`,
    });
    assert.equal(ran.status, 0, `sandboxed worktree commit failed: ${ran.stderr}`);
    // The real host packed-refs must be untouched -- the whole point of the
    // scratch-copy indirection.
    assert.equal(fs.readFileSync(packedRefs, "utf8"), originalContent);
    // But the scratch copy itself did receive the write, proving the bind
    // was live and the sandboxed script targeted the real host path.
    assert.match(fs.readFileSync(fileBind.bindSrc, "utf8"), /aaaa2222aaaa2222aaaa2222aaaa2222aaaa2222 refs\/heads\/wt-filebind-branch/);

    const diffPath = path.join(tmpRoot, "int_filebind.patch");
    const extracted = extractGitDiff({ directory: worktree, stateDir: tmpRoot, homeDir: os.homedir(), denyList: [], overlay, overlayRwBinds, overlayRwFileBinds, preDispatchHead, runtimeDir, diffPath });
    assert.equal(extracted.hasChanges, true, "with overlayRwFileBinds re-mounted, the flattened commit diff must be visible");
    assert.match(fs.readFileSync(diffPath, "utf8"), /\+two/);
    cleanupOverlay({ root: overlay.root, tmpRoot });
  });

  test("non-git target: refuses unsafe apply and preserves concurrent edits and overlay", skip ? undefined : () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-nongit-"));
    trackedTmpDirs.push(directory);
    const overlayTmpRoot = resolveOverlayTmpRoot();
    const tmpRootParent = isWritableDirectory(overlayTmpRoot) ? overlayTmpRoot : os.tmpdir();
    const tmpRoot = fs.mkdtempSync(path.join(tmpRootParent, TMP_ROOT_PREFIX));
    trackedTmpDirs.push(tmpRoot);
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
    trackedTmpDirs.push(runtimeDir);
    fs.writeFileSync(path.join(directory, "keep.txt"), "stays\n");
    fs.writeFileSync(path.join(directory, "edit.txt"), "before\n");

    const overlay = overlayPaths("int_nongit", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    const ran = runInOverlay({
      directory, overlay, runtimeDir, homeDir: os.homedir(),
      script: `echo after > ${directory}/edit.txt && echo brand-new > ${directory}/new.txt && rm ${directory}/keep.txt`,
    });
    assert.equal(ran.status, 0, `sandboxed worker script failed: ${ran.stderr}`);
    assert.equal(fs.readFileSync(path.join(directory, "edit.txt"), "utf8"), "before\n");

    const diffPath = path.join(tmpRoot, "int_nongit.patch");
    const extracted = extractNonGitDiff({ directory, overlay, runtimeDir, diffPath, stateDir: tmpRoot, homeDir: os.homedir(), denyList: [] });
    assert.equal(extracted.hasChanges, true);
    const patch = fs.readFileSync(diffPath, "utf8");
    assert.match(patch, /brand-new/);
    assert.match(patch, /Only in|keep\.txt/); // the deletion surfaces one way or the other
    fs.writeFileSync(path.join(directory, "edit.txt"), "human edit\n");
    const applied = applyChangeset({ directory, diffPath, isGitTarget: false });
    assert.equal(applied.applied, false);
    assert.match(applied.reason, /baseline/i);
    assert.equal(fs.readFileSync(path.join(directory, "edit.txt"), "utf8"), "human edit\n");
    assert.equal(fs.existsSync(path.join(directory, "new.txt")), false);
    assert.equal(fs.existsSync(path.join(directory, "keep.txt")), true);
    assert.equal(fs.existsSync(overlay.upperDir), true);
    cleanupOverlay({ root: overlay.root, tmpRoot });
  });
});

describe("non-git overlay retention (real bwrap)", () => {
  for (const change of ["mode", "binary"]) {
    test(`non-git ${change}-only changes survive settlement in a real overlay`, skip ? undefined : () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-retain-"));
      trackedTmpDirs.push(directory);
      const file = path.join(directory, "file");
      fs.writeFileSync(file, change === "binary" ? Buffer.from([0, 1, 2]) : "same\n", { mode: 0o600 });
      const overlayTmpRoot = fs.mkdtempSync(path.join(isWritableDirectory(resolveOverlayTmpRoot()) ? resolveOverlayTmpRoot() : os.tmpdir(), TMP_ROOT_PREFIX));
      trackedTmpDirs.push(overlayTmpRoot);
      const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
      trackedTmpDirs.push(runtimeDir);
      let child;
      const mgr = makeManager({
        spawnFn: () => { child = fakeChild(); return child; },
        sandboxEnabled: true,
        checkBwrapAvailableFn: () => ({ checked: true, available: true }),
        overlayEnabled: true,
        checkOverlaySupportFn: () => ({ supported: true }),
        platform: "linux",
        overlayTmpRoot,
      });
      const task = mgr.dispatch({ prompt: "hello", directory });
      const overlay = mgr.status(task.id).overlayDirs;
      trackedOverlays.push({ root: overlay.root, tmpRoot: overlayTmpRoot });
      const script = change === "mode" ? 'chmod 755 "$1/file"' : 'printf "\\000\\004\\005" > "$1/file"';
      const args = buildBwrapArgs({ directory, overlay, runtimeDir, stateDir: os.tmpdir(), denyList: [], socketPath: null, homeDir: os.homedir() });
      const ran = spawnSync("bwrap", [...args, "--", "sh", "-c", script, "sh", directory], { encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
      child.emit("exit", 0, null);
      const status = mgr.status(task.id);
      assert.equal(status.changesetStatus, "pending");
      assert.equal(status.overlayDirs.root, overlay.root);
      const upperFile = path.join(overlay.upperDir, "file");
      assert.equal(fs.existsSync(upperFile), true);
      if (change === "mode") {
        assert.equal(fs.statSync(upperFile).mode & 0o777, 0o755);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      } else {
        assert.deepEqual(fs.readFileSync(upperFile), Buffer.from([0, 4, 5]));
        assert.deepEqual(fs.readFileSync(file), Buffer.from([0, 1, 2]));
      }
    });
  }
});

// resolveHeadDrift needs no bwrap at all (it operates on the live directory
// via plain `git worktree`/`apply`, never a sandbox) -- gate only on git
// being present, so this coverage runs everywhere, not just on hosts with a
// working overlay stack. This is the exact repro that caught the --check
// false-clean bug while grounding the spec (see the spec's "A --check
// correction" section) -- kept here as regression coverage against a future
// git version changing --3way --check semantics again.
describe("resolveHeadDrift() (real git, no bwrap required)", () => {
  function initRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-repo-"));
    trackedTmpDirs.push(dir);
    spawnSync("git", ["init", "-q", dir]);
    fs.writeFileSync(path.join(dir, DRIFT_TEST_FILE), "line1\nline2\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base", NO_VERIFY]);
    return dir;
  }

  test("non-conflicting drift: target changes a different file, patch merges cleanly", () => {
    const dir = initRepo();
    const base = resolvePreDispatchHead(dir);
    // Simulate the worker's isolated diff: line2.txt's line2 changed, saved
    // as a patch anchored on `base`, computed independently of dir's later
    // history (mirrors what extractGitDiff would have produced).
    spawnSync("git", ["-C", dir, "checkout", "-q", "-b", DRIFT_WORKER_BRANCH]);
    fs.writeFileSync(path.join(dir, DRIFT_TEST_FILE), "line1\nWORKER-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "worker", NO_VERIFY]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, DRIFT_WORKER_BRANCH], { encoding: "utf8" }).stdout;
    const diffPath = path.join(dir, "..", "worker.patch");
    fs.writeFileSync(diffPath, diff);
    spawnSync("git", ["-C", dir, "checkout", "-q", "main", "--", "."]);
    spawnSync("git", ["-C", dir, "branch", "-q", "-D", DRIFT_WORKER_BRANCH]);

    // Directory independently advances on a DIFFERENT file.
    fs.writeFileSync(path.join(dir, "other.txt"), "unrelated\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "unrelated", NO_VERIFY]);
    const currentHead = resolvePreDispatchHead(dir);

    const scratchDir = path.join((() => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-scratch-")); trackedTmpDirs.push(p); return p; })(), "wt");
    const result = resolveHeadDrift({ directory: dir, diffPath, currentHead, scratchDir });
    assert.deepEqual(result, { recovered: true, conflictDetail: null });
    assert.equal(fs.existsSync(scratchDir), false, "the scratch worktree must be removed after evaluation");
  });

  test("genuine conflict: target changes the same line the patch touches", () => {
    const dir = initRepo();
    const base = resolvePreDispatchHead(dir);
    spawnSync("git", ["-C", dir, "checkout", "-q", "-b", DRIFT_WORKER_BRANCH]);
    fs.writeFileSync(path.join(dir, DRIFT_TEST_FILE), "line1\nWORKER-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "worker", NO_VERIFY]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, DRIFT_WORKER_BRANCH], { encoding: "utf8" }).stdout;
    const diffPath = path.join(dir, "..", "worker-conflict.patch");
    fs.writeFileSync(diffPath, diff);
    spawnSync("git", ["-C", dir, "checkout", "-q", "main", "--", "."]);
    spawnSync("git", ["-C", dir, "branch", "-q", "-D", DRIFT_WORKER_BRANCH]);

    // Directory independently changes the SAME line -- a real conflict.
    fs.writeFileSync(path.join(dir, DRIFT_TEST_FILE), "line1\nTARGET-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "conflicting", NO_VERIFY]);
    const currentHead = resolvePreDispatchHead(dir);

    const scratchDir = path.join((() => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-scratch-")); trackedTmpDirs.push(p); return p; })(), "wt");
    const result = resolveHeadDrift({ directory: dir, diffPath, currentHead, scratchDir });
    assert.equal(result.recovered, false);
    assert.ok(result.conflictDetail);
    assert.equal(fs.existsSync(scratchDir), false, "the scratch worktree must be removed even after a conflict");
  });
});

// An outer supplementary group is not mapped by bwrap's single-gid user
// namespace. Many hosts have no such group, so this fixture is conditional.
function chownableUnmappedGid() {
  if (typeof process.getegid !== "function" || typeof process.getgroups !== "function") return null;
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "axi-gid-probe-"));
  try {
    const egid = process.getegid();
    const gids = process.getgroups().filter((gid) => gid !== egid);
    if (process.geteuid?.() === 0) gids.push(egid === 1 ? 2 : 1);
    for (const gid of gids) {
      try {
        fs.chownSync(probe, -1, gid);
        return gid;
      } catch {
        // Try another group.
      }
    }
    return null;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

describe("unmapped ownership extraction (real bwrap)", () => {
  for (const failure of ["index.lock", OBJECT_TEMPFILE]) {
    test(`reports candidate ownership for ${failure} and retains worker changes`, (t) => {
      const required = process.env.TASKFERRY_REQUIRE_OWNERSHIP_REGRESSION === "1";
      if (!required && process.env.TASKFERRY_TEST_UNMAPPED_OWNERSHIP !== "1") {
        t.skip("set TASKFERRY_TEST_UNMAPPED_OWNERSHIP=1 on a host with working user namespaces and OverlayFS");
        return;
      }
      if (!support.supported) {
        assert.equal(required, false, `ownership regression requires overlay support: ${support.reason}`);
        t.skip(`overlay integration skipped: ${support.reason}`);
        return;
      }
      const gid = chownableUnmappedGid();
      if (gid === null) {
        assert.equal(required, false, "ownership regression requires a chownable unmapped group");
        t.skip("no chownable group outside the sandbox's gid map");
        return;
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-owner-"));
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_ROOT_PREFIX));
      const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
      trackedTmpDirs.push(directory, tmpRoot, runtimeDir);
      spawnSync("git", ["init", "-q", directory]);
      fs.writeFileSync(path.join(directory, TRACKED_FILE), "base\n");
      spawnSync("git", ["-C", directory, "add", "-A"]);
      spawnSync("git", ["-C", directory, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base", NO_VERIFY]);
      const preDispatchHead = resolvePreDispatchHead(directory);
      assert.ok(preDispatchHead);
      const overlay = overlayPaths("int_owner", tmpRoot);
      fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
      const ran = runInOverlay({ directory, overlay, runtimeDir, homeDir: os.homedir(), script: `echo changed >> ${directory}/${TRACKED_FILE}` });
      assert.equal(ran.status, 0, `sandboxed worker write failed: ${ran.stderr}`);
      const upperFile = path.join(overlay.upperDir, TRACKED_FILE);
      let affected = path.join(directory, ".git");
      if (failure === OBJECT_TEMPFILE) {
        const hash = spawnSync("git", ["-C", directory, "hash-object", "--stdin"], { input: CHANGED_CONTENT, encoding: "utf8" });
        assert.equal(hash.status, 0, hash.stderr);
        assert.match(hash.stdout.trim(), /^[0-9a-f]{40,64}$/);
        affected = path.join(directory, ".git", "objects", hash.stdout.trim().slice(0, 2));
        fs.mkdirSync(affected, { recursive: true });
      }
      fs.chownSync(affected, -1, gid);
      const diffPath = path.join(tmpRoot, "int_owner.patch");
      assert.throws(() => extractGitDiff({
        directory, overlay, preDispatchHead, runtimeDir, diffPath,
        overlayRwBinds: [], stateDir: tmpRoot, homeDir: os.homedir(), denyList: [],
      }), (err) => {
        assert.match(err.message, /Value too large for defined data type/);
        assert.match(err.message, /Unable to extract changeset: group owner \d+ cannot be represented in the sandbox/);
        assert.ok(err.message.includes(`Set ownership of ${affected} to`));
        if (failure === OBJECT_TEMPFILE) {
          assert.match(err.message, /Git did not name the failing object directory/);
        }
        return true;
      });
      assert.equal(fs.existsSync(diffPath), false);
      assert.equal(fs.readFileSync(upperFile, "utf8"), CHANGED_CONTENT);
      assert.equal(fs.readFileSync(path.join(directory, TRACKED_FILE), "utf8"), "base\n");
      cleanupOverlay({ root: overlay.root, tmpRoot });
    });
  }
});
