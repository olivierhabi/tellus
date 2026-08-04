// ---------------------------------------------------------------------------
// linkIndexAck → HTTP outcome mapping (POST /:actionTypeApiName/apply).
//
// The edge-index acknowledgement (editApplicator Step 6b,
// services/serving/edgeIndexWatermark.ts) is threaded:
//
//   applyEdits().linkIndexAck
//     → executeAction() → ExecutionResult.linkIndexAck   (actionExecutor.ts)
//     → THIS MODULE → HTTP status + response body         (routes/actions.ts)
//
// HTTP semantics:
//   * ack confirmed, or LINK_INDEX_ACK_REQUIRED disabled (no ack staged):
//     200 with the unchanged success body — byte-compatible with the
//     pre-contract response (no schema drift for existing callers).
//   * PG commit succeeded but the serving edge index did NOT confirm the
//     staged link events within the deadline: 202 with
//     result: "COMMITTED_INDEX_PENDING", the executionId, and a status URL
//     the client can poll (the action audit entry).
//
// HARD INVARIANT (enforced below, not by convention): a post-commit
// link-index timeout/deferral must NEVER be surfaced as a client-visible
// error (4xx/5xx) nor as result "failed"/"failure". The mutation is already
// durable in PostgreSQL; presenting it as failed invites callers to retry
// an already-applied mutation (double-apply). Any code path that would
// violate this is a programmer error and fails loudly.
// ---------------------------------------------------------------------------

import type { EdgeAckConfirmation } from "../services/serving/edgeIndexWatermark";
import type { AuditResult } from "../models/actionAuditLog";
import { query } from "../db";

/** Default per-call budget for the statusUrl index-visibility probe (ms).
 *  The endpoint is pollable — one bounded probe per scope group keeps it
 *  inside the audit log's own data-plane request budget. Env-tunable. */
const INDEX_VISIBILITY_PROBE_MS = Number(
  process.env.INDEX_VISIBILITY_PROBE_TIMEOUT_MS ?? 1_000,
);

/** Result string returned when the PG edit is durable but the edge index
 *  had not confirmed visibility by the ack deadline. */
export const COMMITTED_INDEX_PENDING = "COMMITTED_INDEX_PENDING" as const;

/** The result values a COMMITTED action may surface. "failed" is reserved
 *  for executions that never committed — the invariant guard rejects it for
 *  committed executions. */
export type ApplyOutcomeResult = AuditResult | typeof COMMITTED_INDEX_PENDING;

export interface ApplyOutcomeInput {
  executionId: string;
  result: AuditResult;
  affectedObjects: unknown[];
  durationMs: number;
  /** Present only when link CDC events were staged AND
   *  LINK_INDEX_ACK_REQUIRED=true (see ExecutionResult.linkIndexAck). */
  linkIndexAck?: EdgeAckConfirmation;
}

export interface ApplyHttpOutcome {
  status: 200 | 202;
  body: {
    executionId: string;
    result: ApplyOutcomeResult;
    affectedObjects: unknown[];
    durationMs: number;
    linkIndexAck?: EdgeAckConfirmation;
    /** Poll target for 202 responses (action audit entry). */
    statusUrl?: string;
  };
}

/** Serving-index read-after-write state for a single execution. Surfaced
 *  on the status endpoint for the SAME poll that 202 + statusUrl invited —
 *  202 is terminal (idempotency replays it forever), so statusUrl is the
 *  client's ONLY mechanism to learn the serving edge caught up.
 *
 *   `"VISIBLE"` — every link event STAGED by this execution is present in
 *     its scope's versioned edge table (the same per-event_id probe the
 *     editApplicator Step 6b barrier used — NOT the known-unsound
 *     watermark set-diff).
 *   `"PENDING"` — at least one staged event is not yet visible (or the
 *     probe itself errored / timed out: never fabricate visibility).
 *
 * The field is flag-gated AND additive: absent when
 * LINK_INDEX_ACK_REQUIRED ≠ "true" (byte-compat for flag-off responses)
 * or when the execution staged no link CDC events (e.g. a non-link
 * action). `result` on the SAME response = the PG COMMIT outcome; the
 * two vocabularies are intentionally separate documents of state. */
export type IndexVisibility = "PENDING" | "VISIBLE";

/**
 * Probe the serving edge index for EVERY link event staged by an
 * execution. Returns `"VISIBLE"` iff all staged events are present
 * (per event_id, by scope — identical machinery to the
 * `confirmEdgeIndexVisibility` barrier the write path already used),
 * `"PENDING"` when any are not yet visible or the probe errored, and
 * `null` when the execution staged NO link CDC events (the caller
 * omits the field — this is the byte-compat path).
 *
 * MONOTONIC STICKY VERDICT (migration 159): the first VISIBLE return for
 * an execution is persisted in `link_execution_index_visibility` (PG,
 * INSERT-only, ON CONFLICT DO NOTHING -- presence of a row = VISIBLE
 * forever; never downgraded, never deleted). Before live-probing, the
 * function checks the sticky table; a present row short-circuits to
 * VISIBLE without touching CH. Absence falls through to a live probe
 * exactly as before. This eliminates the ReplacingMergeTree collapse
 * flip-flop: once VISIBLE, every subsequent poll returns VISIBLE
 * regardless of background merges.
 *
 * The verdict is per-execution (`execution_id` PK -- no cross-tenant
 * bleed), durable across process restarts (PG, not in-process), and
 * NEVER fabricated: the row is written ONLY after a real
 * confirmEdgeIndexVisibility round returned confirmed=true for EVERY
 * staged event.
 */
export async function probeExecutionIndexVisibility(args: {
  executionId: string;
  /** Override the per-call probe budget (tests). */
  timeoutMs?: number;
}): Promise<IndexVisibility | null> {
  // Resolve every link event this execution staged and DID NOT dead-
  // letter. Dead-lettered events will never be visible -- surfacing them
  // as PENDING (rather than a third state) is accurate: they are not
  // queryable. The 202 contract statusUrl is "did the index catch up"
  // -- it did not for those. link_cdc_outbox.event_id is uuid; link_edit
  // carries it as text, so cast to bridge the type (PG strictly rejects
  // uuid = text with `operator does not exist`).
  const rows = await query(
    `SELECT le.event_id, le.link_type_api_name,
            le.ontology_id, le.branch_id,
            o.tenant_id, o.outbox_seq, o.source_object_type
       FROM link_edit le
       JOIN link_cdc_outbox o ON o.event_id = le.event_id::uuid
      WHERE le.execution_id = $1
        AND o.dead_lettered_at IS NULL`,
    [args.executionId],
  );
  if (rows.rows.length === 0) return null;

  // MONOTONIC STICKY VERDICT: once a prior poll confirmed VISIBLE, every
  // subsequent poll returns VISIBLE -- no live probe, no CH touch, no
  // ReplacingMergeTree-collapse flip-flop. Best-effort: if the sticky
  // table is missing (pre-migration-159 deploy) the SELECT errors and the
  // function falls through to a live probe unchanged.
  try {
    const sticky = await query(
      `SELECT 1 FROM link_execution_index_visibility
        WHERE execution_id = $1`,
      [args.executionId],
    );
    if (sticky.rows.length > 0) return "VISIBLE";
  } catch {
    // Table absent (pre-migration-159) -- fall through to live probe.
  }

  const { confirmEdgeIndexVisibility } = await import(
    "../services/serving/edgeIndexWatermark"
  );
  const deadlineAt = Date.now() + (args.timeoutMs ?? INDEX_VISIBILITY_PROBE_MS);

  // Group by the SAME scope package the write path uses (tenant,
  // ontology, branch) and run ONE barrier per scope -- multiple ontologies
  // / branches inside one execution confirm against their own index.
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows.rows) {
    const key = `${r.tenant_id ?? ""} ${r.ontology_id ?? ""} ${r.branch_id ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  for (const list of groups.values()) {
    if (Date.now() >= deadlineAt) return "PENDING";
    const scope = list[0];
    const remaining = Math.max(0, deadlineAt - Date.now());
    // A probe-layer outage (CH down, descriptor resolve failure) resolves
    // as PENDING for THIS request -- a future poll will retry once the
    // index comes back. NEVER fabricate VISIBLE from a probe that errored.
    let verdict: { confirmed: boolean };
    try {
      verdict = await confirmEdgeIndexVisibility({
        scope: {
          tenantId: String(scope.tenant_id ?? ""),
          ontologyId: String(scope.ontology_id ?? ""),
          branchId: String(scope.branch_id ?? ""),
        },
        handles: list.map((r) => ({
          eventId: r.event_id as string,
          outboxSeq: Number(r.outbox_seq),
          linkTypeApiName: r.link_type_api_name as string,
          sourceObjectType: r.source_object_type as string,
          ontologyId: String(r.ontology_id ?? ""),
        })),
        timeoutMs: remaining,
      });
    } catch {
      return "PENDING";
    }
    if (!verdict.confirmed) return "PENDING";
  }

  // Persist the FIRST VISIBLE verdict: INSERT-only, ON CONFLICT DO
  // NOTHING. First writer wins; the row is never updated or downgraded.
  // Best-effort: a PG error (table absent pre-migration-159, transient
  // connection) is swallowed -- the RETURN value is still VISIBLE (a
  // real probe confirmed it); the NEXT poll will retry the write.
  try {
    await query(
      `INSERT INTO link_execution_index_visibility (execution_id)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [args.executionId],
    );
  } catch {
    // Sticky write failed -- return VISIBLE anyway; next poll retries.
  }
  return "VISIBLE";
}

/** Pollable status URL for an execution (single audit entry by execution ID;
 *  mounted at /api/v1/audit in server.ts). */
export function actionExecutionStatusUrl(executionId: string): string {
  return `/api/v1/audit/log/${executionId}`;
}

/**
 * Wall-clock the route keeps after its LAST barrier completes, to
 * assemble and flush the response inside the wire budget.
 */
export const ACK_RESPONSE_RESERVE_MS = 500;

/**
 * Per-item ack barrier ceiling for batch surfaces. The
 * requestTimeoutMiddleware stamps the wire deadline into
 * `res.locals.requestBudgetDeadlineAt`; each committed item's barrier
 * gets MIN(remaining, LINK_INDEX_ACK_TIMEOUT_MS). A zero/negative
 * remainder yields 0 — the item PRE-DEFERS its ack (per-item 202
 * pending, pollable via statusUrl) instead of letting the middleware
 * fire a 504 on an already-committed mutation. THAT is invariant #1:
 * an ack-blocking batch only ever stretches its wire while items CAN
 * finish well inside the budget; the rest resolve as deferrals.
 *
 * Returns `undefined` when no deadline was stamped (routers mounted
 * without the budget middleware — unit/integration harnesses), which
 * preserves the pre-existing env-timeout behavior for callers that
 * spread it into the execution context conditionally.
 */
export function perItemAckBudgetMs(args: {
  localsDeadlineAt: unknown;
  envAckTimeoutMs: number;
  now?: number;
}): number | undefined {
  const deadlineAt = args.localsDeadlineAt;
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    return undefined;
  }
  const now = args.now ?? Date.now();
  const remaining = deadlineAt - now - ACK_RESPONSE_RESERVE_MS;
  return Math.max(0, Math.min(args.envAckTimeoutMs, remaining));
}

/**
 * HARD-INVARIANT GUARD. Called by the route IMMEDIATELY before sending, so
 * that even a future refactor of the mapping above cannot regress the
 * contract silently: a committed execution (success / partial / index
 * pending) is never sent as 4xx/5xx and never labelled failed. A
 * COMMITTED_INDEX_PENDING body is always HTTP 202.
 *
 * Throws (500 class, loud in test/dev) on violation — the transaction is
 * already committed at this point, so swallowing would mask a contract bug,
 * not protect the client.
 */
export function assertApplyOutcomeInvariant(outcome: {
  status: number;
  body: { result?: string };
}): void {
  const { result } = outcome.body;
  if (result === COMMITTED_INDEX_PENDING && outcome.status !== 202) {
    throw new Error(
      `INVARIANT VIOLATION: ${COMMITTED_INDEX_PENDING} must be delivered as ` +
        `HTTP 202, got ${outcome.status} — a post-commit link-index deferral ` +
        `must never be coerced into another status`
    );
  }
  if (
    (result === "success" ||
      result === "partial" ||
      result === COMMITTED_INDEX_PENDING) &&
    outcome.status >= 400
  ) {
    throw new Error(
      `INVARIANT VIOLATION: a committed action (result='${result}') must ` +
        `never be surfaced as HTTP ${outcome.status} — the mutation is ` +
        `durable in PostgreSQL and an error status invites retries of an ` +
        `already-applied mutation`
    );
  }
}

/**
 * Map an executeAction() result to its HTTP outcome for the /apply route.
 * The 200 body is byte-compatible with the pre-contract success body
 * (same keys, same values); only the index-pending case diverges.
 */
export function mapApplyExecutionToHttp(
  result: ApplyOutcomeInput
): ApplyHttpOutcome {
  if (result.linkIndexAck && result.linkIndexAck.confirmed === false) {
    const outcome: ApplyHttpOutcome = {
      status: 202,
      body: {
        executionId: result.executionId,
        result: COMMITTED_INDEX_PENDING,
        affectedObjects: result.affectedObjects,
        durationMs: result.durationMs,
        linkIndexAck: result.linkIndexAck,
        statusUrl: actionExecutionStatusUrl(result.executionId),
      },
    };
    assertApplyOutcomeInvariant(outcome);
    return outcome;
  }

  const outcome: ApplyHttpOutcome = {
    status: 200,
    body: {
      executionId: result.executionId,
      result: result.result,
      affectedObjects: result.affectedObjects,
      durationMs: result.durationMs,
      // OSv2 read-after-write verdict (only present when
      // LINK_INDEX_ACK_REQUIRED=true and link edits were staged).
      ...(result.linkIndexAck ? { linkIndexAck: result.linkIndexAck } : {}),
    },
  };
  assertApplyOutcomeInvariant(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Batch surfaces (POST /:actionTypeApiName/applyBatch, applyBulk).
//
// AGGREGATION RULE (single source of truth — do not fork per route):
// each batch item executes+commits independently, so the ack verdict is
// tracked PER ITEM. The WHOLE response is 202 iff ANY committed item's
// ack is unconfirmed; the top-level `result` becomes
// COMMITTED_INDEX_PENDING and every pending item carries its own
// executionId + pollable statusUrl inside its results entry. Genuine
// pre-commit failures are unaffected: they keep their per-item failure
// entries, and an all-pre-commit-failed batch keeps its normal failure
// status (a 202 is emitted ONLY when at least one item committed
// successfully AND is index-pending).
//
//   * LINK_INDEX_ACK_REQUIRED unset  → pendingCount 0: byte-compatible body.
//   * flag on, all items confirmed   → same body + per-item linkIndexAck
//     (mirrors /apply spreading the verdict into its 200 body).
//   * flag on, any item unconfirmed  → 202 + per-item statusUrl.
// ---------------------------------------------------------------------------

/** A batch results entry (any surface shape) reduced to its ack identity. */
export interface BatchAckCandidate {
  index: number;
  executionId: string | null;
  linkIndexAck?: EdgeAckConfirmation;
}

/** A committed batch item whose edge-index ack was NOT confirmed in time. */
export interface PendingAckItem {
  index: number;
  executionId: string;
  statusUrl: string;
}

/** Collect the committed-but-index-pending items of a batch. */
export function collectPendingAcks(
  items: BatchAckCandidate[]
): PendingAckItem[] {
  const pending: PendingAckItem[] = [];
  for (const it of items) {
    if (
      it.linkIndexAck &&
      it.linkIndexAck.confirmed === false &&
      it.executionId
    ) {
      pending.push({
        index: it.index,
        executionId: it.executionId,
        statusUrl: actionExecutionStatusUrl(it.executionId),
      });
    }
  }
  return pending;
}

/**
 * HARD-INVARIANT GUARD for batch surfaces. Called by the route immediately
 * before sending: index-pending items must be delivered as HTTP 202 with
 * the COMMITTED_INDEX_PENDING marker — never as a 4xx/5xx (a client retry
 * would re-attempt already-committed mutations) and never silently as a
 * plain 200 success.
 */
export function assertBatchAckOutcomeInvariant(outcome: {
  status: number;
  pendingCount: number;
  result?: string;
}): void {
  if (outcome.pendingCount > 0) {
    if (outcome.status !== 202 || outcome.result !== COMMITTED_INDEX_PENDING) {
      throw new Error(
        `INVARIANT VIOLATION: ${outcome.pendingCount} committed batch item(s) ` +
          `are link-index-pending — must be delivered as HTTP 202 with ` +
          `result '${COMMITTED_INDEX_PENDING}', got status=${outcome.status} ` +
          `result='${outcome.result}'. A post-commit deferral must never be ` +
          `an error status (invites retries of applied mutations) nor a ` +
          `silent success.`
      );
    }
    return;
  }
  if (outcome.result === COMMITTED_INDEX_PENDING) {
    throw new Error(
      `INVARIANT VIOLATION: result '${COMMITTED_INDEX_PENDING}' emitted ` +
        `with zero pending items — the marker must only accompany a real ` +
        `index deferral`
    );
  }
}
