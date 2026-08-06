// src/changeset.integration.test.js -- new file
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildBwrapArgs, checkOverlaySupport } from "./sandbox.js";
import { applyChangeset, cleanupOverlay, extractGitDiff, extractNonGitDiff, overlayPaths, resolveHeadDrift, resolvePreDispatchHead, subFilePaths, subOverlayPaths } from "./changeset.js";

const trackedTmpDirs = [];
after(() => {
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


// Fixture literals lifted to module scope so the sonarjs
// no-duplicate-string rule stays quiet (each appears once, in its constant)
// and every case points at the same strings.
const TMP_ROOT_PREFIX = "axi-int-tmp-";
const RUN_ROOT_PREFIX = "axi-int-run-";
const TRACKED_FILE = "tracked.txt";
const GIT_EMAIL = "user.email=t@t";
const GIT_NAME = "user.name=t";
const DRIFT_TEST_FILE = "line2.txt";
const DRIFT_WORKER_BRANCH = "worker-sim";

// Skip the whole suite unless this host can actually run overlays: Linux,
// bwrap >= 0.8, and (for the non-git round trip) a real rsync. A missing
// capability is an environment fact, not a test failure.
const support = process.platform === "linux" ? checkOverlaySupport() : { supported: false, reason: "not linux" };
const rsyncAvailable = spawnSync("rsync", ["--version"], { encoding: "utf8" }).status === 0;
let skipReason = support.reason;
if (support.supported) {
  skipReason = rsyncAvailable ? null : "rsync not installed";
}
const skip = skipReason ? { skip: `overlay integration skipped: ${skipReason}` } : undefined;

// Runs one real bwrap invocation against a directory mounted as a CoW
// overlay (plus any sub-overlays), executing `script` inside.
function runInOverlay({ directory, overlay, overlayRwBinds = [], overlayRwFileBinds = [], script, runtimeDir, homeDir }) {
  const args = buildBwrapArgs({ stateDir: os.tmpdir(), denyList: [], overlay: { upperDir: overlay.upperDir, workDir: overlay.workDir }, directory, runtimeDir, homeDir, overlayRwBinds, overlayRwFileBinds });
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
    spawnSync("git", ["-C", directory, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base"]);
    const preDispatchHead = resolvePreDispatchHead(directory);
    assert.ok(preDispatchHead, "fixture repo must have a HEAD");

    const overlay = overlayPaths("int_git", tmpRoot);
    fs.mkdirSync(overlay.upperDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(overlay.workDir, { recursive: true, mode: 0o700 });
    // A worker that both edits and commits: the commit must flatten into the
    // same working-tree-style diff (spec §2), anchored on preDispatchHead.
    const ran = runInOverlay({
      directory, overlay, runtimeDir, homeDir: os.homedir(),
      script: `echo changed >> ${directory}/tracked.txt && echo new > ${directory}/added.txt && git -C ${directory} add -A && git -C ${directory} -c user.email=t@t -c user.name=t commit -qm worker`,
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
    assert.equal(fs.readFileSync(path.join(directory, TRACKED_FILE), "utf8"), "base\nchanged\n");
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
    spawnSync("git", ["-C", mainRepo, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base"]);
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
      script: `echo two >> ${worktree}/f.txt && git -C ${worktree} add -A && git -C ${worktree} -c user.email=t@t -c user.name=t commit -qm wt-worker`,
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
    spawnSync("git", ["-C", mainRepo, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base"]);
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
      script: `test -f ${packedRefs} && echo aaaa2222aaaa2222aaaa2222aaaa2222aaaa2222 refs/heads/wt-filebind-branch >> ${packedRefs} && echo two >> ${worktree}/f.txt && git -C ${worktree} add -A && git -C ${worktree} -c user.email=t@t -c user.name=t commit -qm wt-worker`,
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

  test("non-git target: sandboxed write extracts a diff -ru, rsync-applies, cleans up", skip ? undefined : () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axi-int-nongit-"));
    trackedTmpDirs.push(directory);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_ROOT_PREFIX));
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

    const applied = applyChangeset({ directory, diffPath, overlay, runtimeDir, isGitTarget: false, stateDir: tmpRoot, homeDir: os.homedir(), denyList: [] });
    assert.deepEqual(applied, { applied: true, reason: null });
    assert.equal(fs.readFileSync(path.join(directory, "edit.txt"), "utf8"), "after\n");
    assert.equal(fs.readFileSync(path.join(directory, "new.txt"), "utf8"), "brand-new\n");
    assert.equal(fs.existsSync(path.join(directory, "keep.txt")), false, "whiteout-implied deletions must land");
    cleanupOverlay({ root: overlay.root, tmpRoot });
  });
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
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "base"]);
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
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "worker"]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, DRIFT_WORKER_BRANCH], { encoding: "utf8" }).stdout;
    const diffPath = path.join(dir, "..", "worker.patch");
    fs.writeFileSync(diffPath, diff);
    spawnSync("git", ["-C", dir, "checkout", "-q", "main", "--", "."]);
    spawnSync("git", ["-C", dir, "branch", "-q", "-D", DRIFT_WORKER_BRANCH]);

    // Directory independently advances on a DIFFERENT file.
    fs.writeFileSync(path.join(dir, "other.txt"), "unrelated\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "unrelated"]);
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
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "worker"]);
    const diff = spawnSync("git", ["-C", dir, "diff", base, DRIFT_WORKER_BRANCH], { encoding: "utf8" }).stdout;
    const diffPath = path.join(dir, "..", "worker-conflict.patch");
    fs.writeFileSync(diffPath, diff);
    spawnSync("git", ["-C", dir, "checkout", "-q", "main", "--", "."]);
    spawnSync("git", ["-C", dir, "branch", "-q", "-D", DRIFT_WORKER_BRANCH]);

    // Directory independently changes the SAME line -- a real conflict.
    fs.writeFileSync(path.join(dir, DRIFT_TEST_FILE), "line1\nTARGET-CHANGED\nline3\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, "-c", GIT_EMAIL, "-c", GIT_NAME, "commit", "-qm", "conflicting"]);
    const currentHead = resolvePreDispatchHead(dir);

    const scratchDir = path.join((() => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "axi-drift-scratch-")); trackedTmpDirs.push(p); return p; })(), "wt");
    const result = resolveHeadDrift({ directory: dir, diffPath, currentHead, scratchDir });
    assert.equal(result.recovered, false);
    assert.ok(result.conflictDetail);
    assert.equal(fs.existsSync(scratchDir), false, "the scratch worktree must be removed even after a conflict");
  });
});
