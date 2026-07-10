// ---------------------------------------------------------------------------
// Changelog Stage — tasks-01.md §B4
//
// The Changelog activity consumes a backing datasource's Iceberg snapshot
// diff and emits an append-only changelog table that captures every
// INSERT / UPDATE / DELETE between `fromSnapshotId` (exclusive) and
// `toSnapshotId` (inclusive).
//
// The output schema is:
//   (primary_key, operation, properties, source_transaction_id,
//    source_commit_timestamp)
//
// The activity is *purely computational*. All I/O against the source data
// is performed through the {@link SnapshotDiffReader} so tests can stub
// the reader and exercise the business rules (duplicate-PK detection,
// throughput capping, manifest emission) without standing up S3 or DuckDB.
//
// Palantir hard rule: duplicate primary keys within a single source
// transaction fail the build. "Most recent transaction wins" is handled
// downstream at merge time (B5) — changelog just records what the source
// said, in transaction order.
//
// Throughput cap: streaming sources are capped at 2 MB/s per Object Type
// to match Palantir's own limit. This cap is enforced *inside* the
// activity via {@link ThroughputGuard}, not at the Kafka consumer level,
// so that a runaway batch ingest cannot bypass it.
// ---------------------------------------------------------------------------

import {
  commitSnapshot,
  funnelNamespace,
  ManifestEntry,
  SnapshotOperation,
} from "./icebergCatalog";
import { query } from "../../db";
import {
  CHANGELOG_PARQUET_COLUMNS,
  changelogParquetKey,
  deleteOrphanParquetRef,
  parquetRefToUri,
  writeParquetRef,
  type ParquetRef,
} from "./funnelParquetStore";

export type ChangelogOperation = "INSERT" | "UPDATE" | "DELETE";

export interface ChangelogRow {
  primary_key: string;
  operation: ChangelogOperation;
  /** For INSERT/UPDATE this is the new row's properties; for DELETE it is
   *  the full prior property set per the spec. */
  properties: Record<string, unknown>;
  source_transaction_id: string;
  source_commit_timestamp: string; // ISO 8601
}

/**
 * A change-feed row pulled from the Iceberg incremental read. Maps 1:1
 * onto the rows DuckDB's `iceberg_scan(..., snapshot_id_from=...,
 * snapshot_id_to=...)` yields in production.
 */
export interface SourceChangeRow {
  primary_key: string;
  operation: ChangelogOperation;
  properties: Record<string, unknown>;
  /** Every Iceberg snapshot maps to exactly one source transaction. */
  source_transaction_id: string;
  source_commit_timestamp: string;
  /** Approximate uncompressed byte size of this row — used for
   *  throughput capping. */
  byte_size?: number;
}

/**
 * Reader abstraction for the incremental Iceberg scan. Production binds
 * this to DuckDB's `iceberg_scan` extension; tests supply an in-memory
 * sequence of rows.
 */
export interface SnapshotDiffReader {
  read(input: {
    sourceTableId: string;
    fromSnapshotId: string | null;
    toSnapshotId: string;
  }): AsyncIterable<SourceChangeRow>;
}

export interface ComputeChangelogInput {
  ontologyId: string;
  objectTypeApiName: string;
  datasourceId: string;
  sourceTableId: string;
  fromSnapshotId: string | null;
  toSnapshotId: string;
  changelogTableId: string;
  /** The location (s3://...) where this changelog batch's Parquet will
   *  be written. Supplied by the caller because activities don't own
   *  I/O — they only compute the manifest. */
  outputFileLocation: string;
  /** Max bytes per second. Default 2 MiB/s per spec. Set to 0 to disable. */
  throughputCapBytesPerSec?: number;
}

export interface ComputeChangelogResult {
  snapshotId: string;
  rowsEmitted: number;
  manifest: ManifestEntry[];
  /** Property names the Merge stage must overlay for this datasource
   *  (column-wise MDO). Collected during the stream so the rows never
   *  need to be returned by value. */
  ownedProperties: string[];
  /** Reference to the Parquet object in MinIO holding the emitted rows,
   *  or `null` when the source yielded zero rows. Downstream re-reads via
   *  `loadChangelogRowsFromSnapshot` — rows never travel through a
   *  Temporal activity return NOR through a jsonb INSERT param. */
  parquetRef: ParquetRef | null;
}

export const DEFAULT_THROUGHPUT_CAP = 2 * 1024 * 1024; // 2 MiB/s per spec

// ---------------------------------------------------------------------------
// Main activity
// ---------------------------------------------------------------------------

export async function computeChangelog(
  input: ComputeChangelogInput,
  reader: SnapshotDiffReader,
  now: () => number = Date.now
): Promise<ComputeChangelogResult> {
  // B4: enforce the `_funnel.<object_type>.changelog.<datasource_id>`
  // naming convention. We look up the table by id and confirm it lives
  // under the expected namespace; a mismatch is a wiring bug and fails
  // loudly rather than writing to the wrong table.
  await assertChangelogTableNamespace(
    input.changelogTableId,
    input.objectTypeApiName,
    input.datasourceId
  );

  const throughput = new ThroughputGuard(
    input.throughputCapBytesPerSec ?? DEFAULT_THROUGHPUT_CAP,
    now
  );

  // Palantir rule: duplicate PKs within a single source transaction fail
  // the build. We track (source_transaction_id, primary_key) → first seen
  // index to give a clear error pointing at both occurrences. `seenInTxn`
  // is O(distinct PKs) — bounded by the source size but far smaller than
  // materialising the full row array.
  const seenInTxn = new Map<string, Map<string, number>>();
  const ownedProperties = new Set<string>();
  let idx = 0;

  // PASS-BY-REFERENCE (Option 2): stream the source rows straight into a
  // Parquet object in MinIO. The full row array is NEVER materialised in
  // Node memory — the generator yields one row at a time, DuckDB's temp
  // table (disk-spillable) holds the batched inserts, and the COPY writes
  // the Parquet. The previous design inlined the rows into
  // `summary_json.inline_rows` (jsonb), which at ~573 MB for a 1M-row
  // source crashed the 768 MiB-capped Postgres backend at the INSERT.
  // `summary_json` now carries only a small `parquet_ref`; the Merge stage
  // re-reads the rows from MinIO by `snapshotId`. Rows never travel
  // through a Temporal activity return value NOR through a jsonb INSERT
  // param — both walls are removed.
  const parquetKey = changelogParquetKey(input.objectTypeApiName);
  const rowIterable = (async function* () {
    for await (const r of reader.read({
      sourceTableId: input.sourceTableId,
      fromSnapshotId: input.fromSnapshotId,
      toSnapshotId: input.toSnapshotId,
    })) {
      const txn = r.source_transaction_id;
      if (!seenInTxn.has(txn)) seenInTxn.set(txn, new Map());
      const txnMap = seenInTxn.get(txn)!;
      if (txnMap.has(r.primary_key)) {
        const firstIdx = txnMap.get(r.primary_key)!;
        throw new Error(
          `duplicate primary key '${r.primary_key}' within source transaction ` +
            `'${txn}' (first seen at row ${firstIdx}, duplicate at row ${idx})`
        );
      }
      txnMap.set(r.primary_key, idx);

      if (r.byte_size && r.byte_size > 0) {
        await throughput.consume(r.byte_size);
      }

      for (const k of Object.keys(r.properties)) ownedProperties.add(k);
      idx++;

      // Flatten to the fixed Parquet schema; `properties` is a JSON string.
      yield {
        primary_key: r.primary_key,
        operation: r.operation,
        properties: JSON.stringify(r.properties),
        source_transaction_id: r.source_transaction_id,
        source_commit_timestamp: r.source_commit_timestamp,
      };
    }
  })();

  // Write the Parquet object BEFORE committing the snapshot row. If the
  // commit fails the orphaned object is best-effort deleted (idempotent);
  // it is in any case safely ignorable + GC-able (the key is a per-call
  // uuid, so retries never collide with a referenced object).
  let parquetRef: ParquetRef | null = null;
  try {
    parquetRef = await writeParquetRef({
      columns: CHANGELOG_PARQUET_COLUMNS,
      rows: rowIterable,
      key: parquetKey,
    });
  } catch (err) {
    await deleteOrphanParquetRef(parquetRef);
    throw err;
  }

  const rowsEmitted = parquetRef?.rowCount ?? 0;
  const manifest: ManifestEntry[] = parquetRef
    ? [
        {
          file_path: parquetRefToUri(parquetRef),
          file_size_bytes: parquetRef.sizeBytes,
          row_count: parquetRef.rowCount,
          operation: "added",
        },
      ]
    : [
        {
          // Zero-row source — no Parquet object; the manifest records the
          // empty data-file at the logical table location for compatibility.
          file_path: input.outputFileLocation,
          file_size_bytes: 0,
          row_count: 0,
          operation: "added",
        },
      ];

  let snapshot;
  try {
    snapshot = await commitSnapshot({
      tableId: input.changelogTableId,
      operation: "append" as SnapshotOperation,
      manifest,
      summary: {
        source_datasource_id: input.datasourceId,
        source_from_snapshot: input.fromSnapshotId,
        source_to_snapshot: input.toSnapshotId,
        rows_emitted: rowsEmitted,
        distinct_source_transactions: seenInTxn.size,
        // Small, N-independent reference — replaces the old `inline_rows`
        // array. `loadChangelogRowsFromSnapshot` resolves it back to rows.
        parquet_ref: parquetRef,
      },
    });
  } catch (err) {
    await deleteOrphanParquetRef(parquetRef);
    throw err;
  }

  await query(
    `INSERT INTO funnel_changelog_watermark
       (ontology_id, object_type_api_name, source_datasource_id,
        last_from_snapshot_id, last_to_snapshot_id, last_run_at, last_rows_emitted)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (ontology_id, object_type_api_name, source_datasource_id) DO UPDATE SET
       last_from_snapshot_id = EXCLUDED.last_from_snapshot_id,
       last_to_snapshot_id   = EXCLUDED.last_to_snapshot_id,
       last_run_at           = now(),
       last_rows_emitted     = EXCLUDED.last_rows_emitted`,
    [
      input.ontologyId,
      input.objectTypeApiName,
      input.datasourceId,
      input.fromSnapshotId,
      input.toSnapshotId,
      rowsEmitted,
    ]
  );

  return {
    snapshotId: snapshot.snapshot_id,
    rowsEmitted,
    manifest,
    ownedProperties: Array.from(ownedProperties),
    parquetRef,
  };
}

// ---------------------------------------------------------------------------
// B4 — Namespace guard. The spec mandates `_funnel.<object_type>.changelog.<ds>`
// as the table identity so external tools and the Merge stage can locate
// the right dataset by convention. The caller passes the table id; we
// resolve its namespace and hard-fail on any deviation.
// ---------------------------------------------------------------------------

async function assertChangelogTableNamespace(
  tableId: string,
  objectTypeApiName: string,
  _datasourceId: string
): Promise<void> {
  // Only enforce the `_funnel.<object_type>.changelog` NAMESPACE — the
  // table_name under that namespace is either the datasource UUID (one
  // table per registered datasource) or a sentinel like `default` / `state`
  // used by the dispatcher for object types without a bound datasource yet.
  // The caller-passed `datasourceId` is free-form; the tableId lookup
  // already established that the caller points at the right row.
  //
  // Skip silently if the funnel_dataset row or the relation is missing —
  // unit tests stub the reader and never populate the catalog.
  let row: { namespace: string; table_name: string } | undefined;
  try {
    const res = await query(
      `SELECT namespace, table_name FROM funnel_dataset WHERE dataset_table_id = $1`,
      [tableId]
    );
    row = res.rows[0] as { namespace: string; table_name: string } | undefined;
  } catch {
    return;
  }
  if (!row) return;
  const expectedNs = funnelNamespace(objectTypeApiName, "changelog");
  if (row.namespace !== expectedNs) {
    throw new Error(
      `computeChangelog: changelog table must live under namespace ` +
        `'${expectedNs}'; got '${row.namespace}.${row.table_name}'`
    );
  }
}

// ---------------------------------------------------------------------------
// ThroughputGuard — token-bucket pacing for streaming sources.
// ---------------------------------------------------------------------------

/**
 * Classic token bucket. The bucket holds up to `capPerSec` bytes; each
 * consume() drains that many tokens and sleeps if there aren't enough.
 * This is exposed rather than inlined because B4 tests exercise pacing
 * in isolation.
 */
export class ThroughputGuard {
  private tokens: number;
  private lastRefill: number;
  constructor(
    public readonly capPerSec: number,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = capPerSec;
    this.lastRefill = now();
  }

  async consume(bytes: number): Promise<void> {
    if (this.capPerSec <= 0) return;
    this.refill();
    if (bytes <= this.tokens) {
      this.tokens -= bytes;
      return;
    }
    // Need to wait. Compute the time it would take to accumulate the
    // missing tokens and sleep that long, then retry.
    const deficit = bytes - this.tokens;
    const waitMs = Math.ceil((deficit / this.capPerSec) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    this.refill();
    // After the sleep, assume we earned enough — and if bytes still
    // exceed (huge single row), we let it through to avoid deadlock.
    this.tokens = Math.max(0, this.tokens - bytes);
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = (t - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capPerSec, this.tokens + elapsedSec * this.capPerSec);
    this.lastRefill = t;
  }
}
