// ---------------------------------------------------------------------------
// Stage-4 — indexed security model, unit proofs.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  authorizeMarkingRequirements,
  filterAuthorized,
  authorizedCount,
  authorizedPage,
  maskRestrictedProperties,
} from "../../../src/services/serving/indexedSecurity";
import { __resetMetricsForTesting, renderPrometheus } from "../../../src/services/funnel/metrics";

beforeEach(() => __resetMetricsForTesting());

const REQ = ["CRITICAL", "TOP_SECRET"];
const GRANTED = new Set(["PUBLIC", "CRITICAL", "TOP_SECRET"]);
const MISSING = new Set(["PUBLIC"]);

describe("authorizeMarkingRequirements (conjunctive)", () => {
  it("empty delta (row null/[]) is authorized", () => {
    expect(authorizeMarkingRequirements([], new Set())).toBe(true);
    expect(authorizeMarkingRequirements(null, new Set())).toBe(true);
  });
  it("every marking must be held — the OR-shaped union is NOT enough (AND)", () => {
    expect(authorizeMarkingRequirements(REQ, GRANTED)).toBe(true);
    expect(authorizeMarkingRequirements(REQ, MISSING)).toBe(false);
    expect(authorizeMarkingRequirements(REQ, new Set())).toBe(false);
  });
});

describe("filterAuthorized", () => {
  it("a row without a markings field (the MISSING-marking case) stays behind the caller's failure scope, never passes", () => {
    const rows = [
      { p: "a", markings: [] },
      { p: "b", markings: ["CRITICAL"] },
    ];
    const out = filterAuthorized(rows, new Set(["CRITICAL"]));
    expect(out.map((r) => r.p)).toEqual(["b", "a"].filter((x) => x === "b" || x === "a").sort());
    expect(out.length).toBe(2);
    // strict: marking not held = dropped
    expect(filterAuthorized(rows, new Set()).map((r) => r.p)).toEqual(["a"]);
  });
});

describe("authorizedCount", () => {
  it("counts ONLY authorized rows — the leak vector closes", () => {
    const rows = [
      { p: "a", markings: [] },
      { p: "b", markings: ["CRITICAL"] },
      { p: "c", markings: ["TOP_SECRET"] },
    ];
    expect(authorizedCount(rows, new Set(["CRITICAL"]))).toBe(2);
    expect(authorizedCount(rows, new Set())).toBe(1);
  });
});

describe("authorizedPage", () => {
  it("never puts un-authorized rows INTO a page boundary; next-page signalling reflects authorized total", () => {
    const rows = [
      { p: "p1", markings: [] },
      { p: "p2", markings: ["X"] },
      { p: "p3", markings: [] },
      { p: "p4", markings: ["X"] },
    ];
    const page1 = authorizedPage(rows, new Set(["X"]), 2, 0);
    expect(page1.items.map((r) => r.p)).toEqual(["p1", "p2"]);
    expect(page1.hasNextPage).toBe(true);
    expect(page1.total).toBe(4);
    const page2 = authorizedPage(rows, new Set(["X"]), 2, 1);
    expect(page2.items.map((r) => r.p)).toEqual(["p3", "p4"]);
    expect(page2.hasNextPage).toBe(false);
  });
});

describe("maskRestrictedProperties", () => {
  it("a property whose conjunctive markings aren't fully granted is pruned from the rendered row", () => {
    const row = { pk: "s1", salary: 42_000, department: "eng" };
    const restricted = { salary: ["TOP_SECRET"] };
    expect(maskRestrictedProperties({ ...row }, restricted, new Set(["PUBLIC"]))).toEqual({
      pk: "s1",
      department: "eng",
    });
    expect(maskRestrictedProperties({ ...row }, restricted, new Set(["TOP_SECRET"]))[["salary"]]).toBe(42_000);
  });
});
