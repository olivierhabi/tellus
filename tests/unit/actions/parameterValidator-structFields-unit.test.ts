import { describe, expect, it } from "vitest";
import {
  validateParameters,
  type ParameterDefinition,
} from "../../../src/actions/parameterValidator";

const exists = async () => true;

function structDef(structFields?: ParameterDefinition["structFields"]): ParameterDefinition {
  return {
    apiName: "spec",
    displayName: "Spec",
    type: "struct",
    required: true,
    structFields,
  };
}

describe("validateParameters — structFields", () => {
  it("coerces each field by its declared type", async () => {
    const def = structDef([
      { apiName: "name", type: "string", required: true },
      { apiName: "count", type: "integer" },
      { apiName: "ratio", type: "double" },
      { apiName: "active", type: "boolean", required: true },
      { apiName: "when", type: "timestamp" },
    ]);
    const result = await validateParameters(
      [def],
      {
        spec: {
          name: "bolt",
          count: "7",
          ratio: 0.5,
          active: "true",
          when: "2026-08-04T10:00:00.000Z",
        },
      },
      exists,
    );
    expect(result.valid).toBe(true);
    expect(result.resolvedParameters?.spec).toEqual({
      name: "bolt",
      count: 7,
      ratio: 0.5,
      active: true,
      when: "2026-08-04T10:00:00.000Z",
    });
  });

  it("rejects unknown struct keys (Foundry semantics)", async () => {
    const def = structDef([{ apiName: "name", type: "string" }]);
    const result = await validateParameters(
      [def],
      { spec: { name: "bolt", surprise: 1 } },
      exists,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("unknown struct field 'surprise'");
  });

  it("enforces per-field required", async () => {
    const def = structDef([
      { apiName: "name", type: "string", required: true },
      { apiName: "note", type: "string" },
    ]);
    const result = await validateParameters([def], { spec: {} }, exists);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("spec.name' is required");
  });

  it("rejects wrong field types", async () => {
    const def = structDef([{ apiName: "count", type: "integer" }]);
    const result = await validateParameters(
      [def],
      { spec: { count: "not-a-number" } },
      exists,
    );
    expect(result.valid).toBe(false);
  });

  it("keeps legacy plain-object pass-through when no fields are authored", async () => {
    const def = structDef(undefined);
    const anything = { arbitrary: { nested: [1, 2, 3] } };
    const result = await validateParameters([def], { spec: anything }, exists);
    expect(result.valid).toBe(true);
    expect(result.resolvedParameters?.spec).toEqual(anything);
  });

  it("still rejects non-object struct values", async () => {
    const def = structDef([{ apiName: "name", type: "string" }]);
    const result = await validateParameters([def], { spec: [1, 2] }, exists);
    expect(result.valid).toBe(false);
  });
});
