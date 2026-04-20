// ---------------------------------------------------------------------------
// PB-B10 — schema evolution classifier (unit).
//
// 20 golden scenarios covering the spec's safe/unsafe matrix.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  classifyEvolution,
  classifyTypeChange,
  diffOutputSchema,
  fingerprintOutputSchema,
  type SchemaColumn,
} from "../../../src/services/pipelines/schemaEvolution";

function col(name: string, type: string, extra: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name, type, required: false, primaryKey: false, ...extra };
}

describe("fingerprintOutputSchema", () => {
  it("is stable across key order in the column records", () => {
    const a = fingerprintOutputSchema([col("a", "integer")]);
    const b = fingerprintOutputSchema([{ type: "integer", name: "a" } as SchemaColumn]);
    expect(a).toBe(b);
  });
  it("flips when a column type changes", () => {
    const a = fingerprintOutputSchema([col("a", "integer")]);
    const b = fingerprintOutputSchema([col("a", "long")]);
    expect(a).not.toBe(b);
  });
});

describe("classifyTypeChange — family matrix", () => {
  it("(1) int32 → int64 is a safe widen", () => {
    const op = classifyTypeChange("a", "int32", "int64");
    expect(op?.op).toBe("update_column_type");
  });
  it("(2) int64 → int32 is a narrowing", () => {
    const op = classifyTypeChange("a", "int64", "int32");
    expect(op?.op).toBe("narrowing");
  });
  it("(3) float32 → float64 is a safe widen", () => {
    const op = classifyTypeChange("a", "float32", "float64");
    expect(op?.op).toBe("update_column_type");
  });
  it("(4) float64 → float32 is a narrowing", () => {
    const op = classifyTypeChange("a", "float64", "float32");
    expect(op?.op).toBe("narrowing");
  });
  it("(5) decimal(9,2) → decimal(18,2) is a safe widen", () => {
    const op = classifyTypeChange("a", "decimal(9,2)", "decimal(18,2)");
    expect(op?.op).toBe("update_column_type");
  });
  it("(6) decimal(18,2) → decimal(9,2) is a narrowing", () => {
    const op = classifyTypeChange("a", "decimal(18,2)", "decimal(9,2)");
    expect(op?.op).toBe("narrowing");
  });
  it("(7) string → integer is cross-family", () => {
    const op = classifyTypeChange("a", "string", "integer");
    expect(op?.op).toBe("cross_family_type_change");
  });
  it("(8) integer → timestamp is cross-family", () => {
    const op = classifyTypeChange("a", "integer", "timestamp");
    expect(op?.op).toBe("cross_family_type_change");
  });
  it("(9) identity type (int → integer) is a no-op", () => {
    expect(classifyTypeChange("a", "int", "integer")).toBeNull();
  });
  it("(10) boolean → string is cross-family", () => {
    const op = classifyTypeChange("a", "boolean", "string");
    expect(op?.op).toBe("cross_family_type_change");
  });
});

describe("diffOutputSchema — full schemas", () => {
  it("(11) adding a column emits add_column safe op", () => {
    const res = diffOutputSchema(
      [col("id", "long")],
      [col("id", "long"), col("name", "string")],
    );
    expect(res.safeOperations.map((o) => o.op)).toEqual(["add_column"]);
    expect(res.willBeSafe).toBe(true);
  });
  it("(12) dropping a column emits delete_column safe op", () => {
    const res = diffOutputSchema(
      [col("id", "long"), col("old", "string")],
      [col("id", "long")],
    );
    expect(res.safeOperations.map((o) => o.op)).toEqual(["delete_column"]);
    expect(res.willBeSafe).toBe(true);
  });
  it("(13) dropping a primary-key column is rejected", () => {
    const res = diffOutputSchema(
      [col("id", "long", { primaryKey: true }), col("name", "string")],
      [col("name", "string")],
    );
    expect(res.blockingIssues.some((o) => o.op === "primary_key_change")).toBe(true);
    expect(res.willBeSafe).toBe(false);
  });
  it("(14) re-typing a primary key is rejected", () => {
    const res = diffOutputSchema(
      [col("id", "long", { primaryKey: true })],
      [col("id", "string", { primaryKey: true })],
    );
    expect(res.blockingIssues.some((o) => o.op === "primary_key_change")).toBe(true);
  });
  it("(15) nullable → required on a column with data is blocked", () => {
    const res = diffOutputSchema(
      [col("name", "string", { required: false })],
      [col("name", "string", { required: true })],
    );
    expect(res.blockingIssues.some((o) => o.op === "nullable_tighten")).toBe(true);
    expect(res.willBeSafe).toBe(false);
  });
  it("(16) adding a required column does NOT trigger nullable_tighten", () => {
    const res = diffOutputSchema(
      [col("id", "long")],
      [col("id", "long"), col("new_col", "string", { required: true })],
    );
    // Add ops are always safe (the Iceberg writer adds them as nullable
    // anyway); required=true is advisory metadata on the client.
    expect(res.blockingIssues.length).toBe(0);
  });
  it("(17) multiple safe ops in one diff are all captured", () => {
    const res = diffOutputSchema(
      [col("id", "long"), col("old", "string")],
      [col("id", "long"), col("amount", "int32")],
    );
    const kinds = res.safeOperations.map((o) => o.op).sort();
    expect(kinds).toEqual(["add_column", "delete_column"]);
  });
  it("(18) identical schemas produce empty diff", () => {
    const res = diffOutputSchema(
      [col("id", "long"), col("name", "string")],
      [col("id", "long"), col("name", "string")],
    );
    expect(res.operations).toEqual([]);
  });
  it("(19) widening PLUS a new column = two safe ops", () => {
    const res = diffOutputSchema(
      [col("amount", "int32")],
      [col("amount", "int64"), col("currency", "string")],
    );
    const kinds = res.safeOperations.map((o) => o.op).sort();
    expect(kinds).toEqual(["add_column", "update_column_type"]);
    expect(res.willBeSafe).toBe(true);
  });
  it("(20) narrowing + adding = BOTH surface, overall unsafe", () => {
    const res = diffOutputSchema(
      [col("amount", "int64")],
      [col("amount", "int32"), col("currency", "string")],
    );
    expect(res.blockingIssues.length).toBe(1);
    expect(res.willBeSafe).toBe(false);
    expect(res.safeOperations.length).toBe(1); // add_column still classifies as safe
  });
});

describe("classifyEvolution (full envelope)", () => {
  it("changed=false when fingerprints match", () => {
    const cols = [col("id", "long")];
    const fp = fingerprintOutputSchema(cols);
    const res = classifyEvolution(cols, cols, fp);
    expect(res.changed).toBe(false);
    expect(res.willBeSafe).toBe(true);
  });
  it("changed=true + envelope when fingerprints differ", () => {
    const prior = [col("id", "long")];
    const curr = [col("id", "long"), col("name", "string")];
    const res = classifyEvolution(prior, curr, fingerprintOutputSchema(prior));
    expect(res.changed).toBe(true);
    expect(res.willBeSafe).toBe(true);
    expect(res.safeOperations.length).toBe(1);
  });
  it("narrowing blocked unless caller opts-in at the admission layer", () => {
    const prior = [col("amount", "int64")];
    const curr = [col("amount", "int32")];
    const res = classifyEvolution(prior, curr, fingerprintOutputSchema(prior));
    expect(res.willBeSafe).toBe(false);
    expect(res.blockingIssues[0].op).toBe("narrowing");
  });
});
