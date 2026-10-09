// ---------------------------------------------------------------------------
// Merge staging + promote — Blocker 3.
//
// The merge PG tail NEVER writes the live object_instances directly. It
// loads the merged result into merge_staging_instances (batched, keyed by
// staging run id), runs count + distinct + null/empty checks, and only
// then promotes into the live table inside ONE transaction (in pk-ordered
// chunks, each its own statement, so no statement nears statement_timeout
// and progress keeps the stage heartbeat alive). A failed run
// leaves the live table unchanged; the staging rows are dropped on success
// (or kept for forensics when the versioned config retains them).
//
// Bulk loading reuses the chunked unnest pattern from
// models/objectInstance.bulkUpsertInstances (NOT raw COPY): COPY would need
// either a server-visible file or a copy-stream dependency, while the
// chunked unnest stays under PG's 65 535 bind ceiling with one round trip
// per 1 000-row chunk. Promotion is set-based per chunk (INSERT .. SELECT
// for upserts, index-keyed DELETE for deletes) and atomic because every
// chunk runs inside the caller's single transaction.
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

/**
 * The staging provenance columns are uuid. A non-uuid id is downgraded to
 * NULL (losing a breadcrumb beats failing the batch) and counted; promote
 * COALESCEs a staged NULL with the live value, so a downgrade can never
 * overwrite existing live provenance with NULL.
 */
export function asUuidOrNull(
  value: string | null | undefined,
  onDowngrade?: (value: string) => void,
): string | null {
  if (value == null || value === "") return null;
  if (UUID_RE.test(value)) return value;
  onDowngrade?.(value);
  return null;
}

/**
 * Rows per statement for the chunked verify / promote / cleanup passes.
 * Each statement must finish well inside the 60 s PG_STATEMENT_TIMEOUT_MS
 * default: on a 2 vCPU / 4 GB Postgres 16 a single-statement promote of
 * 1M PaySim-shaped rows took ~30 s and 6.35M rows hit 57014 at 60 s, so
 * 250k rows per statement is ~7–8 s on that box (8x headroom).
 */
export const DEFAULT_STAGING_CHUNK_ROWS = 250_000;

export type StagingChunkPhase = "verify" | "promote" | "cleanup";

export interface StagingChunkProgress {
  phase: StagingChunkPhase;
  /** Staged rows processed so far in this phase. */
  rowsDone: number;
}

export interface StagingChunkOptions {
  /** Rows per statement (default {@link DEFAULT_STAGING_CHUNK_ROWS}). */
  chunkRows?: number;
  /** Called after every chunk. Must be cheap and must not throw. */
  onProgress?: (p: StagingChunkProgress) => void;
}

function chunkRowsOf(opts?: StagingChunkOptions): number {
  const n = Math.floor(opts?.chunkRows ?? DEFAULT_STAGING_CHUNK_ROWS);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`[merge-staging] invalid chunkRows ${String(opts?.chunkRows)}`);
  }
  return n;
}

function reportChunk(
  opts: StagingChunkOptions | undefined,
  phase: StagingChunkPhase,
  rowsDone: number,
): void {
  try {
    opts?.onProgress?.({ phase, rowsDone });
  } catch {
    /* progress signalling must never fail the promote */
  }
}

// Every chunked pass walks ONE run's staging rows in primary_key order over
// the staging PK index (staging_run_id, ontology_id, branch_id,
// object_type_api_name, primary_key). Within that prefix primary_key is
// unique (PK), so the keyset `primary_key > $last ORDER BY primary_key LIMIT n`
// visits every row exactly once. stageMergeRows is the only writer and always
// stages the ontology's main branch, so branch_id is pinned to it.
const RUN_PREFIX = `staging_run_id = $1 AND ontology_id = $2
        AND branch_id = $3 AND object_type_api_name = $4`;

function runPrefixParams(scope: StagingScope, branchId?: string): unknown[] {
  return [
    scope.stagingRunId,
    scope.ontologyId,
    branchId ?? deriveMainBranchId(scope.ontologyId),
    scope.objectTypeApiName,
  ];
}

/** Keyset predicate for chunk n>0; the first chunk has no lower bound so an
 *  empty-string key is still seen by verify. */
function afterClause(last: string | null): string {
  return last === null ? "" : "AND primary_key > $5";
}

/**
 * Delete one (run, branch)'s staging rows in primary-key ranges of at most
 * `chunkRows`, so no single DELETE has to touch millions of rows (a 6.35M
 * row run is ~3.7 GB of staging). Each range is bounded by the key found
 * `chunkRows` rows ahead on the index, then deleted as a PK range scan.
 */
async function clearRunChunked(
  client: PoolClient,
  scope: StagingScope,
  branchId: string,
  opts?: StagingChunkOptions,
): Promise<number> {
  const n = chunkRowsOf(opts);
  const prefix = runPrefixParams(scope, branchId);
  let last: string | null = null;
  let total = 0;
  for (;;) {
    const bound = await client.query(
      `SELECT primary_key FROM merge_staging_instances
        WHERE ${RUN_PREFIX} ${afterClause(last)}
        ORDER BY primary_key
        OFFSET ${n - 1} LIMIT 1`,
      last === null ? prefix : [...prefix, last],
    );
    const hi = (bound.rows[0]?.primary_key ?? null) as string | null;
    const params: unknown[] = last === null ? [...prefix] : [...prefix, last];
    let upper = "";
    if (hi !== null) {
      params.push(hi);
      upper = `AND primary_key <= $${params.length}`;
    }
    const del = await client.query(
      `DELETE FROM merge_staging_instances
        WHERE ${RUN_PREFIX} ${afterClause(last)} ${upper}`,
      params,
    );
    total += (del.rowCount ?? 0) as number;
    reportChunk(opts, "cleanup", total);
    if (hi === null) return total;
    last = hi;
  }
}

/** Branches a run's staging rows live under (always the main branch today;
 *  read rather than assumed so cleanup never leaves rows behind). */
async function stagedBranches(
  client: PoolClient,
  where: string,
  params: unknown[],
): Promise<Array<{ staging_run_id: string; branch_id: string }>> {
  const r = await client.query(
    `SELECT DISTINCT staging_run_id, branch_id
       FROM merge_staging_instances
      WHERE ${where}`,
    params,
  );
  return r.rows as Array<{ staging_run_id: string; branch_id: string }>;
}

/** Drop any staging rows owned by this (ontology, object type). The funnel
 *  holds one indexing lock per object type, so no concurrent run can own
 *  these rows. Called at tail start so a retried run never double-loads.
 *  Chunked: a retained failed 6M-row run must not blow statement_timeout. */
export async function clearMergeStaging(
  client: PoolClient,
  scope: Omit<StagingScope, "stagingRunId">,
  opts?: StagingChunkOptions,
): Promise<void> {
  const owners = await stagedBranches(
    client,
    "ontology_id = $1 AND object_type_api_name = $2",
    [scope.ontologyId, scope.objectTypeApiName],
  );
  for (const o of owners) {
    await clearRunChunked(
      client,
      { ...scope, stagingRunId: o.staging_run_id },
      o.branch_id,
      opts,
    );
  }
}

/** Drop one run's staging rows (post-promote cleanup / failure retention). */
export async function clearMergeStagingRun(
  client: PoolClient,
  scope: StagingScope,
  opts?: StagingChunkOptions,
): Promise<void> {
  const owners = await stagedBranches(
    client,
    "staging_run_id = $1 AND ontology_id = $2 AND object_type_api_name = $3",
    [scope.stagingRunId, scope.ontologyId, scope.objectTypeApiName],
  );
  for (const o of owners) {
    await clearRunChunked(client, scope, o.branch_id, opts);
  }
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
  let downgraded = 0;
  let sample: string | null = null;
  const onDowngrade = (v: string) => {
    downgraded++;
    if (sample == null) sample = v;
  };
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
        chunk.map((r) => asUuidOrNull(r.source_datasource_id, onDowngrade)),
        chunk.map((r) => asUuidOrNull(r.source_transaction_id, onDowngrade)),
      ],
    );
  }
  if (downgraded > 0) {
    console.warn(
      `[merge-staging] ${scope.objectTypeApiName}: ${downgraded} non-uuid ` +
        `provenance id(s) staged as NULL (e.g. ${JSON.stringify(sample)}); ` +
        `promote keeps the existing live provenance for those rows.`,
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

/**
 * Count + distinct + null/empty checks over one run's staging rows.
 * Chunked by primary-key range (see RUN_PREFIX) so the aggregate never runs
 * as one multi-million-row statement, with progress reported per chunk.
 * Chunks are disjoint key ranges, so summing per-chunk distinct counts is
 * exact.
 */
export async function verifyMergeStaging(
  client: PoolClient,
  scope: StagingScope,
  opts?: StagingChunkOptions,
): Promise<StagingVerification> {
  const n = chunkRowsOf(opts);
  const prefix = runPrefixParams(scope);
  const out: StagingVerification = {
    staged: 0,
    stagedUpserts: 0,
    stagedDeletes: 0,
    distinctPk: 0,
    nullPk: 0,
    emptyPk: 0,
  };
  let last: string | null = null;
  for (;;) {
    const r = await client.query(
      `WITH chunk AS (
         SELECT primary_key, operation
           FROM merge_staging_instances
          WHERE ${RUN_PREFIX} ${afterClause(last)}
          ORDER BY primary_key
          LIMIT ${n}
       )
       SELECT count(*)::bigint AS staged,
              count(*) FILTER (WHERE operation = 'upsert')::bigint AS upserts,
              count(*) FILTER (WHERE operation = 'delete')::bigint AS deletes,
              count(DISTINCT primary_key)::bigint AS distinct_pk,
              count(*) FILTER (WHERE primary_key IS NULL)::bigint AS null_pk,
              count(*) FILTER (WHERE primary_key = '')::bigint AS empty_pk,
              max(primary_key) AS last_pk
         FROM chunk`,
      last === null ? prefix : [...prefix, last],
    );
    const row = (r.rows[0] ?? {}) as Record<string, string | null>;
    const staged = Number(row.staged ?? 0);
    out.staged += staged;
    out.stagedUpserts += Number(row.upserts ?? 0);
    out.stagedDeletes += Number(row.deletes ?? 0);
    out.distinctPk += Number(row.distinct_pk ?? 0);
    out.nullPk += Number(row.null_pk ?? 0);
    out.emptyPk += Number(row.empty_pk ?? 0);
    reportChunk(opts, "verify", out.staged);
    if (staged < n || row.last_pk == null) return out;
    last = String(row.last_pk);
  }
}

export interface PromoteResult {
  upserts: number;
  deletes: number;
}

/**
 * Atomic promote: apply the staged upserts + deletes to the live
 * object_instances, then drop the run's staging rows. Callers must have run
 * verifyMergeStaging (and the parquet sample check) first — this function
 * trusts the staging content.
 *
 * CHUNKED, still all-or-nothing: the run is walked in primary-key order,
 * `chunkRows` staged rows per step, and every step runs on the caller's
 * client inside the caller's ONE transaction — a failure anywhere rolls
 * every chunk back and the live table is untouched. Chunking exists because
 * the single INSERT .. SELECT over 6.35M rows exceeded the 60 s
 * statement_timeout (57014) and, being one silent statement, starved the
 * progress-coupled Temporal heartbeat. Per chunk:
 *   1. upsert the chunk's 'upsert' rows (and collect its 'delete' keys);
 *   2. delete those keys from the live table by unique-index lookup
 *      (`primary_key = ANY($keys)` — no join, so neither the old quadratic
 *      nested loop nor a full live-table hash scan is possible);
 *   3. drop the chunk's staging rows (PK range delete);
 *   4. report progress (heartbeat liveness between statements).
 */
export async function promoteMergeStaging(
  client: PoolClient,
  scope: StagingScope,
  opts?: StagingChunkOptions,
): Promise<PromoteResult> {
  const n = chunkRowsOf(opts);
  const branchId = deriveMainBranchId(scope.ontologyId);
  const prefix = runPrefixParams(scope, branchId);
  let upserts = 0;
  let deletes = 0;
  let rowsDone = 0;
  let last: string | null = null;
  for (;;) {
    const up = await client.query(
      `WITH chunk AS (
         SELECT ontology_id, branch_id, object_type_api_name, primary_key,
                operation, properties, markings,
                source_datasource_id, source_transaction_id
           FROM merge_staging_instances
          WHERE ${RUN_PREFIX} ${afterClause(last)}
          ORDER BY primary_key
          LIMIT ${n}
       ),
       ins AS (
         INSERT INTO object_instances
           (ontology_id, branch_id, object_type_api_name, primary_key, properties,
            markings, source_datasource_id, source_transaction_id,
            last_modified_at, version)
         SELECT ontology_id, branch_id, object_type_api_name, primary_key,
                properties, markings, source_datasource_id, source_transaction_id,
                now(), 1
           FROM chunk
          WHERE operation = 'upsert'
         ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
         DO UPDATE SET
           properties            = EXCLUDED.properties,
           markings              = EXCLUDED.markings,
           -- Provenance never regresses to NULL: a staged NULL (no breadcrumb,
           -- or a non-uuid id downgraded by asUuidOrNull) keeps the live value.
           source_datasource_id  = COALESCE(EXCLUDED.source_datasource_id,
                                            object_instances.source_datasource_id),
           source_transaction_id = COALESCE(EXCLUDED.source_transaction_id,
                                            object_instances.source_transaction_id),
           last_modified_at      = now(),
           version               = object_instances.version + 1
         WHERE (object_instances.properties, object_instances.markings,
                object_instances.source_datasource_id,
                object_instances.source_transaction_id)
           IS DISTINCT FROM
               (EXCLUDED.properties, EXCLUDED.markings,
                COALESCE(EXCLUDED.source_datasource_id, object_instances.source_datasource_id),
                COALESCE(EXCLUDED.source_transaction_id, object_instances.source_transaction_id))
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM chunk)::bigint AS scanned,
              (SELECT max(primary_key) FROM chunk) AS last_pk,
              (SELECT count(*) FROM ins)::bigint AS upserted,
              (SELECT coalesce(array_agg(primary_key), '{}'::text[])
                 FROM chunk WHERE operation = 'delete') AS delete_keys`,
      last === null ? prefix : [...prefix, last],
    );
    const row = (up.rows[0] ?? {}) as {
      scanned?: string | number;
      last_pk?: string | null;
      upserted?: string | number;
      delete_keys?: string[] | null;
    };
    const scanned = Number(row.scanned ?? 0);
    if (scanned === 0 || row.last_pk == null) break;
    upserts += Number(row.upserted ?? 0);
    const deleteKeys = row.delete_keys ?? [];
    if (deleteKeys.length > 0) {
      const del = await client.query(
        `DELETE FROM object_instances
          WHERE ontology_id = $1 AND branch_id = $2
            AND object_type_api_name = $3
            AND primary_key = ANY($4::text[])`,
        [scope.ontologyId, branchId, scope.objectTypeApiName, deleteKeys],
      );
      deletes += (del.rowCount ?? 0) as number;
    }
    const hi = String(row.last_pk);
    await client.query(
      `DELETE FROM merge_staging_instances
        WHERE ${RUN_PREFIX} ${afterClause(last)}
          AND primary_key <= $${last === null ? 5 : 6}`,
      last === null ? [...prefix, hi] : [...prefix, last, hi],
    );
    rowsDone += scanned;
    reportChunk(opts, "promote", rowsDone);
    if (scanned < n) break;
    last = hi;
  }
  return { upserts, deletes };
}
