// B3 C-01, C-14 — instruction discriminated union; malformed → MalformedInstruction.
import { describe, it, expect } from "vitest";
import {
  instructionListSchema,
  INSTRUCTION_KINDS,
  type Instruction,
} from "../../../src/services/quiver/ot/instructions";

describe("B3 C-01 — instruction discriminated union (13 variants)", () => {
  it("INSTRUCTION_KINDS covers every spec §B3 kind", () => {
    expect(INSTRUCTION_KINDS).toEqual([
      "addCard",
      "updateCardConfig",
      "bindInput",
      "unbindInput",
      "deleteCard",
      "addCanvas",
      "deleteCanvas",
      "renameCanvas",
      "placeCardOnCanvas",
      "removeCardFromCanvas",
      "reorderCanvasCards",
      "updateParameter",
      "setHidden",
    ]);
  });

  it("accepts a well-formed list of all kinds", () => {
    const list: Instruction[] = [
      { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
      { kind: "updateCardConfig", cardId: "$A", configJsonPatch: [{ op: "add", path: "/x", value: 1 }] },
      { kind: "bindInput", cardId: "$B", slot: "in", sourceCardId: "$A" },
      { kind: "unbindInput", cardId: "$B", slot: "in" },
      { kind: "deleteCard", cardId: "$C" },
      { kind: "addCanvas", canvas: { id: "k1", name: "Main", ordering: [], placements: [] } },
      { kind: "deleteCanvas", canvasId: "k1" },
      { kind: "renameCanvas", canvasId: "k1", name: "x" },
      { kind: "placeCardOnCanvas", cardId: "$A", canvasId: "k1", position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
      { kind: "removeCardFromCanvas", cardId: "$A", canvasId: "k1" },
      { kind: "reorderCanvasCards", canvasId: "k1", ordering: ["$A"] },
      { kind: "updateParameter", parameterId: "$P", valueJson: { v: 1 } },
      { kind: "setHidden", cardId: "$A", hidden: true },
    ];
    const r = instructionListSchema.safeParse(list);
    expect(r.success).toBe(true);
  });
});

describe("B3 C-14 — malformed instructions rejected", () => {
  it("rejects unknown kind", () => {
    const r = instructionListSchema.safeParse([{ kind: "fooBar" }]);
    expect(r.success).toBe(false);
  });
  it("rejects missing required field", () => {
    const r = instructionListSchema.safeParse([{ kind: "deleteCard" }]);
    expect(r.success).toBe(false);
  });
  it("rejects empty cardId", () => {
    const r = instructionListSchema.safeParse([{ kind: "deleteCard", cardId: "" }]);
    expect(r.success).toBe(false);
  });
  it("rejects non-integer position", () => {
    const r = instructionListSchema.safeParse([
      {
        kind: "placeCardOnCanvas",
        cardId: "$A",
        canvasId: "k1",
        position: { x: 0.5, y: 0 },
        size: { width: 100, height: 100 },
      },
    ]);
    expect(r.success).toBe(false);
  });
});
