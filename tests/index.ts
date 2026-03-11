// ---------------------------------------------------------------------------
// Top-Level Test Runner — Runs All Days
//
// Discovers and runs test suites for each day in sequence.
// To add a new day, add an entry to the `days` array below.
//
// Run: npm test              # all days (unit + integration)
//      npm run test:all      # all days (unit + integration + e2e)
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Day registry — add new days here
// ---------------------------------------------------------------------------

const days: string[] = [
  "monday",
  "tuesday",
  // "wednesday",
  // "thursday",
  // "friday",
];

let exitCode = 0;

for (const day of days) {
  const dayIndex = path.join(__dirname, day, "index.ts");

  console.log("\n" + "#".repeat(60));
  console.log(`  ${day.toUpperCase()}`);
  console.log("#".repeat(60));

  try {
    execSync(`npx tsx "${dayIndex}"`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 600000, // 10 min per day
      stdio: "inherit",
    });
  } catch {
    exitCode = 1;
  }
}

console.log("\n" + "#".repeat(60));
console.log(exitCode === 0 ? "  ALL DAYS PASSED" : "  SOME DAYS FAILED");
console.log("#".repeat(60) + "\n");

process.exit(exitCode);
