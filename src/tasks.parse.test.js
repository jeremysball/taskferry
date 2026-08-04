import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseEnvDenylist, parseSandboxDenylist } from "./tasks.js";

describe("parseEnvDenylist()", () => {
  test("returns an empty array for an empty or undefined spec", () => {
    assert.deepEqual(parseEnvDenylist(undefined), []);
    assert.deepEqual(parseEnvDenylist(""), []);
  });

  test("splits, trims, and drops empty entries", () => {
    assert.deepEqual(parseEnvDenylist("FOO, BAR ,, BAZ"), ["FOO", "BAR", "BAZ"]);
  });
});

describe("parseSandboxDenylist()", () => {
  test("returns an empty array for an empty or undefined spec", () => {
    assert.deepEqual(parseSandboxDenylist(undefined), []);
    assert.deepEqual(parseSandboxDenylist(""), []);
  });

  test("splits, trims, and drops empty entries", () => {
    assert.deepEqual(parseSandboxDenylist("/home/user/.docker, /home/user/.kube ,, /opt/shared"), [
      "/home/user/.docker",
      "/home/user/.kube",
      "/opt/shared",
    ]);
  });
});
