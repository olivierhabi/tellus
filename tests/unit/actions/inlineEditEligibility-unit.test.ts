// ---------------------------------------------------------------------------
// Inline-edit eligibility validator — unit tests.
// Pure: no DB, no IO. Covers the full positive/negative matrix for every
// Foundry constraint (Pillar 2).
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  validateInlineEditEligibility,
  type InlineEditEligibilityInput,
} from "../../../src/actions/inlineEditEligibility";

function baseAction(overrides: Partial<InlineEditEligibilityInput> = {}): InlineEditEligibilityInput {
  return {
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
    ...overrides,
  };
}

describe("validateInlineEditEligibility", () => {
  // --- Happy path ---
  it("passes for a minimal eligible modify action", () => {
    const result = validateInlineEditEligibility(baseAction());
    expect(result.eligible).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes with modifyOrCreateObject rule", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        rules: [
          {
            type: "modifyOrCreateObject",
            objectType: "Ticket",
            objectReference: { source: "parameter", param: "ticket" },
            properties: { status: { source: "parameter", param: "status" } },
          },
        ],
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it("passes with default values sourced from the object reference parameter", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        parameters: [
          { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
          {
            apiName: "status",
            type: "string",
            defaultValue: { source: "objectProperty", param: "ticket", path: "status" },
          },
        ],
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it("passes with submission criteria on the object reference parameter", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        submissionCriteria: {
          match: "all",
          conditions: [{ parameter: "ticket", operator: "exists" }],
        },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  // --- Constraint 0: disabled (REMOVED — Foundry parity) ---
  // `is_enabled` is cosmetic metadata; it no longer gates inline-edit
  // binding eligibility (nor execution). An action with the flag false
  // satisfies every eligibility constraint just as an enabled one.
  it("does not gate eligibility on the (cosmetic) is_enabled flag", () => {
    const result = validateInlineEditEligibility(baseAction({ isEnabled: false }));
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_DISABLED")).toBe(false);
    expect(result.eligible).toBe(true);
  });

  // --- Constraint 1: single object of single type ---
  it("rejects an action with no modify rule", () => {
    const result = validateInlineEditEligibility(
      baseAction({ rules: [{ type: "createObject", objectType: "Ticket", properties: {} }] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_NO_MODIFY_RULE")).toBe(true);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_FORBIDDEN_RULES")).toBe(true);
  });

  it("rejects an action with multiple modify rules", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        rules: [
          { type: "modifyObject", objectType: "Ticket", objectReference: { source: "parameter", param: "ticket" }, properties: {} },
          { type: "modifyObject", objectType: "Ticket", objectReference: { source: "parameter", param: "ticket" }, properties: {} },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_MULTIPLE_MODIFY_RULES")).toBe(true);
  });

  it("rejects an action with modify rules on multiple object types", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        rules: [
          { type: "modifyObject", objectType: "Ticket", objectReference: { source: "parameter", param: "ticket" }, properties: {} },
          { type: "modifyObject", objectType: "User", objectReference: { source: "parameter", param: "ticket" }, properties: {} },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_MULTIPLE_MODIFY_RULES")).toBe(true);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_MULTIPLE_OBJECT_TYPES")).toBe(true);
  });

  it("rejects an action with forbidden rule types (create, delete, link)", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        rules: [
          { type: "modifyObject", objectType: "Ticket", objectReference: { source: "parameter", param: "ticket" }, properties: {} },
          { type: "deleteObject", objectType: "Ticket", objectReference: { source: "parameter", param: "ticket" } },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_FORBIDDEN_RULES")).toBe(true);
  });

  it("rejects an action with multiple object_reference parameters", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        parameters: [
          { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
          { apiName: "other", type: "object_reference", objectType: "User" },
          { apiName: "status", type: "string" },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_MULTIPLE_OBJECT_REFERENCE_PARAMS")).toBe(true);
  });

  // --- Constraint 2: default values ---
  it("rejects a parameter with a static default", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        parameters: [
          { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
          { apiName: "status", type: "string", defaultValue: { source: "static", value: "Open" } },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_FORBIDDEN_DEFAULT")).toBe(true);
  });

  it("rejects a parameter with a CurrentUser default", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        parameters: [
          { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
          { apiName: "assignee", type: "string", defaultValue: { source: "currentUser" } },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_FORBIDDEN_DEFAULT")).toBe(true);
  });

  it("rejects a parameter with a CurrentTime default", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        parameters: [
          { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
          { apiName: "updatedAt", type: "timestamp", defaultValue: { source: "currentTimestamp" } },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_FORBIDDEN_DEFAULT")).toBe(true);
  });

  // --- Constraint 3: no side effects ---
  it("rejects an action with side effects", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        sideEffects: [{ kind: "webhook", webhookId: "w1", webhookVersion: 1, inputs: {} }],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_SIDE_EFFECTS_PRESENT")).toBe(true);
  });

  it("rejects an action with a notification side effect", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        sideEffects: [{ kind: "notification", channel: "email", recipients: [], templateId: "t1", templateParameters: {} }],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_SIDE_EFFECTS_PRESENT")).toBe(true);
  });

  it("rejects an action with a writeback config", () => {
    const result = validateInlineEditEligibility(
      baseAction({ writebackConfig: { webhookId: "w1", webhookVersion: 1, inputs: {}, failurePolicy: "abort" } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_WRITEBACK_CONFIG_PRESENT")).toBe(true);
  });

  // --- Constraint 4: submission criteria ---
  it("rejects submission criteria referencing a linked object parameter", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        parameters: [
          { apiName: "ticket", type: "object_reference", objectType: "Ticket" },
          { apiName: "linkedAirport", type: "object_reference", objectType: "Airport" },
          { apiName: "status", type: "string" },
        ],
        submissionCriteria: {
          match: "all",
          conditions: [
            { parameter: "ticket", operator: "exists" },
            { parameter: "linkedAirport", operator: "exists" },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    // The linkedAirport object_reference triggers both multi-obj-ref AND criteria violations.
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_MULTIPLE_OBJECT_REFERENCE_PARAMS")).toBe(true);
    expect(result.violations.some((v) => v.code === "INLINE_EDIT_CRITERIA_LINKED_OBJECT")).toBe(true);
  });

  it("allows submission criteria on a non-object_reference parameter", () => {
    const result = validateInlineEditEligibility(
      baseAction({
        submissionCriteria: {
          match: "all",
          conditions: [{ parameter: "status", operator: "in", value: ["Open", "Closed"] }],
        },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  // --- Adversarial input ---
  it("does not throw on null/undefined rules or parameters", () => {
    expect(() =>
      validateInlineEditEligibility({ ...baseAction(), rules: null as unknown as never[] }),
    ).not.toThrow();
    expect(() =>
      validateInlineEditEligibility({ ...baseAction(), parameters: null as unknown as never[] }),
    ).not.toThrow();
  });

  it("does not throw on malformed submission criteria", () => {
    expect(() =>
      validateInlineEditEligibility({
        ...baseAction(),
        submissionCriteria: "garbage" as unknown as never,
      }),
    ).not.toThrow();
  });
});
