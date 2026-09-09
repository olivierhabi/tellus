// ---------------------------------------------------------------------------
// Unit tests for the shared pipeline-ops primitives extracted from
// transformService.ts (god-file breakup). These pin the exact semantics the
// legacy TS engine has always had — the per-op modules and the chain replay
// in TransformService both consume these, so a regression here would change
// every preview at once.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  CONVERTER_TYPE_MAP,
  EXECUTE_SOURCE_ROW_LIMIT,
  PREVIEW_SOURCE_ROW_LIMIT,
  castExpressionResult,
  collectExpressionItems,
  coerceNumeric,
  coerceString,
  compareEq,
  compareOrd,
  concatenateStringValues,
  evaluateExpression,
  formatStringValue,
  normalizeColumnName,
  parseLiteral,
  sampleInfo,
  stripBom,
  validateExpressionColumns,
} from "../../../src/services/pipelines/ops/shared";

describe("sharedOps — coercion primitives", () => {
  it("coerceNumeric treats null/undefined/empty as null and parses numerics", () => {
    expect(coerceNumeric(null)).toBeNull();
    expect(coerceNumeric(undefined)).toBeNull();
    expect(coerceNumeric("")).toBeNull();
    expect(coerceNumeric("42")).toBe(42);
    expect(coerceNumeric("3.5")).toBe(3.5);
    expect(coerceNumeric(7)).toBe(7);
    expect(coerceNumeric("abc")).toBeNull();
  });

  it("coerceString stringifies, null/undefined → empty string", () => {
    expect(coerceString(null)).toBe("");
    expect(coerceString(undefined)).toBe("");
    expect(coerceString(0)).toBe("0");
    expect(coerceString(false)).toBe("false");
    expect(coerceString("x")).toBe("x");
  });

  it("compareEq prefers numeric comparison when both sides coerce", () => {
    expect(compareEq("10", 10)).toBe(true);
    expect(compareEq("010", "10")).toBe(true);
    expect(compareEq("abc", "abc")).toBe(true);
    expect(compareEq("abc", "abd")).toBe(false);
  });

  it("compareOrd is numeric when both coerce, lexicographic otherwise", () => {
    expect(compareOrd("2", "10")).toBeLessThan(0); // numeric: 2 < 10
    expect(compareOrd("a2", "a10")).toBeGreaterThan(0); // string: "a2" > "a10"
    expect(compareOrd("2024-01-01", "2024-01-02")).toBeLessThan(0);
    expect(compareOrd("5", "5")).toBe(0);
  });
});

describe("sharedOps — parseLiteral", () => {
  it("parses typed literals", () => {
    expect(parseLiteral({ kind: "literal", value: "42", literalType: "integer" })).toBe(42);
    expect(parseLiteral({ kind: "literal", value: "4.5", literalType: "numeric" })).toBe(4.5);
    expect(parseLiteral({ kind: "literal", value: "true", literalType: "boolean" })).toBe(true);
    expect(parseLiteral({ kind: "literal", value: "false", literalType: "boolean" })).toBe(false);
    expect(parseLiteral({ kind: "literal", value: "hi", literalType: "string" })).toBe("hi");
    expect(parseLiteral({ kind: "literal", value: "hi" })).toBe("hi");
  });

  it("returns null for unparseable numeric literals", () => {
    expect(parseLiteral({ kind: "literal", value: "abc", literalType: "integer" })).toBeNull();
    expect(parseLiteral({ kind: "literal", value: "abc", literalType: "numeric" })).toBeNull();
  });

  it("passes column operands through untouched", () => {
    expect(parseLiteral({ kind: "column", value: "col_a" })).toBe("col_a");
  });
});

describe("sharedOps — evaluateExpression", () => {
  const row = { a: "10", b: "4", s: "foo", n: null };

  it("arithmetic coerces operands to numbers", () => {
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "+", right: { kind: "column", value: "b" },
    })).toBe(14);
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "-", right: { kind: "literal", value: "3", literalType: "integer" },
    })).toBe(7);
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "*", right: { kind: "column", value: "b" },
    })).toBe(40);
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "/", right: { kind: "column", value: "b" },
    })).toBe(2.5);
  });

  it("division by zero or non-numeric divisor returns null", () => {
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "/", right: { kind: "literal", value: "0", literalType: "integer" },
    })).toBeNull();
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "/", right: { kind: "column", value: "s" },
    })).toBeNull();
  });

  it("null propagates through arithmetic", () => {
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "n" }, operator: "+", right: { kind: "column", value: "a" },
    })).toBeNull();
  });

  it("'||' concatenates as strings", () => {
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "s" }, operator: "||", right: { kind: "literal", value: "bar" },
    })).toBe("foobar");
  });

  it("comparisons return booleans", () => {
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: ">", right: { kind: "column", value: "b" },
    })).toBe(true);
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "==", right: { kind: "literal", value: "10", literalType: "integer" },
    })).toBe(true);
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "!=", right: { kind: "literal", value: "10", literalType: "integer" },
    })).toBe(false);
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "<=", right: { kind: "column", value: "b" },
    })).toBe(false);
  });

  it("unknown operator returns null", () => {
    expect(evaluateExpression(row, {
      left: { kind: "column", value: "a" }, operator: "??" as never, right: { kind: "column", value: "b" },
    })).toBeNull();
  });
});

describe("sharedOps — formatStringValue", () => {
  it("formats %s/%d/%f with width, precision, and flags", () => {
    expect(formatStringValue("%s", ["hello"])).toBe("hello");
    expect(formatStringValue("%.2s", ["hello"])).toBe("he");
    expect(formatStringValue("%S", ["hello"])).toBe("HELLO");
    expect(formatStringValue("%d", ["42.9"])).toBe("42");
    expect(formatStringValue("%.2f", [3.14159])).toBe("3.14");
    expect(formatStringValue("%+d", [5])).toBe("+5");
    expect(formatStringValue("%05d", [42])).toBe("00042");
    expect(formatStringValue("%-5d|", [42])).toBe("42   |");
  });

  it("renders missing/null args as the literal text 'null'", () => {
    expect(formatStringValue("%s %s", ["only"])).toBe("only null");
    expect(formatStringValue("%s", [null])).toBe("null");
  });

  it("handles %% and %n escapes and ignores extra args", () => {
    expect(formatStringValue("100%%", [])).toBe("100%");
    expect(formatStringValue("a%nb", [])).toBe("a\nb");
    expect(formatStringValue("%s", ["x", "ignored"])).toBe("x");
  });
});

describe("sharedOps — concatenateStringValues", () => {
  it("joins column and literal operands, skipping nulls in lenient mode", () => {
    const exprs = [
      { kind: "column" as const, value: "a" },
      { kind: "literal" as const, value: "-" },
      { kind: "column" as const, value: "b" },
    ];
    expect(concatenateStringValues({ a: "x", b: "y" }, exprs, "", false)).toBe("x-y");
    expect(concatenateStringValues({ a: "x", b: null }, exprs, "", false)).toBe("x-");
    expect(concatenateStringValues({ a: "x", b: null }, exprs, "", true)).toBeNull();
  });
});

describe("sharedOps — castExpressionResult", () => {
  it("passes through when no outputType; coerces otherwise; nulls on failure", () => {
    expect(castExpressionResult("12", undefined)).toBe("12");
    expect(castExpressionResult("12", "integer")).toBe(12);
    expect(castExpressionResult(5, "string")).toBe("5");
  });
});

describe("sharedOps — collectExpressionItems", () => {
  it("unwraps the four Apply-family transform shapes", () => {
    const single = collectExpressionItems({
      function: "ApplyExpression",
      expression: { left: { kind: "column", value: "a" }, operator: "+", right: { kind: "literal", value: "1" }, outputColumn: "out" },
    });
    expect(single).toHaveLength(1);
    expect(single[0].outputColumn).toBe("out");

    const multi = collectExpressionItems({
      function: "ApplyMultipleExpressions",
      expressions: [
        { left: { kind: "column", value: "a" }, operator: "+", right: { kind: "literal", value: "1" }, outputColumn: "o1" },
        { left: { kind: "column", value: "b" }, operator: "*", right: { kind: "literal", value: "2" }, outputColumn: "o2" },
      ],
    });
    expect(multi.map((e) => e.outputColumn)).toEqual(["o1", "o2"]);

    const toCols = collectExpressionItems({
      function: "ApplyToMultipleColumns",
      columns: ["a", "b"],
      operator: "+",
      right: { kind: "literal", value: "1" },
    });
    expect(toCols.map((e) => e.outputColumn)).toEqual(["a_calc", "b_calc"]);
    expect(toCols[0].left).toEqual({ kind: "column", value: "a" });

    const ifAbsent = collectExpressionItems({
      function: "ComputeIfExpressionAbsent",
      outputColumn: "filled",
      expression: { left: { kind: "column", value: "a" }, operator: "+", right: { kind: "literal", value: "1" } },
    });
    expect(ifAbsent).toHaveLength(1);
    expect(ifAbsent[0].outputColumn).toBe("filled");

    expect(collectExpressionItems({ function: "Filter" })).toEqual([]);
  });
});

describe("sharedOps — sampling contract", () => {
  it("row limits keep their historical values", () => {
    expect(PREVIEW_SOURCE_ROW_LIMIT).toBe(5000);
    expect(EXECUTE_SOURCE_ROW_LIMIT).toBe(10000);
  });

  it("sampleInfo flags truncated exactly at the cap", () => {
    expect(sampleInfo(PREVIEW_SOURCE_ROW_LIMIT - 1)).toEqual({
      sampledSourceRows: PREVIEW_SOURCE_ROW_LIMIT - 1,
      sourceRowLimit: PREVIEW_SOURCE_ROW_LIMIT,
      truncated: false,
    });
    expect(sampleInfo(PREVIEW_SOURCE_ROW_LIMIT).truncated).toBe(true);
  });
});

describe("sharedOps — column-name hygiene", () => {
  it("stripBom removes leading and inline BOMs", () => {
    expect(stripBom("﻿name")).toBe("name");
    expect(stripBom("a﻿b")).toBe("ab");
    expect(stripBom("plain")).toBe("plain");
  });

  it("normalizeColumnName mirrors normalizeColumnNamesV1", () => {
    expect(normalizeColumnName("First Name", false)).toBe("first_name");
    expect(normalizeColumnName("a-b.c/d\\e", false)).toBe("a_b_c_d_e");
    expect(normalizeColumnName("Héllo Wörld!", true)).toBe("hllo_wrld");
    expect(normalizeColumnName("__--__", false)).toBe("column");
    expect(normalizeColumnName("A  B", false)).toBe("a_b");
  });
});

describe("sharedOps — validateExpressionColumns", () => {
  const cols = [{ name: "a" }, { name: "b" }];

  it("accepts column operands that exist and literal operands", () => {
    expect(() => validateExpressionColumns({
      left: { kind: "column", value: "a" },
      right: { kind: "literal", value: "1" },
    }, cols)).not.toThrow();
  });

  it("rejects unknown columns with the available list in the message", () => {
    expect(() => validateExpressionColumns({
      left: { kind: "column", value: "zzz" },
      right: { kind: "column", value: "a" },
    }, cols)).toThrowError(/"zzz" which does not exist.*Available: a, b/);
  });
});

describe("sharedOps — CONVERTER_TYPE_MAP", () => {
  it("maps every CastTargetType to its converter base type", () => {
    expect(CONVERTER_TYPE_MAP).toEqual({
      string: "string",
      integer: "integer",
      numeric: "double",
      boolean: "boolean",
      date: "date",
      timestamp: "timestamp",
    });
  });
});
