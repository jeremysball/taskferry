## Task 1: `.taskferry.toml` loader (`src/project-config.js`)

**Files:**
- Create: `src/project-config.js`
- Create: `src/project-config.test.js`
- Modify: `package.json` (add `smol-toml` dependency, register `src/project-config.test.js` in the `test:unit` script)

**Interfaces:**
- Produces: `resolveProjectConfigPath(directory: string): string`, `loadProjectConfig(directory: string, deps?): ProjectConfig`, `verificationPromptBlock(checkCommand: string): string`, `_resetProjectConfigCache(): void`. `ProjectConfig = { check: string|null, checkTimeoutSeconds: number, readOnlyPaths: string[], parseError: string|null }`. Every later task that touches `.taskferry.toml` imports these three functions from `./project-config.js` — do not duplicate the loading/caching logic anywhere else.

- [ ] **Step 1: Add the `smol-toml` dependency**

```bash
npm install smol-toml@^1.7.1
```

Verify: `package.json`'s `dependencies` now has `"smol-toml": "^1.7.1"` alongside the existing `"@toon-format/toon"` entry.

- [ ] **Step 2: Write the failing tests**

Create `src/project-config.test.js`:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectConfigPath, loadProjectConfig, verificationPromptBlock, _resetProjectConfigCache } from "./project-config.js";

function tmpProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "axi-project-config-test-"));
}

function writeConfig(dir, content) {
  fs.writeFileSync(resolveProjectConfigPath(dir), content);
}

describe("loadProjectConfig", () => {
  test("no .taskferry.toml -> no gate, no read-only paths, no error", () => {
    const dir = tmpProjectDir();
    const config = loadProjectConfig(dir);
    assert.deepEqual(config, { check: null, checkTimeoutSeconds: 900, readOnlyPaths: [], parseError: null });
  });

  test("parses check, check_timeout_seconds, and read_only_paths", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "bun x check"\ncheck_timeout_seconds = 120\nread_only_paths = ["/a", "/b"]\n`);
    const config = loadProjectConfig(dir);
    assert.deepEqual(config, { check: "bun x check", checkTimeoutSeconds: 120, readOnlyPaths: ["/a", "/b"], parseError: null });
  });

  test("check_timeout_seconds defaults to 900 when absent", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm run check"\n`);
    assert.equal(loadProjectConfig(dir).checkTimeoutSeconds, 900);
  });

  test("invalid TOML syntax never throws: returns EMPTY_CONFIG-shaped result with parseError set", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = \n`);
    const config = loadProjectConfig(dir);
    assert.equal(config.check, null);
    assert.equal(config.readOnlyPaths.length, 0);
    assert.match(config.parseError, /taskferry\.toml/);
  });

  test("unrecognized key is a validation error, not a silent pass-through", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\nnotarealfield = 1\n`);
    const config = loadProjectConfig(dir);
    assert.equal(config.check, null);
    assert.match(config.parseError, /notarealfield/);
  });

  test("check_timeout_seconds must be a positive integer", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\ncheck_timeout_seconds = -1\n`);
    assert.match(loadProjectConfig(dir).parseError, /check_timeout_seconds/);
  });

  test("read_only_paths must be an array of strings", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\nread_only_paths = [1, 2]\n`);
    assert.match(loadProjectConfig(dir).parseError, /read_only_paths/);
  });

  test("caches by mtime: a second call without a file change does not re-read", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\n`);
    let reads = 0;
    const deps = { readFileFn: (p) => { reads++; return fs.readFileSync(p, "utf8"); } };
    loadProjectConfig(dir, deps);
    loadProjectConfig(dir, deps);
    assert.equal(reads, 1);
  });

  test("cache invalidates when mtime changes", () => {
    const dir = tmpProjectDir();
    writeConfig(dir, `check = "npm test"\n`);
    assert.equal(loadProjectConfig(dir).check, "npm test");
    // Force a distinct mtime -- same-millisecond rewrites can land on an
    // unchanged mtimeMs on fast filesystems.
    fs.utimesSync(resolveProjectConfigPath(dir), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    writeConfig(dir, `check = "npm run check"\n`);
    assert.equal(loadProjectConfig(dir).check, "npm run check");
  });
});

describe("verificationPromptBlock", () => {
  test("renders the required-verification block with the check command embedded", () => {
    const block = verificationPromptBlock("bun x check");
    assert.match(block, /## Verification \(required\)/);
    assert.match(block, /bun x check/);
    assert.match(block, /Run it before declaring the task done/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `env -u TASKFERRY_CHILD node --test src/project-config.test.js`
Expected: FAIL with `Cannot find module './project-config.js'` (the module doesn't exist yet).

- [ ] **Step 4: Implement `src/project-config.js`**

```js
// src/project-config.js
import fs from "node:fs";
import path from "node:path";
import { parse, TomlError } from "smol-toml";

const CONFIG_FILENAME = ".taskferry.toml";
const DEFAULT_CHECK_TIMEOUT_SECONDS = 900;
const KNOWN_KEYS = new Set(["check", "check_timeout_seconds", "read_only_paths"]);

/** @typedef {{check: string|null, checkTimeoutSeconds: number, readOnlyPaths: string[], parseError: string|null}} ProjectConfig */

/** @type {ProjectConfig} */
const EMPTY_CONFIG = Object.freeze({ check: null, checkTimeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS, readOnlyPaths: [], parseError: null });

// Per-path cache: configPath -> { mtimeMs: number|null, result: ProjectConfig }.
// mtimeMs null means "file did not exist at last load" -- same shape as
// config.js's _configCache, so an edit (or a file appearing/disappearing) is
// observed on the next loadProjectConfig() call without an explicit reset.
const _projectConfigCache = new Map();

/** Exported for test use only. */
export function _resetProjectConfigCache() {
  _projectConfigCache.clear();
}

/** @param {string} directory @returns {string} */
export function resolveProjectConfigPath(directory) {
  return path.join(directory, CONFIG_FILENAME);
}

/**
 * @param {unknown} raw
 * @param {string} configPath
 * @returns {ProjectConfig}
 */
function validateAndNormalize(raw, configPath) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_CONFIG, parseError: `${configPath} must contain a TOML table at the top level` };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const errors = [];
  if (record.check !== undefined && typeof record.check !== "string") {
    errors.push(`"check" must be a string (got ${JSON.stringify(record.check)})`);
  }
  if (record.check_timeout_seconds !== undefined && !(Number.isInteger(record.check_timeout_seconds) && record.check_timeout_seconds > 0)) {
    errors.push(`"check_timeout_seconds" must be a positive integer (got ${JSON.stringify(record.check_timeout_seconds)})`);
  }
  const readOnlyPaths = record.read_only_paths;
  if (readOnlyPaths !== undefined && !(Array.isArray(readOnlyPaths) && readOnlyPaths.every((entry) => typeof entry === "string"))) {
    errors.push(`"read_only_paths" must be an array of strings (got ${JSON.stringify(readOnlyPaths)})`);
  }
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unrecognized key "${key}"`);
  }
  if (errors.length) {
    return { ...EMPTY_CONFIG, parseError: `${configPath}: ${errors.join("; ")}` };
  }
  return {
    check: /** @type {string|undefined} */ (record.check) ?? null,
    checkTimeoutSeconds: /** @type {number|undefined} */ (record.check_timeout_seconds) ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
    readOnlyPaths: /** @type {string[]|undefined} */ (record.read_only_paths) ?? [],
    parseError: null,
  };
}

/**
 * Loads `.taskferry.toml` from a dispatch's working-tree root. Never throws:
 * an absent file returns EMPTY_CONFIG (no gate, no injection, no extra
 * binds); an unparseable or invalid file also returns an EMPTY_CONFIG-shaped
 * result, but with `parseError` set so the caller can surface a loud warning
 * instead of silently guessing a partial config -- dispatch proceeds with no
 * gate, per the design's error table. Cached per absolute path by mtime,
 * mirroring config.js's loadConfig() invalidation strategy, so the three
 * independent call sites in a task's lifecycle (dispatch-time prompt
 * injection, spawn-time read-only binds, settle-time gate) each pay only a
 * stat() when the file hasn't changed since the last read.
 * @param {string} directory
 * @param {{statFn?: (p: string) => {mtimeMs: number}, readFileFn?: (p: string) => string}} [deps]
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(directory, { statFn = fs.statSync, readFileFn = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const configPath = resolveProjectConfigPath(directory);
  let currentMtimeMs;
  try {
    currentMtimeMs = statFn(configPath).mtimeMs;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      const cached = _projectConfigCache.get(configPath);
      if (cached && cached.mtimeMs === null) return cached.result;
      _projectConfigCache.set(configPath, { mtimeMs: null, result: EMPTY_CONFIG });
      return EMPTY_CONFIG;
    }
    throw err;
  }
  const cached = _projectConfigCache.get(configPath);
  if (cached && cached.mtimeMs === currentMtimeMs) return cached.result;

  /** @type {ProjectConfig} */
  let result;
  try {
    result = validateAndNormalize(parse(readFileFn(configPath)), configPath);
  } catch (err) {
    if (err instanceof TomlError) {
      result = { ...EMPTY_CONFIG, parseError: `${configPath}: ${err.message.split("\n")[0]}` };
    } else {
      throw err;
    }
  }
  _projectConfigCache.set(configPath, { mtimeMs: currentMtimeMs, result });
  return result;
}

/**
 * The always-on prompt block appended to a dispatch's prompt when the
 * project declares a check command, verbatim per the design's §3.
 * @param {string} checkCommand
 * @returns {string}
 */
export function verificationPromptBlock(checkCommand) {
  return `\n\n## Verification (required)\nThis repo declares a check command in .taskferry.toml:\n    ${checkCommand}\nRun it before declaring the task done. If it fails, fix the failures and\nre-run until it passes. State the final result in your summary.\n`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `env -u TASKFERRY_CHILD node --test src/project-config.test.js`
Expected: PASS, all tests green.

- [ ] **Step 6: Register the new test file and commit**

In `package.json`'s `test:unit` script, append `src/project-config.test.js` to the space-separated file list (alphabetically near `src/protocol.test.js`, matching the script's existing ordering-by-topic pattern — exact position doesn't matter, just don't drop any existing entry).

```bash
git add package.json package-lock.json src/project-config.js src/project-config.test.js
git commit -m "feat(config): add .taskferry.toml loader (project-config.js)"
```

---

