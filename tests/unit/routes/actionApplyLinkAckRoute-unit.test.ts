// ---------------------------------------------------------------------------
// POST /apply → linkIndexAck HTTP mapping (unit; supertest + mocked executor).
//
// Contract (routes/actions.ts → actions/linkIndexAckHttp.ts):
//   * confirmed ack / flag disabled  → 200 with the pre-contract body.
//   * committed, ack NOT confirmed   → 202 COMMITTED_INDEX_PENDING with
//     executionId + statusUrl; NEVER a 4xx/5xx and NEVER result "failure".
//   * the 202 outcome is what gets cached for Idempotency-Key replays —
//     a retried request re-reads the SAME 202 (never downgraded, never
//     re-executed).
// ---------------------------------------------------------------------------

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import request from "supertest";

const {
  executeActionMock,
  checkIdempotencyKeyMock,
  storeIdempotencyKeyMock,
  withIdempotencyLockMock,
} = vi.hoisted(() => ({
  executeActionMock: vi.fn(),
  checkIdempotencyKeyMock: vi.fn(),
  storeIdempotencyKeyMock: vi.fn(),
  withIdempotencyLockMock: vi.fn(),
}));

vi.mock("../../../src/actions/actionExecutor", () => ({
  executeAction: executeActionMock,
}));

vi.mock("../../../src/actions/idempotency", () => ({
  checkIdempotencyKey: checkIdempotencyKeyMock,
  storeIdempotencyKey: storeIdempotencyKeyMock,
  // The real helper serialises on a PG advisory lock; the unit lane only
  // needs the inner closure to run.
  withIdempotencyLock: withIdempotencyLockMock.mockImplementation(
    async (_key: string, fn: () => Promise<void>) => fn()
  ),
}));

import actionsRouter from "../../../src/routes/actions";
import { limiter } from "../../../src/middleware/rateLimiter";

const ONT = "11111111-2222-3333-4444-555555555555";
const URL = `/api/v1/ontology/${ONT}/actions/ackAction/apply`;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ontology/:ontologyId/actions", actionsRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status((err as { statusCode?: number }).statusCode ?? 500)
      .json({ error: { message: err.message } });
  });
  return app;
}

function execResult(linkIndexAck?: unknown) {
  return {
    success: true,
    executionId: "exec-abc",
    result: "success",
    failureType: null,
    errorMessage: null,
    affectedObjects: [
      { objectType: "T", primaryKey: "t-1", operation: "update" },
    ],
    durationMs: 5,
    ...(linkIndexAck ? { linkIndexAck } : {}),
  };
}

describe("POST /apply — linkIndexAck HTTP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkIdempotencyKeyMock.mockResolvedValue(null);
    storeIdempotencyKeyMock.mockResolvedValue(undefined);
    withIdempotencyLockMock.mockImplementation(
      async (_key: string, fn: () => Promise<void>) => fn()
    );
  });

  afterAll(() => {
    // free the in-memory rate-limiter's cleanup interval so the fork exits
    try {
      limiter.destroy();
    } catch {
      /* not initialised in this lane */
    }
  });

  it("flag disabled (no ack) → 200 with the byte-compatible pre-contract body", async () => {
    executeActionMock.mockResolvedValue(execResult());
    const r = await request(buildApp()).post(URL).send({ parameters: {} });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      executionId: "exec-abc",
      result: "success",
      affectedObjects: [
        { objectType: "T", primaryKey: "t-1", operation: "update" },
      ],
      durationMs: 5,
    }); // EXACT shape — no schema drift
  });

  it("confirmed ack → 200 success with the ack verdict surfaced", async () => {
    executeActionMock.mockResolvedValue(
      execResult({ confirmed: true, deferred: 0, waitedMs: 12 })
    );
    const r = await request(buildApp()).post(URL).send({ parameters: {} });
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("success");
    expect(r.body.linkIndexAck).toEqual({ confirmed: true, deferred: 0, waitedMs: 12 });
    expect(r.body.statusUrl).toBeUndefined();
  });

  it("committed but ack NOT confirmed (timeout) → 202 COMMITTED_INDEX_PENDING with executionId + statusUrl — never an error", async () => {
    executeActionMock.mockResolvedValue(
      execResult({ confirmed: false, deferred: 1, waitedMs: 5000, reason: "timeout" })
    );
    const r = await request(buildApp()).post(URL).send({ parameters: {} });
    // Explicit invariant: a post-commit index timeout is not a failure.
    expect(r.status).not.toBeGreaterThanOrEqual(400);
    expect(r.status).toBe(202);
    expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r.body.result).not.toBe("failure");
    expect(r.body.result).not.toBe("failed");
    expect(r.body.executionId).toBe("exec-abc");
    expect(r.body.statusUrl).toBe("/api/v1/audit/log/exec-abc");
    expect(r.body.linkIndexAck).toEqual({
      confirmed: false,
      deferred: 1,
      waitedMs: 5000,
      reason: "timeout",
    });
    expect(r.body.error).toBeUndefined();
  });

  it("Idempotency-Key: the 202 outcome is cached and replayed verbatim (never re-executed, never downgraded)", async () => {
    executeActionMock.mockResolvedValue(
      execResult({ confirmed: false, deferred: 1, waitedMs: 5000, reason: "timeout" })
    );
    const key = "idem-key-1";

    // First call: miss → execute → the STORED body must carry _httpStatus 202.
    const r1 = await request(buildApp())
      .post(URL)
      .set("Idempotency-Key", key)
      .send({ parameters: {} });
    expect(r1.status).toBe(202);
    expect(storeIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    const [, , , storedBody] = storeIdempotencyKeyMock.mock.calls[0];
    expect(storedBody._httpStatus).toBe(202);
    expect(storedBody.result).toBe("COMMITTED_INDEX_PENDING");

    // Second call: cache hit replays the stored 202 without re-executing.
    const { _httpStatus, _isError, ...cachedBody } = storedBody as Record<string, unknown>;
    checkIdempotencyKeyMock.mockResolvedValue({ _httpStatus, _isError, ...cachedBody });
    const r2 = await request(buildApp())
      .post(URL)
      .set("Idempotency-Key", key)
      .send({ parameters: {} });
    expect(r2.status).toBe(202);
    expect(r2.headers["x-idempotency-cached"]).toBe("true");
    expect(r2.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r2.body.statusUrl).toBe("/api/v1/audit/log/exec-abc");
    expect(executeActionMock).toHaveBeenCalledTimes(1); // not re-executed
  });
});
