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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claudeRoot = path.join(root, "integrations", "claude");
const codexRoot = path.join(root, "integrations", "codex");

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(root, ...parts), ENCODING));
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
    description: "Background OpenCode task execution through the Taskferry AXI CLI",
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

  const result = spawnSync(process.execPath, ["scripts/generate-skill.js", "--check"], {
    cwd: root,
    encoding: ENCODING,
  });
  assert.equal(result.status, 0, result.stderr);
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
  ];
  try {
    for (const relativePath of skillFiles) {
      const destination = path.join(sandbox, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, relativePath), destination);
    }
    const scriptDestination = path.join(sandbox, "scripts", "generate-skill.js");
    fs.mkdirSync(path.dirname(scriptDestination), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts", "generate-skill.js"), scriptDestination);

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
  assert.match(skill, /subagent-driven-development/);
  assert.match(skill, /worker backend/);
  assert.match(skill, /fresh sessions/);
  assert.match(skill, /resume only the implementer session/i);
  assert.doesNotMatch(skill, /\bMCP\b/i);
  assert.doesNotMatch(skill, /taskferry setup/);
});
