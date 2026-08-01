import { beforeEach, describe, expect, it, vi } from "vitest";

const { getByApiName, getLinkType, resolveObjectTypeApiName, query } = vi.hoisted(
  () => ({
    getByApiName: vi.fn(),
    getLinkType: vi.fn(),
    resolveObjectTypeApiName: vi.fn(),
    query: vi.fn(),
  }),
);

vi.mock("../../../src/services/objectTypeService", () => ({
  default: { getByApiName },
}));

vi.mock("../../../src/services/propertyService", () => ({
  default: {},
}));

vi.mock("../../../src/models/linkType", () => ({
  getByApiName: getLinkType,
  resolveObjectTypeApiName,
  resolvePropertyApiName: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query }));

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

  it("attaches a many-to-many link to an object created by the same rule", async () => {
    getLinkType.mockResolvedValue({
      api_name: "orderCustomers",
      cardinality: "MANY_TO_MANY",
      source_object_type: "order-type-id",
      target_object_type: "customer-type-id",
    });
    resolveObjectTypeApiName
      .mockResolvedValueOnce("Order")
      .mockResolvedValueOnce("Customer");

    const result = await compileRules(
      [
        {
          type: "createObject",
          objectType: "Order",
          properties: {
            orderId: { source: "parameter", param: "orderId" },
          },
          links: [
            {
              linkType: "orderCustomers",
              createdObjectSide: "source",
              otherObject: {
                source: "parameter",
                param: "customer",
              },
            },
          ],
        },
      ],
      { orderId: "ORD-1", customer: "CUS-1" },
      vi.fn().mockResolvedValue(null),
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([]);
    expect(result.edits).toEqual([
      expect.objectContaining({
        objectType: "Order",
        primaryKey: "ORD-1",
        operation: "create",
        linkEdits: [
          {
            linkTypeApiName: "orderCustomers",
            targetPrimaryKey: "CUS-1",
            operation: "add",
          },
        ],
      }),
    ]);
  });

  it("rejects creating the same object twice instead of merging duplicate creates", async () => {
    const createRule = {
      type: "createObject" as const,
      objectType: "Order",
      properties: {
        orderId: { source: "parameter" as const, param: "orderId" },
      },
    };
    const result = await compileRules(
      [createRule, createRule],
      { orderId: "ORD-1" },
      vi.fn().mockResolvedValue(null),
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([
      expect.stringContaining("Duplicate object creation at rules[1]"),
    ]);
  });

  it("rejects modifying an object after an earlier delete rule", async () => {
    const fetchObject = vi
      .fn()
      .mockResolvedValue({ orderId: "ORD-1", status: "Open" });
    const result = await compileRules(
      [
        {
          type: "deleteObject",
          objectType: "Order",
          objectReference: { source: "parameter", param: "orderId" },
        },
        {
          type: "modifyObject",
          objectType: "Order",
          objectReference: { source: "parameter", param: "orderId" },
          properties: {
            status: { source: "parameter", param: "status" },
          },
        },
      ],
      { orderId: "ORD-1", status: "Closed" },
      fetchObject,
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([
      expect.stringContaining("Invalid rule order at rules[1]"),
    ]);
  });
});

describe("compileRules interface object rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({
      rows: [
        {
          object_type: "Bug",
          property_mapping: { id: "bugId", title: "summary" },
        },
      ],
    });
    getByApiName.mockResolvedValue({
      objectType: { primary_key_property_id: "pk-id" },
      properties: [{ property_id: "pk-id", api_name: "bugId" }],
    });
  });

  it("resolves a create-interface rule to the selected implementation", async () => {
    const result = await compileRules(
      [
        {
          type: "createInterfaceObject",
          interfaceId: "Ticket",
          objectTypeParameter: "ticketType",
          properties: {
            id: { source: "parameter", param: "ticketId" },
            title: { source: "parameter", param: "title" },
          },
        },
      ],
      { ticketType: "Bug", ticketId: "BUG-1", title: "Broken export" },
      vi.fn().mockResolvedValue(null),
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([]);
    expect(result.edits).toEqual([
      expect.objectContaining({
        objectType: "Bug",
        primaryKey: "BUG-1",
        operation: "create",
        propertyValues: { bugId: "BUG-1", summary: "Broken export" },
      }),
    ]);
  });

  it("resolves modify and delete interface references to concrete objects", async () => {
    const objectFetcher = vi.fn().mockResolvedValue({
      bugId: "BUG-1",
      summary: "Old",
    });
    const result = await compileRules(
      [
        {
          type: "modifyInterfaceObject",
          interfaceId: "Ticket",
          interfaceReference: { source: "parameter", param: "ticket" },
          properties: {
            title: { source: "parameter", param: "title" },
          },
        },
        {
          type: "deleteInterfaceObject",
          interfaceId: "Ticket",
          interfaceReference: { source: "parameter", param: "otherTicket" },
        },
      ],
      {
        ticket: { objectType: "Bug", primaryKey: "BUG-1" },
        otherTicket: { objectType: "Bug", primaryKey: "BUG-2" },
        title: "New",
      },
      objectFetcher,
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );

    expect(result.errors).toEqual([]);
    expect(result.edits).toEqual([
      expect.objectContaining({
        objectType: "Bug",
        primaryKey: "BUG-1",
        operation: "update",
        propertyValues: { summary: "New" },
      }),
      expect.objectContaining({
        objectType: "Bug",
        primaryKey: "BUG-2",
        operation: "delete",
      }),
    ]);
  });

  it("rejects an object type that does not implement the interface", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await compileRules(
      [
        {
          type: "createInterfaceObject",
          interfaceId: "Ticket",
          objectTypeParameter: "ticketType",
          properties: {},
        },
      ],
      { ticketType: "Invoice" },
      vi.fn(),
      { ontologyId: "ontology-id", executedBy: "user-1" },
    );
    expect(result.errors).toContain(
      "Object type 'Invoice' does not implement interface 'Ticket'.",
    );
  });
});
