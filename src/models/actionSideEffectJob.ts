// ---------------------------------------------------------------------------
// Action Side-Effect Job Model
//
// CRUD + claim path for the `action_side_effect_job` table created by
// migration 131. The actionExecutor.preCommitHook INSERTS one row per
// side effect (webhook fanout, notification) IN THE SAME PG TRANSACTION
// as the action's edits commit — so the side-effect job is atomic with
// the ontology commit (a side effect's failure NEVER rolls back
// committed edits; the row is durable in the outbox the moment the
// ontology commits).
//
// The stateless worker (Phase 5 — `services/workers/sideEffectWorker.ts`)
// claims rows via `SELECT ... FOR UPDATE SKIP LOCKED` ordered by
// `next_attempt_at` + `created_at`, dispatches via the registered
// transport (WebhookDispatcher / NotificationProvider), updates the
// row in-place, and moves exhausted jobs to 'dead' for operator review.
//
// Phase 5 ships the model + claim path + worker; Phase 6 ships the
// metrics + structured logs + tracing spans around the worker.
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";
import type { PoolClient } from "pg";

export type SideEffectJobKind = "webhook" | "notification";
export type SideEffectJobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "retrying"
  | "failed"
  | "dead";

export interface SideEffectJobRow {
  job_id: string;
  execution_id: string;
  action_type_id: string;
  action_type_version: number;
  side_effect_index: number;
  kind: SideEffectJobKind;
  payload: Record<string, unknown>;
  status: SideEffectJobStatus;
  attempt_count: number;
  last_error_code: string | null;
  last_error_at: string | null;
  next_attempt_at: string | null;
  idempotency_key: string | null;
  external_receipt: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueSideEffectJobsInput {
  executionId: string;
  actionTypeId: string;
  actionTypeVersion: number;
  jobs: Array<{
    sideEffectIndex: number;
    kind: SideEffectJobKind;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }>;
}

/**
 * Enqueue side-effect jobs IN THE CALLER'S PG TRANSACTION. The caller
 * (actionExecutor's preCommitHook) passes a PoolClient that's already
 * in the same transaction as the action's edits — so the INSERT is
 * atomic with the action commit. A side-effect failure later (the
 * worker dispatches post-commit) NEVER rolls back this INSERT.
 *
 * The unique `(execution_id, side_effect_index)` partial index in the
 * DB protects against double-enqueue (the executor's preCommitHook is
 * called exactly once per execution).
 */
export async function enqueueSideEffectJobsInTransaction(
  client: PoolClient,
  input: EnqueueSideEffectJobsInput,
): Promise<SideEffectJobRow[]> {
  if (input.jobs.length === 0) return [];
  const inserted: SideEffectJobRow[] = [];
  for (const job of input.jobs) {
    const result = await client.query(
      `INSERT INTO action_side_effect_job
         (execution_id, action_type_id, action_type_version,
          side_effect_index, kind, payload, status, attempt_count,
          next_attempt_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, now(), $7)
       RETURNING *`,
      [
        input.executionId,
        input.actionTypeId,
        input.actionTypeVersion,
        job.sideEffectIndex,
        job.kind,
        JSON.stringify(job.payload),
        job.idempotencyKey ?? null,
      ],
    );
    inserted.push(result.rows[0] as SideEffectJobRow);
  }
  return inserted;
}

/**
 * Worker claim path. SELECT ... FOR UPDATE SKIP LOCKED against the
 * pending/retrying queue, ordered by next_attempt_at + created_at.
 * Returns up to `limit` jobs marked in 'running' state, with the
 * claiming worker's hold time protected by the FOR UPDATE lock so a
 * duplicate concurrent worker cannot claim the same job.
 *
 * The worker is responsible for updating the row to 'succeeded',
 * 'retrying' (with next_attempt_at = now() + bounded-backoff), or
 * 'failed'/'dead' (attemptCount exhausted).
 *
 * The `claimId` field of the caller is recorded as `last_error_code`
 * while running so a stuck worker's jobs are visible (NULL when none).
 */
export async function claimSideEffectJobs(
  limit: number,
): Promise<SideEffectJobRow[]> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT job_id FROM action_side_effect_job
        WHERE status IN ('pending', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY next_attempt_at NULLS FIRST, created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const jobIds = result.rows.map((r: any) => r.job_id);
    if (jobIds.length === 0) {
      await client.query("COMMIT");
      return [];
    }
    const claimed = await client.query(
      `UPDATE action_side_effect_job
          SET status = 'running', updated_at = now()
        WHERE job_id = ANY($1::uuid[])
       RETURNING *`,
      [jobIds],
    );
    await client.query("COMMIT");
    return claimed.rows as SideEffectJobRow[];
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Worker success path. Idempotent on (`job_id`, `attempt_count`) — the
 * worker sends the idempotency-key derived from those values on every
 * retry so an external system that received a previous delivery can
 * deduplicate safely.
 */
export async function markSideEffectJobSucceeded(
  jobId: string,
  externalReceipt?: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE action_side_effect_job
        SET status = 'succeeded', updated_at = now(),
            external_receipt = COALESCE($2, external_receipt)
      WHERE job_id = $1`,
    [jobId, externalReceipt ? JSON.stringify(externalReceipt) : null],
  );
}

/**
 * Worker retry/fail path. Bounded exponential backoff with jitter —
 * matches the spec §10 "bounded exponential backoff + jitter + retry
 * limits + dead-letter state". On exhaustion (attemptCount >=
 * maxAttempts) the row transitions to 'dead' and surfaces in the
 * operator-visible "dead letter" `idx_action_side_effect_job_dead`
 * partial index for operator retry / manual inspection.
 */
export async function markSideEffectJobRetryOrDead(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  retryPolicy: { maxAttempts: number; initialBackoffMs: number; maxBackoffMs: number; multiplier: number; jitterMs: number },
): Promise<"retrying" | "dead"> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT attempt_count FROM action_side_effect_job WHERE job_id = $1 FOR UPDATE",
      [jobId],
    );
    if (r.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new Error(`Side effect job '${jobId}' not found.`);
    }
    const currentAttempt: number = r.rows[0].attempt_count ?? 0;
    const nextAttempt: number = currentAttempt + 1;
    if (nextAttempt >= retryPolicy.maxAttempts) {
      await client.query(
        `UPDATE action_side_effect_job
            SET status = 'dead', attempt_count = $2, last_error_code = $3,
                last_error_at = now(), next_attempt_at = NULL,
                updated_at = now()
          WHERE job_id = $1`,
        [jobId, nextAttempt, errorCode],
      );
      await client.query("COMMIT");
      return "dead";
    }
    // Compute next attempt time with bounded exponential backoff + jitter.
    const baseMs = Math.min(
      retryPolicy.maxBackoffMs,
      retryPolicy.initialBackoffMs * Math.pow(retryPolicy.multiplier, nextAttempt),
    );
    const jitter = Math.floor(Math.random() * retryPolicy.jitterMs);
    const nextAttemptAt = new Date(Date.now() + baseMs + jitter).toISOString();
    await client.query(
      `UPDATE action_side_effect_job
          SET status = 'retrying', attempt_count = $2, last_error_code = $3,
              last_error_at = now(), next_attempt_at = $4, updated_at = now()
        WHERE job_id = $1`,
      [jobId, nextAttempt, errorCode, nextAttemptAt],
    );
    await client.query("COMMIT");
    return "retrying";
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Operator-triggered retry — re-queue a 'dead' job with attempt_count
 * reset and idempotency-key preserved (so external system can dedup
 * against the original delivery AND the operator's retry).
 */
export async function requeueDeadSideEffectJob(
  jobId: string,
): Promise<SideEffectJobRow | null> {
  const result = await query(
    `UPDATE action_side_effect_job
        SET status = 'pending', attempt_count = 0,
            next_attempt_at = now(), updated_at = now()
      WHERE job_id = $1 AND status = 'dead'
     RETURNING *`,
    [jobId],
  );
  return result.rows.length > 0 ? (result.rows[0] as SideEffectJobRow) : null;
}

/**
 * List current queue stats for operator dashboards. Phase 5 ships the
 * minimal surface (counts by status); Phase 6 ships Prometheus export
 * via the existing metrics pipeline.
 */
export async function getSideEffectQueueStats(): Promise<
  Record<SideEffectJobStatus, number>
> {
  const result = await query(
    `SELECT status, count(*)::int AS n
       FROM action_side_effect_job
      GROUP BY status`,
  );
  const out: Partial<Record<SideEffectJobStatus, number>> = {};
  for (const row of result.rows) {
    out[row.status as SideEffectJobStatus] = row.n;
  }
  // Fill zeros for statuses with no rows.
  const all: SideEffectJobStatus[] = ["pending", "running", "succeeded", "retrying", "failed", "dead"];
  for (const s of all) {
    if (out[s] === undefined) out[s] = 0;
  }
  return out as Record<SideEffectJobStatus, number>;
}
