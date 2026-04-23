// ---------------------------------------------------------------------------
// F-P3-04: 12-cell cardinality × violation_policy test matrix.
//
// Pre-fix bug (closure evidence):
//   linkViolationEnforcer.ts queried `ORDER BY created_at` against link_edit
//   but the column is actually `executed_at`. PG raised SQLSTATE 42703
//   ("column does not exist"). A `catch {}` wrapper swallowed the error and
//   returned {allowed:true} unconditionally — so ONE_TO_ONE and ONE_TO_MANY
//   cardinality enforcement was silently dead code.
//
// This test suite exercises all 3 cardinalities × 3 policies + 3 no-conflict
// baselines = 12 cells. Every post-fix call-site emits a Prometheus counter
// per Hard Rule §6.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock modules BEFORE importing the SUT.
vi.mock("../../../src/db", () => ({
  query: vi.fn(),
}));
vi.mock("../../../src/models/linkQuarantine", () => ({
  insertQuarantineEntry: vi.fn().mockResolvedValue({ violation_id: "v-1" }),
  bumpViolationCounter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/services/opensearch/client", () => ({ client: {} }));
vi.mock("../../../src/services/opensearch/indexLifecycleManager", () => ({
  getIndexName: (n: string) => `ontology-${n}`,
}));
vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
}));

import { enforceOneToOneAdd } from "../../../src/services/linkViolationEnforcer";
import { query } from "../../../src/db";
import { incCounter } from "../../../src/services/funnel/metrics";
import { insertQuarantineEntry } from "../../../src/models/linkQuarantine";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedIncCounter = incCounter as unknown as ReturnType<typeof vi.fn>;
const mockedInsertQ = insertQuarantineEntry as unknown as ReturnType<typeof vi.fn>;

function lt(cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY",
            policy: "reject" | "warn" | "quarantine") {
  return {
    link_type_id: "lt-1",
    api_name: "testLink",
    cardinality,
    violation_policy: policy,
    source_object_type: "A",
    target_object_type: "B",
    source_property_id: null,
    target_property_id: null,
  } as any;
}

describe("F-P3-04: enforceOneToOneAdd — 12-cell matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------- ONE_TO_ONE (existing conflict in link_edit) --------
  describe("ONE_TO_ONE with existing target for source", () => {
    beforeEach(() => {
      // First call: findExistingOneToOneTarget → returns a different existing target
      mockedQuery.mockResolvedValueOnce({
        rows: [{ target_primary_key: "existingTarget" }],
      });
    });

    it("cell-1: reject → throws ONE_TO_ONE_VIOLATION + emits blocked counter", async () => {
      await expect(
        enforceOneToOneAdd({ linkType: lt("ONE_TO_ONE", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "newT" })
      ).rejects.toMatchObject({ code: "ONE_TO_ONE_VIOLATION" });
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_violation_blocked_total",
        { cardinality: "ONE_TO_ONE", policy: "reject", link_type: "testLink" }
      );
    });

    it("cell-2: warn → allowed with warning + emits allowed counter", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_ONE", "warn"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "newT" });
      expect(res.allowed).toBe(true);
      expect(res.quarantined).toBe(false);
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_violation_allowed_total",
        { cardinality: "ONE_TO_ONE", policy: "warn", link_type: "testLink" }
      );
      warnSpy.mockRestore();
    });

    it("cell-3: quarantine → allowed + quarantined + emits allowed counter + inserts quarantine entry", async () => {
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_ONE", "quarantine"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "newT" });
      expect(res.allowed).toBe(true);
      expect(res.quarantined).toBe(true);
      expect(res.violationId).toBe("v-1");
      expect(mockedInsertQ).toHaveBeenCalledOnce();
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_violation_allowed_total",
        { cardinality: "ONE_TO_ONE", policy: "quarantine", link_type: "testLink" }
      );
    });
  });

  // -------- ONE_TO_MANY (target already claimed by another source) --------
  describe("ONE_TO_MANY with target already claimed by another source", () => {
    beforeEach(() => {
      mockedQuery.mockResolvedValueOnce({
        rows: [{ source_primary_key: "otherSource" }],
      });
    });

    it("cell-4: reject → throws ONE_TO_MANY_VIOLATION + emits blocked counter", async () => {
      await expect(
        enforceOneToOneAdd({ linkType: lt("ONE_TO_MANY", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" })
      ).rejects.toMatchObject({ code: "ONE_TO_MANY_VIOLATION" });
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_violation_blocked_total",
        { cardinality: "ONE_TO_MANY", policy: "reject", link_type: "testLink" }
      );
    });

    it("cell-5: warn → allowed with warning + emits allowed counter", async () => {
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_MANY", "warn"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
      expect(res.warnings[0]).toContain("already linked from");
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_violation_allowed_total",
        expect.objectContaining({ cardinality: "ONE_TO_MANY", policy: "warn" })
      );
    });

    it("cell-6: quarantine → allowed + emits allowed counter", async () => {
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_MANY", "quarantine"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_violation_allowed_total",
        expect.objectContaining({ cardinality: "ONE_TO_MANY", policy: "quarantine" })
      );
    });
  });

  // -------- MANY_TO_MANY (no cardinality constraint at all) --------
  describe("MANY_TO_MANY baseline — enforcement is a no-op by contract", () => {
    it("cell-7: reject policy is ignored — MANY_TO_MANY has no constraint", async () => {
      const res = await enforceOneToOneAdd({ linkType: lt("MANY_TO_MANY", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it("cell-8: warn policy is ignored", async () => {
      const res = await enforceOneToOneAdd({ linkType: lt("MANY_TO_MANY", "warn"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
    });

    it("cell-9: quarantine policy is ignored", async () => {
      const res = await enforceOneToOneAdd({ linkType: lt("MANY_TO_MANY", "quarantine"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
    });
  });

  // -------- No-conflict baselines (enforcement allows, no counter emitted) --------
  describe("No-conflict baselines — clean allow path", () => {
    it("cell-10: ONE_TO_ONE with no existing target → allowed, no violation counter", async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [] });
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_ONE", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
      const violationCalls = mockedIncCounter.mock.calls.filter((c) =>
        c[0] === "tellus_link_violation_blocked_total"
      );
      expect(violationCalls).toHaveLength(0);
    });

    it("cell-11: ONE_TO_ONE with same target for same source → idempotent allow", async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ target_primary_key: "t" }] });
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_ONE", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
    });

    it("cell-12: ONE_TO_MANY with target available (no prior source claim) → allowed", async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [] });
      const res = await enforceOneToOneAdd({ linkType: lt("ONE_TO_MANY", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" });
      expect(res.allowed).toBe(true);
    });
  });

  // -------- Pre-fix negative test: the bug was SILENT — simulate column error --------
  describe("F-P3-04 negative: column-rename bug MUST surface as LINK_ENFORCEMENT_UNAVAILABLE", () => {
    it("ONE_TO_MANY with PG column error → fail loud (not silent allow)", async () => {
      const err = Object.assign(new Error('column "created_at" does not exist'), { code: "42703" });
      // findExistingOneToOneTarget is not called for ONE_TO_MANY directly; the
      // enforceOneToManyAdd helper issues its own query. Mock the first call to
      // fail with SQLSTATE 42703 — the pre-fix code silently allowed; the
      // post-fix code MUST throw LINK_ENFORCEMENT_UNAVAILABLE.
      mockedQuery.mockRejectedValueOnce(err);
      await expect(
        enforceOneToOneAdd({ linkType: lt("ONE_TO_MANY", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" })
      ).rejects.toMatchObject({ code: "LINK_ENFORCEMENT_UNAVAILABLE" });
      expect(mockedIncCounter).toHaveBeenCalledWith(
        "tellus_link_enforcement_degraded_total",
        { reason: "query_error", cardinality: "ONE_TO_MANY" }
      );
    });

    it("ONE_TO_ONE with PG column error → fail loud (not silent allow)", async () => {
      const err = Object.assign(new Error('column "created_at" does not exist'), { code: "42703" });
      mockedQuery.mockRejectedValueOnce(err);
      await expect(
        enforceOneToOneAdd({ linkType: lt("ONE_TO_ONE", "reject"), ontologyId: "o", branchId: "b-main", sourcePk: "s", targetPk: "t" })
      ).rejects.toMatchObject({ code: "LINK_ENFORCEMENT_UNAVAILABLE" });
    });
  });
});
