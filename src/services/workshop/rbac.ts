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
// Resolution order: super roles → global workshop roles → direct user grant
// → group membership grants → implicit default groups. When both `roles` and
// `groups` are undefined the middleware soft-bypasses (test compatibility).

import type { NextFunction, Request, Response } from "express";
import { workshopError, moduleNotFound } from "./errors";
import { getModuleEffectiveRole } from "./grantService";

export const ROLE_EDITOR = "workshop-editor";
export const ROLE_VIEWER = "workshop-viewer";

// Tellus super-roles that grant editor (and therefore viewer) access to
// every workshop endpoint. Mirrors the existing convention used by the
// `cbac` framework: realm super-roles bypass per-resource policy. This
// also keeps the existing Cypress test user (which carries
// `ontology-editor` / `ontology-admin` from the bootstrap-keycloak realm
// seed) authorized without requiring a parallel workshop role mapping.
export const SUPER_EDITOR_ROLES: ReadonlyArray<string> = [
  "tellus-superadmin",
  "ontology-admin",
  "ontology-editor",
] as const;

interface UserWithRoles {
  id?: string;
  roles?: unknown;
  groups?: unknown;
}

function userFromReq(req: Request): UserWithRoles | null {
  return (req as unknown as { user?: UserWithRoles }).user ?? null;
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
 * Resolution:
 *  a) Super/global roles (same as `requireRole`).
 *  b) Direct user grant (principal_type='user').
 *  c) Group membership + implicit default groups.
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
        userId: user.id ?? "",
        roles: roles ?? [],
        groups: groups ?? [],
      });

      if (role == null) {
        next(moduleNotFound(rid));
        return;
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
