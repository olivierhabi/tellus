// ---------------------------------------------------------------------------
// Pipeline RBAC middleware — PB-B7.
//
// `requirePipelineRole(role)` guards a route by looking up the
// authenticated user's effective role against `pipeline_acl` (falling
// back to `project_members`). The middleware:
//
//   * Responds 403 INSUFFICIENT_ROLE when the user's role is below
//     `role`.
//   * No-ops when RBAC_ENABLED=false so pre-PB-B7 tenants keep running
//     during the deprecation window.
//   * Skips enforcement when :pipelineId is missing from the path —
//     lets the controller's own 404 surface instead of a 403 on a
//     non-existent route.
//
// Principal resolution: the Keycloak `sub` claim maps to `users.id`
// via the bootstrap's one-row-per-sub pattern (see tellusAuth.ts).
// This middleware reads `req.tellusPrincipal.userId` / `req.user.id`
// to stay compatible with both the realm-auth and the PAT path.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import {
  PipelineAclService,
  isRbacEnabled,
  roleSatisfies,
  type PipelineRole,
} from "../services/pipelines/pipelineAcl";

interface PrincipalHint {
  userId?: string;
  keycloakSub?: string;
}

function extractUserId(req: Request): string | null {
  const principal = (req as unknown as {
    tellusPrincipal?: { userId?: string; sub?: string };
  }).tellusPrincipal;
  if (principal?.userId) return principal.userId;
  const legacy = (req as unknown as { user?: { id?: string } }).user;
  if (legacy?.id) return legacy.id;
  return null;
}

/**
 * PB-B7 follow-groups — pull group identifiers off the authenticated
 * principal. Keycloak typically surfaces them as:
 *   * `tellusPrincipal.groups`  (string[]) — resolved from the ID
 *     token's `groups` claim or a custom mapper.
 *   * `tellusPrincipal.roles`   (string[]) — realm/client role names
 *     that some deployments co-opt as pseudo-groups.
 * We accept either and coalesce into a deduped list of strings.
 */
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

export function requirePipelineRole(required: PipelineRole) {
  const acl = new PipelineAclService();
  return async function middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!isRbacEnabled()) return next();
    const pipelineId = req.params.pipelineId;
    if (!pipelineId) return next();
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
      const role = await acl.effectiveRole(pipelineId, userId, groupIds);
      if (role && roleSatisfies(role, required)) {
        // Attach the resolved role so downstream handlers can log it.
        (req as unknown as { pipelineRole?: PipelineRole }).pipelineRole = role;
        return next();
      }
      res.status(403).json({
        errorCode: "INSUFFICIENT_ROLE",
        errorName: "AuthorizationError",
        message: `Pipeline access requires role '${required}'${role ? `; you have '${role}'` : ""}.`,
        statusCode: 403,
        details: { required, actual: role ?? null },
      });
      return;
    } catch (err) {
      next(err);
    }
  };
}

export function getResolvedPipelineRole(req: Request): PipelineRole | undefined {
  return (req as unknown as { pipelineRole?: PipelineRole }).pipelineRole;
}

export type { PrincipalHint };
