// ---------------------------------------------------------------------------
// Action Type Routes — Delete
//
// DELETE /:actionApiName — delete an action type.
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { deleteActionType } from "../../models/actionType";
import { sendError, sendNoContent } from "../../utils/responseFormatter";
import { OntologyError } from "../../utils/queryErrors";
import {
  KNOWN_CODES,
} from "./shared";

export function registerDeleteRoutes(router: Router): void {
// ---------------------------------------------------------------------------
// Endpoint 7: DELETE /:actionApiName (Delete Action Type)
// ---------------------------------------------------------------------------

router.delete(
  "/:actionApiName",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;

      const deleted = await deleteActionType(ontologyId, actionApiName);
      if (!deleted) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      sendNoContent(res);
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
