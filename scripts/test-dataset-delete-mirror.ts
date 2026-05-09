// scripts/test-dataset-delete-mirror.ts
//
// Live integration test for the dataset delete → trash → restore flow.
// Exercises:
//   1. Seed a probe dataset row in foundry_datasets (+ columns + versions)
//   2. Call DatasetService.deleteDataset(id, actorId) → must mirror to
//      resources.trash_status='DIRECTLY_TRASHED' AND hard-delete the source
//   3. Replay the projectWorkspace.ts restore handler logic against the
//      mirror → must re-create the source row + clear trash flags on the
//      resources row, with metadata.snapshot key removed
//   4. Cleanup
//
// Each step prints PASS/FAIL with the assertion that drove it. Exits 0
// only when all four steps pass — used by scripts/verify-dataset-delete-mirror.sh
// to gate the route's correctness end-to-end without standing up a browser.
//
// Production-faithful: this hits the same DatasetService method the live
// /v1/datasets/<id> DELETE handler calls, so a green run here implies the
// HTTP path is correct (modulo auth + transport, which the bash gate
// covers separately via curl).
import knexLib from "/Users/olivierhabimana/Desktop/projects/tellus/node_modules/knex";
import { Pool } from "/Users/olivierhabimana/Desktop/projects/tellus/node_modules/pg";
import { DatasetService } from "/Users/olivierhabimana/Desktop/projects/tellus/src/services/datasetService";

const PROBE_ID = "ffffffff-1234-1234-1234-aaaaaaaaaaaa";
const PROBE_NAME = "test-dataset-delete-mirror.csv";
const PROJECT_ID = "36271681-65d7-4c55-a6d0-20137f8212dc";

const knex = knexLib({
  client: "pg",
  connection: {
    host: "localhost",
    port: 5432,
    user: "tellus",
    password: "tellus123",
    database: "tellus_db",
  },
});

const pool = new Pool({
  host: "localhost",
  port: 5432,
  user: "tellus",
  password: "tellus123",
  database: "tellus_db",
});

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.log(`  FAIL: ${msg}`);
    failures++;
  }
}

async function cleanup(): Promise<void> {
  await knex.raw("DELETE FROM dataset_columns WHERE dataset_id = ?", [PROBE_ID]).catch(() => {});
  await knex.raw("DELETE FROM dataset_versions WHERE dataset_id = ?", [PROBE_ID]).catch(() => {});
  await knex.raw("DELETE FROM foundry_datasets WHERE id = ?", [PROBE_ID]).catch(() => {});
  await knex.raw("DELETE FROM resources WHERE legacy_uuid = ?", [PROBE_ID]).catch(() => {});
}

async function main(): Promise<void> {
  console.log("=== test-dataset-delete-mirror ===");
  await cleanup();

  const actorId = (await knex("users").select("id").first()).id;
  console.log(`actor = ${actorId}`);

  // STEP 1: seed
  console.log("\n[step 1] seed probe dataset");
  await knex("foundry_datasets").insert({
    id: PROBE_ID,
    name: PROBE_NAME,
    project_id: PROJECT_ID,
    file_path: "/tmp/probe.csv",
    original_filename: "probe.csv",
    status: "ready",
    format: "csv",
    content_hash: "sha256:probe",
    file_size_bytes: 2048,
    row_count: 50,
    column_count: 3,
    created_by: actorId,
    updated_by: actorId,
  });
  await knex("dataset_columns").insert([
    { dataset_id: PROBE_ID, column_name: "a", column_type: "string", ordinal_position: 0, nullable: false, sample_values: JSON.stringify([]) },
    { dataset_id: PROBE_ID, column_name: "b", column_type: "integer", ordinal_position: 1, nullable: true, sample_values: JSON.stringify([]) },
    { dataset_id: PROBE_ID, column_name: "c", column_type: "string", ordinal_position: 2, nullable: true, sample_values: JSON.stringify([]) },
  ]);
  const seeded = await knex("foundry_datasets").where({ id: PROBE_ID }).first();
  assert(seeded?.name === PROBE_NAME, "dataset row seeded");
  const seededCols = await knex("dataset_columns").where({ dataset_id: PROBE_ID });
  assert(seededCols.length === 3, "3 columns seeded");

  // STEP 2: delete via service (the production path)
  console.log("\n[step 2] DatasetService.deleteDataset → mirror to trash");
  const svc = new DatasetService(knex);
  await svc.deleteDataset(PROBE_ID, actorId);

  const sourceAfterDelete = await knex("foundry_datasets").where({ id: PROBE_ID }).first();
  assert(sourceAfterDelete === undefined, "foundry_datasets row hard-deleted");

  const colsAfterDelete = await knex("dataset_columns").where({ dataset_id: PROBE_ID });
  assert(colsAfterDelete.length === 0, "dataset_columns rows hard-deleted");

  const mirror = await knex("resources").where({ legacy_uuid: PROBE_ID }).first() as any;
  assert(mirror !== undefined, "mirror row created in resources");
  assert(mirror.type === "FOUNDRY_DATASET", `type=FOUNDRY_DATASET (got ${mirror?.type})`);
  assert(mirror.trash_status === "DIRECTLY_TRASHED", `trash_status=DIRECTLY_TRASHED (got ${mirror?.trash_status})`);
  assert(mirror.trashed_by === actorId, "trashed_by=actor");
  assert(mirror.trashed_at !== null, "trashed_at populated");
  assert(mirror.retention_until !== null, "retention_until populated (30d default)");
  assert(mirror.metadata?.snapshot?.dataset?.name === PROBE_NAME, "snapshot.dataset.name preserved");
  assert(Array.isArray(mirror.metadata?.snapshot?.columns) && mirror.metadata.snapshot.columns.length === 3, "snapshot.columns has 3 entries");
  assert(mirror.rid.startsWith("ri.compass.main.foundry-dataset."), `rid uses canonical foundry-dataset namespace (got ${mirror?.rid})`);

  // STEP 3: replay restore handler logic (matches projectWorkspace.ts:286-405)
  console.log("\n[step 3] restore from snapshot");
  const ds = mirror.metadata.snapshot.dataset;
  const cols = mirror.metadata.snapshot.columns;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO foundry_datasets (
         id, name, folder_id, project_id, file_path, original_filename, mime_type,
         file_size_bytes, row_count, row_count_exact, column_count,
         schema_info, markings, status, format, content_hash,
         last_output_schema_fingerprint, created_at, updated_at, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::text[],$14,$15,$16,$17,$18,now(),$19,$20)
       ON CONFLICT (id) DO NOTHING`,
      [
        ds.id, ds.name, ds.folder_id, ds.project_id,
        ds.file_path, ds.original_filename, ds.mime_type,
        ds.file_size_bytes, ds.row_count, ds.row_count_exact, ds.column_count,
        ds.schema_info ? JSON.stringify(ds.schema_info) : null,
        Array.isArray(ds.markings) ? ds.markings : null,
        ds.status, ds.format, ds.content_hash,
        ds.last_output_schema_fingerprint,
        ds.created_at, ds.created_by ?? actorId, actorId,
      ],
    );
    for (const c of cols) {
      await client.query(
        `INSERT INTO dataset_columns (dataset_id, column_name, column_type, ordinal_position, nullable, sample_values)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT DO NOTHING`,
        [ds.id, c.column_name, c.column_type, c.ordinal_position, c.nullable, c.sample_values ? JSON.stringify(c.sample_values) : null],
      );
    }
    await client.query(
      `UPDATE resources SET
         trash_status = 'NOT_TRASHED', trashed_at = NULL, trashed_by = NULL,
         retention_until = NULL, metadata = metadata - 'snapshot',
         updated_by = $2, updated_at = now(), etag = etag + 1
       WHERE rid = $1`,
      [mirror.rid, actorId],
    );
    await client.query("COMMIT");
    console.log("  COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.log(`  FAIL: restore raised ${(e as Error).message}`);
    failures++;
  } finally {
    client.release();
  }

  const sourceAfterRestore = await knex("foundry_datasets").where({ id: PROBE_ID }).first();
  assert(sourceAfterRestore?.name === PROBE_NAME, "foundry_datasets row restored with original name");

  const colsAfterRestore = await knex("dataset_columns").where({ dataset_id: PROBE_ID });
  assert(colsAfterRestore.length === 3, "dataset_columns restored");

  const mirrorAfterRestore = await knex("resources").where({ legacy_uuid: PROBE_ID }).first() as any;
  assert(mirrorAfterRestore?.trash_status === "NOT_TRASHED", "mirror row trash_status reset to NOT_TRASHED");
  assert(mirrorAfterRestore?.metadata?.snapshot === undefined, "metadata.snapshot key removed");

  // STEP 4: cleanup
  console.log("\n[step 4] cleanup");
  await cleanup();
  const cleanupSource = await knex("foundry_datasets").where({ id: PROBE_ID }).first();
  const cleanupMirror = await knex("resources").where({ legacy_uuid: PROBE_ID }).first();
  assert(cleanupSource === undefined, "probe dataset removed");
  assert(cleanupMirror === undefined, "probe mirror removed");

  await knex.destroy();
  await pool.end();

  console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\nFAIL:", (e as Error).message);
  await cleanup();
  await knex.destroy();
  await pool.end();
  process.exit(1);
});
