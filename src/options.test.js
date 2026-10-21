import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNonNegativeIntOption, resolvePositiveIntOption } from "./options.js";

const ENV_NAME = "TASKFERRY_MAX_RESPONSE_BYTES";

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
