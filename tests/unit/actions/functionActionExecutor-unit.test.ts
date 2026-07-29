import { beforeEach, describe, expect, it, vi } from "vitest";

const { runSandboxMock, loadSnapshotMock, applyFunctionEditsMock } = vi.hoisted(
  () => ({
    runSandboxMock: vi.fn(),
    loadSnapshotMock: vi.fn(),
    applyFunctionEditsMock: vi.fn(),
  }),
);

vi.mock("../../../src/services/functionWorkerPool", () => ({
  runSandboxedWithSdkAsync: runSandboxMock,
}));

vi.mock("../../../src/services/functions/ontologyRuntime", () => ({
  loadOntologySnapshot: loadSnapshotMock,
  applyEdits: applyFunctionEditsMock,
}));

import { executeFunctionAction } from "../../../src/actions/functionActionExecutor";

const binding = {
  functionRid: "ri.function-registry.main.function.update-order",
  repositoryRid: "ri.stemma.main.repository.orders",
  apiName: "updateOrder",
  branch: "main",
  semver: "1.2.3",
  autoUpgrade: false,
};

describe("executeFunctionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the pinned source, hydrates object references, and applies returned edits", async () => {
    const order = {
      $apiName: "Order",
      $primaryKey: "order-1",
      $title: "Order 1",
      status: "open",
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            repository_rid: binding.repositoryRid,
            api_name: binding.apiName,
            state: "AVAILABLE",
            runtime: "NODE_20",
            function_kind: "edit",
            manifest_json: {
              sources: {
                updateOrder:
                  "export default function updateOrder(order) { return []; }",
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            ontology_id:
              "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
            api_name: "Order",
            kind: "object_type",
          },
        ],
      });
    const db = { query } as never;
    loadSnapshotMock.mockResolvedValue({
      byType: new Map([["Order", new Map([["order-1", order]])]]),
      ontologyId: "00000000-0000-0000-0000-000000000001",
      objectCount: 1,
      objectTypes: ["Order"],
      importedTypes: ["Order"],
    });
    runSandboxMock.mockImplementation(
      async (_source: string, args: Record<string, unknown>) => {
        expect(args.order).toEqual(order);
        return {
          status: "ok",
          output: [
            {
              op: "update",
              objectType: "Order",
              primaryKey: "order-1",
              patch: { status: "closed" },
            },
          ],
          edits: [],
          logs: ["updated"],
          requestedTypes: ["Order"],
          durationMs: 2,
        };
      },
    );
    const transactionClient = { query: vi.fn() };
    const preCommitHook = vi.fn();
    applyFunctionEditsMock.mockImplementation(async (_db, args) => {
      await args.preCommitHook(transactionClient);
      return {
        created: 0,
        updated: 1,
        deleted: 0,
        linked: 0,
        unlinked: 0,
      };
    });

    const result = await executeFunctionAction(
      {
        ontologyId: "00000000-0000-0000-0000-000000000001",
        binding,
        parameters: { order: "order-1" },
        parameterDefinitions: [
          {
            apiName: "order",
            type: "object_reference",
            objectType: "Order",
          },
        ],
        executedBy: "user-1",
        maxAffectedObjects: 10,
        preCommitHook,
      },
      db,
    );

    expect(applyFunctionEditsMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ontologyId: "00000000-0000-0000-0000-000000000001",
        edits: [
          {
            op: "update",
            objectType: "Order",
            primaryKey: "order-1",
            patch: { status: "closed" },
          },
        ],
        actorUserId: "user-1",
        preCommitHook: expect.any(Function),
      }),
    );
    expect(preCommitHook).toHaveBeenCalledWith(transactionClient, [
      {
        objectType: "Order",
        primaryKey: "order-1",
        operation: "update",
      },
    ]);
    expect(result).toEqual({
      affectedObjects: [
        {
          objectType: "Order",
          primaryKey: "order-1",
          operation: "update",
        },
      ],
      logs: ["updated"],
    });
  });

  it("rejects a binding whose registry identity has changed", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            repository_rid: "ri.stemma.main.repository.other",
            api_name: binding.apiName,
            state: "AVAILABLE",
            runtime: "NODE_20",
            function_kind: "edit",
            manifest_json: { sources: { updateOrder: "export default () => []" } },
          },
        ],
      }),
    } as never;

    await expect(
      executeFunctionAction(
        {
          ontologyId: "00000000-0000-0000-0000-000000000001",
          binding,
          parameters: {},
          parameterDefinitions: [],
          executedBy: "user-1",
          maxAffectedObjects: 10,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "FUNCTION_BINDING_MISMATCH" });
    expect(runSandboxMock).not.toHaveBeenCalled();
  });
});
