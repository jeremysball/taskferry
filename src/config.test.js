import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, loadConfig } from "./config.js";

const trackedTmpDirs = [];
after(() => {
  for (const d of trackedTmpDirs) fs.rmSync(d, { recursive: true, force: true });
});


const CONFIG_FILENAME = "config.json";

function tmpConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axi-config-test-")); trackedTmpDirs.push(dir); return dir;
}

function writeConfig(dir, content) {
  const configDir = path.join(dir, "taskferry");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, CONFIG_FILENAME);
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe("resolveConfigPath()", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    const result = resolveConfigPath({ XDG_CONFIG_HOME: "/xdg-config" });
    assert.equal(result, path.join("/xdg-config", "taskferry", CONFIG_FILENAME));
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const result = resolveConfigPath({});
    assert.equal(result, path.join(os.homedir(), ".config", "taskferry", CONFIG_FILENAME));
  });
});

describe("loadConfig()", () => {
  test("returns {} when the file is missing", () => {
    const dir = tmpConfigDir();
    const configPath = path.join(dir, "taskferry", CONFIG_FILENAME);
    assert.deepEqual(loadConfig({ configPath }), {});
  });

  test("returns the parsed object for a valid file", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ maxConcurrentTasks: 8, summaryModel: "opencode/mimo-v2.5-free" }));
    assert.deepEqual(loadConfig({ configPath }), { maxConcurrentTasks: 8, summaryModel: "opencode/mimo-v2.5-free" });
  });

  test("throws with error:/help: on malformed JSON", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, "{ not json");
    assert.throws(() => loadConfig({ configPath }), /error: could not parse.*\nhelp:/s);
  });

  test("throws on a non-object top-level value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, "[1, 2, 3]");
    assert.throws(() => loadConfig({ configPath }), /error: .*must be a JSON object.*\nhelp:/s);
  });

  test("throws on an unrecognized top-level key", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ notARealKey: 1 }));
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized config key "notARealKey".*\nhelp:/s);
  });

  test("throws on a wrong-typed field", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ maxConcurrentTasks: "4" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "maxConcurrentTasks".*must be a number.*\nhelp:/s);
  });

  test("rejects __proto__ as an unrecognized key (prototype-pollution guard)", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, '{"__proto__": null}');
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized config key "__proto__".*\nhelp:/s);
  });

  test("accepts a valid sandboxEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ sandboxEnabled: false }));
    assert.deepEqual(loadConfig({ configPath }), { sandboxEnabled: false });
  });

  test("rejects a wrong-typed sandboxEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ sandboxEnabled: "false" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "sandboxEnabled".*must be a boolean.*\nhelp:/s);
  });

  test("accepts a valid overlayEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ overlayEnabled: false }));
    assert.deepEqual(loadConfig({ configPath }), { overlayEnabled: false });
  });

  test("rejects a wrong-typed overlayEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ overlayEnabled: "false" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "overlayEnabled".*must be a boolean.*\nhelp:/s);
  });

  test("accepts a valid preOutputMaxMs value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ preOutputMaxMs: 600000 }));
    assert.deepEqual(loadConfig({ configPath }), { preOutputMaxMs: 600000 });
  });

  test("rejects a wrong-typed preOutputMaxMs value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ preOutputMaxMs: "600000" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "preOutputMaxMs".*must be a number.*\nhelp:/s);
  });

  test("accepts a valid lowerdirStaggerMs value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ lowerdirStaggerMs: 5000 }));
    assert.deepEqual(loadConfig({ configPath }), { lowerdirStaggerMs: 5000 });
  });

  test("rejects a wrong-typed lowerdirStaggerMs value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ lowerdirStaggerMs: "5000" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "lowerdirStaggerMs".*must be a number.*\nhelp:/s);
  });

  test("accepts a valid allowedDirs value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ allowedDirs: "/home/user/.cache/myapp,/opt/shared" }));
    assert.deepEqual(loadConfig({ configPath }), { allowedDirs: "/home/user/.cache/myapp,/opt/shared" });
  });

  test("rejects a wrong-typed allowedDirs value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ allowedDirs: ["/opt/shared"] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "allowedDirs".*must be a string.*\nhelp:/s);
  });

  test("accepts valid rwBind and roBind values", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ rwBind: "/opt/a,/opt/b", roBind: "/opt/ro" }));
    assert.deepEqual(loadConfig({ configPath }), { rwBind: "/opt/a,/opt/b", roBind: "/opt/ro" });
  });

  test("rejects a wrong-typed rwBind value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ rwBind: ["/opt/a"] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "rwBind".*must be a string.*\nhelp:/s);
  });

  test("rejects a wrong-typed roBind value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ roBind: ["/opt/ro"] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "roBind".*must be a string.*\nhelp:/s);
  });

  test("accepts a valid envDenylist value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ envDenylist: "PI_CODING_AGENT_DIR,SOME_OTHER_VAR" }));
    assert.deepEqual(loadConfig({ configPath }), { envDenylist: "PI_CODING_AGENT_DIR,SOME_OTHER_VAR" });
  });

  test("rejects a wrong-typed envDenylist value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ envDenylist: ["SOME_VAR"] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "envDenylist".*must be a string.*\nhelp:/s);
  });

  test("accepts a valid envFile value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ envFile: "/home/user/.config/taskferry/secrets.env" }));
    assert.deepEqual(loadConfig({ configPath }), { envFile: "/home/user/.config/taskferry/secrets.env" });
  });

  test("rejects a wrong-typed envFile value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ envFile: 123 }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "envFile".*must be a string.*\nhelp:/s);
  });

  test("accepts a valid profilingEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ profilingEnabled: true }));
    assert.deepEqual(loadConfig({ configPath }), { profilingEnabled: true });
  });

  test("rejects a wrong-typed profilingEnabled value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ profilingEnabled: "true" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "profilingEnabled".*must be a boolean.*\nhelp:/s);
  });

  test("accepts a valid sandboxDenylist value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ sandboxDenylist: "/home/user/.docker,/home/user/.kube" }));
    assert.deepEqual(loadConfig({ configPath }), { sandboxDenylist: "/home/user/.docker,/home/user/.kube" });
  });

  test("rejects a wrong-typed sandboxDenylist value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ sandboxDenylist: ["/home/user/.docker"] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "sandboxDenylist".*must be a string.*\nhelp:/s);
  });

  test("accepts a valid providerLimits value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxConcurrentTasks: 4, maxDispatchesPerWindow: 10 }, ollama: { maxConcurrentTasks: 3 } } }));
    assert.deepEqual(loadConfig({ configPath }), { providerLimits: { minimax: { maxConcurrentTasks: 4, maxDispatchesPerWindow: 10 }, ollama: { maxConcurrentTasks: 3 } } });
  });

  test("rejects a providerLimits value that isn't an object", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: "minimax:4" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits".*must be a object.*\nhelp:/s);
  });

  test("rejects a providerLimits array", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: [1, 2] }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits".*must be a JSON object.*\nhelp:/s);
  });

  test("rejects a providerLimits entry that isn't an object", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: 4 } }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits\.minimax".*must be a JSON object.*\nhelp:/s);
  });

  test("rejects an unrecognized key inside a providerLimits entry", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxRpm: 10 } } }));
    assert.throws(() => loadConfig({ configPath }), /error: unrecognized key "providerLimits\.minimax\.maxRpm".*\nhelp:/s);
  });

  test("rejects a non-positive-integer providerLimits value", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ providerLimits: { minimax: { maxConcurrentTasks: 0 } } }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "providerLimits\.minimax\.maxConcurrentTasks".*must be a positive integer.*\nhelp:/s);
  });

  test("accepts the highest sentinel for defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "highest" }));
    assert.deepEqual(loadConfig({ configPath }), { defaultVariant: "highest" });
  });

  test("accepts each of pi's concrete thinking levels for defaultVariant", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const dir = tmpConfigDir();
      const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: level }));
      assert.deepEqual(loadConfig({ configPath }), { defaultVariant: level });
    }
  });

  test("rejects an unrecognized defaultVariant string", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "medium-plus" }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant" in .* must be one of highest, off, minimal, low, medium, high, xhigh, max \(got "medium-plus"\)\nhelp:/);
  });

  test("rejects an empty or whitespace-only defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: "   " }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant".*must be one of/);
  });

  test("rejects a non-string defaultVariant", () => {
    const dir = tmpConfigDir();
    const configPath = writeConfig(dir, JSON.stringify({ defaultVariant: 5 }));
    assert.throws(() => loadConfig({ configPath }), /error: config key "defaultVariant" in .* must be a string \(got 5\)\nhelp:/);
  });
});
