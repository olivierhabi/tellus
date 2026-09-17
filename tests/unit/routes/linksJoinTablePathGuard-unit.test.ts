/**
 * Finding B (CWE-22) — route-level guard for joinTableFilePath.
 *
 * Drives the real POST / and PUT /:apiName handlers from src/routes/links.ts
 * with mock req/res objects and pins:
 *
 *   - traversal / absolute paths outside the upload dir are rejected with
 *     VALIDATION_FAILED before the model/DB is touched;
 *   - a legitimate path inside the join-table upload directory passes the
 *     guard and reaches the model layer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const queryMock = vi.fn(async () => ({ rows: [] }));

vi.mock("../../../src/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/services/opensearch/client", () => ({
  client: {
    search: vi.fn(),
    count: vi.fn(),
    get: vi.fn(),
    indices: { exists: vi.fn() },
  },
  injectSecurityFilter: (body: unknown) => body,
}));

import router from "../../../src/routes/links";
import { joinTableBaseDir } from "../../../src/services/linkResolverService";

const GUARD_MESSAGE =
  "joinTableFilePath must reference a join-table CSV under data/join_tables (set it via the /upload endpoint).";

const VALID_BODY = {
  displayName: "Customer orders",
  cardinality: "MANY_TO_MANY",
  sourceObjectTypeApiName: "Customer",
  targetObjectTypeApiName: "Order",
};

type MockRes = {
  statusCode: number;
  body: any;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  setHeader: (...args: unknown[]) => MockRes;
};

function mockReq(method: string, params: Record<string, string>, body: Record<string, unknown>) {
  return {
    method,
    params,
    body,
    headers: {},
    query: {},
    tellusPrincipal: { roles: ["ontology-editor"] },
  } as any;
}

function mockRes(req: unknown): MockRes {
  const res: any = { req, statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  res.setHeader = () => res;
  return res as MockRes;
}

function findRoute(method: "post" | "put", routePath: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`);
  return layer;
}

async function invokeRoute(layer: any, req: any, res: MockRes) {
  for (const l of layer.route.stack) {
    let advanced = false;
    let err: unknown = null;
    await l.handle(req, res, (e?: unknown) => {
      advanced = true;
      err = e ?? null;
    });
    if (err) throw err;
    if (!advanced) break; // response sent, chain stops
  }
}

describe("links route joinTableFilePath guard (CWE-22)", () => {
  let tmpRoot: string;
  let joinDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "jt-route-"));
    joinDir = path.join(tmpRoot, "data", "join_tables");
    mkdirSync(joinDir, { recursive: true });
    process.env.JOIN_TABLE_DIR = joinDir;
    queryMock.mockClear();
  });

  afterEach(() => {
    delete process.env.JOIN_TABLE_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("POST / rejects an absolute path outside the upload dir before the model is touched", async () => {
    const req = mockReq("POST", { ontologyId: "ont-1" }, { ...VALID_BODY, joinTableFilePath: "/etc/passwd" });
    const res = mockRes(req);

    await invokeRoute(findRoute("post", "/"), req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(res.body.message).toContain(
      "joinTableFilePath must reference a join-table CSV under data/join_tables",
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("POST / rejects relative traversal escaping the upload dir", async () => {
    const req = mockReq("POST", { ontologyId: "ont-1" }, { ...VALID_BODY, joinTableFilePath: `${joinDir}/../../../etc/passwd` });
    const res = mockRes(req);

    await invokeRoute(findRoute("post", "/"), req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("PUT /:apiName rejects an absolute path outside the upload dir", async () => {
    const req = mockReq("PUT", { ontologyId: "ont-1", apiName: "customerOrders" }, { joinTableFilePath: "/etc/passwd" });
    const res = mockRes(req);

    await invokeRoute(findRoute("put", "/:apiName"), req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(res.body.message).toContain("joinTableFilePath must reference");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("PUT /:apiName rejects a null-byte path", async () => {
    const req = mockReq("PUT", { ontologyId: "ont-1", apiName: "customerOrders" }, { joinTableFilePath: `${joinDir}/x.csv\0` });
    const res = mockRes(req);

    await invokeRoute(findRoute("put", "/:apiName"), req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
  });

  it("POST / accepts an upload-dir path and reaches the model layer", async () => {
    const goodPath = path.join(joinTableBaseDir(), "1710000000000-orders.csv");
    const req = mockReq("POST", { ontologyId: "ont-1" }, { ...VALID_BODY, joinTableFilePath: goodPath });
    const res = mockRes(req);

    try {
      await invokeRoute(findRoute("post", "/"), req, res);
    } catch {
      // A downstream (mocked) model failure is fine — we only assert the
      // guard let the request through to the model layer.
    }

    expect(res.body?.errorCode).not.toBe("VALIDATION_FAILED");
    expect(String(res.body?.message ?? "")).not.toContain("joinTableFilePath must reference");
    expect(queryMock).toHaveBeenCalled(); // guard passed, model layer reached
  });

  it("PUT /:apiName accepts an upload-dir path and reaches the model", async () => {
    const req = mockReq("PUT", { ontologyId: "ont-1", apiName: "customerOrders" }, { joinTableFilePath: path.join(joinTableBaseDir(), "1710000000001-orders.csv") });
    const res = mockRes(req);

    try {
      await invokeRoute(findRoute("put", "/:apiName"), req, res);
    } catch {
      // Same as POST — a mocked-model failure does not fail this test.
    }

    expect(res.body?.message ?? "").not.toContain("joinTableFilePath must reference");
    expect(queryMock).toHaveBeenCalled();
  });
});
