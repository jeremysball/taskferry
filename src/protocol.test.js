import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  RPC_METHODS,
  ProtocolError,
  RESULT_FIELDS,
  encodeMessage,
  errorResponse,
  eventMessage,
  parseRequestLine,
  successResponse,
} from "./protocol.js";

const expectedMethods = [
  "system.health",
  "task.dispatch",
  "task.cancel",
  "task.status",
  "task.wait",
  "task.list",
  "task.result",
  "task.tail",
  "task.summary",
  "task.advisor",
  "task.context",
  "task.accept",
  "task.reject",
];

function request(method, params = {}, overrides = {}) {
  return JSON.stringify({ version: 1, id: "req-1", method, params, ...overrides });
}

describe("private daemon protocol", () => {
  test("exports the exact version and RPC method list", () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.deepEqual(RPC_METHODS, expectedMethods);
  });

  test("encodes each message as one newline-terminated JSON object", () => {
    const message = { version: 1, id: "one", ok: true, result: { text: "line one\nline two" } };
    const encoded = encodeMessage(message);

    assert.equal(encoded.endsWith("\n"), true);
    assert.equal(encoded.slice(0, -1).includes("\n"), false);
    assert.deepEqual(JSON.parse(encoded), message);
  });

  test("parses a valid request envelope", () => {
    assert.deepEqual(parseRequestLine(request("task.status", { taskId: "oc_123" })), {
      version: 1,
      id: "req-1",
      method: "task.status",
      params: { taskId: "oc_123" },
    });
  });

  test("rejects malformed JSON with a protocol error", () => {
    assert.throws(
      () => parseRequestLine("{not json"),
      (error) => error instanceof ProtocolError && error.code === "MALFORMED_JSON" && error.requestId === null
    );
  });

  test("rejects unsupported protocol versions and preserves the request id", () => {
    assert.throws(
      () => parseRequestLine(request("system.health", {}, { version: 2 })),
      (error) => error instanceof ProtocolError && error.code === "UNSUPPORTED_VERSION" && error.requestId === "req-1"
    );
  });

  test("rejects unknown methods", () => {
    assert.throws(
      () => parseRequestLine(request("task.nope")),
      (error) => error instanceof ProtocolError && error.code === "UNKNOWN_METHOD"
    );
  });

  test("accepts event.subscribe as a transport control request outside RPC_METHODS", () => {
    const parsed = parseRequestLine(request("event.subscribe", { directory: "/tmp/project" }));
    assert.equal(parsed.method, "event.subscribe");
    assert.equal(RPC_METHODS.includes("event.subscribe"), false);
  });

  test("task.dispatch accepts an optional originSessionId string", () => {
    const parsed = parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      originSessionId: "sess-abc",
    }));
    assert.equal(parsed.params.originSessionId, "sess-abc");
  });

  test("task.dispatch rejects a non-string originSessionId", () => {
    assert.throws(() => parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      originSessionId: 42,
    })), /invalid params/i);
  });

  test("task.dispatch accepts an optional noSandbox boolean", () => {
    const parsed = parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      noSandbox: true,
    }));
    assert.equal(parsed.params.noSandbox, true);
  });

  test("task.dispatch rejects a non-boolean noSandbox", () => {
    assert.throws(() => parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      noSandbox: "true",
    })), /invalid params/i);
  });

  test("task.dispatch accepts an optional executor param", () => {
    const parsed = parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      executor: "pi",
    }));
    assert.equal(parsed.params.executor, "pi");
  });

  test("task.dispatch rejects an invalid executor param", () => {
    assert.throws(
      () => parseRequestLine(request("task.dispatch", {
        prompt: "hi",
        directory: "/tmp/project",
        executor: "bogus",
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.advisor accepts an optional executor param", () => {
    const parsed = parseRequestLine(request("task.advisor", {
      prompt: "hi",
      directory: "/tmp/project",
      model: "m",
      executor: "opencode",
    }));
    assert.equal(parsed.params.executor, "opencode");
  });

  test("task.advisor rejects an invalid executor param", () => {
    assert.throws(
      () => parseRequestLine(request("task.advisor", {
        prompt: "hi",
        directory: "/tmp/project",
        model: "m",
        executor: "bogus",
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.dispatch accepts an optional env object of string values", () => {
    const parsed = parseRequestLine(request("task.dispatch", {
      prompt: "hi",
      directory: "/tmp/project",
      env: { FOO: "bar", EMPTY: "" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar", EMPTY: "" });
  });

  test("task.dispatch rejects an env value with a non-string entry", () => {
    assert.throws(
      () => parseRequestLine(request("task.dispatch", {
        prompt: "hi",
        directory: "/tmp/project",
        env: { FOO: 42 },
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.dispatch rejects env: null, env: [], env: 42, and env: 'string'", () => {
    for (const bad of [null, [], 42, "string"]) {
      assert.throws(
        () => parseRequestLine(request("task.dispatch", {
          prompt: "hi",
          directory: "/tmp/project",
          env: bad,
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS",
        `expected INVALID_PARAMS for env=${JSON.stringify(bad)}`
      );
    }
  });

  test("task.dispatch no longer accepts keySlot", () => {
    assert.throws(
      () => parseRequestLine(request("task.dispatch", {
        prompt: "hi",
        directory: "/tmp/project",
        keySlot: "primary",
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.advisor accepts an optional env object", () => {
    const parsed = parseRequestLine(request("task.advisor", {
      prompt: "hi",
      directory: "/tmp/project",
      model: "m",
      env: { FOO: "bar" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar" });
  });

  test("task.advisor rejects an env value with a non-string entry", () => {
    assert.throws(
      () => parseRequestLine(request("task.advisor", {
        prompt: "hi",
        directory: "/tmp/project",
        model: "m",
        env: { FOO: 42 },
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("task.summary accepts an optional env object", () => {
    const parsed = parseRequestLine(request("task.summary", {
      taskId: "oc_123",
      env: { FOO: "bar" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar" });
  });

  test("task.summary accepts env alongside mode \"report\"", () => {
    const parsed = parseRequestLine(request("task.summary", {
      taskId: "oc_123",
      mode: "report",
      env: { FOO: "bar" },
    }));
    assert.deepEqual(parsed.params.env, { FOO: "bar" });
    assert.equal(parsed.params.mode, "report");
  });

  test("task.summary rejects env with mode \"activity\" as an INVALID_PARAMS validation error (not a silent drop)", () => {
    assert.throws(
      () => parseRequestLine(request("task.summary", {
        taskId: "oc_123",
        mode: "activity",
        env: { FOO: "bar" },
      })),
      (error) => error instanceof ProtocolError
        && error.code === "INVALID_PARAMS"
        && /mode "activity"/.test(error.message)
        && /env/.test(error.message)
        && /Omit env/.test(error.help)
    );
  });

  test("task.summary rejects an env value with a non-string entry", () => {
    assert.throws(
      () => parseRequestLine(request("task.summary", {
        taskId: "oc_123",
        env: { FOO: 42 },
      })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("event.subscribe accepts an optional originSessionId string", () => {
    const parsed = parseRequestLine(request("event.subscribe", {
      directory: "/tmp/project",
      originSessionId: "sess-abc",
    }));
    assert.equal(parsed.params.originSessionId, "sess-abc");
  });

  test("event.subscribe rejects a non-string originSessionId", () => {
    assert.throws(() => parseRequestLine(request("event.subscribe", {
      directory: "/tmp/project",
      originSessionId: 42,
    })), /invalid params/i);
  });

  test("event.subscribe accepts taskId in place of directory (issue #59)", () => {
    const parsed = parseRequestLine(request("event.subscribe", { taskId: "oc_1" }));
    assert.equal(parsed.method, "event.subscribe");
  });

  test("event.subscribe rejects an empty params object (neither directory nor taskId)", () => {
    assert.throws(() => parseRequestLine(request("event.subscribe", {})), /invalid params/i);
  });

  test("rejects invalid request envelopes and params", () => {
    assert.throws(
      () => parseRequestLine(JSON.stringify({ version: 1, id: "req-1", method: "system.health" })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST"
    );
    assert.throws(
      () => parseRequestLine(request("task.status", {})),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
    assert.throws(
      () => parseRequestLine(request("task.list", { directory: "relative" })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
    assert.throws(
      () => parseRequestLine(request("system.health", { extra: true })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
    assert.throws(
      () => parseRequestLine(JSON.stringify({ id: "req-1", method: "system.health", params: {} })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST"
    );
    assert.throws(
      () => parseRequestLine(request("system.health", {}, { extra: true })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST"
    );
    assert.throws(
      () => parseRequestLine(request("task.result", { taskId: "oc_123", fields: ["notAResultField"] })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  test("accepts task.result with failureDetail in params.fields", () => {
    const parsed = parseRequestLine(request("task.result", { taskId: "oc_123", fields: ["failureDetail"] }));
    assert.deepEqual(parsed.params.fields, ["failureDetail"]);
    assert.throws(
      () => parseRequestLine(request("task.result", { taskId: "oc_123", fields: ["failureDetail", "notAResultField"] })),
      (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
    );
  });

  describe("task.accept / task.reject", () => {
    test("accepts a valid taskId-only request", () => {
      const parsed = parseRequestLine(request("task.accept", { taskId: "oc_1" }));
      assert.equal(parsed.method, "task.accept");
      assert.deepEqual(parsed.params, { taskId: "oc_1" });
    });

    test("accepts a valid task.reject taskId-only request", () => {
      const parsed = parseRequestLine(request("task.reject", { taskId: "oc_1" }));
      assert.equal(parsed.method, "task.reject");
      assert.deepEqual(parsed.params, { taskId: "oc_1" });
    });

    test("rejects task.accept with extra params", () => {
      assert.throws(
        () => parseRequestLine(request("task.accept", { taskId: "oc_1", extra: true })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("rejects task.reject with a missing taskId", () => {
      assert.throws(
        () => parseRequestLine(request("task.reject", {})),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });
  });

  describe("RESULT_FIELDS", () => {
    test("includes diff, diffStat, and changesetError", () => {
      assert.ok(RESULT_FIELDS.has("diff"));
      assert.ok(RESULT_FIELDS.has("diffStat"));
      assert.ok(RESULT_FIELDS.has("changesetError"));
    });
  });

  test("constructs exact response and event envelopes", () => {
    assert.deepEqual(successResponse("req-1", { healthy: true }), {
      version: 1,
      id: "req-1",
      ok: true,
      result: { healthy: true },
    });
    assert.deepEqual(errorResponse("req-1", "UNKNOWN_TASK", "unknown task id: oc_123", "Run `taskferry list` to see valid task ids"), {
      version: 1,
      id: "req-1",
      ok: false,
      error: {
        code: "UNKNOWN_TASK",
        message: "unknown task id: oc_123",
        help: "Run `taskferry list` to see valid task ids",
      },
    });
    assert.deepEqual(eventMessage("sub-1", { type: "task.state", taskId: "oc_123" }), {
      version: 1,
      type: "event",
      subscriptionId: "sub-1",
      event: { type: "task.state", taskId: "oc_123" },
    });
  });
});
