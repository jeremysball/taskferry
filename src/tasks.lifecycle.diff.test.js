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

describe("result() diffStat field", () => {
  test("ignores malformed numstat counts without corrupting valid totals", () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [{
        ...baseTask({ id: "t_stat", logPath: path.join(logDir, "t_stat.ndjson") }),
        diffPath: path.join(logDir, "..", "diffs", "t_stat.patch"),
      }],
      logs: { "t_stat.ndjson": "" },
      runOverlayCommandFn: () => ({
        status: 0,
        stdout: [
          "2\t1\tvalid.txt",
          "Infinity\t3\tinfinite.txt",
          "5\t-3\tnegative.txt",
          "5.5\t3\tfractional.txt",
          "0x10\t2\thex.txt",
          "1e3\t2\texponent.txt",
          "+5\t3\tsigned.txt",
          "\t\t",
          "-\t-\tbinary.dat",
          "9007199254740992\t1\tunsafe.txt",
          "",
        ].join("\n"),
        stderr: "",
      }),
    });
    fs.mkdirSync(path.join(mgr.paths.STATE_DIR, "diffs"), { recursive: true });
    fs.writeFileSync(path.join(mgr.paths.STATE_DIR, "diffs", "t_stat.patch"), DIFF_LINE);

    assert.deepEqual(mgr.result("t_stat", { fields: ["diffStat"] }).diffStat, {
      files: 1,
      additions: 2,
      deletions: 1,
    });
  });
});
