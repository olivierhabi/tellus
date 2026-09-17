// ---------------------------------------------------------------------------
// GET /api/v1/audit/log/:executionId — linkIndexAck status overlay (Fix 1).
//
//   * flag OFF ⇒ byte-compatible audit body (no `indexVisibility`)
//   * flag ON + execution staged NO link events ⇒ null ⇒ field ABSENT
//     (byte-compatible even with the flag on — e.g. a non-link action)
//   * flag ON + events PENDING ⇒ additive `indexVisibility: "PENDING"`
//   * flag ON + events VISIBLE ⇒ additive `indexVisibility: "VISIBLE"`
//
// `result` is the PG COMMIT outcome; the two vocabularies are documented on
// the same endpoint as intentionally separate.
// ---------------------------------------------------------------------------

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Response } from "express";
import request from "supertest";

const { queryMock, probeMock, sendErrorStub } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  probeMock: vi.fn(),
  // sendError stub actually writes the error response so supertest gets
  // an answer on the 404 path. Real utils/responseFormatter does likewise.
  sendErrorStub: vi.fn((res: Response, code: string, msg: string) => {
    res.status(400).json({ errorCode: code, message: msg });
    return true;
  }),
}));

vi.mock("../../../src/db", () => ({ query: queryMock }));
vi.mock("../../../src/actions/linkIndexAckHttp", () => ({
  // The audit route only imports the probe via this factory; the route's
  // status-overlay is additive-only, so the rest of the module's exports
  // (the write-side mapper) are unused here and may stay undefined.
  probeExecutionIndexVisibility: probeMock,
}));
vi.mock("../../../src/utils/responseFormatter", () => ({
  sendError: sendErrorStub,
}));

import { globalAuditRouter } from "../../../src/routes/auditLog";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // vuln-0009: the global audit handlers are gated on the ontology-admin
  // role (authorize("ontology-admin")). Mount a minimal admin principal so
  // the route contract itself stays under test; the authz gate has its own
  // regression coverage.
  app.use((req, _res, next) => {
    (req as unknown as { user?: { id: string; roles: string[] } }).user = {
      id: "test-admin",
      roles: ["ontology-admin"],
    };
    next();
  });
  app.use("/api/v1/audit", globalAuditRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: { message: err.message } });
  });
  return app;
}

const AUDIT_ROW = {
  audit_id: "a-1",
  action_type_api_name: "addLink",
  action_type_display_name: "Add Link",
  execution_id: "exec-1",
  parameters: {},
  affected_objects: [],
  affected_object_count: 0,
  result: "success",
  failure_type: null,
  error_message: null,
  duration_ms: 5,
  executed_by: "alice",
  executed_at: "2026-08-03T12:00:00.000Z",
  source_ip: null,
  branch_id: null,
  correlation_id: null,
};

// The stable audit fields — correlationId was added by the Rwanda traceability
// contract and is independent of the optional index-visibility overlay.
const LEGACY_KEYS = [
  "auditId",
  "actionTypeApiName",
  "actionTypeDisplayName",
  "executionId",
  "parameters",
  "affectedObjects",
  "affectedObjectCount",
  "result",
  "failureType",
  "errorMessage",
  "durationMs",
  "executedBy",
  "executedAt",
  "sourceIp",
  "branchId",
  "correlationId",
];

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockReset();
  probeMock.mockReset();
});

describe("GET /api/v1/audit/log/:executionId — indexVisibility overlay", () => {
  it("flag OFF ⇒ byte-compatible audit body, no `indexVisibility` key (invariant #2)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "false";
    queryMock.mockResolvedValueOnce({ rows: [AUDIT_ROW] });
    const r = await request(buildApp()).get("/api/v1/audit/log/exec-1");
    expect(r.status).toBe(200);
    expect("indexVisibility" in r.body).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(LEGACY_KEYS.sort());
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("flag ON + probe returns null (no link events) ⇒ field ABSENT (byte-compatible even with the flag on)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    queryMock.mockResolvedValueOnce({ rows: [AUDIT_ROW] });
    probeMock.mockResolvedValueOnce(null);
    const r = await request(buildApp()).get("/api/v1/audit/log/exec-1");
    expect(r.status).toBe(200);
    expect("indexVisibility" in r.body).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(LEGACY_KEYS.sort());
  });

  it("flag ON + probe returns PENDING ⇒ additive `indexVisibility: 'PENDING'` (202 is terminal: statusUrl is the only catch-up signal)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    queryMock.mockResolvedValueOnce({ rows: [AUDIT_ROW] });
    probeMock.mockResolvedValueOnce("PENDING");
    const r = await request(buildApp()).get("/api/v1/audit/log/exec-1");
    expect(r.status).toBe(200);
    expect(r.body.indexVisibility).toBe("PENDING");
    expect(Object.keys(r.body).sort()).toEqual([...LEGACY_KEYS, "indexVisibility"].sort());
    // The dual vocabulary: result="success" (commit), indexVisibility="PENDING" (serving).
    expect(r.body.result).toBe("success");
  });

  it("flag ON + probe returns VISIBLE ⇒ additive `indexVisibility: 'VISIBLE'`", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    queryMock.mockResolvedValueOnce({ rows: [AUDIT_ROW] });
    probeMock.mockResolvedValueOnce("VISIBLE");
    const r = await request(buildApp()).get("/api/v1/audit/log/exec-1");
    expect(r.status).toBe(200);
    expect(r.body.indexVisibility).toBe("VISIBLE");
  });

  it("404 keeps byte-compatible (no overlay when the audit row itself is missing)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    queryMock.mockResolvedValueOnce({ rows: [] });
    const r = await request(buildApp()).get("/api/v1/audit/log/ghost");
    expect(r.status).toBe(400);
    expect(probeMock).not.toHaveBeenCalled();
  });
});

// Restore env to the test lane's default so other files are unaffected.
afterAll(() => {
  delete process.env.LINK_INDEX_ACK_REQUIRED;
});
