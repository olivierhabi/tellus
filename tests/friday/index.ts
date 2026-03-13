// ---------------------------------------------------------------------------
// Friday Test Runner — All Friday Tasks (16-30)
//
// Runs both unit and integration test suites for Friday's deliverables.
//
// Run: npm run test:friday              # unit + integration
//      npm run test:friday:unit         # unit only
//      npm run test:friday:integration  # integration only
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

let exitCode = 0;

// --- Unit tests ---
console.log("=".repeat(60));
console.log("  FRIDAY — Unit Tests");
console.log("=".repeat(60));

try {
  execSync(`npx tsx "${path.join(__dirname, "unit/index.ts")}"`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 300000, // 5 min
    stdio: "inherit",
  });
} catch {
  exitCode = 1;
}

// --- Integration tests ---
console.log("\n" + "=".repeat(60));
console.log("  FRIDAY — Integration Tests");
console.log("=".repeat(60));

try {
  execSync(`npx tsx "${path.join(__dirname, "integration/index.ts")}"`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 300000, // 5 min
    stdio: "inherit",
  });
} catch {
  exitCode = 1;
}

process.exit(exitCode);
