import "dotenv/config";
import { pool } from "../db";
import { runFunctionKindBackfill } from "../services/functionsRegistry/backfillFunctionKind";

// ---------------------------------------------------------------------------
// backfillFunctionKind CLI — see services/functionsRegistry/
// backfillFunctionKind.ts for the classification contract. The CLI is a
// thin wrapper so the backfill logic is directly testable.
//
//   npx tsx src/scripts/backfillFunctionKind.ts           # dry-run (default)
//   npx tsx src/scripts/backfillFunctionKind.ts --apply   # write
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const report = await runFunctionKindBackfill(pool, { apply });

  console.log(`[backfill-function-kind] mode=${report.mode}`);
  console.log(`[backfill-function-kind] already classified (skipped): ${report.alreadyClassified}`);
  console.log(`[backfill-function-kind] NULL candidates: ${report.candidates}`);
  if (!apply) {
    for (const outcome of report.outcomes) {
      console.log(
        `  would set ${outcome.kind.padEnd(7)} ${outcome.identity}${outcome.reason ? ` — ${outcome.reason}` : ""}`,
      );
    }
  }
  for (const outcome of report.outcomes) {
    if (apply && !outcome.applied && outcome.updateError === null) {
      console.log(`  skipped (already classified concurrently): ${outcome.identity}`);
    }
  }

  const { counts } = report;
  console.log(
    `[backfill-function-kind] result: edit=${counts.edit} query=${counts.query} unknown=${counts.unknown} skipped=${report.alreadyClassified + counts.skippedConcurrent} failed=${counts.failed}`,
  );
  const unknowns = report.outcomes.filter((outcome) => outcome.kind === "unknown");
  if (unknowns.length > 0) {
    console.log(`[backfill-function-kind] rows classified 'unknown' (fail-closed — NOT edit-capable):`);
    for (const outcome of unknowns) console.log(`    ${outcome.identity} — ${outcome.reason}`);
  }
  const failed = report.outcomes.filter((outcome) => outcome.updateError !== null);
  if (failed.length > 0) {
    console.log(`[backfill-function-kind] rows remaining NULL (update failed):`);
    for (const outcome of failed) console.log(`    ${outcome.identity} — ${outcome.updateError}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("[backfill-function-kind] fatal:", error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
