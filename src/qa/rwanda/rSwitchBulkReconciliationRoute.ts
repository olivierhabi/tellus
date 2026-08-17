import crypto from "crypto";
import { appendAuditRow } from "../../models/actionAuditLog";
import type { ExecutionContext } from "../../actions/actionExecutor";
import { query, withTransaction } from "../../db";
import { OntologyError } from "../../utils/queryErrors";
import { deriveMainBranchId } from "../../services/branchContext";
import { publishCommittedObjectOverlay } from "../../services/overlay/writebackOverlay";
import { client as openSearchClient } from "../../services/opensearch/client";
import { getIndexName } from "../../services/opensearch/indexLifecycleManager";
import { ensureDocumentSecurity } from "../../services/security/documentSecurity";
import type {
  BulkReconciliationResult,
  PerRecordReconciliationResult,
} from "./bulkReconciliation";

export const RWANDA_RSWITCH_BULK_ACTION = "qaRwRswitchBulkReconcileSelected";
const PAYMENT_TRANSACTION_TYPE = "QaRwRswitchPaymentTransactions";
const CHUNK_SIZE = 100;
const OVERLAY_PUBLISH_CONCURRENCY = 16;
// Foundry documents a maximum of 1,000 elements for an object-reference list
// parameter. Keep this invariant in the executor as well as form validation,
// because API callers can bypass the Workshop form.
const MAX_OBJECT_REFERENCE_LIST_SIZE = 1_000;

type BatchRequest = { parameters?: Record<string, unknown> };
type PreparedTarget = {
  index: number;
  transactionId: string;
  batchId: string;
  context: ExecutionContext;
};
type CommittedOverlay = {
  branchId: string | null;
  searchBranchId: string;
  transactionId: string;
  properties: Record<string, unknown>;
  version: number;
  editId: string;
  actorUserId: string;
};

function rejected(transactionId: string, reasonCode: string): PerRecordReconciliationResult {
  return { transactionId, outcome: "REJECTED", reasonCode, auditId: null };
}

function canReconcile(context: ExecutionContext): boolean {
  return (context.roles ?? []).includes("recon-specialist");
}

/**
 * Object Search reads the writeback overlay until its asynchronous index has
 * caught up. Publish only after the chunk transaction commits, so no rejected
 * transaction can leak into the read path. Bounded concurrency keeps a
 * 500-record action within Redis and API connection budgets.
 */
async function publishCommittedOverlays(overlays: readonly CommittedOverlay[]): Promise<void> {
  for (let offset = 0; offset < overlays.length; offset += OVERLAY_PUBLISH_CONCURRENCY) {
    await Promise.all(overlays.slice(offset, offset + OVERLAY_PUBLISH_CONCURRENCY).map(async (overlay) => {
      try {
        await publishCommittedObjectOverlay({
          branchId: overlay.branchId,
          objectType: PAYMENT_TRANSACTION_TYPE,
          primaryKey: overlay.transactionId,
          doc: overlay.properties,
          deleted: false,
          version: overlay.version,
          editId: overlay.editId,
          actorUserId: overlay.actorUserId,
        });
      } catch (error) {
        // Postgres is already durable and the indexer/sweeper provides the
        // recovery path. Preserve action availability while making degraded
        // immediate-read behaviour explicit in server logs and metrics from
        // the overlay writer.
        console.warn(
          `[rwanda-bulk-reconcile] overlay publish failed for ${overlay.transactionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }));
  }
}

/**
 * Aggregate widgets execute directly against OpenSearch and cannot merge the
 * row-level writeback overlay. Advance that projection once per committed
 * chunk so every Workshop widget observes the same action result.
 */
async function publishCommittedSearchProjection(
  ontologyId: string,
  overlays: readonly CommittedOverlay[],
): Promise<void> {
  if (overlays.length === 0) return;
  const now = new Date().toISOString();
  const body: Array<Record<string, unknown>> = [];
  for (const overlay of overlays) {
    const upsert = ensureDocumentSecurity({
      __pk: overlay.transactionId,
      __objectType: PAYMENT_TRANSACTION_TYPE,
      __ontology: ontologyId,
      __branch: overlay.searchBranchId,
      __version: overlay.version,
      __lastModified: now,
      __editedBy: overlay.actorUserId,
      ...overlay.properties,
    });
    body.push({ update: { _index: getIndexName(PAYMENT_TRANSACTION_TYPE), _id: overlay.transactionId } });
    body.push({
      scripted_upsert: true,
      script: {
        source:
          "ctx._source.__version = params.version; " +
          "ctx._source.__lastModified = params.now; " +
          "ctx._source.__editedBy = params.editedBy; " +
          "ctx._source.__branch = params.branchId; " +
          "ctx._source.__ontology = params.ontologyId; " +
          "for (entry in params.props.entrySet()) { ctx._source[entry.getKey()] = entry.getValue(); }",
        params: {
          version: overlay.version,
          now,
          editedBy: overlay.actorUserId,
          branchId: overlay.searchBranchId,
          ontologyId,
          props: overlay.properties,
        },
      },
      upsert,
    });
  }
  try {
    const response = await openSearchClient.bulk({ body, refresh: "wait_for" });
    if (response.body?.errors) {
      console.warn("[rwanda-bulk-reconcile] search projection reported per-item failures");
    }
  } catch (error) {
    console.warn(
      `[rwanda-bulk-reconcile] search projection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Rwanda QA §6.3's operation has a deliberately narrow, set-based executor.
 *
 * It is not a generic Action shortcut: its persisted action contract is one
 * property transition (`FAILED` + `ELIGIBLE` -> `RECONCILED`) and its required
 * audit/business-key semantics live here.  The former implementation invoked
 * the full generic Action planner once per target.  That was correct but made
 * the specified 500-record, 30-second journey mathematically unattainable.
 * This executor validates the same domain predicates in one locked read per
 * chunk, writes the edit-store/object projection in bulk, and still appends a
 * hash-chained audit record for every accepted transaction in that transaction.
 */
export async function executeRwandaRswitchBulkReconciliation(input: {
  ontologyId: string;
  requestId: string;
  requests: readonly BatchRequest[];
  contextFor: (index: number) => ExecutionContext;
}): Promise<BulkReconciliationResult> {
  const { ontologyId, requestId, requests, contextFor } = input;
  if (!requestId.trim()) throw new OntologyError("requestId is required", "INVALID_PARAMETER", 400);
  if (requests.length === 0) throw new OntologyError("requests must be a non-empty array", "INVALID_PARAMETER", 400);
  if (requests.length > MAX_OBJECT_REFERENCE_LIST_SIZE) {
    throw new OntologyError(
      `transactions exceeds the maximum of ${MAX_OBJECT_REFERENCE_LIST_SIZE} object references`,
      "SCALE_LIMIT_EXCEEDED",
      400,
      { maxObjectReferences: MAX_OBJECT_REFERENCE_LIST_SIZE },
    );
  }

  const cached = await query(
    `SELECT result FROM rwanda_bulk_reconciliation_run
      WHERE request_id = $1 AND ontology_id = $2 AND action_type_api_name = $3`,
    [requestId, ontologyId, RWANDA_RSWITCH_BULK_ACTION],
  );
  if ((cached.rowCount ?? 0) > 0) return (cached.rows[0] as { result: BulkReconciliationResult }).result;

  await query(
    `INSERT INTO rwanda_bulk_reconciliation_run
       (request_id, ontology_id, action_type_api_name, result)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (request_id) DO NOTHING`,
    [requestId, ontologyId, RWANDA_RSWITCH_BULK_ACTION, JSON.stringify({ requestId, outcome: "FAILED", perRecordResults: [] })],
  );

  const perRecordResults: PerRecordReconciliationResult[] = [];
  try {
    for (let offset = 0; offset < requests.length; offset += CHUNK_SIZE) {
      const chunk = requests.slice(offset, offset + CHUNK_SIZE);
      const committedChunk = await withTransaction(async (client) => {
        const results: PerRecordReconciliationResult[] = [];
        const overlays: CommittedOverlay[] = [];
        const targets: PreparedTarget[] = [];
        for (let itemOffset = 0; itemOffset < chunk.length; itemOffset += 1) {
          const index = offset + itemOffset;
          const parameters = chunk[itemOffset]?.parameters ?? {};
          const transactionId = typeof parameters.transactionId === "string" ? parameters.transactionId : "";
          const batchId = typeof parameters.batchId === "string" ? parameters.batchId : "";
          const context = contextFor(index);
          if (!transactionId || !batchId) {
            results.push(rejected(transactionId, "INVALID_TARGET"));
          } else if (!canReconcile(context)) {
            results.push(rejected(transactionId, "PERMISSION_DENIED"));
          } else {
            targets.push({ index, transactionId, batchId, context });
          }
        }
        if (targets.length === 0) return { results, overlays };

        // A request originates from one authenticated caller.  Do not silently
        // collapse an unusual mixed-branch programmatic batch: reject only the
        // divergent targets rather than writing them into the main branch.
        const branchId = targets[0]!.context.branchId ?? deriveMainBranchId(ontologyId);
        const branchTargets = targets.filter((target) =>
          (target.context.branchId ?? deriveMainBranchId(ontologyId)) === branchId,
        );
        for (const target of targets) {
          if (!branchTargets.includes(target)) results.push(rejected(target.transactionId, "INVALID_TARGET"));
        }
        if (branchTargets.length === 0) return { results, overlays };

        const objectRows = await client.query<{
          primary_key: string;
          properties: { status?: unknown; reconciliationEligibility?: unknown };
        }>(
          `SELECT primary_key, properties
             FROM object_instances
            WHERE ontology_id = $1::uuid
              AND branch_id = $2::uuid
              AND object_type_api_name = $3
              AND primary_key = ANY($4::text[])
            FOR UPDATE`,
          [ontologyId, branchId, PAYMENT_TRANSACTION_TYPE, branchTargets.map((target) => target.transactionId)],
        );
        const objectById = new Map(objectRows.rows.map((row) => [row.primary_key, row.properties]));

        // First occurrence of a transaction/batch pair may reconcile; later
        // occurrences in the same request have the same exactly-once outcome as
        // a previously persisted business key.
        const seenTransactions = new Map<string, string>();
        const eligible: PreparedTarget[] = [];
        for (const target of branchTargets) {
          const pair = `${target.transactionId}\u0000${target.batchId}`;
          const properties = objectById.get(target.transactionId);
          const priorBatch = seenTransactions.get(target.transactionId);
          if (priorBatch === target.batchId) {
            results.push(rejected(target.transactionId, "DUPLICATE_BUSINESS_KEY"));
          } else if (priorBatch !== undefined) {
            // The ordinary action pipeline is sequential. A second request for
            // the same target in this batch observes the first transition to
            // RECONCILED and therefore fails its FAILED-state criterion.
            results.push(rejected(target.transactionId, "INELIGIBLE"));
          } else if (properties?.status !== "FAILED" || properties.reconciliationEligibility !== "ELIGIBLE") {
            results.push(rejected(target.transactionId, "INELIGIBLE"));
          } else {
            seenTransactions.set(target.transactionId, target.batchId);
            eligible.push(target);
          }
        }
        if (eligible.length === 0) return { results, overlays };

        // The unique index is the race-safe authority.  ON CONFLICT returns the
        // accepted keys, so concurrent batches cannot duplicate a settlement.
        const reserved = await client.query<{ transaction_id: string; batch_id: string }>(
          `INSERT INTO rwanda_bulk_reconciliation_business_key
             (ontology_id, transaction_id, batch_id, request_id)
           SELECT $1, transaction_id, batch_id, $4
             FROM unnest($2::text[], $3::text[]) AS input(transaction_id, batch_id)
           ON CONFLICT DO NOTHING
           RETURNING transaction_id, batch_id`,
          [ontologyId, eligible.map((target) => target.transactionId), eligible.map((target) => target.batchId), requestId],
        );
        const reservedPairs = new Set(reserved.rows.map((row) => `${row.transaction_id}\u0000${row.batch_id}`));
        const accepted = eligible.filter((target) => reservedPairs.has(`${target.transactionId}\u0000${target.batchId}`));
        for (const target of eligible) {
          if (!reservedPairs.has(`${target.transactionId}\u0000${target.batchId}`)) {
            results.push(rejected(target.transactionId, "DUPLICATE_BUSINESS_KEY"));
          }
        }
        if (accepted.length === 0) return { results, overlays };

        const executionIds = accepted.map(() => crypto.randomUUID());
        const editIds = accepted.map(() => crypto.randomUUID());
        const actor = accepted[0]!.context.executedBy || "system";
        const correlationId = accepted[0]!.context.correlationId ?? null;
        const parameters = accepted.map((target) => JSON.stringify({ transactionId: target.transactionId, batchId: target.batchId }));

        await client.query(
          `INSERT INTO ontology_edit
             (edit_id, object_type_api_name, primary_key, operation, property_values,
              link_edits, action_type_api_name, execution_id, action_parameters,
              executed_by, edit_strategy, ontology_id, branch_id)
           SELECT edit_id::uuid, $1, transaction_id, 'update', '{"status":"RECONCILED"}'::jsonb,
                  '[]'::jsonb, $2, execution_id::uuid, parameters::jsonb, $3,
                  'user_edit_wins', $4::uuid, $5::uuid
             FROM unnest($6::uuid[], $7::text[], $8::uuid[], $9::jsonb[])
               AS input(edit_id, transaction_id, execution_id, parameters)`,
          [PAYMENT_TRANSACTION_TYPE, RWANDA_RSWITCH_BULK_ACTION, actor, ontologyId, branchId, editIds, accepted.map((target) => target.transactionId), executionIds, parameters],
        );

        // Maintain the authoritative object projection in the same chunk
        // transaction and return its canonical versions. Those exact committed
        // rows are published to the writeback overlay after commit, making the
        // Object Search read path immediately consistent while Quickwit indexes
        // asynchronously.
        const reconciledRows = await client.query<{
          primary_key: string;
          properties: Record<string, unknown>;
          version: number | string;
        }>(
          `UPDATE object_instances
              SET properties = properties || '{"status":"RECONCILED"}'::jsonb,
                  version = version + 1,
                  last_modified_at = now()
            WHERE ontology_id = $1::uuid
              AND branch_id = $2::uuid
              AND object_type_api_name = $3
              AND primary_key = ANY($4::text[])
            RETURNING primary_key, properties, version`,
          [ontologyId, branchId, PAYMENT_TRANSACTION_TYPE, accepted.map((target) => target.transactionId)],
        );
        const reconciledById = new Map(reconciledRows.rows.map((row) => [row.primary_key, row]));

        for (let index = 0; index < accepted.length; index += 1) {
          const target = accepted[index]!;
          const reconciled = reconciledById.get(target.transactionId);
          if (!reconciled) {
            throw new Error(`Committed reconciliation row missing for ${target.transactionId}`);
          }
          const audit = await appendAuditRow(client, {
            action_type_api_name: RWANDA_RSWITCH_BULK_ACTION,
            action_type_display_name: "Bulk Reconcile Selected (QA)",
            execution_id: executionIds[index]!,
            parameters: { transactionId: target.transactionId, batchId: target.batchId },
            affected_objects: [{ objectType: PAYMENT_TRANSACTION_TYPE, primaryKey: target.transactionId, operation: "update" }],
            affected_object_count: 1,
            result: "success",
            failure_type: null,
            error_message: null,
            duration_ms: 0,
            executed_by: target.context.executedBy || "system",
            source_ip: target.context.sourceIp ?? null,
            branch_id: branchId,
            metadata: { requestId, bulkChunkOffset: offset },
            correlation_id: target.context.correlationId ?? null,
            // action_audit_log.semantics_version is NOT NULL; mirror the
            // executor's Stage-1b defaults for this declarative transition.
            semantics_version: 1,
            execution_mode: "declarative",
          });
          results.push({ transactionId: target.transactionId, outcome: "RECONCILED", reasonCode: "OK", auditId: audit.auditId });
          overlays.push({
            // Untagged Object Search requests read the main-branch overlay
            // slot. Preserve explicit branch isolation, but publish a default
            // main-branch action into that canonical slot so Workshop sees it
            // without requiring clients to send an internal branch UUID.
            branchId: branchId === deriveMainBranchId(ontologyId) ? null : branchId,
            searchBranchId: branchId,
            transactionId: target.transactionId,
            properties: reconciled.properties,
            version: Number(reconciled.version),
            editId: editIds[index]!,
            actorUserId: target.context.executedBy || "system",
          });
        }
        return { results, overlays };
      });
      await publishCommittedOverlays(committedChunk.overlays);
      await publishCommittedSearchProjection(ontologyId, committedChunk.overlays);
      perRecordResults.push(...committedChunk.results);
    }
  } catch (error) {
    // §6.3 wholesale infrastructure failure: each committed chunk is fully
    // applied, and the aborted chunk is fully unapplied. Persist the actual
    // state of every requested record before rethrowing, so a same-requestId
    // replay reports the truth instead of the empty placeholder above.
    const reported: PerRecordReconciliationResult[] = [...perRecordResults];
    for (let index = reported.length; index < requests.length; index += 1) {
      const parameters = requests[index]?.parameters ?? {};
      const transactionId = typeof parameters.transactionId === "string" ? parameters.transactionId : "";
      reported.push(rejected(transactionId, "NOT_ATTEMPTED"));
    }
    const committed = reported.filter((row) => row.outcome === "RECONCILED").length;
    const partial: BulkReconciliationResult = {
      requestId,
      outcome: committed === 0 ? "FAILED" : "PARTIAL_FAILURE",
      perRecordResults: reported,
    };
    await query(
      `UPDATE rwanda_bulk_reconciliation_run SET result = $2::jsonb WHERE request_id = $1`,
      [requestId, JSON.stringify(partial)],
    );
    throw error;
  }

  // Preserve request ordering even though validation/rejection results are
  // accumulated in a few set-based phases.
  const order = new Map<string, number>();
  requests.forEach((request, index) => {
    const transactionId = typeof request.parameters?.transactionId === "string" ? request.parameters.transactionId : "";
    if (!order.has(transactionId)) order.set(transactionId, index);
  });
  const ordered = perRecordResults.slice().sort((left, right) =>
    (order.get(left.transactionId) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.transactionId) ?? Number.MAX_SAFE_INTEGER),
  );
  const successes = ordered.filter((row) => row.outcome === "RECONCILED").length;
  const result: BulkReconciliationResult = {
    requestId,
    outcome: successes === requests.length ? "SUCCESS" : successes === 0 ? "FAILED" : "PARTIAL_FAILURE",
    perRecordResults: ordered,
  };
  await query(
    `UPDATE rwanda_bulk_reconciliation_run SET result = $2::jsonb WHERE request_id = $1`,
    [requestId, JSON.stringify(result)],
  );
  return result;
}
