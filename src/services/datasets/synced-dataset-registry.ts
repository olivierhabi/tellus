// ---------------------------------------------------------------------------
// Synced-dataset registry — make a sync's output Dataset visible in Compass.
//
// A table-import writes its data into Iceberg, but the dataset only SHOWS UP in
// a project/folder if it is registered in `foundry_datasets` (the table the
// Compass children listing reads, keyed by project_id/folder_id). Foundry
// behaves the same: a sync creates a Dataset resource in the output folder.
//
// This registers (idempotently) a `foundry_datasets` row whose `id` is the UUID
// of the import's `dataset_rid`, so the listed rid
// (`ri.foundry.main.dataset.<id>`) matches the import's dataset_rid and clicks
// through to the Dataset Preview (which reads the Iceberg data via the import).
// ---------------------------------------------------------------------------

import { pool } from "../../db";
import { readSyncedPreview, type ImportConfigForRead } from "./synced-dataset-reader";

const RID_PREFIX = "ri.foundry.main.dataset.";

/** Last dot-segment of a Compass RID is its UUID (segments are dot-joined). */
function ridUuid(rid: string): string {
  return rid.split(".").pop() ?? rid;
}

/**
 * Map import status → the foundry_datasets lifecycle status the UI shows.
 * Only an ACTIVE build (running/queued) is "processing" (the only state the UI
 * polls). A never-built/draft import maps to "ready" — the dataset exists and
 * is viewable (the preview shows the not-built-yet state) but must NOT be
 * polled, or the folder view would poll un-building datasets forever.
 */
function datasetStatus(state: string | undefined): string {
  if (state === "running" || state === "queued") return "processing";
  if (state === "failed") return "error";
  return "ready"; // succeeded, draft, ready, cancelled, unknown
}

/**
 * Resolve a connection's `compass_folder_rid` to the (projectId, folderId)
 * tuple `foundry_datasets` is keyed by. A project RID → project root
 * (folderId null); a folder RID → its project + that folder; otherwise fall
 * back to the resource's enclosing project. Returns nulls when unresolvable.
 */
export async function resolveProjectFolder(
  compassFolderRid: string | null | undefined,
): Promise<{ projectId: string | null; folderId: string | null }> {
  if (!compassFolderRid) return { projectId: null, folderId: null };
  const uuid = ridUuid(compassFolderRid);

  const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [uuid]);
  if (proj.rowCount) return { projectId: uuid, folderId: null };

  const fol = await pool.query<{ project_id: string }>(
    `SELECT project_id FROM folders WHERE id = $1`,
    [uuid],
  );
  if (fol.rowCount) return { projectId: fol.rows[0].project_id, folderId: uuid };

  // Resource-tree folder not mirrored in `folders`: place it in the enclosing
  // project's root so it is at least visible under the project.
  const res = await pool.query<{ project_rid: string | null }>(
    `SELECT project_rid FROM resources WHERE rid = $1`,
    [compassFolderRid],
  );
  const projectRid = res.rows[0]?.project_rid;
  if (projectRid) {
    const puuid = ridUuid(projectRid);
    const p = await pool.query(`SELECT id FROM projects WHERE id = $1`, [puuid]);
    if (p.rowCount) return { projectId: puuid, folderId: null };
  }
  return { projectId: null, folderId: null };
}

export interface RegisterSyncedDatasetInput {
  datasetRid: string;
  name: string;
  compassFolderRid: string | null;
  schema: string;
  table: string;
  /** Iceberg warehouse (connection tenant); used for the synthetic file path. */
  warehouse: string;
  /** Import status.state — mapped to the dataset lifecycle status. */
  status?: string;
  rowCount?: number | null;
  fileSizeBytes?: number | null;
}

export interface RegisterResult {
  ok: boolean;
  reason?: string;
}

/**
 * Idempotently register/refresh the Compass-visible dataset for a sync. Returns
 * `{ok:false}` (never throws) when it cannot be placed, so callers stay
 * best-effort — the sync + Iceberg data are unaffected.
 */
export async function registerSyncedDataset(
  input: RegisterSyncedDatasetInput,
): Promise<RegisterResult> {
  try {
    if (!input.datasetRid.startsWith(RID_PREFIX)) {
      return { ok: false, reason: "not a foundry dataset rid" };
    }
    const id = ridUuid(input.datasetRid);
    const { projectId, folderId } = await resolveProjectFolder(input.compassFolderRid);
    if (!projectId) return { ok: false, reason: "unresolved output folder" };

    // Foundry parity — ResourceNameAlreadyExists: a different dataset in
    // the same folder already holding `input.name` must not be shadowed.
    // This registry is contractually non-throwing, so the conflict is
    // surfaced as a loud log + `{ok:false}` instead of an HTTP 409.
    const conflict = await pool.query<{ id: string }>(
      folderId
        ? `SELECT id FROM foundry_datasets WHERE name = $1 AND folder_id = $2 AND id <> $3 LIMIT 1`
        : `SELECT id FROM foundry_datasets WHERE name = $1 AND folder_id IS NULL AND project_id = $2 AND id <> $3 LIMIT 1`,
      [input.name, folderId ?? projectId, id],
    );
    if (conflict.rowCount) {
      console.warn(
        `[synced-dataset-registry] refusing to register ${input.datasetRid}: ` +
          `name "${input.name}" already used by dataset ${conflict.rows[0]!.id} in folder ${folderId ?? "<root>"}`,
      );
      return { ok: false, reason: "name_conflict" };
    }

    const filePath = `iceberg://${input.warehouse}/${input.schema}/${input.table}`;
    await pool.query(
      `INSERT INTO foundry_datasets
         (id, name, project_id, folder_id, file_path, format, markings, status,
          row_count, file_size_bytes)
       VALUES ($1,$2,$3,$4,$5,'iceberg','{}'::text[],$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          project_id = EXCLUDED.project_id,
          folder_id = EXCLUDED.folder_id,
          status = EXCLUDED.status,
          row_count = COALESCE(EXCLUDED.row_count, foundry_datasets.row_count),
          file_size_bytes = COALESCE(EXCLUDED.file_size_bytes, foundry_datasets.file_size_bytes),
          updated_at = now()`,
      [
        id,
        input.name,
        projectId,
        folderId,
        filePath,
        datasetStatus(input.status),
        input.rowCount ?? null,
        input.fileSizeBytes ?? null,
      ],
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Sync-schema persistence — populate `dataset_columns` for Iceberg outputs.
//
// The upload pipeline has the CSV parse worker to scan its schema into
// `dataset_columns`, but a table-import's output never got an equivalent:
// `registerSyncedDataset` writes only the registry row, so every Iceberg
// dataset historically had zero persisted columns. Surfaces that read the
// live preview (Dataset Preview, the ontology wizard's picker) masked this,
// but consumers of the PERSISTED scan — notably
// `registerWithFoundryDataset` (backing-datasource registration) — failed
// with "has no columns yet".
//
// `persistSyncedSchema` closes that gap: it reads a bounded preview of the
// current Iceberg snapshot and wipes-and-rewrites the dataset's
// `dataset_columns` rows (same transactional pattern as the CSV parse job),
// then records `column_count`/`schema_info` on the registry row. Called
// best-effort after a successful build and as the registration fallback.
// ---------------------------------------------------------------------------

/** Sample size for type inference + sample values (bounded, cheap). */
const SCHEMA_SCAN_ROW_LIMIT = 200;

/**
 * Scan the current Iceberg snapshot and persist the column schema for a
 * synced dataset. Returns the number of columns persisted (0 when the table
 * has never been built or is unreadable). Throws only on DB failures —
 * callers treat it as best-effort except the registration fallback.
 */
export async function persistSyncedSchema(
  foundryDatasetId: string,
  config: ImportConfigForRead,
  tenant: string,
): Promise<number> {
  const preview = await readSyncedPreview(config, tenant, SCHEMA_SCAN_ROW_LIMIT);
  if (preview.columns.length === 0) return 0;

  // Derive per-column sample values from the previewed rows (first few
  // non-null observations), mirroring what the CSV scan persists.
  const samples = new Map<string, unknown[]>();
  for (const col of preview.columns) samples.set(col.name, []);
  for (const row of preview.rows) {
    let remaining = false;
    for (const [key, vals] of samples) {
      if (vals.length >= 5) continue;
      remaining = true;
      const v = row[key];
      if (v !== null && v !== undefined && v !== "") vals.push(v);
    }
    if (!remaining) break;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM dataset_columns WHERE dataset_id = $1`, [
      foundryDatasetId,
    ]);
    for (let i = 0; i < preview.columns.length; i++) {
      const col = preview.columns[i];
      await client.query(
        `INSERT INTO dataset_columns
           (dataset_id, column_name, column_type, ordinal_position, nullable, sample_values)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          foundryDatasetId,
          col.name,
          col.type,
          i + 1,
          true,
          JSON.stringify(samples.get(col.name) ?? []),
        ],
      );
    }
    await client.query(
      `UPDATE foundry_datasets SET
         column_count = $2,
         row_count = COALESCE(row_count, $3),
         schema_info = $4::jsonb,
         updated_at = now()
       WHERE id = $1`,
      [
        foundryDatasetId,
        preview.columns.length,
        preview.snapshot ? Number(preview.snapshot.addedRecords) || null : null,
        JSON.stringify({
          columns: preview.columns.map((c) => ({ name: c.name, type: c.type })),
          source: "sync-schema-scan",
          snapshotId: preview.snapshot?.id ?? null,
          scannedAt: new Date().toISOString(),
        }),
      ],
    );
    await client.query("COMMIT");
    return preview.columns.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
