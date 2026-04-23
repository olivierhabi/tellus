// ---------------------------------------------------------------------------
// tests/unit/audit/hashChain-unit.test.ts
//
// Tests src/services/audit/hashChain.ts insertion + verification paths
// against a mocked PoolClient. The forward-walk verifier is exercised
// with:
//   - a genuine good chain (verified = N, breaks = 0)
//   - a mutated row body (row_hash_mismatch break)
//   - a mutated prev_hash (prev_hash_mismatch break)
//   - a null row_hash (null_hash break)
//
// Hard Rule §5 negative: flip the stored row_hash on a middle row and
// assert the verifier reports the break. Against a naive "audit rows are
// trusted as-is" baseline this test would fail because there would be
// no verifier to catch the tamper.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
}));

import {
  insertAuditRowWithHashChain,
  verifyChainSegment,
  AuditHashChainError,
  AUDIT_HASH_CHAIN_LOCK_KEY,
  type AuditRowBody,
} from "../../../src/services/audit/hashChain";
import { canonicalJson } from "../../../src/services/audit/canonicalJson";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

function makeBody(overrides: Partial<AuditRowBody> = {}): AuditRowBody {
  return {
    audit_id: "11111111-1111-1111-1111-111111111111",
    action_type_api_name: "testAction",
    action_type_display_name: "Test Action",
    execution_id: "22222222-2222-2222-2222-222222222222",
    parameters: { x: 1 },
    affected_objects: [{ pk: "a" }],
    affected_object_count: 1,
    result: "success",
    failure_type: null,
    error_message: null,
    duration_ms: 10,
    executed_by: "alice",
    executed_at: "2026-04-23T00:00:00.000Z",
    branch_id: null,
    source_ip: null,
    metadata: {},
    ...overrides,
  };
}

function expectedRowHash(prevHash: string, body: AuditRowBody): string {
  return createHash("sha256")
    .update(prevHash, "utf8")
    .update("\n", "utf8")
    .update(canonicalJson(body), "utf8")
    .digest("hex");
}

describe("insertAuditRowWithHashChain — write path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acquires advisory lock with AUDIT_HASH_CHAIN_LOCK_KEY as the first call", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT head_hash")) {
          return {
            rowCount: 1,
            rows: [
              {
                head_hash: "genesis-hash",
                head_audit_id: "00000000-0000-0000-0000-000000000000",
                head_seq: "0",
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    };
    await insertAuditRowWithHashChain(client as any, makeBody());
    expect(calls[0].sql).toContain("pg_advisory_xact_lock");
    expect(calls[0].params).toEqual([AUDIT_HASH_CHAIN_LOCK_KEY.toString()]);
  });

  it("computes row_hash = sha256(prev_hash || '\\n' || canonicalJson(body))", async () => {
    const body = makeBody({ executed_by: "bob" });
    const prev = "aabbccdd";
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT head_hash")) {
          return {
            rowCount: 1,
            rows: [{ head_hash: prev, head_audit_id: "x", head_seq: "5" }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    };
    const result = await insertAuditRowWithHashChain(client as any, body);
    expect(result.prevHash).toBe(prev);
    expect(result.rowHash).toBe(expectedRowHash(prev, body));
    expect(result.seq).toBe(6n);
  });

  it("throws AUDIT_CHAIN_HEAD_MISSING when head row absent", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT head_hash")) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
    };
    await expect(
      insertAuditRowWithHashChain(client as any, makeBody()),
    ).rejects.toBeInstanceOf(AuditHashChainError);
    expect(incMock).toHaveBeenCalledWith(
      "tellus_action_audit_chain_head_missing_total",
      {},
    );
  });

  it("emits tellus_action_audit_chain_appended_total on success", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT head_hash")) {
          return {
            rowCount: 1,
            rows: [{ head_hash: "p", head_audit_id: "x", head_seq: "0" }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    };
    await insertAuditRowWithHashChain(client as any, makeBody());
    expect(incMock).toHaveBeenCalledWith(
      "tellus_action_audit_chain_appended_total",
      {},
    );
  });

  it("propagates PG errors — does NOT catch (durable-before-ack)", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [] };
        throw new Error("PG connection lost");
      }),
    };
    await expect(
      insertAuditRowWithHashChain(client as any, makeBody()),
    ).rejects.toThrow("PG connection lost");
  });
});

describe("verifyChainSegment — forward-walk verifier", () => {
  beforeEach(() => vi.clearAllMocks());

  function chain(n: number, startingPrev: string = "genesis-hash"): any[] {
    let prev = startingPrev;
    const rows: any[] = [];
    for (let i = 0; i < n; i++) {
      const body = makeBody({
        audit_id: `row-${i}`,
        execution_id: `exec-${i}`,
        executed_at: `2026-04-23T00:00:${String(i).padStart(2, "0")}.000Z`,
        parameters: { seq: i },
      });
      const row_hash = expectedRowHash(prev, body);
      rows.push({
        ...body,
        executed_at: new Date(body.executed_at),
        prev_hash: prev,
        row_hash,
      });
      prev = row_hash;
    }
    return rows;
  }

  it("verifies a clean chain with verified=N, breaks=[]", async () => {
    const rows = chain(5);
    const client = {
      query: vi.fn(async () => ({ rowCount: rows.length, rows })),
    };
    const report = await verifyChainSegment(client as any, { limit: 5 });
    expect(report.verified).toBe(5);
    expect(report.breaks).toEqual([]);
    expect(report.last_verified_audit_id).toBe("row-4");
  });

  it("detects a row_hash mismatch (tampered row body)", async () => {
    const rows = chain(3);
    rows[1].parameters = { seq: 999 }; // tamper without updating row_hash
    const client = {
      query: vi.fn(async () => ({ rowCount: 3, rows })),
    };
    const report = await verifyChainSegment(client as any, { limit: 3 });
    expect(report.breaks.length).toBeGreaterThanOrEqual(1);
    expect(report.breaks[0].reason).toBe("row_hash_mismatch");
    expect(report.breaks[0].audit_id).toBe("row-1");
    expect(incMock).toHaveBeenCalledWith(
      "tellus_audit_chain_breaks_total",
      expect.any(Object),
    );
  });

  it("detects a prev_hash mismatch (tampered chain pointer)", async () => {
    const rows = chain(3);
    rows[2].prev_hash = "forged-prev-hash";
    const client = {
      query: vi.fn(async () => ({ rowCount: 3, rows })),
    };
    const report = await verifyChainSegment(client as any, { limit: 3 });
    const prevMismatches = report.breaks.filter((b) => b.reason === "prev_hash_mismatch");
    expect(prevMismatches.length).toBe(1);
    expect(prevMismatches[0].audit_id).toBe("row-2");
  });

  it("detects null row_hash as a break", async () => {
    const rows = chain(2);
    rows[1].row_hash = null;
    const client = { query: vi.fn(async () => ({ rowCount: 2, rows })) };
    const report = await verifyChainSegment(client as any, { limit: 2 });
    const nullBreaks = report.breaks.filter((b) => b.reason === "null_hash");
    expect(nullBreaks.length).toBe(1);
  });

  it("F-P3-11 negative: with no verifier, a mutated middle row would silently pass", async () => {
    // This is the negative assertion in spirit: demonstrate that relying
    // on stored row_hash without recomputation is insufficient. Our
    // verifier DOES recompute, so it catches. The inverse assertion below
    // shows what trusting stored row_hash (pre-fix behaviour) would miss.
    const rows = chain(3);
    rows[1].parameters = { seq: 999 }; // tamper
    const trustStored = rows.every((r) => r.row_hash !== null);
    expect(trustStored).toBe(true); // would pass the naive check
    // The real verifier catches it:
    const client = { query: vi.fn(async () => ({ rowCount: 3, rows })) };
    const report = await verifyChainSegment(client as any, { limit: 3 });
    expect(report.breaks.length).toBeGreaterThan(0);
  });
});
