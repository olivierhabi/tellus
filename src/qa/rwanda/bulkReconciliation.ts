export type ReconciliationOutcome = "RECONCILED" | "REJECTED";

export interface BulkReconciliationTarget {
  transactionId: string;
  batchId: string;
}

export interface PerRecordReconciliationResult {
  transactionId: string;
  outcome: ReconciliationOutcome;
  reasonCode: string;
  auditId: string | null;
}

export interface BulkReconciliationResult {
  requestId: string;
  outcome: "SUCCESS" | "PARTIAL_FAILURE" | "FAILED";
  perRecordResults: PerRecordReconciliationResult[];
}

export interface BulkReconciliationStore {
  read(requestId: string): Promise<BulkReconciliationResult | null>;
  write(requestId: string, result: BulkReconciliationResult): Promise<void>;
}

export interface BulkReconciliationExecutor {
  /** Reserve business keys and apply edits in one database transaction. */
  executeChunk(
    targets: readonly BulkReconciliationTarget[],
  ): Promise<{
    results: readonly PerRecordReconciliationResult[];
    duplicateBusinessKeys: ReadonlySet<string>;
  }>;
}

const businessKey = (target: BulkReconciliationTarget) =>
  `${target.transactionId}\u0000${target.batchId}`;

/** Domain runner for §6.3. Each <=100 item chunk is one executor transaction. */
export async function bulkReconcileTransactions(
  requestId: string,
  targets: readonly BulkReconciliationTarget[],
  store: BulkReconciliationStore,
  executor: BulkReconciliationExecutor,
): Promise<BulkReconciliationResult> {
  if (!requestId.trim()) throw new Error("requestId is required");
  if (targets.length === 0) throw new Error("at least one transaction is required");
  const cached = await store.read(requestId);
  if (cached) return cached;

  const perRecordResults: PerRecordReconciliationResult[] = [];
  for (let offset = 0; offset < targets.length; offset += 100) {
    const chunk = targets.slice(offset, offset + 100);
    const { results: executed, duplicateBusinessKeys: duplicates } =
      await executor.executeChunk(chunk);
    const byId = new Map(executed.map((row) => [row.transactionId, row]));
    for (const target of chunk) {
      perRecordResults.push(
        duplicates.has(businessKey(target))
          ? { transactionId: target.transactionId, outcome: "REJECTED", reasonCode: "DUPLICATE_BUSINESS_KEY", auditId: null }
          : byId.get(target.transactionId) ?? {
              transactionId: target.transactionId,
              outcome: "REJECTED",
              reasonCode: "MISSING_CHUNK_RESULT",
              auditId: null,
            },
      );
    }
  }

  const successes = perRecordResults.filter((row) => row.outcome === "RECONCILED").length;
  const result: BulkReconciliationResult = {
    requestId,
    outcome: successes === perRecordResults.length ? "SUCCESS" : successes === 0 ? "FAILED" : "PARTIAL_FAILURE",
    perRecordResults,
  };
  await store.write(requestId, result);
  return result;
}
