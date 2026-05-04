// Quiver B4 — DocumentDiff unit tests.
// Coverage:
//   B4 C-06: computeDiff returns added/removed/modified card lists +
//            per-card config JSON Patch (RFC 6902); symmetric & stable.

import { describe, expect, it } from "vitest";
import { computeDiff, jsonPatch } from "../../../src/services/quiver/diff";
import type { AnalysisDocument, Card } from "../../../src/services/quiver/types";

const c = (id: string, type: string, config: Record<string, unknown> = {}, inputs: Record<string, string> = {}): Card =>
  ({ id, type, config, inputs, hidden: false }) as Card;

const doc = (cards: Card[]): Pick<AnalysisDocument, "cards" | "canvases" | "parameters"> => ({
  cards: Object.fromEntries(cards.map((x) => [x.id, x])) as AnalysisDocument["cards"],
  canvases: [],
  parameters: {},
});

describe("computeDiff (B4 C-06)", () => {
  it("identical documents → no diff", () => {
    const a = doc([c("$A", "OBJECT_SET")]);
    const d = computeDiff(a, a);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("added card", () => {
    const a = doc([c("$A", "OBJECT_SET")]);
    const b = doc([c("$A", "OBJECT_SET"), c("$B", "FILTER_OBJECT_SET")]);
    expect(computeDiff(a, b).added).toEqual(["$B"]);
    expect(computeDiff(a, b).removed).toEqual([]);
  });

  it("removed card", () => {
    const a = doc([c("$A", "OBJECT_SET"), c("$B", "FILTER_OBJECT_SET")]);
    const b = doc([c("$A", "OBJECT_SET")]);
    expect(computeDiff(a, b).removed).toEqual(["$B"]);
    expect(computeDiff(a, b).added).toEqual([]);
  });

  it("modified card config emits JSON Patch ops", () => {
    const a = doc([c("$A", "OBJECT_SET", { a: 1, b: 2 })]);
    const b = doc([c("$A", "OBJECT_SET", { a: 1, b: 3, c: 4 })]);
    const d = computeDiff(a, b);
    expect(d.modified).toHaveLength(1);
    const ops = d.modified[0].configPatch;
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/c", value: 4 },
        { op: "replace", path: "/b", value: 3 },
      ]),
    );
  });

  it("type change is flagged", () => {
    const a = doc([c("$A", "OBJECT_SET")]);
    const b = doc([c("$A", "FILTER_OBJECT_SET")]);
    const d = computeDiff(a, b);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0].typeChanged).toBe(true);
  });

  it("inputs change is flagged", () => {
    const a = doc([c("$X", "OBJECT_SET"), c("$A", "FILTER_OBJECT_SET", {}, { src: "$X" })]);
    const b = doc([c("$X", "OBJECT_SET"), c("$A", "FILTER_OBJECT_SET", {}, { src: "$X", predicate: "$X" })]);
    const d = computeDiff(a, b);
    const mod = d.modified.find((m) => m.cardId === "$A")!;
    expect(mod.inputsChanged).toBe(true);
  });

  it("symmetric: add(a→b) ≡ remove(b→a) cardinality", () => {
    const a = doc([c("$A", "OBJECT_SET"), c("$B", "OBJECT_SET")]);
    const b = doc([c("$B", "OBJECT_SET"), c("$C", "OBJECT_SET")]);
    const ab = computeDiff(a, b);
    const ba = computeDiff(b, a);
    expect(ab.added.sort()).toEqual(ba.removed.sort());
    expect(ab.removed.sort()).toEqual(ba.added.sort());
  });

  it("stable: two calls produce identical output", () => {
    const a = doc([c("$X", "OBJECT_SET"), c("$Y", "FILTER_OBJECT_SET", { p: 1 }, { src: "$X" })]);
    const b = doc([c("$X", "OBJECT_SET"), c("$Y", "FILTER_OBJECT_SET", { p: 2 }, { src: "$X" })]);
    expect(JSON.stringify(computeDiff(a, b))).toBe(JSON.stringify(computeDiff(a, b)));
  });

  it("canvases / parameters change flags", () => {
    const a = { cards: {} as AnalysisDocument["cards"], canvases: [], parameters: {} };
    const b = {
      cards: {} as AnalysisDocument["cards"],
      canvases: [{ id: "c1", name: "n", placements: [], ordering: [] }],
      parameters: { p: { kind: "STRING" } as never },
    };
    const d = computeDiff(a as never, b as never);
    expect(d.canvasesChanged).toBe(true);
    expect(d.parametersChanged).toBe(true);
  });
});

describe("jsonPatch primitives (B4 C-06)", () => {
  it("scalar replace emits one op", () => {
    expect(jsonPatch(1, 2)).toEqual([{ op: "replace", path: "/", value: 2 }]);
  });
  it("array replace emits one op (no element-wise diff)", () => {
    expect(jsonPatch([1, 2], [1, 2, 3])).toEqual([
      { op: "replace", path: "/", value: [1, 2, 3] },
    ]);
  });
  it("object key add/remove/replace emit individual ops", () => {
    const ops = jsonPatch({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: "replace", path: "/b", value: 3 },
        { op: "add", path: "/c", value: 4 },
        { op: "remove", path: "/a" },
      ]),
    );
  });
  it("escapes ~ and / in JSON Pointer", () => {
    const ops = jsonPatch({}, { "a/b": 1, "c~d": 2 });
    expect(ops.map((o) => o.path).sort()).toEqual(["/a~1b", "/c~0d"]);
  });
});
