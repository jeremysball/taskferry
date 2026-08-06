### Task 1: Raise the shared `task.tail`/`--tail-chars` ceiling to 131072

**Files:**
- Modify: `src/args.js:84`, `src/args.js:419`
- Modify: `src/protocol.js:142`
- Modify: `src/tasks.js:3098-3099`
- Test: `src/args.test.js`, `src/protocol.test.js`, `src/tasks.test.js`

**Interfaces:**
- Produces: the shared ceiling constant `131072`, used verbatim by later tasks (Task 3's `ADVISOR_TAIL_CHARS_CAP` in `commands.js` clamps to this same number).

- [ ] **Step 1: Write the failing tests**

In `src/args.test.js`, add near the other `tail`/`wait` tests:

```js
test("tail --chars accepts up to the new 131072 ceiling and rejects above it", () => {
  assert.equal(parseArgs(["tail", "oc_1", "--chars", "131072"]).options.chars, 131072);
  assert.throws(() => parseArgs(["tail", "oc_1", "--chars", "131073"]), /from 1 through 131072/);
});
```

In `src/protocol.test.js`, add near the other `task.tail`/`task.dispatch` tests:

```js
test("task.tail accepts chars up to 131072", () => {
  const parsed = parseRequestLine(request("task.tail", { taskId: "t1", chars: 131072 }));
  assert.equal(parsed.params.chars, 131072);
});

test("task.tail rejects chars above 131072", () => {
  assert.throws(() => parseRequestLine(request("task.tail", { taskId: "t1", chars: 131073 })), /invalid params/i);
});
```

In `src/tasks.test.js`, add right after the existing `test("validates the requested suffix length", ...)` inside `describe("tail()", ...)`:

```js
  test("accepts a request up to the 131072 ceiling and rejects above it", () => {
    const mgr = makeManager({ tasksFixture: [baseTask({ id: "t1" })] });
    assert.doesNotThrow(() => mgr.tail("t1", { chars: 131072 }));
    assert.throws(() => mgr.tail("t1", { chars: 131073 }), /chars must be a positive integer no greater than 131072/);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test src/args.test.js src/protocol.test.js src/tasks.test.js`
Expected: the three new tests FAIL (old ceiling is still 65536, so `131072` is rejected and the "no greater than 131072" message doesn't exist yet).

- [ ] **Step 3: Raise the ceiling in all three enforcement points**

In `src/args.js`, change line 84's help text:

```js
    options: { "--chars <number>": "characters to return, default 1000, maximum 131072" },
```

And line 419:

```js
      value = parseNumber(value, name, key === "tailChars" || key === "chars" ? { min: 1, max: 131072 } : key === "maxWords" ? { min: 75, max: 300 } : { min: key === "limit" ? 1 : 0 });
```

In `src/protocol.js`, change line 142:

```js
        && optional(params.chars, (value) => positiveInteger(value) && value <= 131072);
```

In `src/tasks.js`, change lines 3098-3099:

```js
    if (!Number.isSafeInteger(chars) || chars <= 0 || chars > 131072) {
      throw new Error("error: chars must be a positive integer no greater than 131072\nhelp: run taskferry tail with chars between 1 and 131072");
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `node --test src/args.test.js src/protocol.test.js src/tasks.test.js`
Expected: PASS, all three new tests plus the full existing suites in these three files.

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/protocol.js src/tasks.js src/args.test.js src/protocol.test.js src/tasks.test.js
git commit -m "feat(tail): raise the chars ceiling from 65536 to 131072"
```

---

