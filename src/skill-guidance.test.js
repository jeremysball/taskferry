// Executable tests for shell recipes the using-taskferry skill tells a reader to
// run. The snippets are extracted from the skill files themselves rather than
// copied here, so a doc edit that breaks the recipe fails this suite instead of
// silently shipping a recipe nobody runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ENCODING = "utf8";
const BASH = "/bin/bash";
const SPAWN_RECEIPT = "spawns.txt";
const EXEC_MODE = 0o700;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "using-taskferry");

function readSkillFile(...parts) {
  return fs.readFileSync(path.join(skillDir, ...parts), ENCODING);
}

/** Pull the single ```sh fenced block containing `marker` out of a markdown file. */
function shellBlockContaining(markdown, marker) {
  const blocks = [...markdown.matchAll(/```sh\n([\s\S]*?)```/gu)].map((m) => m[1]);
  const matched = blocks.filter((b) => b.includes(marker));
  assert.equal(matched.length, 1, `expected exactly one sh block containing ${marker}`);
  return matched[0];
}

function withTempDir(name, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Stand in for the real `taskferry` binary: records one line per invocation so a
 * test can count how many watchers a recipe actually spawned.
 */
function fakeTaskferryBin(dir, receiptPath) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, "taskferry");
  fs.writeFileSync(shim, `#!/bin/bash\necho "$*" >> ${JSON.stringify(receiptPath)}\nsleep 30\n`);
  fs.chmodSync(shim, EXEC_MODE);
  return bin;
}

// ---------------------------------------------------------------------------
// Fleet watch recipe
// ---------------------------------------------------------------------------

const FLEET_MARKER = "FLEET_LOCK";

function runFleetRecipe({ watchDir, bin, extraSetup = "" }) {
  const recipe = shellBlockContaining(readSkillFile("resources", "monitoring-progress.md"), FLEET_MARKER);
  // The recipe's first line assigns a placeholder; point it at the test's dir.
  const script = recipe.replace(/^WATCH_DIR=.*$/mu, `WATCH_DIR=${JSON.stringify(watchDir)}`);
  return spawnSync(BASH, ["-c", `set -u\nexport PATH=${JSON.stringify(bin)}:$PATH\n${extraSetup}\n${script}`], {
    encoding: ENCODING,
  });
}

/** Recompute the recipe's own slug so a test can locate the files it created. */
function fleetSlug(watchDir) {
  return crypto.createHash("sha256").update(watchDir).digest("hex").slice(0, 16);
}

function fleetPaths(watchDir) {
  const slug = fleetSlug(watchDir);
  return {
    log: `/tmp/taskferry-fleet-watch-${slug}.log`,
    pid: `/tmp/taskferry-fleet-watch-${slug}.pid`,
    lock: `/tmp/taskferry-fleet-watch-${slug}.lock`,
  };
}

function cleanupFleet(watchDir) {
  const p = fleetPaths(watchDir);
  const pid = Number(fs.existsSync(p.pid) ? fs.readFileSync(p.pid, ENCODING).trim() : NaN);
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  fs.rmSync(p.log, { force: true });
  fs.rmSync(p.pid, { force: true });
  fs.rmSync(p.lock, { recursive: true, force: true });
}

test("fleet-watch slug does not collide across paths that differ only in separators", () => {
  // Regression: a `tr -c 'A-Za-z0-9_-' '-'` slug mapped /tmp/a/b and /tmp/a-b to
  // the same string, so two unrelated repos shared one log and one pid file.
  assert.notEqual(fleetSlug("/tmp/a/b"), fleetSlug("/tmp/a-b"));

  const recipe = shellBlockContaining(readSkillFile("resources", "monitoring-progress.md"), FLEET_MARKER);
  assert.doesNotMatch(recipe, /tr -c/u, "slug must not be a character substitution");
  assert.match(recipe, /sha256sum/u, "slug must be a hash of the full path");
});

test("fleet-watch recipe reuses the existing watcher when armed twice for the same repo", () => {
  withTempDir("taskferry-fleet-same-", (dir) => {
    const watchDir = path.join(dir, "repo");
    fs.mkdirSync(watchDir);
    const bin = fakeTaskferryBin(dir, path.join(dir, SPAWN_RECEIPT));
    const pidFile = fleetPaths(watchDir).pid;
    try {
      const first = runFleetRecipe({ watchDir, bin });
      assert.equal(first.status, 0, first.stderr);
      // The recipe writes the pid in the parent shell before it exits, so this
      // is readable synchronously; the watcher's own output is not.
      const firstPid = fs.readFileSync(pidFile, ENCODING).trim();
      assert.match(firstPid, /^\d+$/u);

      const second = runFleetRecipe({ watchDir, bin });
      assert.equal(second.status, 0, second.stderr);
      assert.equal(
        fs.readFileSync(pidFile, ENCODING).trim(),
        firstPid,
        "second arm must reuse the live watcher, not replace its pid"
      );
    } finally {
      cleanupFleet(watchDir);
    }
  });
});

test("fleet-watch recipe writes separate log and pid files for different repos", () => {
  withTempDir("taskferry-fleet-distinct-", (dir) => {
    // Named to differ only by a separator, the exact case the old slug collapsed.
    const nested = path.join(dir, "a", "b");
    const flat = path.join(dir, "a-b");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(flat, { recursive: true });
    const bin = fakeTaskferryBin(dir, path.join(dir, SPAWN_RECEIPT));
    try {
      for (const watchDir of [nested, flat]) {
        assert.equal(runFleetRecipe({ watchDir, bin }).status, 0);
      }
      const a = fleetPaths(nested);
      const b = fleetPaths(flat);
      assert.notEqual(a.log, b.log);
      assert.notEqual(a.pid, b.pid);
      assert.ok(fs.existsSync(a.pid) && fs.existsSync(b.pid), "each repo gets its own pid file");
    } finally {
      cleanupFleet(nested);
      cleanupFleet(flat);
    }
  });
});

test("fleet-watch recipe does not spawn while another session holds the lock", () => {
  withTempDir("taskferry-fleet-lock-", (dir) => {
    const watchDir = path.join(dir, "repo");
    fs.mkdirSync(watchDir);
    const receipt = path.join(dir, SPAWN_RECEIPT);
    const bin = fakeTaskferryBin(dir, receipt);
    const { lock: held, pid: pidFile } = fleetPaths(watchDir);
    fs.mkdirSync(held, { recursive: true });
    try {
      const result = runFleetRecipe({ watchDir, bin });
      assert.equal(result.status, 0, result.stderr);
      // Parent-written and therefore synchronous: if the recipe had entered the
      // spawn branch, the pid file would exist by the time bash returned.
      assert.ok(!fs.existsSync(pidFile), "a session that loses the lock must not spawn a second watcher");
      assert.ok(!fs.existsSync(receipt), "and must not invoke taskferry watch at all");
    } finally {
      cleanupFleet(watchDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Heredoc prompt delivery
// ---------------------------------------------------------------------------

/** Deliver `payload` over a heredoc with `delimiter`, capturing what the callee received. */
function deliverViaHeredoc(dir, payload, delimiter) {
  const captured = path.join(dir, `captured-${crypto.randomUUID()}.txt`);
  const sink = path.join(dir, "sink.sh");
  fs.writeFileSync(sink, `#!/bin/bash\ncat > "$1"\n`);
  fs.chmodSync(sink, EXEC_MODE);
  const script = `${JSON.stringify(sink)} ${JSON.stringify(captured)} <<'${delimiter}'\n${payload}\n${delimiter}\n`;
  const result = spawnSync(BASH, ["-c", script], { encoding: ENCODING });
  return {
    result,
    received: fs.existsSync(captured) ? fs.readFileSync(captured, ENCODING) : "",
  };
}

test("a bare delimiter inside the payload truncates the prompt without erroring", () => {
  // This is the hazard the Worker Contract warns about, pinned as a test so the
  // warning can't be dropped as hypothetical. SKILL.md documents the heredoc
  // idiom, so its own text contains a bare PROMPT_EOF line.
  withTempDir("taskferry-heredoc-hazard-", (dir) => {
    const payload = readSkillFile("SKILL.md");
    assert.ok(
      payload.split("\n").includes("PROMPT_EOF"),
      "SKILL.md is expected to contain a bare PROMPT_EOF line; if that changed, this test needs a new fixture"
    );

    const { received } = deliverViaHeredoc(dir, payload, "PROMPT_EOF");
    assert.notEqual(received, `${payload}\n`, "payload must not survive intact");
    assert.ok(received.length < payload.length, "payload is truncated at the first bare delimiter");
  });
});

test("the documented random delimiter delivers a payload that contains PROMPT_EOF intact", () => {
  withTempDir("taskferry-heredoc-safe-", (dir) => {
    const payload = readSkillFile("SKILL.md");
    const delimiter = `TF_EOF_${crypto.randomBytes(8).toString("hex")}`;
    assert.ok(!payload.split("\n").includes(delimiter), "generated delimiter must not collide");

    const { received } = deliverViaHeredoc(dir, payload, delimiter);
    assert.equal(received, `${payload}\n`, "payload must round-trip byte-identical");
  });
});

test("the Worker Contract warns that the delimiter must not appear in the payload", () => {
  const skill = readSkillFile("SKILL.md");
  assert.match(skill, /must not appear on its own line anywhere inside the prompt/u);
  assert.match(skill, /exitCode: 0/u, "the warning must say the failure is silent");
});
