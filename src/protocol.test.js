import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  RPC_METHODS,
  ProtocolError,
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
