import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, withTransaction, appendAuditRow, publishCommittedObjectOverlay, openSearchBulk } = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  appendAuditRow: vi.fn(),
  publishCommittedObjectOverlay: vi.fn(),
  openSearchBulk: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query, withTransaction }));
vi.mock("../../../src/models/actionAuditLog", () => ({ appendAuditRow }));
vi.mock("../../../src/services/overlay/writebackOverlay", () => ({ publishCommittedObjectOverlay }));
vi.mock("../../../src/services/opensearch/client", () => ({
  client: { bulk: openSearchBulk },
}));

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
          if (sql.includes("UPDATE object_instances")) {
            return {
              rowCount: (values?.[3] as string[] | undefined)?.length ?? 0,
              rows: ((values?.[3] as string[] | undefined) ?? []).map((primary_key) => ({
                primary_key,
                properties: { status: "RECONCILED", reconciliationEligibility: "ELIGIBLE" },
                version: 2,
              })),
            };
          }
          return { rowCount: 1, rows: [] };
        }),
      };
      return callback(client);
    });
    let audit = 0;
    appendAuditRow.mockImplementation(async () => ({ auditId: `audit-${++audit}` }));
    publishCommittedObjectOverlay.mockResolvedValue(undefined);
    openSearchBulk.mockResolvedValue({ body: { errors: false } });
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
    expect(publishCommittedObjectOverlay).toHaveBeenCalledTimes(201);
    expect(openSearchBulk).toHaveBeenCalledTimes(3);
    expect(publishCommittedObjectOverlay).toHaveBeenCalledWith(expect.objectContaining({
      branchId: null,
      objectType: "QaRwRswitchPaymentTransactions",
      primaryKey: "tx-0",
      doc: { status: "RECONCILED", reconciliationEligibility: "ELIGIBLE" },
      version: 2,
    }));
  });

  it("rolls back the entire chunk when durable audit append fails", async () => {
    appendAuditRow.mockRejectedValueOnce(new Error("audit storage unavailable"));
    await expect(executeRwandaRswitchBulkReconciliation({
      ontologyId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-infra-failure",
      requests: [request("tx-1"), request("tx-2")],
      contextFor: () => ({ executedBy: "recon-specialist", roles: ["recon-specialist"] }),
    })).rejects.toThrow("audit storage unavailable");

    // §6.3: the durable run row reports every record's actual state after a
    // wholesale failure — the uncommitted chunk is NOT_ATTEMPTED, so a
    // same-requestId replay cannot return the empty placeholder as truth.
    const update = query.mock.calls.find(([sql]: [string]) =>
      String(sql).includes("UPDATE rwanda_bulk_reconciliation_run SET result"),
    );
    expect(update).toBeDefined();
    const persisted = JSON.parse((update as [string, unknown[]])[1][1] as string);
    expect(persisted.outcome).toBe("FAILED");
    expect(persisted.perRecordResults).toEqual([
      { transactionId: "tx-1", outcome: "REJECTED", reasonCode: "NOT_ATTEMPTED", auditId: null },
      { transactionId: "tx-2", outcome: "REJECTED", reasonCode: "NOT_ATTEMPTED", auditId: null },
    ]);
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
          if (sql.includes("UPDATE object_instances")) {
            return {
              rowCount: 1,
              rows: [{
                primary_key: "accepted",
                properties: { status: "RECONCILED", reconciliationEligibility: "ELIGIBLE" },
                version: 2,
              }],
            };
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
