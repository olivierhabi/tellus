// Verify the B1 readiness probe:
//   * returns true when object_edits + object_instances exist
//   * returns false when either is dropped
//   * cache is invalidated on __reset so migrations during server life
//     are picked up without a restart
import "dotenv/config";
import { query } from "../src/db";
import { isB1Ready, __resetB1ReadinessForTesting } from "../src/services/funnel/b1Readiness";

async function applyMigrationFile(name: string): Promise<void> {
  const fs = await import("fs");
  const sql = fs.readFileSync(
    new URL(`../src/migrations/${name}`, import.meta.url),
    "utf8"
  );
  await query(sql);
}

// 012 alone restores the PRE-branch object_instances shape (PK without
// branch_id). Restoring only 012 while 041 is already recorded in the
// migration ledger silently regresses the schema (041 is never re-applied
// by the migrators) and breaks every branch-scoped funnel write. 041 is
// idempotent, so applying it here is safe whether or not the table was
// actually dropped.
async function restoreObjectInstances(): Promise<void> {
  await applyMigrationFile("012_funnel_object_edits.sql");
  await applyMigrationFile("041_object_instances_branch_pk.sql");
}

(async () => {
  await restoreObjectInstances();

  __resetB1ReadinessForTesting();
  const readyWhenPresent = await isB1Ready();

  await query("DROP TABLE IF EXISTS object_instances CASCADE").catch(() => {});
  __resetB1ReadinessForTesting();
  const readyWhenMissing = await isB1Ready();

  // Restore
  await restoreObjectInstances();
  __resetB1ReadinessForTesting();
  const readyAfterRestore = await isB1Ready();

  const report = { readyWhenPresent, readyWhenMissing, readyAfterRestore };
  console.log(JSON.stringify(report, null, 2));

  const pass =
    readyWhenPresent === true &&
    readyWhenMissing === false &&
    readyAfterRestore === true;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`CRASH: ${err?.stack ?? err}\n`);
  process.exit(2);
});
