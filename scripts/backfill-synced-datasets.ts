// scripts/backfill-synced-datasets.ts
// One-off backfill: register a Compass-visible foundry_datasets row for every
// existing table-import whose output dataset was never registered (so prior
// syncs appear in their project/folder + open the Dataset Preview). Idempotent.
//
// Usage: npx tsx scripts/backfill-synced-datasets.ts [--dry-run]
import "dotenv/config";
import { pool } from "../src/db";
import { registerSyncedDataset } from "../src/services/datasets/synced-dataset-registry";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { rows } = await pool.query<{
    import_rid: string;
    dataset_rid: string;
    display_name: string;
    config: { schema: string; table: string; targetTable?: string; warehouseRoot?: string };
    status: { state?: string } | null;
    compass_folder_rid: string | null;
    tenant: string | null;
    rows_written: string | number | null;
  }>(
    `SELECT ti.rid AS import_rid, ti.dataset_rid, ti.display_name, ti.config, ti.status,
            c.compass_folder_rid, c.tenant,
            (SELECT b.rows_written FROM orchestration_builds b
              WHERE b.import_rid = ti.rid AND b.status = 'succeeded'
              ORDER BY b.ended_at DESC NULLS LAST LIMIT 1) AS rows_written
       FROM table_imports ti
       LEFT JOIN connectivity_connections c ON c.rid = ti.connection_rid
      WHERE ti.deleted_at IS NULL
      ORDER BY ti.created_at`,
  );

  let registered = 0, skipped = 0;
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    if (dryRun) {
      console.log(`would register ${r.dataset_rid} (${r.display_name}) folder=${r.compass_folder_rid}`);
      continue;
    }
    const res = await registerSyncedDataset({
      datasetRid: r.dataset_rid,
      name: r.display_name,
      compassFolderRid: r.compass_folder_rid,
      schema: r.config?.schema,
      table: r.config?.targetTable ?? r.config?.table,
      warehouse: r.config?.warehouseRoot ?? r.tenant ?? "default",
      status: r.status?.state,
      rowCount: r.rows_written != null ? Number(r.rows_written) : null,
    });
    if (res.ok) registered++;
    else { skipped++; reasons[res.reason ?? "unknown"] = (reasons[res.reason ?? "unknown"] ?? 0) + 1; }
  }

  console.log(JSON.stringify({ total: rows.length, registered, skipped, skipReasons: reasons }, null, 2));
  await pool.end();
}

main().catch((e) => { console.error("backfill failed:", e); process.exit(1); });
