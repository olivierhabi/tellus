// ---------------------------------------------------------------------------
// tests/unit/audit/readAudit-unit.test.ts
//
// Tests for src/middleware/readAudit.ts (F-P3-11 read-audit closure).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  setGauge: vi.fn(),
  observeHistogram: vi.fn(),
}));

vi.mock("../../../src/models/actionAuditLog", () => ({
  logStandaloneFailureAudit: logMock,
  appendAuditRow: vi.fn(),
  AuditDurabilityError: class extends Error {
    code = "AUDIT_DURABILITY_FAILED";
    statusCode = 503;
  },
}));

import {
  readAuditMiddleware,
  annotateReadAudit,
  setReadAuditResultCount,
} from "../../../src/middleware/readAudit";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

function makeReqRes(overrides: { status?: number } = {}) {
  const req: any = {
    originalUrl: "/api/v1/ontology/o1/objects/Employee/emp-1",
    method: "GET",
    headers: { "x-forwarded-for": "10.0.0.1" },
    ip: "10.0.0.2",
    auth: { preferred_username: "alice" },
  };
  const res: any = new EventEmitter();
  res.statusCode = overrides.status ?? 200;
  return { req, res };
}

async function waitForTick() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("readAuditMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logMock.mockResolvedValue({ auditId: "aud-1", rowHash: "hash-1" });
  });

  it("does NOT emit a read-audit row when the route did not annotate", async () => {
    const mw = readAuditMiddleware();
    const { req, res } = makeReqRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    res.emit("finish");
    await waitForTick();
    expect(logMock).not.toHaveBeenCalled();
  });

  it("emits exactly one audit row after res.on('finish') when annotated", async () => {
    const mw = readAuditMiddleware();
    const { req, res } = makeReqRes();
    const next = vi.fn();
    mw(req, res, next);
    annotateReadAudit(req, {
      category: "object.read",
      ontologyId: "o1",
      objectTypeApiName: "Employee",
      primaryKey: "emp-1",
    });
    setReadAuditResultCount(req, 1);
    res.emit("finish");
    await waitForTick();
    expect(logMock).toHaveBeenCalledTimes(1);
    const call = logMock.mock.calls[0][0];
    expect(call.action_type_api_name).toBe("__read.object.read");
    expect(call.result).toBe("success");
    expect(call.parameters.ontology_id).toBe("o1");
    expect(call.parameters.object_type).toBe("Employee");
    expect(call.affected_object_count).toBe(1);
    expect(call.executed_by).toBe("alice");
    expect(call.source_ip).toBe("10.0.0.1");
    expect(incMock).toHaveBeenCalledWith(
      "tellus_read_audit_emitted_total",
      { category: "object.read", outcome: "success" },
    );
  });

  it("marks outcome='failed' when response status >= 400", async () => {
    const mw = readAuditMiddleware();
    const { req, res } = makeReqRes({ status: 404 });
    const next = vi.fn();
    mw(req, res, next);
    annotateReadAudit(req, { category: "object.read", ontologyId: "o1" });
    res.emit("finish");
    await waitForTick();
    const call = logMock.mock.calls[0][0];
    expect(call.result).toBe("failed");
    expect(call.failure_type).toBe("unclassified");
    expect(call.metadata.status_code).toBe(404);
    expect(incMock).toHaveBeenCalledWith(
      "tellus_read_audit_emitted_total",
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("emission failure increments tellus_read_audit_failed_total (not swallowed)", async () => {
    logMock.mockRejectedValueOnce(new Error("chain head missing"));
    const mw = readAuditMiddleware();
    const { req, res } = makeReqRes();
    const next = vi.fn();
    mw(req, res, next);
    annotateReadAudit(req, { category: "object.search", ontologyId: "o1" });
    res.emit("finish");
    await waitForTick();
    expect(incMock).toHaveBeenCalledWith(
      "tellus_read_audit_failed_total",
      expect.objectContaining({ category: "object.search" }),
    );
  });

  it("each of the 5 ReadCategory values produces category-specific counter labels", async () => {
    const categories: Array<
      "object.read" | "object.search" | "object.search_around" | "object.traverse" | "link.list"
    > = ["object.read", "object.search", "object.search_around", "object.traverse", "link.list"];
    for (const cat of categories) {
      const mw = readAuditMiddleware();
      const { req, res } = makeReqRes();
      const next = vi.fn();
      mw(req, res, next);
      annotateReadAudit(req, { category: cat });
      res.emit("finish");
      await waitForTick();
    }
    for (const cat of categories) {
      const match = incMock.mock.calls.find(
        (c) => c[0] === "tellus_read_audit_emitted_total" && (c[1] as any).category === cat,
      );
      expect(match, `counter for ${cat}`).toBeDefined();
    }
  });
});
