// ---------------------------------------------------------------------------
// Purpose routes — FOUNDRY-GAPS §8 (purpose-based access control)
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/purposes (governance area, next
// to /governance — see server.ts).
//
//   POST   /                          — create a purpose            (admin)
//   GET    /                          — list active purposes        (open read)
//   GET    /:apiName                  — fetch one purpose           (open read)
//   PUT    /:apiName                  — update a purpose            (write)
//   DELETE /:apiName                  — archive a purpose           (admin)
//   POST   /:apiName/grants           — grant to a principal        (admin)
//   GET    /:apiName/grants           — list active grants          (open read)
//   DELETE /:apiName/grants/:grantId  — revoke a grant              (admin)
//
// Authorization follows the governance-router idiom: dataPlaneGuard at the
// top of the router (POST raised to 'admin' — minting a purpose IS an
// access-policy change, same privilege tier as group/membership management).
// PATs scope-gated upstream, superadmin passes, reads open.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { dataPlaneGuard } from "../middleware/requireRole";
import { AppError } from "../utils/foundryAppError";
import {
  createPurpose,
  listPurposes,
  getPurpose,
  updatePurpose,
  archivePurpose,
  grantPurpose,
  listGrants,
  revokeGrant,
} from "../services/governance/purposeService";

const router = Router({ mergeParams: true });

// Purpose + grant management is access-policy administration: every
// mutation (including POST) requires ontology-admin.
router.use(dataPlaneGuard({ post: "admin" }));

function actorOf(req: Request): string {
  const anyReq = req as any;
  return (
    anyReq.auth?.preferred_username ||
    anyReq.auth?.sub ||
    anyReq.user?.email ||
    anyReq.user?.id ||
    "system"
  );
}

function handleAppError(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof AppError) {
    sendError(res, err.code, err.message);
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// Purposes
// ---------------------------------------------------------------------------
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { apiName, displayName, description, allowedCategories, expiresAt } =
      req.body || {};
    if (!apiName || !displayName) {
      return sendError(
        res,
        "VALIDATION_ERROR",
        "apiName and displayName are required."
      );
    }
    const purpose = await createPurpose({
      ontologyId,
      apiName,
      displayName,
      description: description ?? null,
      allowedCategories: allowedCategories ?? [],
      expiresAt: expiresAt ?? null,
      createdBy: actorOf(req),
    });
    sendCreated(res, purpose);
  } catch (err) {
    handleAppError(res, next, err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await listPurposes(req.params.ontologyId));
  } catch (err) {
    next(err);
  }
});

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const purpose = await getPurpose(req.params.ontologyId, req.params.apiName);
    if (!purpose) {
      return sendError(
        res,
        "NOT_FOUND",
        `Purpose '${req.params.apiName}' not found in this ontology.`
      );
    }
    sendSuccess(res, purpose);
  } catch (err) {
    next(err);
  }
});

router.put("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { displayName, description, allowedCategories, expiresAt } = req.body || {};
    const updated = await updatePurpose(req.params.ontologyId, req.params.apiName, {
      displayName,
      description,
      allowedCategories,
      expiresAt,
    });
    if (!updated) {
      return sendError(
        res,
        "NOT_FOUND",
        `Purpose '${req.params.apiName}' not found in this ontology.`
      );
    }
    sendSuccess(res, updated);
  } catch (err) {
    handleAppError(res, next, err);
  }
});

router.delete("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const archived = await archivePurpose(req.params.ontologyId, req.params.apiName);
    if (!archived) {
      return sendError(
        res,
        "NOT_FOUND",
        `Purpose '${req.params.apiName}' not found in this ontology.`
      );
    }
    sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------
router.post(
  "/:apiName/grants",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purpose = await getPurpose(req.params.ontologyId, req.params.apiName);
      if (!purpose) {
        return sendError(
          res,
          "NOT_FOUND",
          `Purpose '${req.params.apiName}' not found in this ontology.`
        );
      }
      const { principalId, principalType } = req.body || {};
      if (!principalId || !principalType) {
        return sendError(
          res,
          "VALIDATION_ERROR",
          "principalId and principalType ('user'|'group') are required."
        );
      }
      const grant = await grantPurpose({
        purposeId: purpose.id,
        principalId,
        principalType,
        grantedBy: actorOf(req),
      });
      sendCreated(res, grant);
    } catch (err) {
      handleAppError(res, next, err);
    }
  }
);

router.get(
  "/:apiName/grants",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purpose = await getPurpose(req.params.ontologyId, req.params.apiName);
      if (!purpose) {
        return sendError(
          res,
          "NOT_FOUND",
          `Purpose '${req.params.apiName}' not found in this ontology.`
        );
      }
      sendSuccess(res, await listGrants(purpose.id));
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:apiName/grants/:grantId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purpose = await getPurpose(req.params.ontologyId, req.params.apiName);
      if (!purpose) {
        return sendError(
          res,
          "NOT_FOUND",
          `Purpose '${req.params.apiName}' not found in this ontology.`
        );
      }
      const revoked = await revokeGrant(purpose.id, req.params.grantId);
      if (!revoked) {
        return sendError(
          res,
          "NOT_FOUND",
          `No active grant '${req.params.grantId}' on purpose '${req.params.apiName}'.`
        );
      }
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
