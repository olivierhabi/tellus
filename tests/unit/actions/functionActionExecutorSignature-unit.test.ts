// ---------------------------------------------------------------------------
// functionActionExecutorSignature — Phase 4 executor-level tests.
//
// The executor resolves the signature metadata for the EXACT pinned
// (function_rid, branch, semver) row and threads it to the sandbox as
// the primary binding source. Missing/malformed metadata falls back
// (undefined → legacy toString() path). Object-reference hydration
// composes with metadata binding.
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

// The executor threads the parsed metadata as a contract-bound
// SandboxBinding: unpinned rows (no invocation_contract column in these
// fixtures) execute under the byte-identical legacy contract.
const parsed = (signature: typeof V1_SIGNATURE) => ({
  contract: "legacy-object-envelope-v1",
  parameters: signature.parameters.map((parameter, position) => ({
    name: parameter.name,
    optional: parameter.optional,
    position,
    injected: parameter.type === "Client" ? ("client" as const) : undefined,
  })),
});

function makeBinding(semver: string) {
  return {
    functionRid: "ri.function-registry.main.function.update-order",
    repositoryRid: "ri.stemma.main.repository.orders",
    apiName: "updateOrder",
    branch: "main",
    semver,
    autoUpgrade: false,
  };
}

const V1_SIGNATURE = {
  parameters: [
    { name: "client", type: "Client", optional: false },
    { name: "order", type: "Osdk.Instance<Order>", optional: false },
  ],
  output: "Edits.Object<Order>[]",
};

const V2_SIGNATURE = {
  parameters: [
    { name: "client", type: "Client", optional: false },
    { name: "order", type: "Osdk.Instance<Order>", optional: false },
    { name: "reason", type: "string", optional: true },
  ],
  output: "Edits.Object<Order>[]",
};

function versionRow(semver: string) {
  return {
    repository_rid: "ri.stemma.main.repository.orders",
    api_name: "updateOrder",
    state: "AVAILABLE",
    runtime: "NODE_20",
    manifest_json: {
      sources: {
        updateOrder: `export default function updateOrder(order) { return []; } // ${semver}`,
      },
    },
    signature: semver === "1.0.0" ? V1_SIGNATURE : V2_SIGNATURE,
    function_kind: "edit",
  };
}

function setupHappyPath(semvers: string[]) {
  const query = vi.fn();
  for (const semver of semvers) {
    query.mockResolvedValueOnce({ rows: [versionRow(semver)] });
    query.mockResolvedValueOnce({
      rows: [{ ontology_id: `ri.ontology.main.ontology.${ONTOLOGY_ID}`, api_name: "Order" }],
    });
  }
  const db = { query } as never;
  const order = {
    $apiName: "Order",
    $primaryKey: "order-1",
    $title: "Order 1",
    status: "open",
  };
  loadSnapshotMock.mockResolvedValue({
    byType: new Map([["Order", new Map([["order-1", order]])]]),
    ontologyId: ONTOLOGY_ID,
    objectCount: 1,
    objectTypes: ["Order"],
    importedTypes: ["Order"],
  });
  runSandboxMock.mockResolvedValue({
    status: "ok",
    output: [],
    edits: [],
    logs: [],
    requestedTypes: ["Order"],
    durationMs: 1,
  });
  applyFunctionEditsMock.mockResolvedValue({
    created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0,
  });
  return { db, order, query };
}

function invoke(db: never, semver: string) {
  return executeFunctionAction(
    {
      ontologyId: ONTOLOGY_ID,
      binding: makeBinding(semver),
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

describe("executeFunctionAction — signature-metadata binding (Phase 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves metadata for the EXACT pinned version, per invocation", async () => {
    const { db } = setupHappyPath(["1.0.0", "2.0.0"]);

    await invoke(db, "1.0.0");
    await invoke(db, "2.0.0");

    expect(runSandboxMock).toHaveBeenCalledTimes(2);
    const v1Call = runSandboxMock.mock.calls[0];
    const v2Call = runSandboxMock.mock.calls[1];

    // The pinned 1.0.0 signature (2 params) reaches the sandbox…
    expect(v1Call[3]).toEqual(parsed(V1_SIGNATURE));
    // …and the pinned 2.0.0 signature (3 params, optional `reason`).
    expect(v2Call[3]).toEqual(parsed(V2_SIGNATURE));
  });

  it("hydrates object references BEFORE metadata binding receives them", async () => {
    const { db, order } = setupHappyPath(["2.0.0"]);

    await invoke(db, "2.0.0");

    const [, args] = runSandboxMock.mock.calls[0];
    expect(args.order).toEqual(order); // hydrated instance, not the PK
    expect(runSandboxMock.mock.calls[0][3]).toEqual(parsed(V2_SIGNATURE));
  });

  it("falls back (undefined signatureParams) when the row has no signature", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ ...versionRow("1.0.0"), signature: null }],
      })
      .mockResolvedValueOnce({
        rows: [{ ontology_id: `ri.ontology.main.ontology.${ONTOLOGY_ID}`, api_name: "Order" }],
      });
    const db = { query } as never;
    loadSnapshotMock.mockResolvedValue({
      byType: new Map([["Order", new Map([["order-1", {
        $apiName: "Order", $primaryKey: "order-1", $title: "Order 1", status: "open",
      }]])]]),
      ontologyId: ONTOLOGY_ID,
      objectCount: 1,
      objectTypes: ["Order"],
      importedTypes: ["Order"],
    });
    runSandboxMock.mockResolvedValue({
      status: "ok", output: [], edits: [], logs: [], requestedTypes: [], durationMs: 1,
    });
    applyFunctionEditsMock.mockResolvedValue({
      created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0,
    });

    await invoke(db, "1.0.0");

    expect(runSandboxMock.mock.calls[0][3]).toEqual({
      contract: "legacy-object-envelope-v1",
      parameters: undefined,
    });
  });

  it("falls back (undefined signatureParams) on malformed signature metadata", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ ...versionRow("1.0.0"), signature: { parameters: "corrupted" } }],
      })
      .mockResolvedValueOnce({
        rows: [{ ontology_id: `ri.ontology.main.ontology.${ONTOLOGY_ID}`, api_name: "Order" }],
      });
    const db = { query } as never;
    loadSnapshotMock.mockResolvedValue({
      byType: new Map([["Order", new Map([["order-1", {
        $apiName: "Order", $primaryKey: "order-1", $title: "Order 1", status: "open",
      }]])]]),
      ontologyId: ONTOLOGY_ID,
      objectCount: 1,
      objectTypes: ["Order"],
      importedTypes: ["Order"],
    });
    runSandboxMock.mockResolvedValue({
      status: "ok", output: [], edits: [], logs: [], requestedTypes: [], durationMs: 1,
    });
    applyFunctionEditsMock.mockResolvedValue({
      created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0,
    });

    await invoke(db, "1.0.0");

    expect(runSandboxMock.mock.calls[0][3]).toEqual({
      contract: "legacy-object-envelope-v1",
      parameters: undefined,
    });
  });
});
