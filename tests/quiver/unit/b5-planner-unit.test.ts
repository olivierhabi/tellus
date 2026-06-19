/**
 * B5 — Planner unit tests.
 *
 * Contracts covered:
 *   B5 C-02 — Planner returns upstream subgraph in topo order, deduplicated;
 *             on cycle → CyclicDagError.
 */

import { describe, it, expect } from "vitest";
import { planSubgraph, CyclicDagError, UnknownCardError, upstreamOf } from "../../../src/services/quiver/compute/planner";

function doc(cards: Record<string, any>): any {
  return { cards };
}

describe("B5 C-02: planSubgraph", () => {
  it("returns target alone when no upstream", () => {
    const d = doc({ $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {} } });
    const plan = planSubgraph(d, "$A");
    expect(plan.map((n) => n.cardId)).toEqual(["$A"]);
    expect(plan[0].cardType).toBe("OBJECT_SET");
  });

  it("returns upstream + target in topological order", () => {
    const d = doc({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {} },
      $B: { id: "$B", type: "FILTER_OBJECT_SET", inputs: { src: "$A", predicate: "$P" }, config: {} },
      $P: { id: "$P", type: "BOOLEAN_FORMULA", inputs: {}, config: {} },
    });
    const plan = planSubgraph(d, "$B").map((n) => n.cardId);
    // $B must be last, $A and $P must precede.
    expect(plan[plan.length - 1]).toBe("$B");
    expect(plan.includes("$A")).toBe(true);
    expect(plan.includes("$P")).toBe(true);
  });

  it("deduplicates shared upstream", () => {
    const d = doc({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {} },
      $B: { id: "$B", type: "FILTER_OBJECT_SET", inputs: { src: "$A", predicate: "$P" }, config: {} },
      $C: { id: "$C", type: "FILTER_OBJECT_SET", inputs: { src: "$A", predicate: "$P" }, config: {} },
      $D: { id: "$D", type: "AGGREGATION", inputs: { src: "$B", group: "$G", agg: "$AG" }, config: {} },
      $P: { id: "$P", type: "BOOLEAN_FORMULA", inputs: {}, config: {} },
      $G: { id: "$G", type: "EXPRESSION", inputs: {}, config: {} },
      $AG: { id: "$AG", type: "EXPRESSION", inputs: {}, config: {} },
    });
    const plan = planSubgraph(d, "$D").map((n) => n.cardId);
    const unique = new Set(plan);
    expect(unique.size).toBe(plan.length);
  });

  it("throws CyclicDagError on back-edge", () => {
    // $A -> $B -> $A forced cycle.
    const d = doc({
      $A: { id: "$A", type: "EXPRESSION", inputs: { x: "$B" }, config: {} },
      $B: { id: "$B", type: "EXPRESSION", inputs: { x: "$A" }, config: {} },
    });
    expect(() => planSubgraph(d, "$A")).toThrow(CyclicDagError);
  });

  it("throws UnknownCardError when target missing", () => {
    expect(() => planSubgraph(doc({}), "$X")).toThrow(UnknownCardError);
  });

  it("upstreamOf returns deduplicated string CardIds", () => {
    const card = { inputs: { a: "$X", b: "$X", c: "$Y", d: "" } };
    expect(upstreamOf(card)).toEqual(["$X", "$Y"]);
  });
});
