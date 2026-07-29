// ---------------------------------------------------------------------------
// `object_set.changed` cardinality — single ownership point in executeAction.
//
// Contract: a successful action execution emits EXACTLY ONE
// `object_set.changed` ws:event per affected object type, AFTER the edit
// transaction commits — for /apply, /applyBatch, and the bulk runner
// (all three call executeAction). Zero events on failure, empty results,
// and validate/dry-run (which never reaches executeAction).
//
// The route-level copy that used to live in routes/actions.ts (a second
// emission on /apply only) was removed; a source-contract test below
// pins its absence so it cannot creep back.
//
// These tests drive the real executeAction orchestrator + real singleton
// eventBus with persistence/sandbox collaborators mocked.
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
  // Row-driven so this file can exercise both execution modes.
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
import { eventBus } from "../../../src/websocket/eventBus";
import { OntologyError } from "../../../src/utils/queryErrors";

const ONTOLOGY_ID = "11111111-2222-3333-4444-555555555555";

const functionConfig = {
  functionRid: "ri.function-registry.main.function.close-order",
  repositoryRid: "ri.stemma.main.repository.orders",
  apiName: "closeOrder",
  branch: "master",
  semver: "1.0.0",
};

const baseRow = {
  display_name: "Test Action",
  is_enabled: true,
  parameters: [{ apiName: "orderId", type: "string", required: true }],
  submission_criteria: null,
  side_effects: null,
  max_affected_objects: 1000,
  semantics_version: 1,
  delete_policy: "legacy_unchecked",
};

const functionActionRow = {
  ...baseRow,
  api_name: "fnAction",
  rules: [],
  execution_mode: "function",
  function_config: functionConfig,
};

const declarativeActionRow = {
  ...baseRow,
  api_name: "declAction",
  rules: [{ type: "createObject", objectType: "CyWidget", properties: {} }],
  execution_mode: "declarative",
  function_config: null,
};

interface CapturedEvent {
  event: string;
  objectTopic?: string;
  payload: Record<string, unknown>;
}

function eventsForType(events: CapturedEvent[], objectType: string) {
  return events.filter((e) => e.objectTopic === `${ONTOLOGY_ID}:${objectType}`);
}

describe("executeAction — object_set.changed cardinality", () => {
  let events: CapturedEvent[];
  const listener = (event: CapturedEvent) => {
    if (event.event === "object_set.changed") events.push(event);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    eventBus.on("ws:event", listener);
    validateParametersMock.mockResolvedValue({
      valid: true,
      resolvedParameters: { orderId: "cy-1" },
    });
    appendAuditRowMock.mockResolvedValue(undefined);
    standaloneFailureAuditMock.mockResolvedValue({});
    return () => {
      eventBus.off("ws:event", listener);
    };
  });

  describe("function-backed execution", () => {
    beforeEach(() => {
      getActionTypeMock.mockResolvedValue(functionActionRow);
    });

    it("exactly one event per affected type after a successful commit (multi-edit same type)", async () => {
      const affectedObjects = [
        { objectType: "CyWidget", primaryKey: "cy-1", operation: "create" as const },
        { objectType: "CyWidget", primaryKey: "cy-2", operation: "update" as const },
      ];
      executeFunctionActionMock.mockImplementation(async (options) => {
        await options.preCommitHook({ query: vi.fn() }, affectedObjects);
        return { affectedObjects, logs: [] };
      });

      const result = await executeAction(
        ONTOLOGY_ID, "fnAction", { orderId: "cy-1" }, { executedBy: "user-1" },
      );

      expect(result.success).toBe(true);
      const widgetEvents = eventsForType(events, "CyWidget");
      expect(widgetEvents).toHaveLength(1);
      expect(widgetEvents[0].payload).toMatchObject({
        ontologyId: ONTOLOGY_ID,
        objectType: "CyWidget",
        objectTypeApiName: "CyWidget",
        operation: "applyAction",
        // Per-type count (2 edits on CyWidget), not a global count.
        affectedCount: 2,
        primaryKeys: ["cy-1", "cy-2"],
        actionTypeApiName: "fnAction",
        result: "success",
      });
      expect(appendAuditRowMock).toHaveBeenCalledTimes(1);
    });

    it("one event for each distinct affected object type, with independent counts", async () => {
      const affectedObjects = [
        { objectType: "CyWidget", primaryKey: "cy-1", operation: "create" as const },
        { objectType: "CyWidget", primaryKey: "cy-2", operation: "update" as const },
        { objectType: "CyGadget", primaryKey: "cy-9", operation: "delete" as const },
      ];
      executeFunctionActionMock.mockImplementation(async (options) => {
        await options.preCommitHook({ query: vi.fn() }, affectedObjects);
        return { affectedObjects, logs: [] };
      });

      await executeAction(
        ONTOLOGY_ID, "fnAction", { orderId: "cy-1" }, { executedBy: "user-1" },
      );

      expect(events).toHaveLength(2);
      expect(eventsForType(events, "CyWidget")).toHaveLength(1);
      expect(eventsForType(events, "CyGadget")).toHaveLength(1);
      expect(eventsForType(events, "CyWidget")[0].payload).toMatchObject({
        operation: "applyAction",
        affectedCount: 2,
        objectTypeApiName: "CyWidget",
      });
      expect(eventsForType(events, "CyGadget")[0].payload).toMatchObject({
        operation: "applyAction",
        affectedCount: 1,
        objectTypeApiName: "CyGadget",
      });
    });

    it("zero events when the function produces no affected objects", async () => {
      executeFunctionActionMock.mockImplementation(async (options) => {
        await options.preCommitHook({ query: vi.fn() }, []);
        return { affectedObjects: [], logs: [] };
      });

      const result = await executeAction(
        ONTOLOGY_ID, "fnAction", { orderId: "cy-1" }, { executedBy: "user-1" },
      );

      expect(result.success).toBe(true);
      expect(events).toHaveLength(0);
    });

    it("zero events + structured failure when function execution fails", async () => {
      executeFunctionActionMock.mockRejectedValue(
        new OntologyError("boom", "FUNCTION_EXECUTION_FAILED", 422),
      );

      await expect(
        executeAction(
          ONTOLOGY_ID, "fnAction", { orderId: "cy-1" }, { executedBy: "user-1" },
        ),
      ).rejects.toMatchObject({ code: "FUNCTION_EXECUTION_FAILED" });

      expect(events).toHaveLength(0);
      expect(appendAuditRowMock).not.toHaveBeenCalled();
      expect(standaloneFailureAuditMock).toHaveBeenCalledTimes(1);
    });

    it("zero events + fail closed when the persisted binding is missing", async () => {
      getActionTypeMock.mockResolvedValue({
        ...functionActionRow,
        function_config: null,
      });

      await expect(
        executeAction(
          ONTOLOGY_ID, "fnAction", { orderId: "cy-1" }, { executedBy: "user-1" },
        ),
      ).rejects.toMatchObject({ code: "FUNCTION_CONFIG_INVALID" });

      expect(executeFunctionActionMock).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  });

  describe("declarative execution", () => {
    beforeEach(() => {
      getActionTypeMock.mockResolvedValue(declarativeActionRow);
    });

    it("exactly one event per affected type after commit (multi-edit same type)", async () => {
      compileRulesMock.mockResolvedValue({
        errors: [],
        affectedObjectCount: 2,
        edits: [
          { objectType: "CyWidget", primaryKey: "cy-1", operation: "create" },
          { objectType: "CyWidget", primaryKey: "cy-2", operation: "update" },
        ],
      });
      applyEditsMock.mockImplementation(async (_edits, ctx) => {
        await ctx.preCommitHook({ query: vi.fn() });
        return {
          success: true,
          appliedEdits: [
            { objectType: "CyWidget", primaryKey: "cy-1", operation: "create" },
            { objectType: "CyWidget", primaryKey: "cy-2", operation: "update" },
          ],
          failedEdits: [],
        };
      });

      const result = await executeAction(
        ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
      );

      expect(result.result).toBe("success");
      const widgetEvents = eventsForType(events, "CyWidget");
      expect(widgetEvents).toHaveLength(1);
      expect(widgetEvents[0].payload).toMatchObject({
        ontologyId: ONTOLOGY_ID,
        objectType: "CyWidget",
        objectTypeApiName: "CyWidget",
        operation: "applyAction",
        affectedCount: 2,
        primaryKeys: ["cy-1", "cy-2"],
        actionTypeApiName: "declAction",
      });
    });

    it("one event for each distinct affected object type, with independent counts", async () => {
      compileRulesMock.mockResolvedValue({
        errors: [],
        affectedObjectCount: 3,
        edits: [
          { objectType: "CyWidget", primaryKey: "cy-1", operation: "create" },
          { objectType: "CyWidget", primaryKey: "cy-2", operation: "update" },
          { objectType: "CyGadget", primaryKey: "cy-9", operation: "delete" },
        ],
      });
      applyEditsMock.mockImplementation(async (_edits, ctx) => {
        await ctx.preCommitHook({ query: vi.fn() });
        return {
          success: true,
          appliedEdits: [
            { objectType: "CyWidget", primaryKey: "cy-1", operation: "create" },
            { objectType: "CyWidget", primaryKey: "cy-2", operation: "update" },
            { objectType: "CyGadget", primaryKey: "cy-9", operation: "delete" },
          ],
          failedEdits: [],
        };
      });

      await executeAction(
        ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
      );

      expect(events).toHaveLength(2);
      expect(eventsForType(events, "CyWidget")).toHaveLength(1);
      expect(eventsForType(events, "CyGadget")).toHaveLength(1);
      expect(eventsForType(events, "CyWidget")[0].payload).toMatchObject({
        operation: "applyAction",
        affectedCount: 2,
        objectTypeApiName: "CyWidget",
      });
      expect(eventsForType(events, "CyGadget")[0].payload).toMatchObject({
        operation: "applyAction",
        affectedCount: 1,
        objectTypeApiName: "CyGadget",
      });
    });

    it("zero events when nothing was applied", async () => {
      compileRulesMock.mockResolvedValue({
        errors: [],
        affectedObjectCount: 0,
        edits: [],
      });
      applyEditsMock.mockImplementation(async (_edits, ctx) => {
        await ctx.preCommitHook({ query: vi.fn() });
        return { success: true, appliedEdits: [], failedEdits: [] };
      });

      await executeAction(
        ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
      );

      expect(events).toHaveLength(0);
    });

    it("zero events when the edit transaction fails", async () => {
      compileRulesMock.mockResolvedValue({
        errors: [],
        affectedObjectCount: 1,
        edits: [{ objectType: "CyWidget", primaryKey: "cy-1", operation: "create" }],
      });
      applyEditsMock.mockRejectedValue(
        new OntologyError("pg boom", "INTERNAL_ERROR", 500),
      );

      await expect(
        executeAction(
          ONTOLOGY_ID, "declAction", { orderId: "cy-1" }, { executedBy: "user-1" },
        ),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      expect(events).toHaveLength(0);
      expect(standaloneFailureAuditMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("single-ownership source contract", () => {
    it("no route layer emits object_set.changed (executor is the only owner)", async () => {
      const { readFileSync } = await import("fs");
      const { resolve } = await import("path");
      for (const routeFile of [
        "../../../src/routes/actions.ts",
        "../../../src/routes/bulkActions.ts",
      ]) {
        const src = readFileSync(resolve(__dirname, routeFile), "utf8");
        expect(
          src.includes("object_set.changed"),
          `${routeFile} must not emit object_set.changed — ` +
            `the executor (actionExecutor Stage 7) is the single ownership point`,
        ).toBe(false);
      }
    });

    it("validate/dry-run never emits (validateAction has no event bus)", async () => {
      const { readFileSync } = await import("fs");
      const { resolve } = await import("path");
      const src = readFileSync(
        resolve(__dirname, "../../../src/actions/actionValidator.ts"),
        "utf8",
      );
      expect(src.includes("eventBus")).toBe(false);
      expect(src.includes("object_set.changed")).toBe(false);
    });
  });
});
