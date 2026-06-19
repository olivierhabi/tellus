// Quiver B5 — Compute Coordinator route.
// Mount path: /quiver/api/v1/compute
//
// Phase feature flag: TELLUS_QUIVER_PHASE >= 2.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getAnalysis, ActorContext } from "../../services/quiver/analysisService";
import { readBranch } from "../../services/quiver/branchHeader";
import {
  invalidAnalysisRequest,
  isQuiverError,
  unauthenticated,
  analysisNotFound,
} from "../../services/quiver/errors";
import { getComputeContext } from "../../services/quiver/compute/context";
import { DeadlineExceededError } from "../../services/quiver/compute/deadline";
import { CircuitOpenError } from "../../services/quiver/compute/circuitBreaker";
import {
  CyclicDagError,
  UnknownCardError,
} from "../../services/quiver/compute/planner";
import { NoBackendForCardTypeError } from "../../services/quiver/compute/backendRouter";
import {
  ActionApplyForbiddenError,
  OssLimitExceededError,
  OssQueryTimeoutError,
  OssUnavailableError,
} from "../../services/quiver/compute/oss/ossPort";
import {
  computeSeconds,
  computeErrorsTotal,
  computeDeadlineExceededTotal,
  computeInflight,
  computeCircuitState,
} from "../../services/quiver/metrics";
import type { CacheBehavior } from "../../services/quiver/compute/types";

const ROUTE_COMPUTE = "POST /quiver/api/v1/compute/cards";

const ComputeCardRequestBody = z.object({
  analysisRid: z.string().min(1),
  cardId: z.string().min(1),
  parameterOverrides: z.record(z.string(), z.unknown()).default({}),
  branch: z.string().min(1).optional(),
  deadlineMs: z.number().int().positive().optional(),
  cacheBehavior: z
    .enum(["READ_WRITE", "READ_ONLY", "BYPASS", "REFRESH"])
    .default("READ_WRITE"),
});

function actorFromReq(req: Request): ActorContext {
  const allowTest = process.env.QUIVER_ALLOW_TEST_AUTH === "1";
  const fromCtx = (req as Request & {
    securityContext?: { userSubject?: string; orgRid?: string };
  }).securityContext;
  let userSubject = fromCtx?.userSubject;
  let orgRid = fromCtx?.orgRid;
  if (allowTest) {
    userSubject ??= req.header("x-test-user") ?? undefined;
    orgRid ??= req.header("x-test-org") ?? "ri.multipass.main.org.test";
  }
  if (!userSubject) {
    throw unauthenticated({ reason: "missing or invalid Multipass token" });
  }
  return {
    userSubject,
    orgRid: orgRid ?? "ri.multipass.main.org.unknown",
    branch: readBranch(req),
  };
}

function sendError(res: Response, e: unknown, cardType?: string): void {
  if (isQuiverError(e)) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: e.envelope.errorName });
    res.status(e.status).json(e.envelope);
    return;
  }
  if (e instanceof DeadlineExceededError) {
    if (cardType) {
      computeDeadlineExceededTotal.inc({ cardType });
      computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:DeadlineExceeded" });
    }
    res.status(504).json({
      errorCode: "DEADLINE_EXCEEDED",
      errorName: "Tellus:Quiver:DeadlineExceeded",
      errorInstanceId: cryptoRandom(),
      parameters: { reason: e.message },
    });
    return;
  }
  if (e instanceof CircuitOpenError) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:CircuitOpen" });
    res.status(503).json({
      errorCode: "BACKEND_UNAVAILABLE",
      errorName: "Tellus:Quiver:CircuitOpen",
      errorInstanceId: cryptoRandom(),
      parameters: { backend: e.backend },
    });
    return;
  }
  if (e instanceof NoBackendForCardTypeError) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:NoBackendForCardType" });
    res.status(500).json({
      errorCode: "NO_BACKEND_FOR_CARD_TYPE",
      errorName: "Tellus:Quiver:NoBackendForCardType",
      errorInstanceId: cryptoRandom(),
      parameters: { cardType: e.cardType },
    });
    return;
  }
  if (e instanceof CyclicDagError) {
    res.status(500).json({
      errorCode: "CYCLIC_DAG",
      errorName: "Tellus:Quiver:CyclicDag",
      errorInstanceId: cryptoRandom(),
      parameters: { reason: e.message },
    });
    return;
  }
  if (e instanceof UnknownCardError) {
    res.status(404).json({
      errorCode: "UNKNOWN_CARD",
      errorName: "Tellus:Quiver:UnknownCard",
      errorInstanceId: cryptoRandom(),
      parameters: { cardId: e.cardId },
    });
    return;
  }
  if (e instanceof OssLimitExceededError) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:ObjectSetLimitExceeded" });
    res.status(400).json({
      errorCode: "OBJECT_SET_LIMIT_EXCEEDED",
      errorName: "Tellus:Quiver:ObjectSetLimitExceeded",
      errorInstanceId: cryptoRandom(),
      parameters: {
        kind: e.kind,
        limit: e.limit,
        ...(e.observed !== undefined ? { observed: e.observed } : {}),
        ...(e.depth !== undefined ? { depth: e.depth } : {}),
      },
    });
    return;
  }
  if (e instanceof ActionApplyForbiddenError) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:ActionApplyForbidden" });
    res.status(403).json({
      errorCode: "ACTION_APPLY_FORBIDDEN",
      errorName: "Tellus:Quiver:ActionApplyForbidden",
      errorInstanceId: cryptoRandom(),
      parameters: { actionApiName: e.actionApiName, userSubject: e.userSubject },
    });
    return;
  }
  if (e instanceof OssUnavailableError) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:OssUnavailable" });
    res.status(500).json({
      errorCode: "OSS_UNAVAILABLE",
      errorName: "Tellus:Quiver:OssUnavailable",
      errorInstanceId: cryptoRandom(),
      parameters: { reason: e.message },
    });
    return;
  }
  if (e instanceof OssQueryTimeoutError) {
    if (cardType) computeErrorsTotal.inc({ cardType, errorCode: "Tellus:Quiver:OssQueryTimeout" });
    res.status(504).json({
      errorCode: "OSS_QUERY_TIMEOUT",
      errorName: "Tellus:Quiver:OssQueryTimeout",
      errorInstanceId: cryptoRandom(),
      parameters: { reason: e.message },
    });
    return;
  }
  // Defensive (G-02): never leak internal exception messages.
  res.status(500).json({
    errorCode: "INTERNAL",
    errorName: "Tellus:Quiver:Internal",
    errorInstanceId: cryptoRandom(),
    parameters: {},
  });
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require("crypto");
  return randomUUID();
}

export const computeRouter = Router();

computeRouter.post("/compute/cards", async (req: Request, res: Response) => {
  const start = process.hrtime.bigint();
  let cardTypeForMetrics: string | undefined;
  let backendForMetrics = "unknown";
  let cacheLabel: "hit" | "miss" | "bypass" = "miss";
  try {
    // Auth + actor.
    const actor = actorFromReq(req);

    // Parse + validate request.
    const parsed = ComputeCardRequestBody.safeParse(req.body);
    if (!parsed.success) {
      throw invalidAnalysisRequest({
        reason: "invalid ComputeCardRequest body",
        zodIssues: parsed.error.issues,
      });
    }
    const branch = parsed.data.branch ?? actor.branch;
    const reqBody = { ...parsed.data, branch };

    // Resolve analysis document (B5 C-10: branch propagated).
    const fetched = await getAnalysis({ ...actor, branch }, reqBody.analysisRid);
    const doc = fetched.document;
    const card = (doc.cards as Record<string, any>)[reqBody.cardId];
    if (!card) {
      throw analysisNotFound({ rid: `${reqBody.analysisRid}::card::${reqBody.cardId}`, kind: "card" });
    }
    cardTypeForMetrics = String(card.type);

    const ctx = getComputeContext();
    computeInflight.inc({ backend: backendForMetrics });

    const result = await ctx.executor.execute(
      doc as any,
      {
        analysisRid: reqBody.analysisRid,
        cardId: reqBody.cardId,
        parameterOverrides: reqBody.parameterOverrides,
        branch,
        cacheBehavior: reqBody.cacheBehavior as CacheBehavior,
        deadlineMs: reqBody.deadlineMs,
        userSubject: actor.userSubject,
      } as any,
      {
        deadlineHeader: req.header("x-deadline") ?? undefined,
        deadlineMs: reqBody.deadlineMs,
      },
    );
    cacheLabel = result.cacheOutcome;

    // Update circuit-state gauges (G-09 — bounded set).
    for (const e of ctx.router.list()) {
      const v = e.circuit === "closed" ? 0 : e.circuit === "half_open" ? 1 : 2;
      computeCircuitState.set({ backend: e.backendName }, v);
    }

    res.status(200).json(result);
  } catch (e) {
    sendError(res, e, cardTypeForMetrics);
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    computeSeconds.observe(
      { cardType: cardTypeForMetrics ?? "unknown", backend: backendForMetrics, cache: cacheLabel },
      elapsedMs / 1000,
    );
    computeInflight.dec({ backend: backendForMetrics });
  }
});

// Diagnostic endpoint: cache stats.
computeRouter.get("/compute/cache/stats", async (req: Request, res: Response) => {
  try {
    actorFromReq(req); // auth gate only
    const ctx = getComputeContext();
    const ratio = await ctx.cache.hitRatio();
    res.status(200).json({ hitRatio: ratio });
  } catch (e) {
    sendError(res, e);
  }
});
