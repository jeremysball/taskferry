/* eslint-disable sonarjs/no-duplicate-string -- test fixtures repeat taskferry/integration paths intentionally */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { contextForHook } from "./output.js";
import { runCli } from "./cli.js";

const ENCODING = "utf8";
const HOOKS_FILE = "hooks.json";
const HOOK_BIN_PREFIX = "taskferry-hook-bin-";
const SKILL_FILE = "SKILL.md";
const SKILL_DIR = "using-taskferry";
const RESOURCES_DIR = "resources";
const GENERATE_SCRIPT = "generate-skill.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claudeRoot = path.join(root, "integrations", "claude");
const codexRoot = path.join(root, "integrations", "codex");
const kiloRoot = path.join(root, "integrations", "kilo");

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(root, ...parts), ENCODING));
}

// Copy the real generator into a throwaway tree so a --check run can be staled
// without touching the live repo (node --test runs files concurrently).
function stageGenerateScript(sandbox) {
  const relative = path.join("scripts", GENERATE_SCRIPT);
  const destination = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, relative), destination);
  return destination;
}

test("Claude plugin manifests describe only the taskferry native integration", () => {
  const plugin = readJson("integrations", "claude", ".claude-plugin", "plugin.json");
  const marketplace = readJson(".claude-plugin", "marketplace.json");
  const hooks = readJson("integrations", "claude", "hooks", HOOKS_FILE);

  assert.equal(plugin.name, "taskferry");
  assert.equal(typeof plugin.description, "string");
  assert.deepEqual(
    Object.keys(plugin).filter((key) => ["commands", "agents", "mcpServers", "channels"].includes(key)),
    []
  );
  assert.equal(Array.isArray(hooks.hooks.SessionStart), true);
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /taskferry context/);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /--format toon/);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /JSON\.stringify/);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /CLAUDE_PROJECT_DIR/);

  assert.equal(marketplace.name, "taskferry");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "taskferry");
  assert.equal(marketplace.plugins[0].source, "./integrations/claude");
});

test("SessionStart context uses Claude's additionalContext payload", () => {
  const context = {
    directory: "/workspace/project",
    counts: { total: 1, running: 1, queued: 0, terminal: 0 },
    tasks: [{ id: "oc_ab12", status: "running", model: "openai/gpt-5.6-sol", startedAt: "2026-07-15T00:00:00Z" }],
  };

  assert.deepEqual(contextForHook(context, "claude-hook"), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "directory: /workspace/project\ncounts:\n  total: 1\n  running: 1\n  queued: 0\n  terminal: 0\ntasks[1]{id,status,model,startedAt}:\n  oc_ab12,running,openai/gpt-5.6-sol,\"2026-07-15T00:00:00Z\"",
    },
  });
});

test("SessionStart context is scoped to the current project", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-claude-hook-"));
  const requests = [];
  let stdout = "";

  try {
    const result = await runCli(["context", "--directory", project, "--format", "claude-hook"], {
      cwd: project,
      io: { stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} } },
      connectClient: async () => ({
        request: async (method, params) => {
          requests.push({ method, params });
          return {
            directory: params.directory,
            counts: { total: 1, running: 1, queued: 0, terminal: 0 },
            tasks: [{ id: "oc_current", status: "running", model: "model", startedAt: "now" }],
          };
        },
        close() {},
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(requests, [{ method: "task.context", params: { directory: fs.realpathSync(project) } }]);
    assert.match(stdout, /hookSpecificOutput/);
    assert.match(stdout, /oc_current/);
    assert.doesNotMatch(stdout, /oc_other/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("SessionStart hook wraps CLI TOON context in Claude JSON output", () => {
  const hooks = readJson("integrations", "claude", "hooks", HOOKS_FILE);
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), HOOK_BIN_PREFIX));
  const taskferry = path.join(bin, "taskferry");

  try {
    fs.writeFileSync(taskferry, "#!/bin/sh\nprintf 'directory: /project\\n'\n");
    // eslint-disable-next-line sonarjs/file-permissions -- 0o755 on a throwaway test script, not taskferry-set permission
    fs.chmodSync(taskferry, 0o755);
    const result = spawnSync("sh", ["-c", command], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: "/project", PATH: `${bin}:${process.env.PATH}` },
      encoding: ENCODING,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "directory: /project\n",
      },
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("SessionStart hook passes CLAUDE_PROJECT_DIR as a single unquoted argument", () => {
  const hooks = readJson("integrations", "claude", "hooks", HOOKS_FILE);
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), HOOK_BIN_PREFIX));
  const taskferry = path.join(bin, "taskferry");

  try {
    fs.writeFileSync(
      taskferry,
      "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\"; done\nprintf '\\n'\n"
    );
    // eslint-disable-next-line sonarjs/file-permissions -- 0o755 on a throwaway test script, not taskferry-set permission
    fs.chmodSync(taskferry, 0o755);
    const result = spawnSync("sh", ["-c", command], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: "/tmp/some project", PATH: `${bin}:${process.env.PATH}` },
      encoding: ENCODING,
    });

    assert.equal(result.status, 0, result.stderr);
    const { additionalContext } = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(additionalContext, "[context][--directory][/tmp/some project][--format][toon]\n");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("SessionStart hook reports a structured error when an installed taskferry fails", () => {
  const hooks = readJson("integrations", "claude", "hooks", HOOKS_FILE);
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), HOOK_BIN_PREFIX));
  const taskferry = path.join(bin, "taskferry");

  try {
    fs.writeFileSync(taskferry, "#!/bin/sh\nexit 1\n");
    // eslint-disable-next-line sonarjs/file-permissions -- 0o755 on a throwaway test script, not taskferry-set permission
    fs.chmodSync(taskferry, 0o755);
    const result = spawnSync("sh", ["-c", command], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: "/project", PATH: `${bin}:${process.env.PATH}` },
      encoding: ENCODING,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "taskferry context failed. Run taskferry doctor to diagnose.",
      },
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("missing taskferry guidance is a single actionable plugin error", () => {
  const hooks = readJson("integrations", "claude", "hooks", HOOKS_FILE);
  const command = hooks.hooks.SessionStart[0].hooks[0].command;

  assert.match(command, /command -v taskferry/);
  assert.match(command, /taskferry is unavailable/);
  assert.match(command, /install taskferry/i);
  assert.equal((command.match(/taskferry is unavailable/g) || []).length, 1);

  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-hook-empty-bin-"));
  try {
    const result = spawnSync("/bin/sh", ["-c", command], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: "/project", PATH: emptyBin },
      encoding: ENCODING,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "taskferry is unavailable. Install taskferry and ensure it is on PATH, then restart Claude Code.",
      },
    });
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("Codex plugin manifests expose native skills and lifecycle hooks", () => {
  const plugin = readJson("integrations", "codex", ".codex-plugin", "plugin.json");
  const marketplace = readJson(".agents", "plugins", "marketplace.json");
  const hooks = readJson("integrations", "codex", "hooks", HOOKS_FILE);

  assert.equal(plugin.name, "taskferry");
  assert.equal(plugin.hooks, "./hooks/hooks.json");
  assert.equal(plugin.skills, "./skills/");
  assert.deepEqual(
    Object.keys(plugin).filter((key) => ["mcpServers", "apps"].includes(key)),
    []
  );
  assert.equal(marketplace.name, "taskferry");
  assert.equal(marketplace.interface.displayName, "Taskferry");
  assert.deepEqual(marketplace.plugins, [{
    name: "taskferry",
    displayName: "Taskferry",
    source: { source: "local", path: "./integrations/codex" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Development & Workflow",
    description: "Background pi/OpenCode task execution through the Taskferry AXI CLI",
  }]);

  assert.match(hooks.description, /workspace context/i);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    assert.equal(hooks.hooks[event].length, 1);
    const hook = hooks.hooks[event][0].hooks[0];
    assert.equal(hook.type, "command");
    assert.match(hook.command, /taskferry context --format codex-hook/);
    assert.equal(hook.command.includes("watch"), false);
  }
});

test("Codex context uses the native additionalContext payload", () => {
  const context = {
    directory: "/workspace/project",
    counts: { total: 1, running: 1, queued: 0, terminal: 0 },
    tasks: [{ id: "oc_ab12", status: "running", model: "openai/gpt-5.6-sol", startedAt: "2026-07-15T00:00:00Z" }],
  };

  assert.deepEqual(contextForHook(context, "codex-hook"), {
    additionalContext: "directory: /workspace/project\ncounts:\n  total: 1\n  running: 1\n  queued: 0\n  terminal: 0\ntasks[1]{id,status,model,startedAt}:\n  oc_ab12,running,openai/gpt-5.6-sol,\"2026-07-15T00:00:00Z\"",
  });
});

test("Codex lifecycle hooks emit workspace context with an isolated CODEX_HOME", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-codex-hook-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-codex-home-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-codex-bin-"));
  const taskferry = path.join(bin, "taskferry");

  try {
    fs.writeFileSync(taskferry, "#!/bin/sh\nprintf '{\"additionalContext\":\"workspace: %s\"}' \"$(pwd)\"\n");
    // eslint-disable-next-line sonarjs/file-permissions -- 0o755 on a throwaway test script, not taskferry-set permission
    fs.chmodSync(taskferry, 0o755);

    const hooks = readJson("integrations", "codex", "hooks", HOOKS_FILE);
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const command = hooks.hooks[event][0].hooks[0].command;
      const result = spawnSync("sh", ["-c", command], {
        cwd: project,
        env: { ...process.env, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH}` },
        encoding: ENCODING,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        additionalContext: `workspace: ${project}`,
      });
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("distributed skills are generated from the canonical source", () => {
  const canonical = fs.readFileSync(path.join(root, "skills", SKILL_DIR, SKILL_FILE), ENCODING);
  assert.equal(fs.readFileSync(path.join(claudeRoot, "skills", SKILL_DIR, SKILL_FILE), ENCODING), canonical);
  assert.equal(fs.readFileSync(path.join(codexRoot, "skills", SKILL_DIR, SKILL_FILE), ENCODING), canonical);
  assert.equal(fs.readFileSync(path.join(kiloRoot, "skills", SKILL_DIR, SKILL_FILE), ENCODING), canonical);

  const result = spawnSync(process.execPath, ["scripts/generate-skill.js", "--check"], {
    cwd: root,
    encoding: ENCODING,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("skill resources are distributed alongside SKILL.md", () => {
  const canonicalResources = path.join(root, "skills", SKILL_DIR, RESOURCES_DIR);
  const names = fs.readdirSync(canonicalResources).sort();
  assert.ok(names.length > 0, "expected canonical skill resources");

  // Every resource file on disk must be linked from SKILL.md, and every link
  // SKILL.md actually contains must resolve to a resource that exists — either
  // direction going stale leaves a plugin consumer with a dead reference.
  const skill = fs.readFileSync(path.join(root, "skills", SKILL_DIR, SKILL_FILE), ENCODING);
  const linkedNames = new Set(
    [...skill.matchAll(new RegExp(`${RESOURCES_DIR}/([\\w.-]+\\.md)`, "gu"))].map((match) => match[1])
  );
  for (const name of names) {
    assert.match(skill, new RegExp(`${RESOURCES_DIR}/${name.replace(/\./gu, "\\.")}`));
    const canonical = fs.readFileSync(path.join(canonicalResources, name), ENCODING);
    for (const integrationRoot of [claudeRoot, codexRoot, kiloRoot]) {
      const copy = path.join(integrationRoot, "skills", SKILL_DIR, RESOURCES_DIR, name);
      assert.equal(fs.readFileSync(copy, ENCODING), canonical, `stale copy: ${copy}`);
    }
  }
  for (const linked of linkedNames) {
    assert.ok(names.includes(linked), `SKILL.md links resources/${linked}, which does not exist canonically`);
  }
});

test("skill check detects a stale generated resource copy", () => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-resource-check-")));
  const resourceName = fs.readdirSync(path.join(root, "skills", SKILL_DIR, RESOURCES_DIR)).sort()[0];
  const files = [
    path.join("skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "claude", "skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "codex", "skills", SKILL_DIR, SKILL_FILE),
    path.join("skills", SKILL_DIR, RESOURCES_DIR, resourceName),
    path.join("integrations", "claude", "skills", SKILL_DIR, RESOURCES_DIR, resourceName),
    path.join("integrations", "codex", "skills", SKILL_DIR, RESOURCES_DIR, resourceName),
  ];
  try {
    for (const relativePath of files) {
      const destination = path.join(sandbox, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, relativePath), destination);
    }
    const scriptDestination = stageGenerateScript(sandbox);

    fs.appendFileSync(
      path.join(sandbox, "integrations", "codex", "skills", SKILL_DIR, RESOURCES_DIR, resourceName),
      "\nstale\n"
    );

    const result = spawnSync(process.execPath, [scriptDestination, "--check"], {
      cwd: sandbox,
      encoding: ENCODING,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale/iu);
    assert.match(result.stderr, new RegExp(`${RESOURCES_DIR}/${resourceName.replace(/\./gu, "\\.")}`));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill check does not false-flag a nested canonical resource as stale", () => {
  // Regression coverage for collectRelativeFiles() recomputing each recursive
  // call's relative base from the recursion-local sourceRelative instead of a
  // fixed top-level base, which dropped nested directory prefixes and made
  // this exact scenario (identical nested copies) falsely report as drift.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-nested-resource-")));
  const files = [
    path.join("skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "claude", "skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "codex", "skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "kilo", "skills", SKILL_DIR, SKILL_FILE),
  ];
  try {
    for (const relativePath of files) {
      const destination = path.join(sandbox, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, relativePath), destination);
    }
    const nestedContent = "# Nested guide\n\nRegression coverage for a nested resource path.\n";
    for (const base of [
      path.join("skills", SKILL_DIR),
      path.join("integrations", "claude", "skills", SKILL_DIR),
      path.join("integrations", "codex", "skills", SKILL_DIR),
      path.join("integrations", "kilo", "skills", SKILL_DIR),
    ]) {
      const destination = path.join(sandbox, base, RESOURCES_DIR, "guides", "nested.md");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, nestedContent);
    }
    const scriptDestination = stageGenerateScript(sandbox);

    const result = spawnSync(process.execPath, [scriptDestination, "--check"], {
      cwd: sandbox,
      encoding: ENCODING,
    });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill generate fails fast instead of wiping resources when the canonical dir is missing", () => {
  // Regression coverage for mirrorTree() silently no-opping (via copyTree's
  // own missing-source no-op) after it had already deleted the destination,
  // which would wipe every integration's resource copy with no error if the
  // canonical resources dir were ever accidentally removed or renamed.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-missing-resources-")));
  const resourceName = fs.readdirSync(path.join(root, "skills", SKILL_DIR, RESOURCES_DIR)).sort()[0];
  const skillFile = path.join("skills", SKILL_DIR, SKILL_FILE);
  const existingCopy = path.join(sandbox, "integrations", "claude", "skills", SKILL_DIR, RESOURCES_DIR, resourceName);
  try {
    const skillDestination = path.join(sandbox, skillFile);
    fs.mkdirSync(path.dirname(skillDestination), { recursive: true });
    fs.copyFileSync(path.join(root, skillFile), skillDestination);

    // Seed a pre-existing integration resource copy, but deliberately never
    // create the canonical skills/using-taskferry/resources dir in the sandbox.
    fs.mkdirSync(path.dirname(existingCopy), { recursive: true });
    fs.copyFileSync(path.join(root, "skills", SKILL_DIR, RESOURCES_DIR, resourceName), existingCopy);

    const scriptDestination = stageGenerateScript(sandbox);

    const result = spawnSync(process.execPath, [scriptDestination], {
      cwd: sandbox,
      encoding: ENCODING,
    });

    assert.notEqual(result.status, 0, "generate should fail, not silently succeed");
    assert.match(result.stderr, /canonical source is missing/iu);
    assert.ok(fs.existsSync(existingCopy), "a failed generate must not delete the pre-existing integration copy");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("skill check detects a stale generated copy", () => {
  // Run the check against a miniature tree in tmpdir, never the live repo:
  // node --test runs test files concurrently, and staling the real
  // integrations/codex copy even transiently raced with commands.test.js
  // dispatch tests that run the real checkSkills() against the same tree
  // (flaky "skill files are out of sync" failures in CI).
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-skill-check-")));
  const skillFiles = [
    path.join("skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "claude", "skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "codex", "skills", SKILL_DIR, SKILL_FILE),
    path.join("integrations", "kilo", "skills", SKILL_DIR, SKILL_FILE),
  ];
  try {
    for (const relativePath of skillFiles) {
      const destination = path.join(sandbox, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, relativePath), destination);
    }
    const scriptDestination = stageGenerateScript(sandbox);

    fs.appendFileSync(
      path.join(sandbox, "integrations", "codex", "skills", SKILL_DIR, SKILL_FILE),
      "\nstale\n"
    );

    const result = spawnSync(process.execPath, [scriptDestination, "--check"], {
      cwd: sandbox,
      encoding: ENCODING,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale/i);
    assert.match(result.stderr, /integrations\/codex\/skills\/using-taskferry\/SKILL\.md/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("bundled skill teaches the AXI worker contract without extra plugin surfaces", () => {
  const skill = fs.readFileSync(path.join(claudeRoot, "skills", SKILL_DIR, SKILL_FILE), ENCODING);

  assert.match(skill, /^name: using-taskferry$/m);
  assert.match(skill, /^description: .+$/m);
  assert.match(skill, /taskferry dispatch/);
  assert.match(skill, /taskferry wait/);
  assert.match(skill, /taskferry result/);
  assert.match(skill, /ferries/);
  assert.match(skill, /worker backend/i);
  assert.match(skill, /resume the session that already did the work/i);
  assert.match(skill, /start a fresh session only when/i);
  assert.doesNotMatch(skill, /\bMCP\b/i);
  assert.doesNotMatch(skill, /taskferry setup/);
});

test("Kilo plugin manifests expose hooks and skill parity with Claude/Codex", () => {
  const plugin = readJson("integrations", "kilo", ".kilo-plugin", "plugin.json");
  const hooks = readJson("integrations", "kilo", "hooks", HOOKS_FILE);

  assert.equal(plugin.name, "taskferry");
  assert.equal(plugin.hooks, "./hooks/hooks.json");
  assert.equal(plugin.skills, "./skills/");
  assert.equal(typeof plugin.description, "string");
  assert.equal(typeof plugin.version, "string");

  assert.match(hooks.description, /kilo/i);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    assert.equal(hooks.hooks[event].length, 1);
    const hook = hooks.hooks[event][0].hooks[0];
    assert.equal(hook.type, "command");
    assert.match(hook.command, /taskferry context/);
    assert.match(hook.command, /kilo-hook/);
  }
});

test("Kilo context uses the kilo-hook envelope (claude-compatible)", () => {
  const context = {
    directory: "/workspace/project",
    counts: { total: 1, running: 1, queued: 0, terminal: 0 },
    tasks: [{ id: "oc_ab12", status: "running", model: "openai/gpt-5.6-sol", startedAt: "2026-07-15T00:00:00Z" }],
  };

  assert.deepEqual(contextForHook(context, "kilo-hook"), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "directory: /workspace/project\ncounts:\n  total: 1\n  running: 1\n  queued: 0\n  terminal: 0\ntasks[1]{id,status,model,startedAt}:\n  oc_ab12,running,openai/gpt-5.6-sol,\"2026-07-15T00:00:00Z\"",
    },
  });
});

test("Kilo hooks degrade gracefully when taskferry is missing or fails", () => {
  const hooks = readJson("integrations", "kilo", "hooks", HOOKS_FILE);
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const command = hooks.hooks[event][0].hooks[0].command;
    assert.match(command, /command -v taskferry/);
    assert.match(command, /taskferry is unavailable/);
    assert.match(command, /taskferry context failed/);
  }
});
