// Exercise replacementScheduler.tick() five times in a row against a DB
// where object_instances is missing. Pre-fix: every tick emits a PG
// error + "auto-trigger scan failed" warning. Post-fix: the first tick
// runs the existence probe silently, caches "missing", and all ticks
// return without touching object_instances or logging.
import "dotenv/config";
import { tick } from "../src/services/funnel/replacementScheduler";
import { query } from "../src/db";

const origWarn = console.warn;
const origError = console.error;
const warnings: string[] = [];
const errors: string[] = [];
console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));

(async () => {
  // Simulate a transitional deployment — drop object_instances so the
  // auto-trigger's join can't run. Safe: tests already expect a
  // disposable local DB.
  await query("DROP TABLE IF EXISTS object_instances CASCADE").catch(() => {});

  const results: Array<{ tick: number; autoTriggered: number }> = [];
  for (let i = 1; i <= 5; i++) {
    const r = await tick();
    results.push({ tick: i, autoTriggered: r.autoTriggered });
  }

  console.warn = origWarn;
  console.error = origError;

  const autoTriggerWarnings = warnings.filter((w) =>
    /auto-trigger scan failed/.test(w)
  );
  const pgRelationErrors = errors.filter((e) =>
    /relation .object_instances. does not exist/.test(e)
  );

  console.log(JSON.stringify({
    ticks: results,
    totalWarnings: warnings.length,
    autoTriggerScanFailedWarnings: autoTriggerWarnings.length,
    pgRelationErrors: pgRelationErrors.length,
    samplePgError: pgRelationErrors[0] ?? null,
    sampleWarning: autoTriggerWarnings[0] ?? null,
  }, null, 2));

  // Restore object_instances so subsequent tests / dev server aren't
  // left in the transitional state we simulated. 012 alone restores the
  // PRE-branch shape (PK without branch_id); 041 re-adds the branch
  // segment. 041 is idempotent, so this is safe whether or not the table
  // was really dropped — skipping 041 would silently regress the schema
  // because 041 is already recorded in the migration ledger.
  const fs = await import("fs");
  const read = (name: string) =>
    fs.readFileSync(new URL(`../src/migrations/${name}`, import.meta.url), "utf8");
  await query(read("012_funnel_object_edits.sql")).catch(() => {});
  await query(read("041_object_instances_branch_pk.sql")).catch(() => {});

  process.exit(autoTriggerWarnings.length === 0 ? 0 : 1);
})().catch((err) => {
  console.warn = origWarn;
  console.error = origError;
  process.stderr.write(`TEST HARNESS CRASHED: ${err?.stack ?? err}\n`);
  process.exit(2);
});
