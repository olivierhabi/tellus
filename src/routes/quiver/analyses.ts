// Quiver B1 — analyses route.
// Mount path: /quiver/api/v1
//
// Phase feature flag: TELLUS_QUIVER_PHASE >= 1 enables this router.
// Auth: every request requires a Multipass JWT (Keycloak-backed).
//   The existing securityContext middleware (used elsewhere in the repo)
//   sets req.userSubject; we trust it here. Tests can short-circuit by
//   passing `x-test-user` when QUIVER_ALLOW_TEST_AUTH=1.

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  ActorContext,
  createAnalysis,
  deleteAnalysis,
  getAnalysis,
  listAnalysesInFolder,
  updateAnalysisMetadata,
} from "../../services/quiver/analysisService";
import { validate as validateDag } from "../../services/quiver/dag";
import { readBranch } from "../../services/quiver/branchHeader";
import {
  invalidAnalysisRequest,
  isQuiverError,
  unauthenticated,
  versionMismatch,
} from "../../services/quiver/errors";
import { makeContext, lookup, record } from "../../services/quiver/idempotency";
import { withTransaction } from "../../db";
import {
  analysisCreateSeconds,
  analysisDeleteSeconds,
  analysisGetSeconds,
  analysisListSeconds,
  analysisUpdateSeconds,
  idempotencyConflictTotal,
  idempotencyReplayTotal,
} from "../../services/quiver/metrics";

const ROUTE_CREATE = "POST /quiver/api/v1/analyses";
const ROUTE_GET = "GET /quiver/api/v1/analyses/:rid";
const ROUTE_PATCH = "PATCH /quiver/api/v1/analyses/:rid";
const ROUTE_DELETE = "DELETE /quiver/api/v1/analyses/:rid";
const ROUTE_LIST = "GET /quiver/api/v1/folders/:folderRid/analyses";

function actorFromReq(req: Request): ActorContext {
  // The securityContext middleware sets these in production.
  // In tests with QUIVER_ALLOW_TEST_AUTH=1, accept x-test-user header.
  const allowTest = process.env.QUIVER_ALLOW_TEST_AUTH === "1";
  const fromCtx = (req as Request & {
    securityContext?: {
      userSubject?: string;
      orgRid?: string;
    };
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

function requireHeader(req: Request, name: string): string {
  const v = req.header(name);
  if (typeof v !== "string" || v.length === 0) {
    throw invalidAnalysisRequest({
      reason: `missing required header: ${name}`,
    });
  }
  return v;
}

/**
 * G-03: missing `If-Match` is a VersionMismatch (412), not a generic 400.
 * Spec: "missing or stale → 412 Tellus:Quiver:VersionMismatch".
 */
function requireIfMatch(req: Request): string {
  const v = req.header("if-match");
  if (typeof v !== "string" || v.length === 0) {
    throw versionMismatch({
      currentEtag: null,
      reason: "If-Match header is required",
    });
  }
  return v;
}

function sendError(res: Response, e: unknown): void {
  if (isQuiverError(e)) {
    res.status(e.status).json(e.envelope);
    return;
  }
  // Defensive: never leak internal exception messages (G-02).
  // eslint-disable-next-line no-console
  console.error("quiver route uncaught:", e);
  res.status(500).json({
    errorCode: "INTERNAL",
    errorName: "Tellus:Quiver:Internal",
    errorInstanceId: cryptoRandom(),
    parameters: {},
  });
}

function cryptoRandom(): string {
  // Lazy import to avoid pulling crypto at module init.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require("node:crypto");
  return randomUUID();
}

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (e) {
      sendError(res, e);
    }
  };

export const analysesRouter: Router = Router();

// === POST /analyses ========================================================
analysesRouter.post(
  "/analyses",
  handle(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const actor = actorFromReq(req);
    const idempotencyKey = req.header("idempotency-key");
    if (!idempotencyKey) {
      throw invalidAnalysisRequest({
        reason: "Idempotency-Key header is required for POST /analyses (G-04)",
      });
    }
    const ctx = makeContext({
      key: idempotencyKey,
      userId: actor.userSubject,
      route: ROUTE_CREATE,
      body: req.body,
    });
    // Wrap idempotency lookup → create → record in a transaction to prevent
    // TOCTOU race conditions where concurrent requests with the same key
    // could both pass the lookup and create separate analyses.
    const result = await withTransaction(async (client) => {
      try {
        const cached = await lookup(ctx, client);
        if (cached) {
          idempotencyReplayTotal.labels({ endpoint: ROUTE_CREATE }).inc();
          return { cached, document: null as any, etag: null as any, status: 0 };
        }
      } catch (e) {
        if (isQuiverError(e) && e.envelope.errorName.endsWith("IdempotencyKeyReplay")) {
          idempotencyConflictTotal.labels({ endpoint: ROUTE_CREATE }).inc();
        }
        throw e;
      }
      const { document, etag } = await createAnalysis(actor, req.body, client);
      const status = 201;
      await record(ctx, status, document, etag, client);
      return { cached: null, document, etag, status };
    });

    if (result.cached) {
      if (result.cached.etag) res.setHeader("ETag", result.cached.etag);
      res.status(result.cached.status).json(result.cached.body);
      return;
    }

    res.setHeader("ETag", result.etag);
    res.setHeader(
      "Location",
      `/quiver/api/v1/analyses/${encodeURIComponent(result.document.rid)}`,
    );
    res.status(result.status).json(result.document);
    analysisCreateSeconds
      .labels({ result: "success" })
      .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  }),
);

// === GET /analyses/:rid =====================================================
analysesRouter.get(
  "/analyses/:rid",
  handle(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const actor = actorFromReq(req);
    const { document, etag } = await getAnalysis(actor, req.params.rid);
    res.setHeader("ETag", etag);
    res.status(200).json(document);
    analysisGetSeconds
      .labels({ cache: "miss" })
      .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  }),
);

// === PATCH /analyses/:rid ===================================================
analysesRouter.patch(
  "/analyses/:rid",
  handle(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const actor = actorFromReq(req);
    const ifMatch = requireIfMatch(req);
    const { document, etag } = await updateAnalysisMetadata(
      actor,
      req.params.rid,
      ifMatch,
      req.body,
    );
    res.setHeader("ETag", etag);
    res.status(200).json(document);
    analysisUpdateSeconds
      .labels({ result: "success" })
      .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  }),
);

// === DELETE /analyses/:rid ==================================================
analysesRouter.delete(
  "/analyses/:rid",
  handle(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const actor = actorFromReq(req);
    const ifMatch = requireIfMatch(req);
    await deleteAnalysis(actor, req.params.rid, ifMatch);
    res.status(204).end();
    analysisDeleteSeconds
      .labels({ result: "success" })
      .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  }),
);

// === GET /folders/:folderRid/analyses =======================================
analysesRouter.get(
  "/folders/:folderRid/analyses",
  handle(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const actor = actorFromReq(req);
    const pageToken = (req.query.pageToken as string | undefined) ?? undefined;
    const pageSize = Number(
      (req.query.pageSize as string | undefined) ?? "50",
    );
    if (!Number.isFinite(pageSize) || pageSize < 1) {
      throw invalidAnalysisRequest({
        reason: "pageSize must be a positive integer",
      });
    }
    const page = await listAnalysesInFolder(
      actor,
      req.params.folderRid,
      pageToken,
      pageSize,
    );
    res.status(200).json(page);
    analysisListSeconds
      .labels({ result: "success" })
      .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  }),
);

// === POST /analyses/:rid/_validate (B2 C-13) ===============================
// Public validator endpoint. Loads the current persisted document and runs
// the same validate() function that B3 will run in-process on every
// instruction-apply. Rejection envelope is byte-identical between the two
// surfaces (B2 C-13).
analysesRouter.post(
  "/analyses/:rid/_validate",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const { document } = await getAnalysis(actor, req.params.rid);
    const result = validateDag(document);
    if (result.valid) {
      res.status(200).json({
        valid: true,
        topologicalOrder: result.topologicalOrder,
        warnings: result.warnings,
      });
      if (result.warnings.length > 0) {
        res.setHeader("X-Tellus-Quiver-Warn", result.warnings.join("; "));
      }
      return;
    }
    res.status(400).json({
      errorCode: result.errorCode,
      errorName: result.errorName,
      errorInstanceId: cryptoRandom(),
      parameters: result.parameters,
    });
  }),
);

export default analysesRouter;
// re-export versionMismatch for convenience in tests
export { versionMismatch };
