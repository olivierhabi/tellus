// ---------------------------------------------------------------------------
// functionActionExecutorBroker — Phase 5 broker-checkpoint tests.
//
// The executor is the broker between the sandbox (pure compute) and
// privileged operations (edit persistence). It must enforce:
//   • PROGRAM authorization — only published versions whose declared
//     contract is edit-kind may back an Action (fail closed for
//     query / unknown / NULL).
//   • OPERATION authorization — emitted edits may only target object
//     types the repository DECLARED as imports for the ontology.
// ---------------------------------------------------------------------------
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

const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

const binding = {
  functionRid: "ri.function-registry.main.function.update-order",
  repositoryRid: "ri.stemma.main.repository.orders",
  apiName: "updateOrder",
  branch: "main",
  semver: "1.0.0",
  autoUpgrade: false,
};

function dbWith(opts: {
  functionKind: string | null;
  importedTypes?: string[];
  importedLinkTypes?: string[];
  /** link_types metadata rows: api_name + endpoint object-type api names. */
  linkMetadata?: Array<{ api_name: string; a_api_name: string; b_api_name: string }>;
}) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          repository_rid: binding.repositoryRid,
          api_name: binding.apiName,
          state: "AVAILABLE",
          runtime: "NODE_20",
          manifest_json: {
            sources: { updateOrder: "export default function updateOrder(order) { return []; }" },
          },
          signature: {
            parameters: [
              { name: "client", type: "Client", optional: false },
              { name: "order", type: "Osdk.Instance<Order>", optional: false },
            ],
            output: "Edits.Object<Order>[]",
          },
          function_kind: opts.functionKind,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        ...(opts.importedTypes ?? ["Order"]).map((api_name) => ({
          ontology_id: `ri.ontology.main.ontology.${ONTOLOGY_ID}`,
          api_name,
          kind: "object_type",
        })),
        ...(opts.importedLinkTypes ?? []).map((api_name) => ({
          ontology_id: `ri.ontology.main.ontology.${ONTOLOGY_ID}`,
          api_name,
          kind: "link_type",
        })),
      ],
    })
    // link_types endpoint-resolution query (only issued when the
    // batch contains link/unlink edits).
    .mockResolvedValue({ rows: opts.linkMetadata ?? [] });
  return { query } as never;
}

function invoke(db: never) {
  return executeFunctionAction(
    {
      ontologyId: ONTOLOGY_ID,
      binding,
      parameters: { order: "order-1" },
      parameterDefinitions: [
        { apiName: "order", type: "object_reference", objectType: "Order" },
      ],
      executedBy: "user-1",
      maxAffectedObjects: 10,
    },
    db,
  );
}

describe("broker checkpoint — program authorization (function kind)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSnapshotMock.mockResolvedValue({
      byType: new Map([["Order", new Map([["order-1", {
        $apiName: "Order", $primaryKey: "order-1", $title: "o", status: "open",
      }]])]]),
      ontologyId: ONTOLOGY_ID,
      objectCount: 1,
      objectTypes: ["Order"],
      importedTypes: ["Order"],
    });
  });

  it.each([
    ["query"],
    ["unknown"],
    [null],
  ])("fails closed when the pinned version's kind is %s", async (kind) => {
    await expect(invoke(dbWith({ functionKind: kind }))).rejects.toMatchObject({
      code: "FUNCTION_KIND_FORBIDDEN",
      statusCode: 422,
    });
    // The sandbox must never run.
    expect(runSandboxMock).not.toHaveBeenCalled();
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });
});

describe("broker checkpoint — operation authorization (edit scope)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSnapshotMock.mockResolvedValue({
      byType: new Map([["Order", new Map([["order-1", {
        $apiName: "Order", $primaryKey: "order-1", $title: "o", status: "open",
      }]])]]),
      ontologyId: ONTOLOGY_ID,
      objectCount: 1,
      objectTypes: ["Order"],
      importedTypes: ["Order"],
    });
  });

  it("rejects edits targeting types the repository did NOT declare", async () => {
    runSandboxMock.mockResolvedValue({
      status: "ok",
      output: [
        { op: "update", objectType: "Order", primaryKey: "order-1", patch: { status: "x" } },
        { op: "delete", objectType: "AuditLog", primaryKey: "a-1" },
      ],
      edits: [],
      logs: [],
      requestedTypes: ["Order"],
      durationMs: 1,
    });

    await expect(invoke(dbWith({ functionKind: "edit" }))).rejects.toMatchObject({
      code: "FUNCTION_EDIT_SCOPE_VIOLATION",
      statusCode: 422,
      details: expect.objectContaining({ objectTypes: ["AuditLog"] }),
    });
    // Nothing may persist.
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });

  it("permits edits scoped to declared imports", async () => {
    runSandboxMock.mockResolvedValue({
      status: "ok",
      output: [
        { op: "update", objectType: "Order", primaryKey: "order-1", patch: { status: "x" } },
      ],
      edits: [],
      logs: [],
      requestedTypes: ["Order"],
      durationMs: 1,
    });
    applyFunctionEditsMock.mockResolvedValue({
      created: 0, updated: 1, deleted: 0, linked: 0, unlinked: 0,
    });

    const result = await invoke(dbWith({ functionKind: "edit" }));
    expect(applyFunctionEditsMock).toHaveBeenCalledTimes(1);
    expect(result.affectedObjects).toEqual([
      { objectType: "Order", primaryKey: "order-1", operation: "update" },
    ]);
  });
});

describe("broker checkpoint — link/unlink authorization", () => {
  const ORDER_SNAPSHOT = {
    byType: new Map([["Order", new Map([["order-1", {
      $apiName: "Order", $primaryKey: "order-1", $title: "o", status: "open",
    }]])]]),
    ontologyId: ONTOLOGY_ID,
    objectCount: 1,
    objectTypes: ["Order"],
    importedTypes: ["Order"],
  };

  function sandboxWith(edits: unknown[]) {
    runSandboxMock.mockResolvedValue({
      status: "ok",
      output: edits,
      edits: [],
      logs: [],
      requestedTypes: ["Order"],
      durationMs: 1,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadSnapshotMock.mockResolvedValue(ORDER_SNAPSHOT);
    applyFunctionEditsMock.mockResolvedValue({
      created: 0, updated: 0, deleted: 0, linked: 1, unlinked: 0,
    });
  });

  it("permits a link over a declared link type with declared endpoints", async () => {
    sandboxWith([
      { op: "link", linkType: "order-to-customer", sourcePrimaryKey: "order-1", targetPrimaryKey: "cust-1" },
    ]);
    const result = await invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order", "Customer"],
      importedLinkTypes: ["order-to-customer"],
      linkMetadata: [{ api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Customer" }],
    }));
    expect(applyFunctionEditsMock).toHaveBeenCalledTimes(1);
    expect(applyFunctionEditsMock.mock.calls[0][1].edits).toHaveLength(1);
    expect(result.logs).toEqual([]);
  });

  it("permits an unlink over a declared link type with declared endpoints", async () => {
    sandboxWith([
      { op: "unlink", linkType: "order-to-customer", sourcePrimaryKey: "order-1", targetPrimaryKey: "cust-1" },
    ]);
    await invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order", "Customer"],
      importedLinkTypes: ["order-to-customer"],
      linkMetadata: [{ api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Customer" }],
    }));
    expect(applyFunctionEditsMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a link whose SOURCE endpoint type is undeclared", async () => {
    sandboxWith([
      { op: "link", linkType: "order-to-customer", sourcePrimaryKey: "order-1", targetPrimaryKey: "cust-1" },
    ]);
    await expect(invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Customer"], // Order NOT imported
      importedLinkTypes: ["order-to-customer"],
      linkMetadata: [{ api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Customer" }],
    }))).rejects.toMatchObject({
      code: "FUNCTION_EDIT_SCOPE_VIOLATION",
      statusCode: 422,
      details: expect.objectContaining({ objectTypes: ["Order"] }),
    });
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });

  it("rejects a link whose TARGET endpoint type is undeclared", async () => {
    sandboxWith([
      { op: "link", linkType: "order-to-customer", sourcePrimaryKey: "order-1", targetPrimaryKey: "cust-1" },
    ]);
    await expect(invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order"], // Customer NOT imported
      importedLinkTypes: ["order-to-customer"],
      linkMetadata: [{ api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Customer" }],
    }))).rejects.toMatchObject({
      code: "FUNCTION_EDIT_SCOPE_VIOLATION",
      statusCode: 422,
      details: expect.objectContaining({ objectTypes: ["Customer"] }),
    });
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });

  it("rejects a link over an UNDECLARED link type", async () => {
    sandboxWith([
      { op: "link", linkType: "order-to-audit-log", sourcePrimaryKey: "order-1", targetPrimaryKey: "a-1" },
    ]);
    await expect(invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order", "AuditLog"],
      importedLinkTypes: [], // link type NOT imported
      linkMetadata: [{ api_name: "order-to-audit-log", a_api_name: "Order", b_api_name: "AuditLog" }],
    }))).rejects.toMatchObject({
      code: "FUNCTION_EDIT_SCOPE_VIOLATION",
      statusCode: 422,
      details: expect.objectContaining({ linkTypes: ["order-to-audit-log"] }),
    });
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });

  it("fails closed when the link type cannot be resolved in ontology metadata", async () => {
    sandboxWith([
      { op: "link", linkType: "ghost-link", sourcePrimaryKey: "order-1", targetPrimaryKey: "x" },
    ]);
    await expect(invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order"],
      importedLinkTypes: ["ghost-link"], // declared, but metadata absent
      linkMetadata: [],
    }))).rejects.toMatchObject({
      code: "FUNCTION_LINK_TYPE_UNRESOLVED",
      statusCode: 422,
      details: expect.objectContaining({ linkTypes: ["ghost-link"] }),
    });
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });

  it("fails closed on AMBIGUOUS link metadata (>2 distinct endpoints)", async () => {
    sandboxWith([
      { op: "link", linkType: "order-to-customer", sourcePrimaryKey: "order-1", targetPrimaryKey: "cust-1" },
    ]);
    await expect(invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order", "Customer", "Supplier"],
      importedLinkTypes: ["order-to-customer"],
      linkMetadata: [
        { api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Customer" },
        { api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Supplier" }, // branch variant
      ],
    }))).rejects.toMatchObject({ code: "FUNCTION_LINK_TYPE_UNRESOLVED" });
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });

  it("rejects the WHOLE mixed batch when one link op is unauthorized — zero partial writes", async () => {
    sandboxWith([
      { op: "update", objectType: "Order", primaryKey: "order-1", patch: { status: "x" } },
      { op: "link", linkType: "order-to-customer", sourcePrimaryKey: "order-1", targetPrimaryKey: "cust-1" },
    ]);
    await expect(invoke(dbWith({
      functionKind: "edit",
      importedTypes: ["Order"], // Customer undeclared → the link op is unauthorized
      importedLinkTypes: ["order-to-customer"],
      linkMetadata: [{ api_name: "order-to-customer", a_api_name: "Order", b_api_name: "Customer" }],
    }))).rejects.toMatchObject({ code: "FUNCTION_EDIT_SCOPE_VIOLATION" });
    // The permitted update in the same batch must NOT commit either.
    expect(applyFunctionEditsMock).not.toHaveBeenCalled();
  });
});
