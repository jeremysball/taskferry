import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readMemoryUsage, DEFAULT_MEMORY_ADMISSION_PERCENT, MEMORY_ADMISSION_POLL_MS } from "./memory.js";

const MEMINFO = "/proc/meminfo";
const SELF_CGROUP = "/proc/self/cgroup";
const CGROUP = "/sys/fs/cgroup";
const KB = 1024;
const GB = 1024 ** 3;

/** @param {Record<string, string>} files */
function readerFor(files) {
  return (/** @type {string} */ filePath) => {
    if (Object.hasOwn(files, filePath)) return files[filePath];
    const err = /** @type {Error & {code: string}} */ (new Error(`ENOENT: ${filePath}`));
    err.code = "ENOENT";
    throw err;
  };
}

/** @param {{totalGb?: number, availableGb?: number}} [fields] */
function meminfo({ totalGb = 16, availableGb = 8 } = {}) {
  return [
    `MemTotal:       ${totalGb * GB / KB} kB`,
    `MemAvailable:   ${availableGb * GB / KB} kB`,
    "",
  ].join("\n");
}

/** @param {string} limit @param {string} current */
function v2(limit, current) {
  return {
    [`${CGROUP}/memory.max`]: limit,
    [`${CGROUP}/memory.current`]: current,
  };
}

describe("readMemoryUsage() metric parsing", () => {
  test("uses MemAvailable against MemTotal when no cgroup limit is set", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/\n",
        ...v2("max", "4"),
      }),
    });
    assert.equal(usage.limitBytes, 16 * GB);
    assert.equal(usage.availableBytes, 8 * GB);
    assert.equal(usage.percent, 50);
    assert.equal(usage.cgroupLimited, false);
  });

  test("uses a finite cgroup v2 limit below the visible physical total", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/\n",
        ...v2(String(4 * GB), String(3 * GB)),
      }),
    });
    assert.equal(usage.limitBytes, 4 * GB);
    assert.equal(usage.availableBytes, 1 * GB);
    assert.equal(usage.percent, 75);
    assert.equal(usage.cgroupLimited, true);
  });

  test("honors a nested cgroup v2 path named by /proc/self/cgroup", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/lxc/taskferry\n",
        [`${CGROUP}/memory.max`]: "max",
        [`${CGROUP}/lxc/taskferry/memory.max`]: String(2 * GB),
        [`${CGROUP}/lxc/taskferry/memory.current`]: String(1 * GB),
      }),
    });
    assert.equal(usage.limitBytes, 2 * GB);
    assert.equal(usage.availableBytes, 1 * GB);
    assert.equal(usage.percent, 50);
  });

  test("honors a finite limit on an ancestor cgroup when the leaf reports max", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/user.slice/session-1.scope\n",
        [`${CGROUP}/memory.max`]: "max",
        [`${CGROUP}/user.slice/memory.max`]: String(4 * GB),
        [`${CGROUP}/user.slice/memory.current`]: String(3 * GB),
        [`${CGROUP}/user.slice/session-1.scope/memory.max`]: "max",
        [`${CGROUP}/user.slice/session-1.scope/memory.current`]: String(3 * GB),
      }),
    });
    assert.equal(usage.limitBytes, 4 * GB);
    assert.equal(usage.availableBytes, 1 * GB);
    assert.equal(usage.percent, 75);
    assert.equal(usage.cgroupLimited, true);
  });

  test("honors a finite v1 limit on an ancestor cgroup", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "5:cpu,memory:/lxc/taskferry\n",
        [`${CGROUP}/memory/memory.limit_in_bytes`]: "9223372036854771712",
        [`${CGROUP}/memory/lxc/memory.limit_in_bytes`]: String(3 * GB),
        [`${CGROUP}/memory/lxc/memory.usage_in_bytes`]: String(2 * GB),
        [`${CGROUP}/memory/lxc/taskferry/memory.limit_in_bytes`]: "9223372036854771712",
      }),
    });
    assert.equal(usage.limitBytes, 3 * GB);
    assert.equal(usage.availableBytes, 1 * GB);
    assert.ok(Math.abs(usage.percent - 66.66666666666666) < 1e-9);
    assert.equal(usage.cgroupLimited, true);
  });

  test("does not let the v1 memory root shadow a v2 ancestor named memory", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/memory/taskferry\n",
        [`${CGROUP}/memory/memory.max`]: String(4 * GB),
        [`${CGROUP}/memory/memory.current`]: String(3 * GB),
        [`${CGROUP}/memory/taskferry/memory.max`]: "max",
      }),
    });
    assert.equal(usage.limitBytes, 4 * GB);
    assert.equal(usage.availableBytes, 1 * GB);
    assert.equal(usage.percent, 75);
    assert.equal(usage.cgroupLimited, true);
  });

  test("uses a finite cgroup v1 limit at a nested memory-controller path", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "5:cpu,cpuacct,memory:/lxc/taskferry\n",
        [`${CGROUP}/memory/memory.limit_in_bytes`]: "9223372036854771712",
        [`${CGROUP}/memory/lxc/taskferry/memory.limit_in_bytes`]: String(3 * GB),
        [`${CGROUP}/memory/lxc/taskferry/memory.usage_in_bytes`]: String(2.5 * GB),
      }),
    });
    assert.equal(usage.limitBytes, 3 * GB);
    assert.equal(usage.availableBytes, 0.5 * GB);
    assert.ok(Math.abs(usage.percent - 83.33333333333334) < 1e-9);
    assert.equal(usage.cgroupLimited, true);
  });

  test("ignores the cgroup v1 unlimited sentinel", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 4 }),
        [SELF_CGROUP]: "4:memory:/\n",
        [`${CGROUP}/memory/memory.limit_in_bytes`]: "9223372036854771712",
        [`${CGROUP}/memory/memory.usage_in_bytes`]: String(1 * GB),
      }),
    });
    assert.equal(usage.limitBytes, 16 * GB);
    assert.equal(usage.availableBytes, 4 * GB);
    assert.equal(usage.percent, 75);
    assert.equal(usage.cgroupLimited, false);
  });

  test("keeps MemTotal as the ceiling when the cgroup limit is larger", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/\n",
        ...v2(String(32 * GB), String(1 * GB)),
      }),
    });
    assert.equal(usage.limitBytes, 16 * GB);
    assert.equal(usage.availableBytes, 8 * GB);
    assert.equal(usage.percent, 50);
  });

  test("reports 0% when MemAvailable equals the ceiling and 100% when nothing is available", () => {
    const idle = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 16 }),
        [SELF_CGROUP]: "0::/\n",
      }),
    });
    assert.equal(idle.percent, 0);

    const full = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 0 }),
        [SELF_CGROUP]: "0::/\n",
      }),
    });
    assert.equal(full.percent, 100);
  });

  test("clamps cgroup availability at zero when current exceeds the limit", () => {
    const usage = readMemoryUsage({
      readFileFn: readerFor({
        [MEMINFO]: meminfo({ totalGb: 16, availableGb: 8 }),
        [SELF_CGROUP]: "0::/\n",
        ...v2(String(2 * GB), String(3 * GB)),
      }),
    });
    assert.equal(usage.limitBytes, 2 * GB);
    assert.equal(usage.availableBytes, 0);
    assert.equal(usage.percent, 100);
  });
});

describe("readMemoryUsage() malformed metric boundary", () => {
  test("throws when /proc/meminfo is missing", () => {
    assert.throws(
      () => readMemoryUsage({ readFileFn: readerFor({ [SELF_CGROUP]: "0::/\n" }) }),
      /MemTotal|not readable/i
    );
  });

  test("throws when MemTotal is missing or unusable", () => {
    assert.throws(
      () => readMemoryUsage({ readFileFn: readerFor({ [MEMINFO]: "MemAvailable: 1024 kB\n" }) }),
      /no usable MemTotal/
    );
    assert.throws(
      () => readMemoryUsage({ readFileFn: readerFor({ [MEMINFO]: "MemTotal: 0 kB\nMemAvailable: 0 kB\n" }) }),
      /no usable MemTotal/
    );
  });

  test("throws when MemAvailable is missing or unusable", () => {
    assert.throws(
      () => readMemoryUsage({ readFileFn: readerFor({ [MEMINFO]: "MemTotal: 1024 kB\n" }) }),
      /no usable MemAvailable/
    );
    assert.throws(
      () => readMemoryUsage({ readFileFn: readerFor({ [MEMINFO]: "MemTotal: 1024 kB\nMemAvailable: nope kB\n" }) }),
      /no usable MemAvailable/
    );
  });

  test("propagates a non-ENOENT /proc/meminfo read error instead of treating it as absent", () => {
    const err = /** @type {Error & {code: string}} */ (new Error("EACCES: /proc/meminfo"));
    err.code = "EACCES";
    assert.throws(() => readMemoryUsage({ readFileFn: () => { throw err; } }), /EACCES/);
  });

  test("throws when a finite cgroup limit has no readable current usage", () => {
    assert.throws(
      () => readMemoryUsage({
        readFileFn: readerFor({
          [MEMINFO]: meminfo(),
          [SELF_CGROUP]: "0::/\n",
          [`${CGROUP}/memory.max`]: String(2 * GB),
        }),
      }),
      /memory\.current is missing/
    );
  });

  test("throws when a cgroup current value is not a byte count", () => {
    assert.throws(
      () => readMemoryUsage({
        readFileFn: readerFor({
          [MEMINFO]: meminfo(),
          [SELF_CGROUP]: "0::/\n",
          ...v2(String(2 * GB), "lots"),
        }),
      }),
      /not a usable byte count/
    );
  });

  test("throws when a cgroup limit is non-empty but not a byte count", () => {
    assert.throws(
      () => readMemoryUsage({
        readFileFn: readerFor({
          [MEMINFO]: meminfo(),
          [SELF_CGROUP]: "0::/\n",
          ...v2("2G", "1"),
        }),
      }),
      /memory\.max is not a usable byte count/
    );
  });

  test("throws when a cgroup current value is empty instead of treating it as zero", () => {
    assert.throws(
      () => readMemoryUsage({
        readFileFn: readerFor({
          [MEMINFO]: meminfo(),
          [SELF_CGROUP]: "0::/\n",
          ...v2(String(2 * GB), "  \n"),
        }),
      }),
      /memory\.current is not a usable byte count/
    );
  });
});

describe("memory admission constants", () => {
  test("document the 85% default and the documented 1000 ms poll interval", () => {
    assert.equal(DEFAULT_MEMORY_ADMISSION_PERCENT, 85);
    assert.equal(MEMORY_ADMISSION_POLL_MS, 1000);
  });
});
