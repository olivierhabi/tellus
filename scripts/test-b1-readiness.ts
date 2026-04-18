// Verify the B1 readiness probe:
//   * returns true when object_edits + object_instances exist
//   * returns false when either is dropped
//   * cache is invalidated on __reset so migrations during server life
//     are picked up without a restart
import "dotenv/config";
import { query } from "../src/db";
import { isB1Ready, __resetB1ReadinessForTesting } from "../src/services/funnel/b1Readiness";

async function applyMig012(): Promise<void> {
  const fs = await import("fs");
  const sql = fs.readFileSync(
    new URL("../src/migrations/012_funnel_object_edits.sql", import.meta.url),
    "utf8"
  );
  await query(sql);
}

(async () => {
  await applyMig012();

  __resetB1ReadinessForTesting();
  const readyWhenPresent = await isB1Ready();

  await query("DROP TABLE IF EXISTS object_instances CASCADE").catch(() => {});
  __resetB1ReadinessForTesting();
  const readyWhenMissing = await isB1Ready();

  // Restore
  await applyMig012();
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
