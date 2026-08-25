// ---------------------------------------------------------------------------
// executeAction → ExecutionResult.linkIndexAck propagation (unit).
//
// Contract: the edge-index acknowledgement computed by applyEdits()
// (editApplicator Step 6b) is surfaced FAITHFULLY on ExecutionResult —
// confirmed, unconfirmed/timeout, and flag-disabled (absent) cases. An
// unconfirmed ack NEVER flips the execution to a failure: the PG
// transaction is committed, result stays "success"/"partial", and no error
// is thrown. Mock harness mirrors actionExecutorFunctionEvents-unit.test.ts
// (real orchestrator, persistence/sandbox collaborators mocked).
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getActionTypeMock,
  validateParametersMock,
  executeFunctionActionMock,
  compileRulesMock,
  applyEditsMock,
  appendAuditRowMock,
  standaloneFailureAuditMock,
} = vi.hoisted(() => ({
  getActionTypeMock: vi.fn(),
  validateParametersMock: vi.fn(),
  executeFunctionActionMock: vi.fn(),
  compileRulesMock: vi.fn(),
  applyEditsMock: vi.fn(),
  appendAuditRowMock: vi.fn(),
  standaloneFailureAuditMock: vi.fn(),
}));

vi.mock("../../../src/models/actionType", () => ({
  getActionType: getActionTypeMock,
  resolveSemanticsForRow: (row: {
    semantics_version?: number | null;
    execution_mode?: string | null;
    delete_policy?: string | null;
  }) => ({
    semanticsVersion: row.semantics_version ?? 1,
    executionMode: row.execution_mode ?? "declarative",
    deletePolicy: row.delete_policy ?? "legacy_unchecked",
  }),
}));

vi.mock("../../../src/actions/parameterValidator", () => ({
  validateParameters: validateParametersMock,
}));

vi.mock("../../../src/actions/functionActionExecutor", () => ({
  executeFunctionAction: executeFunctionActionMock,
}));

vi.mock("../../../src/actions/ruleCompiler", () => ({
  compileRules: compileRulesMock,
}));

vi.mock("../../../src/actions/editApplicator", () => ({
  applyEdits: applyEditsMock,
}));

vi.mock("../../../src/models/actionAuditLog", () => ({
  appendAuditRow: appendAuditRowMock,
  logStandaloneFailureAudit: standaloneFailureAuditMock,
  AuditDurabilityError: class AuditDurabilityError extends Error {},
}));

// Remaining collaborators — unused by the paths under test but mocked
// so importing the orchestrator never touches PG/OpenSearch.
vi.mock("../../../src/db", () => ({ query: vi.fn(), pool: {} }));
vi.mock("../../../src/actions/actionCbac", () => ({
  runActionCbacGate: vi.fn(),
  cbacDenyMessage: vi.fn(),
}));
vi.mock("../../../src/services/funnel/metrics", () => ({ incCounter: vi.fn() }));
vi.mock("../../../src/services/branchContext", () => ({
  resolveBranchIdOrMain: vi.fn(async () => "00000000-0000-0000-0000-000000000000"),
  // Same id as the resolved branch, so `isNonMainBranch` reports false and
  // these tests keep exercising the on-main side-effect path they were
  // written against (migration 173's branch switches are covered separately
  // in actionSecuritySettings-unit.test.ts).
  resolveMainBranchId: vi.fn(async () => "00000000-0000-0000-0000-000000000000"),
}));
vi.mock("../../../src/services/opensearch/client", () => ({ client: null }));
vi.mock("../../../src/services/opensearch/indexMappingGenerator", () => ({
  getIndexName: vi.fn(() => "idx"),
}));
vi.mock("../../../src/actions/objectReferenceResolver", () => ({
  defaultSchemaLookup: {},
}));
vi.mock("../../../src/actions/actionV2PlanBuilder", () => ({
  buildPlannedStepsFromRules: vi.fn(),
}));
vi.mock("../../../src/actions/actionPlanner", () => ({
  buildActionPlan: vi.fn(),
  objectKey: vi.fn(),
}));
vi.mock("../../../src/actions/actionV2StateLoader", () => ({
  loadPersistedState: vi.fn(),
  toLockIdentities: vi.fn(),
}));
vi.mock("../../../src/actions/actionRetry", () => ({
  withBoundedRetry: vi.fn(),
}));
vi.mock("../../../src/actions/runWritebackStage", () => ({
  runWritebackStage: vi.fn(),
}));
vi.mock("../../../src/actions/writebackExecutor", () => ({
  executeWriteback: vi.fn(),
}));
vi.mock("../../../src/actions/actionWebhooks", () => ({
  fireActionWebhooks: vi.fn(),
}));
vi.mock("../../../src/actions/sideEffectNotifier", () => ({
  sendNotifications: vi.fn(),
}));
vi.mock("../../../src/models/actionSideEffectJob", () => ({
  enqueueSideEffectJobsInTransaction: vi.fn(),
}));
vi.mock("../../../src/services/webhookSafeTransport", () => ({
  DEFAULT_EGRESS_POLICY: {},
}));

import { executeAction } from "../../../src/actions/actionExecutor";

const ONTOLOGY_ID = "11111111-2222-3333-4444-555555555555";

const declarativeActionRow = {
  display_name: "Test Action",
  is_enabled: true,
  parameters: [{ apiName: "orderId", type: "string", required: true }],
  submission_criteria: null,
  side_effects: null,
  max_affected_objects: 1000,
  semantics_version: 1,
  delete_policy: "legacy_unchecked",
  api_name: "declAction",
  rules: [{ type: "addLink", linkType: "lt", sourceObject: { source: "parameter", param: "orderId" }, targetObject: { source: "parameter", param: "orderId" } }],
  execution_mode: "declarative",
  function_config: null,
};

const EDITS = [
  { objectType: "CyWidget", primaryKey: "cy-1", operation: "update" },
];

const APPLIED = [
  { editId: "edit-1", objectType: "CyWidget", primaryKey: "cy-1", operation: "update" as const },
];

describe("executeAction → ExecutionResult.linkIndexAck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActionTypeMock.mockResolvedValue(declarativeActionRow);
    validateParametersMock.mockResolvedValue({
      valid: true,
      resolvedParameters: { orderId: "cy-1" },
    });
    appendAuditRowMock.mockResolvedValue(undefined);
    standaloneFailureAuditMock.mockResolvedValue({});
    compileRulesMock.mockResolvedValue({
      errors: [],
      affectedObjectCount: 1,
      edits: EDITS,
    });
  });

  it("confirmed ack → surfaced verbatim on ExecutionResult", async () => {
    const ack = { confirmed: true, deferred: 0, waitedMs: 23 };
    applyEditsMock.mockImplementation(async (_edits, ctx) => {
      await ctx.preCommitHook({ query: vi.fn() });
      return { success: true, appliedEdits: APPLIED, failedEdits: [], indexingStatus: "success", linkIndexAck: ack };
    });

    const result = await executeAction(
      ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("success");
    expect(result.linkIndexAck).toEqual(ack); // no coercion, no dropping
  });

  it("unconfirmed ack (timeout) → surfaced verbatim; execution is STILL a committed success, never a failure", async () => {
    const ack = { confirmed: false, deferred: 1, waitedMs: 5000, reason: "timeout" as const };
    applyEditsMock.mockImplementation(async (_edits, ctx) => {
      await ctx.preCommitHook({ query: vi.fn() });
      return { success: true, appliedEdits: APPLIED, failedEdits: [], indexingStatus: "success", linkIndexAck: ack };
    });

    const result = await executeAction(
      ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("success"); // NOT "failed" — the mutation is durable
    expect(result.failureType).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.linkIndexAck).toEqual(ack);
    // and it did NOT reject (no error surfaced for a committed execution)
    expect(standaloneFailureAuditMock).not.toHaveBeenCalled();
    expect(appendAuditRowMock).toHaveBeenCalledTimes(1);
  });

  it("flag-disabled (no ack staged) → linkIndexAck stays ABSENT on the result", async () => {
    applyEditsMock.mockImplementation(async (_edits, ctx) => {
      await ctx.preCommitHook({ query: vi.fn() });
      return { success: true, appliedEdits: APPLIED, failedEdits: [], indexingStatus: "success" };
    });

    const result = await executeAction(
      ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
    );

    expect(result.success).toBe(true);
    expect("linkIndexAck" in result).toBe(false);
    expect(result.linkIndexAck).toBeUndefined();
  });

  it("index-outage ack (confirmed:false, reason:index_outage) → also a committed success", async () => {
    const ack = { confirmed: false, deferred: 2, waitedMs: 5000, reason: "index_outage" as const };
    applyEditsMock.mockImplementation(async (_edits, ctx) => {
      await ctx.preCommitHook({ query: vi.fn() });
      return { success: true, appliedEdits: APPLIED, failedEdits: [], indexingStatus: "success", linkIndexAck: ack };
    });

    const result = await executeAction(
      ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
    );

    expect(result.result).toBe("success");
    expect(result.linkIndexAck?.reason).toBe("index_outage");
  });
});
