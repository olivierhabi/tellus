// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §5 — action submission criteria (Stage 3) unit tests.
// Pure evaluator: no DB, no IO.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { evaluateSubmissionCriteria } from "../../../src/actions/submissionCriteria";

describe("evaluateSubmissionCriteria", () => {
  it("allows everything when criteria is null/absent", () => {
    expect(evaluateSubmissionCriteria(null, {}).ok).toBe(true);
    expect(evaluateSubmissionCriteria(undefined, { a: 1 }).ok).toBe(true);
    expect(evaluateSubmissionCriteria({ conditions: [] }, {}).ok).toBe(true);
  });

  it("enforces a numeric parameter bound (match=all)", () => {
    const crit = { conditions: [{ parameter: "amount", operator: "lte", value: 1000 }] };
    expect(evaluateSubmissionCriteria(crit, { amount: 500 }).ok).toBe(true);
    const bad = evaluateSubmissionCriteria(crit, { amount: 5000 });
    expect(bad.ok).toBe(false);
    expect(bad.failures[0]).toMatch(/amount/);
  });

  it("enforces an 'in' set and 'exists'", () => {
    const crit = {
      conditions: [
        { parameter: "status", operator: "in", value: ["draft", "pending"] },
        { parameter: "reason", operator: "exists" },
      ],
    };
    expect(evaluateSubmissionCriteria(crit, { status: "draft", reason: "x" }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, { status: "closed", reason: "x" }).ok).toBe(false);
    expect(evaluateSubmissionCriteria(crit, { status: "draft" }).ok).toBe(false); // missing reason
  });

  it("match=all fails if ANY condition fails; match=any passes if ONE passes", () => {
    const conditions = [
      { parameter: "a", operator: "eq", value: 1 },
      { parameter: "b", operator: "eq", value: 2 },
    ];
    expect(evaluateSubmissionCriteria({ match: "all", conditions }, { a: 1, b: 9 }).ok).toBe(false);
    expect(evaluateSubmissionCriteria({ match: "any", conditions }, { a: 1, b: 9 }).ok).toBe(true);
    expect(evaluateSubmissionCriteria({ match: "any", conditions }, { a: 8, b: 9 }).ok).toBe(false);
  });

  it("evaluates subject role/group conditions", () => {
    const crit = { conditions: [{ anyRole: ["approver", "admin"] }, { group: "finance" }] };
    expect(evaluateSubmissionCriteria(crit, {}, { roles: ["approver"], groups: ["finance"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, {}, { roles: ["viewer"], groups: ["finance"] }).ok).toBe(false);
    expect(evaluateSubmissionCriteria(crit, {}, { roles: ["admin"], groups: ["eng"] }).ok).toBe(false);
  });

  it("evaluates an exact current-user condition", () => {
    const crit = { conditions: [{ username: "user-123" }] };
    expect(evaluateSubmissionCriteria(crit, {}, { username: "user-123" }).ok).toBe(true);
    const denied = evaluateSubmissionCriteria(crit, {}, { username: "user-456" });
    expect(denied.ok).toBe(false);
    expect(denied.failures[0]).toMatch(/required user/);
  });

  it("compares the authenticated current user with a live object property", () => {
    const crit = {
      conditions: [{
        currentUser: "username",
        parameter: "approvalId",
        objectType: "RssbApprovalRequest",
        objectProperty: "requestedByPrincipal",
        operator: "ne",
        description: "The maker cannot approve their own request.",
      }],
    };
    const operands = {
      "approvalId.requestedByPrincipal": "fraud.investigator@tellus.local",
    };
    expect(
      evaluateSubmissionCriteria(
        crit,
        { approvalId: "APR-1" },
        { username: "fraud.supervisor@tellus.local" },
        operands,
      ).ok,
    ).toBe(true);

    const denied = evaluateSubmissionCriteria(
      crit,
      { approvalId: "APR-1" },
      { username: "fraud.investigator@tellus.local" },
      operands,
    );
    expect(denied.ok).toBe(false);
    expect(denied.failures[0]).toBe("The maker cannot approve their own request.");
  });

  it("accepts a bare conditions array and ignores string labels", () => {
    const crit = [{ parameter: "x", operator: "gt", value: 0 }, "someLabel"];
    expect(evaluateSubmissionCriteria(crit, { x: 5 }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, { x: -1 }).ok).toBe(false);
  });
});
