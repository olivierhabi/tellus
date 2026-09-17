// Quiver B4 — versions + working-states route.
// Mounted under /quiver/api/v1 by routes/quiver/index.ts (phase >= 1).

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  saveVersion,
  listVersions,
  getVersion,
  revertToVersion,
} from "../../services/quiver/versionService";
import {
  createWorkingState,
  upsertWorkingStateDocument,
  getWorkingState,
  purgeExpiredWorkingStates,
} from "../../services/quiver/workingStateService";
import { ActorContext } from "../../services/quiver/analysisService";
import { readBranch } from "../../services/quiver/branchHeader";
import { isQuiverTestAuthBound } from "./testAuth";
import {
  invalidAnalysisRequest,
  isQuiverError,
  unauthenticated,
  versionMismatch,
} from "../../services/quiver/errors";

function actorFromReq(req: Request): ActorContext {
  const allowTest = isQuiverTestAuthBound(req);
  const ctx = (req as Request & {
    securityContext?: { userSubject?: string; orgRid?: string };
  }).securityContext;
  let userSubject = ctx?.userSubject;
  let orgRid = ctx?.orgRid;
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
  // eslint-disable-next-line no-console
  console.error("quiver versions route uncaught:", e);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require("node:crypto");
  res.status(500).json({
    errorCode: "INTERNAL",
    errorName: "Tellus:Quiver:Internal",
    errorInstanceId: randomUUID(),
    parameters: {},
  });
}

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (e) {
      sendError(res, e);
    }
  };

export const versionsRouter: Router = Router();

// ===== POST /analyses/:rid/versions =========================================
versionsRouter.post(
  "/analyses/:rid/versions",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const ifMatch = requireIfMatch(req);
    const info = await saveVersion(actor, req.params.rid, ifMatch, req.body);
    res.status(201).json(info);
  }),
);

// ===== GET /analyses/:rid/versions ==========================================
versionsRouter.get(
  "/analyses/:rid/versions",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const pageToken = (req.query.pageToken as string | undefined) ?? undefined;
    const pageSize = Number(req.query.pageSize ?? "50");
    const namedOnly =
      typeof req.query.namedOnly === "string" &&
      req.query.namedOnly.toLowerCase() === "true";
    if (!Number.isFinite(pageSize) || pageSize < 1) {
      throw invalidAnalysisRequest({ reason: "pageSize must be a positive integer" });
    }
    const page = await listVersions(actor, req.params.rid, pageToken, pageSize, namedOnly);
    res.status(200).json(page);
  }),
);

// ===== GET /analyses/:rid/versions/:version =================================
versionsRouter.get(
  "/analyses/:rid/versions/:version",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const v = Number(req.params.version);
    if (!Number.isInteger(v) || v < 1) {
      throw invalidAnalysisRequest({ reason: "version must be a positive integer" });
    }
    const r = await getVersion(actor, req.params.rid, v);
    res.status(200).json(r);
  }),
);

// ===== POST /analyses/:rid/versions/:version:revert =========================
// Spec uses `:revert` action suffix; Express decodes ':' literally, so the
// path is matched as-is without URL decoding tricks.
versionsRouter.post(
  "/analyses/:rid/versions/:version\\:revert",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const ifMatch = requireIfMatch(req);
    const v = Number(req.params.version);
    if (!Number.isInteger(v) || v < 1) {
      throw invalidAnalysisRequest({ reason: "version must be a positive integer" });
    }
    const r = await revertToVersion(actor, req.params.rid, v, ifMatch);
    res.setHeader("ETag", r.etag);
    res.status(200).json(r);
  }),
);

// ===== POST /analyses/:rid/working-states ===================================
versionsRouter.post(
  "/analyses/:rid/working-states",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const info = await createWorkingState(actor, req.params.rid, req.body);
    res.status(201).json(info);
  }),
);

// ===== PUT /analyses/:rid/working-states/:stateId ===========================
versionsRouter.put(
  "/analyses/:rid/working-states/:stateId",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    if (!req.body || typeof req.body !== "object") {
      throw invalidAnalysisRequest({ reason: "request body required" });
    }
    const info = await upsertWorkingStateDocument(
      actor,
      req.params.rid,
      req.params.stateId,
      req.body,
    );
    res.status(200).json(info);
  }),
);

// ===== GET /analyses/:rid/working-states/:stateId ===========================
versionsRouter.get(
  "/analyses/:rid/working-states/:stateId",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const r = await getWorkingState(actor, req.params.rid, req.params.stateId);
    res.status(200).json(r);
  }),
);

// ===== POST /_admin/purge-working-states ====================================
// Admin/cron endpoint for the TTL sweeper (B4 C-10). Returns purged count.
versionsRouter.post(
  "/_admin/purge-working-states",
  handle(async (_req, res) => {
    const n = await purgeExpiredWorkingStates();
    res.status(200).json({ purged: n });
  }),
);

export default versionsRouter;
