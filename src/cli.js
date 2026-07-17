#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.js";
import { runSetup } from "./setup.js";

export async function runCli(argv = process.argv.slice(2), {
  io = process,
  cwd = process.cwd(),
  env = process.env,
  executablePath = process.argv[1],
  connectClient: connectClientFn,
  setup: setupFn = runSetup,
  signal,
  runShellCommand,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, { cwd });
  } catch (error) {
    const { writeError } = await import("./output.js");
    writeError(error, io);
    return { exitCode: error instanceof UsageError ? 2 : 1 };
  }

  if (parsed.help) {
    const { writeToon } = await import("./output.js");
    writeToon(parsed.helpText, io);
    return { exitCode: 0 };
  }

  if (parsed.command === "setup") {
    try {
      const value = setupFn({
        checkoutDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        cliPath: fileURLToPath(import.meta.url),
        homeDirectory: os.homedir(),
        env,
      });
      const { writeToon } = await import("./output.js");
      writeToon(value, io);
      return { exitCode: 0, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr.write(`error: ${message}\n`);
      io.stderr.write("help: fix the reported dependency or filesystem problem, then rerun node src/cli.js setup\n");
      return { exitCode: 1 };
    }
  }

  const [{ normalizeDirectory, runCommand }, { connectClient: defaultConnectClient }, { writeError, writeToon }] = await Promise.all([
    import("./commands.js"),
    import("./client.js"),
    import("./output.js"),
  ]);
  const connectClient = connectClientFn || defaultConnectClient;

  let client;
  try {
    if (parsed.command === "version") {
      writeToon(await runCommand(parsed.command, parsed.options, { io, cwd }), io);
      return { exitCode: 0 };
    }
    const watchNeedsTaskIdResolution = parsed.command === "watch" && parsed.options.taskId && !parsed.options.directory;
    if (parsed.command === "home"
      || parsed.command === "dispatch"
      || parsed.command === "advisor"
      || (parsed.command === "watch" && !watchNeedsTaskIdResolution)
      || parsed.command === "context"
      || (parsed.command === "list" && !parsed.options.all)) {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    }
    client = await connectClient({ env });
    const value = await runCommand(parsed.command, parsed.options, {
      client,
      io,
      signal,
      executablePath,
      cwd,
      runShellCommand,
    });
    if (parsed.command !== "watch" && value !== undefined) writeToon(value, io);
    return { exitCode: 0, value };
  } catch (error) {
    writeError(error, io);
    return { exitCode: error instanceof UsageError ? 2 : 1 };
  } finally {
    if (client?.close) {
      try {
        await client.close();
      } catch {
        // The command's result is authoritative; close failures are diagnostics.
      }
    }
  }
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await runCli(process.argv.slice(2), { signal: controller.signal });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolveInvokedPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const { writeError } = await import("./output.js");
    writeError(error);
    process.exitCode = 1;
  });
}

function resolveInvokedPath(invoked) {
  try {
    return fs.realpathSync(invoked);
  } catch {
    return path.resolve(invoked);
  }
}
