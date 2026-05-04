// Quiver B2 — Card Type Registry unit tests.
//
// Coverage:
//   B2 C-01: Card / CardType / OutputType / InputSlot / Dag types exist as
//            TS discriminated unions (compile-time + runtime presence).
//   B2 C-02: registry has exactly 26 entries (locked golden file).
//   B2 C-04: covariance — OBJECT_SET acceptable wherever TRANSFORM_TABLE.
//   B2 C-18: registry types match `tasks/quiver/registry-fixture.md`.

import { describe, expect, it } from "vitest";
import {
  assertRegistryIntegrity,
  getCardType,
  isOutputAcceptable,
  listCardTypes,
  buildDag,
  type Dag,
} from "../../../src/services/quiver/dag";
import {
  CARD_TYPES,
  type Card,
  type CardType,
  type OutputType,
} from "../../../src/services/quiver/types";

describe("B2 C-01: discriminated-union types", () => {
  it("Card / CardType / OutputType / Dag types are present and well-formed", () => {
    // Compile-time: presence is asserted by import. Runtime: ensure the
    // CARD_TYPES union and a sample Card / Dag value round-trip cleanly.
    const cardType: CardType = "OBJECT_SET";
    const card: Card = { id: "$A", type: cardType, config: {}, inputs: {}, hidden: false };
    const dag: Dag = buildDag({ $A: card });
    expect(dag.has("$A")).toBe(true);
    // Output type discriminant is a string union; the registry's output
    // field for OBJECT_SET must be exactly "OBJECT_SET".
    const out: OutputType | "ANY" = getCardType("OBJECT_SET")!.output;
    expect(out).toBe("OBJECT_SET");
  });
});

describe("Card Type Registry (B2 C-02 / C-18)", () => {
  it("B2 C-02: registry has exactly 26 entries", () => {
    expect(listCardTypes().length).toBe(26);
    expect(() => assertRegistryIntegrity()).not.toThrow();
  });

  it("B2 C-02: every CARD_TYPES entry has a registry entry", () => {
    for (const t of CARD_TYPES) {
      expect(getCardType(t), `missing entry for ${t}`).toBeDefined();
    }
  });

  it("B2 C-02: registry entries' types match CARD_TYPES exactly (no extras)", () => {
    const inRegistry = listCardTypes().map((e) => e.type).sort();
    const inEnum = [...CARD_TYPES].sort();
    expect(inRegistry).toEqual(inEnum);
  });
});

describe("Type covariance (B2 C-04)", () => {
  it("OBJECT_SET is acceptable where TRANSFORM_TABLE is", () => {
    expect(isOutputAcceptable("OBJECT_SET", ["TRANSFORM_TABLE"])).toBe(true);
  });
  it("MATERIALIZATION is acceptable where TRANSFORM_TABLE is", () => {
    expect(isOutputAcceptable("MATERIALIZATION", ["TRANSFORM_TABLE"])).toBe(
      true,
    );
  });
  it("TRANSFORM_TABLE is NOT acceptable where OBJECT_SET is required", () => {
    expect(isOutputAcceptable("TRANSFORM_TABLE", ["OBJECT_SET"])).toBe(false);
  });
  it("ANY upstream matches anything", () => {
    expect(isOutputAcceptable("ANY", ["NUMBER"])).toBe(true);
  });
  it("STRING does not match NUMBER", () => {
    expect(isOutputAcceptable("STRING", ["NUMBER"])).toBe(false);
  });
});
