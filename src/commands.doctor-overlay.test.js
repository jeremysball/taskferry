import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

const trackedTmpDirs = [];
after(() => {
  for (const dir of trackedTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const PLUGIN_INSTALLED = {
  status: 0,
  stdout: JSON.stringify([{ id: "taskferry@taskferry" }]),
  stderr: "",
  error: null,
};

test("doctor warns when overlay storage is below the reserve", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-doctor-overlay-"));
  trackedTmpDirs.push(home);
  const mib = 1024 * 1024;
  const client = {
    request: async (method) => {
      assert.equal(method, "system.health");
      return {
        healthy: true,
        pid: 1,
        version: 1,
        overlayStorage: {
          checked: true,
          ok: false,
          root: "/run/user/1000/taskferry/overlay",
          freeBytes: 10 * mib,
          totalBytes: 1024 * mib,
          minFreeBytes: 256 * mib,
          pendingChangesets: 2,
        },
      };
    },
    close() {},
  };
  const runShellCommand = async (command) => {
    if (command === "bwrap") {
      return { status: 0, stdout: "bubblewrap 0.11.2\n", stderr: "", error: null };
    }
    return PLUGIN_INSTALLED;
  };

  const result = await runCommand("doctor", {}, {
    homeDirectory: home,
    env: {},
    platform: "linux",
    client,
    runShellCommand,
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Overlay storage is low/);
  assert.match(result.warnings[0], /10\.0 MiB free of 1\.0 GiB/);
  assert.match(result.warnings[0], /256\.0 MiB reserve/);
  assert.match(result.warnings[0], /Dispatches that create an overlay are refused/);
  assert.doesNotMatch(result.warnings[0], /New dispatches are refused/);
  assert.match(result.warnings[0], /2 task\(s\) hold pending changesets/);
});
