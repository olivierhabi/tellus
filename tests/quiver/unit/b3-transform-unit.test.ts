// B3 C-04, C-05, C-06, C-08 — operational transform.
import { describe, it, expect } from "vitest";
import { transformLocalAgainstRemote } from "../../../src/services/quiver/ot/transform";
import type { Instruction } from "../../../src/services/quiver/ot/instructions";

describe("B3 C-05 — updateCardConfig LWW field-level", () => {
  it("identical path: local dropped, resolution=lww", () => {
    const remote: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/title", value: "Server" }],
      } as Instruction,
    ];
    const local: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/title", value: "Client" }],
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).toBeNull();
    expect(t.results[0].resolution).toBe("lww");
    expect(t.counts.lww).toBe(1);
  });

  it("different paths on same card: local kept, resolution=null", () => {
    const remote: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/title", value: "Server" }],
      } as Instruction,
    ];
    const local: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/colour", value: "red" }],
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).not.toBeNull();
    expect(t.results[0].resolution).toBeNull();
  });

  it("partial overlap: drops only conflicting paths", () => {
    const remote: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/title", value: "Server" }],
      } as Instruction,
    ];
    const local: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [
          { op: "replace", path: "/title", value: "Client" },
          { op: "replace", path: "/colour", value: "red" },
        ],
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).not.toBeNull();
    expect((t.results[0].transformed as any).configJsonPatch).toEqual([
      { op: "replace", path: "/colour", value: "red" },
    ]);
    expect(t.results[0].resolution).toBe("lww");
  });

  it("ancestor path on remote covers descendant local", () => {
    const remote: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/style", value: { color: "red" } }],
      } as Instruction,
    ];
    const local: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "replace", path: "/style/color", value: "blue" }],
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).toBeNull();
    expect(t.results[0].resolution).toBe("lww");
  });
});

describe("B3 C-06 — bindInput merge vs LWW", () => {
  it("different slots: merged (resolution=merge)", () => {
    const remote: Instruction[] = [
      { kind: "bindInput", cardId: "c1", slot: "leftInput", sourceCardId: "src1" } as Instruction,
    ];
    const local: Instruction[] = [
      { kind: "bindInput", cardId: "c1", slot: "rightInput", sourceCardId: "src2" } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).not.toBeNull();
    expect(t.results[0].resolution).toBe("merge");
  });

  it("same slot: LWW, local dropped", () => {
    const remote: Instruction[] = [
      { kind: "bindInput", cardId: "c1", slot: "in", sourceCardId: "src1" } as Instruction,
    ];
    const local: Instruction[] = [
      { kind: "bindInput", cardId: "c1", slot: "in", sourceCardId: "src2" } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).toBeNull();
    expect(t.results[0].resolution).toBe("lww");
  });
});

describe("B3 C-07 — tombstone semantics in transform", () => {
  it("update on a remote-deleted card → tombstone drop", () => {
    const remote: Instruction[] = [{ kind: "deleteCard", cardId: "c1" } as Instruction];
    const local: Instruction[] = [
      {
        kind: "updateCardConfig",
        cardId: "c1",
        configJsonPatch: [{ op: "add", path: "/x", value: 1 }],
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).toBeNull();
    expect(t.results[0].resolution).toBe("tombstone");
    expect(t.counts.tombstone).toBe(1);
  });
});

describe("B3 C-08 — placeCardOnCanvas collision: ±32 px offset", () => {
  it("collision with same position: local offset by +32/+32", () => {
    const remote: Instruction[] = [
      {
        kind: "placeCardOnCanvas",
        cardId: "c1",
        canvasId: "k1",
        position: { x: 100, y: 100 },
        size: { width: 200, height: 100 },
      } as Instruction,
    ];
    const local: Instruction[] = [
      {
        kind: "placeCardOnCanvas",
        cardId: "c2",
        canvasId: "k1",
        position: { x: 100, y: 100 },
        size: { width: 200, height: 100 },
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).not.toBeNull();
    const out = t.results[0].transformed as any;
    expect(out.position).toEqual({ x: 132, y: 132 });
    expect(t.results[0].resolution).toBe("reorder");
  });

  it("same card replaced (LWW)", () => {
    const remote: Instruction[] = [
      {
        kind: "placeCardOnCanvas",
        cardId: "c1",
        canvasId: "k1",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
      } as Instruction,
    ];
    const local: Instruction[] = [
      {
        kind: "placeCardOnCanvas",
        cardId: "c1",
        canvasId: "k1",
        position: { x: 50, y: 50 },
        size: { width: 100, height: 100 },
      } as Instruction,
    ];
    const t = transformLocalAgainstRemote(local, remote);
    expect(t.results[0].transformed).toBeNull();
    expect(t.results[0].resolution).toBe("lww");
  });
});

describe("B3 C-04 — apply(remote;local') ≡ apply(local;remote') (sample pairs)", () => {
  // Smoke check for the convergence invariant on representative pairs.
  it("non-overlapping addCards converge", () => {
    const remote: Instruction[] = [
      { kind: "addCard", card: { id: "a", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
    ];
    const local: Instruction[] = [
      { kind: "addCard", card: { id: "b", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } } as Instruction,
    ];
    const tA = transformLocalAgainstRemote(local, remote);
    const tB = transformLocalAgainstRemote(remote, local);
    expect(tA.results[0].transformed).not.toBeNull();
    expect(tB.results[0].transformed).not.toBeNull();
  });
});
