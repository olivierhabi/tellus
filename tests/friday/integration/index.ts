// ---------------------------------------------------------------------------
// Friday Integration Test Runner — Tasks 16-30
//
// Runs integration tests that exercise the complete action system built
// across Friday's tasks. Requires a live server (PostgreSQL + OpenSearch).
//
// Test suites:
//   1. Complete Action System (Task 30) — 42 tests across 15 groups
//      Exercises action type CRUD, execution (happy + error), atomicity,
//      idempotency, OCC, validate, batch, audit log, edit history,
//      OpenAPI spec, rate limiting, deleteObject/removeLink, and cleanup.
//
// Run: npm run test:friday:integration
//      npx tsx tests/friday/integration/index.ts
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface IntegrationSuite {
  name: string;
  file: string;
  task: string;
  requiresLiveServices: boolean;
  timeout: number;
}

// ---------------------------------------------------------------------------
// Service availability checks
// ---------------------------------------------------------------------------

async function isServerAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("http://localhost:3000/health", { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registry — Integration test suites
// ---------------------------------------------------------------------------

const suites: IntegrationSuite[] = [
  {
    name: "Complete Action System (15 groups, 42 tests)",
    file: "tests/friday/integration/friday-integration.test.ts",
    task: "Task 30",
    requiresLiveServices: true,
    timeout: 180000, // 3 min — includes rate limiting test
  },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  let totalPassed = 0;
  let totalFailed = 0;
  let suitesRun = 0;
  let suitesFailed = 0;
  let suitesSkipped = 0;

  // Pre-check server availability
  const serverUp = await isServerAvailable();
  if (!serverUp) {
    console.log("  Server not reachable at http://localhost:3000");
    console.log("  All Friday integration suites will be skipped.\n");
  }

  console.log("\n=== Running Friday integration tests ===\n");

  for (const suite of suites) {
    const filePath = path.join(ROOT, suite.file);
    console.log(`--- ${suite.name} (${suite.task}) ---`);

    if (suite.requiresLiveServices && !serverUp) {
      suitesSkipped++;
      console.log(`  SKIPPED (requires running server + PostgreSQL + OpenSearch)\n`);
      continue;
    }

    if (suite.requiresLiveServices) {
      console.log(`  (Requires live server + PostgreSQL + OpenSearch)`);
    }

    try {
      const output = execSync(`npx vitest run "${filePath}"`, {
        cwd: ROOT,
        encoding: "utf-8",
        timeout: suite.timeout,
        stdio: ["pipe", "pipe", "pipe"],
      });

      suitesRun++;

      // Parse pass/fail from output
      const match = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (match) {
        const p = parseInt(match[1], 10);
        const f = parseInt(match[2], 10);
        totalPassed += p;
        totalFailed += f;
        console.log(`  ${p} passed, ${f} failed`);
        if (f > 0) suitesFailed++;
      } else {
        console.log(`  PASS (output did not include counts)`);
      }

      if (output.includes("FAIL")) {
        const failLines = output
          .split("\n")
          .filter((l) => l.includes("FAIL"));
        for (const line of failLines.slice(0, 10)) {
          console.log(`  ${line.trim()}`);
        }
        if (failLines.length > 10) {
          console.log(`  ... and ${failLines.length - 10} more failures`);
        }
      }
    } catch (err: any) {
      suitesRun++;
      suitesFailed++;
      totalFailed++;
      console.log(`  FAIL: Suite crashed or had failures`);

      const stdout = (err.stdout as string) || "";
      const stderr = (err.stderr as string) || "";

      // Show partial results
      const match = stdout.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (match) {
        totalPassed += parseInt(match[1], 10);
        totalFailed += parseInt(match[2], 10) - 1;
      }

      // Show first few error lines
      if (stderr) {
        const lines = stderr.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) console.log(`    ${line}`);
        }
      }

      // Show FAIL lines from stdout
      const failLines = stdout
        .split("\n")
        .filter((l: string) => l.includes("FAIL"));
      for (const line of failLines.slice(0, 5)) {
        console.log(`  ${line.trim()}`);
      }
    }

    console.log("");
  }

  console.log("=".repeat(60));
  console.log(`  Friday Integration Test Summary`);
  console.log(`  ${suitesRun} suites run, ${suitesFailed} failed, ${suitesSkipped} skipped`);
  console.log(`  ${totalPassed} assertions passed, ${totalFailed} failed`);
  console.log("=".repeat(60));

  if (totalFailed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Integration runner error:", err);
  process.exit(1);
});
