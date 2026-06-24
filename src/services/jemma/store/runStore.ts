// ---------------------------------------------------------------------------
// B6 — Jemma run + stage store.
//
// CRUD over `jemma_run` and `jemma_run_stage` tables. All mutations honour
// the lifecycle CHECK constraint enforced by migration 054 — the state
// machine (state/stateMachine.ts) is the single authority on legal state
// transitions, and this store persists the resulting RunContext as-is.
//
// SERIALIZABLE on writes that participate in concurrency invariants
// (insertRun via the partial unique index; transitionRun via row-level lock).
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";
import type {
  FailureReason,
  RunContext,
  RunState,
  RunTrigger,
  StageName,
  StageState,
} from "../state/types";
import { STAGE_NAMES } from "../state/types";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface InsertRunArgs {
  readonly rid: string;
  readonly repositoryRid: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly trigger: RunTrigger;
  readonly triggeredBy: string;          // UUID
  readonly idempotencyKey: string | null;
}

export interface RunRow {
  readonly rid: string;
  readonly repositoryRid: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly trigger: RunTrigger;
  readonly triggeredBy: string;
  readonly state: RunState;
  readonly podName: string | null;
  readonly queuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly exitCode: number | null;
  readonly failureReason: FailureReason | null;
  readonly resourceVersion: number;
  readonly idempotencyKey: string | null;
}

export interface StageRow {
  readonly runRid: string;
  readonly stageName: StageName;
  readonly state: StageState;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly logObjectUri: string | null;
  readonly exitCode: number | null;
}

export class RunStoreError extends Error {
  readonly code:
    | "ACTIVE_RUN_EXISTS_FOR_REF"
    | "RUN_NOT_FOUND"
    | "DUPLICATE_RUN_RID"
    | "INVALID_PERSISTED_STATE";
  constructor(code: RunStoreError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "RunStoreError";
  }
}

// ---------------------------------------------------------------------------
// insertRun — creates a QUEUED run + 5 PENDING stage rows in one tx.
// ---------------------------------------------------------------------------

/**
 * Insert a fresh QUEUED run. Honours the 054 partial unique index: at most
 * one ACTIVE (QUEUED|RUNNING) run per (repository_rid, ref). On collision,
 * throws RunStoreError("ACTIVE_RUN_EXISTS_FOR_REF") so the scheduler can
 * decide whether to cancel-in-flight + retry.
 */
export async function insertRun(pool: Pool, args: InsertRunArgs): Promise<RunRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const r = await client.query(
        `INSERT INTO jemma_run (
          rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
          state, idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7)
        RETURNING rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
                  state, pod_name, queued_at, started_at, finished_at, exit_code,
                  failure_reason, resource_version, idempotency_key`,
        [
          args.rid,
          args.repositoryRid,
          args.ref,
          args.commitSha,
          args.trigger,
          args.triggeredBy,
          args.idempotencyKey,
        ],
      );
      // Insert all 5 stage rows in canonical order.
      for (const stage of STAGE_NAMES) {
        await client.query(
          `INSERT INTO jemma_run_stage (run_rid, stage_name, state)
           VALUES ($1, $2, 'PENDING')`,
          [args.rid, stage],
        );
      }
      await client.query("COMMIT");
      return mapRunRow(r.rows[0]);
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      const e = err as { code?: string; constraint?: string; message?: string };
      // Postgres unique violation = 23505.
      if (e.code === "23505") {
        if (e.constraint === "jemma_run_pkey") {
          throw new RunStoreError(
            "DUPLICATE_RUN_RID",
            `run rid already exists: ${args.rid}`,
          );
        }
        // Partial UQ on (repo, ref) WHERE state IN ('QUEUED','RUNNING').
        if (e.constraint === "jemma_run_active_per_ref_uq") {
          throw new RunStoreError(
            "ACTIVE_RUN_EXISTS_FOR_REF",
            `an ACTIVE run already exists for ${args.repositoryRid} @ ${args.ref}`,
          );
        }
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// getRun — read-side.
// ---------------------------------------------------------------------------

export async function getRun(pool: Pool, rid: string): Promise<RunRow | null> {
  const r = await pool.query(
    `SELECT rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
            state, pod_name, queued_at, started_at, finished_at, exit_code,
            failure_reason, resource_version, idempotency_key
       FROM jemma_run WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) return null;
  return mapRunRow(r.rows[0]);
}

export async function getRunStages(pool: Pool, runRid: string): Promise<StageRow[]> {
  const r = await pool.query(
    `SELECT run_rid, stage_name, state, started_at, finished_at,
            log_object_uri, exit_code
       FROM jemma_run_stage WHERE run_rid = $1
       ORDER BY array_position(
         ARRAY['setup','lint','test','build','publish']::text[],
         stage_name
       )`,
    [runRid],
  );
  return r.rows.map(mapStageRow);
}

// ---------------------------------------------------------------------------
// listActiveRunsForRepo — used by scheduler to enforce per-repo cap.
// ---------------------------------------------------------------------------

export async function listActiveRunsForRepo(
  pool: Pool,
  repositoryRid: string,
): Promise<RunRow[]> {
  const r = await pool.query(
    `SELECT rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
            state, pod_name, queued_at, started_at, finished_at, exit_code,
            failure_reason, resource_version, idempotency_key
       FROM jemma_run
       WHERE repository_rid = $1 AND state IN ('QUEUED','RUNNING')
       ORDER BY queued_at ASC`,
    [repositoryRid],
  );
  return r.rows.map(mapRunRow);
}

export async function getActiveRunForRef(
  pool: Pool,
  repositoryRid: string,
  ref: string,
): Promise<RunRow | null> {
  const r = await pool.query(
    `SELECT rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
            state, pod_name, queued_at, started_at, finished_at, exit_code,
            failure_reason, resource_version, idempotency_key
       FROM jemma_run
       WHERE repository_rid = $1 AND ref = $2 AND state IN ('QUEUED','RUNNING')
       LIMIT 1`,
    [repositoryRid, ref],
  );
  if (r.rowCount === 0) return null;
  return mapRunRow(r.rows[0]);
}

// ---------------------------------------------------------------------------
// transitionRunWithinTx — persists a state-machine transition. Caller drives
// transition() to compute the new RunContext, then calls this to flush.
// ---------------------------------------------------------------------------

export async function transitionRunWithinTx(
  client: PoolClient,
  rid: string,
  next: RunContext,
): Promise<void> {
  await client.query(
    `UPDATE jemma_run SET
       state = $2,
       pod_name = $3,
       started_at = $4,
       finished_at = $5,
       failure_reason = $6,
       resource_version = resource_version + 1,
       updated_at = now()
     WHERE rid = $1`,
    [
      rid,
      next.state,
      next.podName,
      next.startedAt ? new Date(next.startedAt) : null,
      next.finishedAt ? new Date(next.finishedAt) : null,
      next.failureReason,
    ],
  );
  // Persist stage states (idempotent — UPDATE only when state changes).
  for (const stage of next.stages) {
    await client.query(
      `UPDATE jemma_run_stage SET state = $3
       WHERE run_rid = $1 AND stage_name = $2 AND state IS DISTINCT FROM $3`,
      [rid, stage.name, stage.state],
    );
  }
}

// ---------------------------------------------------------------------------
// findByIdempotencyKey — for idempotent run starts (G-C-22).
// ---------------------------------------------------------------------------

export async function findRunByIdempotencyKey(
  pool: Pool,
  key: string,
  triggeredBy: string,
): Promise<RunRow | null> {
  const r = await pool.query(
    `SELECT rid, repository_rid, ref, commit_sha, trigger_kind, triggered_by,
            state, pod_name, queued_at, started_at, finished_at, exit_code,
            failure_reason, resource_version, idempotency_key
       FROM jemma_run
       WHERE idempotency_key = $1 AND triggered_by = $2
       LIMIT 1`,
    [key, triggeredBy],
  );
  if (r.rowCount === 0) return null;
  return mapRunRow(r.rows[0]);
}

// ---------------------------------------------------------------------------
// rebuildRunContext — load run + stages and compose a RunContext for the
// state machine.
// ---------------------------------------------------------------------------

export async function rebuildRunContext(
  pool: Pool,
  rid: string,
): Promise<{ row: RunRow; ctx: RunContext } | null> {
  const row = await getRun(pool, rid);
  if (!row) return null;
  const stages = await getRunStages(pool, rid);
  const ctx: RunContext = {
    state: row.state,
    podName: row.podName,
    currentStage: stages.find((s) => s.state === "RUNNING")?.stageName ?? null,
    stages: stages.map((s) => ({ name: s.stageName, state: s.state })),
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    failureReason: row.failureReason,
  };
  return { row, ctx };
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function mapRunRow(r: Record<string, unknown>): RunRow {
  return {
    rid: r.rid as string,
    repositoryRid: r.repository_rid as string,
    ref: r.ref as string,
    commitSha: r.commit_sha as string,
    trigger: r.trigger_kind as RunTrigger,
    triggeredBy: r.triggered_by as string,
    state: r.state as RunState,
    podName: (r.pod_name as string | null) ?? null,
    queuedAt: r.queued_at as Date,
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
    failureReason: (r.failure_reason as FailureReason | null) ?? null,
    resourceVersion: r.resource_version as number,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
  };
}

function mapStageRow(r: Record<string, unknown>): StageRow {
  return {
    runRid: r.run_rid as string,
    stageName: r.stage_name as StageName,
    state: r.state as StageState,
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
    logObjectUri: (r.log_object_uri as string | null) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
  };
}
