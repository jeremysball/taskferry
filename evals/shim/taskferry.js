#!/usr/bin/env node
// A fake `taskferry` CLI for skill evals.
//
// The real CLI needs a daemon, a provider, and real money. These evals only care
// about *what commands the model under test chose to run*, so this shim answers
// from a fixture and appends every invocation to a JSONL log the scorer reads.
// Behaviour is deterministic: same fixture plus same argv always yields the same
// stdout and exit code.
//
// Usage (inside an eval sandbox):
//   TASKFERRY_EVAL_FIXTURE=<path> TASKFERRY_EVAL_LOG=<path> taskferry <args...>
import fs from "node:fs";

const EXIT_USAGE = 2;

function fail(message) {
  process.stderr.write(`eval-shim: ${message}\n`);
  process.exit(EXIT_USAGE);
}

const fixturePath = process.env.TASKFERRY_EVAL_FIXTURE;
const logPath = process.env.TASKFERRY_EVAL_LOG;
if (!fixturePath) fail("TASKFERRY_EVAL_FIXTURE is not set");
if (!logPath) fail("TASKFERRY_EVAL_LOG is not set");

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const argv = process.argv.slice(2);

/** Record the invocation before answering, so a crash still leaves a trace. */
function record(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

/**
 * Pick the fixture response whose `match` tokens all appear in argv. Later
 * entries win, so a fixture can list a general case then override it.
 */
function selectResponse(args) {
  let selected = null;
  for (const candidate of fixture.responses ?? []) {
    const tokens = candidate.match ?? [];
    if (tokens.every((token) => args.includes(token))) selected = candidate;
  }
  return selected;
}

const response = selectResponse(argv);
record({ argv, matched: response?.name ?? null, at: fixture.clock ?? null });

if (!response) {
  process.stderr.write(`eval-shim: no fixture response matches: ${argv.join(" ")}\n`);
  process.exit(1);
}

if (typeof response.stdout === "string") process.stdout.write(response.stdout);
if (typeof response.stderr === "string") process.stderr.write(response.stderr);
process.exit(response.exitCode ?? 0);
