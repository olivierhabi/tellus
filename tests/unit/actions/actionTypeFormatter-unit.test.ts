import { describe, expect, it } from "vitest";
import {
  ACTION_PARAMETER_RID_PREFIX,
  ACTION_RULE_RID_PREFIX,
  ensureParameterRids,
  ensureRuleRids,
  formatActionType,
  resolveWebhookOutputPath,
} from "../../../src/routes/actionTypes";

describe("formatActionType", () => {
  it("preserves persisted creation metadata on every read surface", () => {
    const formatted = formatActionType({
      action_type_id: "action-rid",
      api_name: "updateOrder",
      display_name: "Update order",
      description: "",
      icon_name: "array-timestamp",
      icon_color: "#28A39A",
      save_location_rid: "ri.compass.main.project.project-1",
      parameters: [],
      rules: [],
      submission_criteria: null,
      side_effects: null,
      max_affected_objects: 10_000,
      is_enabled: true,
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
      created_by: "user-1",
    });

    expect(formatted).toMatchObject({
      rid: "action-rid",
      icon: "array-timestamp",
      iconColor: "#28A39A",
      saveLocationRid: "ri.compass.main.project.project-1",
    });
  });

  it("returns explicit nulls for legacy rows without metadata", () => {
    expect(formatActionType({} as any).icon).toBeNull();
    expect(formatActionType({} as any).iconColor).toBeNull();
    expect(formatActionType({} as any).saveLocationRid).toBeNull();
  });

  // Phase 6.2 — versioned definition surface (migration 132 backfill).
  it("surfaces definitionVersion + definitionHash when the column is set", () => {
    const formatted = formatActionType({
      action_type_id: "x",
      api_name: "x",
      display_name: "x",
      definition_version: 7,
      definition_hash: "sha256:abc",
    } as any);
    expect(formatted).toMatchObject({
      definitionVersion: 7,
      definitionHash: "sha256:abc",
    });
  });

  it("falls back to definitionVersion=1 + a canonical hash for pre-132 legacy rows", () => {
    expect(formatActionType({} as any)).toMatchObject({
      definitionVersion: 1,
      definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("ensureParameterRids", () => {
  it("assigns Palantir-style authoring RIDs to new parameters", () => {
    const [parameter] = ensureParameterRids([
      { apiName: "orderId", displayName: "Order ID", type: "string" },
    ]);

    expect(parameter.rid).toMatch(
      /^ri\.actions\.main\.parameter\.[0-9a-f-]{36}$/,
    );
  });

  it("preserves only RIDs already owned by the action", () => {
    const submittedRid = `${ACTION_PARAMETER_RID_PREFIX}11111111-1111-4111-8111-111111111111`;
    const existingRid = `${ACTION_PARAMETER_RID_PREFIX}22222222-2222-4222-8222-222222222222`;

    const parameters = ensureParameterRids(
      [
        { apiName: "renamedOrderId", rid: submittedRid },
        { apiName: "quantity" },
        { apiName: "newParameter", rid: "ri.actions.main.parameter.forged" },
      ],
      [
        { apiName: "orderId", rid: submittedRid },
        { apiName: "quantity", rid: existingRid },
      ],
    );

    expect(parameters[0].rid).toBe(submittedRid);
    expect(parameters[1].rid).toBe(existingRid);
    expect(parameters[2].rid).toMatch(
      /^ri\.actions\.main\.parameter\.[0-9a-f-]{36}$/,
    );
    expect(parameters[2].rid).not.toBe("ri.actions.main.parameter.forged");
  });
});

describe("ensureRuleRids", () => {
  it("assigns stable versioned authoring identity without dropping rule fields", () => {
    const [rule] = ensureRuleRids([
      {
        type: "createObject",
        objectType: "Order",
        properties: { orderId: { source: "parameter", param: "orderId" } },
        extensionField: { retained: true },
      },
    ]);

    expect(rule).toMatchObject({
      ruleId: expect.stringMatching(
        /^ri\.actions\.main\.rule\.[0-9a-f-]{36}$/,
      ),
      schemaVersion: 1,
      type: "createObject",
      objectType: "Order",
      extensionField: { retained: true },
    });
  });

  it("preserves owned identities through reorder and replaces forged duplicates", () => {
    const firstRid = `${ACTION_RULE_RID_PREFIX}11111111-1111-4111-8111-111111111111`;
    const secondRid = `${ACTION_RULE_RID_PREFIX}22222222-2222-4222-8222-222222222222`;
    const existing = [
      { ruleId: firstRid, type: "createObject", objectType: "Order" },
      { ruleId: secondRid, type: "deleteObject", objectType: "Order" },
    ];

    const rules = ensureRuleRids(
      [
        { ruleId: secondRid, type: "deleteObject", objectType: "Order" },
        { ruleId: firstRid, type: "createObject", objectType: "Order" },
        { ruleId: firstRid, type: "modifyObject", objectType: "Order" },
        {
          ruleId: `${ACTION_RULE_RID_PREFIX}33333333-3333-4333-8333-333333333333`,
          type: "createObject",
          objectType: "Customer",
        },
      ],
      existing,
    );

    expect(rules[0].ruleId).toBe(secondRid);
    expect(rules[1].ruleId).toBe(firstRid);
    expect(rules[2].ruleId).toMatch(
      /^ri\.actions\.main\.rule\.[0-9a-f-]{36}$/,
    );
    expect(rules[2].ruleId).not.toBe(firstRid);
    expect(rules[3].ruleId).toMatch(
      /^ri\.actions\.main\.rule\.[0-9a-f-]{36}$/,
    );
    expect(rules[3].ruleId).not.toContain(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("surfaces migrated identity on reads and preserves explicit array order", () => {
    const firstRid = `${ACTION_RULE_RID_PREFIX}11111111-1111-4111-8111-111111111111`;
    const secondRid = `${ACTION_RULE_RID_PREFIX}22222222-2222-4222-8222-222222222222`;
    const formatted = formatActionType({
      rules: [
        { ruleId: secondRid, type: "deleteObject", objectType: "Order" },
        { ruleId: firstRid, type: "createObject", objectType: "Order" },
      ],
    });

    expect(formatted.rules).toEqual([
      {
        ruleId: secondRid,
        schemaVersion: 1,
        type: "deleteObject",
        objectType: "Order",
      },
      {
        ruleId: firstRid,
        schemaVersion: 1,
        type: "createObject",
        objectType: "Order",
      },
    ]);
  });

  it("does not steal a neighbouring RID when duplicating an identified rule", () => {
    const firstRid = `${ACTION_RULE_RID_PREFIX}11111111-1111-4111-8111-111111111111`;
    const secondRid = `${ACTION_RULE_RID_PREFIX}22222222-2222-4222-8222-222222222222`;
    const rules = ensureRuleRids(
      [
        { ruleId: firstRid, type: "createObject", objectType: "Order" },
        { type: "createObject", objectType: "Order" },
        { ruleId: secondRid, type: "deleteObject", objectType: "Order" },
      ],
      [
        { ruleId: firstRid, type: "createObject", objectType: "Order" },
        { ruleId: secondRid, type: "deleteObject", objectType: "Order" },
      ],
    );

    expect(rules[0].ruleId).toBe(firstRid);
    expect(rules[1].ruleId).not.toBe(secondRid);
    expect(rules[2].ruleId).toBe(secondRid);
  });
});

describe("resolveWebhookOutputPath", () => {
  const outputType = {
    kind: "record" as const,
    fields: [
      {
        id: "result",
        required: true,
        type: {
          kind: "record" as const,
          fields: [
            {
              id: "items",
              required: true,
              type: {
                kind: "list" as const,
                elementType: {
                  kind: "record" as const,
                  fields: [
                    {
                      id: "externalId",
                      required: true,
                      type: { kind: "string" as const },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  };

  it("accepts nested record and list paths", () => {
    expect(
      resolveWebhookOutputPath(
        outputType,
        "/result/items/0/externalId",
      ),
    ).toBeNull();
  });

  it("detects stale nested paths and invalid list selectors", () => {
    expect(resolveWebhookOutputPath(outputType, "/result/missing")).toContain(
      "missing record field",
    );
    expect(
      resolveWebhookOutputPath(outputType, "/result/items/not-an-index"),
    ).toContain("non-negative array index");
  });

  it("rejects malformed pointers and primitive traversal", () => {
    expect(resolveWebhookOutputPath(outputType, "result/items")).toContain(
      "RFC 6901",
    );
    expect(
      resolveWebhookOutputPath(
        outputType,
        "/result/items/0/externalId/child",
      ),
    ).toContain("primitive output type 'string'");
  });
});
