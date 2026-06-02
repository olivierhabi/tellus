// Quiver B3 — instructions route.
// Mount path: /quiver/api/v1
//
// Phase: TELLUS_QUIVER_PHASE >= 3 (collab phase).
//
// Endpoints:
//   POST /analyses/:rid/instructions  → submit OT batch
//   GET  /analyses/:rid/instructions?fromSeq=N  → log slice (replay/catch-up)

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  invalidAnalysisRequest,
  isQuiverError,
  unauthenticated,
} from "../../services/quiver/errors";
import { readBranch } from "../../services/quiver/branchHeader";
import { isQuiverTestAuthAllowed } from "./testAuth";
import {
  submitInstructions,
  readLogSlice,
  type SubmitInstructionsActor,
  type SubmitInstructionsRequest,
} from "../../services/quiver/ot/otService";

function actorFromReq(req: Request): SubmitInstructionsActor {
  const allowTest = isQuiverTestAuthAllowed();
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

function sendError(res: Response, e: unknown): void {
  if (isQuiverError(e)) {
    res.status(e.status).json(e.envelope);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("quiver/instructions route uncaught:", e);
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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (e) {
      sendError(res, e);
    }
  };

export const instructionsRouter: Router = Router();

// POST /analyses/:rid/instructions
instructionsRouter.post(
  "/analyses/:rid/instructions",
  handle(async (req, res) => {
    const actor = actorFromReq(req);
    const rid = req.params.rid;
    const body = req.body as Partial<SubmitInstructionsRequest>;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.baseVersion !== "number" ||
      !Array.isArray(body.clientOpIds) ||
      !Array.isArray(body.instructions)
    ) {
      throw invalidAnalysisRequest({
        reason:
          "body must be { baseVersion: number, clientOpIds: string[], instructions: Instruction[] }",
      });
    }
    const ack = await submitInstructions(actor, rid, {
      baseVersion: body.baseVersion,
      clientOpIds: body.clientOpIds as string[],
      instructions: body.instructions,
    });
    res.setHeader("ETag", ack.etag);
    res.status(200).json(ack);
  }),
);

// GET /analyses/:rid/instructions?fromSeq=N&toSeq=M
instructionsRouter.get(
  "/analyses/:rid/instructions",
  handle(async (req, res) => {
    actorFromReq(req); // auth-only
    const rid = req.params.rid;
    const fromSeq = Number(req.query.fromSeq ?? 0);
    const toSeq = Number(req.query.toSeq ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(fromSeq) || fromSeq < 0) {
      throw invalidAnalysisRequest({ reason: "fromSeq must be a non-negative integer" });
    }
    const slice = await readLogSlice(rid, fromSeq, toSeq);
    res.status(200).json({ instructions: slice, count: slice.length });
  }),
);
