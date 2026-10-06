// ---------------------------------------------------------------------------
// runBucketedMergePrefix — orchestration tests: compute, checkpoint, resume.
//
// Tiny in-process DuckDB for the SQL; `query` (checkpoint store) and the
// storage service (MinIO) mocked. Proven here:
//   1. Fresh run: all buckets computed, uploaded, checkpointed; source_state
//      assembled from every bucket; onBucketComplete fires per bucket.
//   2. Resume: a verified completed bucket is downloaded (not recomputed),
//      the rest compute; skipped=1/computed=2; no upload or checkpoint write
//      for the resumed bucket.
//   3. Corrupt checkpoint (missing output): the checkpoint row is deleted
//      and the bucket is recomputed.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import duckdb from "duckdb";

const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
let dbRespond: (sql: string) => { rows: Record<string, unknown>[] } = () => ({
  rows: [],
});

vi.mock("../../../src/db", () => ({
  query: async (sql: string, params: unknown[]) => {
    dbCalls.push({ sql, params });
    const { rows } = dbRespond(sql);
    return { rowCount: rows.length, rows };
  },
}));

const uploaded: Array<{ key: string; file: string }> = [];
const minioDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-minio-"));

vi.mock("../../../src/services/storageService", () => ({
  uploadObject: async (key: string, body: NodeJS.ReadableStream) => {
    const dest = path.join(minioDir, key.replace(/\//g, "_"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(body, fs.createWriteStream(dest));
    uploaded.push({ key, file: dest });
    return { key, bucket: "test", size: fs.statSync(dest).size };
  },
  getObjectStream: async (key: string) => {
    const found = uploaded.find((u) => u.key === key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return fs.createReadStream(found.file);
  },
}));

import { runBucketedMergePrefix } from "../../../src/services/funnel/mergeBuckets";
import {
  buildNarrowBucketStatements,
  buildBucketExportStatement,
} from "../../../src/services/funnel/mergePrefixSql";
import { runAll, queryAll } from "../../../src/services/duckdb/pool";

type Conn = Parameters<typeof runAll>[0];

function memConn(): Conn {
  const db = new duckdb.Database(":memory:");
  return db.connect() as unknown as Conn;
}

// 9 rows across 3 hash buckets (forcing N=3 by input, not by data).
const ROWS = `('P1','INSERT','{"a":"1"}','t1','2026-01-01T00:00:00Z'),
      ('P1','UPDATE','{"b":"2"}','t2','2026-01-01T01:00:00Z'),
      ('P2','INSERT','{"c":"3"}','t1','2026-01-01T00:00:00Z'),
      ('P3','INSERT','{"d":"4"}','t1','2026-01-01T00:00:00Z'),
      ('P3','DELETE','{}','t2','2026-01-01T02:00:00Z'),
      ('P4','INSERT','{"e":"5"}','t1','2026-01-01T00:00:00Z'),
      ('P5','INSERT','{"f":"6"}','t1','2026-01-01T00:00:00Z'),
      ('P6','INSERT','{"g":"7"}','t1','2026-01-01T00:00:00Z'),
      ('P7','INSERT','{"h":"8"}','t1','2026-01-01T00:00:00Z')`;

async function fixtureParquet(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-chg-"));
  const fp = path.join(dir, "c.parquet");
  const conn = memConn();
  await runAll(
    conn,
    `COPY (SELECT * FROM (VALUES ${ROWS}) AS v(primary_key, operation, properties, source_transaction_id, source_commit_timestamp)) TO '${fp}' (FORMAT PARQUET)`,
  );
  return fp;
}

const CONTRIBS = [{ datasource_id: "ds-1", owned_properties: [], markings: [] }];

async function sourceStatePks(conn: Conn): Promise<string[]> {
  const rows = await queryAll<{ primary_key: string }>(
    conn,
    `SELECT primary_key FROM source_state ORDER BY primary_key`,
  );
  return rows.map((r) => String(r.primary_key));
}

beforeEach(() => {
  dbCalls.length = 0;
  uploaded.length = 0;
  dbRespond = () => ({ rows: [] });
});

afterEach(() => {
  delete process.env.MERGE_BUCKET_ROWS;
  delete process.env.MERGE_NARROW_DEDUP;
});

describe("runBucketedMergePrefix", () => {
  it("fresh run computes, uploads and checkpoints every bucket", async () => {
    const lp = await fixtureParquet();
    const conn = memConn();
    const done: number[] = [];
    const res = await runBucketedMergePrefix({
      objectTypeApiName: "ResumeTest",
      snapshotId: "snap-fresh",
      contributions: CONTRIBS,
      localPaths: [lp],
      singleContribution: true,
      bucketCount: 3,
      runKey: "run-fresh",
      conn,
      outOfProcess: false,
      onBucketComplete: (b) => done.push(b),
    });
    expect(res).toEqual({ bucketCount: 3, skipped: 0, computed: 3 });
    expect(done.sort()).toEqual([0, 1, 2]);
    // P3 tombstoned; the rest live.
    expect(await sourceStatePks(conn)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
    ]);
    const tomb = await queryAll<{ tombstoned: boolean }>(
      conn,
      `SELECT tombstoned FROM source_state WHERE primary_key = 'P3'`,
    );
    expect(Boolean(tomb[0].tombstoned)).toBe(true);
    // 3 uploads + 3 checkpoint upserts, keyed per bucket.
    expect(uploaded.map((u) => u.key).sort()).toEqual([
      "merge-buckets/ResumeTest/snap-fresh.b0.parquet",
      "merge-buckets/ResumeTest/snap-fresh.b1.parquet",
      "merge-buckets/ResumeTest/snap-fresh.b2.parquet",
    ]);
    const inserts = dbCalls.filter((c) =>
      c.sql.includes("INSERT INTO funnel_merge_bucket"),
    );
    expect(inserts).toHaveLength(3);
    expect(inserts.map((c) => c.params[1]).sort()).toEqual([0, 1, 2]);
  }, 120_000);

  it("resume skips the verified bucket and computes the rest", async () => {
    const lp = await fixtureParquet();
    // Pre-compute bucket 0 exactly as the runner would, then checkpoint it.
    const prepConn = memConn();
    const b0dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-b0-"));
    const b0file = path.join(b0dir, "b0.parquet");
    for (const s of buildNarrowBucketStatements({
      contributions: CONTRIBS,
      localPaths: [lp],
      bucket: { id: 0, count: 3 },
      singleContribution: true,
    })) {
      await runAll(prepConn, s);
    }
    await runAll(prepConn, buildBucketExportStatement(b0file));
    const fp = await queryAll<{ n: string; h: string }>(
      prepConn,
      `SELECT CAST(count(*) AS VARCHAR) AS n,
              CAST(bit_xor(hash(primary_key)) AS VARCHAR) AS h
         FROM read_parquet('${b0file}')`,
    );
    const b0 = { n: Number(fp[0].n), h: fp[0].h ?? null };
    const b0key = "merge-buckets/ResumeTest/snap-resume.b0.parquet";
    await pipeline(
      fs.createReadStream(b0file),
      fs.createWriteStream(path.join(minioDir, b0key.replace(/\//g, "_"))),
    );
    uploaded.push({
      key: b0key,
      file: path.join(minioDir, b0key.replace(/\//g, "_")),
    });
    dbRespond = (sql) =>
      sql.includes("FROM funnel_merge_bucket")
        ? {
            rows: [
              {
                bucket_id: 0,
                row_count: b0.n,
                checksum: b0.h,
                output_key: b0key,
              },
            ],
          }
        : { rows: [] };

    const conn = memConn();
    const done: number[] = [];
    const res = await runBucketedMergePrefix({
      objectTypeApiName: "ResumeTest",
      snapshotId: "snap-resume",
      contributions: CONTRIBS,
      localPaths: [lp],
      singleContribution: true,
      bucketCount: 3,
      runKey: "run-resume",
      conn,
      outOfProcess: false,
      onBucketComplete: (b) => done.push(b),
    });
    expect(res).toEqual({ bucketCount: 3, skipped: 1, computed: 2 });
    // Bucket 0 was resumed, not recomputed.
    expect(done.sort()).toEqual([1, 2]);
    expect(uploaded.map((u) => u.key).sort()).toEqual([
      b0key,
      "merge-buckets/ResumeTest/snap-resume.b1.parquet",
      "merge-buckets/ResumeTest/snap-resume.b2.parquet",
    ]);
    const inserts = dbCalls.filter((c) =>
      c.sql.includes("INSERT INTO funnel_merge_bucket"),
    );
    expect(inserts.map((c) => c.params[1]).sort()).toEqual([1, 2]);
    // Final assembly still covers every PK.
    expect(await sourceStatePks(conn)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
    ]);
  }, 120_000);

  it("a checkpoint whose output is gone is deleted and recomputed", async () => {
    const lp = await fixtureParquet();
    dbRespond = (sql) =>
      sql.includes("FROM funnel_merge_bucket")
        ? {
            rows: [
              {
                bucket_id: 1,
                row_count: 999,
                checksum: "deadbeef",
                output_key: "missing/key.parquet",
              },
            ],
          }
        : { rows: [] };
    const conn = memConn();
    const done: number[] = [];
    const res = await runBucketedMergePrefix({
      objectTypeApiName: "ResumeTest",
      snapshotId: "snap-corrupt",
      contributions: CONTRIBS,
      localPaths: [lp],
      singleContribution: true,
      bucketCount: 3,
      runKey: "run-corrupt",
      conn,
      outOfProcess: false,
      onBucketComplete: (b) => done.push(b),
    });
    expect(res).toEqual({ bucketCount: 3, skipped: 0, computed: 3 });
    expect(done.sort()).toEqual([0, 1, 2]);
    const deletes = dbCalls.filter((c) =>
      c.sql.includes("DELETE FROM funnel_merge_bucket"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].params).toEqual(["run-corrupt", 1]);
    expect(await sourceStatePks(conn)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
    ]);
  }, 120_000);
});
