## Task 1: `detectHeadDrift` — non-throwing replacement for `assertNoHeadDrift`

**Files:**
- Modify: `src/changeset.js:92-114` (delete `assertNoHeadDrift`, add `detectHeadDrift`)
- Test: `src/changeset.test.js`

**Interfaces:**
- Produces: `export function detectHeadDrift(directory, runCommand, preDispatchHead): {from: string, to: string} | null` — `null` means "no confirmed drift" (HEAD matches, or the check was inconclusive: a git failure or non-git target, matching the old fail-open behavior).

- [ ] **Step 1: Write the failing tests**

Replace the two existing `assertNoHeadDrift`-via-`extractGitDiff` "refuses to extract" tests in `src/changeset.test.js` (the `describe("extraction fail-closed behavior", ...)` block, tests `"extractGitDiff refuses to extract when the directory's HEAD moved since preDispatchHead, without invoking bwrap"` and `"extractGitDiff proceeds normally when the HEAD re-check itself can't resolve (git failure)"`) will be rewritten in Task 2 once `extractGitDiff`'s contract actually changes. For this task, add a standalone `describe("detectHeadDrift()", ...)` block directly testing the new pure function, above the `describe("extractGitDiff()", ...)` block:

```js
import { overlayPaths, subOverlaySlug, extractGitDiff, resolvePreDispatchHead, buildMergedViewBwrapArgs, extractNonGitDiff, applyChangeset, cleanupOverlay, detectHeadDrift, resolveHeadDrift } from "./changeset.js";
```

```js
describe("detectHeadDrift()", () => {
  test("returns null when current HEAD matches preDispatchHead", () => {
    const runCommand = () => ({ status: 0, stdout: "abc123\n", stderr: "", error: null });
    assert.equal(detectHeadDrift(REPO_DIR, runCommand, PRE_DISPATCH_HEAD), null);
  });

  test("returns {from, to} when current HEAD has moved", () => {
    const runCommand = () => ({ status: 0, stdout: "def456\n", stderr: "", error: null });
    assert.deepEqual(detectHeadDrift(REPO_DIR, runCommand, PRE_DISPATCH_HEAD), { from: PRE_DISPATCH_HEAD, to: "def456" });
  });

  test("returns null (fail-open) when the HEAD check itself is inconclusive", () => {
    const runCommand = () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository\n", error: null });
    assert.equal(detectHeadDrift(REPO_DIR, runCommand, PRE_DISPATCH_HEAD), null);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern "detectHeadDrift"`
Expected: FAIL — `detectHeadDrift` is not exported yet.

- [ ] **Step 3: Implement `detectHeadDrift`, deleting `assertNoHeadDrift`**

In `src/changeset.js`, replace the whole `assertNoHeadDrift` function (lines 92-114) with:

```js
/**
 * Detects whether `directory`'s current HEAD has confirmably moved away from
 * `preDispatchHead`. Returns `null` when there's no confirmed drift — either
 * HEAD still matches, or the check itself was inconclusive (a git failure, a
 * non-git target) — deliberately fail-open on the inconclusive case, same as
 * this replaced `assertNoHeadDrift`'s behavior. Unlike that function, this
 * never throws: taskferry#XXX changed drift from a fatal abort into
 * something `extractGitDiff` resolves via a real 3-way apply instead (see
 * `resolveHeadDrift`).
 * @param {string} directory
 * @param {typeof defaultRunCommand} runCommand
 * @param {string} preDispatchHead
 * @returns {{from: string, to: string} | null}
 */
function detectHeadDrift(directory, runCommand, preDispatchHead) {
  const currentHead = resolvePreDispatchHead(directory, runCommand);
  if (currentHead !== null && currentHead !== preDispatchHead) {
    return { from: preDispatchHead, to: currentHead };
  }
  return null;
}
```

Do not export it yet from the module's public surface beyond what's needed — it's consumed internally by `extractGitDiff` (Task 2). Leave it as a plain (non-`export`ed) function for now; Task 2's tests reach it only through `extractGitDiff`. (The `describe("detectHeadDrift()", ...)` block added in Step 1 does need it exported, so mark it `export function detectHeadDrift(...)`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "detectHeadDrift"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/changeset.js src/changeset.test.js
git commit -m "refactor(changeset): replace throwing assertNoHeadDrift with detectHeadDrift"
```

---

