import type { ExecutionContext } from "../../actions/actionExecutor";
import { executeAction } from "../../actions/actionExecutor";
import { query, withTransaction } from "../../db";
import { OntologyError } from "../../utils/queryErrors";
import type {
  BulkReconciliationResult,
  PerRecordReconciliationResult,
} from "./bulkReconciliation";

export const RWANDA_RSWITCH_BULK_ACTION = "qaRwRswitchBulkReconcileSelected";

type BatchRequest = { parameters?: Record<string, unknown> };

function rejected(transactionId: string, reasonCode: string): PerRecordReconciliationResult {
  return { transactionId, outcome: "REJECTED", reasonCode, auditId: null };
}

function reasonFromError(error: unknown): string {
  if (error instanceof OntologyError) {
    if (error.code === "DUPLICATE_BUSINESS_KEY") return error.code;
    if (error.code === "CONCURRENCY_CONFLICT") return "STALE_VERSION";
    if (error.code === "PERMISSION_DENIED") return "PERMISSION_DENIED";
    if (error.code === "SUBMISSION_CRITERIA_FAILED" || error.code === "SUBMISSION_CRITERIA_NOT_MET") return "INELIGIBLE";
    return error.code;
  }
  return "EXECUTION_FAILED";
}

/** Business rejections are the documented partial-success outcomes. Any
 * infrastructure or executor fault aborts the enclosing chunk transaction. */
function isPerRecordRejection(error: unknown): boolean {
  return error instanceof OntologyError && new Set([
    "DUPLICATE_BUSINESS_KEY",
    "CONCURRENCY_CONFLICT",
    "PERMISSION_DENIED",
    "SUBMISSION_CRITERIA_FAILED",
    "SUBMISSION_CRITERIA_NOT_MET",
    "INVALID_PARAMETER",
  ]).has(error.code);
}

/**
 * Production implementation of Rwanda plan §6.3.  The route owns the
 * request-level durable replay record; every target is passed through the
 * normal action executor, whose pre-commit hook reserves the immutable
 * transaction+settlement-batch key in the exact transaction that writes the
 * reconciliation edit and audit entry.
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

  const cached = await query(
    `SELECT result FROM rwanda_bulk_reconciliation_run
      WHERE request_id = $1 AND ontology_id = $2 AND action_type_api_name = $3`,
    [requestId, ontologyId, RWANDA_RSWITCH_BULK_ACTION],
  );
  if ((cached.rowCount ?? 0) > 0) return (cached.rows[0] as { result: BulkReconciliationResult }).result;

  // Establish the parent row before target execution so its foreign-keyed
  // reservations survive process restarts and cannot be claimed by a second
  // request.  A concurrent caller is serialized by the route idempotency
  // lock and will read the completed row above.
  await query(
    `INSERT INTO rwanda_bulk_reconciliation_run
       (request_id, ontology_id, action_type_api_name, result)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (request_id) DO NOTHING`,
    [requestId, ontologyId, RWANDA_RSWITCH_BULK_ACTION, JSON.stringify({ requestId, outcome: "FAILED", perRecordResults: [] })],
  );

  const perRecordResults: PerRecordReconciliationResult[] = [];
  // The chunks are deliberately internal.  UI clients submit their selected
  // set as one requestId; no client-side chunk suffix can weaken replay.
  for (let offset = 0; offset < requests.length; offset += 100) {
    const chunk = requests.slice(offset, offset + 100);
    await withTransaction(async (client) => {
      for (let itemOffset = 0; itemOffset < chunk.length; itemOffset += 1) {
        const index = offset + itemOffset;
        const parameters = chunk[itemOffset]?.parameters ?? {};
        const transactionId = typeof parameters.transactionId === "string" ? parameters.transactionId : "";
        const batchId = typeof parameters.batchId === "string" ? parameters.batchId : "";
        if (!transactionId || !batchId) {
          perRecordResults.push(rejected(transactionId, "INVALID_TARGET"));
          continue;
        }
        // A rejected record must not poison the rest of a partial-success
        // chunk. Savepoints preserve prior accepted records while an outer
        // rollback still removes every accepted record on an infrastructure
        // failure before the chunk commits.
        const savepoint = `rwanda_bulk_${itemOffset}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const execution = await executeAction(
            ontologyId,
            RWANDA_RSWITCH_BULK_ACTION,
            parameters,
            {
              ...contextFor(index),
              transactionClient: client,
              deferSearchProjection: true,
              beforeAuditCommitHook: async (hookClient) => {
                const inserted = await hookClient.query(
                  `INSERT INTO rwanda_bulk_reconciliation_business_key
                     (ontology_id, transaction_id, batch_id, request_id)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT DO NOTHING
                   RETURNING transaction_id`,
                  [ontologyId, transactionId, batchId, requestId],
                );
                if ((inserted.rowCount ?? 0) === 0) {
                  throw new OntologyError(
                    "A reconciliation already exists for this transaction and settlement batch.",
                    "DUPLICATE_BUSINESS_KEY",
                    409,
                    { transactionId, batchId },
                  );
                }
              },
            },
          );
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          perRecordResults.push({
            transactionId,
            outcome: "RECONCILED",
            reasonCode: "OK",
            auditId: execution.executionId,
          });
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          if (!isPerRecordRejection(error)) throw error;
          perRecordResults.push(rejected(transactionId, reasonFromError(error)));
        }
      }
    });
  }

  const successes = perRecordResults.filter((row) => row.outcome === "RECONCILED").length;
  const result: BulkReconciliationResult = {
    requestId,
    outcome: successes === requests.length ? "SUCCESS" : successes === 0 ? "FAILED" : "PARTIAL_FAILURE",
    perRecordResults,
  };
  await query(
    `UPDATE rwanda_bulk_reconciliation_run SET result = $2::jsonb WHERE request_id = $1`,
    [requestId, JSON.stringify(result)],
  );
  return result;
}
