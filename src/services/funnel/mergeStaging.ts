// ---------------------------------------------------------------------------
// Merge staging + promote — Blocker 3.
//
// The merge PG tail NEVER writes the live object_instances directly. It
// loads the merged result into merge_staging_instances (batched, keyed by
// staging run id), runs count + distinct + null/empty checks, and only
// then promotes into the live table inside ONE transaction. A failed run
// leaves the live table unchanged; the staging rows are dropped on success
// (or kept for forensics when the versioned config retains them).
//
// Bulk loading reuses the chunked unnest pattern from
// models/objectInstance.bulkUpsertInstances (NOT raw COPY): COPY would need
// either a server-visible file or a copy-stream dependency, while the
// chunked unnest stays under PG's 65 535 bind ceiling with one round trip
// per 1 000-row chunk. Promotion itself is set-based (single INSERT ..
// SELECT / DELETE per operation class) so the live-table cutover is atomic.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { deriveMainBranchId } from "../branchContext";

export interface StagedRowInput {
  ontology_id: string;
  object_type_api_name: string;
  primary_key: string;
  operation: "upsert" | "delete";
  properties: Record<string, unknown>;
  markings: string[];
  source_datasource_id: string | null;
  source_transaction_id: string | null;
}

export interface StagingScope {
  ontologyId: string;
  objectTypeApiName: string;
  stagingRunId: string;
}

const STAGE_CHUNK_SIZE = 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Staging identity for one tail load. Prefers the run key (stable across
 * retries of the same run) and falls back to the pre-generated merged
 * snapshot id. Non-uuid run keys fall back too — staging_run_id is uuid.
 */
export function resolveStagingRunId(
  runKey: string | null | undefined,
  fallbackSnapshotId: string,
): string {
  if (runKey && UUID_RE.test(runKey)) return runKey;
  return fallbackSnapshotId;
}

function asUuidOrNull(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return UUID_RE.test(value) ? value : null;
}

/** Drop any staging rows owned by this (ontology, object type). The funnel
 *  holds one indexing lock per object type, so no concurrent run can own
 *  these rows. Called at tail start so a retried run never double-loads. */
export async function clearMergeStaging(
  client: PoolClient,
  scope: Omit<StagingScope, "stagingRunId">,
): Promise<void> {
  await client.query(
    `DELETE FROM merge_staging_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2`,
    [scope.ontologyId, scope.objectTypeApiName],
  );
}

/** Drop one run's staging rows (post-promote cleanup / failure retention). */
export async function clearMergeStagingRun(
  client: PoolClient,
  scope: StagingScope,
): Promise<void> {
  await client.query(
    `DELETE FROM merge_staging_instances
      WHERE staging_run_id = $1
        AND ontology_id = $2 AND object_type_api_name = $3`,
    [scope.stagingRunId, scope.ontologyId, scope.objectTypeApiName],
  );
}

/** Batch-load staged rows. Plain INSERTs (PK includes the run id, so a
 *  duplicate here is a merge bug and must fail loudly, not upsert). */
export async function stageMergeRows(
  client: PoolClient,
  scope: StagingScope,
  rows: StagedRowInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const branchId = deriveMainBranchId(scope.ontologyId);
  for (let i = 0; i < rows.length; i += STAGE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + STAGE_CHUNK_SIZE);
    await client.query(
      `INSERT INTO merge_staging_instances
         (staging_run_id, ontology_id, branch_id, object_type_api_name,
          primary_key, operation, properties, markings,
          source_datasource_id, source_transaction_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4,
              primary_key, operation, properties::jsonb,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(markings)), '{}'::text[]),
              source_datasource_id::uuid, source_transaction_id::uuid
         FROM unnest(
           $5::text[], $6::text[], $7::jsonb[], $8::jsonb[],
           $9::uuid[], $10::uuid[]
         ) AS t(primary_key, operation, properties, markings,
                source_datasource_id, source_transaction_id)`,
      [
        scope.stagingRunId,
        scope.ontologyId,
        branchId,
        scope.objectTypeApiName,
        chunk.map((r) => r.primary_key),
        chunk.map((r) => r.operation),
        chunk.map((r) => JSON.stringify(r.properties ?? {})),
        chunk.map((r) => JSON.stringify(r.markings ?? [])),
        chunk.map((r) => asUuidOrNull(r.source_datasource_id)),
        chunk.map((r) => asUuidOrNull(r.source_transaction_id)),
      ],
    );
  }
  return rows.length;
}

export interface StagingVerification {
  staged: number;
  stagedUpserts: number;
  stagedDeletes: number;
  distinctPk: number;
  nullPk: number;
  emptyPk: number;
}

/** Count + distinct + null/empty checks over one run's staging rows. */
export async function verifyMergeStaging(
  client: PoolClient,
  scope: StagingScope,
): Promise<StagingVerification> {
  const r = await client.query(
    `SELECT count(*)::bigint AS staged,
            count(*) FILTER (WHERE operation = 'upsert')::bigint AS upserts,
            count(*) FILTER (WHERE operation = 'delete')::bigint AS deletes,
            count(DISTINCT primary_key)::bigint AS distinct_pk,
            count(*) FILTER (WHERE primary_key IS NULL)::bigint AS null_pk,
            count(*) FILTER (WHERE primary_key = '')::bigint AS empty_pk
       FROM merge_staging_instances
      WHERE staging_run_id = $1
        AND ontology_id = $2 AND object_type_api_name = $3`,
    [scope.stagingRunId, scope.ontologyId, scope.objectTypeApiName],
  );
  const row = r.rows[0] as Record<string, string>;
  return {
    staged: Number(row.staged ?? 0),
    stagedUpserts: Number(row.upserts ?? 0),
    stagedDeletes: Number(row.deletes ?? 0),
    distinctPk: Number(row.distinct_pk ?? 0),
    nullPk: Number(row.null_pk ?? 0),
    emptyPk: Number(row.empty_pk ?? 0),
  };
}

export interface PromoteResult {
  upserts: number;
  deletes: number;
}

/**
 * Atomic promote: apply the staged upserts + deletes to the live
 * object_instances inside ONE transaction, then drop the run's staging
 * rows. Callers must have run verifyMergeStaging (and the parquet sample
 * check) first — this function trusts the staging content.
 */
export async function promoteMergeStaging(
  client: PoolClient,
  scope: StagingScope,
): Promise<PromoteResult> {
  const up = await client.query(
    `INSERT INTO object_instances
       (ontology_id, branch_id, object_type_api_name, primary_key, properties,
        markings, source_datasource_id, source_transaction_id,
        last_modified_at, version)
     SELECT ontology_id, branch_id, object_type_api_name, primary_key,
            properties, markings, source_datasource_id, source_transaction_id,
            now(), 1
       FROM merge_staging_instances
      WHERE staging_run_id = $1
        AND ontology_id = $2 AND object_type_api_name = $3
        AND operation = 'upsert'
     ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
     DO UPDATE SET
       properties            = EXCLUDED.properties,
       markings              = EXCLUDED.markings,
       source_datasource_id  = EXCLUDED.source_datasource_id,
       source_transaction_id = EXCLUDED.source_transaction_id,
       last_modified_at      = now(),
       version               = object_instances.version + 1
     WHERE (object_instances.properties, object_instances.markings,
            object_instances.source_datasource_id,
            object_instances.source_transaction_id)
       IS DISTINCT FROM
           (EXCLUDED.properties, EXCLUDED.markings,
            EXCLUDED.source_datasource_id, EXCLUDED.source_transaction_id)`,
    [scope.stagingRunId, scope.ontologyId, scope.objectTypeApiName],
  );
  const del = await client.query(
    `DELETE FROM object_instances oi
      USING merge_staging_instances st
      WHERE st.staging_run_id = $1
        AND st.ontology_id = $2 AND st.object_type_api_name = $3
        AND st.operation = 'delete'
        AND oi.ontology_id = st.ontology_id
        AND oi.branch_id = st.branch_id
        AND oi.object_type_api_name = st.object_type_api_name
        AND oi.primary_key = st.primary_key`,
    [scope.stagingRunId, scope.ontologyId, scope.objectTypeApiName],
  );
  await clearMergeStagingRun(client, scope);
  return {
    upserts: (up.rowCount ?? 0) as number,
    deletes: (del.rowCount ?? 0) as number,
  };
}
