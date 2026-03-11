// ---------------------------------------------------------------------------
// Self-Test Bridge — Run inline self-tests inside Vitest
//
// Many source modules contain inline self-tests invoked via
// `if (require.main === module)`. This bridge executes those modules as
// child processes and asserts on the result, providing proper Vitest
// integration (timing, failure reporting, test isolation).
//
// Usage in a .test.ts file:
//   import { runModuleSelfTest } from "../helpers/selfTestBridge";
//   runModuleSelfTest("Type System", "src/utils/typeSystem.ts", "Task 7");
//
// This is a migration bridge. As modules are incrementally migrated to
// native Vitest describe/it/expect, they are removed from this bridge.
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import path from "path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

export interface SelfTestResult {
  passed: number;
  failed: number;
  output: string;
}

/**
 * Execute a module's inline self-tests as a child process and parse results.
 *
 * @param modulePath - Path relative to project root (e.g. "src/utils/typeSystem.ts")
 * @param timeout    - Max execution time in ms (default: 60s)
 * @returns Parsed test results
 * @throws If the module crashes or has test failures
 */
export function executeSelfTest(
  modulePath: string,
  timeout: number = 60_000
): SelfTestResult {
  const absolutePath = path.join(ROOT, modulePath);

  const output = execSync(`npx tsx "${absolutePath}"`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  // Match both formats:
  //   "47 passed, 0 failed"                            (inline self-tests)
  //   "49/49 Link Resolver tests passed, 0 failed"     (Runner.summary())
  let passed = 0;
  let failed = 0;

  // Try inline self-test format first: "N passed, M failed"
  const inlineMatch = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  if (inlineMatch) {
    passed = parseInt(inlineMatch[1], 10);
    failed = parseInt(inlineMatch[2], 10);
  }

  // If not found, try Runner.summary format: "N/T Label tests passed, M failed"
  if (!inlineMatch) {
    const runnerMatch = output.match(/(\d+)\/(\d+)\s+.+?tests?\s+passed,\s+(\d+)\s+failed/);
    if (runnerMatch) {
      passed = parseInt(runnerMatch[1], 10);
      failed = parseInt(runnerMatch[3], 10);
    }
  }

  return { passed, failed, output };
}

/**
 * Register a Vitest describe/it block that runs a module's inline self-tests.
 *
 * @param name       - Human-readable module name
 * @param modulePath - Path relative to project root
 * @param task       - Task identifier (e.g. "Task 7")
 */
export function runModuleSelfTest(
  name: string,
  modulePath: string,
  task: string
): void {
  describe(`${name} (${task})`, () => {
    it(`passes all inline self-tests`, () => {
      const result = executeSelfTest(modulePath);

      expect(result.failed, `${name}: ${result.failed} assertion(s) failed\n${result.output}`)
        .toBe(0);
      expect(result.passed, `${name}: expected at least 1 passing assertion`)
        .toBeGreaterThan(0);
    });
  });
}

/**
 * Batch-register multiple modules as Vitest test suites.
 *
 * @param modules - Array of { name, file, task } objects
 */
export function runModuleSelfTests(
  modules: Array<{ name: string; file: string; task: string }>
): void {
  for (const mod of modules) {
    runModuleSelfTest(mod.name, mod.file, mod.task);
  }
}
