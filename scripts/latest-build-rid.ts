// Prints the most recent build RID (joined to a live import) to stdout, or
// nothing if there are no builds. Used by scripts/test-build-sse.sh to target a
// real build without hardcoding an id that goes stale as the dev DB churns.
//   npx tsx scripts/latest-build-rid.ts
import pool from "../src/db";

async function main(): Promise<void> {
  const r = await pool.query<{ rid: string }>(
    `SELECT b.rid
       FROM orchestration_builds b
       JOIN table_imports ti ON ti.rid = b.import_rid
      ORDER BY b.enqueued_at DESC
      LIMIT 1`,
  );
  process.stdout.write(r.rows[0]?.rid ?? "");
}

main()
  .catch(() => process.exit(1))
  .finally(async () => {
    await pool.end().catch(() => {});
  });
