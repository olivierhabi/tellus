import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActionType: vi.fn(),
  validateParameters: vi.fn(),
  compileRules: vi.fn(),
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
  }) => {
    const semanticsVersion = row.semantics_version ?? 1;
    return {
      semanticsVersion,
      executionMode: row.execution_mode ?? "declarative",
      deletePolicy:
        row.delete_policy ??
        (semanticsVersion === 2 ? "restrict" : "legacy_unchecked"),
    };
  },
}));
vi.mock("../../../src/actions/parameterValidator", () => ({
  validateParameters: mocks.validateParameters,
}));
vi.mock("../../../src/actions/ruleCompiler", () => ({
  compileRules: mocks.compileRules,
}));
vi.mock("../../../src/actions/submissionCriteria", () => ({
  evaluateSubmissionCriteria: vi.fn(() => ({ ok: true, failures: [] })),
  resolveObjectPropertyOperands: vi.fn(async () => ({})),
  // `functionValidationCriteria` flattens criteria through this shared
  // helper; these tests exercise no function gates, so it yields no leaves.
  extractConditions: vi.fn(() => []),
}));
vi.mock("../../../src/services/opensearch/indexMappingGenerator", () => ({
  getIndexName: vi.fn((name: string) => name),
}));
vi.mock("../../../src/services/opensearch/client", () => ({
  client: { get: vi.fn() },
}));

import { validateAction } from "../../../src/actions/actionValidator";

const originalExecutionFlag = process.env.ACTION_SEMANTICS_V2_ENABLED;
const originalProjectionFlag =
  process.env.ACTION_SEMANTICS_V2_PROJECTION_READY;
const originalKillSwitch = process.env.ACTION_SEMANTICS_V2_KILL_SWITCH;

function v2ActionRow() {
  return {
    action_type_id: "action-id",
    ontology_id: "ontology-id",
    api_name: "createOrder",
    display_name: "Create Order",
    description: "",
    icon_name: null,
    icon_color: null,
    save_location_rid: null,
    parameters: [],
    rules: [],
    submission_criteria: null,
    side_effects: null,
    writeback_config: null,
    max_affected_objects: 100,
    is_enabled: true,
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    created_by: "test",
    semantics_version: 2,
    execution_mode: "declarative",
    delete_policy: "restrict",
  };
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalExecutionFlag === undefined) {
    delete process.env.ACTION_SEMANTICS_V2_ENABLED;
  } else {
    process.env.ACTION_SEMANTICS_V2_ENABLED = originalExecutionFlag;
  }
  if (originalProjectionFlag === undefined) {
    delete process.env.ACTION_SEMANTICS_V2_PROJECTION_READY;
  } else {
    process.env.ACTION_SEMANTICS_V2_PROJECTION_READY =
      originalProjectionFlag;
  }
  if (originalKillSwitch === undefined) {
    delete process.env.ACTION_SEMANTICS_V2_KILL_SWITCH;
  } else {
    process.env.ACTION_SEMANTICS_V2_KILL_SWITCH = originalKillSwitch;
  }
});

describe("validateAction semantics rollout parity", () => {
  it("rejects a v2 dry run with the same typed gate used by apply", async () => {
    delete process.env.ACTION_SEMANTICS_V2_ENABLED;
    process.env.ACTION_SEMANTICS_V2_PROJECTION_READY = "true";
    mocks.getActionType.mockResolvedValue(v2ActionRow());

    await expect(
      validateAction("ontology-id", "createOrder", {}),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      errorName: "UnsupportedActionSemanticsVersionError",
      statusCode: 422,
      details: {
        semanticsVersion: 2,
        reason: "execution_disabled",
      },
    });

    expect(mocks.validateParameters).not.toHaveBeenCalled();
  });

  it("continues normal validation when v2 execution is fully ready", async () => {
    process.env.ACTION_SEMANTICS_V2_ENABLED = "true";
    process.env.ACTION_SEMANTICS_V2_PROJECTION_READY = "true";
    delete process.env.ACTION_SEMANTICS_V2_KILL_SWITCH;
    mocks.getActionType.mockResolvedValue(v2ActionRow());
    mocks.validateParameters.mockResolvedValue({
      valid: true,
      errors: [],
      resolvedParameters: {},
    });
    mocks.compileRules.mockResolvedValue({
      errors: [],
      affectedObjectCount: 0,
      edits: [],
    });

    await expect(
      validateAction("ontology-id", "createOrder", {}),
    ).resolves.toEqual({
      valid: true,
      errors: [],
      preview: {
        affectedObjectCount: 0,
        edits: [],
      },
    });
  });
});
