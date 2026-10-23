import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { instructionsDestFor, pickInstructionsFile } from "./executor-shared.js";

const regularFile = { isFile: () => true };
const statAll = (kind) => () => kind;
const AGENTS_A = "/a/AGENTS.md";
const AGENTS_B = "/b/AGENTS.md";
const CLAUDE_A = "/a/CLAUDE.md";
const CLAUDE_OK = "/ok/CLAUDE.md";

describe("pickInstructionsFile", () => {
  test("AGENTS.md beats CLAUDE.md whichever is listed first, and the loser is returned as ignored", () => {
    assert.deepEqual(pickInstructionsFile([CLAUDE_A, AGENTS_B], statAll(regularFile)), {
      chosen: AGENTS_B,
      ignored: [CLAUDE_A],
    });
  });

  test("within one name the first listed wins and the rest are ignored", () => {
    assert.deepEqual(pickInstructionsFile([AGENTS_A, AGENTS_B], statAll(regularFile)), {
      chosen: AGENTS_A,
      ignored: [AGENTS_B],
    });
  });

  test("a path listed twice is one file, not a rival of itself", () => {
    assert.deepEqual(pickInstructionsFile([AGENTS_A, AGENTS_A], statAll(regularFile)), {
      chosen: AGENTS_A,
      ignored: [],
    });
  });

  test("only a regular file counts: a directory, a FIFO, and a missing path are all skipped", () => {
    const stats = new Map([
      ["/dir/AGENTS.md", { isFile: () => false, isDirectory: () => true }],
      ["/fifo/AGENTS.md", { isFile: () => false, isFIFO: () => true }],
      [CLAUDE_OK, regularFile],
    ]);
    const statFn = (p) => stats.get(p) ?? null;
    assert.deepEqual(pickInstructionsFile(["/dir/AGENTS.md", "/fifo/AGENTS.md", "/gone/AGENTS.md", CLAUDE_OK], statFn), {
      chosen: CLAUDE_OK,
      ignored: [],
    });
  });

  test("only the exact names count: lookalikes and other files are skipped, and nothing chosen is null", () => {
    assert.deepEqual(pickInstructionsFile(["/a/agents.md", "/a/AGENTS.md.backup", "/a/NOTES.md"], statAll(regularFile)), {
      chosen: null,
      ignored: [],
    });
  });
});

describe("instructionsDestFor", () => {
  test("is AGENTS.md inside the sandboxed config dir", () => {
    assert.equal(instructionsDestFor("/sandbox/config/opencode"), "/sandbox/config/opencode/AGENTS.md");
  });
});
