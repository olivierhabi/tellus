// ---------------------------------------------------------------------------
// mergeBuckets — hash-partitioned merge prefix with per-bucket checkpoints.
//
// WHY: the global `changes_seq` sort is the merge's memory peak (measured:
// 46 s + 4.08 GiB spill on 6.36M rows standalone). Partitioning by
// hash(pk) % N keeps each bucket's sort at ~1/N the size, so peak memory
// stays bounded as datasets grow. Every PK's rows share one bucket (the hash
// is a pure function of the key), so per-bucket folds are exact and the
// final UNION ALL is exact.
//
// Durability: with a runKey, each completed bucket is uploaded to MinIO and
// checkpointed (bucket_id, row_count, checksum, output_key). Resume skips
// completed buckets after verifying the output (row count + checksum
// recomputed from the downloaded file) — a failure costs one bucket, not
// the whole run. Without a runKey, buckets stay local and no checkpoint
// rows are written (resume across restarts is keyed by run_key).
//
// There is no 'running' bucket state: a crashed bucket simply has no row
// and is recomputed. Upload-then-checkpoint ordering means a checkpoint row
// always names a complete output.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { query } from "../../db";
import {
  runAll,
  queryAll,
  type DuckDBConnection,
} from "../duckdb/pool";
import {
  runDuckDbCliScript,
  resolveCliSettings,
  cliSettingsPreamble,
} from "./mergeCliRunner";
import {
  buildNarrowBucketStatements,
  buildBucketAssemblyStatement,
  buildBucketExportStatement,
  buildBucketChecksumStatement,
  mergeBucketTargetRows,
  type PrefixContribution,
  type NarrowBucket,
} from "./mergePrefixSql";
import { getObjectStream, uploadObject } from "../storageService";
import { reportStageProgress } from "./temporal/stageProgress";

export interface BucketPlan {
  bucketCount: number;
  /** Sum of contribution row counts the plan was computed from. */
  totalRows: number;
}

/**
 * Pure: how many buckets for this input? Unknown row counts (missing
 * metadata) plan a single bucket — today's shape, narrow SQL. Never 0.
 */
export function planBucketCount(
  rowCounts: Array<number | undefined>,
): BucketPlan {
  let total = 0;
  let known = rowCounts.length > 0;
  for (const n of rowCounts) {
    if (typeof n === "number" && Number.isFinite(n)) total += n;
    else known = false;
  }
  const target = mergeBucketTargetRows();
  if (!known || target <= 0 || total <= 0) {
    return { bucketCount: 1, totalRows: total };
  }
  return { bucketCount: Math.max(1, Math.ceil(total / target)), totalRows: total };
}

/** Pure: which buckets still need work. */
export function pendingBuckets(
  bucketCount: number,
  completed: number[],
): number[] {
  const done = new Set(completed);
  const out: number[] = [];
  for (let b = 0; b < bucketCount; b++) {
    if (!done.has(b)) out.push(b);
  }
  return out;
}

/** MinIO key for a bucket output, next to the merged-output convention
 *  (`merged/<api>/<snapshot>.parquet`). Snapshot-scoped so retries of the
 *  same run overwrite the same key and runs never share outputs. */
export function mergeBucketKey(
  objectTypeApiName: string,
  snapshotId: string,
  bucketId: number,
): string {
  return `merge-buckets/${objectTypeApiName}/${snapshotId}.b${bucketId}.parquet`;
}

export interface BucketCheckpoint {
  bucket_id: number;
  row_count: number;
  checksum: string | null;
  output_key: string;
}

export async function readCompletedBuckets(
  runKey: string,
): Promise<BucketCheckpoint[]> {
  const res = await query(
    `SELECT bucket_id, row_count, checksum, output_key
       FROM funnel_merge_bucket
      WHERE run_key = $1 AND status = 'completed'
      ORDER BY bucket_id`,
    [runKey],
  );
  return ((res.rows ?? []) as BucketCheckpoint[]).map((r) => ({
    bucket_id: Number(r.bucket_id),
    row_count: Number(r.row_count),
    checksum: r.checksum,
    output_key: String(r.output_key),
  }));
}

export async function writeBucketCheckpoint(
  runKey: string,
  bucketId: number,
  rowCount: number,
  checksum: string | null,
  outputKey: string,
): Promise<void> {
  // Idempotent retry: same run re-completing a bucket overwrites.
  await query(
    `INSERT INTO funnel_merge_bucket
       (run_key, bucket_id, status, row_count, checksum, output_key, updated_at)
     VALUES ($1, $2, 'completed', $3, $4, $5, now())
     ON CONFLICT (run_key, bucket_id) DO UPDATE
       SET status = 'completed', row_count = EXCLUDED.row_count,
           checksum = EXCLUDED.checksum, output_key = EXCLUDED.output_key,
           updated_at = now()`,
    [runKey, bucketId, rowCount, checksum, outputKey],
  );
}

export async function deleteBucketCheckpoint(
  runKey: string,
  bucketId: number,
): Promise<void> {
  await query(
    `DELETE FROM funnel_merge_bucket WHERE run_key = $1 AND bucket_id = $2`,
    [runKey, bucketId],
  );
}

async function downloadToLocal(key: string, localPath: string): Promise<void> {
  const stream = await getObjectStream(key);
  await pipeline(stream, fs.createWriteStream(localPath));
}

export interface BucketedPrefixInput {
  objectTypeApiName: string;
  /** Pre-generated merged snapshot id — scopes bucket MinIO keys. */
  snapshotId: string;
  contributions: PrefixContribution[];
  localPaths: string[];
  singleContribution: boolean;
  bucketCount: number;
  /** Null => local-only buckets, no checkpoint rows, no resume. */
  runKey: string | null;
  conn: DuckDBConnection;
  outOfProcess: boolean;
  /** Test hook: replaces the DuckDB CLI command. */
  command?: string[];
  /** Called after each bucket completes (stage + lease reporting). */
  onBucketComplete?: (bucketId: number, bucketCount: number) => void;
}

export interface BucketedPrefixResult {
  bucketCount: number;
  /** Buckets skipped via verified checkpoints (resume). */
  skipped: number;
  /** Buckets (re)computed this run. */
  computed: number;
}

/**
 * Run one bucket's prefix (steps 2–7 equivalent) and COPY its source_state
 * slice to bucketFile. In-process: statement by statement on conn.
 * Out-of-process: one CLI script per bucket (preamble + statements + COPY),
 * so each bucket gets its own timeout/watchdog window.
 */
async function runBucketStatements(
  args: BucketedPrefixInput,
  bucket: NarrowBucket,
  bucketFile: string,
  cli: { preamble: string; spillDir: string; workDir: string } | null,
): Promise<void> {
  const stmts = buildNarrowBucketStatements({
    contributions: args.contributions,
    localPaths: args.localPaths,
    bucket,
    singleContribution: args.singleContribution,
  });
  // contrib_meta is per-run, not per-bucket: build once ahead of the loop
  // would split the statement list awkwardly, so buckets rebuild it (cheap
  // single-row INSERTs) — correctness identical, cost negligible.
  if (cli) {
    const scriptText =
      cli.preamble +
      [...stmts, buildBucketExportStatement(bucketFile)].join(";\n") +
      ";\n";
    await runDuckDbCliScript({
      scriptText,
      workDir: cli.workDir,
      spillDir: cli.spillDir,
      command: args.command,
      watchPaths: [bucketFile],
      onProgress: (p) => {
        reportStageProgress(
          `merge bucket ${bucket.id + 1}/${bucket.count} ` +
            `spillBytes=${p.spillBytes} wallMs=${p.wallMs}`,
        );
      },
    });
    return;
  }
  for (const stmt of stmts) {
    await runAll(args.conn, stmt);
  }
  await runAll(args.conn, buildBucketExportStatement(bucketFile));
  // Drop the bucket's working tables so the next bucket starts flat. The
  // bucket file on disk is the only thing that carries state forward.
  await runAll(
    args.conn,
    `DROP TABLE IF EXISTS changes;
     DROP TABLE IF EXISTS changes_narrow;
     DROP TABLE IF EXISTS changes_seq;
     DROP TABLE IF EXISTS per_pk_last_delete;
     DROP TABLE IF EXISTS effective_rows;
     DROP TABLE IF EXISTS source_state;`,
  );
}

/** Fingerprint + count of a bucket output file. Order-independent
 *  (bit_xor commutes), so it verifies SET equality, not row order. */
async function fingerprintBucketFile(
  conn: DuckDBConnection,
  bucketFile: string,
): Promise<{ rowCount: number; checksum: string | null }> {
  const lp = bucketFile.replace(/'/g, "''");
  const rows = await queryAll<Record<string, unknown>>(
    conn,
    buildBucketChecksumStatement(`read_parquet('${lp}')`),
  );
  return {
    rowCount: Number(rows[0]?.n ?? 0),
    checksum:
      rows[0]?.h === null || rows[0]?.h === undefined
        ? null
        : String(rows[0]?.h),
  };
}

/**
 * Hash-partitioned prefix. Buckets computed this run are COPY'd locally
 * (always) and uploaded + checkpointed when runKey is set; completed buckets
 * are re-downloaded and verified (count + checksum) instead of recomputed.
 * Ends with `source_state` materialized in-process from all bucket files —
 * downstream (edits, existing-load, merged_result) is untouched.
 */
export async function runBucketedMergePrefix(
  args: BucketedPrefixInput,
): Promise<BucketedPrefixResult> {
  const { bucketCount, runKey, conn } = args;
  if (bucketCount <= 1) {
    throw new Error(
      "runBucketedMergePrefix requires bucketCount > 1 (unbucketed narrow path handles 1)",
    );
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-buckets-"));
  const spillDir = path.join(workDir, "spill");
  const homeDir = process.env.DUCKDB_HOME_DIRECTORY ?? "/tmp/tellus-duckdb";
  const cli = args.outOfProcess
    ? {
        preamble: cliSettingsPreamble(resolveCliSettings(spillDir, homeDir)),
        spillDir,
        workDir,
      }
    : null;

  // contrib_meta once (shared by every bucket's statements? No — each
  // bucket script is self-contained and rebuilds it; see runBucketStatements).
  // Here: prime the shared table for NOTHING — buckets are self-contained.
  // (This comment exists so the next reader doesn't "optimize" it away.)

  const completed = runKey ? await readCompletedBuckets(runKey) : [];
  const localFiles: string[] = new Array(bucketCount);
  let skipped = 0;
  let computed = 0;

  // Resume: re-download verified outputs for completed buckets first, so a
  // failure halfway through verification still leaves earlier buckets local.
  // Verified ids go into `resumed`; anything else (missing, corrupt,
  // out-of-range) is recomputed below.
  const resumed: number[] = [];
  for (const cp of completed) {
    if (cp.bucket_id < 0 || cp.bucket_id >= bucketCount) continue;
    const local = path.join(workDir, `source_state_b${cp.bucket_id}.parquet`);
    try {
      await downloadToLocal(cp.output_key, local);
      const fp = await fingerprintBucketFile(conn, local);
      if (fp.rowCount === cp.row_count && fp.checksum === cp.checksum) {
        localFiles[cp.bucket_id] = local;
        resumed.push(cp.bucket_id);
        skipped++;
        continue;
      }
      console.warn(
        `[merge-buckets] bucket ${cp.bucket_id} output mismatch ` +
          `(file n=${fp.rowCount} h=${fp.checksum} vs checkpoint n=${cp.row_count} h=${cp.checksum}) — recomputing`,
      );
    } catch (err) {
      console.warn(
        `[merge-buckets] bucket ${cp.bucket_id} resume failed (${(err as Error).message}) — recomputing`,
      );
    }
    if (runKey) await deleteBucketCheckpoint(runKey, cp.bucket_id);
  }

  for (const b of pendingBuckets(bucketCount, resumed)) {
    const bucketFile = path.join(workDir, `source_state_b${b}.parquet`);
    await runBucketStatements(args, { id: b, count: bucketCount }, bucketFile, cli);
    const fp = await fingerprintBucketFile(conn, bucketFile);
    if (runKey) {
      const key = mergeBucketKey(args.objectTypeApiName, args.snapshotId, b);
      const stat = fs.statSync(bucketFile);
      const up = await uploadObject(
        key,
        fs.createReadStream(bucketFile),
        "application/vnd.apache.parquet",
        undefined,
        stat.size,
      );
      await writeBucketCheckpoint(runKey, b, fp.rowCount, fp.checksum, up.key);
    }
    localFiles[b] = bucketFile;
    computed++;
    args.onBucketComplete?.(b, bucketCount);
  }

  await runAll(conn, buildBucketAssemblyStatement(localFiles));

  // Bucket files are materialized into source_state now; drop the work dir.
  // Checkpoint rows + MinIO outputs (runKey runs) remain for future resumes.
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore — /tmp reaps it */
  }
  return { bucketCount, skipped, computed };
}
