/**
 * B7 — Calcite plan synthesis unit tests.
 *
 * Covers:
 *   B7 C-04 plan is JSON-serialisable + canonicalises stably
 *   B7 C-05 plansEqual under node-order shuffle
 *   B7 C-06 datasetsOf walks scan nodes deterministically
 */

import { describe, it, expect } from "vitest";
import {
  canonicalisePlan,
  datasetsOf,
  plansEqual,
  type CalcitePlan,
} from "../../../src/services/quiver/compute/mat/calcitePlan";

const samplePlan: CalcitePlan = {
  root: "p1",
  nodes: [
    { kind: "scan",    id: "s1", datasetRid: "ri.tellus.main.dataset.alpha", columns: ["a", "b"] },
    { kind: "scan",    id: "s2", datasetRid: "ri.tellus.main.dataset.beta",  columns: ["b", "c"] },
    { kind: "join",    id: "j1", left: "s1", right: "s2", on: [{ leftCol: "b", rightCol: "b" }], type: "inner" },
    { kind: "project", id: "p1", input: "j1", columns: ["a", "c"] },
  ],
};

describe("B7 — Calcite plan", () => {
  it("B7 C-04 — plans serialise to JSON deterministically", () => {
    const a = JSON.stringify(canonicalisePlan(samplePlan));
    const b = JSON.stringify(canonicalisePlan(samplePlan));
    expect(a).toBe(b);
  });

  it("B7 C-05 — plansEqual is invariant under node-order shuffle", () => {
    const shuffled: CalcitePlan = {
      root: samplePlan.root,
      nodes: [...samplePlan.nodes].reverse(),
    };
    expect(plansEqual(samplePlan, shuffled)).toBe(true);
  });

  it("B7 C-05 — plans with different roots are not equal", () => {
    const otherRoot: CalcitePlan = { root: "j1", nodes: samplePlan.nodes };
    expect(plansEqual(samplePlan, otherRoot)).toBe(false);
  });

  it("B7 C-06 — datasetsOf returns sorted unique scan datasets", () => {
    expect(datasetsOf(samplePlan)).toEqual([
      "ri.tellus.main.dataset.alpha",
      "ri.tellus.main.dataset.beta",
    ]);
  });

  it("B7 C-06 — datasetsOf dedupes when same dataset is scanned twice", () => {
    const plan: CalcitePlan = {
      root: "j1",
      nodes: [
        { kind: "scan", id: "s1", datasetRid: "ri.tellus.main.dataset.x", columns: ["a"] },
        { kind: "scan", id: "s2", datasetRid: "ri.tellus.main.dataset.x", columns: ["b"] },
        { kind: "join", id: "j1", left: "s1", right: "s2", on: [], type: "inner" },
      ],
    };
    expect(datasetsOf(plan)).toEqual(["ri.tellus.main.dataset.x"]);
  });
});
