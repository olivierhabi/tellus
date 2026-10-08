// ---------------------------------------------------------------------------
// POST /reindex — REINDEX_TOO_LARGE must surface as HTTP 413 (§4.3).
//
// assertDatasourceMergeBudget throws REINDEX_TOO_LARGE inside
// reindexObjectType, and both formatters map that code to 413 — but the
// route's execute-step catch used to rewrite EVERY error into a 500
// REINDEX_FAILED, so the operator never saw the 413 nor its remediation.
// This drives the real route handler with db / auth / service mocked.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const reindexObjectType = vi.fn();

vi.mock("../../../src/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: async (sql: string) => {
      const s = sql.replace(/\s+/g, " ");
      let rows: Record<string, unknown>[] = [];
      if (/FROM ontology WHERE/.test(s)) rows = [{ ontology_id: "ont-1" }];
      else if (/FROM object_type ot JOIN ontology/.test(s))
        rows = [{ object_type_id: "ot-1", api_name: "Account", primary_key_property_id: null }];
      else if (/FROM backing_datasource/.test(s))
        rows = [{ object_type_id: "ot-1", file_path: "a.csv", dataset_id: null }];
      else if (/INSERT INTO funnel_state/.test(s)) rows = [{ object_type_id: "ot-1" }];
      return { rowCount: rows.length, rows };
    },
  };
});

vi.mock("../../../src/services/reindexService", () => ({
  reindexObjectType: (...args: unknown[]) => reindexObjectType(...args),
}));

vi.mock("../../../src/middleware/requireRole", () => ({
  requireOntologyAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../src/utils/requestTenant", () => ({
  resolveRequestTenant: () => "default",
}));

import router, { PASSTHROUGH_REINDEX_CODES } from "../../../src/routes/reindex";

type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<unknown>;

function postHandler(): Handler {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === "/" && l.route.methods.post);
  if (!layer?.route) throw new Error("POST / route not found");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    locals: {},
    req: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const req = () => ({
  params: { ontologyId: "ont-1", apiName: "Account" },
  query: { force: "true" },
  body: {},
});

beforeEach(() => {
  reindexObjectType.mockReset();
  delete process.env.FUNNEL_OPENSEARCH_PIPELINE;
});

describe("POST /reindex error status mapping", () => {
  it("passes REINDEX_TOO_LARGE through as 413 (not 500)", async () => {
    expect(PASSTHROUGH_REINDEX_CODES.has("REINDEX_TOO_LARGE")).toBe(true);
    reindexObjectType.mockRejectedValue(
      Object.assign(
        new Error("Account has 2000001 distinct PKs (> 2000000); use the funnel"),
        { code: "REINDEX_TOO_LARGE" },
      ),
    );
    const res = mockRes();
    const next = vi.fn();
    await postHandler()(req(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
    const body = res.body as { errorCode: string; message: string };
    expect(body.errorCode).toBe("REINDEX_TOO_LARGE");
    expect(body.message).toContain("Account");
  });

  it("still maps an ordinary reindex failure to 500 REINDEX_FAILED", async () => {
    reindexObjectType.mockRejectedValue(new Error("boom"));
    const res = mockRes();
    await postHandler()(req(), res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: string }).error).toBe("REINDEX_FAILED");
  });
});
