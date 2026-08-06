#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.js";
import { runSetup } from "./setup.js";
import { runInit } from "./init.js";
import { resolveInvokedPath } from "./paths.js";

export async function runCli(argv = process.argv.slice(2), {
  io = process,
  cwd = process.cwd(),
  env = process.env,
  executablePath = process.argv[1],
  connectClient: connectClientFn,
  setup: setupFn = runSetup,
  init: initFn = runInit,
  signal,
  runShellCommand,
  homeDirectory = os.homedir(),
  resolveWorkspaceRoot: resolveWorkspaceRootFn,
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
    return writeHelp(parsed.helpText, io);
  }

  if (parsed.command === "setup") {
    return runSetupCommand(setupFn, env, io);
  }

  if (parsed.command === "init") {
    return runInitCommand(initFn, io, cwd);
  }

  return runDaemonCommand(parsed, { io, cwd, env, executablePath, connectClientFn, signal, runShellCommand, homeDirectory, resolveWorkspaceRootFn });
}

async function writeHelp(helpText, io) {
  const { writeToon } = await import("./output.js");
  writeToon(helpText, io);
  return { exitCode: 0 };
}

async function runSetupCommand(setupFn, env, io) {
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
    const { colorize } = await import("./output.js");
    const message = error instanceof Error ? error.message : String(error);
    const errorLabel = `error: ${message}`;
    const tty = io.stderr.isTTY;
    io.stderr.write(`${colorize(errorLabel, "\x1b[31m", tty)}\n`);
    io.stderr.write(`${colorize("help: fix the reported dependency or filesystem problem, then rerun node src/cli.js setup", "\x1b[2m", tty)}\n`);
    return { exitCode: 1 };
  }
}

async function runInitCommand(initFn, io, cwd) {
  try {
    const value = await initFn(cwd, { io });
    const { writeToon } = await import("./output.js");
    writeToon(value, io);
    return { exitCode: 0, value };
  } catch (error) {
    const { writeError } = await import("./output.js");
    writeError(error, io);
    return { exitCode: 1 };
  }
}

async function runDaemonCommand(parsed, { io, cwd, env, executablePath, connectClientFn, signal, runShellCommand, homeDirectory, resolveWorkspaceRootFn }) {
  const [{ runCommand }, { normalizeDirectory, resolveWorkspaceRoot }, { connectClient: defaultConnectClient }, { writeError, writeToon }] = await Promise.all([
    import("./commands.js"),
    import("./paths.js"),
    import("./client.js"),
    import("./output.js"),
  ]);
  const connectClient = connectClientFn || defaultConnectClient;
  const resolveRoot = resolveWorkspaceRootFn || resolveWorkspaceRoot;

  let client;
  try {
    if (parsed.command === "version") {
      writeToon(await runCommand(parsed.command, parsed.options, { io, cwd }), io);
      return { exitCode: 0 };
    }
    normalizeCommandDirectory(parsed, normalizeDirectory, cwd, resolveRoot);
    if (readsPromptFromStdin(parsed)) {
      parsed.options.prompt = await readPromptFromStdin(io.stdin || process.stdin, parsed.command, signal);
    }
    client = await connectClient({ env });
    const value = await runCommand(parsed.command, parsed.options, {
      client,
      io,
      signal,
      executablePath,
      cwd,
      runShellCommand,
      env,
      homeDirectory,
      resolveWorkspaceRoot: resolveRoot,
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

function normalizeCommandDirectory(parsed, normalizeDirectory, cwd, resolveRoot) {
  // advisor shares dispatch's literal cwd because it becomes the sandbox root.
  if (["dispatch", "advisor"].includes(parsed.command)) {
    parsed.options.directory = normalizeDirectory(parsed.options.directory || cwd);
    return;
  }
  if (usesWorkspaceRoot(parsed)) {
    parsed.options.directory = normalizeDirectory(parsed.options.directory || resolveRoot(cwd));
  }
}

function usesWorkspaceRoot({ command, options }) {
  if (["home", "context"].includes(command)) return true;
  // --all (list and watch) means "every workspace" -- resolving cwd's root
  // here would overwrite the `directory: void 0` applyAllFlag() already set
  // and silently scope an --all request back down to one workspace.
  if (options.all) return false;
  if (command === "watch") return !(options.taskId && !options.directory);
  return command === "list";
}

function readsPromptFromStdin({ command, options }) {
  return ["dispatch", "advisor"].includes(command) && options.prompt === "-";
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

// `--prompt -` lets a large prompt bypass the argv-length limit entirely by
// piping it into taskferry's own stdin (issue #78) instead of requiring the
// caller to write a temp file and pass a path themselves.
async function readPromptFromStdin(stdin, command, signal) {
  const stdinHelp = `Pipe a prompt into the command (e.g. \`cat prompt.txt | taskferry ${command} --prompt -\`), or pass --prompt "<text>" directly`;
  if (stdin.isTTY) {
    throw new UsageError("--prompt - requires a piped stdin (no TTY input detected)", stdinHelp);
  }
  const abortHelp = "The piped-in process never closed its end of stdin -- fix the producer, or press Ctrl-C to stop waiting";
  const readChunks = (async () => {
    const chunks = [];
    for await (const chunk of stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return chunks;
  })();
  // A producer that never closes its end of the pipe leaves the `for await`
  // loop above waiting forever. Races it against the AbortController that
  // main() wires to SIGINT/SIGTERM so Ctrl-C breaks the hang.
  const chunks = signal
    ? await Promise.race([
        readChunks,
        new Promise((_, reject) => {
          const onAbort = () => reject(new UsageError("--prompt - aborted while waiting for stdin to close", abortHelp));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ])
    : await readChunks;
  const content = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!content) {
    throw new UsageError("--prompt - received empty stdin", stdinHelp);
  }
  return content;
}


