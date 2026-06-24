// Quiver B2 C-12 — pruneUnreferencedCards reachability test.

import { describe, expect, it } from "vitest";
import { buildDag, pruneUnreferencedCards } from "../../../src/services/quiver/dag";
import type { Card } from "../../../src/services/quiver/types";

const c = (id: string, type: string, inputs: Record<string, string> = {}): Card =>
  ({ id, type, config: {}, inputs, hidden: false }) as Card;

describe("pruneUnreferencedCards — B2 C-12", () => {
  it("returns orphan cards not reachable from retainedRoots", () => {
    const cards = {
      $A: c("$A", "OBJECT_SET"),
      $B: c("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P" }),
      $P: c("$P", "BOOLEAN_FORMULA"),
      // $X / $Y are orphans relative to retainedRoot=$B.
      $X: c("$X", "OBJECT_SET"),
      $Y: c("$Y", "FILTER_OBJECT_SET", { src: "$X", predicate: "$P" }),
    };
    const dag = buildDag(cards);
    const orphans = pruneUnreferencedCards(dag, ["$B"]);
    expect(orphans.sort()).toEqual(["$X", "$Y"]);
  });

  it("returns empty list when every card is reachable", () => {
    const cards = {
      $A: c("$A", "OBJECT_SET"),
      $B: c("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P" }),
      $P: c("$P", "BOOLEAN_FORMULA"),
    };
    const dag = buildDag(cards);
    expect(pruneUnreferencedCards(dag, ["$B"])).toEqual([]);
  });

  it("multiple retainedRoots union reachability", () => {
    const cards = {
      $A: c("$A", "OBJECT_SET"),
      $B: c("$B", "OBJECT_SET"),
      $X: c("$X", "OBJECT_SET"),
      $C: c("$C", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P" }),
      $D: c("$D", "FILTER_OBJECT_SET", { src: "$B", predicate: "$P" }),
      $P: c("$P", "BOOLEAN_FORMULA"),
    };
    const dag = buildDag(cards);
    expect(pruneUnreferencedCards(dag, ["$C", "$D"])).toEqual(["$X"]);
  });
});
