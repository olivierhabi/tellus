// ---------------------------------------------------------------------------
// Action Type Routes — Read
//
// GET / (list), GET /by-rid/:rid, POST /by-rid/batch, GET /:actionApiName.
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { getActionType, getActionTypeByRid, getActionTypesByRidBatch, listActionTypes } from "../../models/actionType";
import { sendError, sendSuccess } from "../../utils/responseFormatter";
import { OntologyError } from "../../utils/queryErrors";
import {
  KNOWN_CODES,
  formatActionType,
} from "./shared";

export function registerListRoutes(router: Router): void {
// ---------------------------------------------------------------------------
// Endpoint 2: GET / (List Action Types)
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId } = req.params;

      const rows = await listActionTypes(ontologyId);
      const data = rows.map((row) => formatActionType(row));

      sendSuccess(res, { data });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 3: GET /by-rid/:rid (Get Action Type by RID)
// ---------------------------------------------------------------------------

router.get(
  "/by-rid/:rid",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { rid } = req.params;

      if (!rid || typeof rid !== "string") {
        sendError(res, "INVALID_PARAMETER", "rid is required and must be a string");
        return;
      }

      const row = await getActionTypeByRid(rid);
      if (!row) {
        throw new OntologyError(
          `Action type with RID '${rid}' not found`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { rid }
        );
      }

      sendSuccess(res, formatActionType(row));
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 4: POST /by-rid/batch (Get Action Types by RIDs Batch)
// ---------------------------------------------------------------------------

router.post(
  "/by-rid/batch",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body;
      const rids: string[] = body.rids ?? body;

      if (!Array.isArray(rids)) {
        sendError(res, "INVALID_PARAMETER", "rids must be an array of RID strings");
        return;
      }

      if (rids.length === 0) {
        sendSuccess(res, { data: [] });
        return;
      }

      if (rids.length > 500) {
        sendError(res, "INVALID_PARAMETER", "Maximum 500 RIDs allowed per batch request");
        return;
      }

      const rows = await getActionTypesByRidBatch(rids);
      const data = rows.map((row) => formatActionType(row));

      sendSuccess(res, { data });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 5: GET /:actionApiName (Get Single Action Type)
// ---------------------------------------------------------------------------

router.get(
  "/:actionApiName",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;

      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      // Phase 6.2 — ETag header so a client can stamp `If-Match: <Etag>`
      // on its next PATCH for optimistic-concurrency enforcement. The
      // ETag is the persisted `definition_version` (migration 132
      // backfills to 1 + bumps on every structural change via the
      // BEFORE-UPDATE trigger wrapped as a strong ETag.
      const version = Number(row.definition_version ?? 1);
      if (Number.isInteger(version)) {
        res.set("ETag", `"${version}"`);
      }
      sendSuccess(res, formatActionType(row));
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);
}
