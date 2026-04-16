// ---------------------------------------------------------------------------
// Self-Test Bridge — Run inline self-tests inside Vitest (in-process)
//
// Imports and calls the exported `runSelfTests()` functions directly within
// the Vitest process so V8 code coverage can instrument the source code.
//
// Handles:
//   - process.exit() interception (prevents killing the test runner)
//   - Console output capture (parses pass/fail counts)
//   - Async self-test functions
//   - Module import errors (DB connections, etc.)
//
// Usage:
//   import { runModuleSelfTests } from "../helpers/selfTestBridge";
//   runModuleSelfTests([
//     { name: "Type System", file: "src/utils/typeSystem.ts", task: "Task 7" },
//   ]);
// ---------------------------------------------------------------------------

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

export interface SelfTestResult {
  passed: number;
  failed: number;
  output: string;
}

/**
 * Try to run the module's self-tests in-process for coverage.
 * Falls back to child-process execution if the import fails.
 *
 * @param forceChildProcess - Skip in-process attempt (for modules with
 *   async side effects like signal handlers and timers that outlive the call)
 */
export async function executeSelfTest(
  modulePath: string,
  timeout: number = 60_000,
  forceChildProcess: boolean = false
): Promise<SelfTestResult> {
  const absolutePath = path.join(ROOT, modulePath);

  if (!forceChildProcess) {
    // --- Attempt 1: In-process (enables V8 coverage) ---
    try {
      return await runInProcess(absolutePath);
    } catch {
      // Import failed (DB dependency, etc.) — fall back to child process
    }
  }

  // --- Attempt 2: Child process (no coverage, but always works) ---
  return runInChildProcess(absolutePath, timeout);
}

/**
 * Run self-tests in the current process by importing the module directly.
 * This enables V8 coverage instrumentation.
 */
async function runInProcess(absolutePath: string): Promise<SelfTestResult> {
  // Capture console output
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  // Intercept process.exit — throw a sentinel error to halt execution
  // without actually killing the process. Some modules (e.g. gracefulShutdown)
  // also mock process.exit internally, so we use a unique sentinel class.
  class ExitSentinel extends Error {
    code: number;
    constructor(code: number) {
      super(`process.exit(${code})`);
      this.code = code;
    }
  }

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;

  try {
    const mod = await import(absolutePath);

    if (typeof mod.runSelfTests !== "function") {
      throw new Error(`No exported runSelfTests in ${absolutePath}`);
    }

    await mod.runSelfTests();
  } catch (err) {
    // ExitSentinel is expected (success or failure path)
    if (!(err instanceof ExitSentinel)) {
      throw err; // Re-throw unexpected errors → triggers child-process fallback
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    process.exit = origExit;
  }

  return parseResults(logs.join("\n"));
}

/**
 * Run self-tests in a child process (original approach — always works).
 */
function runInChildProcess(
  absolutePath: string,
  timeout: number
): SelfTestResult {
  const output = execSync(`npx tsx "${absolutePath}"`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  return parseResults(output);
}

/**
 * Parse pass/fail counts from console output.
 */
function parseResults(output: string): SelfTestResult {
  let passed = 0;
  let failed = 0;

  // Try inline format: "N passed, M failed"
  const inlineMatch = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  if (inlineMatch) {
    passed = parseInt(inlineMatch[1], 10);
    failed = parseInt(inlineMatch[2], 10);
  }

  // Try Runner.summary format: "N/T Label tests passed, M failed"
  if (!inlineMatch) {
    const runnerMatch = output.match(
      /(\d+)\/(\d+)\s+.+?tests?\s+passed,\s+(\d+)\s+failed/
    );
    if (runnerMatch) {
      passed = parseInt(runnerMatch[1], 10);
      failed = parseInt(runnerMatch[3], 10);
    }
  }

  return { passed, failed, output };
}

/**
 * Register a Vitest describe/it block that runs a module's self-tests.
 */
export function runModuleSelfTest(
  name: string,
  modulePath: string,
  task: string,
  forceChildProcess: boolean = false
): void {
  describe(`${name} (${task})`, () => {
    it("passes all inline self-tests", async () => {
      const result = await executeSelfTest(modulePath, 60_000, forceChildProcess);

      expect(
        result.failed,
        `${name}: ${result.failed} assertion(s) failed\n${result.output}`
      ).toBe(0);
      expect(
        result.passed,
        `${name}: expected at least 1 passing assertion`
      ).toBeGreaterThan(0);
    });
  });
}

/**
 * Batch-register multiple modules as Vitest test suites.
 *
 * Set `subprocess: true` on individual modules that have async side effects
 * (signal handlers, timers) that outlive the runSelfTests call.
 */
export function runModuleSelfTests(
  modules: Array<{ name: string; file: string; task: string; subprocess?: boolean }>
): void {
  for (const mod of modules) {
    runModuleSelfTest(mod.name, mod.file, mod.task, mod.subprocess ?? false);
  }
}
