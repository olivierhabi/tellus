import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActionType: vi.fn(),
  validateParameters: vi.fn(),
  compileRules: vi.fn(),
  evaluateSubmissionCriteria: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query: vi.fn() }));
vi.mock("../../../src/services/ontology/canonicalOntology", () => ({
  getOntologyId: vi.fn(),
}));
vi.mock("../../../src/models/actionType", () => ({
  getActionType: mocks.getActionType,
  resolveSemanticsForRow: (row: {
    semantics_version?: number | null;
    execution_mode?: string | null;
    delete_policy?: string | null;
  }) => ({
    semanticsVersion: row.semantics_version ?? 1,
    executionMode: row.execution_mode ?? "declarative",
    deletePolicy:
      row.delete_policy ??
      (row.semantics_version === 2 ? "restrict" : "legacy_unchecked"),
  }),
}));
vi.mock("../../../src/actions/parameterValidator", () => ({
  validateParameters: mocks.validateParameters,
}));
vi.mock("../../../src/actions/ruleCompiler", () => ({
  compileRules: mocks.compileRules,
}));
vi.mock("../../../src/actions/submissionCriteria", () => ({
  evaluateSubmissionCriteria: mocks.evaluateSubmissionCriteria,
  resolveObjectPropertyOperands: vi.fn(async () => ({})),
}));
vi.mock("../../../src/services/opensearch/indexMappingGenerator", () => ({
  getIndexName: vi.fn((name: string) => name),
}));
vi.mock("../../../src/services/opensearch/client", () => ({
  client: { get: vi.fn() },
}));

import { validateAction } from "../../../src/actions/actionValidator";

describe("validateAction submission-criteria subject", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Regression: /validate used to build the subject with roles: [] / groups: [],
  // so every role-gated action failed its dry-run criteria while /apply (which
  // forwards context.roles) would have accepted it (qaRw* role gates).
  it("forwards the caller's roles/groups into criteria evaluation", async () => {
    mocks.getActionType.mockResolvedValue({
      action_type_id: "action-id",
      ontology_id: "ontology-id",
      api_name: "qaRwBkApproveCreditLimit",
      display_name: "Approve Credit Limit (QA)",
      description: "",
      icon_name: null,
      parameters: [],
      rules: [],
      submission_criteria: [
        { role: "credit-analyst", description: "analysts only" },
      ],
      max_affected_objects: 1000,
      semantics_version: null,
      execution_mode: null,
      delete_policy: null,
    });
    mocks.validateParameters.mockResolvedValue({
      valid: true,
      errors: [],
      resolvedParameters: {},
    });
    mocks.evaluateSubmissionCriteria.mockReturnValue({ ok: true, failures: [] });
    mocks.compileRules.mockResolvedValue({
      errors: [],
      affectedObjectCount: 0,
      edits: [],
    });

    const result = await validateAction(
      "ontology-id",
      "qaRwBkApproveCreditLimit",
      {},
      { executedBy: "analyst-1", roles: ["credit-analyst"], groups: ["qa"] },
    );

    expect(result.valid).toBe(true);
    expect(mocks.evaluateSubmissionCriteria).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        username: "analyst-1",
        roles: ["credit-analyst"],
        groups: ["qa"],
      }),
      expect.anything(),
    );
  });

  it("falls back to an empty subject when no context is supplied", async () => {
    mocks.getActionType.mockResolvedValue({
      action_type_id: "action-id",
      ontology_id: "ontology-id",
      api_name: "anyAction",
      display_name: "Any",
      parameters: [],
      rules: [],
      submission_criteria: [],
      max_affected_objects: 1000,
      semantics_version: null,
      execution_mode: null,
      delete_policy: null,
    });
    mocks.validateParameters.mockResolvedValue({
      valid: true,
      errors: [],
      resolvedParameters: {},
    });
    mocks.evaluateSubmissionCriteria.mockReturnValue({ ok: true, failures: [] });
    mocks.compileRules.mockResolvedValue({
      errors: [],
      affectedObjectCount: 0,
      edits: [],
    });

    await validateAction("ontology-id", "anyAction", {});

    expect(mocks.evaluateSubmissionCriteria).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ roles: [], groups: [] }),
      expect.anything(),
    );
  });
});
