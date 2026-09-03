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
const resourcesRelativePath = path.join("skills", skillDirName, "resources");
const generatedRelativePaths = [
  path.join("integrations", "claude", "skills", skillDirName, skillFileName),
  path.join("integrations", "codex", "skills", skillDirName, skillFileName),
  path.join("integrations", "kilo", "skills", skillDirName, skillFileName),
];
// Resource files under the canonical skill dir are copied to each integration
// copy so a SKILL.md that references them (e.g. resources/deciding-to-dispatch.md)
// stays self-contained for plugin consumers, who read straight from git history.
const generatedResourcesRelativePaths = [
  path.join("integrations", "claude", "skills", skillDirName, "resources"),
  path.join("integrations", "codex", "skills", skillDirName, "resources"),
  path.join("integrations", "kilo", "skills", skillDirName, "resources"),
];

function canonicalSkill(root) {
  return fs.readFileSync(path.join(root, skillRelativePath), "utf8");
}

// Copy a directory tree (canonical source dir -> destination dir).
function copyTree(root, sourceRelative, destRelative) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyTree(root, path.join(sourceRelative, entry.name), path.join(destRelative, entry.name));
      continue;
    }
    const destPath = path.join(root, destRelative, entry.name);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(source, entry.name), destPath);
  }
}

// Mirror, not merge: the destination is cleared first so a resource renamed or
// deleted canonically doesn't survive as an orphan. checkSkills() reports such
// an orphan as drift, so leaving it behind would make `skill:generate` unable
// to fix what `skill:check` complains about.
//
// Fail fast on a missing canonical source instead of silently clearing the
// destination: copyTree() no-ops when its source is absent, so a mistakenly
// deleted or renamed canonical resources dir would otherwise wipe every
// integration's copy on the next `skill:generate` with no error.
function mirrorTree(root, sourceRelative, destRelative) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) {
    throw new Error(`mirrorTree: canonical source is missing: ${sourceRelative}`);
  }
  fs.rmSync(path.join(root, destRelative), { recursive: true, force: true });
  copyTree(root, sourceRelative, destRelative);
}

// `baseRelative` stays fixed at the top-level call's sourceRelative across
// every recursive call, so a nested file's relative path keeps its full
// subdirectory prefix (e.g. "guides/foo.md") instead of being recomputed
// against the recursion-local sourceRelative, which would report "foo.md".
function collectRelativeFiles(root, sourceRelative, baseRelative = sourceRelative) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) return [];
  const files = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const srcPath = path.join(source, entry.name);
    if (entry.isDirectory()) {
      for (const f of collectRelativeFiles(root, path.join(sourceRelative, entry.name), baseRelative)) {
        files.push(f);
      }
    } else {
      files.push(path.relative(path.join(root, baseRelative), srcPath));
    }
  }
  return files;
}

export function generateSkills(root = repositoryRoot) {
  const content = canonicalSkill(root);
  for (const relativePath of generatedRelativePaths) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  for (const destRelative of generatedResourcesRelativePaths) {
    mirrorTree(root, resourcesRelativePath, destRelative);
  }
}

// Resource files must be in sync too: every canonical resource file must have
// a byte-identical copy at each integration path, and a stale copy that no
// longer exists canonically must be flagged as drift.
function staleResourceCopies(root) {
  const canonicalResources = collectRelativeFiles(root, resourcesRelativePath);
  const stale = [];
  for (const destRelative of generatedResourcesRelativePaths) {
    const destBase = path.join(root, destRelative);
    for (const rel of canonicalResources) {
      const copy = path.join(destBase, rel);
      if (!fs.existsSync(copy) || fs.readFileSync(path.join(root, resourcesRelativePath, rel), "utf8") !== fs.readFileSync(copy, "utf8")) {
        stale.push(path.relative(root, copy));
      }
    }
    // Any file present in a generated resources dir that isn't in the canonical
    // set is stale.
    const copyFiles = fs.existsSync(destBase) ? collectRelativeFiles(root, destRelative) : [];
    for (const rel of copyFiles) {
      if (!canonicalResources.includes(rel)) {
        stale.push(path.relative(root, path.join(destBase, rel)));
      }
    }
  }
  return stale;
}

export function checkSkills(root = repositoryRoot) {
  const content = canonicalSkill(root);
  const stale = generatedRelativePaths.filter((relativePath) => {
    const destination = path.join(root, relativePath);
    return !fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== content;
  });

  stale.push(...staleResourceCopies(root));

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
