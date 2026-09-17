// B3 — pure applyInstruction unit tests.
// C-07 (tombstone), C-09 (no-op when card_not_found), apply semantics.
import { describe, it, expect } from "vitest";
import { applyInstruction, applyJsonPatch, type OtDocument } from "../../../src/services/quiver/ot/apply";
import type { Instruction } from "../../../src/services/quiver/ot/instructions";

function emptyDoc(): OtDocument {
  return { cards: {}, canvases: {}, parameters: {} };
}

describe("B3 apply — addCard / updateCardConfig", () => {
  it("adds a card", () => {
    const doc = emptyDoc();
    const r = applyInstruction(
      doc,
      { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
      new Set(),
    );
    expect(r.applied).toBe(true);
    expect((r.doc.cards as any)["$A"].id).toBe("$A");
  });

  it("updateCardConfig applies RFC-6902 add", () => {
    let doc = emptyDoc();
    doc = applyInstruction(
      doc,
      { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
      new Set(),
    ).doc;
    const r = applyInstruction(
      doc,
      {
        kind: "updateCardConfig",
        cardId: "$A",
        configJsonPatch: [{ op: "add", path: "/objectSetRid", value: "ri.oss.main.os.x" }],
      } as Instruction,
      new Set(),
    );
    expect(r.applied).toBe(true);
    expect((r.doc.cards as any)["$A"].config.objectSetRid).toBe("ri.oss.main.os.x");
  });

  it("update on missing card → card_not_found, applied=false", () => {
    const r = applyInstruction(
      emptyDoc(),
      {
        kind: "updateCardConfig",
        cardId: "$MISSING",
        configJsonPatch: [{ op: "add", path: "/x", value: 1 }],
      } as Instruction,
      new Set(),
    );
    expect(r.applied).toBe(false);
    expect(r.dropReason).toBe("card_not_found");
  });
});

describe("B3 C-07 — tombstone semantics", () => {
  it("deleteCard tombstones; subsequent updates dropped silently", () => {
    let doc = emptyDoc();
    const tomb = new Set<string>();
    doc = applyInstruction(
      doc,
      { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
      tomb,
    ).doc;
    doc = applyInstruction(doc, { kind: "deleteCard", cardId: "$A" } as Instruction, tomb).doc;
    expect(tomb.has("$A")).toBe(true);
    const r = applyInstruction(
      doc,
      {
        kind: "updateCardConfig",
        cardId: "$A",
        configJsonPatch: [{ op: "add", path: "/x", value: 1 }],
      } as Instruction,
      tomb,
    );
    expect(r.applied).toBe(false);
    expect(r.dropReason).toBe("tombstoned");
  });

  it("addCard reusing tombstoned id is dropped (B2 immutable id rule)", () => {
    const tomb = new Set<string>(["$A"]);
    const r = applyInstruction(
      emptyDoc(),
      { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
      tomb,
    );
    expect(r.applied).toBe(false);
    expect(r.dropReason).toBe("tombstoned");
  });
});

describe("B3 — RFC 6902 JsonPatch", () => {
  it("add at nested path creates intermediate objects", () => {
    const out = applyJsonPatch({}, [{ op: "add", path: "/a/b/c", value: 1 } as any]);
    expect(out).toEqual({ a: { b: { c: 1 } } });
  });
  it("remove deletes the leaf", () => {
    const out = applyJsonPatch({ a: 1, b: 2 }, [{ op: "remove", path: "/a" } as any]);
    expect(out).toEqual({ b: 2 });
  });
  it("test failure aborts the patch (atomic)", () => {
    const out = applyJsonPatch(
      { a: 1 },
      [
        { op: "test", path: "/a", value: 999 } as any,
        { op: "replace", path: "/a", value: 2 } as any,
      ],
    );
    expect(out).toEqual({ a: 1 });
  });
});
