/**
 * requireRole.ts — function-level authorization for INTERACTIVE sessions.
 * --------------------------------------------------------------------------
 * The global auth gate (`globalAuth`) proves *who* a caller is. It does not,
 * on its own, constrain *what* they may do — historically most mutating
 * routes carried only `authenticate`, so any authenticated principal (even
 * one with an empty `roles` claim) could delete object types, change another
 * member's role, drop groups, or trigger schema migrations. This middleware
 * closes that function-level-authorization gap (OWASP API5).
 *
 * Design decisions (read before changing):
 *
 *   • PAT principals are allowed through. A Personal Access Token is
 *     authorized by SCOPE in `patSecurityGate` *before* any handler runs
 *     (see `services/patScopeMap.ts`). Re-checking realm roles here would
 *     break legitimate machine automation, whose authority model is scopes,
 *     not roles. A PAT that reached this middleware already satisfied its
 *     per-path scope requirement.
 *
 *   • `tellus-superadmin` always passes — it is the "holds every role"
 *     principal, consistent with `requireSuperAdmin` and the
 *     `markingBypass` short-circuit in `securityContext`.
 *
 *   • Roles are read from BOTH surfaces the two auth paths populate:
 *     `req.tellusPrincipal.roles` (set by `requireTellusAuth`/`authenticate`)
 *     and `req.user.roles` (set by `globalAuth` for JWT/cookie sessions).
 *
 *   • Fail-closed: a session carrying none of the allowed roles is rejected
 *     with 403 INSUFFICIENT_ROLE; a request with no resolved identity at all
 *     is rejected 401 (defence in depth — should not occur behind the gate).
 *
 * Convention: gate WRITES (create/update) with `requireOntologyWrite` and
 * destructive / privileged operations (delete-type, migrations, governance,
 * group & membership management) with `requireOntologyAdmin`.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { TELLUS_SUPERADMIN_ROLE } from './requireSuperAdmin';

// Ontology data-plane realm roles (Keycloak).
export const ONTOLOGY_ADMIN_ROLE = 'ontology-admin';
export const ONTOLOGY_EDITOR_ROLE = 'ontology-editor';
export const ONTOLOGY_VIEWER_ROLE = 'ontology-viewer';

function denyEnvelope(
  code: string,
  status: number,
  message: string,
  req: Request,
  allowedRoles: string[],
) {
  return {
    errorCode: code,
    errorName: 'AuthorizationError',
    message,
    statusCode: status,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    details: { requiredRole: allowedRoles },
  };
}

function resolveRoles(req: Request): string[] {
  // `tellusPrincipal` (set by requireTellusAuth) is the canonical post-auth
  // view when present; otherwise fall back to `req.user` (set by globalAuth
  // for JWT/cookie sessions).
  const principal = req.tellusPrincipal as { roles?: string[] } | undefined;
  if (principal && Array.isArray(principal.roles)) return principal.roles;
  const user = (req as unknown as {
    user?: { roles?: string[]; role?: string };
  }).user;
  if (Array.isArray(user?.roles)) return user!.roles;
  if (typeof user?.role === 'string') return [user.role];
  return [];
}

/**
 * Require the interactive caller to hold at least one of `allowedRoles`.
 * PATs pass (scope-gated upstream); superadmins always pass.
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = req.tellusPrincipal;
    const user = (req as unknown as { user?: unknown }).user;

    if (!principal && !user) {
      res
        .status(401)
        .json(denyEnvelope('UNAUTHORIZED', 401, 'Authentication required', req, allowedRoles));
      return;
    }

    // PATs are authorized by scope before any handler runs.
    if (principal?.source === 'pat') {
      next();
      return;
    }

    const roles = resolveRoles(req);
    if (roles.includes(TELLUS_SUPERADMIN_ROLE)) {
      next();
      return;
    }
    if (allowedRoles.some((r) => roles.includes(r))) {
      next();
      return;
    }

    res
      .status(403)
      .json(
        denyEnvelope(
          'INSUFFICIENT_ROLE',
          403,
          `Insufficient permissions. Requires one of: ${allowedRoles.join(', ')}`,
          req,
          allowedRoles,
        ),
      );
  };
}

/** Gate for ontology WRITES (create / update). */
export const requireOntologyWrite = requireRole(
  ONTOLOGY_ADMIN_ROLE,
  ONTOLOGY_EDITOR_ROLE,
);

/** Gate for DESTRUCTIVE / privileged ontology + platform operations. */
export const requireOntologyAdmin = requireRole(ONTOLOGY_ADMIN_ROLE);

/**
 * Router-level, method-based authorization guard. Mount once at the TOP of a
 * data-plane router (`router.use(dataPlaneGuard())`) so every mutation is
 * covered by default — no per-route annotation to forget, and new routes are
 * secure-by-default.
 *
 *   GET / HEAD / OPTIONS  → always pass (reads governed elsewhere).
 *   DELETE                → require admin (destructive).
 *   PUT / PATCH           → require write (unambiguous update).
 *   POST                  → configurable: many POSTs are reads
 *                           (resolve / count / search / validate / preview),
 *                           so on data-query routers pass `post:'open'` and
 *                           gate the true create-POSTs individually; on
 *                           schema/admin routers leave the default ('write')
 *                           or raise to 'admin'.
 *
 * PAT and superadmin handling is inherited from `requireRole`.
 */
export function dataPlaneGuard(
  opts: { post?: 'write' | 'admin' | 'open' } = {},
) {
  const postMode = opts.post ?? 'write';
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next();
      return;
    }
    if (method === 'DELETE') {
      requireOntologyAdmin(req, res, next);
      return;
    }
    if (method === 'POST') {
      if (postMode === 'open') {
        next();
        return;
      }
      if (postMode === 'admin') {
        requireOntologyAdmin(req, res, next);
        return;
      }
      requireOntologyWrite(req, res, next);
      return;
    }
    // PUT / PATCH
    requireOntologyWrite(req, res, next);
  };
}
