// ---------------------------------------------------------------------------
// Merge Stage — tasks-01.md §B5
//
// mergeChanges() takes the current merged snapshot as a base, overlays
// the changelog(s) from every backing datasource for this Object Type,
// and then applies user edits per the configured conflict strategy.
// The result is written as a NEW merged snapshot AND upserted into the
// `object_instances` Postgres table (the B1 System-of-Record).
//
// The implementation is pure TypeScript with a clean per-PK state machine
// so it can be unit tested without DuckDB present. Production can swap in
// DuckDB's SQL-based join path (see {@link mergeWithDuckDB}) for scale;
// the pure path is used in tests and as the fallback path when DuckDB is
// unavailable.
//
// Conflict strategies (from Palantir docs):
//
//   * user_edit_wins (default): once a property has been touched by a user
//     edit, it is pinned against any subsequent source update. Unedited
//     properties continue to track source.
//   * latest_wins: requires a `source_timestamp` column on the source.
//     The edit wins only when edit.created_at > source.source_timestamp.
//
// Column-wise Multi-Datasource Overlay (MDO):
//   * Each property is contributed by exactly one datasource. Config
//     violating this is rejected at load — we never silently pick a
//     winner across datasources for the same property.
//
// Markings:
//   * Row-level markings are the union of every contributing datasource's
//     markings for that PK.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { PoolClient } from "pg";
import { query, getClient } from "../../db";
import { bulkUpsertInstances, deleteInstance, UpsertInstanceInput } from "../../models/objectInstance";
import { ChangelogRow } from "./changelogStage";
import { commitSnapshot, ManifestEntry } from "./icebergCatalog";
import { markEditsAppliedToMerge, OntologyEditRow } from "../../models/ontologyEdit";
import { unionMarkings } from "../markingUnion";
import {
  MERGED_PARQUET_COLUMNS,
  mergedParquetKey,
  deleteOrphanParquetRef,
  newSnapshotId,
  parquetRefToUri,
  parseJsonColumn,
  parseJsonArrayColumn,
  readParquetRows,
  streamParquetRows,
  resolveParquetRef,
  writeParquetRef,
  type ParquetRef,
} from "./funnelParquetStore";
import {
  acquireConnection,
  runAll,
  queryAll,
  streamQuery,
  releaseConnection,
  type DuckDBConnection,
} from "../duckdb/pool";
import { getObjectStream, uploadObject } from "../storageService";
import {
  recordMergeProgress,
  readMergeProgress,
  clearMergeProgress,
} from "./mergeProgress";
import { reportStageProgress } from "./temporal/stageProgress";
import {
  buildMergePrefixStatements,
  buildEditStatements,
  buildPrefixAttachStatements,
  buildPrefixExportStatements,
  buildFastPathPrecheckStatement,
  buildFastSourceStateStatement,
  isFastPathEnabled,
  isFastPathPrecheckPass,
  isNarrowDedupEnabled,
  PREFIX_EXPORT_FILES,
  type FastPathPrecheck,
} from "./mergePrefixSql";
import {
  planBucketCount,
  runBucketedMergePrefix,
} from "./mergeBuckets";
import {
  runDuckDbCliScript,
  resolveCliSettings,
  cliSettingsPreamble,
  shouldUseOutOfProcessMerge,
} from "./mergeCliRunner";
import {
  touchIndexingLock,
  reportIndexingProgress,
  resolveLeaseObjectTypeId,
} from "./indexingLease";
import { funnelRuntimeConfig } from "../../config/funnelRuntime";
import {
  clearMergeStaging,
  clearMergeStagingRun,
  stageMergeRows,
  verifyMergeStaging,
  promoteMergeStaging,
  resolveStagingRunId,
  type StagedRowInput,
  type StagingVerification,
  type StagingScope,
} from "./mergeStaging";

/**
 * Best-effort lease signalling: a missed heartbeat/progress report delays
 * steal-safety but never corrupts — so signalling must never fail (or slow)
 * the merge it observes.
 */
async function bestEffortLease(
  fn: () => Promise<unknown>,
  what: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(
      `[merge-sql] lease ${what} failed: ${(err as Error).message}`,
    );
  }
}

// Delta PG tail: diff the freshly-built merged parquet against the PREVIOUS
// merged snapshot's parquet (same producer — DuckDB — so plain string
// comparison is exact; no jsonb-canonicalisation pitfalls) and ship ONLY
// changed/new/deleted rows to PG. Steady-state re-merges go from O(dataset)
// writes to O(changes). Set MERGE_DELTA=0 to force the full-rewrite tail
// (e.g. to self-heal out-of-band PG drift).
const MERGE_DELTA = (process.env.MERGE_DELTA ?? "1") !== "0";

/**
 * Snapshot history can outlive `object_instances` (for example after a
 * table restore). In that state an identical source snapshot produces a
 * zero delta even though the materialized store is empty, so the PG tail
 * must be rebuilt in full.
 */
export function requiresFullPgTail(
  expectedActiveRows: number,
  materializedRows: number,
): boolean {
  return expectedActiveRows !== materializedRows;
}

export type EditStrategy = "user_edit_wins" | "latest_wins";

/** A single backing datasource contributing to this Object Type. */
export interface DatasourceContribution {
  datasource_id: string;
  /** Properties this datasource owns. Each property name MUST appear in
   *  exactly one contribution across the set — column-wise MDO rule. */
  owned_properties: string[];
  /** Rows from the changelog table produced by B4 for this datasource,
   *  in source_transaction_id order. */
  changelog_rows: ChangelogRow[];
  /** Markings that apply to every row from this datasource. */
  markings: string[];
  /** If the strategy is latest_wins, the datasource must report its
   *  source_timestamp for each row so the strategy has a comparison
   *  anchor. Map keyed by primary_key. */
  source_timestamps?: Record<string, string>;
}

export interface MergeInput {
  ontologyId: string;
  objectTypeApiName: string;
  /** The ordered set of contributions. At most 70 per Palantir's limit. */
  contributions: DatasourceContribution[];
  /** Pending edits from ontology_edit (applied_to_merged_at IS NULL). */
  pendingEdits: OntologyEditRow[];
  editStrategy: EditStrategy;
  /** The current merged Iceberg table id. A new snapshot is committed
   *  on top of this table. */
  mergedTableId: string;
  mergedOutputFileLocation: string;
  /** Optional existing state keyed by primary_key — production loads
   *  this from `object_instances`; tests can supply it directly. */
  existingInstances?: Record<string, ExistingInstance>;
}

export interface ExistingInstance {
  properties: Record<string, unknown>;
  markings: string[];
  source_datasource_id: string | null;
  source_transaction_id: string | null;
}

export interface MergeResult {
  snapshotId: string;
  upserts: number;
  deletes: number;
  editsConsumed: number;
  mergedRows: Array<{
    primary_key: string;
    properties: Record<string, unknown>;
    markings: string[];
    operation: "upsert" | "delete";
    source_datasource_id: string | null;
    source_transaction_id: string | null;
  }>;
  /** Reference to the Parquet object in MinIO holding the merged rows,
   *  or `null` for a zero-row merge. The merged snapshot's `summary_json`
   *  carries this ref (NOT the rows); `loadMergedRowsFromSnapshot`
   *  resolves it back to rows. */
  parquetRef?: ParquetRef | null;
}

export const MAX_DATASOURCES_PER_OBJECT_TYPE = 70;

// ---------------------------------------------------------------------------
// Column-wise MDO validation — fail fast on config errors.
// ---------------------------------------------------------------------------

export function validateColumnwiseMDO(
  contributions: DatasourceContribution[]
): void {
  if (contributions.length > MAX_DATASOURCES_PER_OBJECT_TYPE) {
    throw new Error(
      `object type has ${contributions.length} backing datasources; limit is ${MAX_DATASOURCES_PER_OBJECT_TYPE}`
    );
  }
  const ownedBy = new Map<string, string>();
  for (const c of contributions) {
    for (const p of c.owned_properties) {
      const prior = ownedBy.get(p);
      if (prior && prior !== c.datasource_id) {
        throw new Error(
          `property '${p}' is owned by both datasource ${prior} and ${c.datasource_id} — column-wise MDO violation`
        );
      }
      ownedBy.set(p, c.datasource_id);
    }
  }
}

// ---------------------------------------------------------------------------
// Conflict strategies — applied per property, per PK.
// ---------------------------------------------------------------------------

/**
 * Given the source-derived value for a property and a pending edit for
 * the same property (or null if none), return the winning value per the
 * configured strategy.
 */
export function resolveProperty(
  sourceValue: unknown,
  sourceTimestamp: string | null,
  edit: { value: unknown; createdAt: string } | null,
  strategy: EditStrategy
): unknown {
  if (!edit) return sourceValue;
  if (strategy === "user_edit_wins") {
    // Once edited, the property is pinned.
    return edit.value;
  }
  if (strategy === "latest_wins") {
    if (!sourceTimestamp) {
      // Without a comparable source timestamp, the edit can only win if
      // the source has nothing — i.e. degrade to user_edit_wins.
      return edit.value;
    }
    // Millisecond-precision ISO8601 comparison works lexicographically.
    return edit.createdAt > sourceTimestamp ? edit.value : sourceValue;
  }
  return sourceValue;
}

// ---------------------------------------------------------------------------
// The main merge algorithm — per-PK reduction over changelog + edits.
// ---------------------------------------------------------------------------

export async function mergeChanges(input: MergeInput): Promise<MergeResult> {
  validateColumnwiseMDO(input.contributions);

  // Index edits per (primary_key, property_api_name). The spec stores
  // edits at the property level — our existing ontology_edit stores a
  // JSONB of property_values, so we expand them here.
  interface EditBucket {
    perProp: Map<string, { value: unknown; createdAt: string }>;
    operation: "create" | "update" | "delete";
    editIds: string[];
    latestAt: string;
  }
  const editsByKey = new Map<string, EditBucket>();
  for (const e of input.pendingEdits) {
    const existing = editsByKey.get(e.primary_key);
    const bucket: EditBucket = existing ?? {
      perProp: new Map<string, { value: unknown; createdAt: string }>(),
      operation: e.operation,
      editIds: [],
      latestAt: e.executed_at,
    };
    bucket.editIds.push(e.edit_id);
    if (e.executed_at > bucket.latestAt) {
      bucket.latestAt = e.executed_at;
      bucket.operation = e.operation;
    }
    if (e.operation !== "delete" && e.property_values) {
      for (const [prop, val] of Object.entries(e.property_values)) {
        bucket.perProp.set(prop, { value: val, createdAt: e.executed_at });
      }
    }
    editsByKey.set(e.primary_key, bucket);
  }

  // Reduce each datasource's changelog into a per-PK latest state.
  // "Most recent transaction wins" — we fold rows in order; DELETE
  // clears the PK; INSERT/UPDATE overwrite properties.
  const sourceState = new Map<string, {
    properties: Record<string, unknown>;
    markings: Set<string>;
    source_datasource_id: string;
    source_transaction_id: string;
    source_timestamp: string | null;
    tombstoned: boolean;
  }>();

  for (const c of input.contributions) {
    for (const row of c.changelog_rows) {
      const prior = sourceState.get(row.primary_key);
      if (row.operation === "DELETE") {
        // Preserve the union of markings across all contributing datasources
        // even on tombstone — the spec computes effective markings as
        // `array_agg(DISTINCT m)` and a later un-tombstone from another
        // datasource must not silently drop markings contributed earlier.
        const carriedMarkings = new Set<string>(prior?.markings ?? []);
        for (const m of c.markings) carriedMarkings.add(m);
        sourceState.set(row.primary_key, {
          properties: {},
          markings: carriedMarkings,
          source_datasource_id: c.datasource_id,
          source_transaction_id: row.source_transaction_id,
          source_timestamp: row.source_commit_timestamp,
          tombstoned: true,
        });
        continue;
      }
      const next = prior
        ? {
            ...prior,
            properties: prior.tombstoned ? {} : { ...prior.properties },
            markings: new Set(prior.markings),
          }
        : {
            properties: {} as Record<string, unknown>,
            markings: new Set<string>(),
            source_datasource_id: c.datasource_id,
            source_transaction_id: row.source_transaction_id,
            source_timestamp: row.source_commit_timestamp,
            tombstoned: false,
          };
      // Only copy properties THIS datasource owns — column-wise MDO.
      for (const prop of c.owned_properties) {
        if (prop in row.properties) next.properties[prop] = row.properties[prop];
      }
      for (const m of c.markings) next.markings.add(m);
      next.source_datasource_id = c.datasource_id;
      next.source_transaction_id = row.source_transaction_id;
      next.source_timestamp = row.source_commit_timestamp;
      next.tombstoned = false;
      sourceState.set(row.primary_key, next);
    }
  }

  // The set of PKs the merge output touches: any PK with a source
  // change OR a pending edit. We also overlay existing state for PKs
  // that have a pending edit but no source row (user-only edits).
  const pksTouched = new Set<string>([
    ...sourceState.keys(),
    ...editsByKey.keys(),
  ]);

  const existing = input.existingInstances ?? (await loadExistingInstances(
    input.ontologyId, input.objectTypeApiName, Array.from(pksTouched)
  ));

  const upserts: UpsertInstanceInput[] = [];
  const deletes: string[] = [];
  const mergedRows: MergeResult["mergedRows"] = [];

  for (const pk of pksTouched) {
    const src = sourceState.get(pk);
    const ex = existing[pk];
    const edit = editsByKey.get(pk);

    if (src?.tombstoned && (!edit || edit.operation === "delete")) {
      // Source deleted and no counter-edit — delete from instance table.
      deletes.push(pk);
      mergedRows.push({
        primary_key: pk,
        properties: {},
        markings: [],
        operation: "delete",
        source_datasource_id: src.source_datasource_id,
        source_transaction_id: src.source_transaction_id,
      });
      continue;
    }

    if (!src && edit?.operation === "delete") {
      deletes.push(pk);
      mergedRows.push({
        primary_key: pk,
        properties: {},
        markings: [],
        operation: "delete",
        source_datasource_id: null,
        source_transaction_id: null,
      });
      continue;
    }

    const baseProps = src?.properties ?? ex?.properties ?? {};
    const sourceTs = src?.source_timestamp ?? null;
    const finalProps: Record<string, unknown> = { ...baseProps };

    if (edit && edit.operation !== "delete") {
      for (const [prop, entry] of edit.perProp) {
        finalProps[prop] = resolveProperty(
          finalProps[prop],
          sourceTs,
          entry,
          input.editStrategy
        );
      }
    }

    // PB-B7 — route through the shared union helper so the Pipeline
    // Builder deploy and the Funnel merge stage cannot drift on the
    // "effective markings = ⋃ contributing datasources" invariant.
    const finalMarkings = unionMarkings(src?.markings, ex?.markings);

    upserts.push({
      ontology_id: input.ontologyId,
      object_type_api_name: input.objectTypeApiName,
      primary_key: pk,
      properties: finalProps,
      markings: finalMarkings,
      source_datasource_id: src?.source_datasource_id ?? ex?.source_datasource_id ?? null,
      source_transaction_id: src?.source_transaction_id ?? ex?.source_transaction_id ?? null,
    });
    mergedRows.push({
      primary_key: pk,
      properties: finalProps,
      markings: finalMarkings,
      operation: "upsert",
      source_datasource_id: src?.source_datasource_id ?? ex?.source_datasource_id ?? null,
      source_transaction_id: src?.source_transaction_id ?? ex?.source_transaction_id ?? null,
    });
  }

  // Commit B1 (object_instances) + B2 (merged snapshot) + stamp edits —
  // all inside a single DB transaction so a crash between them can't
  // leave the tables out of sync.
  const client = await getClient();
  const editIdsToStamp: string[] = [];
  for (const bucket of editsByKey.values()) editIdsToStamp.push(...bucket.editIds);

  try {
    await client.query("BEGIN");
    if (upserts.length > 0) await bulkUpsertInstances(upserts, client);
    for (const pk of deletes) {
      await deleteInstance(input.ontologyId, input.objectTypeApiName, pk, client);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // PASS-BY-REFERENCE (Option 2): persist merged rows to a Parquet object
  // in MinIO; the merged snapshot's `summary_json` carries only a small
  // `parquet_ref` (NOT the rows inline). The previous `inline_rows` jsonb
  // INSERT crashed the Postgres backend at ~573 MB for 1M rows; the
  // Parquet object is N-independent on the Postgres side. The Indexing
  // stage re-reads via `loadMergedRowsFromSnapshot(mergedSnapshotId)`.
  // Pre-generate the merged snapshot id so the MinIO Parquet object is
  // keyed by it before the Postgres row commits (write-parquet-first).
  const preMergedSnapshotId = newSnapshotId();
  const parquetKey = mergedParquetKey(input.objectTypeApiName, preMergedSnapshotId);
  const mergedRowIterable = (async function* () {
    for (const r of mergedRows) {
      yield {
        primary_key: r.primary_key,
        properties: JSON.stringify(r.properties),
        markings: JSON.stringify(r.markings),
        operation: r.operation,
        source_datasource_id: r.source_datasource_id ?? "",
        source_transaction_id: r.source_transaction_id ?? "",
      };
    }
  })();
  let mergedParquetRef: ParquetRef | null = null;
  try {
    mergedParquetRef = await writeParquetRef({
      columns: MERGED_PARQUET_COLUMNS,
      rows: mergedRowIterable,
      key: parquetKey,
      objectTypeApiName: input.objectTypeApiName,
      stage: "merged",
    });
  } catch (err) {
    await deleteOrphanParquetRef(mergedParquetRef);
    throw err;
  }

  const manifest: ManifestEntry[] = mergedParquetRef
    ? [
        {
          file_path: parquetRefToUri(mergedParquetRef),
          file_size_bytes: mergedParquetRef.sizeBytes,
          row_count: mergedParquetRef.rowCount,
          operation: "added",
        },
      ]
    : [
        {
          file_path: input.mergedOutputFileLocation,
          file_size_bytes: 0,
          row_count: 0,
          operation: "added",
        },
      ];

  let snapshot;
  try {
    snapshot = await commitSnapshot({
      tableId: input.mergedTableId,
      operation: "overwrite",
      manifest,
      snapshotId: preMergedSnapshotId,
      summary: {
        upserts: upserts.length,
        deletes: deletes.length,
        edits_consumed: editIdsToStamp.length,
        edit_strategy: input.editStrategy,
        contributions: input.contributions.map((c) => c.datasource_id),
        // Small, N-independent reference — replaces the old `inline_rows`.
        // `loadMergedRowsFromSnapshot` resolves it back to rows.
        parquet_ref: mergedParquetRef,
      },
    });
  } catch (err) {
    await deleteOrphanParquetRef(mergedParquetRef);
    throw err;
  }

  // AFTER the snapshot commits, stamp the edits. Per the spec this must
  // be an activity call, not a workflow call, because activities are
  // the retry-safe boundary — if this fails the workflow will retry and
  // the UPDATE is idempotent (WHERE applied_to_merged_at IS NULL).
  await markEditsAppliedToMerge(editIdsToStamp);

  return {
    snapshotId: snapshot.snapshot_id,
    upserts: upserts.length,
    deletes: deletes.length,
    editsConsumed: editIdsToStamp.length,
    mergedRows,
    parquetRef: mergedParquetRef,
  };
}

// ---------------------------------------------------------------------------
// DuckDB SQL k-way merge — flat-memory, scales to 4.65M+ rows (OO7) without
// materialising the merged rows / sourceState / upserts JS arrays that wall
// the pure-TS {@link mergeChanges} path. This is the Phase 1 streaming merge.
//
// SEMANTICS (verified 1:1 against {@link mergeChanges}): per-PK column-wise
// overlay since the last global DELETE (tombstone carry-forward), markings
// union across every contributing row (DELETE carries forward), source info =
// last row's, edits applied AFTER the source overlay per the conflict
// strategy, tombstone-without-counter-edit / user-only-delete → DELETE.
//
// The DuckDB binding's `streamQuery` (async-iterable `.stream`) keeps memory
// flat while routing `merged_result` to batched PG upserts + batched deletes
// inside ONE transaction (matches {@link mergeChanges}'s atomicity). The
// `runKey` (threaded from {@link runMergeActivity}) keys a Redis checkpoint so
// a retry that crashed AFTER the PG COMMIT skips the re-upsert (the committed
// rows are already in object_instances); mid-transaction crashes redo the
// tail (idempotent — ON CONFLICT DO UPDATE / WHERE pk = ANY). See
// {@link mergeProgress} for the safety model.
//
// ASSUMPTION (design §6.1, common/production case): each contribution's
// `row.properties` already equals exactly its `owned_properties` keys (foundry:
// row = all CSV columns = owned; multi-datasource: each contributes its own CSV
// columns = its owned). Under that assumption `json_merge_patch` over the whole
// `properties` is exact (column-wise MDO → no key conflict across datasources).
// `validateColumnwiseMDO` is still called (the fail-fast guard) — it rejects a
// config where a property is owned by >1 datasource BEFORE this SQL runs.
// ---------------------------------------------------------------------------

/** A contribution staged as a parquet ref (NOT a row array) — the
 *  `mergeChangesSQL` input. Resolved from a changelog snapshot's
 *  `summary_json.parquet_ref` by {@link mergeChangesFromSnapshots}. */
interface SQLContribution {
  datasource_id: string;
  owned_properties: string[];
  markings: string[];
  /** The changelog parquet ref (downloaded to a LOCAL temp file — the host
   *  DuckDB httpfs cannot reach MinIO; see Phase 0 notes in
   *  funnelParquetStore). */
  parquetRef: ParquetRef;
  source_timestamps?: Record<string, string>;
}

export interface MergeSQLInput {
  ontologyId: string;
  objectTypeApiName: string;
  contributions: SQLContribution[];
  pendingEdits: OntologyEditRow[];
  editStrategy: EditStrategy;
  mergedTableId: string;
  mergedOutputFileLocation: string;
  /** Threads from {@link runMergeActivity}'s driving signal id; keys the
   *  Redis checkpoint. Omit in tests. */
  runKey?: string;
  /** Tests supply existing instances directly; production loads them batched
   *  from `object_instances` (flat memory — streamed, never a full N-element
   *  JS array). */
  existingInstances?: Record<string, ExistingInstance>;
}

/** Single-quote-doubling raw-SQL escape (same convention as runAll/queryAll). */
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
/** Build a VARCHAR[] literal from a JS string[] (empty → ARRAY[]::VARCHAR[]). */
function sqlVarcharArray(arr: string[]): string {
  if (arr.length === 0) return "ARRAY[]::VARCHAR[]";
  return `ARRAY[${arr.map(sqlStr).join(",")}]::VARCHAR[]`;
}

/** Download a parquet ref to a LOCAL temp file (host DuckDB httpfs can't reach
 *  MinIO — see {@link streamParquetRows}). Returns the local path; the caller
 *  owns the temp dir's lifecycle. */
async function downloadParquetRefToLocal(
  ref: ParquetRef,
): Promise<{ dir: string; localPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-changelog-"));
  const localPath = path.join(dir, "c.parquet");
  const stream = await getObjectStream(ref.key);
  await pipeline(stream, fs.createWriteStream(localPath));
  return { dir, localPath };
}

/** Staging gate: the staged set must equal the merged tail exactly —
 *  same cardinality, all-distinct PKs, no null/empty keys. Throws (live
 *  table untouched) on any deviation. Exported for unit tests. */
export function assertStagedTail(
  staged: StagingVerification,
  tailRowCount: number,
  objectTypeApiName: string,
): void {
  const where = `staging verification for ${objectTypeApiName}`;
  if (staged.staged !== tailRowCount) {
    throw new Error(
      `[merge-sql] ${where} failed: staged=${staged.staged} expected tail=${tailRowCount}`,
    );
  }
  if (staged.distinctPk !== staged.staged) {
    throw new Error(
      `[merge-sql] ${where} failed: distinctPk=${staged.distinctPk} staged=${staged.staged} (duplicate PKs in staging)`,
    );
  }
  if (staged.nullPk !== 0 || staged.emptyPk !== 0) {
    throw new Error(
      `[merge-sql] ${where} failed: nullPk=${staged.nullPk} emptyPk=${staged.emptyPk}`,
    );
  }
}

/** Key-order-independent JSON serialisation (objects' keys sorted
 *  recursively; arrays keep their order). Exported for unit tests. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value === undefined ? null : value));
}

/**
 * 1 000-row field-by-field sample: the first 1 000 staged PKs (ordered)
 * must match the merged parquet on operation + properties + markings.
 * Catches a corrupt staging load that the counts alone would miss.
 */
async function verifyStagedSample(
  conn: DuckDBConnection,
  client: PoolClient,
  tailFile: string,
  scope: StagingScope,
): Promise<void> {
  const lp = tailFile.replace(/'/g, "''");
  const sample = await queryAll<Record<string, unknown>>(
    conn,
    `SELECT primary_key, CAST(properties AS VARCHAR) AS properties,
            to_json(markings) AS markings, operation
       FROM read_parquet('${lp}')
       ORDER BY primary_key LIMIT 1000`,
  );
  if (sample.length === 0) return;
  const pks = sample.map((r) => String(r.primary_key));
  const res = await client.query(
    `SELECT primary_key, operation, properties, markings
       FROM merge_staging_instances
      WHERE staging_run_id = $1
        AND ontology_id = $2 AND object_type_api_name = $3
        AND primary_key = ANY($4::text[])`,
    [scope.stagingRunId, scope.ontologyId, scope.objectTypeApiName, pks],
  );
  const byPk = new Map<string, Record<string, unknown>>();
  for (const r of res.rows as Record<string, unknown>[]) {
    byPk.set(String(r.primary_key), r);
  }
  const normMarkings = (v: unknown): string[] => {
    if (Array.isArray(v)) return (v as unknown[]).map(String).sort();
    try {
      const p = JSON.parse(String(v ?? "[]"));
      return Array.isArray(p) ? p.map(String).sort() : [];
    } catch {
      return [];
    }
  };
  for (const r of sample) {
    const pk = String(r.primary_key);
    const s = byPk.get(pk);
    if (!s) {
      throw new Error(
        `[merge-sql] staging sample failed for ${scope.objectTypeApiName}: pk ${pk} missing from staging`,
      );
    }
    const wantOp = r.operation === "delete" ? "delete" : "upsert";
    if (s.operation !== wantOp) {
      throw new Error(
        `[merge-sql] staging sample failed for ${scope.objectTypeApiName}: pk ${pk} operation staged=${s.operation} parquet=${r.operation}`,
      );
    }
    const wantProps = JSON.parse(String(r.properties ?? "{}")) as unknown;
    // Postgres jsonb does NOT preserve object key order (it stores keys
    // shortest-first), so a raw JSON.stringify comparison falsely rejected
    // every row whose columns were not already in jsonb order (e.g. CSV
    // header `id,name,qty` comes back as `id,qty,name`). Compare a
    // key-order-independent canonical form instead.
    if (canonicalJson(s.properties) !== canonicalJson(wantProps)) {
      throw new Error(
        `[merge-sql] staging sample failed for ${scope.objectTypeApiName}: pk ${pk} properties differ`,
      );
    }
    const gotM = normMarkings(s.markings);
    const wantM = normMarkings(r.markings);
    if (JSON.stringify(gotM) !== JSON.stringify(wantM)) {
      throw new Error(
        `[merge-sql] staging sample failed for ${scope.objectTypeApiName}: pk ${pk} markings differ`,
      );
    }
  }
}

/**
 * Run merge steps 2–8 in a separate DuckDB CLI process and re-attach the
 * prefix outputs in-process. The CLI work dir holds script.sql, stdout.log,
 * stderr.log and the three prefix parquets. On CLI failure the dir is KEPT
 * for forensics (the error carries its path); on success the parquets are
 * materialized as temp tables by the attach statements and the dir is
 * deleted immediately after — prefix outputs never outlive the attach.
 *
 * Exported for tests (cross-process glue test).
 */
export async function runMergePrefixOutOfProcess(
  input: MergeSQLInput,
  prefixArgs: {
    contributions: SQLContribution[];
    localPaths: string[];
    editOpsRows: string[];
    editPropsRows: string[];
  },
  conn: DuckDBConnection,
  opts?: {
    /** Test hook: replaces the DuckDB CLI command (cf. runDuckDbCliScript). */
    command?: string[];
    /** funnel_state lock key for progress reports; null skips them. */
    leaseObjectTypeId?: string | null;
  },
): Promise<void> {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-"));
  const spillDir = path.join(cliDir, "spill");
  const settings = resolveCliSettings(
    spillDir,
    process.env.DUCKDB_HOME_DIRECTORY ?? "/tmp/tellus-duckdb",
  );
  const scriptText =
    cliSettingsPreamble(settings) +
    [
      ...buildMergePrefixStatements(prefixArgs),
      ...buildPrefixExportStatements(cliDir),
    ].join(";\n") +
    ";\n";
  // Throttled movement reports to the indexing lease: the watchdog polls
  // every ~2 s, but a PG UPDATE per poll is wasteful — 15 s granularity is
  // plenty for a 10-minute stall budget. Fire-and-forget: lease reporting
  // must never fail (or slow) the merge it observes.
  let lastLeaseReport = 0;
  const res = await runDuckDbCliScript({
    scriptText,
    workDir: cliDir,
    spillDir,
    command: opts?.command,
    watchPaths: PREFIX_EXPORT_FILES.map((f) => path.join(cliDir, f)),
    onProgress: (p) => {
      // Liveness evidence, not just process-alive: bytes on disk. A wedged
      // child stops growing spill/outputs and the watchdog kills it.
      reportStageProgress(
        `merge cli-prefix spillBytes=${p.spillBytes} wallMs=${p.wallMs}`,
      );
      if (opts?.leaseObjectTypeId && Date.now() - lastLeaseReport > 15_000) {
        lastLeaseReport = Date.now();
        void bestEffortLease(
          () => reportIndexingProgress(opts.leaseObjectTypeId as string),
          "progress",
        );
      }
    },
  });
  console.log(
    `[merge-sql] ${input.objectTypeApiName} cli prefix ` +
      `wallMs=${res.wallMs} peakSpillBytes=${res.peakSpillBytes}`,
  );
  for (const stmt of buildPrefixAttachStatements(cliDir)) {
    await runAll(conn, stmt);
  }
  try {
    fs.rmSync(cliDir, { recursive: true, force: true });
  } catch {
    /* ignore — /tmp reaps it */
  }
}

/**
 * DuckDB SQL k-way merge. Builds the per-PK overlay (tombstone carry-forward +
 * markings union + source info + edits overlay) entirely in SQL, COPYs the
 * merged result straight to a local parquet (flat memory — DuckDB streams the
 * write), uploads it to MinIO (the merged parquet_ref), then streams
 * `merged_result` to batched PG upserts + deletes inside ONE transaction.
 *
 * `mergedRows` is NOT materialised (the rows live in the returned
 *  `parquetRef`; {@link loadMergedRowsFromSnapshot} / {@link streamParquetRows}
 *  re-read them). This is the pass-by-reference contract.
 *
 *  The PG tail is staging + promote (see mergeStaging.ts): the merged rows
 *  load into merge_staging_instances first, count/distinct/sample checks
 *  run, and only then does a single transaction promote into the live
 *  object_instances. A failed run leaves the live table unchanged.
 *
 * Steps 2–8 (the pure-SQL prefix) execute either in-process or in
 * a separate DuckDB CLI process (versioned funnelRuntime.mergeOutOfProcess) — see
 * {@link runMergePrefixOutOfProcess}. Statement text is shared.
 */
export async function mergeChangesSQL(input: MergeSQLInput): Promise<MergeResult> {
  validateColumnwiseMDO(
    input.contributions.map((c) => ({
      datasource_id: c.datasource_id,
      owned_properties: c.owned_properties,
      changelog_rows: [],
      markings: c.markings,
    })) as DatasourceContribution[],
  );

  // Index edits per (primary_key, property_api_name) into edit_seq-tagged rows
  // (edit_seq = pendingEdits input-array index — the JS `perProp.set` overwrites
  // in input-array order, so `ORDER BY edit_seq DESC` = last-in-array wins;
  // bucket.operation strict-`>` tiebreak → `ORDER BY created_at DESC, edit_seq ASC`
  // = earliest-array wins on a timestamp tie).
  const editOpsRows: string[] = [];
  const editPropsRows: string[] = [];
  input.pendingEdits.forEach((e, seq) => {
    editOpsRows.push(
      `(${sqlStr(e.primary_key)},${sqlStr(e.operation)},${sqlStr(e.executed_at)},${seq})`,
    );
    if (e.operation !== "delete" && e.property_values) {
      for (const [prop, val] of Object.entries(e.property_values)) {
        editPropsRows.push(
          `(${sqlStr(e.primary_key)},${sqlStr(prop)},${sqlStr(
            JSON.stringify(val),
          )},${sqlStr(e.executed_at)},${seq})`,
        );
      }
    }
  });

  // 1. Download each contribution's changelog parquet to a LOCAL temp file.
  const downloads = await Promise.all(
    input.contributions.map((c) => downloadParquetRefToLocal(c.parquetRef)),
  );

  // Steps 2–8 (pure-SQL prefix) run either in-process (default — today's
  // path) or in a separate DuckDB CLI process
  // (versioned funnelRuntime.mergeOutOfProcess). Statement text is shared via
  // mergePrefixSql: a single source of SQL for both executors, so a change
  // to the merge logic cannot diverge between them.
  const prefixArgs = {
    contributions: input.contributions,
    localPaths: downloads.map((d) => d.localPath),
    editOpsRows,
    editPropsRows,
  };
  let mergePath = "duckdb_sql";

  const conn = await acquireConnection({ skipHttpfs: true });
  const preMergedSnapshotId = newSnapshotId();
  const mergedKey = mergedParquetKey(input.objectTypeApiName, preMergedSnapshotId);
  const mergedDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-out-"));
  const localMergedFile = path.join(mergedDir, "merged.parquet");

  let mergedRowCount = 0;
  let activeRowCount = 0;
  let mergedParquetRef: ParquetRef | null = null;
  let upserts = 0;
  let deletes = 0;
  let lastPk: string | null = null;
  let rowsProcessed = 0;
  try {
    // Steps 2–8 execute here. In-process (default): today's path, one
    // statement at a time. Out-of-process (versioned flag on):
    // the same statements run in a separate DuckDB CLI process and the
    // prefix outputs cross back as parquet files.
    //
    // Lease signalling (indexingLease): the holder refreshes the lock
    // heartbeat at every stage boundary and reports movement from the
    // long phases, so the stall watchdog can tell alive-but-stuck from
    // alive-and-moving. Best-effort throughout — signalling never fails
    // the merge it observes.
    const leaseObjectTypeId = await resolveLeaseObjectTypeId(
      input.ontologyId,
      input.objectTypeApiName,
    ).catch((err: unknown) => {
      console.warn(
        `[merge-sql] lease resolve failed: ${(err as Error).message}`,
      );
      return null;
    });
    // Fast path: a single contribution whose changelog parquet provably
    // holds distinct non-null, non-empty PKs skips the dedup sort entirely
    // — the sort removes zero rows on such input (measured: the 6.36M-row
    // changelog was already deduped) while costing 46 s + 4 GiB of spill.
    // The precheck is re-run per merge, never cached: it is what makes
    // skipping safe. A precheck failure falls through to the general path
    // (which will surface the real error loudly); only a PASS skips.
    let fastPath = false;
    if (isFastPathEnabled() && input.contributions.length === 1) {
      try {
        const preRows = await queryAll<Record<string, string>>(
          conn,
          buildFastPathPrecheckStatement(downloads[0].localPath),
        );
        const pre: FastPathPrecheck = {
          total: Number(preRows[0]?.total ?? -1),
          distinctPk: Number(preRows[0]?.distinct_pk ?? -1),
          nullPk: Number(preRows[0]?.null_pk ?? -1),
          emptyPk: Number(preRows[0]?.empty_pk ?? -1),
        };
        if (isFastPathPrecheckPass(pre)) {
          fastPath = true;
          mergePath = "duckdb_sql_fast";
          console.log(
            `[merge-sql] ${input.objectTypeApiName} fast path: single ` +
              `contribution, unique PKs total=${pre.total} — skipping dedup sort`,
          );
          await runAll(
            conn,
            buildFastSourceStateStatement(
              downloads[0].localPath,
              input.contributions[0].datasource_id,
              input.contributions[0].markings,
            ),
          );
          // Step 8 still runs: downstream (existing-load, merged_result)
          // reads edit_bucket + edit_props_latest.
          for (const stmt of buildEditStatements(
            prefixArgs.editOpsRows,
            prefixArgs.editPropsRows,
          )) {
            await runAll(conn, stmt);
          }
        }
      } catch (err) {
        // Precheck is an optimization: its own failure must not fail the
        // merge. The general path below will hit the same parquet and
        // surface the real error.
        console.warn(
          `[merge-sql] ${input.objectTypeApiName} fast-path precheck failed, ` +
            `taking general path: ${(err as Error).message}`,
        );
      }
    }
    if (!fastPath) {
      // Bucket planning from contribution row counts (changelog manifest
      // metadata — no extra scan). Unknown counts plan a single bucket.
      const bucketPlan = planBucketCount(
        input.contributions.map((c) => c.parquetRef?.rowCount),
      );
      if (bucketPlan.bucketCount > 1) {
        const oop = await shouldUseOutOfProcessMerge();
        mergePath = oop.outOfProcess
          ? "duckdb_sql_bucketed_cli"
          : "duckdb_sql_bucketed";
        const res = await runBucketedMergePrefix({
          objectTypeApiName: input.objectTypeApiName,
          snapshotId: preMergedSnapshotId,
          contributions: input.contributions,
          localPaths: downloads.map((d) => d.localPath),
          singleContribution: input.contributions.length === 1,
          bucketCount: bucketPlan.bucketCount,
          runKey: input.runKey ?? null,
          conn,
          outOfProcess: oop.outOfProcess,
          onBucketComplete: (b, n) => {
            reportStageProgress(`merge bucket ${b + 1}/${n} complete`);
            if (leaseObjectTypeId) {
              void bestEffortLease(
                () => reportIndexingProgress(leaseObjectTypeId),
                "progress-bucket",
              );
            }
          },
        });
        console.log(
          `[merge-sql] ${input.objectTypeApiName} bucketed prefix ` +
            `buckets=${res.bucketCount} skipped=${res.skipped} computed=${res.computed}`,
        );
        // Step 8 still runs: downstream (existing-load, merged_result)
        // reads edit_bucket + edit_props_latest.
        for (const stmt of buildEditStatements(
          prefixArgs.editOpsRows,
          prefixArgs.editPropsRows,
        )) {
          await runAll(conn, stmt);
        }
      } else {
        const oop = await shouldUseOutOfProcessMerge();
        if (oop.outOfProcess) {
          mergePath = "duckdb_sql_cli";
          await runMergePrefixOutOfProcess(input, prefixArgs, conn, {
            leaseObjectTypeId,
          });
        } else {
          // Narrow-key dedup is the default SQL shape; the legacy wide sort
          // runs only under MERGE_NARROW_DEDUP=0.
          mergePath = isNarrowDedupEnabled()
            ? "duckdb_sql_narrow"
            : "duckdb_sql";
          for (const stmt of buildMergePrefixStatements(prefixArgs)) {
            await runAll(conn, stmt);
          }
        }
      }
    }
    if (leaseObjectTypeId) {
      await bestEffortLease(
        () => touchIndexingLock(leaseObjectTypeId),
        "heartbeat-prefix",
      );
    }

    // 9. existing instances — batched from PG (flat memory; ~5000/chunk on the
    //    idx_object_instances_ot_pk index — Phase 0 migration 109). For OO7's
    //    FIRST merge object_instances=0 → EXISTS check short-circuits (empty
    //    temp table; every LEFT JOIN below degrades to NULL cleanly). Tests
    //    supply `existingInstances` directly. edit_bucket now exists for the
    //    touched-PK set (source_state ∪ edit_bucket).
    await runAll(
      conn,
      `CREATE OR REPLACE TEMP TABLE existing (
        primary_key VARCHAR, properties VARCHAR, markings VARCHAR[],
        source_datasource_id VARCHAR, source_transaction_id VARCHAR
      )`,
    );
    if (input.existingInstances && Object.keys(input.existingInstances).length > 0) {
      const entries = Object.entries(input.existingInstances);
      for (let i = 0; i < entries.length; i += 500) {
        const chunk = entries.slice(i, i + 500);
        const vals = chunk
          .map(([pk, ex]) =>
            `(${sqlStr(pk)},${sqlStr(JSON.stringify(ex.properties))},${sqlVarcharArray(
              ex.markings ?? [],
            )},${sqlStr(ex.source_datasource_id ?? "")},${sqlStr(
              ex.source_transaction_id ?? "",
            )})`,
          )
          .join(",");
        await runAll(conn, `INSERT INTO existing VALUES ${vals}`);
      }
    } else if (!input.existingInstances) {
      // Production: batched load. Stream the touched PK set from DuckDB (flat
      // memory), chunk into PG WHERE primary_key = ANY($chunk). An EXISTS check
      // short-circuits the first merge (object_instances=0 for the OT).
      // EXISTS (LIMIT 1) — O(1) early-row probe vs count(*)'s O(N) full seq
      // scan. The hasExisting check only needs >0, not the exact count.
      // EXPLAIN ANALYZE on OO2 (4.66M existing rows): count(*) = 43,400ms
      // (Parallel Seq Scan, 6.8GB read — exceeded the 60s statement_timeout
      // under merge load); EXISTS = 0.103ms (LIMIT 1 stops at the first match).
      // The filter is high-selectivity (4.66M/6.35M rows) so the planner
      // correctly prefers a seq scan over an index either way — an index would
      // NOT fix count(*); only avoiding the full count does.
      const hasExisting = await query(
        `SELECT EXISTS (SELECT 1 FROM object_instances
          WHERE ontology_id = $1 AND object_type_api_name = $2 LIMIT 1) AS exists`,
        [input.ontologyId, input.objectTypeApiName],
      );
      if (hasExisting.rows[0]?.exists) {
        // COPY the touched PK set to a local pk-sorted parquet ONCE, then keyset
        // queryAll. NO DuckDB stream — a streamQuery here + the per-batch
        // `await query` (PG loadExistingInstances) interleaves a DuckDB pending
        // result with a long PG await, which the duckdb node binding closes
        // ("Attempting to execute an unsuccessful or closed pending query
        // result") under PG pressure (slow upserts/loads → long awaits). This
        // path fires on RE-merges (existing > 0 — every Save after the first);
        // the first merge (existing=0) short-circuits above. queryAll
        // materializes each 5000-PK batch + closes its result BEFORE the PG
        // await. The parquet is pk-sorted so the keyset range scan is O(batch).
        const pkDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-pks-"));
        const pkFile = path.join(pkDir, "pks.parquet");
        try {
          const pkf = pkFile.replace(/'/g, "''");
          await runAll(
            conn,
            `COPY (
              SELECT primary_key FROM (
                SELECT primary_key FROM source_state
                UNION
                SELECT primary_key FROM edit_bucket
              ) ORDER BY primary_key
            ) TO '${pkf}' (FORMAT PARQUET, CODEC 'ZSTD')`,
          );
          // NDJSON spool + ONE read_json insert. The prior path re-inserted
          // PG rows into DuckDB as 500-row VALUES literals — ~9,300 statement
          // parses of ~1MB SQL each on a 4.66M-row OT (minutes of pure SQL
          // parsing). Spooling to newline-delimited JSON and loading with a
          // single read_json is one parse and one columnar ingest.
          const tExisting = Date.now();
          const existingNdjson = path.join(pkDir, "existing.ndjson");
          let existingRows = 0;
          // Dedicated client with a raised statement_timeout: a cold-cache
          // ANY(20k) fetch on a multi-million-row OT can exceed the global
          // 60s statement_timeout (observed: two merge attempts cancelled at
          // ~60s each before the buffer cache warmed). RESET before release
          // so the pooled session doesn't leak the looser budget.
          const loadClient = await getClient();
          await loadClient.query("SET statement_timeout = '300s'");
          const pkBuf: string[] = [];
          const flushExisting = async (): Promise<void> => {
            if (pkBuf.length === 0) return;
            const res = await loadClient.query(
              `SELECT primary_key, properties, markings, source_datasource_id, source_transaction_id
                 FROM object_instances
                WHERE ontology_id = $1 AND object_type_api_name = $2
                  AND primary_key = ANY($3::text[])`,
              [input.ontologyId, input.objectTypeApiName, pkBuf.splice(0)],
            );
            if (res.rows.length === 0) return;
            const lines = res.rows.map((r) =>
              JSON.stringify({
                primary_key: String(r.primary_key),
                properties: JSON.stringify(r.properties ?? {}),
                markings: (r.markings ?? []) as string[],
                source_datasource_id:
                  (r.source_datasource_id as string | null) ?? "",
                source_transaction_id:
                  (r.source_transaction_id as string | null) ?? "",
              }),
            );
            fs.appendFileSync(existingNdjson, lines.join("\n") + "\n");
            existingRows += res.rows.length;
          };
          try {
            let pkAfter = "";
            for (;;) {
              const batch = await queryAll<{ primary_key: string }>(
                conn,
                `SELECT primary_key FROM read_parquet('${pkf}')
                 ${pkAfter ? `WHERE primary_key > ${sqlStr(pkAfter)}` : ""}
                 ORDER BY primary_key LIMIT 20000`,
              );
              if (batch.length === 0) break;
              for (const row of batch) pkBuf.push(String(row.primary_key));
              if (pkBuf.length >= 20000) await flushExisting();
              pkAfter = String(batch[batch.length - 1].primary_key);
            }
            await flushExisting();
          } finally {
            try {
              await loadClient.query("RESET statement_timeout");
            } finally {
              loadClient.release();
            }
          }
          if (existingRows > 0) {
            const nd = existingNdjson.replace(/'/g, "''");
            await runAll(
              conn,
              `INSERT INTO existing
               SELECT primary_key, properties, markings,
                      source_datasource_id, source_transaction_id
               FROM read_json('${nd}', format = 'newline_delimited',
                 columns = {primary_key: 'VARCHAR', properties: 'VARCHAR',
                            markings: 'VARCHAR[]',
                            source_datasource_id: 'VARCHAR',
                            source_transaction_id: 'VARCHAR'})`,
            );
          }
          console.log(
            `[merge-sql] ${input.objectTypeApiName} existing-load rows=${existingRows} durMs=${Date.now() - tExisting}`,
          );
        } finally {
          try {
            fs.rmSync(pkDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (leaseObjectTypeId) {
      await bestEffortLease(
        () => touchIndexingLock(leaseObjectTypeId),
        "heartbeat-existing",
      );
    }

    // 10. merged_result — the final per-PK resolution. Edits overlay
    //     (resolveProperty) applied AFTER source overlay, per PK. The `<STRATEGY>`
    //     literal inlines user_edit_wins (always include edited prop) vs
    //     latest_wins (include only when edit.created_at > source_timestamp).
    await runAll(
      conn,
      `CREATE OR REPLACE TEMP TABLE merged_result AS
      WITH pks AS (
        SELECT primary_key FROM source_state
        UNION
        SELECT primary_key FROM edit_bucket
      ),
      all_markings AS (
        SELECT primary_key,
          COALESCE(
            array_sort(array_agg(DISTINCT trim(m))
              FILTER (WHERE m IS NOT NULL AND trim(m) <> '')),
            ARRAY[]::VARCHAR[]
          ) AS markings
        FROM (
          SELECT p.primary_key, unnest(s.markings) AS m
            FROM pks p LEFT JOIN source_state s ON s.primary_key = p.primary_key
          UNION ALL
          SELECT p.primary_key, unnest(e.markings) AS m
            FROM pks p LEFT JOIN existing e ON e.primary_key = p.primary_key
        ) GROUP BY primary_key
      ),
      overrides AS (
        SELECT ep.primary_key, json_group_object(ep.prop, ep.value::JSON) AS ov
        FROM edit_props_latest ep
        JOIN edit_bucket eb ON eb.primary_key = ep.primary_key
        LEFT JOIN source_state s ON s.primary_key = ep.primary_key
        WHERE eb.edit_op IS DISTINCT FROM 'delete'
          AND ( ${sqlStr(input.editStrategy)} = 'user_edit_wins'
                OR s.source_timestamp IS NULL
                OR ep.created_at > s.source_timestamp )
        GROUP BY ep.primary_key
      )
      SELECT
        p.primary_key,
        CASE
          WHEN (s.tombstoned AND (eb.edit_op IS NULL OR eb.edit_op = 'delete'))
            OR (s.primary_key IS NULL AND eb.edit_op = 'delete')
          THEN 'delete' ELSE 'upsert'
        END AS operation,
        CASE
          WHEN (s.tombstoned AND (eb.edit_op IS NULL OR eb.edit_op = 'delete'))
            OR (s.primary_key IS NULL AND eb.edit_op = 'delete')
          THEN '{}'::JSON
          ELSE json_merge_patch(
            COALESCE(s.properties, e.properties::JSON, '{}'::JSON),
            COALESCE(ov.ov, '{}'::JSON))
        END AS properties,
        CASE
          WHEN (s.tombstoned AND (eb.edit_op IS NULL OR eb.edit_op = 'delete'))
            OR (s.primary_key IS NULL AND eb.edit_op = 'delete')
          THEN ARRAY[]::VARCHAR[]
          ELSE COALESCE(am.markings, ARRAY[]::VARCHAR[])
        END AS markings,
        COALESCE(s.source_datasource_id, e.source_datasource_id)   AS source_datasource_id,
        COALESCE(s.source_transaction_id, e.source_transaction_id) AS source_transaction_id
      FROM pks p
      LEFT JOIN source_state s  ON s.primary_key  = p.primary_key
      LEFT JOIN existing e      ON e.primary_key  = p.primary_key
      LEFT JOIN edit_bucket eb  ON eb.primary_key = p.primary_key
      LEFT JOIN overrides ov    ON ov.primary_key = p.primary_key
      LEFT JOIN all_markings am ON am.primary_key = p.primary_key`,
    );

    // 11. Row count (CAST to VARCHAR — the v1.4.4 binding surfaces BIGINT as
    //     BigInt which queryAll can't serialise; VARCHAR round-trips to Number).
    const countRes = await queryAll<{ c: string }>(
      conn,
      `SELECT CAST(count(*) AS VARCHAR) AS c FROM merged_result`,
    );
    mergedRowCount = Number(countRes[0]?.c ?? 0);
    const activeCountRes = await queryAll<{ c: string }>(
      conn,
      `SELECT CAST(count(*) AS VARCHAR) AS c
         FROM merged_result
        WHERE operation IS DISTINCT FROM 'delete'`,
    );
    activeRowCount = Number(activeCountRes[0]?.c ?? 0);
    console.log(
      `[merge-sql] ${input.objectTypeApiName} merged_result rows=${mergedRowCount} active=${activeRowCount}`,
    );

    // 12. COPY the merged result straight to a local parquet (flat memory —
    //     DuckDB streams the write). ORDER BY primary_key so the resume query is
    //     pk-sorted. Columns match MERGED_PARQUET_COLUMNS; properties/markings
    //     emitted as JSON text, source ids as '' for null (round-trips via the
    //     existing parseJsonColumn/parseJsonArrayColumn loaders).
    if (mergedRowCount > 0) {
      const lp = localMergedFile.replace(/'/g, "''");
      await runAll(
        conn,
        `COPY (
          SELECT primary_key,
                 CAST(properties AS VARCHAR)            AS properties,
                 to_json(markings)                       AS markings,
                 operation,
                 COALESCE(source_datasource_id,   '')   AS source_datasource_id,
                 COALESCE(source_transaction_id, '')   AS source_transaction_id
          FROM merged_result ORDER BY primary_key
        ) TO '${lp}' (FORMAT PARQUET, CODEC 'ZSTD', ROW_GROUP_SIZE 100000)`,
      );
    }

    if (leaseObjectTypeId) {
      await bestEffortLease(
        () => touchIndexingLock(leaseObjectTypeId),
        "heartbeat-merged",
      );
    }

    // 13. Upload the merged parquet to MinIO (the merged parquet_ref, like
    //     writeParquetRef but produced via DuckDB COPY). On failure the local
    //     file + any partial upload are best-effort cleaned (the key is the
    //     pre-generated snapshot id — an orphan is GC-able per the
    //     funnelParquetStore CONTRACT).
    try {
      if (mergedRowCount > 0) {
        const stat = fs.statSync(localMergedFile);
        const up = await uploadObject(
          mergedKey,
          fs.createReadStream(localMergedFile),
          "application/vnd.apache.parquet",
          undefined,
          stat.size,
        );
        mergedParquetRef = {
          refVersion: 1,
          bucket: up.bucket,
          key: up.key,
          rowCount: mergedRowCount,
          sizeBytes: up.size,
        };
      }
    } catch (err) {
      await deleteOrphanParquetRef(mergedParquetRef);
      throw err;
    }

    // 14. Stream merged_result to batched PG upserts + deletes inside ONE
    //     transaction (matches {@link mergeChanges}'s atomicity). Uses the SAME
    //     `conn` — merged_result is a per-connection temp table. Checkpoint
    //     keyed by runKey: committed=true after COMMIT lets a post-commit-crash
    //     retry SKIP the re-upsert; mid-transaction crash (committed=false)
    //     redoes the tail (idempotent).
    const checkpoint = input.runKey ? await readMergeProgress(input.runKey) : null;
    const skipPgTail = checkpoint?.committed === true;

    if (!skipPgTail && mergedRowCount > 0) {
      if (input.runKey) {
        await recordMergeProgress(input.runKey, {
          committed: false,
          lastPk: null,
          rowsProcessed: 0,
        });
      }

      // Delta vs the previous merged snapshot. Both parquets were produced by
      // THIS DuckDB pipeline (identical serialisation), so plain string
      // comparison is exact. Rows present in prev but absent from the new
      // merged_result were untouched this run and need no action. Any failure
      // here falls back to the full-rewrite tail — correctness is never gated
      // on the delta (and bulkUpsertInstances' IS DISTINCT FROM guard is the
      // PG-side safety net against false positives).
      let tailFile = localMergedFile;
      let tailRowCount = mergedRowCount;
      const materializedCountRes = await query(
        `SELECT count(*)::int AS n
           FROM object_instances
          WHERE ontology_id = $1 AND object_type_api_name = $2`,
        [input.ontologyId, input.objectTypeApiName],
      );
      const materializedRows = Number(materializedCountRes.rows[0]?.n ?? 0);
      const forceFullTail = requiresFullPgTail(activeRowCount, materializedRows);
      if (forceFullTail) {
        console.warn(
          `[merge-sql] ${input.objectTypeApiName} materialized-count drift ` +
            `expected=${activeRowCount} actual=${materializedRows} — full PG tail`,
        );
      }
      if (MERGE_DELTA && !forceFullTail) {
        try {
          const tDelta = Date.now();
          const prevRes = await query(
            `SELECT snapshot_id, summary_json FROM funnel_snapshot
              WHERE dataset_table_id = $1
                AND jsonb_typeof(summary_json->'parquet_ref') = 'object'
              ORDER BY committed_at DESC LIMIT 1`,
            [input.mergedTableId],
          );
          const prevRow = prevRes.rows[0] as
            | { snapshot_id: string; summary_json: Record<string, unknown> }
            | undefined;
          const prevRef = prevRow
            ? resolveParquetRef(prevRow.summary_json?.parquet_ref)
            : null;
          if (prevRef) {
            const prevDl = await downloadParquetRefToLocal(prevRef);
            downloads.push(prevDl); // freed by the existing finally
            const deltaFile = path.join(mergedDir, "delta.parquet");
            const np = localMergedFile.replace(/'/g, "''");
            const pp = prevDl.localPath.replace(/'/g, "''");
            const dp = deltaFile.replace(/'/g, "''");
            await runAll(
              conn,
              `COPY (
                SELECT m.primary_key, m.properties, m.markings, m.operation,
                       m.source_datasource_id, m.source_transaction_id
                FROM read_parquet('${np}') m
                LEFT JOIN read_parquet('${pp}') p
                  ON p.primary_key = m.primary_key
                WHERE p.primary_key IS NULL
                   OR m.operation             IS DISTINCT FROM p.operation
                   OR m.properties            IS DISTINCT FROM p.properties
                   OR m.markings              IS DISTINCT FROM p.markings
                   OR m.source_datasource_id  IS DISTINCT FROM p.source_datasource_id
                   OR m.source_transaction_id IS DISTINCT FROM p.source_transaction_id
                ORDER BY m.primary_key
              ) TO '${dp}' (FORMAT PARQUET, CODEC 'ZSTD', ROW_GROUP_SIZE 100000)`,
            );
            const dc = await queryAll<{ c: string }>(
              conn,
              `SELECT CAST(count(*) AS VARCHAR) AS c FROM read_parquet('${dp}')`,
            );
            tailRowCount = Number(dc[0]?.c ?? 0);
            tailFile = deltaFile;
            console.log(
              `[merge-sql] ${input.objectTypeApiName} delta merged=${mergedRowCount} ` +
                `changed=${tailRowCount} prevSnapshot=${prevRow!.snapshot_id} ` +
                `durMs=${Date.now() - tDelta}`,
            );
          } else {
            console.log(
              `[merge-sql] ${input.objectTypeApiName} no previous merged snapshot — full PG tail`,
            );
          }
        } catch (err) {
          console.warn(
            `[merge-sql] ${input.objectTypeApiName} delta failed (non-fatal — ` +
              `falling back to full PG tail): ${(err as Error).message}`,
          );
          tailFile = localMergedFile;
          tailRowCount = mergedRowCount;
        }
      }

      if (tailRowCount === 0) {
        console.log(
          `[merge-sql] ${input.objectTypeApiName} delta=0 — PG tail skipped`,
        );
        if (input.runKey) {
          await recordMergeProgress(input.runKey, {
            committed: true,
            lastPk: null,
            rowsProcessed: 0,
            upserts: 0,
            deletes: 0,
          });
        }
      } else {
      const tTail = Date.now();
      const batchSize = funnelRuntimeConfig().mergeBatchSize;
      const stagingScope = {
        ontologyId: input.ontologyId,
        objectTypeApiName: input.objectTypeApiName,
        stagingRunId: resolveStagingRunId(input.runKey, preMergedSnapshotId),
      };
      const client = await getClient();
      const stageBuf: StagedRowInput[] = [];
      let pgTailCommitted = false;
      // Phase 1 — load the merged tail into STAGING (never the live table).
      // A kill here rolls the staging transaction back; object_instances
      // is untouched until the verified promote in Phase 3.
      try {
        await client.query("BEGIN");
        await clearMergeStaging(client, stagingScope);
        // Batched queryAll over the LOCAL merged parquet (pk-sorted — the COPY
        // at step 12 wrote it ORDER BY primary_key). Keyset pagination
        // (WHERE primary_key > $last) — NOT a DuckDB stream. A stream
        // (streamQuery/conn.stream) leaves a "pending query result" open across
        // the per-batch `await bulkUpsertInstances` PG round-trips; under PG
        // pressure (slow upserts → long awaits) the duckdb node binding closes
        // that pending result → "Attempting to execute an unsuccessful or closed
        // pending query result" crash (flaky — succeeded when PG was fast).
        // queryAll materializes each 5000-row batch + closes its result BEFORE
        // the PG await, so there is no pending result to close. The keyset range
        // scan over a pk-sorted parquet is O(batch) per page (merged_result has
        // exactly 1 row per PK — the merge dedups — so no duplicate-PK keyset
        // skip). read_parquet on a local file needs no httpfs.
        const lp = tailFile.replace(/'/g, "''");
        const batchSelect = (after: string) =>
          `SELECT primary_key, CAST(properties AS VARCHAR) AS properties,
             to_json(markings) AS markings, operation,
             COALESCE(source_datasource_id,   '') AS source_datasource_id,
             COALESCE(source_transaction_id, '') AS source_transaction_id
           FROM read_parquet('${lp}')
           ${after ? `WHERE primary_key > ${sqlStr(after)}` : ""}
           ORDER BY primary_key LIMIT ${batchSize}`;
        let keysetAfter = "";
        for (;;) {
          const batch = await queryAll<Record<string, unknown>>(
            conn,
            batchSelect(keysetAfter),
          );
          if (batch.length === 0) break;
          for (const row of batch) {
            lastPk = String(row.primary_key);
            rowsProcessed++;
            stageBuf.push({
              ontology_id: input.ontologyId,
              object_type_api_name: input.objectTypeApiName,
              primary_key: lastPk,
              operation: row.operation === "delete" ? "delete" : "upsert",
              properties: parseJsonColumn(row.properties),
              markings: parseJsonArrayColumn(row.markings),
              source_datasource_id:
                String(row.source_datasource_id ?? "") || null,
              source_transaction_id:
                String(row.source_transaction_id ?? "") || null,
            });
            if (stageBuf.length >= 1000) {
              await stageMergeRows(client, stagingScope, stageBuf.splice(0));
            }
            // Advisory progress (transaction NOT committed yet — advisory only).
            // Deliberately NOT awaited: this runs inside the open BEGIN/COMMIT
            // while holding a pooled PG client, so awaiting a Redis round-trip
            // here would hold the transaction (and the pool slot) open for the
            // duration of every checkpoint — 930 checkpoints for OO7's 4.65M
            // rows, and up to the full connect deadline each when Redis is
            // down. recordMergeProgress swallows its own failures, so a
            // floating rejection is impossible.
            if (input.runKey && rowsProcessed % batchSize === 0) {
              void recordMergeProgress(input.runKey, {
                committed: false,
                lastPk,
                rowsProcessed,
              });
              // Liveness evidence for the Temporal heartbeat loop. Unlike the
              // Redis checkpoint above, this is a local field write that cannot
              // block — and it is what lets heartbeatTimeout fail this activity
              // if the PG tail ever wedges again.
              reportStageProgress(`merge pg-tail rows=${rowsProcessed}`);
              // Movement evidence for the indexing-lease watchdog: the same
              // cadence, best-effort, never blocking the tail.
              if (leaseObjectTypeId) {
                void bestEffortLease(
                  () => reportIndexingProgress(leaseObjectTypeId),
                  "progress-tail",
                );
              }
            }
          }
          keysetAfter = lastPk ?? ""; // advance the cursor to the last row of this batch
        }
        if (stageBuf.length > 0) {
          await stageMergeRows(client, stagingScope, stageBuf.splice(0));
        }
        await client.query("COMMIT");
        console.log(
          `[merge-sql] ${input.objectTypeApiName} staging rows=${rowsProcessed} ` +
            `durMs=${Date.now() - tTail}`,
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      // Phase 2 — verify staging BEFORE touching the live table. Count +
      // distinct + null/empty over the staged rows, plus a 1 000-row
      // field-by-field sample against the merged parquet. Any failure here
      // throws with object_instances unchanged.
      const stageClient = await getClient();
      try {
        const staged = await verifyMergeStaging(stageClient, stagingScope);
        assertStagedTail(staged, tailRowCount, input.objectTypeApiName);
        await verifyStagedSample(conn, stageClient, tailFile, stagingScope);
        upserts = staged.stagedUpserts;
        deletes = staged.stagedDeletes;
        // Phase 3 — atomic promote: staged upserts + deletes cut over to
        // the live table inside ONE transaction, then staging is dropped.
        await stageClient.query("BEGIN");
        try {
          const promoted = await promoteMergeStaging(stageClient, stagingScope);
          await stageClient.query("COMMIT");
          console.log(
            `[merge-sql] ${input.objectTypeApiName} pg-tail rows=${rowsProcessed} ` +
              `upserts=${upserts} deletes=${deletes} ` +
              `promotedUpserts=${promoted.upserts} promotedDeletes=${promoted.deletes} ` +
              `durMs=${Date.now() - tTail}`,
          );
        } catch (err) {
          await stageClient.query("ROLLBACK");
          throw err;
        }
        pgTailCommitted = true;
      } catch (err) {
        if (!funnelRuntimeConfig().mergeStagingRetainOnFailure) {
          await clearMergeStagingRun(stageClient, stagingScope).catch(() => {});
        }
        throw err;
      } finally {
        stageClient.release();
      }
      // committed=true is recorded only AFTER the pool client is released, so
      // the Redis write can never extend the lifetime of a PG connection.
      // Ordering is still safe: the checkpoint is a resume hint, and a crash
      // between COMMIT and this write only costs a redundant (idempotent) redo.
      if (input.runKey && pgTailCommitted) {
        await recordMergeProgress(input.runKey, {
          committed: true,
          lastPk,
          rowsProcessed,
          upserts,
          deletes,
        });
      }
      } // end tailRowCount > 0
    } else if (skipPgTail) {
      // Post-commit crash on a prior attempt — PG tail already durable. The
      // merged parquet_ref was re-built above; commitSnapshot will point at the
      // fresh ref. Restore the counts from the checkpoint so the committed
      // snapshot's summary carries accurate counts without re-streaming.
      upserts = checkpoint?.upserts ?? 0;
      deletes = checkpoint?.deletes ?? 0;
      console.log(
        `[merge-sql] runKey=${input.runKey ?? ""} skip PG tail (committed checkpoint) upserts=${upserts} deletes=${deletes}`,
      );
    }
  } finally {
    releaseConnection(conn);
    try {
      fs.rmSync(mergedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    for (const d of downloads) {
      try {
        fs.rmSync(d.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // 15. commitSnapshot (NO-TOUCH — opens its own BEGIN/COMMIT) with the merged
  //     parquet_ref in summary_json. On failure the orphan is best-effort
  //     deleted (key = pre-generated snapshot id — GC-able per the CONTRACT).
  const manifest: ManifestEntry[] = mergedParquetRef
    ? [
        {
          file_path: parquetRefToUri(mergedParquetRef),
          file_size_bytes: mergedParquetRef.sizeBytes,
          row_count: mergedParquetRef.rowCount,
          operation: "added",
        },
      ]
    : [
        {
          file_path: input.mergedOutputFileLocation,
          file_size_bytes: 0,
          row_count: 0,
          operation: "added",
        },
      ];

  let snapshot;
  try {
    snapshot = await commitSnapshot({
      tableId: input.mergedTableId,
      operation: "overwrite",
      manifest,
      snapshotId: preMergedSnapshotId,
      summary: {
        upserts,
        deletes,
        edits_consumed: input.pendingEdits.length,
        edit_strategy: input.editStrategy,
        contributions: input.contributions.map((c) => c.datasource_id),
        parquet_ref: mergedParquetRef,
        merge_path: mergePath,
      },
    });
  } catch (err) {
    await deleteOrphanParquetRef(mergedParquetRef);
    throw err;
  }

  // 16. markEditsAppliedToMerge (NO-TOUCH — idempotent via
  //     WHERE applied_to_merged_at IS NULL).
  const editIdsToStamp = input.pendingEdits.map((e) => e.edit_id);
  if (editIdsToStamp.length > 0) {
    await markEditsAppliedToMerge(editIdsToStamp);
  }
  if (input.runKey) await clearMergeProgress(input.runKey);

  return {
    snapshotId: snapshot.snapshot_id,
    upserts,
    deletes,
    editsConsumed: editIdsToStamp.length,
    // NOT materialised — the rows live in `parquetRef`; re-read via
    // loadMergedRowsFromSnapshot / streamParquetRows (pass-by-reference).
    mergedRows: [],
    parquetRef: mergedParquetRef,
  };
}

/**
 * Resolve a changelog snapshot's `summary_json.parquet_ref` WITHOUT loading
 * the rows (the {@link loadChangelogRowsFromSnapshot} full-array load is the
 * wall). Returns null for legacy snapshots (inline_rows) — the caller falls
 * back to the pure-TS {@link mergeChanges} path.
 */
export async function resolveChangelogParquetRef(
  snapshotId: string,
): Promise<ParquetRef | null> {
  const res = await query(
    `SELECT summary_json FROM funnel_snapshot WHERE snapshot_id = $1`,
    [snapshotId],
  );
  const row = res.rows[0] as
    | { summary_json: Record<string, unknown> }
    | undefined;
  if (!row) return null;
  return resolveParquetRef(row.summary_json?.parquet_ref);
}

/**
 * Spec-aligned entry point: `mergeChanges(objectTypeApiName,
 * changelogSnapshots[], editsBatch[])`. Resolves each changelog snapshot's
 * `parquet_ref` (NOT the full row array — the load was the OO7 wall) and
 * delegates to {@link mergeChangesSQL}. Legacy snapshots (pre-Phase-0
 * inline_rows, no parquet_ref) fall back to the pure-TS {@link mergeChanges}
 * (kept for tests/fallback). Preferred entry point from the Temporal activity.
 */
export async function mergeChangesFromSnapshots(args: {
  ontologyId: string;
  objectTypeApiName: string;
  changelogSnapshots: Array<{
    datasource_id: string;
    snapshot_id: string;
    owned_properties: string[];
    markings?: string[];
    source_timestamps?: Record<string, string>;
  }>;
  editsBatch: OntologyEditRow[];
  editStrategy: EditStrategy;
  mergedTableId: string;
  mergedOutputFileLocation: string;
  existingInstances?: Record<string, ExistingInstance>;
  /** Threads from {@link runMergeActivity}'s driving signal id; keys the
   *  Redis checkpoint. */
  runKey?: string;
}): Promise<MergeResult> {
  // Resolve parquet_refs (flat — a small PG read per snapshot, NOT a row load).
  const resolved = await Promise.all(
    args.changelogSnapshots.map(async (s) => ({
      snapshot: s,
      ref: await resolveChangelogParquetRef(s.snapshot_id),
    })),
  );
  // Legacy fallback: any snapshot without a parquet_ref → pure-TS path (loads
  // rows; correct but materialises — only for pre-Phase-0 snapshots).
  if (resolved.some((r) => !r.ref)) {
    const contributions: DatasourceContribution[] = [];
    for (const r of resolved) {
      const rows = await loadChangelogRowsFromSnapshot(r.snapshot.snapshot_id);
      contributions.push({
        datasource_id: r.snapshot.datasource_id,
        owned_properties: r.snapshot.owned_properties,
        changelog_rows: rows,
        markings: r.snapshot.markings ?? [],
        source_timestamps: r.snapshot.source_timestamps,
      });
    }
    return mergeChanges({
      ontologyId: args.ontologyId,
      objectTypeApiName: args.objectTypeApiName,
      contributions,
      pendingEdits: args.editsBatch,
      editStrategy: args.editStrategy,
      mergedTableId: args.mergedTableId,
      mergedOutputFileLocation: args.mergedOutputFileLocation,
      existingInstances: args.existingInstances,
    });
  }

  // SQL path — all snapshots have parquet_refs. Stage as SQLContribution[]
  // (parquet refs, NOT row arrays) and delegate to the DuckDB k-way merge.
  const sqlContributions: SQLContribution[] = resolved.map((r) => ({
    datasource_id: r.snapshot.datasource_id,
    owned_properties: r.snapshot.owned_properties,
    markings: r.snapshot.markings ?? [],
    parquetRef: r.ref!,
    source_timestamps: r.snapshot.source_timestamps,
  }));
  return mergeChangesSQL({
    ontologyId: args.ontologyId,
    objectTypeApiName: args.objectTypeApiName,
    contributions: sqlContributions,
    pendingEdits: args.editsBatch,
    editStrategy: args.editStrategy,
    mergedTableId: args.mergedTableId,
    mergedOutputFileLocation: args.mergedOutputFileLocation,
    existingInstances: args.existingInstances,
    runKey: args.runKey,
  });
}

export async function loadChangelogRowsFromSnapshot(
  snapshotId: string
): Promise<ChangelogRow[]> {
  // PASS-BY-REFERENCE (Option 2): `computeChangelog` persists the emitted
  // rows as a Parquet object in MinIO; the snapshot's `summary_json`
  // carries a small `parquet_ref`. Resolve it back to rows here. Legacy
  // snapshots (pre-fix) still carry `summary_json.inline_rows` — handle
  // both without a data migration.
  const res = await query(
    `SELECT manifest_json, summary_json FROM funnel_snapshot WHERE snapshot_id = $1`,
    [snapshotId]
  );
  const row = res.rows[0] as
    | { manifest_json: unknown; summary_json: Record<string, unknown> }
    | undefined;
  if (!row) return [];
  const summary = row.summary_json ?? {};
  const ref = resolveParquetRef(summary.parquet_ref);
  if (ref) {
    return readParquetRows<ChangelogRow>(ref, (r) => {
      const op = String(r.operation ?? "INSERT").toUpperCase();
      return {
        primary_key: String(r.primary_key ?? ""),
        operation:
          op === "DELETE" ? "DELETE" : op === "UPDATE" ? "UPDATE" : "INSERT",
        properties: parseJsonColumn(r.properties),
        source_transaction_id: String(r.source_transaction_id ?? ""),
        source_commit_timestamp: String(r.source_commit_timestamp ?? ""),
      };
    });
  }
  // LEGACY: pre-fix snapshots inlined the rows into summary_json.inline_rows.
  const inline = (summary.inline_rows ?? []) as ChangelogRow[];
  return Array.isArray(inline) ? inline : [];
}

/**
 * PASS-BY-REFERENCE re-read for the Indexing stage. `mergeChanges`
 * persists its `mergedRows` as a Parquet object (small `parquet_ref` in
 * `summary_json`); the Indexing activity re-reads them here (by
 * `snapshotId`) only when Quickwit is actually reachable. Legacy
 * snapshots fall back to `summary_json.inline_rows`.
 */
export async function loadMergedRowsFromSnapshot(
  snapshotId: string
): Promise<MergeResult["mergedRows"]> {
  const res = await query(
    `SELECT summary_json FROM funnel_snapshot WHERE snapshot_id = $1`,
    [snapshotId]
  );
  const row = res.rows[0] as
    | { summary_json: Record<string, unknown> }
    | undefined;
  if (!row) return [];
  const summary = row.summary_json ?? {};
  const ref = resolveParquetRef(summary.parquet_ref);
  if (ref) {
    return readParquetRows<MergeResult["mergedRows"][number]>(ref, (r) => ({
      primary_key: String(r.primary_key ?? ""),
      properties: parseJsonColumn(r.properties),
      markings: parseJsonArrayColumn(r.markings),
      operation: r.operation === "delete" ? "delete" : "upsert",
      source_datasource_id:
        r.source_datasource_id != null && r.source_datasource_id !== ""
          ? String(r.source_datasource_id)
          : null,
      source_transaction_id:
        r.source_transaction_id != null && r.source_transaction_id !== ""
          ? String(r.source_transaction_id)
          : null,
    }));
  }
  // LEGACY: pre-fix snapshots inlined the merged rows.
  const inline = (summary.inline_rows ?? []) as MergeResult["mergedRows"];
  return Array.isArray(inline) ? inline : [];
}

/**
 * STREAMING sibling of {@link loadMergedRowsFromSnapshot} — yields the merged
 * rows one at a time instead of returning a full array.
 *
 * Why this exists: `loadMergedRowsFromSnapshot` goes through
 * `readParquetRows`, which refuses (throws) above
 * `TELLUS_PARQUET_READ_MAX_ROWS` (default 2M) because materialising a
 * multi-million-row array is a real O(N) heap wall. That gate is correct, but
 * the Quickwit indexing activity was calling the materialising variant
 * unconditionally, so every Object Type past 2M rows — OO7 sits at 4.65M —
 * had its indexing stage hard-fail with "exceeds
 * TELLUS_PARQUET_READ_MAX_ROWS", i.e. the largest types were exactly the ones
 * that could never reach the serving index. The guard was doing its job; the
 * caller had no streaming path to fall back to. This is it.
 *
 * Same row shape and same legacy `inline_rows` fallback as the array variant,
 * so callers can switch without changing their mapping.
 */
export async function* streamMergedRowsFromSnapshot(
  snapshotId: string
): AsyncGenerator<MergeResult["mergedRows"][number]> {
  const res = await query(
    `SELECT summary_json FROM funnel_snapshot WHERE snapshot_id = $1`,
    [snapshotId]
  );
  const row = res.rows[0] as
    | { summary_json: Record<string, unknown> }
    | undefined;
  if (!row) return;
  const summary = row.summary_json ?? {};
  const ref = resolveParquetRef(summary.parquet_ref);
  if (ref) {
    yield* streamParquetRows<MergeResult["mergedRows"][number]>(ref, (r) => ({
      primary_key: String(r.primary_key ?? ""),
      properties: parseJsonColumn(r.properties),
      markings: parseJsonArrayColumn(r.markings),
      operation: r.operation === "delete" ? "delete" : "upsert",
      source_datasource_id:
        r.source_datasource_id != null && r.source_datasource_id !== ""
          ? String(r.source_datasource_id)
          : null,
      source_transaction_id:
        r.source_transaction_id != null && r.source_transaction_id !== ""
          ? String(r.source_transaction_id)
          : null,
    }));
    return;
  }
  // LEGACY: pre-fix snapshots inlined the merged rows.
  const inline = (summary.inline_rows ?? []) as MergeResult["mergedRows"];
  if (Array.isArray(inline)) yield* inline;
}

async function loadExistingInstances(
  ontologyId: string,
  objectTypeApiName: string,
  pks: string[]
): Promise<Record<string, ExistingInstance>> {
  if (pks.length === 0) return {};
  const result = await query(
    `SELECT primary_key, properties, markings, source_datasource_id, source_transaction_id
       FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = ANY($3)`,
    [ontologyId, objectTypeApiName, pks]
  );
  const out: Record<string, ExistingInstance> = {};
  for (const row of result.rows) {
    out[row.primary_key as string] = {
      properties: row.properties ?? {},
      markings: row.markings ?? [],
      source_datasource_id: row.source_datasource_id,
      source_transaction_id: row.source_transaction_id,
    };
  }
  return out;
}
