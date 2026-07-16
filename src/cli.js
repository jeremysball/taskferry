#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.js";
import { normalizeDirectory, runCommand } from "./commands.js";
import { connectClient } from "./client.js";
import { writeError, writeToon } from "./output.js";

export async function runCli(argv = process.argv.slice(2), {
  io = process,
  cwd = process.cwd(),
  env = process.env,
  executablePath = process.argv[1],
  connectClient: connectClientFn = connectClient,
  signal,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, { cwd });
  } catch (error) {
    writeError(error, io);
    return { exitCode: error instanceof UsageError ? 2 : 1 };
  }

  if (parsed.help) {
    writeToon(parsed.helpText, io);
    return { exitCode: 0 };
  }

  let client;
  try {
    if (parsed.command === "version") {
      writeToon(await runCommand(parsed.command, parsed.options, { io, cwd }), io);
      return { exitCode: 0 };
    }
    if (parsed.command === "home"
      || parsed.command === "dispatch"
      || parsed.command === "advisor"
      || parsed.command === "watch"
      || parsed.command === "context"
      || (parsed.command === "list" && !parsed.options.all)) {
      parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    }
    client = await connectClientFn({ env });
    const value = await runCommand(parsed.command, parsed.options, {
      client,
      io,
      signal,
      executablePath,
      cwd,
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    writeError(error);
    process.exitCode = 1;
  });
}
