// Scoring for skill evals. Pure functions over a shim command log, so the same
// log always produces the same verdict and the scorer can be unit-tested without
// dispatching anything.
import fs from "node:fs";

/** Parse a shim JSONL log into an array of invocations. */
export function readCommandLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function argvOf(entry) {
  return entry.argv.join(" ");
}

/**
 * A check is `{ id, description, kind, ... }`. Every check returns
 * `{ id, ok, detail }` so a failing run says which criterion failed and why,
 * rather than just "FAIL".
 */
const CHECKS = {
  // At least one invocation's argv contains every token in `tokens`.
  ranCommand({ tokens }, log) {
    const hit = log.find((entry) => tokens.every((t) => entry.argv.includes(t)));
    return { ok: Boolean(hit), detail: hit ? argvOf(hit) : `no invocation contained: ${tokens.join(" ")}` };
  },
  // No invocation's argv contains every token in `tokens`.
  neverRanCommand({ tokens }, log) {
    const hit = log.find((entry) => tokens.every((t) => entry.argv.includes(t)));
    return { ok: !hit, detail: hit ? `forbidden command ran: ${argvOf(hit)}` : "not run" };
  },
  // `before` tokens must first appear earlier than `after` tokens.
  ranInOrder({ before, after }, log) {
    const idx = (tokens) => log.findIndex((entry) => tokens.every((t) => entry.argv.includes(t)));
    const b = idx(before);
    const a = idx(after);
    if (b === -1) return { ok: false, detail: `never ran: ${before.join(" ")}` };
    if (a === -1) return { ok: false, detail: `never ran: ${after.join(" ")}` };
    return { ok: b < a, detail: `${before.join(" ")} at ${b}, ${after.join(" ")} at ${a}` };
  },
  // Exactly `count` invocations match `tokens`.
  ranExactly({ tokens, count }, log) {
    const hits = log.filter((entry) => tokens.every((t) => entry.argv.includes(t)));
    return { ok: hits.length === count, detail: `matched ${hits.length}, expected ${count}` };
  },
};

export function scoreRun(fixture, log) {
  const results = fixture.checks.map((check) => {
    const runner = CHECKS[check.kind];
    if (!runner) throw new Error(`unknown check kind: ${check.kind}`);
    const { ok, detail } = runner(check, log);
    return { id: check.id, description: check.description, ok, detail };
  });
  return { pass: results.every((r) => r.ok), results };
}

export function formatReport(fixture, { pass, results }) {
  const lines = [`${pass ? "PASS" : "FAIL"}  ${fixture.name}`];
  for (const r of results) {
    lines.push(`  ${r.ok ? "ok  " : "FAIL"} ${r.id}: ${r.description}`);
    if (!r.ok) lines.push(`         ${r.detail}`);
  }
  return lines.join("\n");
}
