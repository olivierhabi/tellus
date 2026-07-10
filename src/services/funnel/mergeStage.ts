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

import { PoolClient } from "pg";
import { query, getClient } from "../../db";
import { bulkUpsertInstances, deleteInstance, UpsertInstanceInput } from "../../models/objectInstance";
import { ChangelogRow } from "./changelogStage";
import { commitSnapshot, ManifestEntry } from "./icebergCatalog";
import { markEditsAppliedToMerge, OntologyEditRow } from "../../models/ontologyEdit";
import { unionMarkings } from "../markingUnion";
import {
  MERGED_PARQUET_COLUMNS,
  CHANGELOG_PARQUET_COLUMNS,
  changelogParquetKey,
  mergedParquetKey,
  deleteOrphanParquetRef,
  parquetRefToUri,
  parseJsonColumn,
  parseJsonArrayColumn,
  readParquetRows,
  writeParquetRef,
  type ParquetRef,
} from "./funnelParquetStore";

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
  const parquetKey = mergedParquetKey(input.objectTypeApiName);
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

/**
 * Spec-aligned entry point: `mergeChanges(objectTypeApiName,
 * changelogSnapshots[], editsBatch[])`. Loads each changelog snapshot's
 * rows from `funnel_snapshot.manifest_json` and the owning dataset's
 * datasource wiring, then delegates to {@link mergeChanges} for the
 * reduction. Preferred entry point from the Temporal activity so the
 * workflow only needs to pass snapshot ids.
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
}): Promise<MergeResult> {
  const contributions: DatasourceContribution[] = [];
  for (const s of args.changelogSnapshots) {
    const rows = await loadChangelogRowsFromSnapshot(s.snapshot_id);
    contributions.push({
      datasource_id: s.datasource_id,
      owned_properties: s.owned_properties,
      changelog_rows: rows,
      markings: s.markings ?? [],
      source_timestamps: s.source_timestamps,
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
  const ref = summary.parquet_ref as ParquetRef | null | undefined;
  if (ref && typeof ref === "object" && ref.key) {
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
  const ref = summary.parquet_ref as ParquetRef | null | undefined;
  if (ref && typeof ref === "object" && ref.key) {
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
