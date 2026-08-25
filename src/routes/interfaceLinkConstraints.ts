// ---------------------------------------------------------------------------
// Interface-Link Constraint Routes — Express Router
//
// CRUD for interface_link_constraint rows (Phase 2). Mounted at
//   /api/v1/ontology/:ontologyId/interfaceLinkConstraints
//
// An interface link constraint declares a polymorphic, interface-typed
// relationship contract published by an Interface. Action types reference
// the constraint by apiName; the runtime resolver in
// `actions/rules/interfaceLinkRules.ts` picks the concrete link_type(s) at
// execution time.
//
// Phase 2 ships the model + CRUD. Phase 6 will tighten authorization
// (per-rule per-object-type per-link-type checks + recipient data
// filtering) and start enforcing the `status` lifecycle transitions
// (draft → active → deprecated) at the route layer.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import {
  sendSuccess,
  sendCreated,
  sendError,
} from "../utils/responseFormatter";
import { requireOntologyWrite, requireOntologyAdmin } from "../middleware/requireRole";
import {
  createInterfaceLinkConstraint,
  getInterfaceLinkConstraintByApiName,
  listInterfaceLinkConstraints,
  updateInterfaceLinkConstraintStatus,
  deleteInterfaceLinkConstraint,
  type InterfaceLinkConstraintCardinality,
  type InterfaceLinkConstraintStatus,
  type InterfaceLinkConstraintRow,
} from "../models/interfaceLinkConstraint";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Mount-level authorization: GET open (every authenticated user can list
// constraints); mutations gated. Per-route guards below apply
// `requireOntologyWrite` (POST/PUT) and `requireOntologyAdmin` (DELETE).

// ---------------------------------------------------------------------------
// POST / — Create
// ---------------------------------------------------------------------------

const API_NAME_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CARDINALITIES = new Set<InterfaceLinkConstraintCardinality>([
  "ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY",
]);
const STATUSES = new Set<InterfaceLinkConstraintStatus>(["draft", "active", "deprecated"]);

function formatRow(row: InterfaceLinkConstraintRow): Record<string, unknown> {
  return {
    rid: row.interface_link_constraint_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    interfaceId: row.interface_id,
    targetInterfaceId: row.target_interface_id,
    targetObjectTypeId: row.target_object_type_id,
    cardinality: row.cardinality,
    sourceRole: row.source_role,
    targetRole: row.target_role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.post(
  "/",
  requireOntologyWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params as { ontologyId: string };
      const body = req.body ?? {};

      if (!body.apiName || typeof body.apiName !== "string" || !API_NAME_RE.test(body.apiName)) {
        sendError(res, "VALIDATION_FAILED", "apiName is required and must be UpperCamelCase (^[A-Z][a-zA-Z0-9]*$).");
        return;
      }
      if (!body.displayName || typeof body.displayName !== "string") {
        sendError(res, "VALIDATION_FAILED", "displayName is required.");
        return;
      }
      if (!body.interfaceApiName || typeof body.interfaceApiName !== "string") {
        sendError(res, "VALIDATION_FAILED", "interfaceApiName is required (the api name of the owning interface).");
        return;
      }
      const targetInterface = body.targetInterfaceApiName;
      const targetObj = body.targetObjectTypeApiName;
      const xorOk = !!targetInterface !== !!targetObj; // exactly one
      if (!xorOk) {
        sendError(res, "VALIDATION_FAILED", "Exactly ONE of targetInterfaceApiName or targetObjectTypeApiName must be set.");
        return;
      }
      if (!CARDINALITIES.has(body.cardinality)) {
        sendError(res, "VALIDATION_FAILED", `cardinality must be one of: ${Array.from(CARDINALITIES).join(", ")}.`);
        return;
      }
      if (body.status !== undefined && !STATUSES.has(body.status)) {
        sendError(res, "VALIDATION_FAILED", `status must be one of: ${Array.from(STATUSES).join(", ")}.`);
        return;
      }

      const row = await createInterfaceLinkConstraint(ontologyId, {
        apiName: body.apiName,
        displayName: body.displayName,
        description: body.description ?? null,
        interfaceApiName: body.interfaceApiName,
        targetInterfaceApiName: targetInterface ?? null,
        targetObjectTypeApiName: targetObj ?? null,
        cardinality: body.cardinality,
        sourceRole: body.sourceRole ?? null,
        targetRole: body.targetRole ?? null,
        status: body.status ?? "draft",
      });
      // Resolved apiName of the owning interface — the FE interface-link
      // adapter uses this for the rule body's `interfaceId` field. The
      // owning interface's apiName goes through `interfaceApiName` on the
      // POST request and back to `interfaceApiName` on the response so the
      // FE never has to look up the interface by UUID.
      const interfaceApiName = body.interfaceApiName;
      sendCreated(res, { ...formatRow(row), interfaceApiName });
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET / — List
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params as { ontologyId: string };
    const rows = await listInterfaceLinkConstraints(ontologyId);
    sendSuccess(res, { items: rows.map(formatRow) });
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:apiName — Read by apiName
// ---------------------------------------------------------------------------

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params as { ontologyId: string; apiName: string };
    const row = await getInterfaceLinkConstraintByApiName(ontologyId, apiName);
    if (!row) {
      sendError(res, "INTERFACE_LINK_CONSTRAINT_NOT_FOUND", `Interface link constraint '${apiName}' not found.`);
      return;
    }
    sendSuccess(res, formatRow(row));
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:apiName/status — Update lifecycle status only
// (Phase 2 reserves structural edits; only the lifecycle status is mutable.)
// ---------------------------------------------------------------------------

router.patch(
  "/:apiName/status",
  requireOntologyWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params as { ontologyId: string; apiName: string };
      const body = req.body ?? {};
      if (!body.status || !STATUSES.has(body.status)) {
        sendError(res, "VALIDATION_FAILED", `status must be one of: ${Array.from(STATUSES).join(", ")}.`);
        return;
      }
      const row = await updateInterfaceLinkConstraintStatus(ontologyId, apiName, body.status);
      if (!row) {
        sendError(res, "INTERFACE_LINK_CONSTRAINT_NOT_FOUND", `Interface link constraint '${apiName}' not found.`);
        return;
      }
      sendSuccess(res, formatRow(row));
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /:apiName — Delete
// ---------------------------------------------------------------------------

router.delete(
  "/:apiName",
  requireOntologyAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params as { ontologyId: string; apiName: string };
      const ok = await deleteInterfaceLinkConstraint(ontologyId, apiName);
      if (!ok) {
        sendError(res, "INTERFACE_LINK_CONSTRAINT_NOT_FOUND", `Interface link constraint '${apiName}' not found.`);
        return;
      }
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      next(err);
    }
  }
);

export default router;
