// B3 C-10 — replay(rid, fromSeq=0) reproduces canonical document.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { applyInstruction, type OtDocument } from "../../../src/services/quiver/ot/apply";
import { replay } from "../../../src/services/quiver/ot/replay";
import type { Instruction } from "../../../src/services/quiver/ot/instructions";

function emptyDoc(): OtDocument {
  return { cards: {}, canvases: {}, parameters: {} };
}

function canonical(d: OtDocument): string {
  // Stable, sorted-keys JSON for deterministic SHA-256 (per spec etag rule).
  const sortedKeys = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortedKeys);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((o: any, k) => {
        o[k] = sortedKeys(v[k]);
        return o;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sortedKeys(d));
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("B3 C-10 — replay produces canonical document", () => {
  const ops: Instruction[] = [
    { kind: "addCard", card: { id: "c1", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
    { kind: "addCard", card: { id: "c2", type: "FILTER_OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
    { kind: "bindInput", cardId: "c2", slot: "in", sourceCardId: "c1" } as Instruction,
    { kind: "addCanvas", canvas: { id: "k1", name: "Main", ordering: [], placements: {} } } as Instruction,
    { kind: "placeCardOnCanvas", cardId: "c1", canvasId: "k1", position: { x: 0, y: 0 }, size: { width: 100, height: 100 } } as Instruction,
    { kind: "updateCardConfig", cardId: "c1", configJsonPatch: [{ op: "add", path: "/title", value: "Hello" }] } as Instruction,
    { kind: "deleteCard", cardId: "c2" } as Instruction,
  ];

  it("two replays produce byte-identical documents", () => {
    const a = replay(emptyDoc(), ops);
    const b = replay(emptyDoc(), ops);
    expect(sha(canonical(a.document))).toEqual(sha(canonical(b.document)));
    expect(a.appliedCount).toBe(b.appliedCount);
  });

  it("replay equals direct apply chain", () => {
    let doc = emptyDoc();
    const tomb = new Set<string>();
    for (const op of ops) doc = applyInstruction(doc, op, tomb).doc;
    const r = replay(emptyDoc(), ops);
    expect(sha(canonical(doc))).toEqual(sha(canonical(r.document)));
  });

  it("ops on tombstoned cards are dropped during replay", () => {
    const seq: Instruction[] = [
      ...ops,
      // updateCardConfig on already-deleted c2 → drop
      { kind: "updateCardConfig", cardId: "c2", configJsonPatch: [{ op: "add", path: "/x", value: 1 }] } as Instruction,
    ];
    const r = replay(emptyDoc(), seq);
    expect(r.tombstones.has("c2")).toBe(true);
    expect((r.document.cards as any).c2).toBeUndefined();
    expect(r.droppedCount).toBeGreaterThanOrEqual(1);
  });
});
