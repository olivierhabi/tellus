// Quiver B10 — Publishing routes.
// Mount: /quiver/api/v1/{dashboards,visual-functions,templates}
// Phase: TELLUS_QUIVER_PHASE >= 5.

import { Router, type Request, type Response } from "express";
import { readBranch } from "../../services/quiver/branchHeader";
import {
  invalidAnalysisRequest,
  isQuiverError,
  unauthenticated,
  versionMismatch,
} from "../../services/quiver/errors";
import {
  embedDashboard,
  getDashboard,
  publishDashboard,
  updateDashboard,
} from "../../services/quiver/publishing/dashboardService";
import {
  getVisualFunction,
  inlineVisualFunction,
  publishVisualFunction,
  updateVisualFunction,
} from "../../services/quiver/publishing/visualFunctionService";
import {
  TEMPLATE_DEPRECATION_HEADERS,
  createTemplate,
  getTemplate,
} from "../../services/quiver/publishing/templateService";
import {
  lookup as idempotencyLookup,
  record as idempotencyRecord,
  makeContext as makeIdempotencyContext,
} from "../../services/quiver/idempotency";

interface Actor {
  userSubject: string;
  orgRid: string;
  branch: string;
}

function actor(req: Request): Actor {
  const allowTest = process.env.QUIVER_ALLOW_TEST_AUTH === "1";
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
  return { userSubject, orgRid: orgRid!, branch: readBranch(req) };
}

function sendError(res: Response, e: unknown): void {
  if (isQuiverError(e)) {
    res.status(e.status).json(e.envelope);
    return;
  }
  res.status(500).json({
    errorCode: "INTERNAL",
    errorName: "Tellus:Quiver:Internal",
    parameters: { message: (e as Error).message },
  });
}

async function withIdempotency<T>(
  req: Request,
  res: Response,
  route: string,
  user: string,
  fn: () => Promise<{ status: number; body: T; etag?: string }>,
): Promise<void> {
  const key = req.header("idempotency-key");
  if (!key) {
    sendError(
      res,
      invalidAnalysisRequest({
        reason: "Idempotency-Key header is required (G-04)",
      }),
    );
    return;
  }
  let ctx;
  try {
    ctx = makeIdempotencyContext({
      key,
      userId: user,
      route,
      body: req.body,
    });
  } catch (e) {
    sendError(
      res,
      invalidAnalysisRequest({ reason: (e as Error).message }),
    );
    return;
  }
  try {
    const cached = await idempotencyLookup(ctx);
    if (cached) {
      if (cached.etag) res.setHeader("ETag", cached.etag);
      res.status(cached.status).json(cached.body);
      return;
    }
  } catch {
    // Ignore lookup errors — proceed with fresh execution.
  }
  const result = await fn();
  if (result.etag) res.setHeader("ETag", result.etag);
  await idempotencyRecord(ctx, result.status, result.body, result.etag ?? null);
  res.status(result.status).json(result.body);
}

export function publishingRouter(): Router {
  const r = Router();

  // ---------- Dashboards ----------
  r.post("/dashboards", async (req, res) => {
    try {
      const a = actor(req);
      await withIdempotency(req, res, "POST /quiver/api/v1/dashboards", a.userSubject, async () => {
        const dash = await publishDashboard(a, req.body);
        return { status: 201, body: dash, etag: dash.etag };
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get("/dashboards/:rid", async (req, res) => {
    try {
      const a = actor(req);
      const versionPin = req.query.version
        ? Number(req.query.version)
        : undefined;
      const out = await getDashboard(a, req.params.rid, versionPin);
      res.set("ETag", out.etag).json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  r.patch("/dashboards/:rid", async (req, res) => {
    try {
      const a = actor(req);
      const ifMatch = req.header("if-match");
      if (!ifMatch) {
        return sendError(res, versionMismatch({ rid: req.params.rid }));
      }
      const out = await updateDashboard(a, req.params.rid, ifMatch, req.body);
      res.set("ETag", out.etag).json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  // Express does not parse `:` inside path tokens cleanly when using
  // `:rid:embedXxx`. Use distinct sub-paths to avoid path-token confusion.
  r.post("/dashboards/:rid/embedInObjectView", async (req, res) => {
    try {
      const a = actor(req);
      await withIdempotency(
        req,
        res,
        "POST /quiver/api/v1/dashboards/:rid/embedInObjectView",
        a.userSubject,
        async () => {
          const e = await embedDashboard(
            a,
            req.params.rid,
            "OBJECT_VIEW",
            req.body,
          );
          return { status: 201, body: e };
        },
      );
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post("/dashboards/:rid/embedInWorkshop", async (req, res) => {
    try {
      const a = actor(req);
      await withIdempotency(
        req,
        res,
        "POST /quiver/api/v1/dashboards/:rid/embedInWorkshop",
        a.userSubject,
        async () => {
          const e = await embedDashboard(
            a,
            req.params.rid,
            "WORKSHOP",
            req.body,
          );
          return { status: 201, body: e };
        },
      );
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---------- Visual Functions ----------
  r.post("/visual-functions", async (req, res) => {
    try {
      const a = actor(req);
      await withIdempotency(
        req,
        res,
        "POST /quiver/api/v1/visual-functions",
        a.userSubject,
        async () => {
          const vf = await publishVisualFunction(a, req.body);
          return { status: 201, body: vf, etag: vf.etag };
        },
      );
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get("/visual-functions/:rid", async (req, res) => {
    try {
      const a = actor(req);
      const out = await getVisualFunction(a, req.params.rid);
      res.set("ETag", out.etag).json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  r.patch("/visual-functions/:rid", async (req, res) => {
    try {
      const a = actor(req);
      const ifMatch = req.header("if-match");
      if (!ifMatch) {
        return sendError(res, versionMismatch({ rid: req.params.rid }));
      }
      const out = await updateVisualFunction(
        a,
        req.params.rid,
        ifMatch,
        req.body,
      );
      res.set("ETag", out.etag).json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  r.get("/visual-functions/:rid/inline", async (req, res) => {
    try {
      // Internal endpoint for consumer coordinator to fetch sub-DAG.
      actor(req);
      const out = await inlineVisualFunction(req.params.rid);
      res.json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  // ---------- Templates (legacy) ----------
  r.use("/templates", (_req, res, next) => {
    for (const [k, v] of Object.entries(TEMPLATE_DEPRECATION_HEADERS)) {
      res.set(k, v);
    }
    next();
  });
  r.post("/templates", async (req, res) => {
    try {
      const a = actor(req);
      const out = await createTemplate(a, req.body);
      res.status(201).json(out);
    } catch (e) {
      sendError(res, e);
    }
  });
  r.get("/templates/:rid", async (req, res) => {
    try {
      actor(req);
      const out = await getTemplate(req.params.rid);
      res.json(out);
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}
