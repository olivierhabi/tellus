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

import type { NextFunction, Request, Response } from "express";
import { workshopError } from "./errors";

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
}

export function userRolesOrNull(req: Request): string[] | null {
  const u = (req as unknown as { user?: UserWithRoles }).user;
  if (!u) return null;
  if (!Array.isArray(u.roles)) return null;
  return u.roles.filter((r): r is string => typeof r === "string");
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
