import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, loadEnvFile } from "./env-file.js";

describe("parseEnvFile()", () => {
  test("parses simple NAME=VALUE pairs", () => {
    assert.deepEqual(parseEnvFile("FOO=bar\nBAZ=qux\n"), { FOO: "bar", BAZ: "qux" });
  });

  test("skips blank lines and comment lines", () => {
    assert.deepEqual(parseEnvFile("\n# a comment\nFOO=bar\n   \n#another\n"), { FOO: "bar" });
  });

  test("strips a leading 'export ' prefix", () => {
    assert.deepEqual(parseEnvFile("export FOO=bar\n"), { FOO: "bar" });
  });

  test("trims surrounding whitespace around name and value", () => {
    assert.deepEqual(parseEnvFile("  FOO  =  bar  \n"), { FOO: "bar" });
  });

  test("strips matching double quotes and unescapes \\\" and \\\\", () => {
    assert.deepEqual(parseEnvFile('FOO="bar baz"\n'), { FOO: "bar baz" });
    assert.deepEqual(parseEnvFile('FOO="a \\"quoted\\" value"\n'), { FOO: 'a "quoted" value' });
    assert.deepEqual(parseEnvFile('FOO="back\\\\slash"\n'), { FOO: "back\\slash" });
  });

  test("strips matching single quotes literally, no unescaping", () => {
    assert.deepEqual(parseEnvFile("FOO='bar \\n baz'\n"), { FOO: "bar \\n baz" });
  });

  test("takes an unquoted value verbatim, including '#'", () => {
    assert.deepEqual(parseEnvFile("FOO=bar#not-a-comment\n"), { FOO: "bar#not-a-comment" });
  });

  test("allows an empty value", () => {
    assert.deepEqual(parseEnvFile("FOO=\n"), { FOO: "" });
  });

  test("last write wins on a duplicate name", () => {
    assert.deepEqual(parseEnvFile("FOO=first\nFOO=second\n"), { FOO: "second" });
  });

  test("handles CRLF line endings", () => {
    assert.deepEqual(parseEnvFile("FOO=bar\r\nBAZ=qux\r\n"), { FOO: "bar", BAZ: "qux" });
  });

  test("returns {} for empty input", () => {
    assert.deepEqual(parseEnvFile(""), {});
  });

  test("throws on a line with no '='", () => {
    assert.throws(() => parseEnvFile("FOO=bar\nNOT_A_PAIR\n", "/tmp/x.env"), /\/tmp\/x\.env:2:.*expected NAME=VALUE/);
  });

  test("throws on an invalid env var name", () => {
    assert.throws(() => parseEnvFile("1FOO=bar\n", "/tmp/x.env"), /\/tmp\/x\.env:1:.*invalid env var name/);
    assert.throws(() => parseEnvFile("FOO-BAR=bar\n"), /invalid env var name/);
  });
});

describe("loadEnvFile()", () => {
  test("reads and parses the file at the given path", () => {
    const reads = [];
    const result = loadEnvFile("/fake/path.env", {
      readFileFn: (p, enc) => {
        reads.push([p, enc]);
        return "FOO=bar\n";
      },
    });
    assert.deepEqual(result, { FOO: "bar" });
    assert.deepEqual(reads, [["/fake/path.env", "utf8"]]);
  });

  test("throws a clear error when the file doesn't exist", () => {
    const readFileFn = () => {
      const err = new Error("nope");
      err.code = "ENOENT";
      throw err;
    };
    assert.throws(() => loadEnvFile("/fake/missing.env", { readFileFn }), /env file not found: \/fake\/missing\.env/);
  });

  test("rethrows non-ENOENT read errors unchanged", () => {
    const readFileFn = () => {
      const err = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    };
    assert.throws(() => loadEnvFile("/fake/denied.env", { readFileFn }), /permission denied/);
  });
});
