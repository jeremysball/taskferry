#!/usr/bin/env node
// Run a skill eval against a real model.
//
//   node evals/run.js --fixture crash-overlay-recovery --model <provider/model> [--variant max]
//
// Builds a sandbox containing the skill under test and a fake `taskferry`,
// dispatches a real ferry into it, then scores the commands the model chose to
// run. Costs money and needs a live provider, which is why this is not part of
// `npm test`; the harness itself is covered by src/evals.test.js.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCommandLog, scoreRun, formatReport } from "./score.js";

const ENCODING = "utf8";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`expected a --flag, got: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.fixture || !args.model) {
  process.stderr.write("usage: node evals/run.js --fixture <name> --model <provider/model> [--variant <name>]\n");
  process.exit(2);
}

const fixturePath = path.join(root, "evals", "fixtures", `${args.fixture}.json`);
const fixture = JSON.parse(fs.readFileSync(fixturePath, ENCODING));

// Sandbox layout: the skill the model reads, a bin/ holding the shim, and the
// command log the scorer reads back.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `taskferry-eval-${fixture.name}-`));
fs.cpSync(path.join(root, "skills", "using-taskferry"), path.join(sandbox, "skill"), { recursive: true });
fs.mkdirSync(path.join(sandbox, "bin"), { recursive: true });
fs.copyFileSync(fixturePath, path.join(sandbox, "fixture.json"));

// The command log must live OUTSIDE the dispatched --directory. That directory
// is a copy-on-write overlay, so a log written inside it never reaches the host
// unless the changeset is extracted, and the sandbox is not a git repo for a
// diff to be computed against. A separate dir bound read-write lands directly.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `taskferry-evallog-${fixture.name}-`));
const logPath = path.join(logDir, "commands.jsonl");
const launcher = path.join(sandbox, "bin", "taskferry");
fs.writeFileSync(
  launcher,
  `#!/bin/bash\nexport TASKFERRY_EVAL_FIXTURE=${JSON.stringify(path.join(sandbox, "fixture.json"))}\n` +
    `export TASKFERRY_EVAL_LOG=${JSON.stringify(logPath)}\n` +
    `exec node ${JSON.stringify(path.join(sandbox, "bin", "shim.js"))} "$@"\n`
);
// Owner-only: the sandbox is this user's temp dir, nothing else needs to run it.
fs.chmodSync(launcher, 0o700);
fs.copyFileSync(path.join(root, "evals", "shim", "taskferry.js"), path.join(sandbox, "bin", "shim.js"));

const prompt = [
  "You are working in a sandbox. A `taskferry` CLI is available at ./bin/taskferry.",
  "Always invoke it as `./bin/taskferry <args>`; do not use any other taskferry.",
  "",
  "The taskferry skill documenting how to use it is in ./skill/ (start with ./skill/SKILL.md;",
  "it references files under ./skill/resources/). Read whatever you need from it.",
  "",
  "Your task:",
  fixture.task,
  "",
  "Do the work by running commands. Do not edit files under ./skill/.",
  "End your reply with a line starting `Status:` and the single word DONE.",
].join("\n");

// A random delimiter, per the skill's own Worker Contract: the prompt can embed
// content that contains the usual PROMPT_EOF token.
const delimiter = `TF_EOF_${crypto.randomBytes(8).toString("hex")}`;
if (prompt.split("\n").includes(delimiter)) throw new Error("delimiter collision");

const variantFlag = args.variant ? ` --variant ${args.variant}` : "";
// --rw-bind is required for the log dir: the sandbox mounts an empty /tmp, so a
// host path under /tmp is otherwise invisible to the worker.
const command =
  `taskferry dispatch --prompt - --directory ${JSON.stringify(sandbox)} --model ${args.model}` +
  `${variantFlag} --rw-bind ${JSON.stringify(logDir)} --class skill-eval-${fixture.name}` +
  ` <<'${delimiter}'\n${prompt}\n${delimiter}\n`;

process.stdout.write(`sandbox: ${sandbox}\ndispatching ${args.model}${variantFlag} for ${fixture.name}\n`);
const dispatched = spawnSync("/bin/bash", ["-c", command], { encoding: ENCODING });
process.stdout.write(dispatched.stdout ?? "");
if (dispatched.status !== 0) {
  process.stderr.write(dispatched.stderr ?? "");
  process.exit(1);
}

const taskId = /id: (\S+)/u.exec(dispatched.stdout ?? "")?.[1];
if (!taskId) {
  process.stderr.write("could not parse a task id from dispatch output\n");
  process.exit(1);
}

process.stdout.write(`waiting on ${taskId}\n`);
spawnSync("taskferry", ["wait", taskId], { encoding: ENCODING, env: { ...process.env, TASKFERRY_WAIT_DEFAULT_TIMEOUT_MS: "0" } });

// Nothing to accept: the eval only cares about the command log, which the
// --rw-bind above already landed on the host. Release the overlay instead.
spawnSync("taskferry", ["reject", taskId], { encoding: ENCODING });

const scored = scoreRun(fixture, readCommandLog(logPath));
process.stdout.write(`\n${formatReport(fixture, scored)}\n`);
process.stdout.write(`\ncommand log: ${logPath}\ntask: ${taskId}\n`);
process.exit(scored.pass ? 0 : 1);
