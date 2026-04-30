// ---------------------------------------------------------------------------
// tests/unit/middleware/requestId-unit.test.ts
//
// F-P4-03 negative test. Pre-fix behaviour: inbound X-Request-ID was
// silently dropped; every request got a fresh UUID regardless of upstream
// correlation id. Post-fix behaviour: inbound id is honoured when safe,
// and replaced only when unsafe (injection guard).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
  setGauge: vi.fn(),
}));

import { requestId } from "../../../src/middleware/requestId";
import { incCounter } from "../../../src/services/funnel/metrics";

const incMock = incCounter as unknown as ReturnType<typeof vi.fn>;

function makeReqRes(inbound?: string) {
  const req: any = {
    headers: inbound !== undefined ? { "x-request-id": inbound } : {},
  };
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => { headers[k] = v; return res; },
    __headers: headers,
  };
  return { req, res };
}

describe("requestId middleware (F-P4-03)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adopts a safe inbound X-Request-ID verbatim", () => {
    const { req, res } = makeReqRes("abc-123_DEF");
    const next = vi.fn();
    requestId()(req, res, next);
    expect(req.requestId).toBe("abc-123_DEF");
    expect(res.__headers["X-Request-ID"]).toBe("abc-123_DEF");
    expect(next).toHaveBeenCalled();
    expect(incMock).toHaveBeenCalledWith(
      "tellus_request_id_origin_total",
      { source: "inbound" },
    );
  });

  it("mints a fresh UUID when no inbound id is present", () => {
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requestId()(req, res, next);
    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.__headers["X-Request-ID"]).toBe(req.requestId);
    expect(incMock).toHaveBeenCalledWith(
      "tellus_request_id_origin_total",
      { source: "minted" },
    );
  });

  it("F-P4-03 negative: unsafe inbound id (log injection attempt) is rejected and replaced", () => {
    // Contains a newline — pre-fix code could inject log entries.
    // Safe pattern ^[A-Za-z0-9_.-]{1,128}$ rejects this; we mint a fresh id.
    const { req, res } = makeReqRes("evil\nid");
    const next = vi.fn();
    requestId()(req, res, next);
    expect(req.requestId).not.toBe("evil\nid");
    expect(req.requestId).toMatch(/^[0-9a-f]{8}-/);
    expect(incMock).toHaveBeenCalledWith(
      "tellus_request_id_origin_total",
      { source: "minted" },
    );
  });

  it("rejects inbound id exceeding 128 chars", () => {
    const long = "a".repeat(129);
    const { req, res } = makeReqRes(long);
    const next = vi.fn();
    requestId()(req, res, next);
    expect(req.requestId).not.toBe(long);
    expect(req.requestId.length).toBeLessThanOrEqual(128);
  });

  it("handles arrayed x-request-id header by using first entry", () => {
    const { req, res } = makeReqRes();
    req.headers["x-request-id"] = ["valid-id", "second"];
    const next = vi.fn();
    requestId()(req, res, next);
    expect(req.requestId).toBe("valid-id");
  });

  it("next is always called", () => {
    const { req, res } = makeReqRes("ok");
    const next = vi.fn();
    requestId()(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
