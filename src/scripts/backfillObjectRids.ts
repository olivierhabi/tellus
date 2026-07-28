import { pool } from "../db";
import type { PoolClient, QueryResult } from "pg";

// The local production-parity Postgres profile is intentionally capped at
// 512 MiB. One thousand rows keeps each heap/index mutation transaction well
// below that envelope even for wide JSONB objects.
const DEFAULT_BATCH_SIZE = 1_000;
const ADVISORY_LOCK_KEY = 1_380_013_800;
const MAX_BATCH_RETRIES = 10;

function batchSize(): number {
  const value = Number(
    process.env.TELLUS_OBJECT_RID_BACKFILL_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
  );
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(
      "TELLUS_OBJECT_RID_BACKFILL_BATCH_SIZE must be an integer from 1 to 100000",
    );
  }
  return value;
}

async function ensureConcurrentIndex(
  name: "tmp_oi_rid_null" | "idx_object_instances_rid",
  createSql: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("SET maintenance_work_mem = '8MB'");
    await client.query("SET max_parallel_maintenance_workers = 0");
    const existing = await client.query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [name],
    );
    if (existing.rows[0]?.indisvalid === false) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    }
    if (existing.rows[0]?.indisvalid !== true) {
      await client.query(createSql);
    }
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const size = batchSize();
  let total = 0;
  const startedAt = Date.now();
  try {
    // Keep the operator command independently deployable: it can run
    // before or after the migration gate reaches migration 138.
    await pool.query(
      "ALTER TABLE object_instances ADD COLUMN IF NOT EXISTS rid TEXT",
    );
    await pool.query(
      `ALTER TABLE object_instances
         ALTER COLUMN rid
         SET DEFAULT ('ri.tellus.main.object.' || gen_random_uuid())`,
    );
    // A nullable-column heap scan gets progressively worse as early pages
    // are filled. Keep a resumable partial index for the duration of the
    // backfill. CONCURRENTLY is valid because this statement is autocommit.
    await ensureConcurrentIndex(
      "tmp_oi_rid_null",
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS tmp_oi_rid_null
         ON object_instances (rid)
      WHERE rid IS NULL`,
    );

    for (let batch = 1; ; batch += 1) {
      let updated: number | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt += 1) {
        let client: PoolClient | null = null;
        let poisoned = false;
        try {
          const acquired = await pool.connect();
          client = acquired;
          // A cgroup may kill one PostgreSQL backend while the postmaster
          // remains healthy. node-postgres can emit that termination after
          // the query promise has rejected; keep it on the retry path instead
          // of letting an unhandled Client event terminate the process.
          acquired.on("error", (error) => {
            lastError = error;
            poisoned = true;
          });
          await acquired.query("BEGIN");
          await acquired.query("SET LOCAL enable_seqscan = off");
          await acquired.query("SET LOCAL jit = off");
          await acquired.query("SET LOCAL work_mem = '1MB'");
          // Transaction-scoped guard prevents accidental concurrent
          // operators; FOR UPDATE SKIP LOCKED remains the safety net.
          const lock = await acquired.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_xact_lock($1) AS acquired",
            [ADVISORY_LOCK_KEY],
          );
          if (lock.rows[0]?.acquired !== true) {
            throw new Error(
              "Another object RID backfill transaction owns the lock.",
            );
          }
          const result = await acquired.query(
            `WITH batch AS (
               SELECT ctid
                 FROM object_instances
                WHERE rid IS NULL
                LIMIT $1
                FOR UPDATE SKIP LOCKED
             )
             UPDATE object_instances AS oi
                SET rid = 'ri.tellus.main.object.' || gen_random_uuid()
               FROM batch
              WHERE oi.ctid = batch.ctid`,
            [size],
          );
          await acquired.query("COMMIT");
          updated = result.rowCount ?? 0;
          break;
        } catch (error) {
          lastError = error;
          poisoned = true;
          await client?.query("ROLLBACK").catch(() => undefined);
          if (attempt < MAX_BATCH_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 250));
          }
        } finally {
          client?.release(poisoned);
        }
      }
      if (updated === null) {
        throw lastError instanceof Error
          ? lastError
          : new Error("Object RID batch failed after bounded retries.");
      }
      total += updated;
      if (updated === 0) break;
      if (batch === 1 || batch % 25 === 0 || updated < size) {
        process.stdout.write(
          JSON.stringify({
            event: "object_rid_backfill.progress",
            batch,
            updated,
            total,
            elapsedMs: Date.now() - startedAt,
          }) + "\n",
        );
      }
    }

    const probeClient = await pool.connect();
    let nullProbe: QueryResult;
    try {
      await probeClient.query("SET enable_seqscan = off");
      nullProbe = await probeClient.query(
        "SELECT 1 FROM object_instances WHERE rid IS NULL LIMIT 1",
      );
    } finally {
      probeClient.release();
    }
    if (nullProbe.rows.length > 0) {
      throw new Error("Object RID backfill ended while NULL rows still exist.");
    }
    await ensureConcurrentIndex(
      "idx_object_instances_rid",
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_object_instances_rid
         ON object_instances (rid)
      WHERE rid IS NOT NULL`,
    );
    await pool.query(
      "DROP INDEX CONCURRENTLY IF EXISTS tmp_oi_rid_null",
    );
    process.stdout.write(
      JSON.stringify({
        event: "object_rid_backfill.complete",
        total,
        elapsedMs: Date.now() - startedAt,
      }) + "\n",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      event: "object_rid_backfill.failed",
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
  process.exitCode = 1;
});
