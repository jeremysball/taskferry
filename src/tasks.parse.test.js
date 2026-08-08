import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseEnvDenylist, parseSandboxDenylist, parseProviderLimitsEnv } from "./tasks.js";

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

describe("parseProviderLimitsEnv()", () => {
  test("returns an empty Map for undefined or empty input", () => {
    assert.deepEqual(parseProviderLimitsEnv(undefined), new Map());
    assert.deepEqual(parseProviderLimitsEnv(""), new Map());
  });

  test("parses a single provider:concurrency entry with an unbounded dispatch limit", () => {
    const result = parseProviderLimitsEnv("minimax:4");
    assert.deepEqual(result, new Map([["minimax", { concurrencyLimit: 4, dispatchLimit: Infinity }]]));
  });

  test("parses a provider:concurrency:dispatchesPerWindow entry", () => {
    const result = parseProviderLimitsEnv("minimax:4:10");
    assert.deepEqual(result, new Map([["minimax", { concurrencyLimit: 4, dispatchLimit: 10 }]]));
  });

  test("parses multiple comma-separated entries, trimming whitespace", () => {
    const result = parseProviderLimitsEnv("minimax:4:10, ollama:3");
    assert.deepEqual(result, new Map([
      ["minimax", { concurrencyLimit: 4, dispatchLimit: 10 }],
      ["ollama", { concurrencyLimit: 3, dispatchLimit: Infinity }],
    ]));
  });

  test("throws error:/help: on an empty provider name", () => {
    assert.throws(() => parseProviderLimitsEnv(":4"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry ":4": empty provider name\nhelp:/);
  });

  test("throws error:/help: on a non-integer concurrency limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:four"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry "minimax:four": maxConcurrentTasks must be a positive integer\nhelp:/);
  });

  test("throws error:/help: on a zero concurrency limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:0"), /maxConcurrentTasks must be a positive integer/);
  });

  test("throws error:/help: on a non-integer dispatch-window limit", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:4:x"), /maxDispatchesPerWindow must be a positive integer/);
  });

  test("throws error:/help: on more than three colon-separated fields", () => {
    assert.throws(() => parseProviderLimitsEnv("minimax:4:10:20"), /error: malformed TASKFERRY_PROVIDER_LIMITS entry "minimax:4:10:20"\nhelp:/);
  });
});
