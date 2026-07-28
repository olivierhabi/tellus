import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  query: mocks.query,
}));

import {
  getActionTypeV2,
  getObjectTypeV2,
  toObjectPropertyType,
  toReleaseStatus,
} from "../../../src/services/oss/omsV2Mapper";

describe("OMS v2 mapper contract", () => {
  beforeEach(() => mocks.query.mockReset());

  it("maps internal scalar and array property types to ObjectPropertyType", () => {
    expect(toObjectPropertyType("string")).toEqual({ type: "string" });
    expect(toObjectPropertyType("media_reference")).toEqual({
      type: "mediaReference",
    });
    expect(toObjectPropertyType("string_array")).toEqual({
      type: "array",
      subType: { type: "string" },
      reducers: [],
    });
    expect(toObjectPropertyType("struct")).toEqual({
      type: "struct",
      structFieldTypes: [],
    });
  });

  it("maps release status without exposing internal casing", () => {
    expect(toReleaseStatus("active")).toBe("ACTIVE");
    expect(toReleaseStatus("experimental")).toBe("EXPERIMENTAL");
    expect(toReleaseStatus("deprecated")).toBe("DEPRECATED");
  });

  it("returns required ObjectTypeV2 fields and reads property.base_type", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            object_type_id: "ot-1",
            api_name: "Employee",
            display_name: "Employee",
            description: "A person",
            icon: "person",
            icon_color: "#123456",
            status: "active",
            primary_key_property_id: "p-id",
            title_property_id: "p-name",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            property_id: "p-id",
            api_name: "employeeId",
            display_name: "Employee ID",
            description: null,
            base_type: "string",
          },
          {
            property_id: "p-name",
            api_name: "name",
            display_name: "Name",
            description: null,
            base_type: "string",
          },
        ],
      });

    const result = await getObjectTypeV2("ontology-1", "Employee");

    expect(String(mocks.query.mock.calls[1]?.[0])).toContain("base_type");
    expect(result).toMatchObject({
      apiName: "Employee",
      primaryKey: "employeeId",
      titleProperty: "name",
      status: "ACTIVE",
      aliases: [],
      datasources: [],
      properties: {
        employeeId: { dataType: { type: "string" } },
      },
    });
  });

  it("fails typed instead of emitting an invalid object type without a primary key", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            object_type_id: "ot-1",
            api_name: "Broken",
            display_name: "Broken",
            status: "active",
            primary_key_property_id: null,
            title_property_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getObjectTypeV2("ontology-1", "Broken")).rejects.toMatchObject({
      errorName: "InvalidObjectTypeMetadata",
    });
  });

  it("adapts internal action rules to LogicRule discriminators", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          action_type_id: "action-1",
          api_name: "Promote",
          display_name: "Promote",
          description: "",
          parameters: [
            {
              apiName: "employee",
              displayName: "Employee",
              type: "object_reference",
              objectType: "Employee",
              required: true,
            },
          ],
          rules: [
            {
              type: "modifyObject",
              objectType: "Employee",
              objectReference: {
                source: "parameter",
                param: "employee",
              },
              properties: {
                level: { source: "static", value: "Senior" },
              },
            },
          ],
        },
      ],
    });

    const result = await getActionTypeV2("ontology-1", "Promote");

    expect(result).toMatchObject({
      apiName: "Promote",
      parameters: {
        employee: {
          dataType: {
            type: "object",
            objectApiName: "Employee",
            objectTypeApiName: "Employee",
          },
        },
      },
      operations: [
        {
          type: "modifyObject",
          objectTypeApiName: "Employee",
        },
      ],
    });
  });

  it("maps incomplete legacy modify rules from their high-level object type", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          action_type_id: "action-legacy",
          api_name: "LegacyModify",
          display_name: "Legacy Modify",
          parameters: [],
          rules: [{ type: "modifyObject", objectType: "Employee" }],
        },
      ],
    });

    await expect(
      getActionTypeV2("ontology-1", "LegacyModify"),
    ).resolves.toMatchObject({
      operations: [
        { type: "modifyObject", objectTypeApiName: "Employee" },
      ],
    });
  });

  it("resolves legacy link endpoint types from object parameters", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            action_type_id: "action-link",
            api_name: "LinkEmployees",
            display_name: "Link Employees",
            parameters: [
              {
                apiName: "manager",
                type: "object_reference",
                objectType: "Employee",
              },
              {
                apiName: "report",
                type: "object_reference",
                objectType: "Employee",
              },
            ],
            rules: [
              {
                type: "addLink",
                linkType: "reportsTo",
                sourceObject: { source: "parameter", param: "report" },
                targetObject: { source: "parameter", param: "manager" },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            api_name: "reportsTo",
            source_object_type: "Employee",
            target_object_type: "Employee",
          },
        ],
      });

    await expect(
      getActionTypeV2("ontology-1", "LinkEmployees"),
    ).resolves.toMatchObject({
      operations: [
        {
          type: "createLink",
          linkTypeApiNameAtoB: "reportsTo",
          aSideObjectTypeApiName: "Employee",
          bSideObjectTypeApiName: "Employee",
        },
      ],
    });
  });

  it("does not fabricate a concrete link for an interface-link rule", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            action_type_id: "action-interface-link",
            api_name: "RegisterBuyerSeller",
            display_name: "Register Buyer Seller",
            parameters: [],
            rules: [
              {
                type: "createInterfaceLink",
                interfaceLinkConstraint: "BuyerSellerContract",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      getActionTypeV2("ontology-1", "RegisterBuyerSeller"),
    ).resolves.toMatchObject({ operations: [] });
  });
});
