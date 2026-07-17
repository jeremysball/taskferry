import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { leanStatus } from "./output.js";

function resumeHint(detail) {
  return leanStatus(detail).next;
}

describe("leanStatus crashed-resume hint", () => {
  const base = { id: "oc_1", status: "crashed", sessionId: "ses_1", directory: "/workspace/proj" };

  test("quotes a benign session id and directory in single quotes", () => {
    assert.equal(
      resumeHint(base),
      "Session 'ses_1' may be salvageable; resume with taskferry dispatch --session-id 'ses_1' --directory '/workspace/proj' --prompt \"<continuation prompt>\""
    );
  });

  test("quotes a session id containing a single quote literally", () => {
    const hint = resumeHint({ ...base, sessionId: "ses_'x", directory: "/workspace/proj" });
    assert.ok(hint.includes("--session-id 'ses_'\\''x'"));
    assert.ok(!hint.includes("ses_x"));
  });

  test("quotes a directory containing $(...) literally, not executed", () => {
    const dir = "/workspace/$(touch pwned)";
    const hint = resumeHint({ ...base, directory: dir });
    assert.match(hint, /--directory '\/workspace\/\$\(touch pwned\)'/);
    assert.ok(hint.includes(dir));
  });

  test("quotes a session id containing backticks literally, not executed", () => {
    const sid = "ses_`whoami`";
    const hint = resumeHint({ ...base, sessionId: sid });
    assert.match(hint, /--session-id 'ses_`whoami`'/);
    assert.ok(hint.includes(sid));
  });
});
