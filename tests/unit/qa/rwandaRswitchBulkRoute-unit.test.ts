import { beforeEach, describe, expect, it, vi } from "vitest";
import { OntologyError } from "../../../src/utils/queryErrors";

const { query, withTransaction, executeAction } = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  executeAction: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query, withTransaction }));
vi.mock("../../../src/actions/actionExecutor", () => ({ executeAction }));

import {
  executeRwandaRswitchBulkReconciliation,
  RWANDA_RSWITCH_BULK_ACTION,
} from "../../../src/qa/rwanda/rSwitchBulkReconciliationRoute";

describe("Rwanda RSwitch production bulk route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT result")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    let transactionNumber = 0;
    withTransaction.mockImplementation(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
      transactionNumber += 1;
      return callback(client);
    });
    executeAction.mockImplementation(async (_ontologyId, _action, _parameters, context) => {
      await context.beforeAuditCommitHook(context.transactionClient);
      return { executionId: `audit-${context.transactionClient === undefined ? "missing" : "ok"}` };
    });
  });

  it("uses one database transaction per 100 records while preserving the normal action hook", async () => {
    const requests = Array.from({ length: 201 }, (_, index) => ({
      parameters: { transactionId: `tx-${index}`, batchId: "settlement-1" },
    }));

    const result = await executeRwandaRswitchBulkReconciliation({
      ontologyId: "ontology-1",
      requestId: "request-1",
      requests,
      contextFor: () => ({ executedBy: "recon-specialist" }),
    });

    expect(result.outcome).toBe("SUCCESS");
    expect(result.perRecordResults).toHaveLength(201);
    expect(withTransaction).toHaveBeenCalledTimes(3);
    expect(executeAction).toHaveBeenCalledTimes(201);
    for (const [, actionType, , context] of executeAction.mock.calls) {
      expect(actionType).toBe(RWANDA_RSWITCH_BULK_ACTION);
      expect(context.transactionClient).toBeDefined();
    }
  });

  it("rolls back the item savepoint and aborts its chunk on an infrastructure error", async () => {
    const clients: Array<{ query: ReturnType<typeof vi.fn> }> = [];
    withTransaction.mockImplementation(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const client = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
      clients.push(client);
      return callback(client);
    });
    executeAction
      .mockImplementationOnce(async (_ontologyId, _action, _parameters, context) => {
        await context.beforeAuditCommitHook(context.transactionClient);
        return { executionId: "audit-first" };
      })
      .mockRejectedValueOnce(new OntologyError("database unavailable", "ACTION_EXECUTION_FAILED", 503));

    await expect(executeRwandaRswitchBulkReconciliation({
      ontologyId: "ontology-1",
      requestId: "request-infra-failure",
      requests: [
        { parameters: { transactionId: "tx-1", batchId: "settlement-1" } },
        { parameters: { transactionId: "tx-2", batchId: "settlement-1" } },
      ],
      contextFor: () => ({ executedBy: "recon-specialist" }),
    })).rejects.toMatchObject({ code: "ACTION_EXECUTION_FAILED" });

    expect(clients[0].query).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT rwanda_bulk_1");
  });

  it("returns a partial result when the action executor reports its real submission-criteria code", async () => {
    executeAction
      .mockRejectedValueOnce(new OntologyError("not eligible", "SUBMISSION_CRITERIA_NOT_MET", 422))
      .mockImplementationOnce(async (_ontologyId, _action, _parameters, context) => {
        await context.beforeAuditCommitHook(context.transactionClient);
        return { executionId: "audit-eligible" };
      });

    const result = await executeRwandaRswitchBulkReconciliation({
      ontologyId: "ontology-1",
      requestId: "request-partial",
      requests: [
        { parameters: { transactionId: "tx-ineligible", batchId: "settlement-1" } },
        { parameters: { transactionId: "tx-eligible", batchId: "settlement-1" } },
      ],
      contextFor: () => ({ executedBy: "recon-specialist" }),
    });

    expect(result).toMatchObject({
      outcome: "PARTIAL_FAILURE",
      perRecordResults: [
        { transactionId: "tx-ineligible", outcome: "REJECTED", reasonCode: "INELIGIBLE" },
        { transactionId: "tx-eligible", outcome: "RECONCILED", auditId: "audit-eligible" },
      ],
    });
  });
});
