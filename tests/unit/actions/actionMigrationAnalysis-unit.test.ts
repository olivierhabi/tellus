import { describe, it, expect } from "vitest";
import { classifyActionTypeForMigration } from "../../../src/actions/actionMigrationAnalysis";

describe("classifyActionTypeForMigration", () => {
  it("marks a clean typed modify action compatible", () => {
    const r = classifyActionTypeForMigration({
      parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
      rules: [{ type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
    });
    expect(r.classification).toBe("compatible");
    expect(r.findings).toEqual([]);
  });

  it("marks incompatible when modify uses a primitive string parameter", () => {
    const r = classifyActionTypeForMigration({
      parameters: [{ apiName: "ref", type: "string" }],
      rules: [{ type: "deleteObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" } }],
    });
    expect(r.classification).toBe("incompatible");
    expect(r.findings.some((f) => f.severity === "blocker")).toBe(true);
  });

  it("marks incompatible when object_reference param has no objectType", () => {
    const r = classifyActionTypeForMigration({
      parameters: [{ apiName: "ref", type: "object_reference" }],
      rules: [{ type: "deleteObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" } }],
    });
    expect(r.classification).toBe("incompatible");
  });

  it("marks potentially_incompatible when create + modify share an object type", () => {
    const r = classifyActionTypeForMigration({
      parameters: [
        { apiName: "ref", type: "object_reference", objectType: "Customer" },
        { apiName: "pk", type: "string" },
      ],
      rules: [
        { type: "createObject", objectType: "Customer", properties: {} },
        { type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} },
      ],
    });
    expect(r.classification).toBe("potentially_incompatible");
  });

  it("does not claim certainty for runtime-collision scenarios", () => {
    // hasPotential is true even when create+modify object types match — never 'compatible'.
    const r = classifyActionTypeForMigration({
      parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
      rules: [
        { type: "createObject", objectType: "Customer", properties: {} },
        { type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} },
      ],
    });
    expect(r.classification).not.toBe("compatible");
  });

  it("flags delete rules as becoming restrict and classifies requires_review", () => {
    const r = classifyActionTypeForMigration({
      parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
      rules: [{ type: "deleteObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" } }],
    });
    expect(r.classification).toBe("requires_review");
    expect(r.findings.some((f) => f.severity === "info" && /restrict/.test(f.message))).toBe(true);
  });

  it("marks incompatible when a rule is missing objectReference", () => {
    const r = classifyActionTypeForMigration({
      parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
      rules: [{ type: "modifyObject", objectType: "Customer", properties: {} }],
    });
    expect(r.classification).toBe("incompatible");
  });
});
