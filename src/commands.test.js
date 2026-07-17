import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

function fakeIo() {
  const stdout = [];
  return { stdout: { write: (chunk) => stdout.push(chunk) }, lines: stdout };
}

function fakeClient({ onSubscribe } = {}) {
  const closed = { value: false };
  return {
    closed,
    async request() {
      throw new Error("request() not stubbed for this test");
    },
    async subscribe(params, onEvent) {
      if (onSubscribe) onSubscribe(params, onEvent);
      return "sub-1";
    },
    close() {
      closed.value = true;
    },
  };
}

test("watch prints each event through formatWatchEvent and resolves on abort", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  const controller = new AbortController();
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false }, {
    client,
    io,
    signal: controller.signal,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  controller.abort();
  const result = await pending;

  assert.equal(result.directory, root);
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1);
  assert.match(io.lines[0], /oc_1/);
});

test("watch --task-id filters events to one task and exits on its terminal event", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskferry-commands-test-")));
  let deliver;
  const client = fakeClient({
    onSubscribe: (_params, onEvent) => {
      deliver = onEvent;
    },
  });
  const io = fakeIo();

  const pending = runCommand("watch", { directory: root, format: "toon", summaries: false, taskId: "oc_1" }, {
    client,
    io,
    cwd: root,
  });

  deliver({ sequence: 1, type: "task.state", taskId: "oc_2", directory: root, status: "running" });
  deliver({ sequence: 2, type: "task.state", taskId: "oc_1", directory: root, status: "running" });
  deliver({ sequence: 3, type: "task.state", taskId: "oc_1", directory: root, status: "done" });

  const result = await pending;
  assert.equal(result.watching, false);
  assert.equal(io.lines.length, 1, "only the matching task's events should print");
  assert.match(io.lines[0], /oc_1/);
  assert.match(io.lines[0], /running/);
});
