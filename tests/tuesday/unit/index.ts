// ---------------------------------------------------------------------------
// Tuesday Unit Test Runner — Tasks 14-30
//
// Runs all inline self-tests for Tuesday (Day 2) modules. Each module has
// self-tests that execute when run directly via `npx tsx <file>`.
//
// This runner executes them all sequentially and provides a unified
// pass/fail exit code and summary.
//
// Note: Monday's unit runner already covers typeSystem, apiNameValidator,
// responseFormatter, structValidator, columnMappingValidator,
// fileScannerService, and schemaDiff. Those are NOT duplicated here.
//
// Run: npm run test:tuesday:unit
//      npx tsx tests/tuesday/unit/index.ts
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
// Registry — Tuesday self-test modules (Tasks 14-30)
//
// Only modules with `if (require.main === module)` self-test blocks.
// Ordered by task number.
// ---------------------------------------------------------------------------

const modules: TestModule[] = [
  // Task 1 (Day 2 scope): Type Mapper
  { name: "Type Mapper (property → OpenSearch)", file: "src/services/mapping/typeMapper.ts", task: "Task 1" },

  // Task 3: Mapping Diff
  { name: "Mapping Diff (index mapping comparison)", file: "src/services/opensearch/mappingDiff.ts", task: "Task 3" },

  // Task 5: Refresh Utility
  { name: "Refresh Utility (disable/enable refresh)", file: "src/services/opensearch/refreshUtil.ts", task: "Task 5" },

  // Task 7: CSV Reader
  { name: "CSV Reader (parse CSV files)", file: "src/services/indexing/csvReader.ts", task: "Task 7" },

  // Task 8: Type Converter
  { name: "Type Converter (CSV string → typed values)", file: "src/services/indexing/typeConverter.ts", task: "Task 8" },

  // Task 9: Row Transformer
  { name: "Row Transformer (CSV row → document)", file: "src/services/indexing/rowTransformer.ts", task: "Task 9" },

  // Task 10: Batch Document Builder
  { name: "Batch Document Builder", file: "src/services/indexing/batchDocumentBuilder.ts", task: "Task 10" },

  // Task 11: Primary Key Validator
  { name: "Primary Key Validator", file: "src/services/indexing/primaryKeyValidator.ts", task: "Task 11" },

  // Task 12: Indexing Orchestrator
  { name: "Indexing Orchestrator (7-stage pipeline)", file: "src/services/indexing/indexingOrchestrator.ts", task: "Task 12" },

  // Task 13: Funnel Pipeline State
  { name: "Funnel Pipeline State Model", file: "src/models/funnelState.ts", task: "Task 13" },

  // Task 14: Datasource Validator
  { name: "Datasource Validator (pre-index checks)", file: "src/services/indexing/datasourceValidator.ts", task: "Task 14" },

  // Task 15: Data Sampler
  { name: "Data Sampler (sample + infer types)", file: "src/services/indexing/dataSampler.ts", task: "Task 15" },

  // Task 17: Error Collector
  { name: "Error Collector (deduplicate errors)", file: "src/services/indexing/errorCollector.ts", task: "Task 17" },

  // Task 18: Progress Tracker
  { name: "Progress Tracker (multi-stage progress)", file: "src/services/indexing/progressTracker.ts", task: "Task 18" },

  // Task 19: Verifier
  { name: "Verifier (post-index count check)", file: "src/services/indexing/verifier.ts", task: "Task 19" },

  // Task 20: Object Counter
  { name: "Object Counter (count by type)", file: "src/services/opensearch/objectCounter.ts", task: "Task 20" },

  // Task 21: Edit Merger
  { name: "Edit Merger (user edits survive reindex)", file: "src/services/indexing/editMerger.ts", task: "Task 21" },

  // Task 25: Property Change Handler
  { name: "Property Change Handler (reindex advice)", file: "src/services/indexing/propertyChangeHandler.ts", task: "Task 25" },

  // Task 26: Auto-Create Hook
  { name: "Auto-Create Hook (index on datasource reg)", file: "src/services/indexing/autoCreateHook.ts", task: "Task 26" },

  // Task 29: Test Data Generator
  { name: "Test Data Generator (CSV generation)", file: "src/tests/helpers/testDataGenerator.ts", task: "Task 29" },

  // Task 30: Health Check Endpoint
  { name: "Health Check Endpoint", file: "src/routes/health.ts", task: "Task 30" },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let totalPassed = 0;
let totalFailed = 0;
let modulesRun = 0;
let modulesFailed = 0;

console.log("\n=== Running Tuesday unit self-tests (Tasks 14-30) ===\n");

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
console.log(`  Tuesday Unit Test Summary`);
console.log(`  ${modulesRun} modules run, ${modulesFailed} failed`);
console.log(`  ${totalPassed} assertions passed, ${totalFailed} failed`);
console.log("=".repeat(60));

if (totalFailed > 0) {
  process.exit(1);
}
