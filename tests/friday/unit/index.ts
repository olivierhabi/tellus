// ---------------------------------------------------------------------------
// Friday Unit Test Runner — Tasks 16-30
//
// Runs all inline self-tests for Friday (Day 5) modules. Each module has
// self-tests that execute when run directly via `npx tsx <file>`.
//
// This runner executes them all sequentially and provides a unified
// pass/fail exit code and summary.
//
// Note: Only modules with `if (require.main === module)` self-test blocks
// are included. Most Friday modules (actions/*, routes/*, middleware/*)
// do NOT have inline self-tests — they are covered by integration + E2E.
//
// Run: npm run test:friday:unit
//      npx tsx tests/friday/unit/index.ts
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface TestModule {
  name: string;
  file: string;
  task: string;
}

// ---------------------------------------------------------------------------
// Registry — Friday self-test modules (Tasks 16-30)
//
// Only modules with `if (require.main === module)` self-test blocks.
// Most Friday code is exercised via integration and E2E tests instead.
// ---------------------------------------------------------------------------

const modules: TestModule[] = [
  // Task 16: Indexer (CSV + OpenSearch indexing orchestrator)
  { name: "Indexer (CSV indexing pipeline)", file: "src/indexer.ts", task: "Task 16" },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let totalPassed = 0;
let totalFailed = 0;
let modulesRun = 0;
let modulesFailed = 0;

console.log("\n=== Running Friday unit self-tests (Tasks 16-30) ===\n");

if (modules.length === 0) {
  console.log("  No modules with inline self-tests for Friday.");
  console.log("  Friday code is covered by integration + E2E tests.\n");
  console.log("=".repeat(60));
  console.log("  Friday Unit Test Summary");
  console.log("  0 modules run, 0 failed");
  console.log("  0 assertions passed, 0 failed");
  console.log("=".repeat(60));
  process.exit(0);
}

for (const mod of modules) {
  const filePath = path.join(ROOT, mod.file);
  console.log(`--- ${mod.name} (${mod.task}) ---`);

  try {
    const output = execSync(`npx tsx "${filePath}"`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    modulesRun++;

    // Parse pass/fail from output
    const match = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (match) {
      const p = parseInt(match[1], 10);
      const f = parseInt(match[2], 10);
      totalPassed += p;
      totalFailed += f;
      console.log(`  ${p} passed, ${f} failed`);
      if (f > 0) modulesFailed++;
    } else {
      console.log(`  PASS (output did not include counts)`);
    }

    if (output.includes("FAIL")) {
      const failLines = output
        .split("\n")
        .filter((l) => l.includes("FAIL"));
      for (const line of failLines) {
        console.log(`  ${line.trim()}`);
      }
    }
  } catch (err: any) {
    modulesRun++;
    modulesFailed++;
    totalFailed++;
    console.log(`  FAIL: Module crashed`);
    if (err.stderr) {
      const lines = (err.stderr as string).split("\n").slice(0, 5);
      for (const line of lines) {
        console.log(`    ${line}`);
      }
    }
    if (err.stdout) {
      // Check if there are partial results in stdout
      const match = (err.stdout as string).match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
      if (match) {
        totalPassed += parseInt(match[1], 10);
        totalFailed += parseInt(match[2], 10) - 1; // -1 because we already counted 1 failure
      }
      // Show FAIL lines
      const failLines = (err.stdout as string)
        .split("\n")
        .filter((l: string) => l.includes("FAIL"));
      for (const line of failLines) {
        console.log(`  ${line.trim()}`);
      }
    }
  }

  console.log("");
}

console.log("=".repeat(60));
console.log(`  Friday Unit Test Summary`);
console.log(`  ${modulesRun} modules run, ${modulesFailed} failed`);
console.log(`  ${totalPassed} assertions passed, ${totalFailed} failed`);
console.log("=".repeat(60));

if (totalFailed > 0) {
  process.exit(1);
}
