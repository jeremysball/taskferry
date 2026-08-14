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

const TEST_DIR = "/tmp/project";
const ERROR_MESSAGE_UNKNOWN_TASK = "unknown task id: oc_123";

const METHOD = Object.freeze({
  health: "system.health",
  dispatch: "task.dispatch",
  cancel: "task.cancel",
  status: "task.status",
  wait: "task.wait",
  list: "task.list",
  stats: "task.stats",
  result: "task.result",
  tail: "task.tail",
  summary: "task.summary",
  advisor: "task.advisor",
  context: "task.context",
  accept: "task.accept",
  reject: "task.reject",
  output: "task.output",
  subscribe: "event.subscribe",
});

const expectedMethods = [
  METHOD.health,
  METHOD.dispatch,
  METHOD.cancel,
  METHOD.status,
  METHOD.wait,
  METHOD.list,
  METHOD.stats,
  METHOD.result,
  METHOD.tail,
  METHOD.summary,
  METHOD.advisor,
  METHOD.context,
  METHOD.accept,
  METHOD.reject,
  METHOD.output,
];

function request(method, params = {}, overrides = {}) {
  return JSON.stringify({ version: 1, id: "req-1", method, params, ...overrides });
}

/** @param {unknown} error @returns {boolean} */
function isSummaryEnvActivityError(error) {
  if (!(error instanceof ProtocolError) || error.code !== "INVALID_PARAMS") {
    return false;
  }
  return /env/.test(error.message)
    && /mode "activity"/.test(error.message)
    && /Omit env/.test(error.help);
}

describe("protocol version, method list, and envelope", () => {
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
      assert.deepEqual(parseRequestLine(request(METHOD.status, { taskId: "oc_123" })), {
        version: 1,
        id: "req-1",
        method: METHOD.status,
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
        () => parseRequestLine(request(METHOD.health, {}, { version: 2 })),
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
      const parsed = parseRequestLine(request(METHOD.subscribe, { directory: TEST_DIR }));
      assert.equal(parsed.method, METHOD.subscribe);
      assert.equal(RPC_METHODS.includes(METHOD.subscribe), false);
    });
  });

  describe("task.dispatch and task.advisor params", () => {
    test("task.dispatch accepts an optional originSessionId string", () => {
      const parsed = parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        originSessionId: "sess-abc",
      }));
      assert.equal(parsed.params.originSessionId, "sess-abc");
    });

    test("task.dispatch rejects a non-string originSessionId", () => {
      assert.throws(() => parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        originSessionId: 42,
      })), /invalid params/i);
    });

    test("task.dispatch accepts an optional noSandbox boolean", () => {
      const parsed = parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        noSandbox: true,
      }));
      assert.equal(parsed.params.noSandbox, true);
    });

    test("task.dispatch rejects a non-boolean noSandbox", () => {
      assert.throws(() => parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        noSandbox: "true",
      })), /invalid params/i);
    });

    test("task.dispatch accepts an optional noOverlay boolean", () => {
      const parsed = parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        noOverlay: true,
      }));
      assert.equal(parsed.params.noOverlay, true);
    });

    test("task.dispatch rejects a non-boolean noOverlay", () => {
      assert.throws(() => parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        noOverlay: "true",
      })), /invalid params/i);
    });

    test("task.advisor rejects noOverlay as an INVALID_PARAMS validation error (overlay is mandatory for the advisor role; review finding #5)", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.advisor, {
          prompt: "hi",
          directory: TEST_DIR,
          model: "m",
          noOverlay: true,
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("task.dispatch accepts an optional executor param", () => {
      const parsed = parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        executor: "pi",
      }));
      assert.equal(parsed.params.executor, "pi");
    });

    test("task.dispatch rejects an invalid executor param", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.dispatch, {
          prompt: "hi",
          directory: TEST_DIR,
          executor: "bogus",
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("task.advisor accepts an optional executor param", () => {
      const parsed = parseRequestLine(request(METHOD.advisor, {
        prompt: "hi",
        directory: TEST_DIR,
        model: "m",
        executor: "opencode",
      }));
      assert.equal(parsed.params.executor, "opencode");
    });

    test("task.advisor rejects an invalid executor param", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.advisor, {
          prompt: "hi",
          directory: TEST_DIR,
          model: "m",
          executor: "bogus",
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("task.dispatch accepts an arbitrary class value", () => {
      const parsed = parseRequestLine(request(METHOD.dispatch, {
        prompt: "p",
        directory: TEST_DIR,
        class: "implementer",
      }));
      assert.equal(parsed.params.class, "implementer");
    });

    test("task.dispatch rejects an empty class value", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.dispatch, {
          prompt: "p",
          directory: TEST_DIR,
          class: "",
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("task.advisor accepts an arbitrary class value", () => {
      const parsed = parseRequestLine(request(METHOD.advisor, {
        prompt: "p",
        directory: TEST_DIR,
        model: "m",
        class: "advisor-design",
      }));
      assert.equal(parsed.params.class, "advisor-design");
    });

    test("task.dispatch accepts an optional env object of string values", () => {
      const parsed = parseRequestLine(request(METHOD.dispatch, {
        prompt: "hi",
        directory: TEST_DIR,
        env: { FOO: "bar", EMPTY: "" },
      }));
      assert.deepEqual(parsed.params.env, { FOO: "bar", EMPTY: "" });
    });

    test("task.dispatch rejects an env value with a non-string entry", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.dispatch, {
          prompt: "hi",
          directory: TEST_DIR,
          env: { FOO: 42 },
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("task.dispatch rejects env: null, env: [], env: 42, and env: 'string'", () => {
      for (const bad of [null, [], 42, "string"]) {
        assert.throws(
          () => parseRequestLine(request(METHOD.dispatch, {
            prompt: "hi",
            directory: TEST_DIR,
            env: bad,
          })),
          (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS",
          `expected INVALID_PARAMS for env=${JSON.stringify(bad)}`
        );
      }
    });

    test("task.dispatch no longer accepts keySlot", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.dispatch, {
          prompt: "hi",
          directory: TEST_DIR,
          keySlot: "primary",
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("task.advisor accepts an optional env object", () => {
      const parsed = parseRequestLine(request(METHOD.advisor, {
        prompt: "hi",
        directory: TEST_DIR,
        model: "m",
        env: { FOO: "bar" },
      }));
      assert.deepEqual(parsed.params.env, { FOO: "bar" });
    });

    test("task.advisor rejects an env value with a non-string entry", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.advisor, {
          prompt: "hi",
          directory: TEST_DIR,
          model: "m",
          env: { FOO: 42 },
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });
  });

  describe("task.summary params", () => {
    test("task.summary accepts an optional env object", () => {
      const parsed = parseRequestLine(request(METHOD.summary, {
        taskId: "oc_123",
        env: { FOO: "bar" },
      }));
      assert.deepEqual(parsed.params.env, { FOO: "bar" });
    });

    test("task.summary accepts env alongside mode \"report\"", () => {
      const parsed = parseRequestLine(request(METHOD.summary, {
        taskId: "oc_123",
        mode: "report",
        env: { FOO: "bar" },
      }));
      assert.deepEqual(parsed.params.env, { FOO: "bar" });
      assert.equal(parsed.params.mode, "report");
    });

    test("task.summary rejects env with mode \"activity\" as an INVALID_PARAMS validation error (not a silent drop)", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.summary, {
          taskId: "oc_123",
          mode: "activity",
          env: { FOO: "bar" },
        })),
        (error) => isSummaryEnvActivityError(error)
      );
    });

    test("task.summary rejects an env value with a non-string entry", () => {
      assert.throws(
        () => parseRequestLine(request(METHOD.summary, {
          taskId: "oc_123",
          env: { FOO: 42 },
        })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });
  });

  describe("event.subscribe params", () => {
    test("event.subscribe accepts an optional originSessionId string", () => {
      const parsed = parseRequestLine(request(METHOD.subscribe, {
        directory: TEST_DIR,
        originSessionId: "sess-abc",
      }));
      assert.equal(parsed.params.originSessionId, "sess-abc");
    });

    test("event.subscribe rejects a non-string originSessionId", () => {
      assert.throws(() => parseRequestLine(request(METHOD.subscribe, {
        directory: TEST_DIR,
        originSessionId: 42,
      })), /invalid params/i);
    });

    test("event.subscribe accepts taskId in place of directory (issue #59)", () => {
      const parsed = parseRequestLine(request(METHOD.subscribe, { taskId: "oc_1" }));
      assert.equal(parsed.method, METHOD.subscribe);
    });

    test("event.subscribe rejects an empty params object (neither directory nor taskId)", () => {
      assert.throws(() => parseRequestLine(request(METHOD.subscribe, {})), /invalid params/i);
    });
  });

  describe("request and result validation", () => {
    test("rejects invalid request envelopes and params", () => {
      assert.throws(
        () => parseRequestLine(JSON.stringify({ version: 1, id: "req-1", method: METHOD.health })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST"
      );
      assert.throws(
        () => parseRequestLine(request(METHOD.status, {})),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
      assert.throws(
        () => parseRequestLine(request(METHOD.list, { directory: "relative" })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
      assert.throws(
        () => parseRequestLine(request(METHOD.health, { extra: true })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
      assert.throws(
        () => parseRequestLine(JSON.stringify({ id: "req-1", method: METHOD.health, params: {} })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST"
      );
      assert.throws(
        () => parseRequestLine(request(METHOD.health, {}, { extra: true })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST"
      );
      assert.throws(
        () => parseRequestLine(request(METHOD.result, { taskId: "oc_123", fields: ["notAResultField"] })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    test("accepts task.result with failureDetail in params.fields", () => {
      const parsed = parseRequestLine(request(METHOD.result, { taskId: "oc_123", fields: ["failureDetail"] }));
      assert.deepEqual(parsed.params.fields, ["failureDetail"]);
      assert.throws(
        () => parseRequestLine(request(METHOD.result, { taskId: "oc_123", fields: ["failureDetail", "notAResultField"] })),
        (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
      );
    });

    describe("task.accept / task.reject", () => {
      test("accepts a valid taskId-only request", () => {
        const parsed = parseRequestLine(request(METHOD.accept, { taskId: "oc_1" }));
        assert.equal(parsed.method, METHOD.accept);
        assert.deepEqual(parsed.params, { taskId: "oc_1" });
      });

      test("accepts a valid task.reject taskId-only request", () => {
        const parsed = parseRequestLine(request(METHOD.reject, { taskId: "oc_1" }));
        assert.equal(parsed.method, METHOD.reject);
        assert.deepEqual(parsed.params, { taskId: "oc_1" });
      });

      test("rejects task.accept with extra params", () => {
        assert.throws(
          () => parseRequestLine(request(METHOD.accept, { taskId: "oc_1", extra: true })),
          (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
        );
      });

      test("accepts task.accept with force: true", () => {
        const parsed = parseRequestLine(request(METHOD.accept, { taskId: "oc_1", force: true }));
        assert.equal(parsed.params.force, true);
      });

      test("rejects task.accept with non-boolean force", () => {
        assert.throws(
          () => parseRequestLine(request(METHOD.accept, { taskId: "oc_1", force: "yes" })),
          (error) => error instanceof ProtocolError && error.code === "INVALID_PARAMS"
        );
      });

      test("rejects task.reject with a missing taskId", () => {
        assert.throws(
          () => parseRequestLine(request(METHOD.reject, {})),
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
      assert.deepEqual(errorResponse("req-1", "UNKNOWN_TASK", ERROR_MESSAGE_UNKNOWN_TASK, "Run `taskferry list` to see valid task ids"), {
        version: 1,
        id: "req-1",
        ok: false,
        error: {
          code: "UNKNOWN_TASK",
          message: ERROR_MESSAGE_UNKNOWN_TASK,
          help: "Run `taskferry list` to see valid task ids",
          detail: ERROR_MESSAGE_UNKNOWN_TASK,
        },
      });
      assert.equal(
        errorResponse("req-2", "REQUEST_FAILED", "check gate failed", "retry", "error: check gate failed\n  output tail:\n    2 tests failed").error.detail,
        "error: check gate failed\n  output tail:\n    2 tests failed"
      );
      assert.deepEqual(eventMessage("sub-1", { type: "task.state", taskId: "oc_123" }), {
        version: 1,
        type: "event",
        subscriptionId: "sub-1",
        event: { type: "task.state", taskId: "oc_123" },
      });
    });
  });
