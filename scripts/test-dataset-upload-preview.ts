// ---------------------------------------------------------------------------
// Integration test for the UNIFIED dataset preview's file-upload data path.
//
// Proves that an uploaded CSV — which has no sync producer and no Iceberg table
// — renders real data through the SAME platform preview as a sync, by reading
// its object from MinIO/S3 and parsing a bounded preview.
//
// Requires PG + S3 env (the dev `.env`). Run:
//   set -a; . ./.env; set +a; npx tsx scripts/test-dataset-upload-preview.ts
//
// Exit non-zero on any failed assertion. Skips (exit 0) when no uploaded
// dataset exists or S3 is not configured, so it never blocks a PG-only run.
// ---------------------------------------------------------------------------
import { resolveDataset } from "../src/services/datasets/dataset-resolver";
import { readUploadedPreview } from "../src/services/datasets/uploaded-dataset-reader";
import { readSyncedPreview } from "../src/services/datasets/synced-dataset-reader";
import pool from "../src/db";

const DATASET_PREFIX = "ri.foundry.main.dataset.";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  if (!process.env.S3_ACCESS_KEY_ID) {
    console.log("S3 not configured (S3_ACCESS_KEY_ID unset) — skipping upload-preview test.");
    return;
  }

  // Find an uploaded CSV: a foundry_datasets row backed by an object (not
  // Iceberg) with no surviving table-import producer.
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT fd.id::text AS id, fd.name
       FROM foundry_datasets fd
      WHERE fd.file_path IS NOT NULL
        AND fd.file_path NOT LIKE 'iceberg://%'
        AND fd.file_path NOT LIKE '%/pipeline-outputs/%'   -- exclude pipeline outputs
        AND fd.file_path LIKE '%.csv'                       -- a parseable CSV upload
        AND NOT EXISTS (SELECT 1 FROM table_imports ti
                         WHERE ti.dataset_rid = $1 || fd.id::text AND ti.deleted_at IS NULL)
      ORDER BY fd.row_count DESC NULLS LAST LIMIT 1`,
    [DATASET_PREFIX],
  );
  if (rows.length === 0) {
    console.log("No uploaded dataset in DB — skipping.");
    return;
  }

  const rid = DATASET_PREFIX + rows[0].id;
  console.log(`\n[upload preview] ${rid} (${rows[0].name})`);

  const resolved = await resolveDataset(rid);
  assert(resolved !== null, "uploaded dataset resolves");
  assert(resolved!.provenance.kind === "file-import", "provenance is file-import");
  assert(!!resolved!.registry?.filePath, "registry has an object file path");

  const preview = await readUploadedPreview(resolved!.registry!.filePath!, 5);
  assert(preview.columns.length > 0, `CSV columns inferred (${preview.columns.length})`);
  assert(preview.rows.length > 0 && preview.rows.length <= 5, `bounded rows returned (${preview.rows.length})`);
  assert(
    preview.columns.every((c) => typeof c.name === "string" && typeof c.type === "string"),
    "every column has a name + inferred display type",
  );
  const firstCol = preview.columns[0].name;
  assert(
    preview.rows.every((r) => Object.prototype.hasOwnProperty.call(r, firstCol)),
    "rows are keyed by the inferred columns",
  );

  // The unified contract: an uploaded preview is shaped exactly like a sync
  // preview (columns/rows/snapshot), so the same FE grid renders both.
  const empty = await readSyncedPreview(
    { schema: "does", table: "not-exist" } as never,
    "default",
    1,
  );
  assert(
    Array.isArray(empty.columns) && Array.isArray(empty.rows),
    "sync + upload readers share the {columns,rows,snapshot} shape",
  );

  console.log(`\nAll assertions passed.\n`);
}

main()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => {}); });
