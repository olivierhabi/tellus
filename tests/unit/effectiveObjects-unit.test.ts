// ---------------------------------------------------------------------------
// effectiveObjects — Phase L D1 regression coverage.
//
// The effective-state read path guarantees: a row whose committed edits no
// longer satisfy a query's where clause is dropped from search results
// (refilterMergedRows), and aggregates computed during the serving-projector
// convergence window reflect the authoritative store, not the lagging index
// (recomputeAggregationsOverRows).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildEffectiveRowPredicate,
  refilterMergedRows,
  recomputeAggregationsOverRows,
} from "../../src/services/effectiveObjects";

describe("buildEffectiveRowPredicate", () => {
  const row = { signalStatus: "CONFIRMED", amount: 12500, name: "Alpha" };

  it("eq matches and mismatches by effective value", () => {
    expect(buildEffectiveRowPredicate({ type: "eq", field: "signalStatus", value: "CONFIRMED" })!(row)).toBe(true);
    expect(buildEffectiveRowPredicate({ type: "eq", field: "signalStatus", value: "OPEN" })!(row)).toBe(false);
  });

  it("neq inverts eq", () => {
    expect(buildEffectiveRowPredicate({ type: "neq", field: "signalStatus", value: "OPEN" })!(row)).toBe(true);
    expect(buildEffectiveRowPredicate({ type: "neq", field: "signalStatus", value: "CONFIRMED" })!(row)).toBe(false);
  });

  it("in matches membership", () => {
    const pred = buildEffectiveRowPredicate({ type: "in", field: "signalStatus", value: ["CONFIRMED", "DISMISSED"] });
    expect(pred!(row)).toBe(true);
  });

  it("numeric ranges compare numerically, not lexicographically", () => {
    expect(buildEffectiveRowPredicate({ type: "gte", field: "amount", value: 9000 })!(row)).toBe(true);
    expect(buildEffectiveRowPredicate({ type: "lt", field: "amount", value: 9000 })!(row)).toBe(false);
  });

  it("and/or/not compose", () => {
    const and = buildEffectiveRowPredicate({
      type: "and",
      filters: [
        { type: "eq", field: "signalStatus", value: "CONFIRMED" },
        { type: "gte", field: "amount", value: 12500 },
      ],
    });
    expect(and!(row)).toBe(true);
    const not = buildEffectiveRowPredicate({ type: "not", value: { type: "eq", field: "signalStatus", value: "OPEN" } });
    expect(not!(row)).toBe(true);
  });

  it("isNull / isNotNull check presence", () => {
    expect(buildEffectiveRowPredicate({ type: "isNull", field: "missing" })!(row)).toBe(true);
    expect(buildEffectiveRowPredicate({ type: "isNotNull", field: "signalStatus" })!(row)).toBe(true);
  });

  it("unsupported shapes return undefined (caller keeps index semantics)", () => {
    expect(buildEffectiveRowPredicate({ type: "linked", linkTypeApiName: "x" })).toBeUndefined();
  });
});

describe("refilterMergedRows", () => {
  it("drops rows whose EFFECTIVE properties no longer match (the D1 queue bug)", () => {
    // The index matched both rows with status=OPEN before projection; the
    // hydration overlay upgraded row B to its committed CONFIRMED value.
    const rows = [
      { __pk: "A", signalStatus: "OPEN" },
      { __pk: "B", signalStatus: "CONFIRMED" }, // stale index match, effective miss
    ];
    const out = refilterMergedRows(rows, { type: "eq", field: "signalStatus", value: "OPEN" });
    expect(out.map((r) => r.__pk)).toEqual(["A"]);
  });

  it("keeps everything for unfiltered searches and un-evaluable clauses", () => {
    const rows = [{ __pk: "A" }, { __pk: "B" }];
    expect(refilterMergedRows(rows, null)).toHaveLength(2);
    expect(
      refilterMergedRows(rows, { type: "linked", linkTypeApiName: "lt", targetObjectTypeApiName: "T" }),
    ).toHaveLength(2);
  });
});

describe("recomputeAggregationsOverRows", () => {
  const rows = [
    { status: "OPEN", amount: 100, detectedAt: "2026-01-15T00:00:00Z" },
    { status: "OPEN", amount: 300, detectedAt: "2026-02-15T00:00:00Z" },
    { status: "CONFIRMED", amount: 600, detectedAt: "2026-02-20T00:00:00Z" },
  ];

  it("count / sum / avg / min / max / cardinality", () => {
    const { data } = recomputeAggregationsOverRows(rows, [
      { name: "c", type: "count" },
      { name: "s", type: "sum", field: "amount" },
      { name: "a", type: "avg", field: "amount" },
      { name: "mn", type: "min", field: "amount" },
      { name: "mx", type: "max", field: "amount" },
      { name: "card", type: "cardinality", field: "status" },
    ]);
    expect(data.totalCount).toBe(3);
    expect(data.c).toBe(3);
    expect(data.s).toBe(1000);
    expect(data.a).toBeCloseTo(1000 / 3);
    expect(data.mn).toBe(100);
    expect(data.mx).toBe(600);
    expect(data.card).toBe(2);
  });

  it("terms buckets carry count + metric value, ordered by count desc, capped by size", () => {
    const { data } = recomputeAggregationsOverRows(rows, [
      { name: "byStatus", type: "terms", field: "status", size: 10, metric: { type: "sum", field: "amount" } },
    ]);
    const buckets = data.byStatus as Array<{ key: string; count: number; value: number }>;
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({ key: "OPEN", count: 2, value: 400 });
    expect(buckets[1]).toEqual({ key: "CONFIRMED", count: 1, value: 600 });
  });

  it("date_histogram buckets chronologically", () => {
    const { data } = recomputeAggregationsOverRows(rows, [
      { name: "trend", type: "date_histogram", field: "detectedAt", interval: "1M" },
    ]);
    expect(data.trend).toEqual([
      { key: "2026-01", count: 1 },
      { key: "2026-02", count: 2 },
    ]);
  });

  it("empty input produces zeroed totals, never whole-type fallbacks", () => {
    const { data } = recomputeAggregationsOverRows([], [
      { name: "c", type: "count" },
      { name: "s", type: "sum", field: "amount" },
    ]);
    expect(data.totalCount).toBe(0);
    expect(data.c).toBe(0);
    expect(data.s).toBeNull();
  });
});
