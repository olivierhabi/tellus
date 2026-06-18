// =============================================================================
// B09 — Action Type Wizard unit tests
//
// Spec §B09 + §C Phase 6 Step 1.
//
// Contract IDs:
//   B09 C-01: parameter list rejects duplicate apiName
//   B09 C-02: schema rejects malformed apiName
//   B09 C-03: parameter binding discriminator: user vs static
//   B09 C-04: submission criteria User → self accepted
//   B09 C-05: maxAffectedObjects bounded to 10_000
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  actionTypeRequestSchema,
  assertParameterShape,
} from "../../../src/services/workshop/actionTypeWizard.js";
import { WorkshopError } from "../../../src/services/workshop/errors.js";

const baseReq = (overrides: Partial<{ apiName: string; parameters: unknown[] }> = {}) => ({
  ontologyRid: "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
  apiName: overrides.apiName ?? "olivierAssignOrder",
  displayName: "Olivier Assign Order",
  parameters: overrides.parameters ?? [
    { apiName: "assignee", binding: { kind: "user" }, type: "user", required: true },
    {
      apiName: "status",
      binding: { kind: "static", value: "assigned" },
      type: "string",
      required: true,
    },
  ],
  submissionCriteria: { kind: "user", target: "self" },
});

describe("B09 C-01: parameter list rejects duplicate apiName", () => {
  it("DuplicateParameterApiName 400", () => {
    const parsed = actionTypeRequestSchema.parse(
      baseReq({
        parameters: [
          { apiName: "x", binding: { kind: "user" }, type: "string", required: true },
          { apiName: "x", binding: { kind: "user" }, type: "string", required: true },
        ],
      }),
    );
    try {
      assertParameterShape(parsed);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkshopError);
      expect((err as WorkshopError).errorName).toBe(
        "Tellus:Workshop:DuplicateParameterApiName",
      );
    }
  });
});

describe("B09 C-02: schema rejects malformed apiName", () => {
  it.each([
    "1startsWithDigit",
    "has-dash",
    "has space",
    "",
    "with.dot",
  ])("rejects '%s'", (apiName) => {
    expect(actionTypeRequestSchema.safeParse(baseReq({ apiName })).success).toBe(
      false,
    );
  });

  it("accepts a clean PascalCase or camelCase api name", () => {
    expect(actionTypeRequestSchema.safeParse(baseReq({ apiName: "MyAction" })).success).toBe(true);
    expect(actionTypeRequestSchema.safeParse(baseReq({ apiName: "myAction_42" })).success).toBe(true);
  });
});

describe("B09 C-03: parameter binding discriminator", () => {
  it("user-bound parameter has no `value`", () => {
    const r = actionTypeRequestSchema.parse(baseReq());
    expect(r.parameters[0]!.binding.kind).toBe("user");
    expect(r.parameters[1]!.binding.kind).toBe("static");
    if (r.parameters[1]!.binding.kind === "static") {
      expect(r.parameters[1]!.binding.value).toBe("assigned");
    }
  });
  it("static parameter without `value` is rejected", () => {
    const broken = baseReq({
      parameters: [
        // intentionally drop `value`
        { apiName: "x", binding: { kind: "static" }, type: "string", required: true },
      ],
    });
    expect(actionTypeRequestSchema.safeParse(broken).success).toBe(false);
  });
});

describe("B09 C-04: submission criteria User → self", () => {
  it("accepted", () => {
    expect(actionTypeRequestSchema.safeParse(baseReq()).success).toBe(true);
  });
  it("alternative kinds rejected", () => {
    const r = {
      ...baseReq(),
      submissionCriteria: { kind: "group", target: "admins" },
    } as unknown;
    expect(actionTypeRequestSchema.safeParse(r).success).toBe(false);
  });
  it("null is accepted (no submission criteria)", () => {
    const r = { ...baseReq(), submissionCriteria: null };
    expect(actionTypeRequestSchema.safeParse(r).success).toBe(true);
  });
});

describe("B09 C-05: maxAffectedObjects bounded", () => {
  it.each([0, -1, 10_001, 1_000_000])("rejects %s", (n) => {
    expect(
      actionTypeRequestSchema.safeParse({ ...baseReq(), maxAffectedObjects: n })
        .success,
    ).toBe(false);
  });
  it("default is 1000 when omitted", () => {
    const r = actionTypeRequestSchema.parse(baseReq());
    expect(r.maxAffectedObjects).toBe(1000);
  });
});
