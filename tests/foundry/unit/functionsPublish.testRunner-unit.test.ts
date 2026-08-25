import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  parseTapSummary,
  resolveTestRunnerTunables,
  runRepositoryTests,
} from "../../../src/services/functionsPublish/testRunner";

const PASSING_TEST = `
const { test } = require("node:test");
const assert = require("node:assert");
test("alpha passes", () => { assert.strictEqual(1, 1); });
test("beta passes", () => { assert.strictEqual("a", "a"); });
`;

describe("parseTapSummary", () => {
  it("parses a passing TAP summary", () => {
    const output = [
      "TAP version 13",
      "ok 1 - alpha passes",
      "1..1",
      "# tests 1",
      "# suites 0",
      "# pass 1",
      "# fail 0",
      "# duration_ms 42.5",
    ].join("\n");
    expect(parseTapSummary(output)).toEqual({ tests: 1, pass: 1, fail: 0, durationMs: 42.5 });
  });

  it("parses a failing TAP summary", () => {
    const output = "# tests 3\n# pass 2\n# fail 1\n# duration_ms 10\n";
    expect(parseTapSummary(output)).toMatchObject({ tests: 3, pass: 2, fail: 1 });
  });

  it("returns null for malformed output (loader crash, partial output)", () => {
    expect(parseTapSummary("Error: Cannot find module './nope'")).toBeNull();
    expect(parseTapSummary("# tests 2\n# pass 2\n")).toBeNull();
    expect(parseTapSummary("")).toBeNull();
  });
});

describe("resolveTestRunnerTunables", () => {
  it("uses named defaults when env is unset", () => {
    expect(resolveTestRunnerTunables({})).toEqual({
      timeoutMs: DEFAULT_TEST_TIMEOUT_MS,
      memoryMb: 256,
      killGraceMs: 2_000,
    });
  });

  it("clamps out-of-range and non-numeric env values", () => {
    expect(resolveTestRunnerTunables({
      FUNCTIONS_PUBLISH_TEST_TIMEOUT_MS: "1", // below the 1s floor
      FUNCTIONS_PUBLISH_TEST_MEMORY_MB: "999999",
      FUNCTIONS_PUBLISH_KILL_GRACE_MS: "not-a-number",
    })).toEqual({ timeoutMs: 1_000, memoryMb: 4_096, killGraceMs: 2_000 });
  });
});

describe("runRepositoryTests", () => {
  const tunables = { timeoutMs: 15_000, memoryMb: 128, killGraceMs: 500 };

  it("executes a passing test file and reports real counts", async () => {
    const result = await runRepositoryTests([
      { path: "src/functions/alpha.ts", source: "export default function alpha(input: string): string { return input; }\n" },
      { path: "src/functions/alpha.test.ts", source: PASSING_TEST },
    ], tunables);
    expect(result.status).toBe("passed");
    expect(result).toMatchObject({ fileCount: 1, testCount: 2, passedCount: 2, failedCount: 0 });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.childPid).not.toBeNull();
  });

  it("fails on a failing assertion and surfaces the detail", async () => {
    const result = await runRepositoryTests([
      { path: "src/functions/alpha.test.ts", source: `
const { test } = require("node:test");
const assert = require("node:assert");
test("first passes", () => { assert.strictEqual(1, 1); });
test("second fails", () => { assert.strictEqual(1, 2); });
test("third passes", () => { assert.strictEqual(3, 3); });
` },
    ], tunables);
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ testCount: 3, passedCount: 2, failedCount: 1 });
    expect(result.failures.join("\n")).toContain("second fails");
    expect(result.failures.join("\n")).toContain("ERR_ASSERTION");
  });

  it("fails when a test file throws during module loading", async () => {
    const result = await runRepositoryTests([
      { path: "src/functions/broken.test.ts", source: `
throw new Error("boom at module load");
` },
    ], tunables);
    expect(result.status).toBe("failed");
    expect(result.failures.join("\n")).toContain("boom at module load");
  });

  it("fails when a test file imports a missing module", async () => {
    const result = await runRepositoryTests([
      { path: "src/functions/nope.test.ts", source: `
const { test } = require("node:test");
const missing = require("./definitely-missing");
test("never runs", () => { missing(); });
` },
    ], tunables);
    expect(result.status).toBe("failed");
    expect(result.failedCount).toBeGreaterThanOrEqual(1);
    expect(result.failures.join("\n")).toContain("Cannot find module");
  });

  it("kills a hanging test at the configured timeout and reaps the process", async () => {
    let childPid = -1;
    const result = await runRepositoryTests([
      { path: "src/functions/hang.test.ts", source: `
const { test } = require("node:test");
test("hangs forever", async () => { await new Promise(() => {}); });
` },
    ], { timeoutMs: 1_000, memoryMb: 128, killGraceMs: 300, onChildSpawned: (pid) => { childPid = pid; } });
    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(true);
    expect(result.failures.join("\n")).toContain("timeout");
    expect(childPid).toBeGreaterThan(0);
    // The child (and its process group) must be gone after settlement.
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 20_000);

  it("zero test files is a structured pass (policy: no tests is not a failure)", async () => {
    const result = await runRepositoryTests([
      { path: "src/functions/alpha.ts", source: "export default function alpha(input: string): string { return input; }\n" },
    ], tunables);
    expect(result).toMatchObject({ status: "passed", fileCount: 0, testCount: 0, childPid: null });
  });
});
