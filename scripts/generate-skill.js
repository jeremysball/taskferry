import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Both integrations/* copies are committed, not gitignored: each plugin
// marketplace (Claude Code, Codex) reads its skill file straight from this
// repo's git history at its own path, so a stale/missing copy ships wrong
// content to real installs rather than just failing a rebuild.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillFileName = "SKILL.md";
const skillDirName = "using-taskferry";
const skillRelativePath = path.join("skills", skillDirName, skillFileName);
const generatedRelativePaths = [
  path.join("integrations", "claude", "skills", skillDirName, skillFileName),
  path.join("integrations", "codex", "skills", skillDirName, skillFileName),
];

function canonicalSkill(root) {
  return fs.readFileSync(path.join(root, skillRelativePath), "utf8");
}

export function generateSkills(root = repositoryRoot) {
  const content = canonicalSkill(root);
  for (const relativePath of generatedRelativePaths) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}

export function checkSkills(root = repositoryRoot) {
  const content = canonicalSkill(root);
  const stale = generatedRelativePaths.filter((relativePath) => {
    const destination = path.join(root, relativePath);
    return !fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== content;
  });

  if (stale.length) {
    throw new Error(`stale generated skill copies: ${stale.join(", ")}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [option] = process.argv.slice(2);
  try {
    if (option && option !== "--check") {
      throw new Error("usage: node scripts/generate-skill.js [--check]");
    }
    if (option === "--check") {
      checkSkills();
    } else {
      generateSkills();
      process.stdout.write("Generated distributed taskferry skills.\n");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
