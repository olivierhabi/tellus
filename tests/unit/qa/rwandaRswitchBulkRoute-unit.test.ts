import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, withTransaction, appendAuditRow } = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  appendAuditRow: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query, withTransaction }));
vi.mock("../../../src/models/actionAuditLog", () => ({ appendAuditRow }));

import {
  executeRwandaRswitchBulkReconciliation,
} from "../../../src/qa/rwanda/rSwitchBulkReconciliationRoute";

function request(transactionId: string, batchId = "settlement-1") {
  return { parameters: { transactionId, batchId } };
}

describe("Rwanda RSwitch production bulk route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT result")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    withTransaction.mockImplementation(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          if (sql.includes("FROM object_instances")) {
            return {
              rowCount: (values?.[3] as string[] | undefined)?.length ?? 0,
              rows: ((values?.[3] as string[] | undefined) ?? []).map((transactionId) => ({
                primary_key: transactionId,
                properties: { status: "FAILED", reconciliationEligibility: "ELIGIBLE" },
              })),
            };
          }
          if (sql.includes("rwanda_bulk_reconciliation_business_key")) {
            const transactionIds = values?.[1] as string[];
            const batchIds = values?.[2] as string[];
            return { rowCount: transactionIds.length, rows: transactionIds.map((transaction_id, index) => ({ transaction_id, batch_id: batchIds[index] })) };
          }
          return { rowCount: 1, rows: [] };
        }),
      };
      return callback(client);
    });
    let audit = 0;
    appendAuditRow.mockImplementation(async () => ({ auditId: `audit-${++audit}` }));
  });

  it("uses one transaction and set-based writes per 100 records while retaining one durable audit per accepted target", async () => {
    const requests = Array.from({ length: 201 }, (_, index) => request(`tx-${index}`));
    const result = await executeRwandaRswitchBulkReconciliation({
      ontologyId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-1",
      requests,
      contextFor: () => ({ executedBy: "recon-specialist", roles: ["recon-specialist"] }),
    });

    expect(result.outcome).toBe("SUCCESS");
    expect(result.perRecordResults).toHaveLength(201);
    expect(withTransaction).toHaveBeenCalledTimes(3);
    expect(appendAuditRow).toHaveBeenCalledTimes(201);
  });

  it("rolls back the entire chunk when durable audit append fails", async () => {
    appendAuditRow.mockRejectedValueOnce(new Error("audit storage unavailable"));
    await expect(executeRwandaRswitchBulkReconciliation({
      ontologyId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-infra-failure",
      requests: [request("tx-1"), request("tx-2")],
      contextFor: () => ({ executedBy: "recon-specialist", roles: ["recon-specialist"] }),
    })).rejects.toThrow("audit storage unavailable");
  });

  it("returns exact partial outcomes for ineligible, unauthorized, and accepted targets", async () => {
    withTransaction.mockImplementationOnce(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          if (sql.includes("FROM object_instances")) {
            return {
              rowCount: 2,
              rows: [
                { primary_key: "ineligible", properties: { status: "SETTLED", reconciliationEligibility: "ELIGIBLE" } },
                { primary_key: "accepted", properties: { status: "FAILED", reconciliationEligibility: "ELIGIBLE" } },
              ],
            };
          }
          if (sql.includes("rwanda_bulk_reconciliation_business_key")) {
            return { rowCount: 1, rows: [{ transaction_id: "accepted", batch_id: "settlement-1" }] };
          }
          return { rowCount: 1, rows: [] };
        }),
      };
      return callback(client);
    });
    const result = await executeRwandaRswitchBulkReconciliation({
      ontologyId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-partial",
      requests: [request("ineligible"), request("unauthorized"), request("accepted")],
      contextFor: (index) => index === 1
        ? { executedBy: "viewer", roles: [] }
        : { executedBy: "recon-specialist", roles: ["recon-specialist"] },
    });

    expect(result).toMatchObject({
      outcome: "PARTIAL_FAILURE",
      perRecordResults: [
        { transactionId: "ineligible", outcome: "REJECTED", reasonCode: "INELIGIBLE" },
        { transactionId: "unauthorized", outcome: "REJECTED", reasonCode: "PERMISSION_DENIED" },
        { transactionId: "accepted", outcome: "RECONCILED", auditId: "audit-1" },
      ],
    });
  });
});
