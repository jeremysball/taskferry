import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnvFile, loadEnvFile, watchEnvFile } from "./env-file.js";

const trackedTmpDirs = [];
after(() => {
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


const X_ENV_PATH = "/tmp/x.env";
const ENV_WATCH_TEST_PREFIX = "env-file-watch-test-";
const SECRETS_ENV_NAME = "secrets.env";

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
      () => parseEnvFile('API_KEY="unterminated\n', X_ENV_PATH),
      /\/tmp\/x\.env:1:.*unterminated double-quoted value/
    );
  });

  test("throws on an unterminated single-quoted value", () => {
    assert.throws(
      () => parseEnvFile("FOO='unterminated\n", X_ENV_PATH),
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
    assert.throws(() => parseEnvFile("FOO=bar\nNOT_A_PAIR\n", X_ENV_PATH), /\/tmp\/x\.env:2:.*expected NAME=VALUE/);
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
    assert.throws(() => parseEnvFile("1FOO=bar\n", X_ENV_PATH), /\/tmp\/x\.env:1:.*invalid env var name/);
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

describe("watchEnvFile()", () => {
  function tmpEnvFile(initialContents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), ENV_WATCH_TEST_PREFIX));
    trackedTmpDirs.push(dir);
    const filePath = path.join(dir, SECRETS_ENV_NAME);
    fs.writeFileSync(filePath, initialContents, { mode: 0o600 });
    return { dir, filePath };
  }

  // Real fs, real fs.watch, real mktemp+rename -- the exact rewrite pattern
  // secrets-unlock uses -- rather than an injected watchFn. A mocked
  // watchFn would only prove the reload/debounce logic is internally
  // consistent, not that it survives the inode swap a real rename causes,
  // which is the entire reason this watches the parent directory instead
  // of the file itself.
  test("reloads after a real mktemp+rename over the watched file", async () => {
    const { dir, filePath } = tmpEnvFile("FOO=before\n");
    const reloads = [];
    const handle = watchEnvFile(filePath, {
      debounceMs: 10,
      onReload: (vars) => reloads.push(vars),
      onError: (e) => assert.fail(e),
    });

    const tmpPath = path.join(dir, "secrets.env.tmp");
    fs.writeFileSync(tmpPath, "FOO=after\n", { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);

    let lastReload = reloads.at(-1);
    for (let i = 0; i < 50 && lastReload?.FOO !== "after"; i++) {
      await sleep(20);
      lastReload = reloads.at(-1);
    }
    assert.deepEqual(lastReload, { FOO: "after" });

    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("does not call onReload for changes to an unrelated file in the same directory", async () => {
    const { dir, filePath } = tmpEnvFile("FOO=stable\n");
    let reloadCount = 0;
    const handle = watchEnvFile(filePath, {
      debounceMs: 10,
      onReload: () => { reloadCount++; },
      onError: (e) => assert.fail(e),
    });

    fs.writeFileSync(path.join(dir, "unrelated-file.txt"), "noise\n");
    await sleep(150);
    assert.equal(reloadCount, 0);

    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("close() stops further reloads", async () => {
    const { dir, filePath } = tmpEnvFile("FOO=before\n");
    let reloadCount = 0;
    const handle = watchEnvFile(filePath, {
      debounceMs: 10,
      onReload: () => { reloadCount++; },
      onError: (e) => assert.fail(e),
    });
    handle.close();

    fs.writeFileSync(filePath, "FOO=after-close\n");
    await sleep(150);
    assert.equal(reloadCount, 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Injected loadEnvFileFn/watchFn from here down: exercising a real
  // permission-regression or real fs.watch() ENOENT is loadEnvFile()'s and
  // fs.watch()'s own job to cover, not this module's reload-vs-error
  // routing logic.
  test("routes a reload failure to onError and keeps the watch alive for the next change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), ENV_WATCH_TEST_PREFIX));
    trackedTmpDirs.push(dir);
    const filePath = path.join(dir, SECRETS_ENV_NAME);
    let call = 0;
    const errors = [];
    const reloads = [];

    const handle = watchEnvFile(filePath, {
      debounceMs: 10,
      loadEnvFileFn: () => {
        call++;
        if (call === 1) throw new Error("mid-rename read failure");
        return { FOO: "recovered" };
      },
      onReload: (vars) => reloads.push(vars),
      onError: (e) => errors.push(e),
      watchFn: (dirPath, listener) => fs.watch(dirPath, listener),
    });

    fs.writeFileSync(filePath, "FOO=first\n");
    for (let i = 0; i < 50 && errors.length === 0; i++) await sleep(20);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /mid-rename read failure/);
    assert.equal(reloads.length, 0);

    fs.writeFileSync(filePath, "FOO=second\n");
    for (let i = 0; i < 50 && reloads.length === 0; i++) await sleep(20);
    assert.deepEqual(reloads[0], { FOO: "recovered" });

    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("coalesces a burst of rapid changes into a single reload via the debounce window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), ENV_WATCH_TEST_PREFIX));
    trackedTmpDirs.push(dir);
    const filePath = path.join(dir, SECRETS_ENV_NAME);
    fs.writeFileSync(filePath, "FOO=0\n");
    let loadCalls = 0;
    const handle = watchEnvFile(filePath, {
      debounceMs: 100,
      loadEnvFileFn: () => { loadCalls++; return { FOO: String(loadCalls) }; },
      onReload: () => {},
      onError: (e) => assert.fail(e),
      watchFn: (dirPath, listener) => fs.watch(dirPath, listener),
    });

    for (let i = 1; i <= 5; i++) fs.writeFileSync(filePath, `FOO=${i}\n`);
    await sleep(300);
    assert.equal(loadCalls, 1, "five rapid writes within one debounce window must trigger exactly one reload");

    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
