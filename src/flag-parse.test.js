import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePositiveIntFlag } from "./flag-parse.js";

const FLAG = "--max-response-bytes";

test("parsePositiveIntFlag reads the space and equals forms and ignores unrelated args", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "2048"], FLAG), 2048);
  assert.equal(parsePositiveIntFlag([`${FLAG}=2048`], FLAG), 2048);
  assert.equal(parsePositiveIntFlag(["--other", "1", FLAG, "7"], FLAG), 7);
  assert.equal(parsePositiveIntFlag(["--other", "1"], FLAG), undefined);
  assert.equal(parsePositiveIntFlag([], FLAG), undefined);
});

test("parsePositiveIntFlag rejects a repeated flag in either form", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "10"], FLAG), 10);
  assert.throws(() => parsePositiveIntFlag([FLAG, "10", FLAG, "20"], FLAG), /duplicate flag --max-response-bytes/);
  assert.throws(() => parsePositiveIntFlag([`${FLAG}=10`, `${FLAG}=20`], FLAG), /duplicate flag --max-response-bytes/);
  assert.throws(() => parsePositiveIntFlag([FLAG, "10", `${FLAG}=20`], FLAG), /duplicate flag --max-response-bytes/);
});

test("parsePositiveIntFlag rejects a flag with no value", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "10"], FLAG), 10);
  assert.throws(() => parsePositiveIntFlag([FLAG], FLAG), /--max-response-bytes requires a value/);
  assert.throws(() => parsePositiveIntFlag(["--other", FLAG], FLAG), /requires a value/);
  assert.throws(() => parsePositiveIntFlag([FLAG, "--other", "1"], FLAG), /requires a value/);
  assert.throws(() => parsePositiveIntFlag([`${FLAG}=`], FLAG), /requires a non-empty value/);
});

test("parsePositiveIntFlag accepts only positive digit strings", () => {
  assert.equal(parsePositiveIntFlag([FLAG, "1"], FLAG), 1);
  for (const raw of ["1e3", "0x10", " 5", "5 ", "+5", "5.0", "-5", "0", "abc", "9007199254740993"]) {
    assert.throws(() => parsePositiveIntFlag([FLAG, raw], FLAG), /--max-response-bytes must be (an|a positive) integer/, `space form should reject ${JSON.stringify(raw)}`);
    assert.throws(() => parsePositiveIntFlag([`${FLAG}=${raw}`], FLAG), /--max-response-bytes must be (an|a positive) integer/, `equals form should reject ${JSON.stringify(raw)}`);
  }
});
