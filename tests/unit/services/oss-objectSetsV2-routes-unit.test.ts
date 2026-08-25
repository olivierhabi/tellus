import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compileObjectSet: vi.fn(),
  loadObjectSet: vi.fn(),
  aggregateObjectSet: vi.fn(),
  requireOntology: vi.fn(async () => "ontology-id"),
  tempResolve: vi.fn(),
  savedGet: vi.fn(),
  getLinkType: vi.fn(),
  resolveObjectTypeApiName: vi.fn(),
  resolveLinks: vi.fn(),
  composeReadContextLinkTargets: vi.fn(),
}));

vi.mock("../../../src/services/oss/objectSetCompiler", () => ({
  compileObjectSet: mocks.compileObjectSet,
}));
vi.mock("../../../src/services/oss/objectSetExecutor", () => ({
  loadObjectSet: mocks.loadObjectSet,
  aggregateObjectSet: mocks.aggregateObjectSet,
}));
vi.mock("../../../src/services/oss/productionDeps", () => ({
  makeProductionCompilerDeps: () => ({}),
  makeProductionExecutorDeps: () => ({}),
  resolveInterfacePropertyMapping: vi.fn(),
}));
vi.mock("../../../src/services/oss/objectSetStore", () => ({
  temporaryObjectSetStore: {
    create: vi.fn(),
    resolve: mocks.tempResolve,
  },
  savedObjectSetStore: { get: mocks.savedGet },
}));
vi.mock("../../../src/routes/v2/ontologyParam", () => ({
  requireOntology: mocks.requireOntology,
}));
vi.mock("../../../src/utils/requestTenant", () => ({
  resolveRequestTenant: () => "tenant-test",
}));
vi.mock("../../../src/middleware/securityContext", () => ({
  buildSecurityFilter: () => ({ bool: { filter: [] } }),
  requireSecurityContext: (req: { security: unknown }) => req.security,
}));
vi.mock("../../../src/services/security/propertyMarkingGuard", () => ({
  enforceQueryMarkings: vi.fn(async () => new Map()),
  stripRestrictedRows: vi.fn(),
}));
vi.mock("../../../src/services/oss/readContext", () => ({
  resolveReadContexts: async () => ({ transaction: null, scenario: null }),
  composeReadContextLinkTargets: mocks.composeReadContextLinkTargets,
}));
vi.mock("../../../src/models/linkType", () => ({
  default: { getByApiName: mocks.getLinkType },
  resolveObjectTypeApiName: mocks.resolveObjectTypeApiName,
}));
vi.mock("../../../src/services/linkResolverService", () => ({
  resolveLinks: mocks.resolveLinks,
}));
vi.mock("../../../src/db", () => ({
  query: vi.fn(),
  pool: {},
}));

import objectSetsV2Router from "../../../src/routes/v2/objectSetsV2";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    Object.assign(req, {
      user: { id: "user-1" },
      security: {
        userId: "user-1",
        markings: [],
        cbac: [],
        organizations: [],
        markingMode: "disjunctive",
        systemPrincipal: false,
        markingBypass: false,
      },
    });
    next();
  });
  instance.use("/api/v2/ontologies/:ontology", objectSetsV2Router);
  return instance;
}

describe("ObjectSet v2 route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compileObjectSet.mockResolvedValue({
      plans: [{ objectType: "Employee" }],
      crossType: false,
    });
    mocks.loadObjectSet.mockResolvedValue({
      data: [
        {
          __apiName: "Employee",
          __primaryKey: "E-1",
          __rid: "ri.tellus.main.object.1",
          name: "Ada",
        },
      ],
      nextPageToken: null,
      totalCount: "1",
      propertySecurities: [],
    });
    mocks.getLinkType.mockResolvedValue({
      api_name: "worksAt",
      source_object_type: "employee-type-id",
      target_object_type: "company-type-id",
    });
    mocks.resolveObjectTypeApiName.mockImplementation(async (id: string) =>
      id === "employee-type-id" ? "Employee" : "Company",
    );
    mocks.resolveLinks.mockResolvedValue({
      linkedObjects: [{ __pk: "C-1" }],
      totalCount: 1,
      nextPageToken: null,
    });
    mocks.composeReadContextLinkTargets.mockImplementation(
      async (input: { baseTargetPrimaryKeys: string[] }) =>
        input.baseTargetPrimaryKeys,
    );
  });

  it("serves the SDK loadObjectsMultipleObjectTypes path and $ metadata", async () => {
    const response = await request(app())
      .post(
        "/api/v2/ontologies/main/objectSets/loadObjectsMultipleObjectTypes?preview=true",
      )
      .send({
        objectSet: { type: "base", objectType: "Employee" },
        select: [],
        selectV2: [],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      $apiName: "Employee",
      $primaryKey: "E-1",
      $rid: "ri.tellus.main.object.1",
      name: "Ada",
    });
    expect(response.body.propertySecurities).toEqual([]);
  });

  it("rejects fields absent from the objects-or-interfaces request", async () => {
    const response = await request(app())
      .post(
        "/api/v2/ontologies/main/objectSets/loadObjectsOrInterfaces?preview=true",
      )
      .send({
        objectSet: { type: "base", objectType: "Employee" },
        select: [],
        selectV2: [],
        includeComputeUsage: true,
      });

    expect(response.status).toBe(400);
    expect(response.body.errorName).toBe("InvalidLoadObjectSetRequest");
    expect(mocks.compileObjectSet).not.toHaveBeenCalled();
  });

  it("accepts transaction/scenario context for context-aware loadLinks", async () => {
    const response = await request(app())
      .post(
        "/api/v2/ontologies/main/objectSets/loadLinks?transactionId=tx-1",
      )
      .send({
        objectSet: { type: "base", objectType: "Employee" },
        links: ["worksAt"],
      });

    expect(response.status).not.toBe(400);
  });

  it("normalizes raw resolver __pk values before secured link loading", async () => {
    mocks.loadObjectSet
      .mockResolvedValueOnce({
        data: [{ __apiName: "Employee", __primaryKey: "E-1" }],
        nextPageToken: null,
        totalCount: "1",
        propertySecurities: [],
      })
      .mockResolvedValueOnce({
        data: [{ __apiName: "Company", __primaryKey: "C-1" }],
        nextPageToken: null,
        totalCount: "1",
        propertySecurities: [],
      });

    const response = await request(app())
      .post("/api/v2/ontologies/main/objectSets/loadLinks")
      .send({
        objectSet: { type: "base", objectType: "Employee" },
        links: ["worksAt"],
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mocks.composeReadContextLinkTargets).toHaveBeenCalledWith(
      expect.objectContaining({ baseTargetPrimaryKeys: ["C-1"] }),
    );
    expect(response.body.data[0].linkedObjects).toEqual([
      {
        targetObject: {
          __primaryKey: "C-1",
          __apiName: "Company",
        },
        linkType: "worksAt",
      },
    ]);
  });

  it("gets a tenant-scoped temporary ObjectSet by RID", async () => {
    mocks.tempResolve.mockResolvedValue({
      type: "base",
      objectType: "Employee",
    });
    const rid = "ri.object-set.main.temporary-object-set.abc";
    const response = await request(app()).get(
      `/api/v2/ontologies/main/objectSets/${rid}?preview=true`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      type: "base",
      objectType: "Employee",
    });
    expect(mocks.tempResolve).toHaveBeenCalledWith(
      rid,
      expect.objectContaining({
        tenant: "tenant-test",
        ontologyRid: "ontology-id",
      }),
    );
  });
});
