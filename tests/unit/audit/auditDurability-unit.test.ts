// ---------------------------------------------------------------------------
// tests/unit/audit/auditDurability-unit.test.ts
//
// F-P3-11 negative test — durable-before-ack contract on the Action path.
//
// Pre-fix behaviour: src/models/actionAuditLog.ts stated `logActionExecution()
// must NEVER throw`. A failed audit row still returned 200 OK with the
// Action's result. The regulatory contract (Rwandan Law 058/2021 Art. 29)
// was violated on every audit-path failure.
//
// Post-fix behaviour: appendAuditRow + logStandaloneFailureAudit both
// THROW on failure. The Action's PG transaction rolls back together with
// the audit failure; the route layer surfaces AuditDurabilityError as
// 503 Service Unavailable.
//
// This test proves the throw contract by mocking a failing PG client
// under logStandaloneFailureAudit and asserting AuditDurabilityError is
// raised with statusCode=503 and a Prometheus counter is incremented.
// Against the pre-fix code (bare return on failure), this test would
// have asserted a throw that never happened.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock metrics before importing SUT.
vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  setGauge: vi.fn(),
  observeHistogram: vi.fn(),
}));

// Mock the db module — getClient returns a PoolClient whose query/throws
// are driven by the individual tests.
const mockClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } = {
  query: vi.fn(),
  release: vi.fn(),
};
vi.mock("../../../src/db", () => ({
  getClient: vi.fn(async () => mockClient),
}));

import {
  logStandaloneFailureAudit,
  AuditDurabilityError,
  appendAuditRow,
} from "../../../src/models/actionAuditLog";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

function baseEntry() {
  return {
    action_type_api_name: "testAction",
    action_type_display_name: "Test Action",
    execution_id: "00000000-0000-0000-0000-000000000001",
    parameters: { x: 1 },
    affected_objects: [],
    affected_object_count: 0,
    result: "success" as const,
    failure_type: null,
    error_message: null,
    duration_ms: 10,
    executed_by: "alice",
  };
}

describe("F-P3-11 — Audit durability contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
  });

  describe("logStandaloneFailureAudit — standalone failure path", () => {
    it("PG failure during INSERT → throws AuditDurabilityError with statusCode=503", async () => {
      // First query: BEGIN succeeds.
      // Second query: advisory lock succeeds.
      // Third query: SELECT head_hash succeeds.
      // Fourth query: INSERT fails.
      mockClient.query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // advisory lock
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ head_hash: "prev", head_audit_id: "x", head_seq: "0" }],
        })
        .mockRejectedValueOnce(new Error("PG write failed: disk full")) // INSERT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

      await expect(logStandaloneFailureAudit(baseEntry())).rejects.toBeInstanceOf(
        AuditDurabilityError,
      );

      // Assert ROLLBACK was attempted.
      const rollbackCall = mockClient.query.mock.calls.find((c) =>
        String(c[0]).includes("ROLLBACK"),
      );
      expect(rollbackCall).toBeDefined();

      // Assert client was released.
      expect(mockClient.release).toHaveBeenCalled();

      // Assert Prometheus counter was incremented.
      expect(incMock).toHaveBeenCalledWith(
        "tellus_action_audit_standalone_failed_total",
        expect.objectContaining({ reason: expect.any(String) }),
      );
    });

    it("AuditDurabilityError has statusCode=503 + code=AUDIT_DURABILITY_FAILED", async () => {
      mockClient.query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error("fail")) // advisory lock
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

      try {
        await logStandaloneFailureAudit(baseEntry());
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AuditDurabilityError);
        const e = err as AuditDurabilityError;
        expect(e.code).toBe("AUDIT_DURABILITY_FAILED");
        expect(e.statusCode).toBe(503);
      }
    });

    it("successful path: commits and returns auditId + rowHash", async () => {
      mockClient.query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // advisory lock
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ head_hash: "prev-hash", head_audit_id: "x", head_seq: "0" }],
        }) // SELECT head
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE head
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT

      const result = await logStandaloneFailureAudit(baseEntry());
      expect(result.auditId).toMatch(/^[0-9a-f]{8}-/);
      expect(result.rowHash).toMatch(/^[0-9a-f]{64}$/);
      expect(incMock).toHaveBeenCalledWith(
        "tellus_action_audit_chain_appended_total",
        {},
      );
    });

    it("F-P3-11 negative: pre-fix contract 'must NEVER throw' is REVOKED — failures DO throw", async () => {
      // Pre-fix code: logActionExecution() would have returned a best-effort
      // object on failure, swallowing the error. Post-fix: it throws.
      mockClient.query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error("regulatory-violation-path"))
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK

      // If this call silently returned, the 503-translation chain in
      // actionExecutor would never fire. The post-fix code guarantees a
      // throw so the route returns 503 instead of a false 200.
      await expect(logStandaloneFailureAudit(baseEntry())).rejects.toThrow(
        /audit durability failed/,
      );
    });
  });

  describe("appendAuditRow — in-transaction path", () => {
    it("failure inside caller's transaction propagates (durable-before-ack)", async () => {
      // Caller owns BEGIN/COMMIT. appendAuditRow must not catch — failure
      // propagates so caller can ROLLBACK the whole transaction including
      // the Action's edits.
      const clientForTxn = {
        query: vi.fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // advisory lock
          .mockRejectedValueOnce(new Error("head row missing")), // SELECT head fails
      };

      await expect(
        appendAuditRow(clientForTxn as any, baseEntry()),
      ).rejects.toThrow(/head row missing/);

      // Observability counter incremented with the right category.
      expect(incMock).toHaveBeenCalledWith(
        "tellus_action_audit_inline_failed_total",
        expect.any(Object),
      );
    });
  });
});
