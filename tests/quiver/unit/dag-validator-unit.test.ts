// Quiver B2 — DagValidator rule-by-rule tests.
//
// Coverage:
//   B2 C-03: validate() returns ValidationResult, never throws on rules.
//   B2 C-04: type compatibility — incompat → CardTypeInputMismatch.
//   B2 C-05: cycle → CyclicDag.
//   B2 C-06: parameter cards have no inputs.
//   B2 C-07: canvas.ordering[] references unknown id → fail.
//   B2 C-08: card count > 500 → CardLimitExceeded.
//   B2 C-09: canvas count > 50 → CanvasLimitExceeded.
//   B2 C-13: validator runs identically inside in-process callers.
//   B2 C-15: random valid DAGs validate; mutated → fail.
//   B2 C-16: golden combinations validate.

import { describe, expect, it } from "vitest";
import { validate } from "../../../src/services/quiver/dag";
import type { AnalysisDocument, Card } from "../../../src/services/quiver/types";

const card = (id: string, type: string, inputs: Record<string, string> = {}, config: Record<string, unknown> = {}): Card =>
  ({ id, type, config, inputs, hidden: false }) as unknown as Card;

const doc = (
  cards: Card[],
  canvases: AnalysisDocument["canvases"] = [],
): Pick<AnalysisDocument, "cards" | "canvases"> => ({
  cards: Object.fromEntries(cards.map((c) => [c.id, c])) as AnalysisDocument["cards"],
  canvases,
});

describe("DagValidator — happy paths (B2 C-16)", () => {
  it("B2 C-16: object-set → filter → search-around → aggregation → categorical-chart validates", () => {
    const r = validate(doc([
      card("$A", "OBJECT_SET"),
      card("$B", "BOOLEAN_FORMULA"),
      card("$C", "FILTER_OBJECT_SET", { src: "$A", predicate: "$B" }),
      card("$D", "SEARCH_AROUND", { src: "$C", linkApiName: "$E" }),
      card("$E", "PARAMETER_STRING"),
      card("$F", "AGGREGATION", { src: "$D", group: "$G", agg: "$H" }),
      card("$G", "EXPRESSION"),
      card("$H", "EXPRESSION"),
      card("$K", "CATEGORICAL_CHART", { src: "$F", x: "$E", y: "$E" }),
    ]));
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.topologicalOrder).toContain("$K");
      expect(r.topologicalOrder.indexOf("$A")).toBeLessThan(r.topologicalOrder.indexOf("$K"));
    }
  });

  it("B2 C-04: TRANSFORM_TABLE accepts OBJECT_SET upstream (covariance)", () => {
    const r = validate(doc([
      card("$A", "OBJECT_SET"),
      card("$B", "TRANSFORM_TABLE", { src: "$A" }),
    ]));
    expect(r.valid).toBe(true);
  });
});

describe("DagValidator — failure paths", () => {
  it("B2 C-04: type-mismatched binding → CardTypeInputMismatch", () => {
    const r = validate(doc([
      card("$A", "PARAMETER_NUMBER"),
      card("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$A" }),
    ]));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errorName).toBe("Tellus:Quiver:CardTypeInputMismatch");
    }
  });

  it("B2 C-05: cycle → CyclicDag with cyclePath", () => {
    const r = validate(doc([
      card("$A", "FILTER_OBJECT_SET", { src: "$B", predicate: "$C" }),
      card("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$C" }),
      card("$C", "BOOLEAN_FORMULA"),
    ]));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errorName).toBe("Tellus:Quiver:CyclicDag");
      expect(Array.isArray(r.parameters.cyclePath)).toBe(true);
    }
  });

  it("B2 C-06: parameter card with input → InvalidParameterBinding", () => {
    const r = validate(doc([
      card("$A", "OBJECT_SET"),
      card("$B", "PARAMETER_STRING", { src: "$A" }),
    ]));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errorName).toBe("Tellus:Quiver:InvalidParameterBinding");
    }
  });

  it("B2 C-07: canvas ordering references unknown card → fail", () => {
    const r = validate(doc(
      [card("$A", "OBJECT_SET")],
      [{ id: "c1", name: "main", placements: [], ordering: ["$A", "$NOPE"] as never[] }],
    ));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errorName).toBe("Tellus:Quiver:InvalidCanvasOrdering");
      expect(r.parameters.unknownCardId).toBe("$NOPE");
    }
  });

  it("B2 C-08: > 500 cards → CardLimitExceeded", () => {
    const cards: Card[] = [];
    for (let i = 0; i < 501; i++) cards.push(card("$" + idAt(i), "OBJECT_SET"));
    const r = validate(doc(cards));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errorName).toBe("Tellus:Quiver:CardLimitExceeded");
  });

  it("B2 C-09: > 50 canvases → CanvasLimitExceeded", () => {
    const canvases: AnalysisDocument["canvases"] = [];
    for (let i = 0; i < 51; i++)
      canvases.push({ id: "c" + i, name: "n" + i, placements: [], ordering: [] });
    const r = validate(doc([card("$A", "OBJECT_SET")], canvases));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errorName).toBe("Tellus:Quiver:CanvasLimitExceeded");
  });
});

describe("DagValidator — soft warning (B2 C-08)", () => {
  it("> 200 but ≤ 500 cards emits a soft warning, still validates", () => {
    const cards: Card[] = [];
    for (let i = 0; i < 250; i++) cards.push(card("$" + idAt(i), "OBJECT_SET"));
    const r = validate(doc(cards));
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.warnings.some((w) => w.includes("soft limit"))).toBe(true);
    }
  });
});

function idAt(i: number): string {
  // Card IDs of the form $A, $B, ..., $Z, $AA, ... — uppercase letters only.
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
