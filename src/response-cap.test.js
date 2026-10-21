import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { connectClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import { MAX_BUFFER_BYTES } from "./daemon-server.js";
import { resolveResponseCapBytes, resolveResponseCapRaw } from "./options.js";
import { readTaskOutputFile } from "./output-dir.js";
import { createTaskManager } from "./tasks.js";

const ENV_NAME = "TASKFERRY_MAX_RESPONSE_BYTES";

function scratch(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `taskferry-${prefix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function socketLocations(root) {
  const runtimeDir = path.join(root, "run");
  return { runtimeDir, socketPath: path.join(runtimeDir, "daemon.sock") };
}

function daemonPaths(t) {
  const root = scratch(t, "response-cap");
  return { root, stateDir: path.join(root, "state"), ...socketLocations(root) };
}

/** Task-manager factory that records the options the daemon hands it. */
function capturingFactory() {
  const seen = { options: null };
  const manager = {
    list: () => ({ counts: {}, tasks: [] }),
    setActivitySubscriptions() {},
    close() {},
  };
  return {
    seen,
    factory(options) {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      seen.options = options;
      return manager;
    },
  };
}

async function startCapturing(t, extra = {}) {
  const paths = daemonPaths(t);
  const fake = capturingFactory();
  const daemon = await startDaemon({ ...paths, env: {}, taskManagerFactory: fake.factory, ...extra });
  t.after(() => daemon.close());
  return { ...fake, daemon, paths };
}

describe("resolveResponseCapRaw", () => {
  test("prefers maxResponseBytes, then maxOutboundBytes, then maxBufferBytes", () => {
    assert.equal(resolveResponseCapRaw({ maxResponseBytes: 1, maxOutboundBytes: 2, maxBufferBytes: 3 }), 1);
    assert.equal(resolveResponseCapRaw({ maxOutboundBytes: 2, maxBufferBytes: 3 }), 2);
    assert.equal(resolveResponseCapRaw({ maxBufferBytes: 3 }), 3);
    assert.equal(resolveResponseCapRaw({}), undefined);
  });
});

describe("resolveResponseCapBytes", () => {
  test("applies option > env > config > default", () => {
    assert.equal(resolveResponseCapBytes({ maxResponseBytes: 10 }, "20", 30, 40), 10);
    assert.equal(resolveResponseCapBytes({}, "20", 30, 40), 20);
    assert.equal(resolveResponseCapBytes({}, undefined, 30, 40), 30);
    assert.equal(resolveResponseCapBytes({}, undefined, undefined, 40), 40);
  });

  test("an invalid env value throws naming the variable only under strictEnv", () => {
    assert.equal(resolveResponseCapBytes({}, "abc", 30, 40), 30);
    assert.throws(
      () => resolveResponseCapBytes({}, "abc", 30, 40, { strictEnv: true }),
      new RegExp(`${ENV_NAME} must be a positive integer \\(got "abc"\\)`)
    );
  });
});

describe("daemon response cap", () => {
  test("defaults to the 1 MiB ceiling and hands the same cap to the task manager", async (t) => {
    const { seen } = await startCapturing(t);
    assert.equal(seen.options.maxResponseBytes, MAX_BUFFER_BYTES);
  });

  test("an option raises the cap for the wire and the task manager", async (t) => {
    const { seen } = await startCapturing(t, { maxResponseBytes: 4 * MAX_BUFFER_BYTES });
    assert.equal(seen.options.maxResponseBytes, 4 * MAX_BUFFER_BYTES);
  });

  test("env raises the cap, and config raises it when env is unset", async (t) => {
    const fromEnv = await startCapturing(t, { env: { [ENV_NAME]: String(3 * MAX_BUFFER_BYTES) } });
    assert.equal(fromEnv.seen.options.maxResponseBytes, 3 * MAX_BUFFER_BYTES);
    const fromConfig = await startCapturing(t, { taskManagerOptions: { config: { maxResponseBytes: 5 * MAX_BUFFER_BYTES } } });
    assert.equal(fromConfig.seen.options.maxResponseBytes, 5 * MAX_BUFFER_BYTES);
  });

  test("option beats env beats config", async (t) => {
    const config = { maxResponseBytes: 2 * MAX_BUFFER_BYTES };
    const env = { [ENV_NAME]: String(3 * MAX_BUFFER_BYTES) };
    const all = await startCapturing(t, { env, maxResponseBytes: 4 * MAX_BUFFER_BYTES, taskManagerOptions: { config } });
    assert.equal(all.seen.options.maxResponseBytes, 4 * MAX_BUFFER_BYTES);
    const envAndConfig = await startCapturing(t, { env, taskManagerOptions: { config } });
    assert.equal(envAndConfig.seen.options.maxResponseBytes, 3 * MAX_BUFFER_BYTES);
  });

  test("an invalid env value fails startup instead of silently using the default", async (t) => {
    const paths = daemonPaths(t);
    let started;
    t.after(() => started?.close());
    await assert.rejects(
      async () => { started = await startDaemon({ ...paths, env: { [ENV_NAME]: "lots" }, taskManagerFactory: capturingFactory().factory }); },
      new RegExp(`${ENV_NAME} must be a positive integer \\(got "lots"\\)`)
    );
  });

  test("a cap the caller already set on the task manager under any alias is kept", async (t) => {
    const control = await startCapturing(t, { maxResponseBytes: 4 * MAX_BUFFER_BYTES });
    assert.equal(control.seen.options.maxResponseBytes, 4 * MAX_BUFFER_BYTES, "without an alias the daemon does thread its cap");
    const kept = await startCapturing(t, {
      maxResponseBytes: 4 * MAX_BUFFER_BYTES,
      taskManagerOptions: { maxBufferBytes: 2 * MAX_BUFFER_BYTES },
    });
    assert.equal(kept.seen.options.maxBufferBytes, 2 * MAX_BUFFER_BYTES);
    assert.equal(kept.seen.options.maxResponseBytes, undefined);
  });

  test("a raised cap does not leak into the next daemon started in the same process", async (t) => {
    const raised = await startCapturing(t, { maxResponseBytes: 4 * MAX_BUFFER_BYTES });
    assert.equal(raised.seen.options.maxResponseBytes, 4 * MAX_BUFFER_BYTES);
    const next = await startCapturing(t);
    assert.equal(next.seen.options.maxResponseBytes, MAX_BUFFER_BYTES);
  });

  test("a self-restart carries a flag-only raise to the replacement through its env", async (t) => {
    const paths = daemonPaths(t);
    const sourceDir = scratch(t, "response-cap-src");
    const entry = path.join(sourceDir, "daemon.js");
    fs.writeFileSync(entry, "// fixture\n");
    const spawnCalls = [];
    const fake = capturingFactory();
    const daemon = await startDaemon({
      ...paths,
      env: { MARKER: "kept" },
      maxResponseBytes: 4 * MAX_BUFFER_BYTES,
      taskManagerFactory: fake.factory,
      sourceDir,
      daemonEntry: entry,
      spawnReplacement: (args) => spawnCalls.push(args),
      exitProcess: () => {},
    });
    t.after(() => daemon.close());

    const bumped = new Date(Date.now() + 60_000);
    fs.utimesSync(entry, bumped, bumped);
    const socket = net.createConnection(paths.socketPath);
    await EventEmitter.once(socket, "connect");
    socket.write(`${JSON.stringify({ version: 1, id: "health", method: "system.health", params: {} })}\n`);
    await EventEmitter.once(socket, "data");
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.destroy();

    assert.equal(spawnCalls.length, 1, "the source change should trigger one restart");
    assert.equal(spawnCalls[0].env[ENV_NAME], String(4 * MAX_BUFFER_BYTES));
    assert.equal(spawnCalls[0].env.MARKER, "kept");
  });
});

describe("task manager response cap", () => {
  test("constructs at a tiny cap, clamping the output-file budget instead of throwing", (t) => {
    for (const cap of [1, 200, 512]) {
      let manager;
      assert.doesNotThrow(() => {
        manager = createTaskManager({ maxResponseBytes: cap, stateDir: path.join(scratch(t, "cap-tiny"), "state") });
      }, `a cap of ${cap} bytes should construct`);
      t.after(() => manager.close());
    }
  });

  test("an explicit output-file limit above the cap still throws", (t) => {
    assert.throws(
      () => createTaskManager({
        maxResponseBytes: 100_000,
        maxOutputFileBytes: 200_000,
        stateDir: path.join(scratch(t, "cap-explicit"), "state"),
      }),
      /maxOutputFileBytes 200000 exceeds daemon response limit 100000 bytes/
    );
  });
});

describe("client response cap", () => {
  /** Runs connectClient against a dead socket and returns the env it handed the booter. */
  async function bootEnvFor(t, options) {
    const root = scratch(t, "cap-client");
    let booterEnv;
    await assert.rejects(() => connectClient({
      ...socketLocations(root),
      stateDir: path.join(root, "state"),
      startupTimeoutMs: 20,
      retryDelayMs: 5,
      ensureDaemonFn: ({ env }) => { booterEnv = env; },
      ...options,
    }));
    return booterEnv;
  }

  test("forwards a raised client cap to the auto-started daemon without mutating the caller's env", async (t) => {
    const env = Object.freeze({ MARKER: "kept" });
    const booterEnv = await bootEnvFor(t, { env, maxBufferBytes: 2 * MAX_BUFFER_BYTES });
    assert.equal(booterEnv[ENV_NAME], String(2 * MAX_BUFFER_BYTES));
    assert.equal(booterEnv.MARKER, "kept");
    assert.equal(env[ENV_NAME], undefined);
  });

  test("forwards nothing at the default cap, and leaves an explicit env value alone", async (t) => {
    const raised = await bootEnvFor(t, { env: {}, maxBufferBytes: 2 * MAX_BUFFER_BYTES });
    assert.equal(raised[ENV_NAME], String(2 * MAX_BUFFER_BYTES), "a raised cap is forwarded");
    const plain = await bootEnvFor(t, { env: {} });
    assert.equal(plain[ENV_NAME], undefined);
    const explicit = await bootEnvFor(t, { env: { [ENV_NAME]: "3145728" }, maxBufferBytes: 2 * MAX_BUFFER_BYTES });
    assert.equal(explicit[ENV_NAME], "3145728");
  });

  test("does not forward a lowered cap and treats an empty env value as unset", async (t) => {
    const lowered = await bootEnvFor(t, { env: {}, maxBufferBytes: MAX_BUFFER_BYTES / 2 });
    assert.equal(lowered[ENV_NAME], undefined, "a lowered cap stays this client's receive limit");
    const empty = await bootEnvFor(t, { env: { [ENV_NAME]: "" }, maxBufferBytes: 2 * MAX_BUFFER_BYTES });
    assert.equal(empty[ENV_NAME], String(2 * MAX_BUFFER_BYTES), "an empty env value is not an explicit setting");
  });

  test("reads the cap from the config file when neither option nor env sets one", async (t) => {
    const configHome = scratch(t, "cap-config");
    fs.mkdirSync(path.join(configHome, "taskferry"));
    fs.writeFileSync(path.join(configHome, "taskferry", "config.json"), JSON.stringify({ maxResponseBytes: 2 * MAX_BUFFER_BYTES }));
    const booterEnv = await bootEnvFor(t, { env: { XDG_CONFIG_HOME: configHome } });
    assert.equal(booterEnv[ENV_NAME], String(2 * MAX_BUFFER_BYTES));
  });

  test("a malformed config file is an error naming the file, not a silent default", async (t) => {
    const configHome = scratch(t, "cap-config-bad");
    fs.mkdirSync(path.join(configHome, "taskferry"));
    fs.writeFileSync(path.join(configHome, "taskferry", "config.json"), "{ not json");
    const root = scratch(t, "cap-client-badcfg");
    await assert.rejects(
      () => connectClient({
        env: { XDG_CONFIG_HOME: configHome },
        ...socketLocations(root),
        stateDir: path.join(root, "state"),
        autoStart: false,
      }),
      /could not parse .*config\.json/
    );
  });

  test("an invalid env value is an error naming the variable", async (t) => {
    const root = scratch(t, "cap-client-bad");
    await assert.rejects(
      () => connectClient({
        env: { [ENV_NAME]: "lots" },
        ...socketLocations(root),
        stateDir: path.join(root, "state"),
        autoStart: false,
      }),
      new RegExp(`${ENV_NAME} must be a positive integer \\(got "lots"\\)`)
    );
  });
});

describe("daemon and client caps are independent", () => {
  /** Serves one oversized `task.status` response from a daemon whose cap allows it. */
  async function fetchBigStatus(t, clientCap) {
    const paths = daemonPaths(t);
    const bigBytes = MAX_BUFFER_BYTES + 512 * 1024;
    const manager = {
      list: () => ({ counts: {}, tasks: [] }),
      status: () => ({ id: "oc_big", blob: "x".repeat(bigBytes) }),
      setActivitySubscriptions() {},
      close() {},
    };
    const daemon = await startDaemon({
      ...paths,
      env: {},
      maxResponseBytes: 4 * MAX_BUFFER_BYTES,
      taskManagerFactory(options) {
        fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
        return manager;
      },
    });
    t.after(() => daemon.close());
    const client = await connectClient({ ...paths, env: {}, autoStart: false, maxBufferBytes: clientCap });
    t.after(() => client.close());
    const status = await client.request("task.status", { taskId: "oc_big" });
    return status.blob.length === bigBytes;
  }

  test("a client left at the default cap rejects a response the raised daemon sent", async (t) => {
    assert.equal(await fetchBigStatus(t, 4 * MAX_BUFFER_BYTES), true, "a client with the matching cap receives the response");
    await assert.rejects(() => fetchBigStatus(t, undefined), /taskferry daemon message exceeds 1048576 bytes/);
  });
});

describe("readTaskOutputFile", () => {
  test("honors a maxBytes above the static 1 MiB ceiling instead of re-clamping it", (t) => {
    const dir = scratch(t, "cap-output");
    const size = MAX_BUFFER_BYTES + 1024;
    fs.writeFileSync(path.join(dir, "big.txt"), "a".repeat(size));
    const result = readTaskOutputFile(dir, "big.txt", 2 * MAX_BUFFER_BYTES);
    assert.equal(result.truncated, false);
    assert.equal(result.content?.length, size);
  });
});
