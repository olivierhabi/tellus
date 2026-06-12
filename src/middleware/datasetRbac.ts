// ---------------------------------------------------------------------------
// Dataset RBAC middleware — FOUNDRY-GAPS §6 (per-dataset permissions).
//
// `requireDatasetRole(role)` guards a by-id dataset route on the
// authenticated user's effective role (dataset_acl → project_members
// fallback). It is OPT-IN via DATASET_RBAC_ENABLED=true so it can roll out
// without disturbing existing dataset callers; when disabled it no-ops and
// the existing function-level dataPlaneGuard remains the only check.
//
// Mirrors middleware/pipelineRbac.ts: same principal/group extraction, same
// 401/403 envelopes, skips when :datasetId is absent so the controller's own
// 404 surfaces instead of a 403.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import {
  DatasetAclService,
  datasetRoleSatisfies,
  isDatasetRbacEnabled,
  type DatasetRole,
} from "../services/datasetAcl";

function extractUserId(req: Request): string | null {
  const principal = (req as unknown as {
    tellusPrincipal?: { userId?: string; sub?: string };
  }).tellusPrincipal;
  if (principal?.userId) return principal.userId;
  const legacy = (req as unknown as { user?: { id?: string } }).user;
  if (legacy?.id) return legacy.id;
  return null;
}

function extractGroupIds(req: Request): string[] {
  const principal = (req as unknown as {
    tellusPrincipal?: { groups?: string[]; roles?: string[]; groupIds?: string[] };
  }).tellusPrincipal;
  if (!principal) return [];
  const groups = [
    ...(principal.groupIds ?? []),
    ...(principal.groups ?? []),
    ...(principal.roles ?? []),
  ].filter((g): g is string => typeof g === "string" && g.length > 0);
  return Array.from(new Set(groups));
}

export function requireDatasetRole(required: DatasetRole) {
  const acl = new DatasetAclService();
  return async function middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!isDatasetRbacEnabled()) return next();
    const datasetId = req.params.datasetId;
    if (!datasetId) return next();
    const userId = extractUserId(req);
    if (!userId) {
      res.status(401).json({
        errorCode: "UNAUTHORIZED",
        errorName: "AuthenticationError",
        message: "Authentication required",
        statusCode: 401,
      });
      return;
    }
    try {
      const groupIds = extractGroupIds(req);
      const role = await acl.effectiveRole(datasetId, userId, groupIds);
      if (role && datasetRoleSatisfies(role, required)) {
        (req as unknown as { datasetRole?: DatasetRole }).datasetRole = role;
        return next();
      }
      res.status(403).json({
        errorCode: "INSUFFICIENT_ROLE",
        errorName: "AuthorizationError",
        message: `Dataset access requires role '${required}'${role ? `; you have '${role}'` : ""}.`,
        statusCode: 403,
        details: { required, actual: role ?? null },
      });
      return;
    } catch (err) {
      next(err);
    }
  };
}

export function getResolvedDatasetRole(req: Request): DatasetRole | undefined {
  return (req as unknown as { datasetRole?: DatasetRole }).datasetRole;
}
