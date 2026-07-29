// ---------------------------------------------------------------------------
// F-P4-08 / Block F — request-timeout middleware unit coverage.
//
// The middleware:
//   1. Exempts /health, /ready, /metrics (and a caller-supplied list).
//   2. Attaches `req.timeoutSignal: AbortSignal` to every non-exempt
//      request.
//   3. Fires a 504 with `errorCode: REQUEST_TIMEOUT` after
//      `timeoutMs` if the handler has not responded.
//   4. Cancels the timer on res `finish` / `close` so a fast handler
//      does not emit 504 after the fact.
//
// Negative test: drop the `controller.abort()` call on timeout and the
// abort-signal assertion below fails; drop the `res.headersSent`
// guard and the "does not fire after response" test fails.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { requestTimeoutMiddleware } from "../../../src/middleware/requestTimeout";

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  setGauge: vi.fn(),
  observeHistogram: vi.fn(),
}));

function makeReq(path = "/api/v1/objects"): any {
  return { path, method: "GET", route: { path } };
}

function makeRes() {
  const emitter = new EventEmitter();
  const res: any = emitter;
  res.headersSent = false;
  res.writableEnded = false;
  const statusSpy = vi.fn(() => res);
  const jsonSpy = vi.fn(() => res);
  res.status = statusSpy;
  res.json = jsonSpy;
  return { res, statusSpy, jsonSpy };
}

describe("requestTimeoutMiddleware (F-P4-08)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips exempt paths (no signal attached, no timer armed)", () => {
    const mw = requestTimeoutMiddleware();
    const req = makeReq("/health");
    const { res, statusSpy } = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.timeoutSignal).toBeUndefined();
    // Even after time advances, no 504 is emitted.
    vi.advanceTimersByTime(60_000);
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("attaches AbortSignal on non-exempt paths", () => {
    const mw = requestTimeoutMiddleware({ timeoutMs: 5_000 });
    const req = makeReq();
    const { res } = makeRes();
    mw(req, res, vi.fn());
    expect(req.timeoutSignal).toBeInstanceOf(AbortSignal);
    expect(req.timeoutSignal.aborted).toBe(false);
  });

  it("fires 504 + aborts signal when the handler overruns the budget", () => {
    const mw = requestTimeoutMiddleware({ timeoutMs: 5_000 });
    const req = makeReq();
    const { res, statusSpy, jsonSpy } = makeRes();
    mw(req, res, vi.fn());
    vi.advanceTimersByTime(4_999);
    expect(statusSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2); // crosses 5_000
    expect(statusSpy).toHaveBeenCalledWith(504);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "REQUEST_TIMEOUT",
        statusCode: 504,
        retryHint: "narrower_filter",
      }),
    );
    expect(req.timeoutSignal.aborted).toBe(true);
  });

  it("does NOT fire 504 after handler has already responded", () => {
    const mw = requestTimeoutMiddleware({ timeoutMs: 100 });
    const req = makeReq();
    const { res, statusSpy } = makeRes();
    mw(req, res, vi.fn());
    // Handler finishes — middleware must clear the timer.
    res.headersSent = true;
    (res as EventEmitter).emit("finish");
    vi.advanceTimersByTime(5_000);
    expect(statusSpy).not.toHaveBeenCalled();
    expect(req.timeoutSignal.aborted).toBe(false);
  });

  it("gives exact ObjectSet aggregation a bounded extended envelope", () => {
    const mw = requestTimeoutMiddleware({
      timeoutMs: 100,
      exactAggregationTimeoutMs: 1_000,
    });
    const req = makeReq(
      "/api/v2/ontologies/main/objectSets/aggregate",
    );
    req.method = "POST";
    const { res, statusSpy } = makeRes();
    mw(req, res, vi.fn());
    vi.advanceTimersByTime(999);
    expect(statusSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(statusSpy).toHaveBeenCalledWith(504);
  });

  it("honours caller-supplied extra exempt paths", () => {
    const mw = requestTimeoutMiddleware({ exemptPaths: ["/custom/stream"] });
    const req = makeReq("/custom/stream");
    const { res } = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.timeoutSignal).toBeUndefined();
  });
});
