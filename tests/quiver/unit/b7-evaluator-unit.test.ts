/**
 * B7 — In-process MatAdapter evaluator unit tests + plan-equivalence
 * golden between Polars and Spark tiers.
 *
 * Covers:
 *   B7 C-04 evaluator computes deterministic results for {scan, project,
 *           filter, join, aggregate, pivot, expression, orderBy}
 *   B7 C-05 polarsExecute and sparkExecute return byte-identical results
 *           for the canonicalised plan on golden datasets (the only
 *           variance allowed is up to the ORDER BY clause)
 *   B7 C-06 pinSnapshots returns deterministic snapshot ids
 *   B7 C-08 row limit 50_000 surfaces as MatLimitExceededError
 *   B7 C-10 every port call records the supplied branch
 */

import { describe, it, expect } from "vitest";
import { InProcessMatAdapter } from "../../../src/services/quiver/compute/mat/inProcessMat";
import { MatLimitExceededError, type MatExecuteContext } from "../../../src/services/quiver/compute/mat/matPort";
import type { CalcitePlan } from "../../../src/services/quiver/compute/mat/calcitePlan";

const ctx: MatExecuteContext = { branch: "trunk", remainingMs: 5_000, userSubject: "u-1" };

function buildAdapter(): InProcessMatAdapter {
  const a = new InProcessMatAdapter();
  a.registerDataset("ri.tellus.main.dataset.orders", {
    snapshotId: "snap-orders-001",
    columns: [
      { name: "id",       type: "STRING" },
      { name: "customer", type: "STRING" },
      { name: "amount",   type: "NUMBER" },
      { name: "region",   type: "STRING" },
    ],
    rows: [
      ["o1", "c1", 10, "EU"],
      ["o2", "c1", 20, "EU"],
      ["o3", "c2", 30, "US"],
      ["o4", "c2", 40, "EU"],
      ["o5", "c3", 50, "US"],
    ],
  });
  a.registerDataset("ri.tellus.main.dataset.customers", {
    snapshotId: "snap-customers-002",
    columns: [
      { name: "customer", type: "STRING" },
      { name: "tier",     type: "STRING" },
    ],
    rows: [["c1", "gold"], ["c2", "silver"], ["c3", "bronze"]],
  });
  return a;
}

describe("B7 — InProcessMatAdapter evaluator", () => {
  it("B7 C-06 — pinSnapshots returns the per-dataset snapshot id", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "s1",
      nodes: [{ kind: "scan", id: "s1", datasetRid: "ri.tellus.main.dataset.orders", columns: ["id"] }],
    };
    expect(await a.pinSnapshots(plan, ctx)).toEqual({ "ri.tellus.main.dataset.orders": "snap-orders-001" });
  });

  it("B7 C-04 — scan + filter + project pipeline returns expected rows", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "p1",
      nodes: [
        { kind: "scan",    id: "s1", datasetRid: "ri.tellus.main.dataset.orders", columns: ["id", "amount", "region"] },
        { kind: "filter",  id: "f1", input: "s1", predicate: { op: "eq", args: ["region", "EU"] } },
        { kind: "project", id: "p1", input: "f1", columns: ["id", "amount"] },
      ],
    };
    const r = await a.polarsExecute(plan, ctx);
    expect(r.rows).toEqual([["o1", 10], ["o2", 20], ["o4", 40]]);
  });

  it("B7 C-04 — aggregate sums by group and orders deterministically", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "a1",
      nodes: [
        { kind: "scan",      id: "s1", datasetRid: "ri.tellus.main.dataset.orders", columns: ["customer", "amount"] },
        { kind: "aggregate", id: "a1", input: "s1", groupBy: ["customer"], aggregations: [{ fn: "sum", column: "amount", alias: "total" }] },
      ],
    };
    const r = await a.polarsExecute(plan, ctx);
    expect(r.rows).toEqual([["c1", 30], ["c2", 70], ["c3", 50]]);
  });

  it("B7 C-04 — join + aggregate", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "a1",
      nodes: [
        { kind: "scan",      id: "s1", datasetRid: "ri.tellus.main.dataset.orders",    columns: ["customer", "amount"] },
        { kind: "scan",      id: "s2", datasetRid: "ri.tellus.main.dataset.customers", columns: ["customer", "tier"] },
        { kind: "join",      id: "j1", left: "s1", right: "s2", on: [{ leftCol: "customer", rightCol: "customer" }], type: "inner" },
        { kind: "aggregate", id: "a1", input: "j1", groupBy: ["tier"], aggregations: [{ fn: "sum", column: "amount", alias: "rev" }] },
      ],
    };
    const r = await a.polarsExecute(plan, ctx);
    expect(r.rows).toEqual([["bronze", 50], ["gold", 30], ["silver", 70]]);
  });

  it("B7 C-04 — expression node appends a derived column", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "e1",
      nodes: [
        { kind: "scan",       id: "s1", datasetRid: "ri.tellus.main.dataset.orders", columns: ["amount"] },
        { kind: "expression", id: "e1", input: "s1", column: "doubled", expression: "amount * 2" },
      ],
    };
    const r = await a.polarsExecute(plan, ctx);
    expect(r.rows).toEqual([[10, 20], [20, 40], [30, 60], [40, 80], [50, 100]]);
  });

  it("B7 C-04 — pivot table sums by row × col", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "pv1",
      nodes: [
        { kind: "scan",  id: "s1",  datasetRid: "ri.tellus.main.dataset.orders", columns: ["customer", "region", "amount"] },
        { kind: "pivot", id: "pv1", input: "s1", rows: ["customer"], cols: "region", value: "amount", fn: "sum" },
      ],
    };
    const r = await a.polarsExecute(plan, ctx);
    expect(r.columns.map((c) => c.name)).toEqual(["customer", "EU", "US"]);
    expect(r.rows).toEqual([["c1", 30, 0], ["c2", 40, 30], ["c3", 0, 50]]);
  });

  it("B7 C-05 — polarsExecute and sparkExecute return identical results on the same plan (golden #1)", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "p1",
      nodes: [
        { kind: "scan",      id: "s1", datasetRid: "ri.tellus.main.dataset.orders", columns: ["customer", "amount"] },
        { kind: "aggregate", id: "a1", input: "s1", groupBy: ["customer"], aggregations: [{ fn: "sum", column: "amount", alias: "total" }] },
        { kind: "project",   id: "p1", input: "a1", columns: ["customer", "total"] },
      ],
    };
    const polars = await a.polarsExecute(plan, ctx);
    const spark  = await a.sparkExecute(plan, ctx);
    expect(JSON.stringify(polars)).toBe(JSON.stringify(spark));
  });

  it("B7 C-05 — golden equivalence #2: pivot + orderBy", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "ob1",
      nodes: [
        { kind: "scan",    id: "s1",  datasetRid: "ri.tellus.main.dataset.orders", columns: ["customer", "region", "amount"] },
        { kind: "pivot",   id: "pv1", input: "s1", rows: ["customer"], cols: "region", value: "amount", fn: "sum" },
        { kind: "orderBy", id: "ob1", input: "pv1", orderings: [{ column: "customer", direction: "desc" }] },
      ],
    };
    const polars = await a.polarsExecute(plan, ctx);
    const spark  = await a.sparkExecute(plan, ctx);
    expect(JSON.stringify(polars)).toBe(JSON.stringify(spark));
    // descending order on customer
    expect(polars.rows[0][0]).toBe("c3");
  });

  it("B7 C-08 — row limit 50_000 surfaces as MatLimitExceededError", async () => {
    const a = new InProcessMatAdapter();
    a.registerDataset("ri.tellus.main.dataset.huge", {
      snapshotId: "snap-h",
      columns: [{ name: "id", type: "STRING" }],
      rows: Array.from({ length: 50_001 }, (_, i) => [`r${i}`]),
    });
    const plan: CalcitePlan = {
      root: "s1",
      nodes: [{ kind: "scan", id: "s1", datasetRid: "ri.tellus.main.dataset.huge", columns: ["id"] }],
    };
    await expect(a.polarsExecute(plan, ctx)).rejects.toBeInstanceOf(MatLimitExceededError);
  });

  it("B7 C-10 + G-09 — every port call records branch", async () => {
    const a = buildAdapter();
    const plan: CalcitePlan = {
      root: "s1",
      nodes: [{ kind: "scan", id: "s1", datasetRid: "ri.tellus.main.dataset.orders", columns: ["id"] }],
    };
    await a.pinSnapshots(plan, { ...ctx, branch: "feature-x" });
    await a.estimateCardinality(plan, { ...ctx, branch: "feature-x" });
    await a.polarsExecute(plan, { ...ctx, branch: "feature-x" });
    await a.sparkExecute(plan, { ...ctx, branch: "feature-x" });
    expect(a.calls.every((c) => c.branch === "feature-x")).toBe(true);
    expect(a.calls.map((c) => c.op)).toEqual(["pinSnapshots", "estimateCardinality", "polarsExecute", "sparkExecute"]);
  });
});
