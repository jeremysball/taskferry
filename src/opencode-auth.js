// Serialized into the sandbox command. No credential values enter argv or logs.
function runWithImportedCredentials() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const args = process.argv.slice(1);
  const model = args[args.indexOf("-m") + 1];
  const provider = model?.split("/")[0];
  const dataHome = process.env.XDG_DATA_HOME;
  if (!dataHome) {
    process.stderr.write("OpenCode V2 credential bootstrap requires the sandbox data home\n");
    process.exit(1);
  }
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(dataHome, "opencode", "auth.json"), "utf8"));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      process.stderr.write("OpenCode V2 credential bootstrap failed: could not read mounted auth.json\n");
      process.exit(1);
    }
  }
  const legacy = auth?.[provider];
  function credentialValue() {
    if (legacy?.type === "api") return { type: "key", key: legacy.key };
    // OAuth method IDs are integration-specific. Only OpenAI's mapping is known.
    if (provider === "openai" && legacy?.type === "oauth") {
      return { type: "oauth", methodID: "chatgpt-browser", access: legacy.access, refresh: legacy.refresh, expires: legacy.expires,
        ...(legacy.accountId ? { metadata: { accountID: legacy.accountId } } : {}) };
    }
    return null;
  }
  const value = credentialValue();
  if (value) {
    const entry = { id: `cred_taskferry_${Buffer.from(provider).toString("hex")}`, integrationID: provider, label: "Taskferry", active: true, value };
    const imported = spawnSync("opencode", ["auth", "import", "--standalone"], {
      input: JSON.stringify([entry]), stdio: ["pipe", "ignore", "pipe"], timeout: 30000,
    });
    if (imported.status !== 0) {
      // CLI diagnostics may contain secrets; never forward captured output.
      process.stderr.write("OpenCode V2 credential import failed; worker was not started\n");
      process.exit(1);
    }
  }
  const result = spawnSync("opencode", args, { stdio: "inherit" });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

/** @param {string[]} args @returns {string[]} */
export function buildV2SandboxSpawn(args) {
  return [process.execPath, "--eval", `(${runWithImportedCredentials.toString()})()`, "--", ...args];
}
