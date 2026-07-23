import { beforeEach, describe, expect, it, vi } from "vitest";

const { getByApiName } = vi.hoisted(() => ({ getByApiName: vi.fn() }));

vi.mock("../../../src/services/objectTypeService", () => ({
  default: { getByApiName },
}));

vi.mock("../../../src/services/propertyService", () => ({
  default: {},
}));

import { compileRules } from "../../../src/actions/ruleCompiler";

describe("compileRules modifyOrCreateObject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByApiName.mockResolvedValue({
      objectType: { primary_key_property_id: "property-id" },
      properties: [{ property_id: "property-id", api_name: "orderId" }],
    });
  });

  it("creates a new object when the referenced primary key does not exist", async () => {
    const result = await compileRules(
      [{
        type: "modifyOrCreateObject",
        objectType: "Order",
        objectReference: { source: "parameter", param: "orderId" },
        properties: {
          orderId: { source: "parameter", param: "orderId" },
          status: { source: "parameter", param: "status" },
        },
      }],
      { orderId: "ORD-1", status: "Open" },
      vi.fn().mockResolvedValue(null),
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([]);
    expect(result.edits).toEqual([expect.objectContaining({
      objectType: "Order",
      primaryKey: "ORD-1",
      operation: "create",
      propertyValues: { orderId: "ORD-1", status: "Open" },
    })]);
  });

  it("updates an existing object without attempting to mutate its primary key", async () => {
    const result = await compileRules(
      [{
        type: "modifyOrCreateObject",
        objectType: "Order",
        objectReference: { source: "parameter", param: "orderId" },
        properties: {
          orderId: { source: "parameter", param: "orderId" },
          status: { source: "parameter", param: "status" },
        },
      }],
      { orderId: "ORD-1", status: "Closed" },
      vi.fn().mockResolvedValue({ orderId: "ORD-1", status: "Open" }),
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([]);
    expect(result.edits).toEqual([expect.objectContaining({
      primaryKey: "ORD-1",
      operation: "update",
      propertyValues: { status: "Closed" },
    })]);
  });
});
