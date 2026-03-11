// ---------------------------------------------------------------------------
// Unit Test Runner — Discovers and runs all self-test modules
//
// Each utility module has inline self-tests that run when executed directly.
// This runner executes them all and provides a unified pass/fail exit code.
//
// To add a new unit test module:
//   1. Add inline self-tests to your utility (see typeSystem.ts for pattern)
//   2. Add an entry to the `modules` array below
//
// Run: npm run test:monday
//      npm run test:monday:unit
//      npx tsx tests/monday/unit/index.ts
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
// Registry — add new self-test modules here
// ---------------------------------------------------------------------------

const modules: TestModule[] = [
  { name: "Type System (23 base types)", file: "src/utils/typeSystem.ts", task: "Task 7" },
  { name: "API Name Validator (5 validators)", file: "src/utils/apiNameValidator.ts", task: "Task 8" },
  { name: "Response Formatter", file: "src/utils/responseFormatter.ts", task: "Task 9" },
  { name: "Struct Validator", file: "src/utils/structValidator.ts", task: "Task 22" },
  { name: "Column Mapping Validator", file: "src/utils/columnMappingValidator.ts", task: "Task 23" },
  { name: "File Scanner Service", file: "src/services/fileScannerService.ts", task: "Task 24" },
  { name: "Schema Diff", file: "src/utils/schemaDiff.ts", task: "Task 27" },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let totalPassed = 0;
let totalFailed = 0;

console.log("\n=== Running unit self-tests for all utility modules ===\n");

for (const mod of modules) {
  const filePath = path.join(ROOT, mod.file);
  console.log(`--- ${mod.name} (${mod.task}) ---`);

  try {
    const output = execSync(`npx tsx "${filePath}"`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse pass/fail from output
    const match = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (match) {
      const p = parseInt(match[1], 10);
      const f = parseInt(match[2], 10);
      totalPassed += p;
      totalFailed += f;
      console.log(`  ${p} passed, ${f} failed`);
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
    totalFailed++;
    console.log(`  FAIL: Module crashed`);
    if (err.stderr) {
      const lines = err.stderr.split("\n").slice(0, 5);
      for (const line of lines) {
        console.log(`    ${line}`);
      }
    }
  }

  console.log("");
}

console.log(`\n=== Unit test summary: ${totalPassed} passed, ${totalFailed} failed ===\n`);

if (totalFailed > 0) {
  process.exit(1);
}
