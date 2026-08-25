// ---------------------------------------------------------------------------
// Submission criteria — nested logical groups, type-filtered operators,
// organization and execution-context leaves.
//
// These back the Ontology Manager "Security & Submission Criteria" editor,
// which authors arbitrarily nested `all`/`any`/`none` groups. Before this
// layer existed the evaluator treated an unrecognized condition object as
// always-pass, so an FE-authored group would LOOK enforced while permitting
// every submission. Every assertion here is really a fail-closed assertion.
//
// Pure evaluator: no DB, no IO.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  evaluateSubmissionCriteria,
  extractConditions,
} from "../../../src/actions/submissionCriteria";

describe("nested condition groups", () => {
  it("evaluates an `any` group nested inside the root `all`", () => {
    // amount <= 1000 AND (role approver OR group finance)
    const crit = {
      match: "all",
      conditions: [
        { parameter: "amount", operator: "lte", value: 1000 },
        {
          operator: "any",
          conditions: [{ anyRole: ["approver"] }, { group: "finance" }],
        },
      ],
    };
    expect(
      evaluateSubmissionCriteria(crit, { amount: 10 }, { roles: ["approver"], groups: [] }).ok,
    ).toBe(true);
    expect(
      evaluateSubmissionCriteria(crit, { amount: 10 }, { roles: [], groups: ["finance"] }).ok,
    ).toBe(true);
    // Inner group unsatisfied → whole criteria fails.
    expect(
      evaluateSubmissionCriteria(crit, { amount: 10 }, { roles: ["viewer"], groups: ["eng"] }).ok,
    ).toBe(false);
    // Outer leaf unsatisfied → whole criteria fails even with the group met.
    expect(
      evaluateSubmissionCriteria(crit, { amount: 9999 }, { roles: ["approver"], groups: [] }).ok,
    ).toBe(false);
  });

  it("evaluates a `none` group as a negation of its children", () => {
    const crit = {
      conditions: [
        {
          operator: "none",
          conditions: [
            { parameter: "status", operator: "eq", value: "closed" },
            { group: "blocked" },
          ],
        },
      ],
    };
    expect(evaluateSubmissionCriteria(crit, { status: "draft" }, { groups: ["eng"] }).ok).toBe(true);
    // A matching child makes `none` fail.
    expect(evaluateSubmissionCriteria(crit, { status: "closed" }, { groups: ["eng"] }).ok).toBe(false);
    expect(evaluateSubmissionCriteria(crit, { status: "draft" }, { groups: ["blocked"] }).ok).toBe(false);
  });

  it("nests groups several levels deep", () => {
    // all( any( none( a=1 ), b=2 ) )
    const crit = {
      conditions: [
        {
          operator: "all",
          conditions: [
            {
              operator: "any",
              conditions: [
                { operator: "none", conditions: [{ parameter: "a", operator: "eq", value: 1 }] },
                { parameter: "b", operator: "eq", value: 2 },
              ],
            },
          ],
        },
      ],
    };
    expect(evaluateSubmissionCriteria(crit, { a: 9, b: 9 }).ok).toBe(true); // none() passes
    expect(evaluateSubmissionCriteria(crit, { a: 1, b: 2 }).ok).toBe(true); // b=2 passes
    expect(evaluateSubmissionCriteria(crit, { a: 1, b: 9 }).ok).toBe(false); // neither
  });

  it("uses a group's description as its failure message", () => {
    const crit = {
      conditions: [
        {
          operator: "any",
          description: "You must be an approver or in finance.",
          conditions: [{ anyRole: ["approver"] }, { group: "finance" }],
        },
      ],
    };
    const denied = evaluateSubmissionCriteria(crit, {}, { roles: [], groups: [] });
    expect(denied.ok).toBe(false);
    expect(denied.failures).toContain("You must be an approver or in finance.");
  });

  it("treats an empty group as vacuously satisfied", () => {
    // An unfinished group in the editor must not block every submission.
    expect(evaluateSubmissionCriteria({ conditions: [{ operator: "any", conditions: [] }] }, {}).ok).toBe(true);
  });

  it("reads an unrecognized group operator as `all` (the strictest safe reading)", () => {
    const crit = {
      conditions: [
        {
          operator: "sometimes",
          conditions: [
            { parameter: "a", operator: "eq", value: 1 },
            { parameter: "b", operator: "eq", value: 2 },
          ],
        },
      ],
    };
    expect(evaluateSubmissionCriteria(crit, { a: 1, b: 2 }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, { a: 1, b: 9 }).ok).toBe(false);
  });

  it("fails closed past the nesting depth cap instead of recursing forever", () => {
    let node: any = { parameter: "a", operator: "eq", value: 1 };
    for (let i = 0; i < 40; i += 1) node = { operator: "all", conditions: [node] };
    const result = evaluateSubmissionCriteria({ conditions: [node] }, { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/nested deeper than/);
  });
});

describe("type-filtered operators", () => {
  it("`matches` applies a regular expression", () => {
    const crit = { conditions: [{ parameter: "code", operator: "matches", value: "^RW-\\d{3}$" }] };
    expect(evaluateSubmissionCriteria(crit, { code: "RW-123" }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, { code: "RW-12" }).ok).toBe(false);
    expect(evaluateSubmissionCriteria(crit, { code: null }).ok).toBe(false);
  });

  it("`matches` fails closed on an unparseable pattern", () => {
    const crit = { conditions: [{ parameter: "code", operator: "matches", value: "([" }] };
    expect(evaluateSubmissionCriteria(crit, { code: "anything" }).ok).toBe(false);
  });

  it("`contains` / `containsAny` test a multi-value parameter", () => {
    const contains = { conditions: [{ parameter: "tags", operator: "contains", value: "urgent" }] };
    expect(evaluateSubmissionCriteria(contains, { tags: ["urgent", "ops"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(contains, { tags: ["ops"] }).ok).toBe(false);

    const anyOf = { conditions: [{ parameter: "tags", operator: "containsAny", value: ["urgent", "p0"] }] };
    expect(evaluateSubmissionCriteria(anyOf, { tags: ["ops", "p0"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(anyOf, { tags: ["ops"] }).ok).toBe(false);
  });

  it("`eachIs` / `eachIsNot` quantify over every element", () => {
    const eachIs = { conditions: [{ parameter: "tags", operator: "eachIs", value: "ops" }] };
    expect(evaluateSubmissionCriteria(eachIs, { tags: ["ops", "ops"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(eachIs, { tags: ["ops", "urgent"] }).ok).toBe(false);

    const eachIsNot = { conditions: [{ parameter: "tags", operator: "eachIsNot", value: "banned" }] };
    expect(evaluateSubmissionCriteria(eachIsNot, { tags: ["ops", "urgent"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(eachIsNot, { tags: ["ops", "banned"] }).ok).toBe(false);
  });
});

describe("organization and execution-context leaves", () => {
  it("`organization` requires exact membership", () => {
    const crit = { conditions: [{ organization: "bihire" }] };
    expect(evaluateSubmissionCriteria(crit, {}, { organizations: ["bihire"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, {}, { organizations: ["other"] }).ok).toBe(false);
    // Unknown principal orgs → fail closed, never pass on absence.
    expect(evaluateSubmissionCriteria(crit, {}, {}).ok).toBe(false);
  });

  it("`anyOrganization` accepts membership in one of several orgs", () => {
    const crit = { conditions: [{ anyOrganization: ["bihire", "rra"] }] };
    expect(evaluateSubmissionCriteria(crit, {}, { organizations: ["rra"] }).ok).toBe(true);
    expect(evaluateSubmissionCriteria(crit, {}, { organizations: ["other"] }).ok).toBe(false);
  });

  it("`executionContext` defaults an absent subject context to `live`", () => {
    const live = { conditions: [{ executionContext: "live" }] };
    expect(evaluateSubmissionCriteria(live, {}, {}).ok).toBe(true);
    expect(evaluateSubmissionCriteria(live, {}, { executionContext: "scenario" }).ok).toBe(false);

    const scenario = { conditions: [{ executionContext: "scenario" }] };
    expect(evaluateSubmissionCriteria(scenario, {}, {}).ok).toBe(false);
    expect(evaluateSubmissionCriteria(scenario, {}, { executionContext: "Scenario" }).ok).toBe(true);
  });
});

describe("extractConditions", () => {
  it("returns leaves from inside nested groups, not the group nodes", () => {
    const crit = {
      conditions: [
        { parameter: "a", operator: "eq", value: 1 },
        {
          operator: "any",
          conditions: [
            { functionValidation: { apiName: "f", version: 1, input: {}, resultField: "ok" } },
            { operator: "none", conditions: [{ parameter: "b", operator: "eq", value: 2 }] },
          ],
        },
      ],
    };
    const leaves = extractConditions(crit);
    expect(leaves).toHaveLength(3);
    expect(leaves.some((c: any) => c.functionValidation?.apiName === "f")).toBe(true);
    expect(leaves.some((c: any) => c.parameter === "b")).toBe(true);
    // No group nodes leaked through.
    expect(leaves.every((c: any) => !Array.isArray(c.conditions))).toBe(true);
  });

  it("still handles a bare array and a null blob", () => {
    expect(extractConditions([{ parameter: "a" }])).toHaveLength(1);
    expect(extractConditions(null)).toEqual([]);
  });
});
