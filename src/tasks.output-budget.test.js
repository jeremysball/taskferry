import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeManager, fakeChild, AXI_TASKS_TEST_DIR, mkdtempTracked } from "./tasks.test-helpers.js";
import { MAX_SAFE_OUTPUT_FILE_BYTES } from "./output-dir.js";
import { createTaskManager, MAX_SAFE_OUTPUT_FILE_BYTES as TASK_SAFE, assertListingResponseFits, assertOutputResponseFits, BUDGET_CHECK_ID } from "./tasks.js";
import { MAX_BUFFER_BYTES } from "./daemon-server.js";
import { encodeMessage, successResponse } from "./protocol.js";

const TEST_PROMPT = "hi";
const TEST_DIRECTORY = "/tmp";

describe("response-budget guard (taskferry#508 review)", () => {
  test("control-character-heavy file that fits raw cap but exceeds wire budget surfaces clear knob-specific error, not generic RESPONSE_TOO_LARGE", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    // 300 KiB of \x01: raw 307200, JSON-escaped ≈ 6× = 1.8 MiB > 1 MiB ceiling
    const heavy = String.fromCharCode(1).repeat(300 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "heavy.bin"), heavy);
    assert.throws(
      () => mgr.output(dispatched.id, { path: "heavy.bin", maxOutputFileBytes: 512 * 1024 }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Must mention the knob and safe ceiling, not the generic fallback
        assert.match(msg, /would exceed daemon response limit/);
        assert.match(msg, /--max-output-file-bytes/);
        assert.match(msg, new RegExp(String(MAX_SAFE_OUTPUT_FILE_BYTES)));
        assert.match(msg, /help:/);
        // Generic fallback must NOT appear
        assert.doesNotMatch(msg, /daemon response for this request exceeds/);
        return true;
      },
    );
  });

  test("ASCII file of same raw size succeeds under same cap (no false positive)", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    const ascii = "a".repeat(300 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "ascii.txt"), ascii);
    const result = mgr.output(dispatched.id, { path: "ascii.txt", maxOutputFileBytes: 512 * 1024 });
    assert.equal(result.file.content, ascii);
    assert.equal(result.file.truncated, false);
  });

  test("small control file within safe ceiling succeeds", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    const smallHeavy = String.fromCharCode(1).repeat(50 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "small.bin"), smallHeavy);
    const result = mgr.output(dispatched.id, { path: "small.bin", maxOutputFileBytes: 512 * 1024 });
    assert.equal(result.file.content, smallHeavy);
    assert.equal(result.file.truncated, false);
    // Also assert computed safe is indeed ≈ (1MiB-4096)/6 and matches both exports
    assert.equal(MAX_SAFE_OUTPUT_FILE_BYTES, TASK_SAFE);
    assert.equal(MAX_SAFE_OUTPUT_FILE_BYTES, Math.floor((MAX_BUFFER_BYTES - 4096) / 6));
  });

  test("--max-output-file-bytes exceeding raw daemon ceiling throws clear error", () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    fs.writeFileSync(path.join(dispatched.outputDir, "tiny.txt"), "x");
    assert.throws(
      () => mgr.output(dispatched.id, { path: "tiny.txt", maxOutputFileBytes: MAX_BUFFER_BYTES + 1 }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /exceeds daemon response limit/);
        assert.match(msg, /--max-output-file-bytes/);
        return true;
      },
    );
  });

  test("creates manager with TASKFERRY_MAX_OUTPUT_FILE_BYTES exceeding raw ceiling throws at construction", () => {
    const prev = process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES;
    process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES = String(MAX_BUFFER_BYTES + 1000);
    try {
      assert.throws(
        () => createTaskManager({ stateDir: mkdtempTracked(AXI_TASKS_TEST_DIR + "-guard-env-"), config: {} }),
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /exceeds daemon response limit/);
          assert.match(msg, /TASKFERRY_MAX_OUTPUT_FILE_BYTES/);
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES;
      else process.env.TASKFERRY_MAX_OUTPUT_FILE_BYTES = prev;
    }
  });
});

describe("listing response-budget guard (taskferry#508 follow-up)", () => {
  test("synthetic listing with control-character-heavy filenames that would exceed wire budget is truncated to fit, not generic RESPONSE_TOO_LARGE", () => {
    const taskId = "oc_listing_guard_synthetic";
    const outputDir = "/tmp/state/outputs/oc_listing_guard_synthetic";
    const files = [];
    for (let i = 0; i < 256; i++) {
      files.push({ path: String.fromCharCode(1).repeat(800) + `_${i}.txt`, size: 10 });
    }
    const listing = { files, bytes: files.reduce((s, f) => s + f.size, 0), total: files.length, truncated: false };
    const fullPayload = { taskId, outputDir, files: listing.files, bytes: listing.bytes, total: listing.total, truncated: listing.truncated };
    const fullSize = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, fullPayload)));
    assert.ok(fullSize > MAX_BUFFER_BYTES, `synthetic full listing must exceed budget to test guard (got ${fullSize} <= ${MAX_BUFFER_BYTES})`);
    const guarded = assertListingResponseFits(taskId, outputDir, listing);
    assert.ok(guarded.truncated, "guarded listing must be marked truncated");
    assert.ok(guarded.files.length < listing.files.length, "guarded listing must have fewer files than the original");
    const guardedPayload = { taskId, outputDir, files: guarded.files, bytes: guarded.bytes, total: guarded.total, truncated: guarded.truncated };
    const guardedSize = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, guardedPayload)));
    assert.ok(guardedSize <= MAX_BUFFER_BYTES, `guarded listing must fit budget (got ${guardedSize} > ${MAX_BUFFER_BYTES})`);
  });

  test("plain taskferry output listing with control-character-heavy filenames is bounded to the response budget (integration)", async () => {
    const mgr = makeManager({ spawnFn: () => fakeChild() });
    const dispatched = mgr.dispatch({ prompt: TEST_PROMPT, directory: TEST_DIRECTORY });
    const deepPrefix = Array.from({ length: 8 }, () => String.fromCharCode(1).repeat(100)).join("/");
    const deepDir = path.join(dispatched.outputDir, deepPrefix);
    fs.mkdirSync(deepDir, { recursive: true });
    for (let i = 0; i < 256; i++) {
      const name = String.fromCharCode(1).repeat(50) + `_${i}.txt`;
      fs.writeFileSync(path.join(deepDir, name), "x");
    }
    const fullListing = mgr.output(dispatched.id);
    // Must not throw generic fallback and must be bounded
    assert.ok(fullListing.truncated, "oversized listing must be truncated to the response budget");
    assert.ok(fullListing.files.length < 256, `expected fewer than 256 files after budget truncation, got ${fullListing.files.length}`);
    const payload = { taskId: dispatched.id, outputDir: dispatched.outputDir, files: fullListing.files, bytes: fullListing.bytes, total: fullListing.total, truncated: fullListing.truncated };
    const size = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, payload)));
    assert.ok(size <= MAX_BUFFER_BYTES, `guarded listing response must fit budget (got ${size} > ${MAX_BUFFER_BYTES})`);
    // Ensure file-read guard preserved: a heavy file still surfaces knob-specific error
    const heavy = String.fromCharCode(1).repeat(300 * 1024);
    fs.writeFileSync(path.join(dispatched.outputDir, "heavy2.bin"), heavy);
    assert.throws(
      () => mgr.output(dispatched.id, { path: "heavy2.bin", maxOutputFileBytes: 512 * 1024 }),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /would exceed daemon response limit/);
        return true;
      },
    );
  });
});

describe("request-id overhead guard (taskferry#508 Luna re-review)", () => {
  test("BUDGET_CHECK_ID is 36 chars to match real UUID request ids", () => {
    assert.equal(BUDGET_CHECK_ID.length, 36, "guard must use 36-char placeholder, not 12-char budget-check");
    assert.match(BUDGET_CHECK_ID, /^[0-9a-f-]{36}$/i);
  });

  // eslint-disable-next-line sonarjs/cognitive-complexity, sonarjs/cyclomatic-complexity -- boundary probe needs loops to find 24-byte window where 12-char fits but 36-char overflows
  test("listing guard uses 36-char placeholder: near-boundary listing that fits with 12-char would overflow with real UUID and is truncated", () => {
    const OLD_ID = "budget-check";
    assert.equal(OLD_ID.length, 12);
    assert.equal(BUDGET_CHECK_ID.length, 36);
    const taskId = "oc_boundary_list";
    const outputDir = "/tmp/state/outputs/oc_boundary_list";
    let found = null;
    let baseCount = null;
    for (let n = 200; n <= 220; n++) {
      const files = [];
      for (let i = 0; i < n; i++) files.push({ path: String.fromCharCode(1).repeat(800) + `_${i}`, size: 10 });
      const listing = { files, bytes: files.reduce((s, f) => s + f.size, 0), total: files.length, truncated: false };
      const payload = { taskId, outputDir, files: listing.files, bytes: listing.bytes, total: listing.total, truncated: listing.truncated };
      const sizeOld = Buffer.byteLength(encodeMessage(successResponse(OLD_ID, payload)));
      if (sizeOld > MAX_BUFFER_BYTES) {
        baseCount = n - 1;
        break;
      }
    }
    if (baseCount === null) baseCount = 214;
    const baseFiles = [];
    for (let i = 0; i < baseCount; i++) baseFiles.push({ path: String.fromCharCode(1).repeat(800) + `_${i}`, size: 10 });
    // eslint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- need break on boundary and on overflow
    for (let extraLen = 0; extraLen <= 5000; extraLen++) {
      const files = extraLen === 0 ? baseFiles : [...baseFiles, { path: String.fromCharCode(1).repeat(extraLen), size: 10 }];
      if (files.length > 256) break;
      const listing = { files, bytes: files.reduce((s, f) => s + f.size, 0), total: files.length, truncated: false };
      const payload = { taskId, outputDir, files: listing.files, bytes: listing.bytes, total: listing.total, truncated: listing.truncated };
      const sizeOld = Buffer.byteLength(encodeMessage(successResponse(OLD_ID, payload)));
      const sizeReal = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, payload)));
      assert.equal(sizeReal - sizeOld, BUDGET_CHECK_ID.length - OLD_ID.length, "envelope overhead must be exactly id length difference");
      if (sizeOld <= MAX_BUFFER_BYTES && sizeReal > MAX_BUFFER_BYTES) {
        found = { listing, sizeOld, sizeReal, baseCount, extraLen };
        break;
      }
      if (sizeOld > MAX_BUFFER_BYTES && sizeReal > MAX_BUFFER_BYTES) break;
    }
    assert.ok(found, "must find near-boundary listing where 12-char fits but 36-char overflows");
    const guarded = assertListingResponseFits(taskId, outputDir, found.listing);
    assert.ok(guarded.truncated, "guarded listing must be truncated");
    assert.ok(guarded.files.length < found.listing.files.length, "guarded listing must have fewer files");
    const guardedPayload = { taskId, outputDir, files: guarded.files, bytes: guarded.bytes, total: guarded.total, truncated: guarded.truncated };
    const guardedRealSize = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, guardedPayload)));
    assert.ok(guardedRealSize <= MAX_BUFFER_BYTES, `guarded listing with real id must fit budget (got ${guardedRealSize} > ${MAX_BUFFER_BYTES})`);
    const realUuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(realUuid.length, 36);
    const guardedRealUuidSize = Buffer.byteLength(encodeMessage(successResponse(realUuid, guardedPayload)));
    assert.equal(guardedRealUuidSize, guardedRealSize, "BUDGET_CHECK_ID must be same length as real UUID");
    // Verify actual daemon would not fall through to generic RESPONSE_TOO_LARGE
    assert.ok(guardedRealUuidSize <= MAX_BUFFER_BYTES, "real daemon response must not exceed MAX_BUFFER after guard");
  });

  test("file guard uses 36-char placeholder: near-boundary file that fits with 12-char would overflow with real UUID and is rejected", () => {
    const OLD_ID = "budget-check";
    const taskId = "oc_boundary_file";
    const outputDir = "/tmp/state/outputs/oc_boundary_file";
    let found = null;
    for (let len = 172000; len < 176000; len += 10) {
      const content = String.fromCharCode(1).repeat(len);
      const file = { content, size: len, truncated: false };
      const payloadOld = { taskId, outputDir, file, files: [], bytes: 0, total: 0, truncated: false };
      const payloadReal = { taskId, outputDir, file, files: [], bytes: 0, total: 0, truncated: false };
      const sizeOld = Buffer.byteLength(encodeMessage(successResponse(OLD_ID, payloadOld)));
      const sizeReal = Buffer.byteLength(encodeMessage(successResponse(BUDGET_CHECK_ID, payloadReal)));
      if (sizeOld <= MAX_BUFFER_BYTES && sizeReal > MAX_BUFFER_BYTES) {
        found = { file, len, sizeOld, sizeReal };
        break;
      }
    }
    assert.ok(found, "must find near-boundary file where 12-char fits but 36-char overflows");
    assert.throws(
      () => assertOutputResponseFits(taskId, outputDir, found.file, "near-boundary.bin", 512 * 1024),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /would exceed daemon response limit/);
        assert.doesNotMatch(msg, /daemon response for this request exceeds/);
        return true;
      },
    );
    const smallFile = { content: "a".repeat(1000), size: 1000, truncated: false };
    assert.doesNotThrow(() => assertOutputResponseFits(taskId, outputDir, smallFile, "small.txt", 512 * 1024));
  });
});
