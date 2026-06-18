// Quiver B2 C-16 — golden combinations.
//
// 30 common card combinations all validate; topologicalOrder is stable
// across two consecutive runs. Stability guards against accidental
// nondeterminism in Kahn's frontier ordering (C-11).

import { describe, expect, it } from "vitest";
import { validate } from "../../../src/services/quiver/dag";
import type { AnalysisDocument, Card } from "../../../src/services/quiver/types";

const c = (id: string, type: string, inputs: Record<string, string> = {}): Card =>
  ({ id, type, config: {}, inputs, hidden: false }) as Card;

const doc = (cards: Card[]): Pick<AnalysisDocument, "cards" | "canvases"> => ({
  cards: Object.fromEntries(cards.map((x) => [x.id, x])) as AnalysisDocument["cards"],
  canvases: [],
});

const COMBOS: Array<{ name: string; cards: Card[] }> = [
  { name: "1: object-set", cards: [c("$A", "OBJECT_SET")] },
  { name: "2: object-set + filter", cards: [c("$A", "OBJECT_SET"), c("$P", "BOOLEAN_FORMULA"), c("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P" })] },
  { name: "3: object-set → search-around", cards: [c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"), c("$B", "SEARCH_AROUND", { src: "$A", linkApiName: "$E" })] },
  { name: "4: object-set → transform-table", cards: [c("$A", "OBJECT_SET"), c("$T", "TRANSFORM_TABLE", { src: "$A" })] },
  { name: "5: object-set → materialization", cards: [c("$A", "OBJECT_SET"), c("$M", "MATERIALIZATION", { src: "$A" })] },
  { name: "6: object-set → pivot-table", cards: [c("$A", "OBJECT_SET"), c("$P", "PIVOT_TABLE", { src: "$A" })] },
  { name: "7: filter → aggregation → categorical-chart", cards: [
    c("$A", "OBJECT_SET"), c("$P", "BOOLEAN_FORMULA"),
    c("$B", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P" }),
    c("$G", "EXPRESSION"), c("$H", "EXPRESSION"),
    c("$F", "AGGREGATION", { src: "$B", group: "$G", agg: "$H" }),
    c("$E", "PARAMETER_STRING"),
    c("$K", "CATEGORICAL_CHART", { src: "$F", x: "$E", y: "$E" }),
  ] },
  { name: "8: time-series plot", cards: [c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"), c("$T", "TIME_SERIES_PLOT", { src: "$A", propertyApiName: "$E" })] },
  { name: "9: time-series rolling aggregate", cards: [
    c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"),
    c("$T", "TIME_SERIES_PLOT", { src: "$A", propertyApiName: "$E" }),
    c("$W", "EXPRESSION"), c("$O", "EXPRESSION"),
    c("$R", "ROLLING_AGGREGATE", { src: "$T", window: "$W", op: "$O" }),
  ] },
  { name: "10: event-set from time-series", cards: [
    c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"),
    c("$T", "TIME_SERIES_PLOT", { src: "$A", propertyApiName: "$E" }),
    c("$N", "PARAMETER_NUMBER"), c("$OP", "EXPRESSION"),
    c("$S", "EVENT_SET", { src: "$T", threshold: "$N", op: "$OP" }),
  ] },
  { name: "11: time-series chart from plots", cards: [
    c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"),
    c("$T", "TIME_SERIES_PLOT", { src: "$A", propertyApiName: "$E" }),
    c("$P", "EXPRESSION"),
    c("$C", "TIME_SERIES_CHART", { plots: "$P" }),
  ] },
  { name: "12: parameter cards stand alone", cards: [
    c("$1", "PARAMETER_STRING"), c("$2", "PARAMETER_NUMBER"),
    c("$3", "PARAMETER_BOOLEAN"), c("$4", "PARAMETER_DATETIME"),
  ] },
  { name: "13: vega plot", cards: [
    c("$A", "OBJECT_SET"), c("$S", "EXPRESSION"),
    c("$V", "VEGA_PLOT", { spec: "$S", data: "$A" }),
  ] },
  { name: "14: action button", cards: [
    c("$N", "PARAMETER_STRING"), c("$P", "EXPRESSION"),
    c("$B", "ACTION_BUTTON", { actionApiName: "$N", paramBindings: "$P" }),
  ] },
  { name: "15: function call", cards: [
    c("$R", "EXPRESSION"), c("$P", "EXPRESSION"),
    c("$F", "FUNCTION_CALL", { functionRid: "$R", paramBindings: "$P" }),
  ] },
  { name: "16: visual function call", cards: [
    c("$R", "EXPRESSION"), c("$P", "EXPRESSION"),
    c("$V", "VISUAL_FUNCTION_CALL", { visualFunctionRid: "$R", paramBindings: "$P" }),
  ] },
  { name: "17: property-value-select", cards: [
    c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"),
    c("$P", "PROPERTY_VALUE_SELECT", { src: "$A", propertyApiName: "$E" }),
  ] },
  { name: "18: numeric & boolean formula stand alone", cards: [c("$N", "NUMERIC_FORMULA"), c("$B", "BOOLEAN_FORMULA")] },
  { name: "19: time-series formula stand alone", cards: [c("$F", "TIME_SERIES_FORMULA")] },
  { name: "20: join materialization", cards: [
    c("$A", "OBJECT_SET"), c("$B", "OBJECT_SET"),
    c("$L", "MATERIALIZATION", { src: "$A" }),
    c("$R", "MATERIALIZATION", { src: "$B" }),
    c("$ON", "EXPRESSION"), c("$K", "EXPRESSION"),
    c("$J", "JOIN_MATERIALIZATION", { left: "$L", right: "$R", on: "$ON", kind: "$K" }),
  ] },
  { name: "21: filter chain (3 deep)", cards: [
    c("$A", "OBJECT_SET"), c("$P1", "BOOLEAN_FORMULA"), c("$P2", "BOOLEAN_FORMULA"), c("$P3", "BOOLEAN_FORMULA"),
    c("$F1", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P1" }),
    c("$F2", "FILTER_OBJECT_SET", { src: "$F1", predicate: "$P2" }),
    c("$F3", "FILTER_OBJECT_SET", { src: "$F2", predicate: "$P3" }),
  ] },
  { name: "22: search-around chain (2 deep)", cards: [
    c("$A", "OBJECT_SET"), c("$E1", "PARAMETER_STRING"), c("$E2", "PARAMETER_STRING"),
    c("$S1", "SEARCH_AROUND", { src: "$A", linkApiName: "$E1" }),
    c("$S2", "SEARCH_AROUND", { src: "$S1", linkApiName: "$E2" }),
  ] },
  { name: "23: aggregation pipes into transform-table (covariance)", cards: [
    c("$A", "OBJECT_SET"), c("$G", "EXPRESSION"), c("$H", "EXPRESSION"),
    c("$AG", "AGGREGATION", { src: "$A", group: "$G", agg: "$H" }),
    c("$T", "TRANSFORM_TABLE", { src: "$AG" }),
  ] },
  { name: "24: materialization pipes into transform-table (covariance)", cards: [
    c("$A", "OBJECT_SET"), c("$M", "MATERIALIZATION", { src: "$A" }),
    c("$T", "TRANSFORM_TABLE", { src: "$M" }),
  ] },
  { name: "25: categorical chart from object-set directly (covariance)", cards: [
    c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"),
    c("$K", "CATEGORICAL_CHART", { src: "$A", x: "$E", y: "$E" }),
  ] },
  { name: "26: pivot-table off transform-table chain", cards: [
    c("$A", "OBJECT_SET"), c("$T", "TRANSFORM_TABLE", { src: "$A" }),
    c("$P", "PIVOT_TABLE", { src: "$T" }),
  ] },
  { name: "27: object-set → search-around → filter → aggregation", cards: [
    c("$A", "OBJECT_SET"), c("$E", "PARAMETER_STRING"),
    c("$S", "SEARCH_AROUND", { src: "$A", linkApiName: "$E" }),
    c("$P", "BOOLEAN_FORMULA"),
    c("$F", "FILTER_OBJECT_SET", { src: "$S", predicate: "$P" }),
    c("$G", "EXPRESSION"), c("$H", "EXPRESSION"),
    c("$AG", "AGGREGATION", { src: "$F", group: "$G", agg: "$H" }),
  ] },
  { name: "28: parameter binding into filter predicate via boolean-formula", cards: [
    c("$A", "OBJECT_SET"), c("$P1", "PARAMETER_BOOLEAN"),
    c("$F", "FILTER_OBJECT_SET", { src: "$A", predicate: "$P1" }),
  ] },
  { name: "29: function-call output ANY satisfies any downstream slot", cards: [
    c("$R", "EXPRESSION"), c("$P", "EXPRESSION"),
    c("$F", "FUNCTION_CALL", { functionRid: "$R", paramBindings: "$P" }),
    // FUNCTION_CALL output ANY → acceptable wherever; pipe into TRANSFORM_TABLE.src
    c("$T", "TRANSFORM_TABLE", { src: "$F" }),
  ] },
  { name: "30: visual-function-call output ANY satisfies CATEGORICAL_CHART.src", cards: [
    c("$R", "EXPRESSION"), c("$P", "EXPRESSION"),
    c("$V", "VISUAL_FUNCTION_CALL", { visualFunctionRid: "$R", paramBindings: "$P" }),
    c("$E", "PARAMETER_STRING"),
    c("$K", "CATEGORICAL_CHART", { src: "$V", x: "$E", y: "$E" }),
  ] },
];

describe("DagValidator — 30 golden combinations (B2 C-16)", () => {
  for (const combo of COMBOS) {
    it(`B2 C-16 [${combo.name}] validates and is stable`, () => {
      const r1 = validate(doc(combo.cards));
      const r2 = validate(doc(combo.cards));
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
      if (r1.valid && r2.valid) {
        // B2 C-11 stability: identical input → identical topologicalOrder.
        expect(r1.topologicalOrder).toEqual(r2.topologicalOrder);
      }
    });
  }

  it("contract: exactly 30 golden combinations registered", () => {
    expect(COMBOS.length).toBe(30);
  });
});
