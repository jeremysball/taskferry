import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeManager, baseTask, DIFF_LINE } from "./tasks.test-helpers.js";

describe("result() diff field", () => {
  test("returns the cached patch text for fields: ['diff']", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_diff", logPath: path.join(logDir, "t_diff.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_diff.patch"),
      }],
      logs: { "t_diff.ndjson": "" },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_diff.patch"), DIFF_LINE);
    const result = mgr.result("t_diff", { fields: ["diff"] });
    assert.equal(result.diff, DIFF_LINE);
  });

  test("returns null for a task with no diffPath", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t_no_diff" })] });
    const result = mgr.result("t_no_diff", { fields: ["diff"] });
    assert.equal(result.diff, null);
  });
});

// Split out of tasks.lifecycle.test.js's "result() diffStat field" describe —
// that file is at its line-count ceiling.
describe("result() diffStat field — parseNumstatLine hardening", () => {
  test("rejects numstat tokens isNaN doesn't catch: Infinity/negative/fractional/hex/scientific/signed/blank", () => {
    const bad = "Infinity\t3\tx\n5\t-3\tx\n5.5\t3\tx\n0x10\t2\tx\n1e3\t2\tx\n+5\t-3\tx\n\t\t\n-\t-\tx\n";
    const mgr = makeManager({
      tasksFixture: (logDir) => [{ ...baseTask({ id: "t_bad", logPath: path.join(logDir, "t_bad.ndjson") }), diffPath: path.join(logDir, "..", "diffs", "t_bad.patch") }],
      logs: { "t_bad.ndjson": "" },
      runOverlayCommandFn: (command, args) =>
        command === "git" && args[0] === "apply" && args[1] === "--numstat"
          ? { status: 0, stdout: bad, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_bad.patch"), "diff --git a/x b/x\n");
    assert.deepEqual(mgr.result("t_bad", { fields: ["diffStat"] }).diffStat, { files: 0, additions: 0, deletions: 0 });
  });
});
