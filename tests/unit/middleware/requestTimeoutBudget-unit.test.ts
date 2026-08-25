// ---------------------------------------------------------------------------
// requestTimeoutMiddleware budget override (unit, fake timers — no I/O).
//
// The linkIndexAck barrier (LINK_INDEX_ACK_REQUIRED=true) can block a
// POST /apply for up to LINK_INDEX_ACK_TIMEOUT_MS while the PG commit is
// already durable — the route's answer is 202 COMMITTED_INDEX_PENDING,
// delivered AFTER the barrier resolves. The global 5 s data-plane budget
// must NOT fire first: a 504 on a committed mutation violates the
// post-commit invariant (invites retries of an already-applied edit).
// Verifying the wiring: budgetFor grants /apply(|Batch)/POST routes the
// ack deadline + headroom; every other path keeps the tight budget.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { requestTimeoutMiddleware } from "../../../src/middleware/requestTimeout";

vi.mock("../../../src/services/funnel/metrics", () => ({ incCounter: vi.fn() }));

// Mirrors the server.ts wiring (REQUEST_TIMEOUT_MS=5000,
// LINK_INDEX_ACK_TIMEOUT_MS=5000, +2 s of per-item headroom).
// The barrier wait AND the ordinary work are MULTIPLICATIVE for
// applyBatch: each item is a full action execution that waits on its
// own barrier, so a stalled N-item batch blocks ~N × (data-plane
// allowance + ack deadline). The budget scales by the parsed body's
// requests length (clamped to MAX_BATCH_SIZE=100).
const DATAPLANE_MS = 5_000;
const BARRIER_MS = 5_000;
const HEADROOM_MS = 2_000;
const MAX_ITEMS = 100;

const mw = requestTimeoutMiddleware({
  budgetFor: (req) =>
    req.method === "POST" && /\/actions\/[^/]+\/(apply|applyBatch)$/.test(req.path)
      ? Math.min(
          MAX_ITEMS,
          Math.max(
            1,
            /\/applyBatch$/.test(req.path) &&
              Array.isArray(
                (req.body as { requests?: unknown } | undefined)?.requests,
              )
              ? ((req.body as { requests: unknown[] }).requests.length || 1)
              : 1,
          ),
        ) *
        (DATAPLANE_MS + BARRIER_MS + HEADROOM_MS)
      : undefined,
});

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  headersSent: boolean;
  writableEnded: boolean;
  locals: Record<string, unknown>;
}

function run(path: string, method = "POST", body?: unknown) {
  const req = {
    path,
    method,
    route: { path },
    socket: {},
    headers: {},
    body,
  } as unknown as Request;
  const res: MockRes = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    on: vi.fn(),
    headersSent: false,
    writableEnded: false,
    locals: {},
  };
  mw(req, res as unknown as Response, () => {});
  return res;
}

describe("requestTimeoutMiddleware — linkIndexAck budget override", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("POST /apply keeps serving at t>5 s (the barrier window is live); 504 only past the ack-budget deadline", () => {
    const res = run("/api/v1/ontology/ont-1/actions/myAction/apply");
    vi.advanceTimersByTime(5_001); // past the default data-plane budget
    expect(res.status).not.toHaveBeenCalledWith(504); // barrier still owns the wire
    vi.advanceTimersByTime(3_000); // past 7 s
    expect(res.status).not.toHaveBeenCalledWith(504);
    vi.advanceTimersByTime(5_001); // past 5000 + 1×(5000+2000) = 12001 ms
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "REQUEST_TIMEOUT" }),
    );
  });

  it("POST /applyBatch with NO body counts as a single barrier window (N=1)", () => {
    const res = run("/api/v1/ontology/ont-1/actions/myAction/applyBatch");
    vi.advanceTimersByTime(5_001);
    expect(res.status).not.toHaveBeenCalledWith(504);
    vi.advanceTimersByTime(7_001); // past 12002 ms
    expect(res.status).toHaveBeenCalledWith(504);
  });

  it("POST /applyBatch with N items gets N full allowance windows — a stalled multi-item batch must NOT 504 early (committed items are never an error)", () => {
    const res = run("/api/v1/ontology/ont-1/actions/myAction/applyBatch", "POST", {
      requests: [{ parameters: {} }, { parameters: {} }, { parameters: {} }],
    });
    // One full allowance must NOT suffice for 3 items.
    vi.advanceTimersByTime(12_001);
    expect(res.status).not.toHaveBeenCalledWith(504);
    // Budget = 3×(5000+5000+2000) = 36000.
    vi.advanceTimersByTime(24_001);
    expect(res.status).toHaveBeenCalledWith(504);
  });

  it("applyBatch N is clamped to MAX_BATCH_SIZE (an oversized body cannot buy a longer budget)", () => {
    const res = run("/api/v1/ontology/ont-1/actions/myAction/applyBatch", "POST", {
      requests: Array.from({ length: 250 }, () => ({ parameters: {} })),
    });
    // Budget = 100×12000 = 1,200,000.
    vi.advanceTimersByTime(1_200_001);
    expect(res.status).toHaveBeenCalledWith(504);
  });

  it("a requests array on /apply is ignored — only applyBatch multiplies", () => {
    const res = run("/api/v1/ontology/ont-1/actions/myAction/apply", "POST", {
      requests: [{ parameters: {} }, { parameters: {} }],
    });
    vi.advanceTimersByTime(12_001); // past 5000 + 1×7000
    expect(res.status).toHaveBeenCalledWith(504);
  });

  it("unrelated routes keep the default 5 s data-plane budget", () => {
    const res = run("/api/v1/ontology/ont-1/objectTypes", "GET");
    vi.advanceTimersByTime(5_001);
    expect(res.status).toHaveBeenCalledWith(504);
  });

  it("GET on an actions path is NOT extended (only POST apply/applyBatch block on the barrier)", () => {
    const res = run("/api/v1/ontology/ont-1/actions/myAction/apply", "GET");
    vi.advanceTimersByTime(5_001);
    expect(res.status).toHaveBeenCalledWith(504);
  });

  // Regression (Fix 3 plumbing): budgetFor runs AFTER express.json, so
  // req.body.requests.length N multiplies the wire budget AND the route
  // receives a stamped `res.locals.requestBudgetDeadlineAt` it threads
  // per-item to pre-defer (ACK_RESPONSE_RESERVE_MS margin aside).
  it("stamps res.locals.requestBudgetDeadlineAt = now + budget (route reads it for per-item pre-defer)", () => {
    const t0 = Date.now();
    const res1 = run("/api/v1/ontology/ont-1/actions/myAction/apply");
    expect(res1.locals.requestBudgetDeadlineAt).toBeGreaterThanOrEqual(
      t0 + (DATAPLANE_MS + BARRIER_MS + HEADROOM_MS) - 5,
    );
    const res3 = run(
      "/api/v1/ontology/ont-1/actions/myAction/applyBatch",
      "POST",
      { requests: [{}, {}, {}] }, // exactly 3 — proves the body parser order
    );
    // Budget = 3 × 12000 = 36000.
    expect(res3.locals.requestBudgetDeadlineAt).toBeGreaterThanOrEqual(
      t0 + 3 * (DATAPLANE_MS + BARRIER_MS + HEADROOM_MS) - 5,
    );
    // N=undefined (no body-parser field) collapses to N=1 — confirm it
    // stays the single-apply budget, never overruns.
    const resUndef = run("/api/v1/ontology/ont-1/actions/myAction/applyBatch");
    expect(resUndef.locals.requestBudgetDeadlineAt).toBeGreaterThanOrEqual(
      t0 + (DATAPLANE_MS + BARRIER_MS + HEADROOM_MS) - 5,
    );
  });
});
