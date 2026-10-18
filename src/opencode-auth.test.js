import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { opencodeExecutor } from "./opencode-executor.js";

const SYNTHETIC_KEY = "synthetic-key";
const SYNTHETIC_ACCESS = "synthetic-access";

function fixture(t, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-auth-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "data");
  fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
  if (auth !== null) fs.writeFileSync(path.join(data, "opencode", "auth.json"), JSON.stringify(auth));
  const trace = path.join(dir, "trace.jsonl");
  fs.writeFileSync(trace, "");
  const binary = path.join(dir, "opencode");
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const importing = args[0] === 'auth' && args[1] === 'import';
const input = importing ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync(process.env.TEST_AUTH_TRACE, JSON.stringify({args, input, dataHome:process.env.XDG_DATA_HOME})+'\\n');
if(importing && process.env.TEST_IMPORT_FAIL){console.error('synthetic-private-provider-error');process.exit(1);}
if(!importing)process.exit(Number(process.env.TEST_RUN_EXIT || 0));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, XDG_DATA_HOME: data, TEST_AUTH_TRACE: trace };
  const args = ["run", "--standalone", "-m", "openai/gpt-6-luna#xhigh", "--", "do not use tools"];
  return {
    data, env, args,
    run(major = 2) {
      const executor = opencodeExecutor({ detectCliMajorFn: () => major });
      const launchArgs = major === 1 ? ["run", "--dir", dir, "-m", "openai/gpt-6-luna", "--", "do not use tools"] : args;
      const command = executor.buildSandboxSpawn?.(launchArgs) ?? [executor.binaryName, ...launchArgs];
      return spawnSync(command[0], command.slice(1), { env, encoding: "utf8", timeout: 10000 });
    },
    rows: () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

test("V2 imports selected OpenAI OAuth through stdin before the model run", t => {
  const f = fixture(t, { openai: { type: "oauth", access: SYNTHETIC_ACCESS, refresh: "synthetic-refresh", expires: 2000000000000, accountId: "account-test" }, other: { type: "api", key: "unrelated-secret" } });
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  const rows = f.rows();
  assert.deepEqual(rows.map(row => row.args[0]), ["auth", "run"]);
  assert.deepEqual(rows[0].args, ["auth", "import", "--standalone"]);
  assert.equal(rows[0].input.length, 1);
  assert.equal(rows[0].input[0].integrationID, "openai");
  assert.deepEqual(rows[0].input[0].value, { type: "oauth", methodID: "chatgpt-browser", access: SYNTHETIC_ACCESS, refresh: "synthetic-refresh", expires: 2000000000000, metadata: { accountID: "account-test" } });
  assert.deepEqual(rows[1].args, f.args);
  assert.equal(rows[0].dataHome, f.data);
  assert.equal(JSON.stringify(rows.map(row => row.args)).includes(SYNTHETIC_ACCESS), false);
});

test("V2 maps a legacy API key to the supported credential key schema", t => {
  const f = fixture(t, { openai: { type: "api", key: SYNTHETIC_KEY } });
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.rows()[0].input?.[0]?.value, { type: "key", key: SYNTHETIC_KEY });
});

test("failed import stops before model execution and suppresses credential-bearing diagnostics", t => {
  const f = fixture(t, { openai: { type: "api", key: SYNTHETIC_KEY } });
  f.env.TEST_IMPORT_FAIL = "1";
  const run = f.run();
  assert.notEqual(run.status, 0);
  assert.deepEqual(f.rows().map(row => row.args[0]), ["auth"]);
  assert.match(run.stderr, /credential import failed/i);
  assert.equal(run.stderr.includes("synthetic-private-provider-error"), false);
});

test("V1 retains its existing auth-file path without importing", t => {
  const f = fixture(t, { openai: { type: "api", key: SYNTHETIC_KEY } });
  assert.equal(f.run(1).status, 0);
  assert.deepEqual(f.rows().map(row => row.args[0]), ["run"]);
});

test("V2 without a selected legacy credential still allows environment authentication", t => {
  const f = fixture(t, null);
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.rows().map(row => row.args[0]), ["run"]);
});

test("V2 bootstrap stays paired with V2 argv after the version cache expires", () => {
  let cached = 2;
  const executor = opencodeExecutor({ detectCliMajorFn: () => cached });
  const args = executor.buildSpawnArgs({ directory: ".", model: "openai/gpt-6-luna", prompt: "test" });
  cached = null;
  assert.equal(executor.buildSandboxSpawn(args)[0], process.execPath);
});
