import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./commands.js";

const TASK_RESULT_METHOD = "task.result";

function fakeClient(respond) {
  return {
    request: async (method, params) => {
      assert.equal(method, TASK_RESULT_METHOD);
      return respond(params);
    },
  };
}

function fakeIo() {
  const lines = [];
  return { stdout: { write: (chunk) => lines.push(chunk) }, lines };
}

test("result --diff --raw writes the diff verbatim and skips the TOON document", async () => {
  const client = fakeClient((params) => {
    assert.deepEqual(params.fields, ["diff"]);
    return { taskId: "oc_raw", diff: "--- a/x\n+++ b/x\n+naïve — text\n" };
  });
  const io = fakeIo();

  const value = await runCommand("result", { taskId: "oc_raw", diff: true, raw: true }, { client, io });

  assert.equal(value, undefined);
  assert.deepEqual(io.lines, ["--- a/x\n+++ b/x\n+naïve — text\n"]);
});

test("result --diff --raw surfaces a retained-diff miss as an error, not an empty write", async () => {
  const client = fakeClient(() => ({ taskId: "oc_gone", diff: null }));
  const io = fakeIo();

  await assert.rejects(
    () => runCommand("result", { taskId: "oc_gone", diff: true, raw: true }, { client, io }),
    /has no diff to display/
  );
  assert.deepEqual(io.lines, []);
});

test("result --diff --raw falls back to the TOON path when the payload omits diff", async () => {
  const client = fakeClient(() => ({ taskId: "oc_nodiff" }));
  const io = fakeIo();

  const value = await runCommand("result", { taskId: "oc_nodiff", diff: true, raw: true }, { client, io });

  assert.equal(value.taskId, "oc_nodiff");
  assert.deepEqual(io.lines, []);
});
