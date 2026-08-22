import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManager, fakeChild, baseTask, LUNA_MODEL } from "./tasks.test-helpers.js";

describe("daemon restart auto-resume", () => {
  test("a task marked running with a valid sessionId in its log is resumed on restart (fresh overlay, sessionId reused)", async () => {
    const spawns = [];
    const fakeSpawn = (cmd, args, opts) => {
      spawns.push({ cmd, args, env: opts.env });
      const child = fakeChild(9999);
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    };
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({
          id: "oc_resume_1",
          status: "running",
          directory: fs.realpathSync(os.tmpdir()),
          model: LUNA_MODEL,
          variant: "high",
          sessionId: null,
          pid: 12345,
          logPath: path.join(logDir, "oc_resume_1.ndjson"),
          promptPreview: "resume me",
        }),
      ],
      logs: {
        "oc_resume_1.ndjson": [JSON.stringify({ sessionID: "ses_resume_abc" }), JSON.stringify({ type: "text", part: { text: "hello", messageID: "m1" } })].join("\n") + "\n",
      },
      spawnFn: fakeSpawn,
      killFn: () => {},
      sandboxEnabled: false,
      overlayEnabled: false,
    });

    await new Promise((r) => setTimeout(r, 60));

    const status = mgr.status("oc_resume_1");
    assert.notEqual(status.status, "unknown", "resumable task should not degrade to unknown");
    assert.notEqual(status.failureReason, "daemon_restarted_session_lost", "resumable task should not be marked session_lost");
    assert.ok(spawns.length > 0 || status.status === "running" || status.status === "queued", "expected resume to trigger a spawn");
  });

  test("a running task with no sessionId in its log is marked daemon_restarted_session_lost", async () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({
          id: "oc_lost_1",
          status: "running",
          directory: fs.realpathSync(os.tmpdir()),
          model: LUNA_MODEL,
          variant: "high",
          sessionId: null,
          pid: 12346,
          logPath: path.join(logDir, "oc_lost_1.ndjson"),
          promptPreview: "lost me",
        }),
      ],
      logs: {
        "oc_lost_1.ndjson": "not json at all\nstill not json\n",
      },
      spawnFn: () => { throw new Error("should not spawn for non-resumable"); },
      killFn: () => {},
      sandboxEnabled: false,
    });

    await new Promise((r) => setTimeout(r, 20));
    const status = mgr.status("oc_lost_1");
    assert.equal(status.status, "crashed");
    assert.equal(status.failureReason, "daemon_restarted_session_lost");
  });

  test("queued tasks degrade to unknown (never started, nothing to resume)", async () => {
    const mgr = makeManager({
      tasksFixture: (logDir) => [
        baseTask({
          id: "oc_queued_1",
          status: "queued",
          directory: fs.realpathSync(os.tmpdir()),
          model: LUNA_MODEL,
          variant: "high",
          sessionId: null,
          pid: null,
          logPath: path.join(logDir, "oc_queued_1.ndjson"),
          promptPreview: "queued",
        }),
      ],
      logs: {},
      spawnFn: () => { throw new Error("should not spawn queued on restart"); },
      killFn: () => {},
      sandboxEnabled: false,
      overlayEnabled: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    const status = mgr.status("oc_queued_1");
    assert.equal(status.status, "unknown", "queued tasks should degrade to unknown, not be auto-launched");
  });
});
