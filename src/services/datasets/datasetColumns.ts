// ---------------------------------------------------------------------------
// Dataset column resolution — the single source the "Get Dataset" identity
// surface uses to surface a dataset's column schema.
//
// Two layers, in order of authority:
//   1. `dataset_columns` — the persisted schema scan (authoritative PG types,
//      ordinal_position, nullable, sample_values). Populated by the upload
//      parse worker / pipeline deploy / sync scan.
//   2. Live preview inference — `readSyncedPreview` / `readUploadedPreview`
//      derive columns from the materialised data when the scan has not yet
//      persisted (e.g. a failed scan, `status='error'`, or a freshly-built
//      dataset whose worker hasn't run). This mirrors exactly what the
//      `/preview` endpoint returns, so the "Create a new object type" wizard
//      sees the same columns the dataset preview page shows.
//
// Both the Foundry-parity identity endpoint (`GET /:datasetRid` for full RIDs)
// and the legacy UUID-keyed identity endpoint (its foundry-dataset fallback)
// share this helper so the wizard works regardless of which identifier form
// the picker/pipeline-builder handed it.
// ---------------------------------------------------------------------------

import { pool } from "../../db";
import type { ResolvedDataset } from "./dataset-resolver";
import {
  readSyncedPreview,
  type SyncedPreview,
} from "./synced-dataset-reader";
import { readUploadedPreview } from "./uploaded-dataset-reader";

/** A column as the ontology wizard / dataset detail surfaces consume it. */
export interface DatasetColumnInfo {
  name: string;
  /** PG type from `dataset_columns.column_type` or an inferred preview type. */
  type: string;
  ordinal_position: number;
  nullable: boolean;
  sample_values: unknown[];
}

/**
 * Read a bounded preview of a resolved dataset's data — the same branch the
 * Foundry `/preview` handler runs. Centralised here so the identity endpoint
 * and the preview endpoint derive columns from one implementation.
 *
 * Returns an empty (well-formed) preview when the dataset has no materialised
 * data yet (identity-only / not built), so callers never see phantom columns.
 */
export async function readDatasetPreview(
  resolved: ResolvedDataset,
  limit: number,
): Promise<SyncedPreview> {
  const producer = resolved.producer;
  const objectPath = resolved.registry?.filePath ?? null;
  if (producer) {
    return readSyncedPreview(
      producer.config as never,
      producer.tenant,
      limit,
    );
  }
  if (objectPath && !objectPath.startsWith("iceberg://")) {
    return readUploadedPreview(objectPath, limit);
  }
  return { columns: [], rows: [], snapshot: null };
}

/**
 * Resolve the column schema for a dataset, preferring the persisted
 * `dataset_columns` scan and falling back to live-preview inference when the
 * scan is empty (not run / failed). `limit` bounds the fallback read.
 */
export async function resolveDatasetColumns(
  resolved: ResolvedDataset,
  limit = 50,
): Promise<DatasetColumnInfo[]> {
  const registryId = resolved.registry?.id;
  if (registryId) {
    const r = await pool.query<{
      column_name: string;
      column_type: string;
      ordinal_position: number;
      nullable: boolean;
      sample_values: unknown;
    }>(
      `SELECT column_name, column_type, ordinal_position, nullable, sample_values
         FROM dataset_columns
        WHERE dataset_id = $1
        ORDER BY ordinal_position ASC`,
      [registryId],
    );
    if (r.rows.length > 0) {
      return r.rows.map((c) => ({
        name: c.column_name,
        type: c.column_type,
        ordinal_position: c.ordinal_position,
        nullable: c.nullable,
        sample_values: Array.isArray(c.sample_values) ? c.sample_values : [],
      }));
    }
  }

  // Fallback: the scan hasn't persisted columns, but the data is readable —
  // derive the schema from the live preview (matches the /preview endpoint).
  const preview = await readDatasetPreview(resolved, limit);
  return preview.columns.map((c, i) => ({
    name: c.name,
    type: c.type,
    ordinal_position: i + 1,
    nullable: true,
    sample_values: [],
  }));
}
