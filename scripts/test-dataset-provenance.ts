// ---------------------------------------------------------------------------
// Integration test for dataset provenance ("Updated via").
//
// Exercises the REAL `resolveDataset` against the live dev DB and asserts the
// derived `provenance` is correct for each origin shape:
//   - data-connection : an Iceberg dataset with a table-import producer
//   - file-import      : an uploaded CSV (foundry_datasets, no producer)
//   - manual           : a Create-Dataset-API row (resources DATASET, no data)
//
// RIDs are discovered from the DB (not hardcoded) so the test stays valid as
// data changes. Exit non-zero on any failed assertion so it can gate CI.
//
//   npx tsx scripts/test-dataset-provenance.ts
// ---------------------------------------------------------------------------
import { resolveDataset } from "../src/services/datasets/dataset-resolver";
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

async function pickSyncDatasetRid(): Promise<string | null> {
  const { rows } = await pool.query<{ dataset_rid: string }>(
    `SELECT ti.dataset_rid
       FROM table_imports ti
       JOIN foundry_datasets fd ON fd.id::text = split_part(ti.dataset_rid, '.', 5)
      WHERE ti.deleted_at IS NULL AND fd.file_path LIKE 'iceberg://%'
      ORDER BY ti.created_at DESC LIMIT 1`,
  );
  return rows[0]?.dataset_rid ?? null;
}

async function pickUploadDatasetId(): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT fd.id::text AS id
       FROM foundry_datasets fd
      WHERE (fd.file_path NOT LIKE 'iceberg://%' OR fd.file_path IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM table_imports ti
           WHERE ti.dataset_rid = $1 || fd.id::text AND ti.deleted_at IS NULL)
      ORDER BY fd.created_at DESC LIMIT 1`,
    [DATASET_PREFIX],
  );
  return rows[0]?.id ?? null;
}

async function pickManualDatasetRid(): Promise<string | null> {
  // A Create-Dataset-API resource with neither a producer nor a registry row.
  const { rows } = await pool.query<{ rid: string }>(
    `SELECT r.rid
       FROM resources r
      WHERE r.type = 'DATASET' AND r.trash_status = 'NOT_TRASHED'
        AND NOT EXISTS (SELECT 1 FROM foundry_datasets fd
                         WHERE fd.id::text = split_part(r.rid, '.', 5))
        AND NOT EXISTS (SELECT 1 FROM table_imports ti
                         WHERE ti.dataset_rid = r.rid AND ti.deleted_at IS NULL)
      LIMIT 1`,
  );
  return rows[0]?.rid ?? null;
}

async function main() {
  // --- data-connection (sync) ---------------------------------------------
  const syncRid = await pickSyncDatasetRid();
  if (syncRid) {
    console.log(`\n[data-connection] ${syncRid}`);
    const r = await resolveDataset(syncRid);
    assert(r !== null, "sync dataset resolves");
    assert(r!.provenance.kind === "data-connection", `provenance.kind = data-connection (got ${r!.provenance.kind})`);
    if (r!.provenance.kind === "data-connection") {
      assert(r!.provenance.sourceRid.startsWith("ri.magritte.main.source."), `sourceRid is a source RID (${r!.provenance.sourceRid})`);
      assert(typeof r!.provenance.label === "string" && r!.provenance.label.startsWith("Data connection"), `label starts with "Data connection" (${r!.provenance.label})`);
      assert(r!.provenance.importRid.length > 0, "importRid is populated");
    }
  } else {
    console.log("\n[data-connection] (no sync dataset in DB — skipped)");
  }

  // --- file-import (upload) ------------------------------------------------
  const uploadId = await pickUploadDatasetId();
  if (uploadId) {
    const uploadRid = DATASET_PREFIX + uploadId;
    console.log(`\n[file-import] ${uploadRid}`);
    const r = await resolveDataset(uploadRid);
    assert(r !== null, "uploaded CSV now resolves (was 404 before the fix)");
    assert(r!.producer === null, "upload has no sync producer");
    assert(r!.registry !== null, "upload has a foundry_datasets registry row");
    assert(r!.provenance.kind === "file-import", `provenance.kind = file-import (got ${r!.provenance.kind})`);
    if (r!.provenance.kind === "file-import") {
      assert(r!.provenance.label === "Manual upload", `label = "Manual upload" (${r!.provenance.label})`);
    }
    assert(r!.provenance.kind !== "data-connection", "upload is NOT mislabelled as a data connection");
  } else {
    console.log("\n[file-import] (no uploaded dataset in DB — skipped)");
  }

  // --- pipeline output (deploy-written object, not a manual upload) --------
  const pipeRow = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM foundry_datasets
      WHERE file_path LIKE '%/pipeline-outputs/%' LIMIT 1`,
  );
  if (pipeRow.rows[0]) {
    const pipeRid = DATASET_PREFIX + pipeRow.rows[0].id;
    console.log(`\n[pipeline] ${pipeRid}`);
    const r = await resolveDataset(pipeRid);
    assert(r !== null, "pipeline-output dataset resolves");
    assert(r!.provenance.kind === "pipeline", `provenance.kind = pipeline (got ${r!.provenance.kind})`);
    assert(r!.provenance.kind !== "file-import", "pipeline output is NOT mislabelled as a manual upload (the bug the test caught)");
    if (r!.provenance.kind === "pipeline") {
      assert(
        r!.provenance.pipelineRid === null || r!.provenance.pipelineRid.startsWith("ri.foundry.main.pipeline."),
        `pipelineRid is well-formed or null (${r!.provenance.pipelineRid})`,
      );
    }
  } else {
    console.log("\n[pipeline] (no pipeline-output dataset in DB — skipped)");
  }

  // --- manual (Create Dataset API, no data) --------------------------------
  const manualRid = await pickManualDatasetRid();
  if (manualRid) {
    console.log(`\n[manual] ${manualRid}`);
    const r = await resolveDataset(manualRid);
    assert(r !== null, "manual dataset resolves (identity only)");
    assert(r!.producer === null && r!.registry === null, "manual dataset has neither producer nor registry");
    assert(r!.provenance.kind === "manual", `provenance.kind = manual (got ${r!.provenance.kind})`);
    assert(r!.provenance.kind !== "data-connection", "manual dataset is NOT mislabelled as a data connection (the bug)");
  } else {
    console.log("\n[manual] (no producerless DATASET resource in DB — skipped)");
  }

  // --- unknown RID still 404s ----------------------------------------------
  const bogus = await resolveDataset(DATASET_PREFIX + "00000000-0000-0000-0000-000000000000");
  assert(bogus === null, "unknown dataset RID resolves to null (→ DatasetNotFound)");

  console.log(`\nAll assertions passed.\n`);
}

main()
  .catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => {}); });
