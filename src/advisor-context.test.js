import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdvisorContextChars, claudeTranscriptPath, extractTranscriptText } from "./advisor-context.js";
import { UsageError } from "./args.js";

const TASKFERRY_ADVISOR_CONFIG_PREFIX = "taskferry-advisor-config-";
const TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX = "taskferry-extract-transcript-";
const TRANSCRIPT_JSONL_FILENAME = "transcript.jsonl";

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("advisor context helpers", () => {
  test("resolveAdvisorContextChars() defaults to 120000", () => {
    assert.equal(resolveAdvisorContextChars({}), 120000);
  });

  test("resolveAdvisorContextChars() honors TASKFERRY_ADVISOR_CONTEXT_CHARS", () => {
    assert.equal(resolveAdvisorContextChars({ TASKFERRY_ADVISOR_CONTEXT_CHARS: "50000" }), 50000);
  });

  test("resolveAdvisorContextChars() falls back to the config file when the env var is unset", () => {
    const dir = mkTmpDir(TASKFERRY_ADVISOR_CONFIG_PREFIX);
    const configDir = path.join(dir, "taskferry");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ advisorContextChars: 75000 }));
    assert.equal(resolveAdvisorContextChars({ XDG_CONFIG_HOME: dir }), 75000);
  });

  test("claudeTranscriptPath() slugifies cwd the same way the account's project dirs are named", () => {
    const result = claudeTranscriptPath("/home/user", "/workspace/taskferry", "sess-1");
    assert.equal(result, path.join("/home/user", ".claude", "projects", "-workspace-taskferry", "sess-1.jsonl"));
  });

  test("extractTranscriptText() keeps only user/assistant text turns, dropping thinking, tool_use, and tool_result noise", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    const lines = [
      { type: "user", message: { role: "user", content: "please fix the bug" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "let me think about this" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "huge file dump here" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "found it, fixing now" }] } },
      { type: "system", subtype: "hook", hookInfos: [] },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = extractTranscriptText(filePath, 10000);

    assert.match(result, /please fix the bug/);
    assert.match(result, /found it, fixing now/);
    assert.doesNotMatch(result, /let me think about this/);
    assert.doesNotMatch(result, /huge file dump here/);
    assert.doesNotMatch(result, /Read/);
  });

  test("extractTranscriptText() returns the last N characters of the extracted text when it exceeds the budget", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    const lines = [
      { type: "user", message: { role: "user", content: "first message" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "second message" }] } },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = extractTranscriptText(filePath, 10);

    // Pin both the code-point count (not String#length, which counts UTF-16
    // code units and would misreport a result containing a surrogate pair)
    // and the exact tail slice, so a regression that flips the slice
    // direction (head instead of tail) fails this test.
    assert.equal(Array.from(result).length, 10);
    assert.equal(result, "nd message");
  });

  test("extractTranscriptText() skips malformed lines instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    fs.writeFileSync(filePath, 'not valid json\n{"type":"user","message":{"role":"user","content":"still readable"}}\n');

    const result = extractTranscriptText(filePath, 10000);

    assert.match(result, /still readable/);
  });

  test("extractTranscriptText() skips a line that parses to the JSON literal null instead of crashing on entry.type", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    fs.writeFileSync(filePath, 'null\n{"type":"user","message":{"role":"user","content":"still readable"}}\n');

    const result = extractTranscriptText(filePath, 10000);

    assert.match(result, /still readable/);
  });

  test("extractTranscriptText() strips a leading UTF-8 BOM instead of silently dropping the first line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    fs.writeFileSync(filePath, '﻿{"type":"user","message":{"role":"user","content":"first turn"}}\n');

    const result = extractTranscriptText(filePath, 10000);

    assert.match(result, /first turn/);
  });

  test("extractTranscriptText() drops a text block with no text field instead of rendering the literal string 'undefined'", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    const lines = [
      { type: "assistant", message: { role: "assistant", content: [{ type: "text" }] } },
      { type: "user", message: { role: "user", content: "still readable" } },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = extractTranscriptText(filePath, 10000);

    assert.doesNotMatch(result, /undefined/);
    assert.match(result, /still readable/);
  });

  test("extractTranscriptText() bounds its read to a tail of the file instead of loading the whole thing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASKFERRY_EXTRACT_TRANSCRIPT_PREFIX));
    const filePath = path.join(dir, TRANSCRIPT_JSONL_FILENAME);
    // Pad with a huge noise line so the file is far bigger than the small
    // budget below would need if the read were properly bounded.
    const noise = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: { data: "x".repeat(500000) } }] } });
    const tail = { type: "user", message: { role: "user", content: "the real message" } };
    fs.writeFileSync(filePath, noise + "\n" + JSON.stringify(tail) + "\n");

    const result = extractTranscriptText(filePath, 100);

    assert.match(result, /real message/);
  });

  test("extractTranscriptText() throws a UsageError naming the path when the file doesn't exist", () => {
    assert.throws(() => extractTranscriptText("/nonexistent/transcript.jsonl", 100), (err) => err instanceof UsageError && /\/nonexistent\/transcript\.jsonl/.test(err.message));
  });
});
