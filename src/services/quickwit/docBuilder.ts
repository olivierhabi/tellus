// ---------------------------------------------------------------------------
// Quickwit doc builder — Task B6
//
// Transforms a merged-dataset row + changelog operation into the NDJSON
// document Quickwit ingests. Rows come out of the merged Iceberg table as
// `{ primary_key, properties, operation, version, ... }`; the Index activity
// funnels them through this module before dropping them on the Kafka topic
// that feeds the index.
//
// Delete semantics: because Quickwit's delete-by-query cadence is
// hours-to-days (see B6 risk note), we don't emit deletes to the index.
// Instead we emit a tombstone document with `__deleted=true`. All search
// paths filter out tombstones at query time — that's fast (filterable +
// indexed) and makes the Writeback Overlay's job simpler.
// ---------------------------------------------------------------------------

export type ChangelogOperation = "INSERT" | "UPDATE" | "DELETE";

export interface MergedRow {
  primary_key: string;
  properties: Record<string, unknown>;
  operation: ChangelogOperation;
  version: number;
  source_transaction_id?: string;
  source_commit_timestamp?: string;
}

export interface BuildDocInput {
  objectTypeApiName: string;
  primaryKeyApiName: string;
  row: MergedRow;
}

export function buildQuickwitDoc(input: BuildDocInput): Record<string, unknown> {
  const { row, primaryKeyApiName, objectTypeApiName } = input;

  const isDelete = row.operation === "DELETE";
  const doc: Record<string, unknown> = {
    __pk: row.primary_key,
    __version: row.version,
    __deleted: isDelete,
    __object_type: objectTypeApiName,
    [`__pk_${primaryKeyApiName}`]: row.primary_key,
  };

  // For tombstones we still emit the PK so Hydration's split prefetch sees
  // the row, but we skip user properties — they're no longer authoritative
  // and carrying them would confuse cost-based query planners.
  if (!isDelete) {
    for (const [k, v] of Object.entries(row.properties ?? {})) {
      if (v === undefined) continue;
      doc[k] = v;
    }
    if (!(primaryKeyApiName in doc)) {
      doc[primaryKeyApiName] = row.primary_key;
    }
  }

  return doc;
}

export function buildQuickwitNdjson(
  rows: MergedRow[],
  ctx: { objectTypeApiName: string; primaryKeyApiName: string }
): string {
  return rows
    .map((row) => JSON.stringify(buildQuickwitDoc({ ...ctx, row })))
    .join("\n");
}
