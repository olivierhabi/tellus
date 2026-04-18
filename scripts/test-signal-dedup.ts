// Verify sendSignal's fingerprint-based idempotency: two calls with
// the same (object_type, fingerprint) must produce ONE signal row and
// return the same signal_id. Without this, a flaky client retry would
// enqueue duplicate saves that then race through the pipeline.
import "dotenv/config";
import { query } from "../src/db";
import { sendSignal } from "../src/services/funnel/durableWorkflow";

const OT = `DedupTestOT_${process.pid}_${Date.now()}`;
const FP = `test-fp-${Date.now()}`;

(async () => {
  // Ensure migration 015 is applied. If `signal_fingerprint` doesn't
  // exist, run the SQL inline — same pattern the B9 test uses.
  try {
    const fs = await import("fs");
    const sql = fs.readFileSync(
      new URL("../src/migrations/015_funnel_signal_idempotency.sql", import.meta.url),
      "utf8"
    );
    await query(sql);
  } catch (err) {
    process.stderr.write(`migration apply failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const first = await sendSignal({
    ontologyId: "00000000-0000-0000-0000-000000000001",
    objectTypeApiName: OT,
    signalType: "sourceTransactionCommitted",
    fingerprint: FP,
  });
  const second = await sendSignal({
    ontologyId: "00000000-0000-0000-0000-000000000001",
    objectTypeApiName: OT,
    signalType: "sourceTransactionCommitted",
    fingerprint: FP,
  });

  const count = await query(
    `SELECT COUNT(*)::int AS c FROM funnel_signal WHERE object_type_api_name = $1`,
    [OT]
  );
  const rows = count.rows[0]?.c ?? 0;

  const report = {
    firstSignalId: first,
    secondSignalId: second,
    sameId: first === second,
    rowCount: rows,
  };
  console.log(JSON.stringify(report, null, 2));

  // Cleanup
  await query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]);

  const pass = report.sameId && report.rowCount === 1;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`CRASH: ${err?.stack ?? err}\n`);
  process.exit(2);
});
