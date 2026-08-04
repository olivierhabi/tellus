// ---------------------------------------------------------------------------
// POST /applyBatch + POST /applyBulk → linkIndexAck HTTP aggregation (unit;
// supertest + mocked executor). Covers ALL THREE batch surfaces:
//
//   * router:      /api/v1/ontology/:ontologyId/actions/:apiName/applyBatch
//   * batchRouter: /api/v1/actions/:apiName/applyBatch  (default ontology)
//   * bulk router: /api/v1/actions/:apiName/applyBulk
//
// Aggregation contract (actions/linkIndexAckHttp.ts — single rule):
//   * flag disabled (no acks staged)        → 200 byte-compatible legacy
//     body: NO top-level `result`, NO per-item linkIndexAck/statusUrl.
//   * all committed items ack-confirmed     → 200, per-item linkIndexAck
//     surfaced, still no top-level `result`.
//   * ANY committed item ack-unconfirmed    → 202 with top-level
//     result COMMITTED_INDEX_PENDING; each pending item carries its own
//     executionId + pollable statusUrl. NEVER a 4xx/5xx and NEVER a
//     per-item failure — the mutations are durable in PG.
//   * genuine pre-commit failures are unaffected: an all-failed bulk keeps
//     its 422; a mixed bulk keeps the failed item's error alongside the
//     202 for the committed-but-pending item.
//   * the 202 outcome is what gets cached for Idempotency-Key replays.
// ---------------------------------------------------------------------------

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";

const {
  executeActionMock,
  checkIdempotencyKeyMock,
  storeIdempotencyKeyMock,
  withIdempotencyLockMock,
  getDefaultOntologyIdMock,
} = vi.hoisted(() => ({
  executeActionMock: vi.fn(),
  checkIdempotencyKeyMock: vi.fn(),
  storeIdempotencyKeyMock: vi.fn(),
  withIdempotencyLockMock: vi.fn(),
  getDefaultOntologyIdMock: vi.fn(),
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
    async (_key: string, fn: () => Promise<void>) => fn(),
  ),
}));

// batchRouter + bulkActions resolve the default ontology from the DB —
// stub ONLY that function, keep the rest of the real module intact.
vi.mock("../../../src/actions/actionValidator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/actions/actionValidator")>();
  return { ...actual, getDefaultOntologyId: getDefaultOntologyIdMock };
});

// bulkActions imports these at module scope for the autoIndex path — keep
// them out of reach so no PG pool / orchestrator side effects load.
vi.mock("../../../src/db", () => ({ query: vi.fn() }));
vi.mock("../../../src/services/indexing/indexingOrchestrator", () => ({
  indexObjectType: vi.fn(),
}));

import actionsRouter, { batchRouter } from "../../../src/routes/actions";
import bulkActionsRouter from "../../../src/routes/bulkActions";
import { limiter } from "../../../src/middleware/rateLimiter";
import { OntologyError } from "../../../src/utils/queryErrors";

const ONT = "11111111-2222-3333-4444-555555555555";
const APPLY_BATCH = `/api/v1/ontology/${ONT}/actions/ackAction/applyBatch`;
const APPLY_BATCH_DEFAULT = `/api/v1/actions/ackAction/applyBatch`;
const APPLY_BULK = `/api/v1/actions/ackAction/applyBulk`;

const CONFIRMED_ACK = { confirmed: true, deferred: 0, waitedMs: 12 };
const TIMEOUT_ACK = {
  confirmed: false,
  deferred: 1,
  waitedMs: 5000,
  reason: "timeout",
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ontology/:ontologyId/actions", actionsRouter);
  app.use("/api/v1/actions", batchRouter);
  app.use("/api/v1/actions", bulkActionsRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status((err as { statusCode?: number }).statusCode ?? 500)
      .json({ error: { message: err.message } });
  });
  return app;
}

const AFFECTED = [{ objectType: "T", primaryKey: "t-1", operation: "update" }];

function execResult(executionId: string, linkIndexAck?: unknown) {
  return {
    success: true,
    executionId,
    result: "success",
    failureType: null,
    errorMessage: null,
    affectedObjects: AFFECTED,
    durationMs: 1,
    ...(linkIndexAck ? { linkIndexAck } : {}),
  };
}

describe("POST /applyBatch (ontology-scoped) — linkIndexAck aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkIdempotencyKeyMock.mockResolvedValue(null);
    storeIdempotencyKeyMock.mockResolvedValue(undefined);
    getDefaultOntologyIdMock.mockResolvedValue(ONT);
    withIdempotencyLockMock.mockImplementation(
      async (_key: string, fn: () => Promise<void>) => fn(),
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

  it("flag disabled → 200 with the byte-compatible legacy batch body (no result/linkIndexAck/statusUrl)", async () => {
    executeActionMock
      .mockResolvedValueOnce(execResult("e0"))
      .mockResolvedValueOnce(execResult("e1"));

    const r = await request(buildApp())
      .post(APPLY_BATCH)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).toBe(200);
    expect("result" in r.body).toBe(false);
    expect(r.body).toEqual({
      batchId: expect.any(String),
      totalRequests: 2,
      successCount: 2,
      failedCount: 0,
      results: [
        {
          index: 0,
          success: true,
          executionId: "e0",
          affectedObjects: AFFECTED,
        },
        {
          index: 1,
          success: true,
          executionId: "e1",
          affectedObjects: AFFECTED,
        },
      ],
      totalDurationMs: expect.any(Number),
    }); // EXACT shape — no schema drift
  });

  it("all items ack-confirmed → 200 with per-item linkIndexAck and no top-level result", async () => {
    executeActionMock
      .mockResolvedValueOnce(execResult("e0", CONFIRMED_ACK))
      .mockResolvedValueOnce(execResult("e1", CONFIRMED_ACK));

    const r = await request(buildApp())
      .post(APPLY_BATCH)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).toBe(200);
    expect("result" in r.body).toBe(false);
    expect(r.body.results[0].linkIndexAck).toEqual(CONFIRMED_ACK);
    expect(r.body.results[1].linkIndexAck).toEqual(CONFIRMED_ACK);
    expect(r.body.results[0].statusUrl).toBeUndefined();
    expect(r.body.results[1].statusUrl).toBeUndefined();
  });

  it("one-of-N ack timeout → 202 COMMITTED_INDEX_PENDING; only the pending item carries a statusUrl — never an error", async () => {
    executeActionMock
      .mockResolvedValueOnce(execResult("e0", CONFIRMED_ACK))
      .mockResolvedValueOnce(execResult("e1", TIMEOUT_ACK));

    const r = await request(buildApp())
      .post(APPLY_BATCH)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    // Explicit invariant: a post-commit index deferral is not a failure.
    expect(r.status).not.toBeGreaterThanOrEqual(400);
    expect(r.status).toBe(202);
    expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r.body.result).not.toBe("failure");
    expect(r.body.failedCount).toBe(0); // BOTH items committed successfully
    expect(r.body.successCount).toBe(2);

    // The confirmed item keeps its verdict but gets NO statusUrl.
    expect(r.body.results[0].success).toBe(true);
    expect(r.body.results[0].linkIndexAck).toEqual(CONFIRMED_ACK);
    expect(r.body.results[0].statusUrl).toBeUndefined();

    // The pending item carries its own executionId + poll target.
    expect(r.body.results[1].success).toBe(true);
    expect(r.body.results[1].linkIndexAck).toEqual(TIMEOUT_ACK);
    expect(r.body.results[1].executionId).toBe("e1");
    expect(r.body.results[1].statusUrl).toBe("/api/v1/audit/log/e1");
    expect(r.body.results[1].failureType).toBeUndefined();
  });

  it("mixed: a pre-commit failure + a committed-but-pending item → 202; the genuine failure keeps its per-item entry", async () => {
    executeActionMock
      .mockRejectedValueOnce(
        new OntologyError("bad param", "INVALID_PARAMETER", 400),
      )
      .mockResolvedValueOnce(execResult("e1", TIMEOUT_ACK));

    const r = await request(buildApp())
      .post(APPLY_BATCH)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).toBe(202);
    expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r.body.successCount).toBe(1);
    expect(r.body.failedCount).toBe(1);

    // Pre-commit failure unchanged by the ack contract.
    expect(r.body.results[0]).toMatchObject({
      index: 0,
      success: false,
      executionId: null,
      failureType: "invalid_parameter",
    });
    expect(r.body.results[0].statusUrl).toBeUndefined();

    expect(r.body.results[1].statusUrl).toBe("/api/v1/audit/log/e1");
  });

  it("Idempotency-Key: the 202 outcome is cached and replayed verbatim (never re-executed, never downgraded)", async () => {
    executeActionMock
      .mockResolvedValueOnce(execResult("e0", CONFIRMED_ACK))
      .mockResolvedValueOnce(execResult("e1", TIMEOUT_ACK));
    const key = "idem-batch-1";

    const r1 = await request(buildApp())
      .post(APPLY_BATCH)
      .set("Idempotency-Key", key)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });
    expect(r1.status).toBe(202);
    expect(storeIdempotencyKeyMock).toHaveBeenCalledTimes(1);
    const [, , , storedBody] = storeIdempotencyKeyMock.mock.calls[0];
    expect(storedBody._httpStatus).toBe(202);
    expect(storedBody.result).toBe("COMMITTED_INDEX_PENDING");

    // Second call: cache hit replays the stored 202 without re-executing.
    const { _httpStatus, _isError, ...cachedBody } = storedBody as Record<
      string,
      unknown
    >;
    checkIdempotencyKeyMock.mockResolvedValue({
      _httpStatus,
      _isError,
      ...cachedBody,
    });
    const r2 = await request(buildApp())
      .post(APPLY_BATCH)
      .set("Idempotency-Key", key)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });
    expect(r2.status).toBe(202);
    expect(r2.headers["x-idempotency-cached"]).toBe("true");
    expect(r2.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r2.body.results[1].statusUrl).toBe("/api/v1/audit/log/e1");
    expect(executeActionMock).toHaveBeenCalledTimes(2); // not re-executed
  });
});

describe("POST /applyBatch (default-ontology mount) — same contract on the second surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkIdempotencyKeyMock.mockResolvedValue(null);
    storeIdempotencyKeyMock.mockResolvedValue(undefined);
    getDefaultOntologyIdMock.mockResolvedValue(ONT);
    withIdempotencyLockMock.mockImplementation(
      async (_key: string, fn: () => Promise<void>) => fn(),
    );
  });

  afterAll(() => {
    try {
      limiter.destroy();
    } catch {
      /* already destroyed */
    }
  });

  it("one ack timeout → 202 + per-item statusUrl; ontology resolved from the default", async () => {
    executeActionMock.mockResolvedValueOnce(execResult("e0", TIMEOUT_ACK));

    const r = await request(buildApp())
      .post(APPLY_BATCH_DEFAULT)
      .send({ requests: [{ parameters: {} }] });

    expect(r.status).toBe(202);
    expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r.body.results[0].statusUrl).toBe("/api/v1/audit/log/e0");
    expect(getDefaultOntologyIdMock).toHaveBeenCalled();
    expect(executeActionMock).toHaveBeenCalledWith(
      ONT,
      "ackAction",
      expect.any(Object),
      expect.any(Object),
    );
  });
});

describe("POST /applyBulk — linkIndexAck aggregation over the bulk shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkIdempotencyKeyMock.mockResolvedValue(null);
    storeIdempotencyKeyMock.mockResolvedValue(undefined);
    getDefaultOntologyIdMock.mockResolvedValue(ONT);
    withIdempotencyLockMock.mockImplementation(
      async (_key: string, fn: () => Promise<void>) => fn(),
    );
  });

  it("flag disabled → 200 with the legacy bulk body; no top-level result, no per-item ack keys", async () => {
    executeActionMock
      .mockResolvedValueOnce(execResult("e0"))
      .mockResolvedValueOnce(execResult("e1"));

    const r = await request(buildApp())
      .post(APPLY_BULK)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).toBe(200);
    expect("result" in r.body).toBe(false);
    expect(r.body.results[0]).toEqual({
      index: 0,
      status: "success",
      primaryKey: "t-1",
      operation: "update",
      executionId: "e0",
      affectedObjects: AFFECTED,
    }); // EXACT item shape — no schema drift
  });

  it("one-of-N ack timeout → 202 + marker; per-item status stays 'success' (never coerced to 'failed')", async () => {
    executeActionMock
      .mockResolvedValueOnce(execResult("e0", CONFIRMED_ACK))
      .mockResolvedValueOnce(execResult("e1", TIMEOUT_ACK));

    const r = await request(buildApp())
      .post(APPLY_BULK)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).not.toBeGreaterThanOrEqual(400);
    expect(r.status).toBe(202);
    expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r.body.results[1].status).toBe("success");
    expect(r.body.results[1].statusUrl).toBe("/api/v1/audit/log/e1");
    expect(r.body.results[1].linkIndexAck).toEqual(TIMEOUT_ACK);
    expect(r.body.results[0].statusUrl).toBeUndefined();
    expect(r.body.successCount).toBe(2);
    expect(r.body.failedCount).toBe(0);
  });

  it("all items fail pre-commit → 422 with NO COMMITTED_INDEX_PENDING marker (nothing committed)", async () => {
    executeActionMock
      .mockRejectedValueOnce(
        new OntologyError("bad param", "INVALID_PARAMETER", 400),
      )
      .mockRejectedValueOnce(
        new OntologyError("bad param", "INVALID_PARAMETER", 400),
      );

    const r = await request(buildApp())
      .post(APPLY_BULK)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).toBe(422);
    expect("result" in r.body).toBe(false); // no fabricated deferrals
    expect(r.body.successCount).toBe(0);
    expect(r.body.failedCount).toBe(2);
    expect(r.body.results[0].status).toBe("failed");
    expect(r.body.results[0].error.code).toBe("INVALID_PARAMETER");
  });

  it("mixed pre-commit failure + committed-but-pending → 202; the failed item's error entry is preserved", async () => {
    executeActionMock
      .mockRejectedValueOnce(
        new OntologyError("bad param", "INVALID_PARAMETER", 400),
      )
      .mockResolvedValueOnce(execResult("e1", TIMEOUT_ACK));

    const r = await request(buildApp())
      .post(APPLY_BULK)
      .send({ requests: [{ parameters: {} }, { parameters: {} }] });

    expect(r.status).toBe(202);
    expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r.body.successCount).toBe(1);
    expect(r.body.failedCount).toBe(1);

    expect(r.body.results[0]).toMatchObject({
      index: 0,
      status: "failed",
      error: { code: "INVALID_PARAMETER" },
    });
    expect(r.body.results[0].statusUrl).toBeUndefined();

    expect(r.body.results[1].status).toBe("success");
    expect(r.body.results[1].statusUrl).toBe("/api/v1/audit/log/e1");
  });
});
