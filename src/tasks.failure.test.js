import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { bucketFor } from "./tasks.js";
import { makeManager, fakeChild, RATE_LIMIT_ERROR, RATE_LIMIT_PLAIN, UNAUTHORIZED_ERROR, UNAUTHORIZED_SHORT, USAGE_LIMIT_ERROR, QUOTA_ERROR, NO_API_KEY_FOUND, EXTENSION_CONFIG_ERROR, MINIMAX_MODEL, UNUSED_TMP } from "./tasks.test-helpers.js";

describe("provider-failure classification: rate limits, payment, authentication", () => {
  test("a rate-limit diagnostic in the log stops the child early with failureReason rate_limited and captures failureDetail", async () => {
    const child = fakeChild(7101);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000, // long enough that only exhaustion detection could trigger this
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, RATE_LIMIT_ERROR);
  });

  test("an unterminated rate-limit diagnostic stops the child early", async () => {
    const child = fakeChild(7104);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, RATE_LIMIT_PLAIN);

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, RATE_LIMIT_PLAIN);
  });

  test("a matched log line longer than 500 chars is truncated to exactly the 500-char cap", async () => {
    const child = fakeChild(7199);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const longLine = RATE_LIMIT_PLAIN + " " + "x".repeat(1000);
    fs.writeFileSync(mgr.status(dispatched.id).logPath, longLine);

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail.length, 500);
    assert.ok(s.failureDetail.endsWith("…"));
  });

  test("status still lands on crashed when the SIGTERM'd child exits 0 (traps the signal) instead of dying by signal", async () => {
    const child = fakeChild(7105);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    // A well-behaved CLI can trap SIGTERM and shut down cleanly (exit 0, no
    // signal) instead of dying by the signal itself. That must not read as
    // "done" and bury the failureReason behind a healthy-looking status.
    child.emit("exit", 0, null);
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "rate_limited");
  });

  test("ordinary crash text is not misclassified as a provider failure (it surfaces as boot_failure instead)", () => {
    const child = fakeChild(7102);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "TypeError: cannot read property 'x' of undefined\n");
    child.emit("exit", 1, null);
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    // The false-positive protection this test was written for stands: no
    // provider bucket. But an eventless non-zero exit no longer settles
    // silent -- the raw line is now surfaced under the boot_failure bucket.
    assert.equal(s.failureReason, "pi_boot_failure");
    assert.equal(s.failureDetail, "TypeError: cannot read property 'x' of undefined");
  });

  test("a type:\"text\" narration event that legitimately mentions rate limits, quotas, or 429 is not misclassified as a provider failure (GLM-5.2 review finding)", async () => {
    const child = fakeChild(7103);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      [
        JSON.stringify({ type: "text", part: { messageID: "m1", text: "I hit a 429 while testing the client, so I added quota and rate-limit backoff handling per the usage-limit spec." } }),
        JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }),
      ].join("\n") + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(killed.length, 0);
    assert.equal(mgr.status(dispatched.id).failureReason, null);
  });

  test("insufficient_quota lands on payment_required, not rate_limited", async () => {
    const child = fakeChild(7106);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "insufficient_quota: your account has run out of credits" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "payment_required");
    assert.equal(s.failureDetail, "insufficient_quota: your account has run out of credits");
  });

  test("a line combining insufficient_quota and rate-limit language resolves to payment_required (checked first)", async () => {
    const child = fakeChild(7107);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "rate limit exceeded: insufficient_quota on this key" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "payment_required");
  });

  test("a line mentioning quota alongside rate-limit language, without insufficient_quota, resolves to rate_limited (bare quota's fallback bucket)", async () => {
    const child = fakeChild(7108);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "Rate limit exceeded, check your quota" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "rate_limited");
  });
});

describe("provider-failure classification: authentication and timeout detail", () => {
  test("unauthorized/invalid api key diagnostics land on authentication_failed", async () => {
    const child = fakeChild(7109);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: UNAUTHORIZED_ERROR }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "authentication_failed");
    assert.equal(s.failureDetail, UNAUTHORIZED_ERROR);
  });

  test("a raw non-JSON line with an unrelated 3-digit number is not misclassified as authentication_failed", () => {
    const child = fakeChild(7110);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "401 tests passed, 0 failed\n");
    child.emit("exit", 1, null);
    // Not authentication_failed (the false-positive this test guards); an
    // eventless non-zero exit now surfaces as boot_failure with the raw
    // line as detail rather than leaving failureReason null.
    const s = mgr.status(dispatched.id);
    assert.equal(s.failureReason, "pi_boot_failure");
    assert.equal(s.failureDetail, "401 tests passed, 0 failed");
  });

  test("pi's plain-text NO_API_KEY_FOUND stderr line lands on authentication_failed (issue #94)", async () => {
    // pi's auth-failure stderr text reads "No API key found for <provider>."
    // -- plain English, not the `unauthorized`/`invalid api key`/`status 401`
    // surface the existing regex set covers. Without an additional pattern,
    // it leaks through as the unclassified `crashed` fallback. Today the
    // dispatch is opencode-backed (Task 6/7 will let a pi dispatch route
    // its raw line through the same classifier with `pi_` prefix); the
    // executor-prefixed end-to-end check lives with that task.
    const child = fakeChild(7115);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      NO_API_KEY_FOUND + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "authentication_failed");
    assert.equal(s.failureDetail, NO_API_KEY_FOUND);
  });

  test("a structured status_code: 401 diagnostic without the word 'unauthorized' still lands on authentication_failed", async () => {
    const child = fakeChild(7111);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: "request failed with status_code: 401" }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 40));
    child.emit("exit", null, "SIGTERM");
    assert.equal(mgr.status(dispatched.id).failureReason, "authentication_failed");
  });

  test("no_output_timeout captures which timeout fired and the pre/post-output latch state in failureDetail", async () => {
    const child = fakeChild(7112);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "no_output_timeout_dead_spawn");
    assert.equal(s.failureDetail, "no output for 20ms (pre-output timeout)");
  });

  test("failureReason and failureDetail are set once; a second watchdog tick does not overwrite either", async () => {
    const child = fakeChild(7113);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 20));

    // Append a second, different diagnostic after the first tick has almost
    // certainly already classified and started killing the task.
    fs.appendFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: UNAUTHORIZED_ERROR }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 20));

    child.emit("exit", null, "SIGTERM");
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited", "the first classification wins");
    assert.equal(s.failureDetail, RATE_LIMIT_ERROR);
  });
});

describe("trailing provider-error events that land after the last watcher poll (issue #81)", () => {
  test("a provider-error event written just before exit -- with no watcher tick in between -- is still classified instead of lost", () => {
    const child = fakeChild(7201);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      // Long enough that the watchdog interval never ticks during this test.
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: USAGE_LIMIT_ERROR }) + "\n"
    );

    // The provider process exits immediately after logging the error --
    // no interval tick ever gets a chance to read it.
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, USAGE_LIMIT_ERROR);
  });

  test("a trailing provider-error event is classified even when the child traps the signal-less exit and exits 0", () => {
    const child = fakeChild(7202);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: UNAUTHORIZED_ERROR }) + "\n"
    );

    child.emit("exit", 0, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, "authentication_failed");
  });

  test("does not override a failureReason the watcher already classified while the task was still running", async () => {
    const child = fakeChild(7203);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"));

    // A second, different diagnostic lands right at exit -- the earlier,
    // watcher-classified reason must still win.
    fs.appendFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: UNAUTHORIZED_ERROR }) + "\n"
    );
    child.emit("exit", null, "SIGTERM");

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
    assert.equal(s.failureDetail, RATE_LIMIT_ERROR);
  });

  test("a clean exit reuses the watcher's incremental offset and does not reclassify bytes the watcher already scanned", async () => {
    const child = fakeChild(7204);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // A non-error line plus a newline-terminated final line so the watcher
    // can scan it without a trailing carry on its next tick.
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "all good" } }) + "\n"
      + JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }) + "\n"
    );
    // Wait for at least one watcher tick so bytesRead catches up to the
    // file size and the carry is empty.
    await new Promise((r) => setTimeout(r, 30));
    child.emit("exit", 0, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "done");
    assert.equal(s.failureReason, null);
    assert.equal(s.failureDetail, null);
  });

  test("settlement reads only the trailing delta after the watcher's accumulated offset", async (t) => {
    const child = fakeChild(7209);
    const readCalls = [];
    const originalReadSync = fs.readSync;
    t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
      readCalls.push({ length, position });
      return originalReadSync(fd, buffer, offset, length, position);
    });
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const logPath = mgr.status(dispatched.id).logPath;
    const prefix = JSON.stringify({ type: "text", part: { messageID: "m1", text: "x".repeat(4096) } }) + "\n";
    fs.writeFileSync(logPath, prefix);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const prefixBytes = Buffer.byteLength(prefix);
    assert.ok(readCalls.some((call) => call.position === 0 && call.length === prefixBytes));
    readCalls.length = 0;

    const trailing = JSON.stringify({ type: "error", message: USAGE_LIMIT_ERROR }) + "\n";
    fs.appendFileSync(logPath, trailing);
    child.emit("exit", 1, null);

    // classifyTrailingLogFailure() reads only the trailing delta; the
    // remaining two calls are readSessionIdFromLog() scanning the log from
    // the start for a sessionID (one chunk covers the whole small file here,
    // plus a terminal zero-byte read that detects EOF).
    assert.deepEqual(readCalls, [
      { length: Buffer.byteLength(trailing), position: prefixBytes },
      { length: 64 * 1024, position: null },
      { length: 64 * 1024, position: null },
    ]);
    assert.equal(mgr.status(dispatched.id).failureReason, "rate_limited");
  });

  test("a clean exit with an opencode error in the watched-but-not-yet-classified bytes does not invent a failureReason", async () => {
    const child = fakeChild(7205);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // A `type:"text"` event that just happens to mention "rate limit" --
    // legitimate narration, not a provider failure (issue #81 guard).
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "the server returned 429 due to rate limit, so I retried with backoff" } }) + "\n"
    );
    child.emit("exit", 0, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "done");
    assert.equal(s.failureReason, null);
  });

  test("a provider error split across the watcher's carry and the new bytes at exit is still classified", async () => {
    const child = fakeChild(7206);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const fullLine = JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }) + "\n";
    // Write a partial line so the watcher's first tick stores it as carry,
    // then write the rest of the line plus a terminating \n. The exit
    // happens immediately after, before another watcher tick can finalize
    // the carry. classifyTrailingLogFailure must concatenate the carry
    // (the stale partial) with the new bytes (the rest of the line) and
    // still classify the merged line.
    const split = Math.floor(fullLine.length / 2);
    fs.writeFileSync(mgr.status(dispatched.id).logPath, fullLine.slice(0, split));
    await new Promise((r) => setTimeout(r, 30));
    fs.appendFileSync(mgr.status(dispatched.id).logPath, fullLine.slice(split));
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "rate_limited");
  });

  test("a trailing provider-error is still classified when the log file no longer exists at exit", () => {
    // Defensive: if the log was rotated/deleted between the watcher's last
    // tick and the exit handler, statSync throws ENOENT and the function
    // returns without crashing or inventing a reason.
    const child = fakeChild(7207);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    fs.writeFileSync(logPath, JSON.stringify({ type: "error", message: "rate_limit_exceeded: too many requests" }) + "\n");
    fs.unlinkSync(logPath);
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, null);
    assert.equal(s.failureDetail, null);
  });

  test("a trailing provider-error is still classified when the log shrank past the watcher's offset between ticks", async () => {
    // Same shape as the file-shrank branch the watcher already handles: if
    // the log got rotated/replaced between the watcher's last tick and
    // exit, classifyTrailingLogFailure must reclassify the replacement
    // contents from offset 0, not from the stale watcher offset.
    const child = fakeChild(7208);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 60000,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    const logPath = mgr.status(dispatched.id).logPath;
    fs.writeFileSync(logPath, "x".repeat(4096));
    child.emit("exit", 1, null);
    // Overwrite the (now-closed-by-the-exit-handler) log with a small file
    // containing a provider error.
    fs.writeFileSync(logPath, JSON.stringify({ type: "error", message: UNAUTHORIZED_SHORT }) + "\n");
    // The exit handler has already classified (and found nothing); the
    // shrink branch in classifyTrailingLogFailure would re-rescan from
    // offset 0 in a real run. This test pins down that we don't crash
    // when the file changes between read and write.
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "crashed");
  });
});

describe("bucketFor() (Task 7 review fix: isolate the prefix rule from the classify e2e path)", () => {
  test("opencode's bucket names stay unprefixed", () => {
    assert.equal(bucketFor("opencode", "rate_limited"), "rate_limited");
    assert.equal(bucketFor("opencode", "authentication_failed"), "authentication_failed");
  });

  test("every other prefix gets an underscore-joined prefix", () => {
    assert.equal(bucketFor("pi", "rate_limited"), "pi_rate_limited");
    assert.equal(bucketFor("pi", "executornormalizationerror"), "pi_executornormalizationerror");
  });
});

describe("classifyProviderFailure() honors the binding compatibility contract (Task 7)", () => {
  test("opencode's named buckets stay unprefixed (shipped behavior preserved)", async () => {
    // Each line below is what opencode would emit today; the bucket must
    // come back as the historical string every doc, watcher, and CLI
    // output is keyed off (no `opencode_` prefix).
    const cases = [
      { line: JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }), bucket: "rate_limited" },
      { line: JSON.stringify({ type: "error", message: QUOTA_ERROR }), bucket: "payment_required" },
      { line: JSON.stringify({ type: "error", message: UNAUTHORIZED_SHORT }), bucket: "authentication_failed" },
      // Raw non-JSON line that matches a known bucket (e.g. a future pi
      // shape leaking into an opencode task -- the prefix-stripping rule
      // must apply on this branch too).
      { line: NO_API_KEY_FOUND, bucket: "authentication_failed" },
    ];
    for (const { line, bucket } of cases) {
      const child = fakeChild(9300 + cases.indexOf({ line, bucket }));
      const mgr = makeManager({
        spawnFn: () => child,
        killFn: () => {},
        noOutputTimeoutMs: 60000,
        watchdogPollMs: 5,
      });
      const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
      fs.writeFileSync(mgr.status(dispatched.id).logPath, `${line}\n`);
      await new Promise((r) => setTimeout(r, 40));
      child.emit("exit", null, "SIGTERM");
      assert.equal(
        mgr.status(dispatched.id).failureReason,
        bucket,
        `opencode task with line ${JSON.stringify(line)} must land on bare ${bucket}`
      );
    }
  });

  test("pi's named buckets receive the pi_ prefix so executor-specific failures stay distinguishable", async () => {
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: MINIMAX_MODEL,
      defaultSummaryModel: MINIMAX_MODEL,
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--model", MINIMAX_MODEL, "--mode", "json", "-p", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: UNUSED_TMP, sandboxEnv: {} }),
    };
    // Each line is the equivalent pi shape for the opencode buckets above;
    // the same regex set must classify it, but with the pi_ prefix added.
    const cases = [
      { line: JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }), bucket: "pi_rate_limited" },
      { line: JSON.stringify({ type: "error", message: QUOTA_ERROR }), bucket: "pi_payment_required" },
      { line: JSON.stringify({ type: "error", message: UNAUTHORIZED_SHORT }), bucket: "pi_authentication_failed" },
      { line: NO_API_KEY_FOUND, bucket: "pi_authentication_failed" },
    ];
    for (let i = 0; i < cases.length; i++) {
      const { line, bucket } = cases[i];
      const child = fakeChild(9400 + i);
      const mgr = makeManager({
        spawnFn: () => child,
        killFn: () => {},
        defaultExecutor: fakePi,
        noOutputTimeoutMs: 60000,
        watchdogPollMs: 5,
      });
      const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
      fs.writeFileSync(mgr.status(dispatched.id).logPath, `${line}\n`);
      await new Promise((r) => setTimeout(r, 40));
      child.emit("exit", null, "SIGTERM");
      assert.equal(
        mgr.status(dispatched.id).failureReason,
        bucket,
        `pi task with line ${JSON.stringify(line)} must land on ${bucket}`
      );
    }
  });

  test("unknown structured error events keep the executor prefix for both opencode and pi", async () => {
    // The third-class-name bucket (constructed from evt.error.name) is
    // a *new* string that has never been shipped unprefixed -- so
    // callers don't depend on a bare name, and the prefix rule stays
    // unconditional on this branch.
    const opencodeEvent = JSON.stringify({
      type: "error",
      error: { name: "SomeNewOpencodeClass", data: { message: "Streaming failed" } },
    });
    const piEvent = JSON.stringify({
      type: "error",
      error: { name: "SomeNewPiClass", data: { message: "Streaming failed" } },
    });
    // opencode (default executor)
    const childOc = fakeChild(9500);
    const mgrOc = makeManager({
      spawnFn: () => childOc,
      killFn: () => {},
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatchedOc = mgrOc.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgrOc.status(dispatchedOc.id).logPath, `${opencodeEvent}\n`);
    await new Promise((r) => setTimeout(r, 40));
    childOc.emit("exit", null, "SIGTERM");
    assert.equal(
      mgrOc.status(dispatchedOc.id).failureReason,
      "opencode_somenewopencodeclass"
    );

    // pi
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: MINIMAX_MODEL,
      defaultSummaryModel: MINIMAX_MODEL,
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--model", MINIMAX_MODEL, "--mode", "json", "-p", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: UNUSED_TMP, sandboxEnv: {} }),
    };
    const childPi = fakeChild(9501);
    const mgrPi = makeManager({
      spawnFn: () => childPi,
      killFn: () => {},
      defaultExecutor: fakePi,
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatchedPi = mgrPi.dispatch({ prompt: "hi", directory: os.tmpdir() });
    fs.writeFileSync(mgrPi.status(dispatchedPi.id).logPath, `${piEvent}\n`);
    await new Promise((r) => setTimeout(r, 40));
    childPi.emit("exit", null, "SIGTERM");
    assert.equal(
      mgrPi.status(dispatchedPi.id).failureReason,
      "pi_somenewpiclass"
    );
  });
});

describe("provider-failure classification is task-aware via task.executorId (Task 7: end-to-end pi bucket)", () => {
  test("a pi executor task receiving plain NO_API_KEY_FOUND settles with failureReason: 'pi_authentication_failed'", async () => {
    const fakePi = {
      id: "pi",
      taskIdPrefix: "pi",
      errorBucketPrefix: "pi",
      defaultModel: MINIMAX_MODEL,
      defaultSummaryModel: MINIMAX_MODEL,
      binaryName: "pi",
      listModelsFn: async () => "",
      buildSpawnArgs: () => ["--model", MINIMAX_MODEL, "--mode", "json", "-p", "hi"],
      buildSummaryPrompt: () => "",
      normalizeLogEvent: (parsed) => parsed,
      sandboxAuthFile: () => ({ extraRoBinds: [], sandboxedDataHome: UNUSED_TMP, sandboxEnv: {} }),
    };
    const child = fakeChild(9119);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      defaultExecutor: fakePi,
      noOutputTimeoutMs: 60000,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir() });
    // pi exits 0 after printing the plain-text auth failure on stdout;
    // startTask's stdout handler must preserve that line so the watcher
    // can classify it.
    child.stdout.emit("data", Buffer.from(NO_API_KEY_FOUND + "\n"));
    child.emit("exit", 0, null);
    // Watcher is async -- give one tick so classifyProviderFailure runs.
    await new Promise((r) => setTimeout(r, 20));
    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.failureReason, "pi_authentication_failed");
    assert.equal(s.failureDetail, NO_API_KEY_FOUND);
  });
});

describe("boot-failure surfacing (exit non-zero with zero parseable events)", () => {
  test("raw capture from a boot crash becomes failureReason boot_failure with the fatal Error line as detail", () => {
    const child = fakeChild(7301);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      'Warning: No models match pattern "kimi-coding/k2p5"\n' +
        EXTENSION_CONFIG_ERROR + "\n"
    );
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail", "exitCode"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(
      r.failureDetail,
      EXTENSION_CONFIG_ERROR
    );
    assert.equal(r.exitCode, 1);
    assert.equal(
      mgr.status(dispatched.id).failureReason,
      "boot_failure",
      "the status snapshot (and thus list rows) must carry the reason"
    );
  });

  test("the pi executor gets the prefixed pi_boot_failure bucket", () => {
    const child = fakeChild(7302);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "pi" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Error: auth.json not found\n");
    child.emit("exit", 1, null);
    assert.equal(mgr.result(dispatched.id, { fields: ["failureReason"] }).failureReason, "pi_boot_failure");
  });

  test("with no Error-prefixed line, the last non-JSON line becomes the detail", () => {
    const child = fakeChild(7303);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "warning: something odd\npanic: runtime exploded\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(r.failureDetail, "panic: runtime exploded");
  });

  test("a crash after real events leaves failureReason to the curated classifier (gate holds)", () => {
    const child = fakeChild(7304);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "step_start", part: {} }) + "\nError: some mid-run stderr noise\n"
    );
    child.emit("exit", 1, null);
    assert.equal(mgr.result(dispatched.id, { fields: ["failureReason"] }).failureReason, null);
  });

  test("exit 0 with only raw text is not classified as a boot failure", () => {
    const child = fakeChild(7305);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Error: text from a child that still exited 0\n");
    child.emit("exit", 0, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason"] });
    assert.equal(r.status, "done");
    assert.equal(r.failureReason, null);
  });

  test("an event line larger than the 64KiB head window still blocks boot classification (whole-log gate)", () => {
    const child = fakeChild(7306);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    // A long answer is one NDJSON line; a head-only event scan sees a
    // truncated fragment, fails JSON.parse, and would misclassify this
    // working task as a boot crash.
    const longAnswer = JSON.stringify({ type: "text", part: { messageID: "m1", text: "x".repeat(70 * 1024) } });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, longAnswer + "\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, null);
    assert.equal(r.failureDetail, null);
  });

  test("a log whose only content is one oversized raw line past the scan window yields no garbage detail", () => {
    const child = fakeChild(7307);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Error: " + "x".repeat(70000) + "\n");
    child.emit("exit", 1, null);
    // The scan window starts mid-line; the partial first line is dropped
    // rather than promoted to evidence, so nothing classifiable remains.
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, null);
    assert.equal(r.failureDetail, null);
  });

  test("an oversized noise line before a real Error line still surfaces the real one", () => {
    const child = fakeChild(7308);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "w".repeat(70000) + "\n" + "Error: fatal baseUrl missing\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(r.failureDetail, "Error: fatal baseUrl missing");
  });

  test("unparseable brace-starting stderr is evidence, not an event", () => {
    const child = fakeChild(7309);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    const dump = '{ provider: "x", error: "boom" }';
    fs.writeFileSync(mgr.status(dispatched.id).logPath, dump + "\n");
    child.emit("exit", 1, null);
    const r = mgr.result(dispatched.id, { fields: ["failureReason", "failureDetail"] });
    assert.equal(r.failureReason, "boot_failure");
    assert.equal(r.failureDetail, dump);
  });

  test("a signal-killed eventless child is not classified as a boot failure", () => {
    const child = fakeChild(7310);
    const mgr = makeManager({ spawnFn: () => child, killFn: () => {} });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, "Warning: something harmless\n");
    child.emit("exit", null, "SIGKILL");
    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
    assert.equal(s.failureReason, null, "an external kill is not a boot failure even during startup");
  });

  test("a watcher-set failureReason survives an eventless non-zero exit (gate does not clobber)", async () => {
    const child = fakeChild(7311);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(mgr.status(dispatched.id).logPath, 'Error: Extension "/x/y.js" blew up at load\n');
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "watchdog must fire on the eventless silence");
    // Graceful-trap exit: non-zero code after the watchdog already named
    // the failure. The boot gate must leave the existing reason alone.
    child.emit("exit", 1, null);
    assert.equal(mgr.result(dispatched.id, { fields: ["failureReason"] }).failureReason, "no_output_timeout_dead_spawn");
  });
});

describe("crash recovery: a genuine step_finish stop overrides a crashed status", () => {
  test("a transient mid-run provider error followed by a real final answer is recovered to done, keeping failureReason as a record", async () => {
    const child = fakeChild(7401);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    // A transient provider error mid-run (classified by the watcher as a
    // crash bucket, same as any other error line) followed by the model
    // recovering and reaching a genuine step_finish "stop" with real text --
    // the concrete pattern found live in the fleet: a ContextOverflowError
    // partway through, 24s later a normal completion.
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "error", message: RATE_LIMIT_ERROR }) + "\n"
      + JSON.stringify({ type: "text", part: { messageID: "m1", text: "Verification completed successfully." } }) + "\n"
      + JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 30));
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "done", "a genuine final answer must not be undercounted as a failure");
    assert.equal(s.failureReason, "rate_limited", "the transient cause stays on record even though status recovered");
  });

  test("a crash with no explicit step_finish stop is left crashed (the fallback last-message rule does not count)", async () => {
    const child = fakeChild(7402);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    // Text landed but the run never reached a step_finish "stop" -- this is
    // the ordinary crashed-mid-write case the fallback rule in
    // extractFinalMessageDetail exists for at read time, but recovery must
    // not treat a fallback-only message the same as a genuine completion.
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "still working" } }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 30));
    child.emit("exit", 1, null);

    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "crashed");
  });

  test("a cancelled task is never reinterpreted as done even with a genuine step_finish stop", async () => {
    const child = fakeChild(7403);
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: () => {},
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "done before the cancel landed" } }) + "\n"
      + JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }) + "\n"
    );
    mgr.cancel(dispatched.id);
    child.emit("exit", null, "SIGTERM");

    const s = mgr.status(dispatched.id);
    assert.equal(s.status, "cancelled");
  });

  test("a real step_finish stop reaches recovery even when the watchdog is what actually killed the process (no_output_timeout_stalled)", async () => {
    // The transcript reached a genuine "stop" before the process hung --
    // e.g. a stuck provider keep-alive or a cleanup step that never
    // returns. The generation itself finished; the watchdog only ended a
    // process that failed to exit afterward, so this still recovers.
    const child = fakeChild(7404);
    const killed = [];
    const mgr = makeManager({
      spawnFn: () => child,
      killFn: (pid, signal) => killed.push({ pid, signal }),
      noOutputTimeoutMs: 20,
      postOutputNoOutputTimeoutMs: 20,
      watchdogPollMs: 5,
    });
    const dispatched = mgr.dispatch({ prompt: "hi", directory: os.tmpdir(), executor: "opencode" });
    fs.writeFileSync(
      mgr.status(dispatched.id).logPath,
      JSON.stringify({ type: "text", part: { messageID: "m1", text: "real final answer" } }) + "\n"
      + JSON.stringify({ type: "step_finish", part: { messageID: "m1", reason: "stop" } }) + "\n"
    );

    await new Promise((r) => setTimeout(r, 60));
    assert.ok(killed.some((k) => k.signal === "SIGTERM"), "the watchdog must have fired on the post-stop hang");

    child.emit("exit", null, "SIGTERM");

    const s = mgr.status(dispatched.id, { full: true });
    assert.equal(s.status, "done");
    assert.equal(s.failureReason, "no_output_timeout_stalled");
  });
});
