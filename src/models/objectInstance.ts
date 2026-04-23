// ---------------------------------------------------------------------------
// Object Instance Model — tasks-01.md §B1
//
// Polymorphic System-of-Record for every object instance across every Object
// Type in every Ontology. Populated by the Funnel Merge stage (B5); not the
// Action writeback path. Actions write user intent to `ontology_edit`; the
// Merge stage overlays that intent on top of the datasource-derived state
// and upserts the resulting row here.
//
// The hydration layer (search, object views) reads from this table when the
// index is not authoritative. Shutting down Elasticsearch/Quickwit and
// losing the search index does NOT cause edit loss — edits live in
// `ontology_edit` and merged state lives here.
// ---------------------------------------------------------------------------

import { PoolClient } from "pg";
import { query, getClient } from "../db";
import { deriveMainBranchId } from "../services/branchContext";

export interface ObjectInstanceRow {
  ontology_id: string;
  object_type_api_name: string;
  primary_key: string;
  properties: Record<string, unknown>;
  markings: string[];
  source_datasource_id: string | null;
  source_transaction_id: string | null;
  last_modified_at: string;
  version: string; // BIGINT comes back as string from pg
}

export interface UpsertInstanceInput {
  ontology_id: string;
  object_type_api_name: string;
  primary_key: string;
  properties: Record<string, unknown>;
  markings?: string[];
  source_datasource_id?: string | null;
  source_transaction_id?: string | null;
}

/**
 * Upsert a single object instance. `version` is bumped on every write.
 * Intended for unit tests and ad-hoc writes; bulk merge should use
 * {@link bulkUpsertInstances} which amortizes the round-trip.
 */
export async function upsertInstance(
  input: UpsertInstanceInput,
  client?: PoolClient
): Promise<ObjectInstanceRow> {
  const runner = client
    ? (sql: string, params: unknown[]) => client.query(sql, params)
    : (sql: string, params: unknown[]) => query(sql, params);

  // Migration 041 made branch_id part of the PK — see writebackOverlay.ts
  // header for the same rationale. All non-branch-aware callers default to
  // the ontology's 'main' branch.
  const branchId = deriveMainBranchId(input.ontology_id);
  const result = await runner(
    `INSERT INTO object_instances
       (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings,
        source_datasource_id, source_transaction_id, last_modified_at, version)
     VALUES ($1, $8::uuid, $2, $3, $4::jsonb, $5, $6, $7, now(), 1)
     ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
     DO UPDATE SET
       properties            = EXCLUDED.properties,
       markings              = EXCLUDED.markings,
       source_datasource_id  = EXCLUDED.source_datasource_id,
       source_transaction_id = EXCLUDED.source_transaction_id,
       last_modified_at      = now(),
       version               = object_instances.version + 1
     RETURNING *`,
    [
      input.ontology_id,
      input.object_type_api_name,
      input.primary_key,
      JSON.stringify(input.properties),
      input.markings ?? [],
      input.source_datasource_id ?? null,
      input.source_transaction_id ?? null,
      branchId,
    ]
  );
  return result.rows[0] as ObjectInstanceRow;
}

/**
 * Bulk upsert. Runs inside a single transaction. If the caller supplies a
 * client it must already be inside a BEGIN; otherwise we open and close our
 * own transaction. Intended as the commit path for the Merge activity.
 *
 * Rows are written in chunks via a single multi-row
 * `INSERT ... SELECT * FROM unnest(...)` so Merge can hit §B5's acceptance
 * target (10 datasources × 100M rows + 50k edits in <15 min) without a
 * per-row round trip. Chunking caps the parameter count well under
 * Postgres's 65 535 bound-parameter limit.
 */
const BULK_UPSERT_CHUNK_SIZE = 1000;

export async function bulkUpsertInstances(
  rows: UpsertInstanceInput[],
  client?: PoolClient
): Promise<number> {
  if (rows.length === 0) return 0;

  const ownClient = client == null;
  const pg = client ?? (await getClient());
  try {
    if (ownClient) await pg.query("BEGIN");
    for (let i = 0; i < rows.length; i += BULK_UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + BULK_UPSERT_CHUNK_SIZE);
      await pg.query(
        `INSERT INTO object_instances
           (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings,
            source_datasource_id, source_transaction_id, last_modified_at, version)
         SELECT
           ontology_id, branch_id, object_type_api_name, primary_key, properties::jsonb, markings,
           source_datasource_id, source_transaction_id, now(), 1
         FROM unnest(
           $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[][],
           $6::uuid[], $7::uuid[], $8::uuid[]
         ) AS t(
           ontology_id, object_type_api_name, primary_key, properties, markings,
           source_datasource_id, source_transaction_id, branch_id
         )
         ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
         DO UPDATE SET
           properties            = EXCLUDED.properties,
           markings              = EXCLUDED.markings,
           source_datasource_id  = EXCLUDED.source_datasource_id,
           source_transaction_id = EXCLUDED.source_transaction_id,
           last_modified_at      = now(),
           version               = object_instances.version + 1`,
        [
          chunk.map((r) => r.ontology_id),
          chunk.map((r) => r.object_type_api_name),
          chunk.map((r) => r.primary_key),
          chunk.map((r) => JSON.stringify(r.properties)),
          chunk.map((r) => r.markings ?? []),
          chunk.map((r) => r.source_datasource_id ?? null),
          chunk.map((r) => r.source_transaction_id ?? null),
          chunk.map((r) => deriveMainBranchId(r.ontology_id)),
        ]
      );
    }
    if (ownClient) await pg.query("COMMIT");
    return rows.length;
  } catch (err) {
    if (ownClient) await pg.query("ROLLBACK");
    throw err;
  } finally {
    if (ownClient) pg.release();
  }
}

/**
 * Delete a single object instance. Returns true if a row was removed.
 * The Merge stage calls this when a DELETE changelog row is consumed.
 */
export async function deleteInstance(
  ontologyId: string,
  objectTypeApiName: string,
  primaryKey: string,
  client?: PoolClient
): Promise<boolean> {
  const runner = client
    ? (sql: string, params: unknown[]) => client.query(sql, params)
    : (sql: string, params: unknown[]) => query(sql, params);
  const result = await runner(
    `DELETE FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = $3`,
    [ontologyId, objectTypeApiName, primaryKey]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getInstance(
  ontologyId: string,
  objectTypeApiName: string,
  primaryKey: string
): Promise<ObjectInstanceRow | null> {
  const result = await query(
    `SELECT * FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = $3`,
    [ontologyId, objectTypeApiName, primaryKey]
  );
  return (result.rows[0] as ObjectInstanceRow | undefined) ?? null;
}

export async function countInstancesForObjectType(
  objectTypeApiName: string
): Promise<number> {
  const result = await query(
    `SELECT count(*)::bigint AS n FROM object_instances WHERE object_type_api_name = $1`,
    [objectTypeApiName]
  );
  return Number(result.rows[0]?.n ?? 0);
}
