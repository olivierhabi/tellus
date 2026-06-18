// ---------------------------------------------------------------------------
// B6 — Jemma DDL roundtrip integration tests.
//
// Exercises every CHECK constraint, every UNIQUE/partial index, and the
// reversibility of migration 054 against a real Postgres instance.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openTestSchema } from "../_helpers/pg";

const ROOT = process.cwd();
const UP_054 = readFileSync(path.join(ROOT, "src/migrations/054_b6_jemma.sql"), "utf-8");
const DOWN_054 = readFileSync(
  path.join(ROOT, "src/migrations/054_b6_jemma.down.sql"),
  "utf-8",
);

const REPO_RID = "ri.stemma.main.repository." + randomUUID();
const USER_UUID = "ab78f128-9c4e-4b65-9d80-f0a3a7e0c102";

const ts = (s: string) => `'${s}'::timestamptz`;

function insertRunSql(args: {
  rid: string;
  ref?: string;
  state?: string;
  trigger?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  podName?: string | null;
  failureReason?: string | null;
  commitSha?: string;
}): string {
  const ref = args.ref ?? "refs/heads/main";
  const state = args.state ?? "QUEUED";
  const trigger = args.trigger ?? "PUSH";
  const startedAt = args.startedAt === undefined ? null : args.startedAt;
  const finishedAt = args.finishedAt === undefined ? null : args.finishedAt;
  const podName = args.podName === undefined ? null : args.podName;
  const failureReason = args.failureReason === undefined ? null : args.failureReason;
  const commitSha = args.commitSha ?? "abc1234";
  return `
    INSERT INTO jemma_run (
      rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
      state, pod_name, started_at, finished_at, failure_reason
    ) VALUES (
      '${args.rid}', '${REPO_RID}', '${ref}', '${commitSha}', '${trigger}',
      '${USER_UUID}', '${state}',
      ${podName === null ? "NULL" : `'${podName}'`},
      ${startedAt === null ? "NULL" : `${ts(startedAt)}`},
      ${finishedAt === null ? "NULL" : `${ts(finishedAt)}`},
      ${failureReason === null ? "NULL" : `'${failureReason}'`}
    );
  `;
}

describe("Migration 054 — B6 Jemma DDL roundtrip", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;

  beforeAll(async () => {
    openSchema = await openTestSchema("jemma_ddl");
    await openSchema.applyMigrationSql(UP_054);
  });

  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });

  it("creates jemma_run + jemma_run_stage tables", async () => {
    const r = await openSchema.query(
      `SELECT relname FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND relkind='r' AND relname LIKE 'jemma%'
       ORDER BY relname`,
      [openSchema.schema],
    );
    expect(r.rows.map((x) => x.relname)).toEqual(["jemma_run", "jemma_run_stage"]);
  });

  it("rejects state outside the 6-value enum (CHECK violation)", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(insertRunSql({ rid, state: "BOGUS_STATE" })),
    ).rejects.toThrow(/jemma_run_state_chk|check constraint/i);
  });

  it("rejects trigger_kind outside the 4-value enum", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(insertRunSql({ rid, trigger: "FOO" })),
    ).rejects.toThrow(/jemma_run_trigger_chk|check constraint/i);
  });

  it("lifecycle CHECK: QUEUED forbids started_at", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(
        insertRunSql({ rid, state: "QUEUED", startedAt: "2026-05-01T00:00:00Z" }),
      ),
    ).rejects.toThrow(/jemma_run_lifecycle_chk|check constraint/i);
  });

  it("lifecycle CHECK: RUNNING requires started_at, forbids finished_at", async () => {
    const rid1 = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(insertRunSql({ rid: rid1, state: "RUNNING" })),
    ).rejects.toThrow(/jemma_run_lifecycle_chk|check constraint/i);

    const rid2 = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(
        insertRunSql({
          rid: rid2,
          state: "RUNNING",
          startedAt: "2026-05-01T00:00:00Z",
          finishedAt: "2026-05-01T00:00:01Z",
        }),
      ),
    ).rejects.toThrow(/jemma_run_lifecycle_chk|check constraint/i);
  });

  it("lifecycle CHECK: terminal states require finished_at", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(
        insertRunSql({
          rid,
          state: "SUCCEEDED",
          startedAt: "2026-05-01T00:00:00Z",
        }),
      ),
    ).rejects.toThrow(/jemma_run_lifecycle_chk|check constraint/i);
  });

  it("commit_sha CHECK: enforces hex 7-64", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await expect(
      openSchema.query(insertRunSql({ rid, commitSha: "ZZZZ" })),
    ).rejects.toThrow(/jemma_run_commit_sha_chk|check constraint/i);
  });

  it("partial unique index: at most one ACTIVE run per (repo,ref)", async () => {
    const ridA = `ri.jemma.main.run.${randomUUID()}`;
    const ridB = `ri.jemma.main.run.${randomUUID()}`;
    const ref = `refs/heads/active-${randomUUID().slice(0, 8)}`;
    await openSchema.query(insertRunSql({ rid: ridA, ref, state: "QUEUED" }));
    await expect(
      openSchema.query(insertRunSql({ rid: ridB, ref, state: "QUEUED" })),
    ).rejects.toThrow(/jemma_run_active_per_ref_uq|duplicate|unique/i);
  });

  it("partial unique index allows one ACTIVE + many TERMINAL on same ref", async () => {
    const ridA = `ri.jemma.main.run.${randomUUID()}`;
    const ridB = `ri.jemma.main.run.${randomUUID()}`;
    const ridC = `ri.jemma.main.run.${randomUUID()}`;
    const ref = `refs/heads/term-${randomUUID().slice(0, 8)}`;
    await openSchema.query(
      insertRunSql({
        rid: ridA,
        ref,
        state: "SUCCEEDED",
        startedAt: "2026-05-01T00:00:00Z",
        finishedAt: "2026-05-01T00:01:00Z",
      }),
    );
    await openSchema.query(
      insertRunSql({
        rid: ridB,
        ref,
        state: "FAILED",
        startedAt: "2026-05-01T00:02:00Z",
        finishedAt: "2026-05-01T00:03:00Z",
        failureReason: "stage-failed",
      }),
    );
    // Now one ACTIVE is allowed.
    await openSchema.query(insertRunSql({ rid: ridC, ref, state: "QUEUED" }));
    const r = await openSchema.query(
      `SELECT count(*)::int AS n FROM jemma_run WHERE repository_rid=$1 AND ref=$2`,
      [REPO_RID, ref],
    );
    expect(r.rows[0].n).toBe(3);
  });

  it("jemma_run_stage CHECK: stage_name + state CHECK constraints", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await openSchema.query(
      insertRunSql({ rid, ref: `refs/heads/stage-${randomUUID().slice(0, 8)}` }),
    );
    await expect(
      openSchema.query(
        `INSERT INTO jemma_run_stage (run_rid, stage_name, state) VALUES ($1,$2,$3)`,
        [rid, "bogus_stage", "PENDING"],
      ),
    ).rejects.toThrow(/jemma_run_stage_name_chk|check constraint/i);
    await expect(
      openSchema.query(
        `INSERT INTO jemma_run_stage (run_rid, stage_name, state) VALUES ($1,$2,$3)`,
        [rid, "lint", "BOGUS_STATE"],
      ),
    ).rejects.toThrow(/jemma_run_stage_state_chk|check constraint/i);
    await openSchema.query(
      `INSERT INTO jemma_run_stage (run_rid, stage_name, state) VALUES ($1,$2,$3)`,
      [rid, "lint", "PENDING"],
    );
  });

  it("ON DELETE CASCADE removes orphaned stages", async () => {
    const rid = `ri.jemma.main.run.${randomUUID()}`;
    await openSchema.query(
      insertRunSql({ rid, ref: `refs/heads/cascade-${randomUUID().slice(0, 8)}` }),
    );
    await openSchema.query(
      `INSERT INTO jemma_run_stage (run_rid, stage_name, state) VALUES ($1,$2,$3)`,
      [rid, "setup", "PENDING"],
    );
    await openSchema.query(`DELETE FROM jemma_run WHERE rid=$1`, [rid]);
    const r = await openSchema.query(
      `SELECT count(*)::int AS n FROM jemma_run_stage WHERE run_rid=$1`,
      [rid],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("DOWN drops both tables; UP recreates idempotently", async () => {
    await openSchema.applyMigrationSql(DOWN_054);
    const r1 = await openSchema.query(
      `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND relname IN ('jemma_run','jemma_run_stage')`,
      [openSchema.schema],
    );
    expect(r1.rows[0].n).toBe(0);
    await openSchema.applyMigrationSql(UP_054);
    const r2 = await openSchema.query(
      `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND relname IN ('jemma_run','jemma_run_stage')`,
      [openSchema.schema],
    );
    expect(r2.rows[0].n).toBe(2);
  });
});
