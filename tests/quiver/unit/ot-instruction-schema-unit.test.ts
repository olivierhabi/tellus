// OT instruction write schema == read schema (types.ts AnalysisDocument).
//
// Regression guard for the write/read divergence where the OT write path
// accepted loose card ids/types/canvas shapes, poisoned quiver_analysis
// rows, and bricked folder listings (AnalysisDocument.parse 500s).
// The strictness is the point — do NOT loosen these schemas.
import { describe, expect, it } from "vitest";
import { instructionListSchema } from "../../../src/services/quiver/ot/instructions";
import { Card as CardWireSchema } from "../../../src/services/quiver/types";

const validCard = {
  id: "$A",
  type: "OBJECT_SET",
  inputs: {},
  config: {},
  hidden: false,
};

function rejects(instr: unknown): void {
  const r = instructionListSchema.safeParse([instr]);
  expect(r.success).toBe(false);
}

function accepts(instr: unknown): void {
  const r = instructionListSchema.safeParse([instr]);
  expect(r.success).toBe(true);
}

describe("addCard — id/type/inputs must equal the read schema", () => {
  it("accepts a valid card", () => {
    accepts({ kind: "addCard", card: validCard });
  });

  it("accepted card parses as the read-side Card (write == read)", () => {
    const r = instructionListSchema.safeParse([
      { kind: "addCard", card: { ...validCard, inputs: { src: "$B" }, displayName: "x" } },
    ]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(CardWireSchema.safeParse((r.data[0] as { card: unknown }).card).success).toBe(true);
    }
  });

  it("rejects non-$ ids: 'c1', '', '$a', '$A1', '__proto__'", () => {
    for (const id of ["c1", "", "$a", "$A1", "__proto__"]) {
      rejects({ kind: "addCard", card: { ...validCard, id } });
    }
  });

  it("rejects non-registry types: 'metric', 'object_set', ''", () => {
    for (const type of ["metric", "object_set", ""]) {
      rejects({ kind: "addCard", card: { ...validCard, type } });
    }
  });

  it("rejects inputs whose values are not CardIds (read schema: record<string, CardId>)", () => {
    rejects({
      kind: "addCard",
      card: { ...validCard, inputs: { src: "card-1" } },
    });
    accepts({
      kind: "addCard",
      card: { ...validCard, inputs: { src: "$B" } },
    });
  });
});

describe("updateParameter — parameterId must be a CardId", () => {
  it("rejects '__proto__', 'p1', ''", () => {
    for (const parameterId of ["__proto__", "p1", ""]) {
      rejects({ kind: "updateParameter", parameterId, valueJson: 1 });
    }
  });

  it("accepts a $-prefixed id", () => {
    accepts({ kind: "updateParameter", parameterId: "$P", valueJson: 1 });
  });
});

describe("canvas — placements/ordering must equal the stored Canvas shape", () => {
  it("rejects the legacy record-form placements (write shape == stored shape)", () => {
    rejects({
      kind: "addCanvas",
      canvas: {
        id: "cv1",
        name: "C",
        ordering: [],
        placements: { $A: { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } } },
      },
    });
  });

  it("accepts array-form placements ({cardId,x,y,w,h})", () => {
    accepts({
      kind: "addCanvas",
      canvas: {
        id: "cv1",
        name: "C",
        ordering: ["$A"],
        placements: [{ cardId: "$A", x: 0, y: 0, w: 320, h: 200 }],
      },
    });
  });

  it("rejects placement entries with a non-CardId cardId or missing w/h", () => {
    rejects({
      kind: "addCanvas",
      canvas: {
        id: "cv1",
        name: "C",
        ordering: [],
        placements: [{ cardId: "c1", x: 0, y: 0, w: 320, h: 200 }],
      },
    });
    rejects({
      kind: "addCanvas",
      canvas: {
        id: "cv1",
        name: "C",
        ordering: [],
        placements: [{ cardId: "$A", x: 0, y: 0 }],
      },
    });
  });

  it("rejects loose ordering ids on addCanvas and reorderCanvasCards", () => {
    rejects({
      kind: "addCanvas",
      canvas: { id: "cv1", name: "C", ordering: ["c1"], placements: [] },
    });
    accepts({
      kind: "reorderCanvasCards",
      canvasId: "cv1",
      ordering: ["$A"],
    });
    rejects({ kind: "reorderCanvasCards", canvasId: "cv1", ordering: ["c1"] });
  });
});

describe("instruction cardId/canvasId/sourceCardId fields", () => {
  it("rejects loose cardId on deleteCard / setHidden / placeCardOnCanvas", () => {
    rejects({ kind: "deleteCard", cardId: "card-1" });
    rejects({ kind: "setHidden", cardId: "card-1", hidden: true });
    rejects({
      kind: "placeCardOnCanvas",
      cardId: "card-1",
      canvasId: "cv1",
      position: { x: 0, y: 0 },
      size: { width: 10, height: 10 },
    });
  });

  it("rejects loose sourceCardId on bindInput", () => {
    rejects({ kind: "bindInput", cardId: "$A", slot: "in", sourceCardId: "src-1" });
    accepts({ kind: "bindInput", cardId: "$A", slot: "in", sourceCardId: "$B" });
  });

  it("rejects empty canvasId (deleteCanvas / renameCanvas)", () => {
    rejects({ kind: "deleteCanvas", canvasId: "" });
    rejects({ kind: "renameCanvas", canvasId: "", name: "x" });
  });
});
