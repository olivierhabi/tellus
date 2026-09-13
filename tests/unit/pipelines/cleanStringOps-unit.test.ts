// ---------------------------------------------------------------------------
// Unit tests for the Clean String op (Palantir cleanStringV1 parity):
// trim / normalize whitespace / nullify empty, column-scoped or whole-row.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { applyCleanStringRows } from "../../../src/services/pipelines/ops/cleanStringOps";

describe("cleanStringOps — applyCleanStringRows", () => {
  it("trims leading/trailing whitespace on selected columns", () => {
    const rows = [{ a: "  hello  ", b: "  untouched  " }];
    const out = applyCleanStringRows(rows, ["a"], { trim: true });
    expect(out[0].a).toBe("hello");
    expect(out[0].b).toBe("  untouched  ");
  });

  it("cleans every column when no column list is given", () => {
    const rows = [{ a: " x ", b: "y " }];
    const out = applyCleanStringRows(rows, undefined, { trim: true });
    expect(out[0]).toEqual({ a: "x", b: "y" });
  });

  it("normalize whitespace collapses internal runs to a single space", () => {
    const rows = [{ a: "hello \t\n  world" }];
    const out = applyCleanStringRows(rows, ["a"], { normalizeWhitespace: true });
    expect(out[0].a).toBe("hello world");
  });

  it("nullify empty converts trimmed empty strings to null", () => {
    const rows = [{ a: "   ", b: "x" }];
    const out = applyCleanStringRows(rows, undefined, { trim: true, nullifyEmpty: true });
    expect(out[0].a).toBeNull();
    expect(out[0].b).toBe("x");
  });

  it("leaves null/undefined and non-string values untouched", () => {
    const rows = [{ a: null, b: undefined, c: 42, d: true }];
    const out = applyCleanStringRows(rows, undefined, { trim: true, normalizeWhitespace: true, nullifyEmpty: true });
    expect(out[0]).toEqual({ a: null, b: undefined, c: 42, d: true });
  });
});
