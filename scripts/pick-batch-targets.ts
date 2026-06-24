// Prints a connection rid + two existing import rids on it (newest first), for
// the live execute-batch HTTP test. Re-running existing imports is a valid batch
// (they built before, so the new group build should succeed).
import pool from "../src/db";

(async () => {
  const latest = await pool.query<{ connection_rid: string }>(
    `SELECT connection_rid FROM orchestration_builds ORDER BY enqueued_at DESC LIMIT 1`,
  );
  if (latest.rowCount === 0) {
    console.log("NONE");
    return;
  }
  const conn = latest.rows[0].connection_rid;
  const imps = await pool.query<{ rid: string }>(
    `SELECT rid FROM table_imports
      WHERE connection_rid=$1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 2`,
    [conn],
  );
  console.log("CONN=" + conn);
  for (const r of imps.rows) console.log("IMP=" + r.rid);
})()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
