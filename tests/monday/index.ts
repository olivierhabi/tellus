// ---------------------------------------------------------------------------
// Monday Test Runner — All Monday Tasks (1-30)
//
// Runs both unit and integration test suites for Monday's deliverables.
// The E2E bash tests are run separately via `npm run test:monday:e2e`.
//
// Run: npm run test:monday           # unit + integration
//      npm run test:monday:unit      # unit only
//      npm run test:monday:integration  # integration only
//      npm run test:monday:e2e       # bash E2E only
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

let exitCode = 0;

// --- Unit tests ---
console.log("=".repeat(60));
console.log("  MONDAY — Unit Tests");
console.log("=".repeat(60));

try {
  execSync(`npx tsx "${path.join(__dirname, "unit/index.ts")}"`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60000,
    stdio: "inherit",
  });
} catch {
  exitCode = 1;
}

// --- Integration tests ---
console.log("=".repeat(60));
console.log("  MONDAY — Integration Tests");
console.log("=".repeat(60));

try {
  execSync(`npx tsx "${path.join(__dirname, "integration/index.ts")}"`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120000,
    stdio: "inherit",
  });
} catch {
  exitCode = 1;
}

process.exit(exitCode);
