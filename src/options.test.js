import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePositiveIntFlag, resolveNonNegativeIntOption, resolvePositiveIntOption } from "./options.js";

const FLAG = "--max-response-bytes";
const ENV_NAME = "TASKFERRY_MAX_RESPONSE_BYTES";

test("parsePositiveIntFlag reads the space and equals forms and ignores unrelated args", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "2048"], FLAG), 2048);
  assert.equal(parsePositiveIntFlag([`${FLAG}=2048`], FLAG), 2048);
  assert.equal(parsePositiveIntFlag(["--other", "1", FLAG, "7"], FLAG), 7);
  assert.equal(parsePositiveIntFlag(["--other", "1"], FLAG), undefined);
  assert.equal(parsePositiveIntFlag([], FLAG), undefined);
});

test("parsePositiveIntFlag rejects a repeated flag in either form instead of using the first value", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "10"], FLAG), 10);
  assert.throws(() => parsePositiveIntFlag([FLAG, "10", FLAG, "20"], FLAG), /duplicate flag --max-response-bytes/);
  assert.throws(() => parsePositiveIntFlag([`${FLAG}=10`, `${FLAG}=20`], FLAG), /duplicate flag --max-response-bytes/);
  assert.throws(() => parsePositiveIntFlag([FLAG, "10", `${FLAG}=20`], FLAG), /duplicate flag --max-response-bytes/);
});

test("parsePositiveIntFlag rejects a flag with no value instead of treating it as absent", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "10"], FLAG), 10);
  assert.throws(() => parsePositiveIntFlag([FLAG], FLAG), /--max-response-bytes needs a value \(got end of command line\)/);
  assert.throws(() => parsePositiveIntFlag(["--other", FLAG], FLAG), /needs a value \(got end of command line\)/);
  assert.throws(() => parsePositiveIntFlag([FLAG, "--other", "1"], FLAG), /needs a value \(got "--other"\)/);
});

test("parsePositiveIntFlag accepts only plain digit strings, like the CLI parser in args.js", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "1"], FLAG), 1);
  for (const raw of ["1e3", "0x10", " 5", "5 ", "+5", "5.0", "-5", "0", "", "abc", "9007199254740993"]) {
    assert.throws(
      () => parsePositiveIntFlag([FLAG, raw], FLAG),
      /--max-response-bytes must be a positive integer/,
      `space form should reject ${JSON.stringify(raw)}`
    );
    assert.throws(
      () => parsePositiveIntFlag([`${FLAG}=${raw}`], FLAG),
      /--max-response-bytes must be a positive integer/,
      `equals form should reject ${JSON.stringify(raw)}`
    );
  }
});

test("resolvePositiveIntOption applies flag > env > config > default", () => {
  assert.equal(resolvePositiveIntOption(5, "6", 7, 8), 5);
  assert.equal(resolvePositiveIntOption(undefined, "6", 7, 8), 6);
  assert.equal(resolvePositiveIntOption(undefined, undefined, 7, 8), 7);
  assert.equal(resolvePositiveIntOption(undefined, undefined, undefined, 8), 8);
});

test("resolvePositiveIntOption lets an empty or invalid env value fall through unless strictEnv is set", () => {
  assert.equal(resolvePositiveIntOption(undefined, "", 7, 8), 7);
  assert.equal(resolvePositiveIntOption(undefined, "abc", 7, 8), 7);
  assert.equal(resolvePositiveIntOption(undefined, "0", undefined, 8), 8);
  assert.equal(resolvePositiveIntOption(undefined, "", 7, 8, { strictEnv: true }), 7);
  assert.throws(
    () => resolvePositiveIntOption(undefined, "abc", 7, 8, { envVarName: ENV_NAME, strictEnv: true }),
    /error: TASKFERRY_MAX_RESPONSE_BYTES must be a positive integer \(got "abc"\)\nhelp: set a byte count like 2097152/
  );
  assert.throws(() => resolvePositiveIntOption(undefined, "0", 7, 8, { strictEnv: true }), /env var must be a positive integer/);
});

test("resolvePositiveIntOption ignores a non-positive config value", () => {
  assert.equal(resolvePositiveIntOption(undefined, undefined, 0, 8), 8);
  assert.equal(resolvePositiveIntOption(undefined, undefined, -3, 8), 8);
  assert.equal(resolvePositiveIntOption(undefined, undefined, 1.5, 8), 8);
});

test("resolveNonNegativeIntOption allows zero from every source", () => {
  assert.equal(resolveNonNegativeIntOption(0, "6", 7, 8), 0);
  assert.equal(resolveNonNegativeIntOption(undefined, "0", 7, 8), 0);
  assert.equal(resolveNonNegativeIntOption(undefined, undefined, 0, 8), 0);
  assert.equal(resolveNonNegativeIntOption(undefined, undefined, undefined, 8), 8);
});

test("resolveNonNegativeIntOption lets an empty or invalid env value fall through unless strictEnv is set", () => {
  assert.equal(resolveNonNegativeIntOption(undefined, "", 7, 8), 7);
  assert.equal(resolveNonNegativeIntOption(undefined, "-1", 7, 8), 7);
  assert.throws(
    () => resolveNonNegativeIntOption(undefined, "-1", 7, 8, { envVarName: ENV_NAME, strictEnv: true }),
    /error: TASKFERRY_MAX_RESPONSE_BYTES must be a non-negative integer \(got "-1"\)\nhelp: set a byte count like 0/
  );
});
