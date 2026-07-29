// ---------------------------------------------------------------------------
// Track 2 item #9 — jemma_run_log retention and bounded growth.
// Real Postgres, real advisory locks, real batches.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveLogRetentionTunables,
  runLogRetentionCleanup,
  type LogRetentionTunables,
} from "../../../../src/services/functionsPublish/maintenance";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

const TUNABLES: LogRetentionTunables = {
  retentionDays: 30,
  batchSize: 100,
  maxBatches: 10,
  intervalMs: 3_600_000,
  artifactSweep: false, // artifact sweep has its own test file
};

async function insertRun(
  ctx: SchemaContext,
  opts: { state: string; ageDays: number | null; logs: number },
): Promise<string> {
  const rid = `ri.jemma.main.run.${randomUUID()}`;
  // jemma_run_lifecycle_chk: QUEUED ⇒ started_at IS NULL;
  // RUNNING ⇒ started_at NOT NULL, finished_at IS NULL;
  // terminal ⇒ finished_at NOT NULL.
  await ctx.query(
    `INSERT INTO jemma_run (rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
                            state, job_name, started_at, finished_at)
     VALUES ($1, $5, 'main', 'abcdef0', 'TAG', $2, $3, 'functions-publish',
             CASE WHEN $3 = 'QUEUED' THEN NULL ELSE now() END,
             CASE WHEN $4::int IS NULL THEN NULL
                  ELSE now() - ($4::int * interval '1 day') END)`,
    [rid, randomUUID(), opts.state, opts.ageDays,
      `ri.stemma.main.repository.00000000-0000-0000-0000-${randomUUID().slice(0, 12)}`],
  );
  for (let i = 0; i < opts.logs; i += 1) {
    await ctx.query(
      `INSERT INTO jemma_run_log(run_rid, stage_name, stream, message)
       VALUES ($1, 'setup', 'stdout', $2)`,
      [rid, `log line ${i}`],
    );
  }
  return rid;
}

async function logCount(ctx: SchemaContext, rid: string): Promise<number> {
  const result = await ctx.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM jemma_run_log WHERE run_rid = $1`,
    [rid],
  );
  return result.rows[0].n;
}

describe("functions-publish jemma_run_log retention (item #9)", () => {
  let ctx: SchemaContext;

  beforeEach(async () => {
    ctx = await openTestSchema("functions_publish_reten");
    await ctx.applyMigration("src/migrations/054_b6_jemma.sql");
    await ctx.applyMigration("src/migrations/055_b8_functions_registry.sql");
    await ctx.applyMigration("src/migrations/116_functions_publish_jobs.sql");
    await ctx.applyMigration("src/migrations/137_functions_publish_retry.sql");
    await ctx.applyMigration("src/migrations/142_jemma_run_log_retention.sql");
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("deletes old terminal-run logs; keeps recent, active, and queued logs", async () => {
    const oldFailed = await insertRun(ctx, {
      state: "FAILED", ageDays: 60, logs: 5,
    });
    const oldSucceeded = await insertRun(ctx, {
      state: "SUCCEEDED", ageDays: 31, logs: 5,
    });
    const recentFailed = await insertRun(ctx, {
      state: "FAILED", ageDays: 2, logs: 5,
    });
    // Active run OLDER than the cutoff — its logs are sacred.
    const activeOld = await insertRun(ctx, {
      state: "RUNNING", ageDays: null, logs: 5,
    });
    const queuedOld = await insertRun(ctx, {
      state: "QUEUED", ageDays: null, logs: 5,
    });

    const result = await runLogRetentionCleanup(ctx.pool, TUNABLES);
    expect(result.skipped).toBe(false);
    expect(result.disabled).toBe(false);
    expect(result.deleted).toBe(10);

    expect(await logCount(ctx, oldFailed)).toBe(0);
    expect(await logCount(ctx, oldSucceeded)).toBe(0);
    expect(await logCount(ctx, recentFailed)).toBe(5);
    expect(await logCount(ctx, activeOld)).toBe(5);
    expect(await logCount(ctx, queuedOld)).toBe(5);

    // Run rows themselves are untouched (FK direction preserved).
    const runs = await ctx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM jemma_run`);
    expect(runs.rows[0].n).toBe(5);
  });

  it("honors the batch limit across bounded batches", async () => {
    const rid = await insertRun(ctx, {
      state: "SUCCEEDED", ageDays: 90, logs: 250,
    });
    const oneBatch = await runLogRetentionCleanup(ctx.pool, {
      ...TUNABLES, batchSize: 100, maxBatches: 1,
    });
    expect(oneBatch.deleted).toBe(100);
    expect(oneBatch.batches).toBe(1);
    expect(await logCount(ctx, rid)).toBe(150);

    const rest = await runLogRetentionCleanup(ctx.pool, {
      ...TUNABLES, batchSize: 100, maxBatches: 10,
    });
    expect(rest.deleted).toBe(150);
    expect(await logCount(ctx, rid)).toBe(0);
  });

  it("serializes concurrent cleanup workers via the advisory lock", async () => {
    await insertRun(ctx, {
      state: "FAILED", ageDays: 60, logs: 10,
    });
    // Hold the lock with a raw client; a second cleanup must skip.
    const holder = await ctx.pool.connect();
    try {
      const held = await holder.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('functions-publish-log-retention')) AS locked`,
      );
      expect(held.rows[0].locked).toBe(true);
      const concurrent = await runLogRetentionCleanup(ctx.pool, TUNABLES);
      expect(concurrent.skipped).toBe(true);
      expect(concurrent.deleted).toBe(0);
    } finally {
      await holder.query(
        `SELECT pg_advisory_unlock(hashtext('functions-publish-log-retention'))`,
      );
      holder.release();
    }
    // After release the cleanup proceeds.
    const after = await runLogRetentionCleanup(ctx.pool, TUNABLES);
    expect(after.skipped).toBe(false);
    expect(after.deleted).toBe(10);
  });

  it("is idempotent: a repeated pass deletes nothing more", async () => {
    await insertRun(ctx, {
      state: "CANCELLED", ageDays: 45, logs: 7,
    });
    const first = await runLogRetentionCleanup(ctx.pool, TUNABLES);
    expect(first.deleted).toBe(7);
    const second = await runLogRetentionCleanup(ctx.pool, TUNABLES);
    expect(second.deleted).toBe(0);
    expect(second.batches).toBe(1);
  });

  it("retentionDays = 0 disables cleanup entirely", async () => {
    const rid = await insertRun(ctx, {
      state: "FAILED", ageDays: 365, logs: 3,
    });
    const result = await runLogRetentionCleanup(ctx.pool, {
      ...TUNABLES, retentionDays: 0,
    });
    expect(result.disabled).toBe(true);
    expect(result.deleted).toBe(0);
    expect(await logCount(ctx, rid)).toBe(3);
  });

  it("cleanup failure does not affect publishing tables", async () => {
    // A pool wrapper that fails only the DELETE — the cleanup
    // runs on a connect()-ed client, so wrap client queries too.
    class FailDeletePool {
      query(...args: unknown[]): Promise<unknown> {
        if (/DELETE FROM jemma_run_log/.test(String(args[0]))) {
          const error = new Error("injected delete failure") as Error & { code: string };
          error.code = "57014";
          return Promise.reject(error);
        }
        return (ctx.pool as { query: (...a: unknown[]) => Promise<unknown> }).query(...args);
      }
      async connect() {
        const client = await ctx.pool.connect();
        return {
          async query(text: unknown, ...rest: unknown[]) {
            if (/DELETE FROM jemma_run_log/.test(String(text))) {
              const error = new Error("injected delete failure") as Error & { code: string };
              error.code = "57014";
              throw error;
            }
            return client.query(text as string, ...(rest as never[]));
          },
          release() {
            client.release();
          },
        };
      }
      on(): this {
        return this;
      }
      async end(): Promise<void> { /* owned */ }
    }
    const rid = await insertRun(ctx, {
      state: "FAILED", ageDays: 60, logs: 4,
    });
    await expect(
      runLogRetentionCleanup(new FailDeletePool() as unknown as Pool, TUNABLES),
    ).rejects.toThrow("injected delete failure");
    // Logs and runs intact — nothing half-applied.
    expect(await logCount(ctx, rid)).toBe(4);
  });

  it("the driving query uses the terminal-finished index", async () => {
    const plan = await ctx.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT rid FROM jemma_run
        WHERE state = ANY(ARRAY['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT']::text[])
          AND finished_at < now() - interval '30 days'
        ORDER BY finished_at
        LIMIT 200`,
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("jemma_run_terminal_finished_idx");
  });

  it("env resolution: defaults and overrides", () => {
    const defaults = resolveLogRetentionTunables({});
    expect(defaults.retentionDays).toBe(30);
    expect(defaults.batchSize).toBe(10_000);
    expect(defaults.artifactSweep).toBe(true);
    const off = resolveLogRetentionTunables({
      FUNCTIONS_PUBLISH_LOG_RETENTION_DAYS: "0",
      FUNCTIONS_PUBLISH_ARTIFACT_SWEEP: "0",
    } as NodeJS.ProcessEnv);
    expect(off.retentionDays).toBe(0);
    expect(off.artifactSweep).toBe(false);
  });
});
