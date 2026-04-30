// ---------------------------------------------------------------------------
// Run All Tests — Consolidated Test Runner (Task 29)
//
// Discovers and runs all test suites in order, prints a consolidated report.
//
// Suite order:
//   1. Unit self-tests (inline self-tests in src/ modules)
//   2. Day-based test suites (monday → friday)
//   3. Integration tests (vitest)
//   4. Performance benchmarks (optional, requires running server)
//
// Run: npx tsx tests/runAll.ts
//      npx tsx tests/runAll.ts --skip-perf    # skip performance benchmarks
//      npx tsx tests/runAll.ts --only-unit     # only inline self-tests
// ---------------------------------------------------------------------------

import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SuiteResult {
  name: string;
  category: string;
  passed: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const ARGS = process.argv.slice(2);
const SKIP_PERF = ARGS.includes("--skip-perf");
const ONLY_UNIT = ARGS.includes("--only-unit");
const TIMEOUT_PER_SUITE = 120_000; // 2 minutes per suite

// ---------------------------------------------------------------------------
// Server management — start/stop/restart with elevated rate limits
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;

/**
 * Kill any process listening on port 3000, excluding the current process.
 * Uses SIGTERM first for a clean shutdown, then SIGKILL after a brief wait.
 */
function killPort3000(): void {
  try {
    const pidsRaw = execSync("lsof -ti:3000 2>/dev/null || true", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    if (!pidsRaw) return;

    const myPid = process.pid;
    const pids = pidsRaw
      .split("\n")
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p) && p !== myPid);

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process might already be dead
      }
    }

    // Brief wait, then force-kill any survivors
    if (pids.length > 0) {
      try {
        execSync("sleep 0.5", { stdio: "pipe" });
      } catch { /* ignore */ }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already dead — expected
        }
      }
    }
  } catch {
    // Ignore — port might not be in use
  }
}

async function startServer(): Promise<void> {
  killPort3000();
  // Brief pause to let the port free up
  await new Promise((r) => setTimeout(r, 1500));

  const serverPath = path.join(ROOT, "src/server.ts");

  serverProcess = spawn("npx", ["tsx", serverPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Mirror tests/globalSetup.ts:303-339 so the runAll-owned server is
      // test-equivalent to the one globalSetup spawns. Without this, Phase 3
      // vitest suites run against a server that still has background workers
      // live (funnel/pipeline/temporal dispatchers), whose CPU contention on
      // GitHub's 2-core runners intermittently pushes POST /api/v1/ontology
      // into 5xx territory — which is what triggers the "ontology create
      // returned no id" beforeAll crashes in tests/wednesday/integration/*.
      TELLUS_TEST_HOOKS: "1",
      RATE_LIMIT_MAX: "10000",
      ACTION_RATE_LIMIT_MAX: "10000",
      USER_RATE_LIMIT_MAX: "50000",
      GLOBAL_ACTION_RATE_LIMIT_MAX: "100000",
      BATCH_RATE_LIMIT_MAX: "1000",
      // F-CI-POOL: bump PG pool to handle Phase 3's parallel vitest workers
      // hitting the same shared server. Default 20 exhausts under the
      // batch / rate-limiter test load and surfaces as
      // `timeout exceeded when trying to connect`.
      PG_POOL_MAX: process.env.PG_POOL_MAX || "60",
      PG_CONNECT_TIMEOUT_MS: process.env.PG_CONNECT_TIMEOUT_MS || "15000",
      FUNNEL_DISPATCHER_DISABLED: "true",
      PIPELINE_DISPATCHER_DISABLED: "true",
      PIPELINE_ICEBERG_MAINTENANCE_DISABLED: "true",
      OVERLAY_SWEEPER_DISABLED: "true",
      REPLACEMENT_SCHEDULER_DISABLED: "true",
      TEMPORAL_WORKER_DISABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Prevent the server from keeping the parent alive
  serverProcess.unref();

  // Wait for server to become healthy
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://localhost:3000/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log(`  Server ready (PID ${serverProcess.pid}).`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Server failed to start within 30 seconds");
}

function stopServer(): void {
  if (serverProcess && serverProcess.pid) {
    try {
      // Kill the entire process group (negative PID) since detached=true
      process.kill(-serverProcess.pid, "SIGTERM");
    } catch {
      // Process might already be dead
    }
    serverProcess = null;
  }
  killPort3000();
}

async function restartServer(): Promise<void> {
  console.log("  Restarting server with elevated rate limits...");
  stopServer();
  await startServer();
}

// ---------------------------------------------------------------------------
// Self-test modules (inline `if (require.main === module)` tests)
// ---------------------------------------------------------------------------

const SELF_TEST_MODULES = [
  { name: "Response Formatter", file: "src/utils/responseFormatter.ts" },
  { name: "Type System", file: "src/utils/typeSystem.ts" },
  { name: "API Name Validator", file: "src/utils/apiNameValidator.ts" },
  { name: "Column Mapping Validator", file: "src/utils/columnMappingValidator.ts" },
  { name: "Struct Validator", file: "src/utils/structValidator.ts" },
  { name: "Schema Diff", file: "src/utils/schemaDiff.ts" },
  { name: "Type Coercion", file: "src/utils/typeCoercion.ts" },
  { name: "Type Converter", file: "src/utils/typeConverter.ts" },
  { name: "Health Check (Legacy)", file: "src/routes/health.ts" },
  { name: "Health Check (Enhanced)", file: "src/routes/healthCheck.ts" },
  { name: "Funnel State Model", file: "src/models/funnelState.ts" },
  { name: "Action Type Model", file: "src/models/actionType.ts" },
  { name: "Link Type Model", file: "src/models/linkType.ts" },
  { name: "Ontology Edit Model", file: "src/models/ontologyEdit.ts" },
  { name: "Action Audit Log", file: "src/models/actionAuditLog.ts" },
  { name: "Property Validator", file: "src/actions/propertyValidator.ts" },
  { name: "Parameter Validator", file: "src/actions/parameterValidator.ts" },
  { name: "Object Checker", file: "src/actions/objectChecker.ts" },
  { name: "Rule Compiler", file: "src/actions/ruleCompiler.ts" },
  { name: "Action Validator", file: "src/actions/actionValidator.ts" },
  { name: "Edit Applicator", file: "src/actions/editApplicator.ts" },
  { name: "Idempotency", file: "src/actions/idempotency.ts" },
  { name: "Schema Migration Validator", file: "src/actions/schemaMigrationValidator.ts" },
  { name: "Query Validator", file: "src/services/queryValidator.ts" },
  { name: "Query Translator", file: "src/services/queryTranslator.ts" },
  { name: "Pagination Service", file: "src/services/paginationService.ts" },
  { name: "Property Resolver", file: "src/services/propertyResolver.ts" },
  { name: "Object Counter", file: "src/services/opensearch/objectCounter.ts" },
  { name: "Mapping Diff", file: "src/services/opensearch/mappingDiff.ts" },
  { name: "Index Mapping Generator", file: "src/services/opensearch/indexMappingGenerator.ts" },
  { name: "Row Transformer", file: "src/services/indexing/rowTransformer.ts" },
  { name: "Primary Key Validator", file: "src/services/indexing/primaryKeyValidator.ts" },
  { name: "Error Collector", file: "src/services/indexing/errorCollector.ts" },
  { name: "Progress Tracker", file: "src/services/indexing/progressTracker.ts" },
  { name: "Datasource Validator", file: "src/services/indexing/datasourceValidator.ts" },
  { name: "Batch Document Builder", file: "src/services/indexing/batchDocumentBuilder.ts" },
  { name: "Edit Merger", file: "src/services/indexing/editMerger.ts" },
  { name: "Data Sampler", file: "src/services/indexing/dataSampler.ts" },
  { name: "Type Converter (Indexing)", file: "src/services/indexing/typeConverter.ts" },
  { name: "Property Change Handler", file: "src/services/indexing/propertyChangeHandler.ts" },
  { name: "Test Data Generator (src)", file: "src/tests/helpers/testDataGenerator.ts" },
  { name: "API Doc Generator", file: "src/utils/generateApiDocs.ts" },
  { name: "Test Data Generator (tests)", file: "tests/utils/testDataGenerator.ts" },
];

// ---------------------------------------------------------------------------
// Day test suites
// ---------------------------------------------------------------------------

// DAY_SUITES drives Phase 2 (the nested `tsx tests/<day>/index.ts` chain).
//
// `friday` is intentionally dropped here: its integration file (15 groups,
// 42 tests) runs through a 3-deep tsx→tsx→tsx→vitest pipeline plus the
// long-lived server on port 3000, which overruns the GitHub Actions
// 7 GB runner and the kernel OOM-kills the whole group with exit 137.
//
// Phase 3 below already runs `vitest run tests/friday/integration` as a
// single direct child of this process, so removing friday here is not a
// coverage reduction — it eliminates a duplicate run that is also the
// memory hot-spot.
const DAY_SUITES = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// Env vars passed to all child processes — matches the elevated rate limits
// used by the managed server so that tests can detect elevated limits and
// skip rate-limiter-specific tests.
//
// TELLUS_TEST_BEARER is populated later (after server + Keycloak are up) by
// acquireAliceToken(). Day-suite child processes read it at module load
// in tests/helpers/api.ts and use it as the default bearer for every
// request — without this, every data-plane call returns 401 under F-01.
// NODE_OPTIONS pins the child-process V8 heap so the GitHub runner can't
// be OOM-killed silently. At ~1 GB per child, runAll + server + two concurrent
// vitest workers stays comfortably under the 7 GB runner limit. If any
// individual vitest overruns this cap it exits with a clear `JavaScript heap
// out of memory` rather than SIGKILL (exit 137) that takes down siblings.
//
// Honours a caller-supplied NODE_OPTIONS by appending rather than overwriting.
// 2048 MB is generous enough for a warm tsx + vitest worker loading OTel
// auto-instrumentations and the full server module graph; 1024 MB was the
// former cap and caused V8 to force GC churn that slowed Phase 3 without
// bounding RSS (native modules like duckdb/pg/nodejs-polars live off-heap).
const EXISTING_NODE_OPTIONS = (process.env.NODE_OPTIONS ?? "").trim();
const CHILD_NODE_OPTIONS = EXISTING_NODE_OPTIONS.includes("--max-old-space-size")
  ? EXISTING_NODE_OPTIONS
  : `${EXISTING_NODE_OPTIONS} --max-old-space-size=2048`.trim();

const CHILD_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: "test",
  NODE_OPTIONS: CHILD_NODE_OPTIONS,
  // Signal to tests/globalSetup.ts that a healthy server on :3000 is already
  // under runAll's management; it must NOT kill-port, re-seed, re-bootstrap
  // Keycloak, or spawn a duplicate server. Phase 3 was OOM-killed because
  // every vitest call with the default config did all four again on top of
  // runAll's server. See globalSetup.ts:setup() for the reuse branch.
  TELLUS_REUSE_SERVER: "1",
  RATE_LIMIT_MAX: "10000",
  ACTION_RATE_LIMIT_MAX: "10000",
  USER_RATE_LIMIT_MAX: "50000",
  GLOBAL_ACTION_RATE_LIMIT_MAX: "100000",
  BATCH_RATE_LIMIT_MAX: "1000",
};

/**
 * Direct-grant a JWT for alice from the Keycloak test realm and install
 * it on CHILD_ENV.TELLUS_TEST_BEARER so subsequently-spawned day-suite
 * processes authenticate under F-01. Non-fatal: if Keycloak isn't up or
 * alice isn't bootstrapped, we print a loud warning and proceed without
 * a token — tests that hit auth'd routes will fail with a clean 401
 * rather than a mysterious stall.
 */
async function acquireAliceToken(): Promise<void> {
  const kcUrl = process.env.KEYCLOAK_URL || "http://localhost:8086";
  const kcRealm = process.env.KEYCLOAK_REALM || "tellus";
  const kcClient = process.env.KEYCLOAK_FRONTEND_CLIENT_ID || "tellus-frontend";
  const username =
    process.env.KEYCLOAK_ADMIN_TEST_USER || "cypress-admin@tellus.local";
  const password = process.env.KEYCLOAK_TEST_PASS || "Password123!";

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: kcClient,
    username,
    password,
    scope: "openid",
  });

  try {
    const res = await fetch(
      `${kcUrl}/realms/${kcRealm}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(
        `  [runAll] Direct-grant failed for ${username}: HTTP ${res.status} ${txt.slice(0, 180)} — day suites will 401 on data-plane routes`,
      );
      return;
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) {
      console.warn("  [runAll] Direct-grant response missing access_token — day suites will 401");
      return;
    }
    CHILD_ENV.TELLUS_TEST_BEARER = data.access_token;
    console.log(`  Alice JWT acquired (${data.access_token.length} chars) for child suites.`);
  } catch (err) {
    console.warn(
      `  [runAll] Keycloak unreachable at ${kcUrl} (${(err as Error).message}) — day suites will 401 on data-plane routes`,
    );
  }
}

function runCommand(
  command: string,
  label: string,
  timeoutMs: number = TIMEOUT_PER_SUITE
): SuiteResult {
  const start = Date.now();
  try {
    const output = execSync(command, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      env: CHILD_ENV,
      // Default is 1 MiB which vitest --reporter=verbose trivially overflows,
      // killing the child with ENOBUFS mid-run. 64 MiB is ample for every
      // suite we have today and bounded enough that the parent tsx process
      // does not balloon while buffering child output.
      maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;

    // Check output for failure indicators
    const hasFail =
      output.includes("FAIL") ||
      output.includes("failed") ||
      output.match(/\d+ failed/) !== null;
    const hasPassedLine = output.match(/(\d+)\s+passed/) !== null;
    const failMatch = output.match(/(\d+)\s+failed/);
    const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;

    return {
      name: label,
      category: "self-test",
      passed: failCount === 0,
      durationMs,
      output: output.trim(),
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const output = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? "";

    return {
      name: label,
      category: "self-test",
      passed: false,
      durationMs,
      output: output.trim(),
      error: stderr.trim() || err.message || "Unknown error",
    };
  }
}

function runSelfTest(mod: { name: string; file: string }): SuiteResult {
  const absolutePath = path.join(ROOT, mod.file);
  if (!fs.existsSync(absolutePath)) {
    return {
      name: mod.name,
      category: "self-test",
      passed: true,
      durationMs: 0,
      output: `SKIP: file not found: ${mod.file}`,
    };
  }

  return runCommand(`npx tsx "${absolutePath}"`, mod.name);
}

function runDaySuite(day: string): SuiteResult {
  const dayIndex = path.join(__dirname, day, "index.ts");
  if (!fs.existsSync(dayIndex)) {
    return {
      name: `${day} (day suite)`,
      category: "day",
      passed: true,
      durationMs: 0,
      output: `SKIP: ${dayIndex} not found`,
    };
  }

  const result = runCommand(`npx tsx "${dayIndex}"`, `${day} (day suite)`, 600_000);
  result.category = "day";
  return result;
}

/**
 * Pick the right vitest config for a test pattern.
 *
 * Unit patterns (`tests/<day>/unit`) must use vitest.unit.config.ts so that
 * vitest does NOT run tests/globalSetup.ts — which otherwise kills port 3000,
 * respawns seeds + Keycloak bootstrap + a duplicate server, and OOM-kills
 * the whole runner. Integration patterns genuinely need the full globalSetup
 * (server on :3000), so they fall through to the default vitest.config.ts;
 * `TELLUS_REUSE_SERVER=1` in CHILD_ENV tells that globalSetup to reuse the
 * server runAll already manages instead of respawning one.
 */
function isUnitPattern(pattern: string): boolean {
  return /(^|\/)unit(\/|$)/.test(pattern);
}

// Per-suite vitest timeout. 300 s was tight enough that friday's 42-test
// integration suite consistently SIGKILLed on GitHub Actions (2-core
// ubuntu-latest) before any test output reached stdout — see the
// "Duration  300036ms" signature. 600 s is still well inside the CI job's
// 30-minute cap and leaves headroom for tuesday (40 s local → 2× on CI).
const VITEST_SUITE_TIMEOUT_MS = 600_000;

function runVitestSuite(pattern: string, label: string): SuiteResult {
  const configFlag = isUnitPattern(pattern) ? " --config vitest.unit.config.ts" : "";
  const result = runCommand(
    `npx vitest run ${pattern}${configFlag} --reporter=verbose`,
    label,
    VITEST_SUITE_TIMEOUT_MS,
  );
  result.category = "vitest";
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runAll(): Promise<void> {
  const startTime = Date.now();

  console.log("#".repeat(60));
  console.log("  CONSOLIDATED TEST RUNNER");
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`  Flags: ${ARGS.join(" ") || "(none)"}`);
  console.log("#".repeat(60));

  const results: SuiteResult[] = [];

  // =========================================================================
  // Phase 1: Inline self-tests
  // =========================================================================
  console.log("\n" + "=".repeat(60));
  console.log("  PHASE 1: Inline Self-Tests");
  console.log("=".repeat(60));

  for (const mod of SELF_TEST_MODULES) {
    process.stdout.write(`  Running ${mod.name}... `);
    const result = runSelfTest(mod);
    results.push(result);

    const icon = result.passed ? "PASS" : result.output.startsWith("SKIP") ? "SKIP" : "FAIL";
    console.log(`[${icon}] (${result.durationMs}ms)`);

    if (!result.passed && result.error) {
      // Show first few lines of error
      const errorLines = result.error.split("\n").slice(0, 3);
      for (const line of errorLines) {
        console.log(`    ${line}`);
      }
    }
  }

  if (ONLY_UNIT) {
    printReport(results, startTime);
    return;
  }

  // =========================================================================
  // Start server for Phases 2-4 (elevated rate limits)
  // =========================================================================
  console.log("\n" + "=".repeat(60));
  console.log("  Starting server with elevated rate limits...");
  console.log("=".repeat(60));
  await startServer();
  await acquireAliceToken();

  // =========================================================================
  // Phase 2: Day test suites
  // =========================================================================
  console.log("\n" + "=".repeat(60));
  console.log("  PHASE 2: Day Test Suites");
  console.log("=".repeat(60));

  for (const day of DAY_SUITES) {
    process.stdout.write(`  Running ${day}... `);
    const result = runDaySuite(day);
    results.push(result);

    const icon = result.passed ? "PASS" : result.output.startsWith("SKIP") ? "SKIP" : "FAIL";
    console.log(`[${icon}] (${result.durationMs}ms)`);
  }

  // =========================================================================
  // Phase 3: Vitest suites
  //
  // Restart the server to reset rate limit counters accumulated in Phase 2.
  // The Tuesday rate-limiter test is excluded here — it deliberately
  // exhausts the per-action rate limit and requires a dedicated server
  // restart with default limits. It is fully covered by `test:integration`.
  // =========================================================================
  console.log("\n" + "=".repeat(60));
  console.log("  PHASE 3: Vitest Test Suites");
  console.log("=".repeat(60));

  await restartServer();
  // Refresh the JWT — Keycloak default access-token TTL is 5 minutes and
  // Phase 2 may have consumed most of it. Vitest has its own per-file
  // setupFiles.ts that re-acquires, but a refreshed CHILD_ENV also helps
  // any deeper child processes the vitest suites spawn.
  await acquireAliceToken();

  // Files to exclude from Tuesday integration (rate-limiter needs default limits)
  const TUESDAY_INTEGRATION_EXCLUDE = "rate-limiter-integration";

  const vitestDays = ["monday", "tuesday", "wednesday", "thursday", "friday"];
  for (const day of vitestDays) {
    const unitPath = `tests/${day}/unit`;
    const integrationPath = `tests/${day}/integration`;

    if (fs.existsSync(path.join(ROOT, "tests", day, "unit"))) {
      process.stdout.write(`  Running vitest ${day}/unit... `);
      const result = runVitestSuite(unitPath, `vitest:${day}:unit`);
      results.push(result);
      const icon = result.passed ? "PASS" : "FAIL";
      console.log(`[${icon}] (${result.durationMs}ms)`);
    }

    if (fs.existsSync(path.join(ROOT, "tests", day, "integration"))) {
      if (day === "tuesday") {
        // Run Tuesday integration tests individually, excluding rate-limiter
        const integrationDir = path.join(ROOT, "tests", day, "integration");
        const testFiles = fs.readdirSync(integrationDir)
          .filter((f) => f.endsWith(".test.ts") && !f.includes(TUESDAY_INTEGRATION_EXCLUDE));

        const filePaths = testFiles
          .map((f) => path.join(integrationDir, f))
          .join(" ");

        process.stdout.write(`  Running vitest ${day}/integration (excl. rate-limiter)... `);
        const result = runCommand(
          `npx vitest run ${filePaths} --reporter=verbose`,
          `vitest:${day}:integration`,
          VITEST_SUITE_TIMEOUT_MS
        );
        result.category = "vitest";
        results.push(result);
        const icon = result.passed ? "PASS" : "FAIL";
        console.log(`[${icon}] (${result.durationMs}ms)`);
      } else {
        process.stdout.write(`  Running vitest ${day}/integration... `);
        const result = runVitestSuite(integrationPath, `vitest:${day}:integration`);
        results.push(result);
        const icon = result.passed ? "PASS" : "FAIL";
        console.log(`[${icon}] (${result.durationMs}ms)`);
      }
    }
  }

  // =========================================================================
  // Phase 4: Performance benchmarks (optional)
  //
  // Restart the server to reset rate limit counters before benchmarks.
  // =========================================================================
  if (!SKIP_PERF) {
    console.log("\n" + "=".repeat(60));
    console.log("  PHASE 4: Performance Benchmarks");
    console.log("=".repeat(60));

    await restartServer();

    process.stdout.write("  Running benchmarks... ");
    const benchPath = path.join(__dirname, "performance", "benchmark.ts");
    if (fs.existsSync(benchPath)) {
      const result = runCommand(`npx tsx "${benchPath}"`, "Performance Benchmarks", 300_000);
      result.category = "benchmark";
      results.push(result);
      const icon = result.passed ? "PASS" : "FAIL";
      console.log(`[${icon}] (${result.durationMs}ms)`);
    } else {
      console.log("[SKIP] benchmark.ts not found");
    }

    const sundayBenchPath = path.join(__dirname, "performance", "sundayBenchmark.ts");
    if (fs.existsSync(sundayBenchPath)) {
      process.stdout.write("  Running Sunday benchmarks... ");
      const result = runCommand(`npx tsx "${sundayBenchPath}"`, "Sunday Performance Benchmarks", 300_000);
      result.category = "benchmark";
      results.push(result);
      const icon = result.passed ? "PASS" : "FAIL";
      console.log(`[${icon}] (${result.durationMs}ms)`);
    }
  }

  // =========================================================================
  // Stop server
  // =========================================================================
  stopServer();

  // =========================================================================
  // Report
  // =========================================================================
  printReport(results, startTime);
}

function printReport(results: SuiteResult[], startTime: number): void {
  const totalDuration = Date.now() - startTime;

  console.log("\n" + "#".repeat(60));
  console.log("  CONSOLIDATED TEST REPORT");
  console.log("#".repeat(60));

  // Group by category
  const categories = ["self-test", "day", "vitest", "benchmark"];
  const categoryLabels: Record<string, string> = {
    "self-test": "Inline Self-Tests",
    day: "Day Test Suites",
    vitest: "Vitest Suites",
    benchmark: "Performance Benchmarks",
  };

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length === 0) continue;

    const catPassed = catResults.filter((r) => r.passed && !r.output.startsWith("SKIP")).length;
    const catFailed = catResults.filter((r) => !r.passed && !r.output.startsWith("SKIP")).length;
    const catSkipped = catResults.filter((r) => r.output.startsWith("SKIP")).length;

    console.log(`\n  ${categoryLabels[cat] || cat}:`);
    console.log(`    Passed: ${catPassed}  Failed: ${catFailed}  Skipped: ${catSkipped}`);

    totalPassed += catPassed;
    totalFailed += catFailed;
    totalSkipped += catSkipped;

    // Show failed suites — dump captured stdout/stderr so CI logs contain
    // the actual vitest/tsx failure output instead of just the first stderr
    // line (which is almost always a harmless `npm warn Unknown env config`
    // and tells you nothing about the real failure).
    for (const r of catResults.filter((r) => !r.passed && !r.output.startsWith("SKIP"))) {
      console.log(`    FAIL: ${r.name}`);
      if (r.output) {
        const tail = r.output.split("\n").slice(-80).join("\n");
        console.log("    ----- captured stdout (last 80 lines) -----");
        for (const line of tail.split("\n")) console.log(`      ${line}`);
        console.log("    ----- end stdout -----");
      }
      if (r.error) {
        const tail = r.error.split("\n").slice(-40).join("\n");
        console.log("    ----- captured stderr (last 40 lines) -----");
        for (const line of tail.split("\n")) console.log(`      ${line}`);
        console.log("    ----- end stderr -----");
      }
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log(`  Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
  console.log(`  Duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log("-".repeat(60));

  if (totalFailed === 0) {
    console.log("\n  ALL TESTS PASSED\n");
  } else {
    console.log(`\n  ${totalFailed} SUITE(S) FAILED\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Ensure server is stopped on any exit
  process.on("exit", () => stopServer());
  process.on("SIGINT", () => { stopServer(); process.exit(1); });
  process.on("SIGTERM", () => { stopServer(); process.exit(1); });

  runAll().catch((err) => {
    console.error("Test runner crashed:", err);
    stopServer();
    process.exit(1);
  });
}

export { runAll };
