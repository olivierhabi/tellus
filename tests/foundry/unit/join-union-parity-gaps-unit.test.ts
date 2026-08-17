// ---------------------------------------------------------------------------
// The three Palantir parity gaps closed after the Join/Union audit
// (Join ≈92%, Union ≈85%):
//
//   1. N-input union         — Palantir's union*ByNameV1 take a List<Table>,
//                              so a three-way union is ONE node.
//   2. Expression conditions — the complex*JoinV1 family accepts an arbitrary
//                              Expression<Boolean> (lessThan, and(...)), not
//                              just joinV2's equality key list.
//   3. Key coalescing        — complexOuterJoinV1 Example 4: same-name join
//                              keys are coalesced when no prefix is applied.
//
// Each is pinned at the pure layer the service and both SQL compilers share, so
// the reported match rate, the preview's column list, and the deploy schema
// cannot drift from one another. A column present in the rows but absent from
// the schema is a silently blank column downstream — the exact failure mode
// this whole effort started from.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  compareJoinValues,
  coalescedJoinKeyNames,
  computeJoinMatchRate,
  buildJoinMatchWarnings,
  isEqualityCondition,
} from "../../../src/services/pipelines/joinMatchRate";
import { resolveUnionInputIds } from "../../../src/types/pipeline";
import { unionSideLabels } from "../../../src/utils/columnNameReconciler";
import {
  joinOperatorSql,
  unionOtherPaths,
  __internals,
} from "../../../src/services/pipelines/duckdbTransformEngine";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Gap 2a — the comparison primitive.
// ---------------------------------------------------------------------------

describe("compareJoinValues", () => {
  it("keeps equality text-based so a CSV string joins a cast number", () => {
    // The historical join compares String(lv) === String(rv). A left side read
    // from CSV holds "42" while a cast right side holds 42, and those must
    // still join or every existing pipeline breaks.
    expect(compareJoinValues("42", 42, "equals")).toBe(true);
    expect(compareJoinValues("42", 42)).toBe(true); // default is equals
    expect(compareJoinValues("42", "43", "equals")).toBe(false);
  });

  it("supports notEquals as the inverse of equals", () => {
    expect(compareJoinValues("a", "b", "notEquals")).toBe(true);
    expect(compareJoinValues("42", 42, "notEquals")).toBe(false);
  });

  it("orders numerically, NOT as text", () => {
    // The trap: as strings "10" < "9" is true, so a text-ordered theta join
    // would silently return the wrong rows. Both sides numeric ⇒ compare as
    // numbers.
    expect(compareJoinValues("10", "9", "lessThan")).toBe(false);
    expect(compareJoinValues("9", "10", "lessThan")).toBe(true);
    expect(compareJoinValues(9, 10, "lessThan")).toBe(true);
    expect(compareJoinValues("100", "20", "greaterThan")).toBe(true);
  });

  it("handles the inclusive variants at the boundary", () => {
    expect(compareJoinValues(5, 5, "lessThanOrEqual")).toBe(true);
    expect(compareJoinValues(5, 5, "lessThan")).toBe(false);
    expect(compareJoinValues(5, 5, "greaterThanOrEqual")).toBe(true);
    expect(compareJoinValues(5, 5, "greaterThan")).toBe(false);
  });

  it("orders dates chronologically when neither side is numeric", () => {
    // Lexicographic ordering happens to be right for ISO dates, so use a pair
    // where the two disagree: "2024-01-02" vs "2024-1-10" sorts wrong as text
    // ("2024-01-02" < "2024-1-10" because "0" < "1") but is chronologically
    // earlier too — so use month names, where text ordering is clearly wrong.
    expect(compareJoinValues("Mar 1 2024", "Feb 1 2024", "greaterThan")).toBe(true);
    expect(compareJoinValues("Mar 1 2024", "Feb 1 2024", "lessThan")).toBe(false);
    // Text ordering would say "Mar" > "Feb" too; the discriminating case is a
    // year boundary, where text ordering fails outright.
    expect(compareJoinValues("Dec 1 2023", "Jan 1 2024", "lessThan")).toBe(true);
  });

  it("falls back to lexicographic ordering for plain text", () => {
    expect(compareJoinValues("apple", "banana", "lessThan")).toBe(true);
    expect(compareJoinValues("banana", "apple", "lessThan")).toBe(false);
  });
});

describe("isEqualityCondition", () => {
  it("treats an omitted operator as equals", () => {
    expect(isEqualityCondition({ leftColumn: "a", rightColumn: "b" })).toBe(true);
    expect(
      isEqualityCondition({ leftColumn: "a", rightColumn: "b", operator: "equals" }),
    ).toBe(true);
  });

  it("excludes every inequality", () => {
    for (const operator of [
      "notEquals",
      "lessThan",
      "lessThanOrEqual",
      "greaterThan",
      "greaterThanOrEqual",
    ] as const) {
      expect(isEqualityCondition({ leftColumn: "a", rightColumn: "b", operator })).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 2b — theta conditions in the match-rate calculation. The percentage must
// agree with the rows, so the hash-bucket optimisation cannot be allowed to
// ignore the inequality half of a mixed condition list.
// ---------------------------------------------------------------------------

describe("computeJoinMatchRate with theta conditions", () => {
  const LEFT: Row[] = [
    { region: "east", amount: 100 },
    { region: "east", amount: 5 },
    { region: "west", amount: 100 },
  ];
  const RIGHT: Row[] = [
    { region: "east", threshold: 50 },
    { region: "west", threshold: 500 },
  ];

  it("narrows by equality then filters by inequality", () => {
    // east/100 > 50 matches; east/5 does not; west/100 > 500 does not.
    const { matched, probed } = computeJoinMatchRate(LEFT, RIGHT, "left", [
      { leftColumn: "region", rightColumn: "region" },
      { leftColumn: "amount", rightColumn: "threshold", operator: "greaterThan" },
    ]);
    expect(probed).toBe(3);
    expect(matched).toBe(1);
  });

  it("scans every row when there is no equality condition to bucket on", () => {
    // A pure theta join has no hash key at all; every probe row must be checked
    // against every other row or the rate silently reads 0%.
    const { matched, probed } = computeJoinMatchRate(LEFT, RIGHT, "left", [
      { leftColumn: "amount", rightColumn: "threshold", operator: "lessThan" },
    ]);
    // amount 100 < 500 (west) ⇒ match; amount 5 < 50 and < 500 ⇒ match;
    // amount 100 < 500 ⇒ match. All three find some candidate.
    expect(probed).toBe(3);
    expect(matched).toBe(3);
  });

  it("keeps the equality-only path unchanged", () => {
    const { matched, probed } = computeJoinMatchRate(LEFT, RIGHT, "left", [
      { leftColumn: "region", rightColumn: "region" },
    ]);
    expect(matched).toBe(3);
    expect(probed).toBe(3);
  });

  it("never matches a nullish value through an inequality", () => {
    // null ≠ null is a documented joinV2 rule (complexLeftJoinV1 Example 3);
    // ordering against a null must not accidentally succeed via Number(null)=0.
    const left: Row[] = [{ region: "east", amount: null }];
    const { matched } = computeJoinMatchRate(left, RIGHT, "left", [
      { leftColumn: "region", rightColumn: "region" },
      { leftColumn: "amount", rightColumn: "threshold", operator: "lessThan" },
    ]);
    expect(matched).toBe(0);
  });
});

describe("match-rate warnings render the real operator", () => {
  it("shows the inequality symbol rather than assuming =", () => {
    // A ZERO_MATCHES message that prints `"a" = "b"` for a lessThan join would
    // send the user hunting for a key mismatch that does not exist.
    const w = buildJoinMatchWarnings(
      [{ amount: 1 }],
      [{ threshold: 0 }],
      "left",
      [{ leftColumn: "amount", rightColumn: "threshold", operator: "lessThan" }],
    );
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe("ZERO_MATCHES");
    expect(w[0].message).toContain('"amount" < "threshold"');
    expect(w[0].message).not.toContain('"amount" = "threshold"');
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — key coalescing.
// ---------------------------------------------------------------------------

describe("coalescedJoinKeyNames", () => {
  const leftCols = new Set(["id", "region", "amount"]);

  it("collapses a same-name equality key", () => {
    const out = coalescedJoinKeyNames(
      [{ leftColumn: "id", rightColumn: "id" }],
      leftCols,
    );
    expect([...out]).toEqual(["id"]);
  });

  it("leaves differently-named keys alone", () => {
    // There is nothing to merge: `order_id` and `orderId` are two columns.
    const out = coalescedJoinKeyNames(
      [{ leftColumn: "order_id", rightColumn: "orderId" }],
      new Set(["order_id"]),
    );
    expect(out.size).toBe(0);
  });

  it("refuses to coalesce an inequality pair", () => {
    // The two sides hold different values by definition, so there is no single
    // value the merged column could carry.
    const out = coalescedJoinKeyNames(
      [{ leftColumn: "amount", rightColumn: "amount", operator: "lessThan" }],
      leftCols,
    );
    expect(out.size).toBe(0);
  });

  it("only coalesces when the left side actually has the column", () => {
    // With leftSelectedColumns filtering the left side down, a right key whose
    // left twin was dropped must stay in the output — otherwise the column
    // disappears from both sides.
    const out = coalescedJoinKeyNames(
      [{ leftColumn: "id", rightColumn: "id" }],
      new Set(["region"]),
    );
    expect(out.size).toBe(0);
  });

  it("applies the normalizer to both sides (BOM-stripped CSV headers)", () => {
    const strip = (n: string) => n.replace(/^﻿/, "");
    const out = coalescedJoinKeyNames(
      [{ leftColumn: "﻿id", rightColumn: "id" }],
      new Set(["id"]),
      strip,
    );
    expect([...out]).toEqual(["id"]);
  });

  it("handles a composite key, coalescing only the same-named parts", () => {
    const out = coalescedJoinKeyNames(
      [
        { leftColumn: "region", rightColumn: "region" },
        { leftColumn: "order_id", rightColumn: "orderId" },
      ],
      new Set(["region", "order_id"]),
    );
    expect([...out]).toEqual(["region"]);
  });
});

// ---------------------------------------------------------------------------
// Gap 1 — N-input union.
// ---------------------------------------------------------------------------

describe("resolveUnionInputIds", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";

  it("accepts the legacy singular shape", () => {
    expect(resolveUnionInputIds({ rightNodeId: A })).toEqual([A]);
  });

  it("accepts the N-input list", () => {
    expect(resolveUnionInputIds({ rightNodeIds: [A, B, C] })).toEqual([A, B, C]);
  });

  it("puts the singular first when both are sent", () => {
    // Column order follows input order (wideUnionByNameV1), so this ordering is
    // observable in the output schema — it cannot be arbitrary.
    expect(resolveUnionInputIds({ rightNodeId: A, rightNodeIds: [B] })).toEqual([A, B]);
  });

  it("de-duplicates, so a repeated input cannot silently double its rows", () => {
    expect(resolveUnionInputIds({ rightNodeId: A, rightNodeIds: [A, B, B] })).toEqual([
      A,
      B,
    ]);
  });

  it("returns empty when nothing is wired", () => {
    expect(resolveUnionInputIds({})).toEqual([]);
  });
});

describe("unionOtherPaths (DuckDB step shape)", () => {
  it("folds the legacy otherPath in ahead of otherPaths", () => {
    expect(
      unionOtherPaths({ function: "Union", otherPath: "a.csv", otherPaths: ["b.csv"] }),
    ).toEqual(["a.csv", "b.csv"]);
  });

  it("de-duplicates repeated paths", () => {
    expect(
      unionOtherPaths({ function: "Union", otherPaths: ["a.csv", "a.csv", "b.csv"] }),
    ).toEqual(["a.csv", "b.csv"]);
  });
});

// ---------------------------------------------------------------------------
// Both gaps as the DuckDB compiler emits them. Compile-only, so these run
// without the native binding.
// ---------------------------------------------------------------------------

describe("joinOperatorSql", () => {
  it("maps every operator to its SQL comparison", () => {
    expect(joinOperatorSql(undefined)).toBe("=");
    expect(joinOperatorSql("equals")).toBe("=");
    expect(joinOperatorSql("notEquals")).toBe("<>"); // NOT `!=`
    expect(joinOperatorSql("lessThan")).toBe("<");
    expect(joinOperatorSql("lessThanOrEqual")).toBe("<=");
    expect(joinOperatorSql("greaterThan")).toBe(">");
    expect(joinOperatorSql("greaterThanOrEqual")).toBe(">=");
  });

  it("rejects an unknown operator rather than interpolating it into SQL", () => {
    expect(() =>
      joinOperatorSql("; DROP TABLE t --" as never),
    ).toThrow(/Unsupported join condition operator/);
  });
});

describe("compileJoin renders operators", () => {
  it("still emits = for an equality-only step", () => {
    const sql = __internals.compileJoin(
      {
        function: "Join",
        rightPath: "s3://b/right.csv",
        joinType: "inner",
        on: [{ left: "id", right: "id" }],
      },
      "step0",
    );
    expect(sql).toContain('l."id" = "r"."id"');
  });

  it("emits the inequality for a theta join and ANDs a mixed list", () => {
    const sql = __internals.compileJoin(
      {
        function: "Join",
        rightPath: "s3://b/right.csv",
        joinType: "inner",
        on: [
          { left: "region", right: "region" },
          { left: "amount", right: "threshold", operator: "greaterThan" },
        ],
      },
      "step0",
    );
    expect(sql).toContain('l."region" = "r"."region"');
    expect(sql).toContain('l."amount" > "r"."threshold"');
    expect(sql).toContain(" AND ");
  });
});

describe("compileUnion is N-input", () => {
  it("chains one flat UNION ALL BY NAME across three inputs", () => {
    const sql = __internals.compileUnion(
      { function: "Union", otherPaths: ["s3://b/2.csv", "s3://b/3.csv"] },
      "step0",
    );
    expect(sql.match(/UNION ALL BY NAME/g)).toHaveLength(2);
    expect(sql).toContain("s3://b/2.csv");
    expect(sql).toContain("s3://b/3.csv");
  });

  it("keeps the two-input legacy shape byte-identical", () => {
    const sql = __internals.compileUnion(
      { function: "Union", otherPath: "s3://b/2.csv" },
      "step0",
    );
    expect(sql).toBe(
      "SELECT * FROM step0 UNION ALL BY NAME SELECT * FROM read_csv_auto('s3://b/2.csv')",
    );
  });

  it("honours byName:false across N inputs", () => {
    const sql = __internals.compileUnion(
      { function: "Union", byName: false, otherPaths: ["s3://b/2.csv", "s3://b/3.csv"] },
      "step0",
    );
    expect(sql).not.toContain("BY NAME");
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
  });

  it("errors rather than emitting a one-sided union when nothing is wired", () => {
    expect(() => __internals.compileUnion({ function: "Union" }, "step0")).toThrow(
      /at least one additional input/,
    );
  });

  it("still routes first/narrow to the legacy engine", () => {
    // These need static column knowledge of every input, which this compiler
    // does not track through chained steps.
    for (const mode of ["first", "narrow"] as const) {
      expect(() =>
        __internals.compileUnion(
          { function: "Union", mode, otherPaths: ["s3://b/2.csv"] },
          "step0",
        ),
      ).toThrow(/requires static column knowledge/);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 1 follow-up — the messages have to be N-input aware too.
//
// Found by driving the real browser: a three-way union still reported
// "Right-only: orderId", which names a side that does not exist once there are
// three inputs. The user cannot tell WHICH later input has the column.
// ---------------------------------------------------------------------------

describe("unionSideLabels", () => {
  it("keeps the historical left/right wording for exactly two inputs", () => {
    expect(unionSideLabels(2)).toEqual({
      firstOnly: "only in left",
      laterOnly: "only in right",
      allInputs: "both inputs",
    });
  });

  it("drops left/right for three inputs, because there is no single right", () => {
    const l = unionSideLabels(3);
    expect(l.firstOnly).toBe("missing from at least one later input");
    expect(l.laterOnly).toBe("absent from the first input");
    expect(l.allInputs).toBe("all 3 inputs");
    for (const v of Object.values(l)) {
      expect(v).not.toMatch(/\bleft\b|\bright\b/i);
    }
  });

  it("counts the inputs it was given rather than hardcoding three", () => {
    expect(unionSideLabels(5).allInputs).toBe("all 5 inputs");
    expect(unionSideLabels(12).allInputs).toBe("all 12 inputs");
  });
});
