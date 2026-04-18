// ---------------------------------------------------------------------------
// Durable Workflow — tasks-01.md §B3
//
// Temporal-style durable workflow backed by Postgres. One workflow instance
// per Object Type. A worker that crashes mid-run resumes at the exact
// activity boundary on restart because every activity invocation is
// persisted in `funnel_stage_run` with an `attempt` number and the
// workflow dispatcher finds the last unfinished row to decide what to do
// next.
//
// This is a deliberately small, determinism-preserving subset of Temporal:
//
//   * The workflow function describes the shape of the pipeline but does
//     not perform I/O. All I/O is encapsulated in *activities*, each with
//     its own timeout and retry policy.
//   * Activities run via {@link runActivity}, which:
//       - INSERTs a funnel_stage_run row in 'running' status (durable)
//       - invokes the activity with the configured timeout
//       - UPDATEs the row to 'succeeded' / 'failed' / 'timed_out' with
//         the activity output or error message
//       - on failure, re-enters with `attempt+1` according to the retry
//         policy (exponential backoff with jitter, caller-configured)
//   * `runWorkflow` writes a `funnel_run` row *before* any activity runs,
//     and updates its `current_stage` / `objects_indexed` / `status` as
//     the workflow progresses. The frontend reads this row — not
//     Temporal — per the spec's 1-second projection requirement.
//
// Production deployments would swap this out for the real Temporal
// TypeScript SDK; the {@link WorkflowContext} interface is shaped so that
// a Temporal-backed implementation can be substituted without changing
// stage code.
// ---------------------------------------------------------------------------

import { PoolClient } from "pg";
import { query, getClient } from "../../db";

export type FunnelStage = "changelog" | "merge" | "indexing" | "hydration";

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  multiplier: number;
}

/** Default per-stage retry policies from the spec §B3. */
export const DEFAULT_RETRY_POLICIES: Record<FunnelStage, RetryPolicy> = {
  changelog: { maxAttempts: 5, initialBackoffMs: 1_000, maxBackoffMs: 60_000, multiplier: 2 },
  merge:     { maxAttempts: 5, initialBackoffMs: 1_000, maxBackoffMs: 60_000, multiplier: 2 },
  indexing:  { maxAttempts: 3, initialBackoffMs: 1_000, maxBackoffMs: 30_000, multiplier: 2 },
  hydration: { maxAttempts: 10, initialBackoffMs: 500, maxBackoffMs: 10_000, multiplier: 2 },
};

/** Default per-stage timeouts (seconds) from the spec §B3. */
export const DEFAULT_STAGE_TIMEOUTS_S: Record<FunnelStage, number> = {
  changelog: 60 * 60,
  merge: 2 * 60 * 60,
  indexing: 4 * 60 * 60,
  hydration: 30 * 60,
};

export interface ActivityOptions<I, O> {
  name: string;
  stage: FunnelStage;
  input: I;
  activity: (input: I) => Promise<O>;
  timeoutSeconds?: number;
  retry?: RetryPolicy;
}

export interface WorkflowStartInput {
  ontologyId: string;
  objectTypeApiName: string;
  workflowType?: string;
  signalPayload?: unknown;
  parentRunId?: string | null;
}

export interface WorkflowContext {
  runId: string;
  ontologyId: string;
  objectTypeApiName: string;
  /** Execute an activity with durable replay semantics. */
  runActivity<I, O>(opts: ActivityOptions<I, O>): Promise<O>;
  /** Advance the workflow's externally-visible stage tag. */
  setCurrentStage(stage: FunnelStage | null): Promise<void>;
  /** Bump the reported index count for the UI projection. */
  incrementObjectsIndexed(n: number): Promise<void>;
}

export interface WorkflowResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  errorMessage?: string;
}

/** User-supplied workflow function. It runs to completion (maybe spanning
 *  many activities) and returns when the full pipeline for one signal is
 *  drained. The function itself must be deterministic — no Math.random,
 *  Date.now, network, or filesystem calls. All non-determinism lives in
 *  activities. */
export type WorkflowFn = (ctx: WorkflowContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Run a workflow end-to-end. Returns when the WorkflowFn returns.
// ---------------------------------------------------------------------------

export async function runWorkflow(
  input: WorkflowStartInput,
  workflowFn: WorkflowFn
): Promise<WorkflowResult> {
  // Durable creation of the funnel_run row.
  const runRow = await query(
    `INSERT INTO funnel_run
       (ontology_id, object_type_api_name, workflow_type, status,
        signal_payload, parent_run_id)
     VALUES ($1, $2, $3, 'running', $4::jsonb, $5)
     RETURNING run_id`,
    [
      input.ontologyId,
      input.objectTypeApiName,
      input.workflowType ?? "ObjectTypeFunnelWorkflow",
      JSON.stringify(input.signalPayload ?? null),
      input.parentRunId ?? null,
    ]
  );
  const runId = runRow.rows[0].run_id as string;

  const ctx: WorkflowContext = {
    runId,
    ontologyId: input.ontologyId,
    objectTypeApiName: input.objectTypeApiName,
    async runActivity<I, O>(opts: ActivityOptions<I, O>): Promise<O> {
      return runActivityImpl(runId, opts);
    },
    async setCurrentStage(stage) {
      await query(
        `UPDATE funnel_run SET current_stage = $1 WHERE run_id = $2`,
        [stage, runId]
      );
    },
    async incrementObjectsIndexed(n) {
      await query(
        `UPDATE funnel_run SET objects_indexed = objects_indexed + $1 WHERE run_id = $2`,
        [n, runId]
      );
    },
  };

  try {
    await workflowFn(ctx);
    await query(
      `UPDATE funnel_run
          SET status = 'completed', completed_at = now(), current_stage = NULL
        WHERE run_id = $1`,
      [runId]
    );
    return { runId, status: "completed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE funnel_run
          SET status = 'failed', completed_at = now(), error_message = $1
        WHERE run_id = $2`,
      [message, runId]
    );
    return { runId, status: "failed", errorMessage: message };
  }
}

// ---------------------------------------------------------------------------
// Activity runner — the core durability primitive.
// ---------------------------------------------------------------------------

async function runActivityImpl<I, O>(
  runId: string,
  opts: ActivityOptions<I, O>
): Promise<O> {
  const retry = opts.retry ?? DEFAULT_RETRY_POLICIES[opts.stage];
  const timeoutSec = opts.timeoutSeconds ?? DEFAULT_STAGE_TIMEOUTS_S[opts.stage];

  // If this stage already has a succeeded attempt for this run we can
  // short-circuit — this is how resume-from-boundary works after a
  // worker crash.
  const completed = await query(
    `SELECT stage_run_id, output_json FROM funnel_stage_run
       WHERE run_id = $1 AND stage = $2 AND status = 'succeeded'
       ORDER BY finished_at DESC
       LIMIT 1`,
    [runId, opts.stage]
  );
  if (completed.rows[0]) {
    return completed.rows[0].output_json as O;
  }

  // Find next attempt number for (run_id, stage).
  const prior = await query(
    `SELECT COALESCE(MAX(attempt), 0) AS max_attempt FROM funnel_stage_run
       WHERE run_id = $1 AND stage = $2`,
    [runId, opts.stage]
  );
  let attempt = Number(prior.rows[0].max_attempt) + 1;
  let backoffMs = retry.initialBackoffMs;
  let lastError: unknown;

  while (attempt <= retry.maxAttempts) {
    const stageRunId = await startStageRun(runId, opts, attempt, timeoutSec);
    try {
      const out = await runWithTimeout(
        opts.activity(opts.input),
        timeoutSec * 1000,
        `${opts.name} timed out after ${timeoutSec}s`
      );
      await finishStageRun(stageRunId, "succeeded", out, null);
      return out;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("timed out") ? "timed_out" : "failed";
      await finishStageRun(stageRunId, status, null, message);
      if (attempt >= retry.maxAttempts) break;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * retry.multiplier, retry.maxBackoffMs);
      attempt++;
    }
  }

  const finalMessage =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `activity '${opts.name}' exhausted ${retry.maxAttempts} attempts: ${finalMessage}`
  );
}

async function startStageRun<I>(
  runId: string,
  opts: ActivityOptions<I, unknown>,
  attempt: number,
  timeoutSec: number
): Promise<string> {
  const result = await query(
    `INSERT INTO funnel_stage_run
       (run_id, stage, status, attempt, input_json, timeout_seconds, started_at)
     VALUES ($1, $2, 'running', $3, $4::jsonb, $5, now())
     RETURNING stage_run_id`,
    [runId, opts.stage, attempt, JSON.stringify(opts.input ?? null), timeoutSec]
  );
  return result.rows[0].stage_run_id as string;
}

async function finishStageRun(
  stageRunId: string,
  status: "succeeded" | "failed" | "timed_out",
  output: unknown,
  errorMessage: string | null
): Promise<void> {
  await query(
    `UPDATE funnel_stage_run
        SET status        = $1,
            output_json   = $2::jsonb,
            error_message = $3,
            finished_at   = now()
      WHERE stage_run_id  = $4`,
    [status, output == null ? null : JSON.stringify(output), errorMessage, stageRunId]
  );
}

function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Signal inbox — durable queue for workflow signals.
// ---------------------------------------------------------------------------

export type SignalType =
  | "sourceTransactionCommitted"
  | "editBatchPending"
  | "schemaChanged";

export interface SendSignalInput {
  ontologyId: string;
  objectTypeApiName: string;
  signalType: SignalType;
  payload?: unknown;
  client?: PoolClient;
}

/**
 * Send a signal to the Object Type's workflow. Durable: if the receiver
 * is not running, the signal sits in funnel_signal until a worker picks
 * it up on its next poll. Action writeback uses this (via the same DB
 * txn as the ontology_edit INSERT) to wake the Funnel on every action.
 */
export async function sendSignal(input: SendSignalInput): Promise<string> {
  const exec = input.client
    ? (sql: string, params: unknown[]) => input.client!.query(sql, params)
    : (sql: string, params: unknown[]) => query(sql, params);

  const result = await exec(
    `INSERT INTO funnel_signal
       (ontology_id, object_type_api_name, signal_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING signal_id`,
    [
      input.ontologyId,
      input.objectTypeApiName,
      input.signalType,
      JSON.stringify(input.payload ?? {}),
    ]
  );
  return result.rows[0].signal_id as string;
}

/**
 * Atomically claim the next unconsumed signal for a given Object Type.
 * Returns null if none pending. Uses SKIP LOCKED so multiple workers
 * racing for the same type is safe.
 */
export async function claimNextSignal(
  objectTypeApiName: string,
  runId: string | null = null
): Promise<{
  signal_id: string;
  signal_type: SignalType;
  payload: Record<string, unknown>;
  ontology_id: string;
} | null> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const pick = await client.query(
      `SELECT signal_id, ontology_id, signal_type, payload
         FROM funnel_signal
        WHERE object_type_api_name = $1 AND consumed_at IS NULL
        ORDER BY received_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [objectTypeApiName]
    );
    if (!pick.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const row = pick.rows[0];
    // consumed_by_run_id is a FK; set NULL here and let the caller
    // back-fill it once the funnel_run row exists.
    await client.query(
      `UPDATE funnel_signal
          SET consumed_at = now(), consumed_by_run_id = $1
        WHERE signal_id = $2`,
      [runId, row.signal_id]
    );
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
