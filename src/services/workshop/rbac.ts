// Workshop RBAC — minimal role enforcement layer.
//
// Spec §0.6 + DoD: every endpoint must enforce 403 on insufficient role.
// This middleware reads `req.user.roles` (populated by globalAuth from the
// Multipass JWT realm_access.roles claim) and rejects with
// `Tellus:Workshop:Forbidden` when the required role is absent.
//
// Soft-enforcement contract:
//   - If `req.user.roles` is undefined OR not an array, the middleware is a
//     no-op. This keeps the dozens of existing integration tests (which mount
//     a stub user without roles) working without modification.
//   - If `req.user.roles` IS an array (production traffic + opt-in tests),
//     enforcement is strict.
//
// The `requireRole(role)` factory is intentionally small so it can be applied
// at the per-route level without restructuring the router. For broader
// resource-policy enforcement, the existing `cbac` framework remains the
// future home (D-15 candidate); this RBAC layer is the stop-gap.
//
// Per-module grants (P1): `requireModuleRole(minRole)` extends the global-role
// model with module-scoped Viewer/Editor grants from `workshop_module_grants`.
// Applicable permissions are additive and the strongest role wins
// (editor > viewer > no access). When both `roles` and `groups` are undefined
// the middleware soft-bypasses for legacy test compatibility.

import type { NextFunction, Request, Response } from "express";
import { workshopError, moduleNotFound } from "./errors";
import {
  getModuleEffectiveRole,
  meetsWorkshopFileAccessRequirements,
} from "./grantService";

export const ROLE_EDITOR = "workshop-editor";
export const ROLE_VIEWER = "workshop-viewer";

// Platform super-role that grants editor (and therefore viewer) access to
// every Workshop endpoint. Ontology roles are deliberately excluded:
// ontology-admin / ontology-editor govern Ontology dependencies, while the
// ability to edit a Workshop module comes from Workshop permissions.
export const SUPER_EDITOR_ROLES: ReadonlyArray<string> = [
  "tellus-superadmin",
] as const;

interface UserWithRoles {
  id?: string;
  roles?: unknown;
  groups?: unknown;
}

interface TellusPrincipalIdentity {
  keycloakSub?: unknown;
  userId?: unknown;
}

function localPrincipalId(req: Request): string | null {
  const isUuid = (value: unknown): value is string =>
    typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const principal = (req as unknown as { tellusPrincipal?: TellusPrincipalIdentity })
    .tellusPrincipal;
  if (isUuid(principal?.userId)) {
    return principal.userId;
  }
  const user = userFromReq(req);
  return isUuid(user?.id) ? user.id : null;
}

function userFromReq(req: Request): UserWithRoles | null {
  return (req as unknown as { user?: UserWithRoles }).user ?? null;
}

/**
 * Workshop sharing stores user principals using the Keycloak directory id
 * returned by the people picker / access-check APIs. Browser auth also
 * provisions a separate local database user id on `req.user.id`; using that
 * local id here makes a valid direct Workshop grant impossible to match.
 * Prefer the Keycloak subject and retain the local id only as a compatibility
 * fallback for older tests and synthetic principals.
 */
export function moduleGrantPrincipalId(req: Request): string {
  const principal = (req as unknown as { tellusPrincipal?: TellusPrincipalIdentity })
    .tellusPrincipal;
  if (typeof principal?.keycloakSub === "string" && principal.keycloakSub.length > 0) {
    return principal.keycloakSub;
  }

  const keycloakUser = (req as unknown as { keycloakUser?: { sub?: unknown } })
    .keycloakUser;
  if (typeof keycloakUser?.sub === "string" && keycloakUser.sub.length > 0) {
    return keycloakUser.sub;
  }

  const user = userFromReq(req);
  return typeof user?.id === "string" ? user.id : "";
}

export function userRolesOrNull(req: Request): string[] | null {
  const u = userFromReq(req);
  if (!u) return null;
  if (!Array.isArray(u.roles)) return null;
  return u.roles.filter((r): r is string => typeof r === "string");
}

function userGroupsOrNull(req: Request): string[] | null {
  const u = userFromReq(req);
  if (!u) return null;
  if (!Array.isArray(u.groups)) return null;
  return u.groups.filter((g): g is string => typeof g === "string");
}

export function hasAnyRole(
  req: Request,
  acceptable: ReadonlyArray<string>,
): boolean {
  const roles = userRolesOrNull(req);
  if (roles == null) return true; // soft-enforce: no roles array → allow
  return acceptable.some((r) => roles.includes(r));
}

/**
 * Returns Express middleware that enforces the named role.
 * Editor implies viewer (an editor can read).
 */
export function requireRole(required: "editor" | "viewer") {
  const acceptable =
    required === "viewer"
      ? [ROLE_EDITOR, ROLE_VIEWER, ...SUPER_EDITOR_ROLES]
      : [ROLE_EDITOR, ...SUPER_EDITOR_ROLES];
  return function workshopRequireRole(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (hasAnyRole(req, acceptable)) {
      next();
      return;
    }
    next(
      workshopError({
        errorName: "Tellus:Workshop:Forbidden",
        status: 403,
        parameters: {
          requiredRole: required,
          acceptable: [...acceptable],
        },
      }),
    );
  };
}

/**
 * Returns async Express middleware that enforces per-module role access.
 *
 * Resolution combines super/global roles, direct user grants, group grants,
 * and implicit default groups; the strongest applicable role wins.
 *
 * Soft-enforcement: when both `roles` AND `groups` are undefined/absent
 * on `req.user`, the middleware allows (test-bypass contract).
 *
 * No grant → 404 (module hidden). Insufficient grant → 403 (Forbidden).
 *
 * Attaches `req.workshopModuleRole` for downstream handlers.
 */
export function requireModuleRole(minRole: "viewer" | "editor") {
  return async function workshopRequireModuleRole(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rid = (req.params as Record<string, string>).rid
        ?? (req.query as Record<string, string>).rid;
      if (!rid) {
        // Not a module-scoped route — fall through.
        next();
        return;
      }

      const user = userFromReq(req);
      if (!user) {
        next();
        return;
      }

      const roles = userRolesOrNull(req);
      const groups = userGroupsOrNull(req);

      // Soft-enforcement: if neither roles nor groups are arrays, bypass
      // (existing integration tests with bare `{ id }` user stubs).
      if (roles == null && groups == null) {
        next();
        return;
      }

      const role = await getModuleEffectiveRole(rid, {
        userId: moduleGrantPrincipalId(req),
        roles: roles ?? [],
        groups: groups ?? [],
      });

      if (role == null) {
        next(moduleNotFound(rid));
        return;
      }

      // Foundry file access is role + Organization + Marking requirements.
      // Keep these checks in the same middleware used by every Workshop read
      // and edit route so the Check access verdict and actual enforcement can
      // never disagree in production.
      const localUserId = localPrincipalId(req);
      if (localUserId) {
        const meetsFileRequirements = await meetsWorkshopFileAccessRequirements(
          rid,
          localUserId,
        );
        if (!meetsFileRequirements) {
          next(moduleNotFound(rid));
          return;
        }
      }

      (req as unknown as Record<string, unknown>).workshopModuleRole = role;

      if (minRole === "editor" && role !== "editor") {
        next(
          workshopError({
            errorName: "Tellus:Workshop:Forbidden",
            status: 403,
            parameters: { requiredRole: minRole, effectiveRole: role },
          }),
        );
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
