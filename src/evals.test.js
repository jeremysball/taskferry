// Deterministic tests for the eval harness itself.
//
// The evals in evals/ dispatch real models and cost real money, so they are not
// part of `npm test`. What IS testable without a model is the machinery: the
// shim answers a fixture the same way every time, and the scorer turns a command
// log into the same verdict every time. These tests pin both, so a broken
// harness fails in CI rather than silently scoring every eval PASS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readCommandLog, scoreRun, formatReport } from "../evals/score.js";

const ENCODING = "utf8";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalsDir = path.join(root, "evals");
const shim = path.join(evalsDir, "shim", "taskferry.js");
const CRASH_ID = "oc_eval_crash01";
const CRASH_FIXTURE = "crash-overlay-recovery";
const REVIEW_FIXTURE = "reviewer-visibility";

function fixturePath(name) {
  return path.join(evalsDir, "fixtures", `${name}.json`);
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(fixturePath(name), ENCODING));
}

function withSandbox(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-evalharness-")));
  try {
    return fn(path.join(dir, "commands.jsonl"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runShim(fixtureName, logPath, args) {
  return spawnSync(process.execPath, [shim, ...args], {
    encoding: ENCODING,
    env: {
      ...process.env,
      TASKFERRY_EVAL_FIXTURE: fixturePath(fixtureName),
      TASKFERRY_EVAL_LOG: logPath,
    },
  });
}

test("every checked-in fixture is well formed", () => {
  const names = fs.readdirSync(path.join(evalsDir, "fixtures")).map((f) => f.replace(/\.json$/u, ""));
  assert.ok(names.length > 0, "expected at least one fixture");
  const kinds = new Set(["ranCommand", "neverRanCommand", "ranInOrder", "ranExactly"]);
  for (const name of names) {
    const fixture = loadFixture(name);
    assert.equal(fixture.name, name, `${name}: fixture name must match its filename`);
    assert.ok(fixture.task, `${name}: needs a task`);
    // Every fixture records which review finding motivated it, so a reader can
    // tell what the eval is defending against without archaeology.
    assert.ok(fixture.sourceFinding, `${name}: needs a sourceFinding`);
    assert.ok(fixture.checks.length > 0, `${name}: needs checks`);
    for (const check of fixture.checks) {
      assert.ok(kinds.has(check.kind), `${name}: unknown check kind ${check.kind}`);
      assert.ok(check.id && check.description, `${name}: every check needs an id and description`);
    }
  }
});

test("shim records every invocation and answers the matching fixture response", () => {
  withSandbox((log) => {
    const result = runShim(CRASH_FIXTURE, log, ["status", CRASH_ID, "--full"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sessionId: ses_eval_9f2c/u);

    const entries = readCommandLog(log);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].argv, ["status", CRASH_ID, "--full"]);
    assert.equal(entries[0].matched, "status-full");
  });
});

test("shim is deterministic: identical argv yields identical stdout and exit code", () => {
  withSandbox((log) => {
    const args = ["result", CRASH_ID, "--diff"];
    const first = runShim(CRASH_FIXTURE, log, args);
    const second = runShim(CRASH_FIXTURE, log, args);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.status, second.status);
    assert.equal(readCommandLog(log).length, 2, "both invocations are recorded");
  });
});

test("shim fails loudly on an unmatched command instead of inventing a response", () => {
  withSandbox((log) => {
    const result = runShim(CRASH_FIXTURE, log, ["teleport", "--nowhere"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no fixture response matches/u);
    assert.equal(readCommandLog(log)[0].matched, null, "the miss is still recorded");
  });
});

test("later fixture responses override earlier ones on a more specific match", () => {
  withSandbox((log) => {
    const plain = runShim(CRASH_FIXTURE, log, ["status", CRASH_ID]);
    const full = runShim(CRASH_FIXTURE, log, ["status", CRASH_ID, "--full"]);
    assert.doesNotMatch(plain.stdout, /diffStat/u);
    assert.match(full.stdout, /diffStat/u);
  });
});

test("scorer passes a log that satisfies every check", () => {
  const fixture = loadFixture(CRASH_FIXTURE);
  const log = [
    { argv: ["status", CRASH_ID, "--full"] },
    { argv: ["result", CRASH_ID, "--diff"] },
    { argv: ["dispatch", "--session-id", "ses_eval_9f2c", "--prompt", "-"] },
  ];
  const scored = scoreRun(fixture, log);
  assert.equal(scored.pass, true, formatReport(fixture, scored));
});

test("scorer fails the exact failure the crash eval exists to catch", () => {
  // The modelled mistake: read a clean `git status`, conclude nothing happened,
  // and dispatch fresh without ever looking at the overlay or the session id.
  const fixture = loadFixture(CRASH_FIXTURE);
  const scored = scoreRun(fixture, [{ argv: ["dispatch", "--prompt", "-"] }]);
  assert.equal(scored.pass, false);
  const failed = scored.results.filter((r) => !r.ok).map((r) => r.id);
  assert.deepEqual(failed.sort(), ["checks-session", "inspects-before-dispatching", "reads-overlay", "resumes-session"]);
});

test("scorer enforces ordering, not just presence", () => {
  const fixture = loadFixture(REVIEW_FIXTURE);
  const accepted = [
    { argv: ["accept", "oc_eval_impl01"] },
    { argv: ["result", "oc_eval_impl01", "--diff"] },
    { argv: ["reject", "oc_eval_impl01"] },
  ];
  const scored = scoreRun(fixture, accepted);
  assert.equal(scored.pass, false, "accepting before reviewing must fail");
  const byId = Object.fromEntries(scored.results.map((r) => [r.id, r.ok]));
  assert.equal(byId["extracts-diff"], true, "the diff was extracted");
  assert.equal(byId["reviews-before-accepting"], false, "but only after accepting");
  assert.equal(byId["does-not-accept-defect"], false, "and the flagged changeset was accepted");
});

test("report names the failing criterion rather than reporting a bare FAIL", () => {
  const fixture = loadFixture(REVIEW_FIXTURE);
  const report = formatReport(fixture, scoreRun(fixture, []));
  assert.match(report, /^FAIL {2}reviewer-visibility/u);
  assert.match(report, /extracts-diff/u);
  assert.match(report, /no invocation contained/u);
});

test("scorer rejects a fixture using an unknown check kind", () => {
  assert.throws(
    () => scoreRun({ name: "x", checks: [{ id: "a", description: "d", kind: "notAKind" }] }, []),
    /unknown check kind: notAKind/u
  );
});
