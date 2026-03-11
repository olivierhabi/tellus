// ---------------------------------------------------------------------------
// Tuesday Integration Test Runner — Tasks 27-28
//
// Runs integration tests that exercise the full indexing pipeline and link
// resolver with injected dependencies (no live DB/OpenSearch required for
// the pipeline test; link resolver test requires both).
//
// Test suites:
//   1. Full Pipeline Test (Task 28) — 87 tests across 14 phases
//      Uses dependency injection. Runs always.
//
//   2. Link Resolver Test (Task 27) — 30 tests across 10 sections
//      Requires live PostgreSQL + OpenSearch. Skips gracefully if unavailable.
//
// Run: npm run test:tuesday:integration
//      npx tsx tests/tuesday/integration/index.ts
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

async function isPostgresAvailable(): Promise<boolean> {
  try {
    // Dynamically import pg to check connectivity
    const { Pool } = require("pg");
    const pool = new Pool({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432", 10),
      database: process.env.PGDATABASE || "tellus_db",
      user: process.env.PGUSER || "tellus",
      password: process.env.PGPASSWORD || "tellus123",
      connectionTimeoutMillis: 3000,
    });
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

async function isOpenSearchAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("http://localhost:9200", { signal: controller.signal });
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
    name: "Full Indexing Pipeline (14 phases)",
    file: "src/tests/indexing/fullPipelineTest.ts",
    task: "Task 28",
    requiresLiveServices: false,
    timeout: 120000,
  },
  {
    name: "Link Resolver (all cardinalities)",
    file: "tests/linkResolvers.test.ts",
    task: "Task 27",
    requiresLiveServices: true,
    timeout: 180000,
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

  // Pre-check live service availability
  let liveServicesAvailable = false;
  const hasLiveSuites = suites.some((s) => s.requiresLiveServices);

  if (hasLiveSuites) {
    const [pgOk, osOk] = await Promise.all([
      isPostgresAvailable(),
      isOpenSearchAvailable(),
    ]);
    liveServicesAvailable = pgOk && osOk;
    if (!liveServicesAvailable) {
      console.log(
        `  Live services: PostgreSQL ${pgOk ? "UP" : "DOWN"}, OpenSearch ${osOk ? "UP" : "DOWN"}`
      );
      console.log(
        `  Suites requiring live services will be skipped.\n`
      );
    }
  }

  console.log("\n=== Running Tuesday integration tests ===\n");

  for (const suite of suites) {
    const filePath = path.join(ROOT, suite.file);
    console.log(`--- ${suite.name} (${suite.task}) ---`);

    // Skip suites that require live services when they're not available
    if (suite.requiresLiveServices && !liveServicesAvailable) {
      suitesSkipped++;
      console.log(`  SKIPPED (requires PostgreSQL + OpenSearch)\n`);
      continue;
    }

    if (suite.requiresLiveServices) {
      console.log(`  (Requires live PostgreSQL + OpenSearch)`);
    }

    try {
      const output = execSync(`npx tsx "${filePath}"`, {
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
        totalFailed += parseInt(match[2], 10) - 1; // -1 because we already counted 1
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
  console.log(`  Tuesday Integration Test Summary`);
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
