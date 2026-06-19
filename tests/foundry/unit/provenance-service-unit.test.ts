// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §8 — ProvenanceService unit tests (no DB).
//
// The service is the join across the four audited streams. These tests inject
// a fake `query` that dispatches canned rows by SQL shape, so we can assert the
// correlation/summary logic deterministically without Postgres. The live wiring
// (real schema, real rows) is covered by the integration test.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { ProvenanceService, type QueryFn } from "../../../src/services/security/provenanceService";

type Rows = { rows: any[]; rowCount: number | null };
const ok = (rows: any[]): Rows => ({ rows, rowCount: rows.length });

/**
 * Build a fake query() that routes each SQL string to canned rows by matching
 * a distinctive fragment. Anything unmatched returns empty (so a stray query
 * surfaces as a missing-data assertion failure, not a false pass).
 */
function fakeQuery(canned: {
  reads?: any[];
  writes?: any[];
  decisions?: any[];
  datasetResolve?: any[];
  datasetNode?: any[];
  walkUpstream?: any[];
  walkDownstream?: any[];
  purposeGroup?: any[];
  purposeCatalogue?: any[];
}): { fn: QueryFn; calls: string[] } {
  const calls: string[] = [];
  let walkSeen = 0;
  const fn: QueryFn = async (sql: string) => {
    calls.push(sql);
    if (sql.includes("affected_objects @>")) return ok(canned.writes ?? []);
    if (sql.includes("cbac_decision_log")) return ok(canned.decisions ?? []);
    if (sql.includes("FROM backing_datasource") || sql.includes("JOIN backing_datasource"))
      return ok(canned.datasetResolve ?? []);
    if (sql.includes("WITH RECURSIVE walk")) {
      // upstream walk is issued first (Promise.all order in source), but to be
      // robust we alternate on call order.
      walkSeen += 1;
      const wantUp = sql.includes("l.downstream_dataset_id = w.node");
      return ok((wantUp ? canned.walkUpstream : canned.walkDownstream) ?? []);
    }
    if (sql.includes("FROM foundry_datasets WHERE id")) return ok(canned.datasetNode ?? []);
    if (sql.includes("FROM access_purpose")) return ok(canned.purposeCatalogue ?? []);
    if (sql.includes("metadata->>'purpose' AS purpose")) return ok(canned.purposeGroup ?? []);
    if (sql.includes("LIKE '__read.%'") && sql.includes("primary_key' = $3"))
      return ok(canned.reads ?? []);
    return ok([]);
  };
  return { fn, calls };
}

describe("ProvenanceService.getObjectProvenance", () => {
  it("joins reads, writes, decisions, lineage and purposes into one record", async () => {
    const { fn } = fakeQuery({
      reads: [
        {
          executed_at: "2026-06-10T10:00:00.000Z",
          executed_by: "alice",
          source_ip: "10.0.0.1",
          result: "success",
          route: "/v1/ontology/o1/objects/Taxpayer/T1",
          purpose: "tax-audit",
          result_count: 1,
          category: "object.read",
        },
        {
          executed_at: "2026-06-10T11:00:00.000Z",
          executed_by: "bob",
          source_ip: "10.0.0.2",
          result: "success",
          route: "/v1/.../traverse",
          purpose: null,
          result_count: 4,
          category: "object.traverse",
        },
      ],
      writes: [
        {
          executed_at: "2026-06-09T09:00:00.000Z",
          executed_by: "etl-service",
          source_ip: null,
          result: "success",
          failure_type: null,
          action: "createTaxpayer",
          execution_id: "exec-1",
          branch_id: null,
          operation: "create",
        },
      ],
      decisions: [
        {
          decided_at: "2026-06-09T09:00:00.000Z",
          subject: "etl-service",
          subject_kind: "service",
          decision: "allow",
          reason: "allowlist match",
          resource_kind: "action_type",
          resource_id: "createTaxpayer",
          source_ip: null,
        },
        {
          decided_at: "2026-06-09T08:59:00.000Z",
          subject: "mallory",
          subject_kind: "user",
          decision: "deny",
          reason: "markings_insufficient",
          resource_kind: "action_type",
          resource_id: "createTaxpayer",
          source_ip: "10.9.9.9",
        },
      ],
      datasetResolve: [{ dataset_id: "11111111-1111-1111-1111-111111111111" }],
      datasetNode: [{ id: "11111111-1111-1111-1111-111111111111", name: "taxpayer_merged" }],
      walkUpstream: [{ id: "22222222-2222-2222-2222-222222222222", name: "raw_taxpayers" }],
      walkDownstream: [{ id: "33333333-3333-3333-3333-333333333333", name: "tax_summary" }],
      purposeGroup: [{ purpose: "tax-audit", reads: 1 }],
      purposeCatalogue: [{ api_name: "tax-audit", display_name: "Tax Audit" }],
    });

    const svc = new ProvenanceService(fn);
    const p = await svc.getObjectProvenance({
      ontologyId: "o1",
      objectTypeApiName: "Taxpayer",
      primaryKey: "T1",
    });

    expect(p.object).toEqual({ ontologyId: "o1", objectTypeApiName: "Taxpayer", primaryKey: "T1" });

    // reads
    expect(p.reads).toHaveLength(2);
    expect(p.reads[0]).toMatchObject({ by: "alice", category: "object.read", purpose: "tax-audit", resultCount: 1 });
    expect(p.reads[1]).toMatchObject({ by: "bob", category: "object.traverse", purpose: null });

    // writes carry the affected-object operation
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0]).toMatchObject({ by: "etl-service", action: "createTaxpayer", operation: "create" });

    // access decisions correlated to the writing action type (allow + deny)
    expect(p.accessDecisions).toHaveLength(2);
    expect(p.accessDecisions.map((d) => d.decision).sort()).toEqual(["allow", "deny"]);

    // lineage: backing dataset + upstream/downstream
    expect(p.lineage.dataset).toMatchObject({ name: "taxpayer_merged" });
    expect(p.lineage.upstream.map((n) => n.name)).toEqual(["raw_taxpayers"]);
    expect(p.lineage.downstream.map((n) => n.name)).toEqual(["tax_summary"]);

    // purposes observed (active because present in catalogue)
    expect(p.purposes).toEqual([
      { apiName: "tax-audit", displayName: "Tax Audit", active: true, reads: 1 },
    ]);

    // summary
    expect(p.summary.totalReads).toBe(2);
    expect(p.summary.totalWrites).toBe(1);
    expect(p.summary.distinctReaders).toBe(2);
    expect(p.summary.distinctWriters).toBe(1);
    expect(p.summary.denials).toBe(1);
    expect(p.summary.firstTouchedAt).toBe("2026-06-09T09:00:00.000Z"); // the write
    expect(p.summary.lastTouchedAt).toBe("2026-06-10T11:00:00.000Z"); // the latest read
    expect(p.notes).toEqual([]);
  });

  it("emits a note and empty lineage when the object type has no backing dataset", async () => {
    const { fn } = fakeQuery({
      reads: [],
      writes: [],
      datasetResolve: [], // no backing dataset
    });
    const svc = new ProvenanceService(fn);
    const p = await svc.getObjectProvenance({
      ontologyId: "o1",
      objectTypeApiName: "VirtualThing",
      primaryKey: "V1",
    });
    expect(p.lineage).toEqual({ dataset: null, upstream: [], downstream: [] });
    expect(p.notes.join(" ")).toMatch(/no backing/i);
    expect(p.summary.totalReads).toBe(0);
    expect(p.summary.firstTouchedAt).toBeNull();
  });

  it("marks an observed purpose inactive when it is not in the catalogue (archived/deleted)", async () => {
    const { fn } = fakeQuery({
      reads: [],
      writes: [],
      datasetResolve: [],
      purposeGroup: [{ purpose: "ghost-purpose", reads: 3 }],
      purposeCatalogue: [], // not found
    });
    const svc = new ProvenanceService(fn);
    const p = await svc.getObjectProvenance({
      ontologyId: "o1",
      objectTypeApiName: "Taxpayer",
      primaryKey: "T1",
    });
    expect(p.purposes).toEqual([
      { apiName: "ghost-purpose", displayName: null, active: false, reads: 3 },
    ]);
  });
});
