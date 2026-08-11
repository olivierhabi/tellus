import { describe, expect, it, vi } from "vitest";
import { bulkReconcileTransactions, type BulkReconciliationResult } from "../../../src/qa/rwanda/bulkReconciliation";

describe("Rwanda §6.3 bulk reconciliation", () => {
  it("chunks 250 targets at 100, reports partial failure, and replays by requestId", async () => {
    let cached: BulkReconciliationResult | null = null;
    const store = {
      read: vi.fn(async () => cached),
      write: vi.fn(async (_id: string, value: BulkReconciliationResult) => { cached = value; }),
    };
    const executor = {
      executeChunk: vi.fn(async (chunk: readonly { transactionId: string; batchId: string }[]) => {
        const duplicateBusinessKeys = new Set(chunk.filter((row) => row.transactionId.endsWith("7")).map((row) => `${row.transactionId}\u0000${row.batchId}`));
        return {
          duplicateBusinessKeys,
          results: chunk
            .filter((row) => !duplicateBusinessKeys.has(`${row.transactionId}\u0000${row.batchId}`))
            .map((row) => ({ transactionId: row.transactionId, outcome: "RECONCILED" as const, reasonCode: "OK", auditId: `audit-${row.transactionId}` })),
        };
      }),
    };
    const targets = Array.from({ length: 250 }, (_, index) => ({ transactionId: `tx-${index}`, batchId: "batch-1" }));

    const first = await bulkReconcileTransactions("request-1", targets, store, executor);
    expect(executor.executeChunk.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 50]);
    expect(first.outcome).toBe("PARTIAL_FAILURE");
    expect(first.perRecordResults).toHaveLength(250);
    expect(first.perRecordResults.find((row) => row.transactionId === "tx-7")).toEqual({
      transactionId: "tx-7", outcome: "REJECTED", reasonCode: "DUPLICATE_BUSINESS_KEY", auditId: null,
    });

    const replay = await bulkReconcileTransactions("request-1", targets, store, executor);
    expect(replay).toEqual(first);
    expect(executor.executeChunk).toHaveBeenCalledTimes(3);
  });
});
