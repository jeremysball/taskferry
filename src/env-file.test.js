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

  test("allows an empty double- or single-quoted value", () => {
    assert.deepEqual(parseEnvFile('FOO=""\n'), { FOO: "" });
    assert.deepEqual(parseEnvFile("FOO=''\n"), { FOO: "" });
  });

  test("strips matching single quotes literally, no unescaping", () => {
    assert.deepEqual(parseEnvFile("FOO='bar \\n baz'\n"), { FOO: "bar \\n baz" });
  });

  test("throws on an unterminated double-quoted value instead of returning the leading quote as data", () => {
    assert.throws(
      () => parseEnvFile('API_KEY="unterminated\n', "/tmp/x.env"),
      /\/tmp\/x\.env:1:.*unterminated double-quoted value/
    );
  });

  test("throws on an unterminated single-quoted value", () => {
    assert.throws(
      () => parseEnvFile("FOO='unterminated\n", "/tmp/x.env"),
      /\/tmp\/x\.env:1:.*unterminated single-quoted value/
    );
  });

  test("throws on a lone opening quote with no other characters", () => {
    assert.throws(() => parseEnvFile('FOO="\n'), /unterminated double-quoted value/);
  });

  test("does not embed the raw line content in the unterminated-quote error, since the value is a secret", () => {
    try {
      parseEnvFile('API_KEY="sk-super-secret-value\n');
      assert.fail("expected parseEnvFile to throw");
    } catch (err) {
      assert.doesNotMatch(err.message, /sk-super-secret-value/);
    }
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

  test("does not embed the raw line content in a missing-'=' error, since a bare secret could be the whole line", () => {
    try {
      parseEnvFile("sk-a-bare-secret-pasted-with-no-name-prefix\n");
      assert.fail("expected parseEnvFile to throw");
    } catch (err) {
      assert.doesNotMatch(err.message, /sk-a-bare-secret-pasted-with-no-name-prefix/);
    }
  });

  test("throws on an invalid env var name", () => {
    assert.throws(() => parseEnvFile("1FOO=bar\n", "/tmp/x.env"), /\/tmp\/x\.env:1:.*invalid env var name/);
    assert.throws(() => parseEnvFile("FOO-BAR=bar\n"), /invalid env var name/);
  });
});

describe("loadEnvFile()", () => {
  const ownerOnlyStatFn = () => ({ mode: 0o100600 });

  test("reads and parses the file at the given path", () => {
    const reads = [];
    const result = loadEnvFile("/fake/path.env", {
      readFileFn: (p, enc) => {
        reads.push([p, enc]);
        return "FOO=bar\n";
      },
      statFn: ownerOnlyStatFn,
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

  test("throws when the file is group-readable", () => {
    const readFileFn = () => "FOO=bar\n";
    const statFn = () => ({ mode: 0o100640 });
    assert.throws(
      () => loadEnvFile("/fake/group-readable.env", { readFileFn, statFn }),
      /\/fake\/group-readable\.env is readable by group or other \(mode 640\)/
    );
  });

  test("throws when the file is other-readable", () => {
    const readFileFn = () => "FOO=bar\n";
    const statFn = () => ({ mode: 0o100644 });
    assert.throws(
      () => loadEnvFile("/fake/other-readable.env", { readFileFn, statFn }),
      /readable by group or other \(mode 644\)/
    );
  });

  test("accepts an owner-only 0600 file", () => {
    const readFileFn = () => "FOO=bar\n";
    const result = loadEnvFile("/fake/secure.env", { readFileFn, statFn: ownerOnlyStatFn });
    assert.deepEqual(result, { FOO: "bar" });
  });
});
