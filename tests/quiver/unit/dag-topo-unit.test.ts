// Quiver B2 — topo / cycle / pruning tests.
//
// Coverage:
//   B2 C-05: cycle detected; CYCLIC_DAG envelope with parameters.cyclePath.
//   B2 C-11: topologicalOrder is deterministic for identical input.
//   B2 C-12: pruneUnreferencedCards reachability.
//   B2 C-17: cycle detection runs on the *definition* graph.

import { describe, expect, it } from "vitest";
import {
  buildDag,
  pruneUnreferencedCards,
  topologicalOrder,
} from "../../../src/services/quiver/dag/topo";
import type { Card } from "../../../src/services/quiver/types";
import { isQuiverError } from "../../../src/services/quiver/errors";

function card(id: string, type: string, inputs: Record<string, string> = {}): Card {
  return {
    id: id as Card["id"],
    type: type as Card["type"],
    config: {},
    inputs: inputs as unknown as Card["inputs"],
    hidden: false,
  };
}

describe("topologicalOrder (B2 C-05 / C-11 / C-17)", () => {
  it("B2 C-11: stable across calls for identical inputs", () => {
    const cards: Record<string, Card> = {
      $A: card("$A", "OBJECT_SET"),
      $B: card("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$D" }),
      $C: card("$C", "AGGREGATION", { src: "$B" }),
      $D: card("$D", "BOOLEAN_FORMULA"),
    };
    const dag = buildDag(cards);
    const a = topologicalOrder(dag);
    const b = topologicalOrder(dag);
    expect(a).toEqual(b);
    // Roots ($A, $D) come before $B which comes before $C.
    expect(a.indexOf("$A")).toBeLessThan(a.indexOf("$B"));
    expect(a.indexOf("$D")).toBeLessThan(a.indexOf("$B"));
    expect(a.indexOf("$B")).toBeLessThan(a.indexOf("$C"));
  });

  it("B2 C-05 / C-17: cycle on definition graph throws CyclicDag with cyclePath", () => {
    const cards: Record<string, Card> = {
      $A: card("$A", "FILTER_OBJECT_SET", { src: "$B" }),
      $B: card("$B", "FILTER_OBJECT_SET", { src: "$A" }),
    };
    const dag = buildDag(cards);
    try {
      topologicalOrder(dag);
      throw new Error("expected throw");
    } catch (e) {
      expect(isQuiverError(e)).toBe(true);
      if (isQuiverError(e)) {
        expect(e.envelope.errorName).toBe("Tellus:Quiver:CyclicDag");
        expect(Array.isArray(e.envelope.parameters.cyclePath)).toBe(true);
      }
    }
  });

  it("B2 C-05: self-loop is rejected at buildDag", () => {
    const cards: Record<string, Card> = {
      $A: card("$A", "FILTER_OBJECT_SET", { src: "$A" }),
    };
    expect(() => buildDag(cards)).toThrow(/Tellus:Quiver:CyclicDag/);
  });
});

describe("pruneUnreferencedCards (B2 C-12)", () => {
  it("returns ids unreachable from any retained root", () => {
    const cards: Record<string, Card> = {
      $A: card("$A", "OBJECT_SET"),
      $B: card("$B", "FILTER_OBJECT_SET", { src: "$A" }),
      $C: card("$C", "OBJECT_SET"), // orphan — not reachable from $B root
    };
    const dag = buildDag(cards);
    expect(pruneUnreferencedCards(dag, ["$B"])).toEqual(["$C"]);
  });

  it("empty when all cards reach a root", () => {
    const cards: Record<string, Card> = {
      $A: card("$A", "OBJECT_SET"),
      $B: card("$B", "FILTER_OBJECT_SET", { src: "$A" }),
    };
    const dag = buildDag(cards);
    expect(pruneUnreferencedCards(dag, ["$B"])).toEqual([]);
  });
});
