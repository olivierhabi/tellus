// ---------------------------------------------------------------------------
// B5 — Watermark repository (spec §B5 line 253).
//
// Stores the last successfully-processed value of the import's
// incrementalColumn. Reads are non-locking; writes are upserts.
// Strict `>` semantics: the append strategy uses
//   WHERE incrementalColumn > :last_watermark
// so the same row never re-imports.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";
import type { PoolClient } from "pg";

export interface Watermark {
  importRid: string;
  watermarkColumn: string;
  watermarkValue: string | null;
  observedMax: string | null;
  updatedAt: string;
  lastBuildRid: string | null;
}

export async function read(importRid: string): Promise<Watermark | null> {
  const r = await pool.query<Watermark>(
    `SELECT import_rid AS "importRid",
            watermark_column AS "watermarkColumn",
            watermark_value AS "watermarkValue",
            observed_max AS "observedMax",
            updated_at AS "updatedAt",
            last_build_rid AS "lastBuildRid"
       FROM table_import_watermarks
      WHERE import_rid = $1`,
    [importRid],
  );
  return r.rows[0] ?? null;
}

export async function upsert(
  client: PoolClient | undefined,
  args: {
    importRid: string;
    watermarkColumn: string;
    newValue: string | null;
    observedMax: string | null;
    buildRid: string;
  },
): Promise<void> {
  const exec = client ?? pool;
  await exec.query(
    `INSERT INTO table_import_watermarks(
       import_rid, watermark_column, watermark_value, observed_max,
       updated_at, last_build_rid
     ) VALUES ($1,$2,$3,$4, now(), $5)
     ON CONFLICT (import_rid) DO UPDATE
       SET watermark_value = EXCLUDED.watermark_value,
           observed_max = EXCLUDED.observed_max,
           updated_at = now(),
           last_build_rid = EXCLUDED.last_build_rid,
           watermark_column = EXCLUDED.watermark_column`,
    [
      args.importRid,
      args.watermarkColumn,
      args.newValue,
      args.observedMax,
      args.buildRid,
    ],
  );
}
