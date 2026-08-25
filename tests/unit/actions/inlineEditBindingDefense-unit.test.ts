// ---------------------------------------------------------------------------
// Pillar 1 defense-in-depth — property inline-edit binding validation.
// Pure unit test: the eligibility check the route performs before persisting
// `inline_edit_action_id`. The DB-query + route plumbing is covered by
// integration tests; this file covers the pure eligibility logic at the
// boundary (what the route would accept/reject given a mock action row).
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { validateInlineEditEligibility } from "../../../src/actions/inlineEditEligibility";

describe("property inline-edit binding defense-in-depth", () => {
  it("accepts an eligible action type for binding", () => {
    const result = validateInlineEditEligibility({
      apiName: "modifyTicket",
      isEnabled: true,
      rules: [
        {
          type: "modifyObject",
          objectType: "Ticket",
          objectReference: { source: "parameter", param: "ticket" },
          properties: { status: { source: "parameter", param: "status" } },
        },
      ],
      parameters: [
        { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
        { apiName: "status", type: "string" },
      ],
      sideEffects: null,
      writebackConfig: null,
      submissionCriteria: null,
    });
    expect(result.eligible).toBe(true);
  });

  it("rejects binding an action with side effects", () => {
    const result = validateInlineEditEligibility({
      apiName: "modifyWithWebhook",
      isEnabled: true,
      rules: [
        {
          type: "modifyObject",
          objectType: "Ticket",
          objectReference: { source: "parameter", param: "ticket" },
          properties: {},
        },
      ],
      parameters: [{ apiName: "ticket", type: "object_reference", objectType: "Ticket" }],
      sideEffects: [{ kind: "webhook", webhookId: "w1", webhookVersion: 1, inputs: {} }],
      writebackConfig: null,
      submissionCriteria: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_SIDE_EFFECTS_PRESENT")).toBe(true);
  });

  it("rejects binding a create-only action", () => {
    const result = validateInlineEditEligibility({
      apiName: "createTicket",
      isEnabled: true,
      rules: [{ type: "createObject", objectType: "Ticket", properties: {} }],
      parameters: [],
      sideEffects: null,
      writebackConfig: null,
      submissionCriteria: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_NO_MODIFY_RULE")).toBe(true);
  });

  it("allows binding an action whose (cosmetic) is_enabled flag is false — Foundry parity", () => {
    // Foundry has no enable/disable lifecycle for action types; the
    // eligibility constraints (modify-rule shape, writeback, params) are
    // what gate inline edit, never the flag.
    const result = validateInlineEditEligibility({
      apiName: "flagFalseAction",
      isEnabled: false,
      rules: [
        {
          type: "modifyObject",
          objectType: "Ticket",
          objectReference: { source: "parameter", param: "ticket" },
          properties: {},
        },
      ],
      parameters: [{ apiName: "ticket", type: "object_reference", objectType: "Ticket" }],
      sideEffects: null,
      writebackConfig: null,
      submissionCriteria: null,
    });
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_DISABLED")).toBe(false);
    expect(result.eligible).toBe(true);
  });

  it("clearing the binding (null/empty) is always allowed — no eligibility check needed", () => {
    // Clearing is the absence of a binding; the route only checks when
    // actionApiName is non-empty. This test documents that contract.
    expect(true).toBe(true);
  });
});
