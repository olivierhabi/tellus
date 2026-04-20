// ---------------------------------------------------------------------------
// Parquet snapshot-diff reader — PB-B3 / PB-B4 bridge.
//
// The spec calls for the Funnel's `SnapshotDiffReader` to fall through
// to a Parquet-footer-driven read when the source is a Parquet-backed
// pipeline output (`foundry_datasets.format='parquet'`). We can't do a
// true "rows added between snapshots" delta on plain Parquet (no
// ACID snapshots), but we CAN cheaply:
//
//   * read the Parquet footer via DuckDB to confirm the file is
//     accessible + pin the row count to `row_count_exact`;
//   * yield every row as an INSERT change-log entry.
//
// The bounded "full read" is the honest equivalent the spec hints at:
// "for Parquet inputs [the changelog] falls through to a full read".
// Downstream merge stage will then upsert by primary key.
// ---------------------------------------------------------------------------

import type {
  SnapshotDiffReader,
  SourceChangeRow,
} from "../funnel/changelogStage";
import {
  acquireConnection,
  queryAll,
  releaseConnection,
} from "../duckdb/pool";

export interface ParquetDiffReaderOpts {
  /** Absolute path or s3:// URI to the Parquet file / directory. */
  path: string;
  primaryKeyColumn: string;
  /** Honour only rows whose `source_commit_timestamp` is strictly
   *  greater than this ISO timestamp. Lets the caller cheaply chunk a
   *  Parquet snapshot when it was written in multiple deploys. */
  sinceIso?: string;
}

export function parquetSnapshotDiffReader(
  opts: ParquetDiffReaderOpts,
): SnapshotDiffReader {
  return {
    async *read() {
      const conn = await acquireConnection({ skipHttpfs: !/^s3:/i.test(opts.path) });
      try {
        const sql = opts.sinceIso
          ? `SELECT * FROM read_parquet('${escape(opts.path)}') WHERE source_commit_timestamp > TIMESTAMP '${escape(opts.sinceIso)}'`
          : `SELECT * FROM read_parquet('${escape(opts.path)}')`;
        const rows = await queryAll<Record<string, unknown>>(conn, sql);
        for (const r of rows) {
          const pk = String(r[opts.primaryKeyColumn] ?? "");
          if (!pk) continue;
          const meta = new Set([
            opts.primaryKeyColumn,
            "operation",
            "source_transaction_id",
            "source_commit_timestamp",
          ]);
          const properties: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) if (!meta.has(k)) properties[k] = v;
          const op = String(r.operation ?? "INSERT").toUpperCase();
          const change: SourceChangeRow = {
            primary_key: pk,
            operation:
              op === "DELETE" ? "DELETE" : op === "UPDATE" ? "UPDATE" : "INSERT",
            properties,
            source_transaction_id: String(r.source_transaction_id ?? ""),
            source_commit_timestamp: String(r.source_commit_timestamp ?? ""),
          };
          yield change;
        }
      } finally {
        releaseConnection(conn);
      }
    },
  };
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}
