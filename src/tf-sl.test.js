import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const STATUSLINE = fileURLToPath(new URL("./tf-sl.sh", import.meta.url));
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
const REFRESH_DID_NOT_PUBLISH = "background refresh did not publish a snapshot";
const trackedRoots = [];

after(() => {
  for (const root of trackedRoots) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(destination, contents) {
  fs.writeFileSync(destination, contents, { mode: 0o755 });
}

function makeFixture({ delaySeconds = "0.40" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-statusline-test-"));
  trackedRoots.push(root);
  const bin = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  const runtime = path.join(root, "runtime");
  const cache = path.join(root, "cache");
  const home = path.join(root, "home");
  const callLog = path.join(root, "calls.log");
  for (const directory of [bin, workspace, state, runtime, cache, home]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  writeExecutable(path.join(bin, "timeout"), `#!/usr/bin/env bash
shift
exec "$@"
`);
  writeExecutable(path.join(bin, "taskferry"), `#!/usr/bin/env bash
[ "$TASKFERRY_AUTO_START" = 0 ] || exit 91
printf '%s\\n' "$*" >> "$TASKFERRY_TEST_CALL_LOG"
sleep "$TASKFERRY_TEST_DELAY_SECONDS"
[ "${"$"}{TASKFERRY_TEST_FAIL:-0}" = 1 ] && exit 1
case "${"$"}1" in
  list)
    printf '%s\\n' '  running: 1' '  queued: 2' '  oc_12345678,running'
    ;;
  status)
    printf '%s\\n' 'summarizedActivity: "Indexing files"'
    ;;
esac
`);

  return {
    root,
    workspace,
    callLog,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      XDG_STATE_HOME: path.join(root, "xdg-state"),
      XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      TASKFERRY_STATE_DIR: state,
      TASKFERRY_RUNTIME_DIR: runtime,
      TASKFERRY_CACHE_DIR: cache,
      TASKFERRY_SOCKET_PATH: path.join(runtime, "taskferry.sock"),
      TASKFERRY_TEST_CALL_LOG: callLog,
      TASKFERRY_TEST_DELAY_SECONDS: delaySeconds,
      COLUMNS: "120",
    },
  };
}

function runStatusline(fixture, env = {}) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const child = execFile("/bin/bash", [STATUSLINE], {
      env: { ...fixture.env, ...env },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`tf-sl failed: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, durationMs: performance.now() - startedAt });
    });
    child.stdin.end(JSON.stringify({ cwd: fixture.workspace }));
  });
}

function readCalls(fixture) {
  try {
    return fs.readFileSync(fixture.callLog, "utf8").trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function findSnapshot(fixture) {
  const statuslineCache = path.join(fixture.env.TASKFERRY_CACHE_DIR, "statusline");
  try {
    return fs.readdirSync(statuslineCache)
      .map((entry) => path.join(statuslineCache, entry))
      .find((entry) => entry.endsWith(".snapshot"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return assert.fail(message);
}

test("returns a cold statusline immediately, then renders the cached task", async () => {
  const fixture = makeFixture();
  const first = await runStatusline(fixture);
  assert.equal(first.stdout, "");
  assert.ok(first.durationMs < 250, `cold poll took ${first.durationMs.toFixed(1)}ms`);

  await waitFor(() => findSnapshot(fixture), REFRESH_DID_NOT_PUBLISH);
  const second = await runStatusline(fixture);
  assert.match(second.stdout.replace(ANSI_RE, ""), /^tf:12345678 running \(1r\/2q\)$/);
  assert.deepEqual(readCalls(fixture), [
    `list --directory ${fixture.workspace} --limit 5`,
    "status oc_12345678",
  ]);
});

test("deduplicates concurrent cold-cache refreshes", async () => {
  const fixture = makeFixture();
  const results = await Promise.all([runStatusline(fixture), runStatusline(fixture)]);
  assert.deepEqual(results.map((result) => result.stdout), ["", ""]);
  assert.ok(results.every((result) => result.durationMs < 250));

  await waitFor(() => findSnapshot(fixture), REFRESH_DID_NOT_PUBLISH);
  const calls = readCalls(fixture);
  assert.equal(calls.filter((call) => call.startsWith("list ")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("status ")).length, 1);
});

test("does not render a snapshot past the stale limit", async () => {
  const fixture = makeFixture({ delaySeconds: "0.10" });
  await runStatusline(fixture);
  await waitFor(() => findSnapshot(fixture), REFRESH_DID_NOT_PUBLISH);

  const snapshot = findSnapshot(fixture);
  assert.ok(snapshot, "statusline snapshot was not published");
  const lines = fs.readFileSync(snapshot, "utf8").split("\n");
  lines[0] = "1";
  fs.writeFileSync(snapshot, lines.join("\n"));

  const stale = await runStatusline(fixture, { TASKFERRY_TEST_FAIL: "1" });
  assert.equal(stale.stdout, "");
  await waitFor(
    () => readCalls(fixture).filter((call) => call.startsWith("list ")).length === 2,
    "stale poll did not schedule a refresh",
  );
  await waitFor(() => !fs.existsSync(`${snapshot}.lock`), "failed refresh did not release its lock");
});
