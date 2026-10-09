// POST /reindex?force=true must answer within the 5s request budget: a long
// reindex (6.35M rows ≈ 12 min) returned 504 REQUEST_TIMEOUT. It now answers
// 202 + statusUrl when the run outlasts the sync window, and funnel-managed
// types rebuild the serving index from object_instances (streamed) instead
// of the in-heap datasource path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reindexObjectType, syncMock, state } = vi.hoisted(() => ({
  reindexObjectType: vi.fn(),
  syncMock: vi.fn(),
  state: { funnelManaged: false, sqls: [] as string[] },
}));

vi.mock("../../../src/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: async (sql: string) => {
      const s = sql.replace(/\s+/g, " ");
      state.sqls.push(s);
      let rows: Record<string, unknown>[] = [];
      if (/FROM ontology WHERE/.test(s)) rows = [{ ontology_id: "ont-1" }];
      else if (/FROM object_type ot JOIN ontology/.test(s))
        rows = [{ object_type_id: "ot-1", api_name: "Paysim", primary_key_property_id: null }];
      else if (/FROM backing_datasource/.test(s))
        rows = [{ object_type_id: "ot-1", file_path: "a.csv", dataset_id: null }];
      else if (/INSERT INTO funnel_state/.test(s)) rows = [{ object_type_id: "ot-1" }];
      else if (/FROM funnel_run/.test(s)) rows = state.funnelManaged ? [{ "?column?": 1 }] : [];
      return { rowCount: rows.length, rows };
    },
  };
});
vi.mock("../../../src/services/reindexService", () => ({
  reindexObjectType: (...a: unknown[]) => reindexObjectType(...a),
}));
vi.mock("../../../src/services/opensearch/syncFromInstances", () => ({
  syncObjectInstancesToOpenSearch: (...a: unknown[]) => syncMock(...a),
}));
vi.mock("../../../src/services/funnel/indexingPlan", () => ({ clearIndexWatermark: vi.fn() }));
vi.mock("../../../src/middleware/requireRole", () => ({
  requireOntologyAdmin: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../../../src/utils/requestTenant", () => ({ resolveRequestTenant: () => "default" }));

import router from "../../../src/routes/reindex";

type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<unknown>;
function postHandler(): Handler {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === "/" && l.route.methods.post)!;
  return layer.route!.stack[layer.route!.stack.length - 1].handle;
}
function mockRes() {
  const res = {
    statusCode: 0, body: undefined as unknown, locals: {}, req: {},
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
  };
  return res;
}
const req = () => ({
  params: { ontologyId: "ont-1", apiName: "Paysim" },
  query: { force: "true" }, body: {},
  baseUrl: "/api/v1/ontology/ont-1/objectTypes/Paysim/reindex",
});

beforeEach(() => {
  reindexObjectType.mockReset();
  syncMock.mockReset();
  state.funnelManaged = false;
  state.sqls.length = 0;
  process.env.REINDEX_SYNC_WAIT_MS = "50";
  delete process.env.FUNNEL_OPENSEARCH_PIPELINE;
});
afterEach(() => { delete process.env.REINDEX_SYNC_WAIT_MS; });

describe("POST /reindex detached execution", () => {
  it("returns 202 + statusUrl when the run outlasts the sync window, and releases the lock if it later fails", async () => {
    let fail!: (e: Error) => void;
    reindexObjectType.mockReturnValue(new Promise((_r, rej) => { fail = rej; }));
    const res = mockRes();
    await postHandler()(req(), res, vi.fn());
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      data: { status: "accepted", pipeline: "datasource-reindex", statusUrl: "/api/v1/ontology/ont-1/objectTypes/Paysim/reindex/status" },
    });
    fail(new Error("late boom"));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.sqls.some((s) => /SET status = 'failed'/.test(s))).toBe(true);
  });

  it("still answers synchronously when the run finishes inside the window", async () => {
    reindexObjectType.mockResolvedValue({ indexed: 3 });
    const res = mockRes();
    await postHandler()(req(), res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("completed");
  });

  it("funnel-managed types rebuild from object_instances, not the datasource path", async () => {
    state.funnelManaged = true;
    syncMock.mockResolvedValue({ indexName: "ix", rowsRead: 10, rowsIndexed: 10, rowsFailed: 0 });
    const res = mockRes();
    await postHandler()(req(), res, vi.fn());
    expect(reindexObjectType).not.toHaveBeenCalled();
    expect(syncMock).toHaveBeenCalledWith("Paysim", "ont-1");
    expect(res.statusCode).toBe(200);
    expect(state.sqls.some((s) => /SET status = 'indexed'/.test(s))).toBe(true);
  });

  it("an all-rejected sync is a failure, not 'indexed'", async () => {
    state.funnelManaged = true;
    syncMock.mockResolvedValue({ indexName: "ix", rowsRead: 10, rowsIndexed: 0, rowsFailed: 10 });
    const res = mockRes();
    await postHandler()(req(), res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(state.sqls.some((s) => /SET status = 'indexed'/.test(s))).toBe(false);
  });
});
