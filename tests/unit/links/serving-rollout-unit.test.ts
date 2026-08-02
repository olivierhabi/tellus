// ---------------------------------------------------------------------------
// Serving-store rollout flags + shadow comparison engine.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveServingMode, __resetServingRolloutCache } from "../../../src/services/serving/servingFlags";
import { compareShadow } from "../../../src/services/serving/shadowCompare";

describe("resolveServingMode", () => {
  beforeEach(() => {
    __resetServingRolloutCache();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  async function mockRows(rows: Array<{ scope_kind: string; scope_key: string; mode: string }>) {
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockResolvedValue({ rows, rowCount: rows.length } as never);
  }

  it("defaults to legacy when the table is empty", async () => {
    await mockRows([]);
    expect(await resolveServingMode({ ontologyId: "o1" })).toBe("legacy");
  });

  it("missing table (PG error) falls back to legacy", async () => {
    __resetServingRolloutCache();
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockRejectedValue(new Error("relation serving_rollout does not exist"));
    expect(await resolveServingMode({ ontologyId: "o1" })).toBe("legacy");
  });

  it("the most specific scope wins (link_type beats ontology beats tenant beats global)", async () => {
    await mockRows([
      { scope_kind: "global", scope_key: "*", mode: "legacy" },
      { scope_kind: "tenant", scope_key: "t-1", mode: "shadow" },
      { scope_kind: "ontology", scope_key: "o-1", mode: "indexed" },
      { scope_kind: "link_type", scope_key: "lt-9", mode: "legacy" },
    ]);
    expect(
      await resolveServingMode({ tenantId: "t-1", ontologyId: "o-1", linkTypeApiName: "lt-9" }),
    ).toBe("legacy");
    expect(
      await resolveServingMode({ tenantId: "t-1", ontologyId: "o-1" }),
    ).toBe("indexed");
    expect(await resolveServingMode({ tenantId: "t-1" })).toBe("shadow");
    expect(await resolveServingMode({})).toBe("legacy");
  });

  it("capability scope can gate one endpoint at a time", async () => {
    await mockRows([{ scope_kind: "capability", scope_key: "links.searchAround", mode: "shadow" }]);
    expect(await resolveServingMode({ capability: "links.searchAround" })).toBe("shadow");
    expect(await resolveServingMode({ capability: "links.resolve" })).toBe("legacy");
  });
});

describe("compareShadow", () => {
  it("canonicalizes ordering: permuted sets MATCH", async () => {
    const { pks, report } = await compareShadow({
      capability: "links.searchAround",
      scopeKey: "lt",
      legacyFn: async () => ({ pks: ["B", "A", "C"] }),
      indexedFn: async () => ({ pks: ["C", "B", "A"] }),
      primary: "legacy",
    });
    expect(report.match).toBe(true);
    expect(pks).toEqual(["B", "A", "C"]);
  });

  it("detects intentionally introduced differences and returns the primary", async () => {
    const { pks, report } = await compareShadow({
      capability: "links.searchAround",
      scopeKey: "lt",
      legacyFn: async () => ({ pks: ["A", "B"] }),
      indexedFn: async () => ({ pks: ["A", "B", "INJECTED"] }),
      primary: "legacy",
    });
    expect(report.match).toBe(false);
    expect(report.legacyCount).toBe(2);
    expect(report.indexedCount).toBe(3);
    expect(report.legacyDigest).not.toBe(report.indexedDigest);
    expect(pks).toEqual(["A", "B"]);
  });

  it("indexed-side errors never escape and are recorded as mismatches", async () => {
    const { pks, report } = await compareShadow({
      capability: "links.searchAround",
      scopeKey: "lt",
      legacyFn: async () => ({ pks: ["A"] }),
      indexedFn: async () => {
        throw new Error("clickhouse down");
      },
      primary: "legacy",
    });
    expect(pks).toEqual(["A"]);
    expect(report.match).toBe(false);
    expect(report.indexedError).toBe("clickhouse down");
  });

  it("primary=indexed returns the serving-index result on match", async () => {
    const { pks, report } = await compareShadow({
      capability: "links.searchAround",
      scopeKey: "lt",
      legacyFn: async () => ({ pks: ["A", "B"] }),
      indexedFn: async () => ({ pks: ["B", "A"] }),
      primary: "indexed",
    });
    expect(pks).toEqual(["B", "A"]);
    expect(report.match).toBe(true);
  });
});
