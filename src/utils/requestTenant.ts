// ---------------------------------------------------------------------------
// resolveRequestTenant — non-throwing tenant resolution for route handlers
// that live OUTSIDE the connectivity service but need to reach
// tenant-scoped connectivity resources (e.g. an action type's writeback
// binding referencing a data-connection webhook).
//
// Mirrors the fallback chain in
// `services/connectivity/handlers/connections.handler.ts#extractUser`
// (`tenant ?? tenantId ?? tenant_id ?? claims.tenant ?? claims.tenant_id`,
// defaulting to "default") so both surfaces resolve the SAME tenant for
// the SAME authenticated request. Unlike `extractUser` this never throws
// and never requires a user id — the action execution path legitimately
// runs with `executedBy: "system"` in tests and internal callers.
// ---------------------------------------------------------------------------

import type { Request } from "express";

export const DEFAULT_TENANT = "default";

export function resolveRequestTenant(req: Request): string {
  const r = req as unknown as Record<string, unknown>;
  const candidates = [
    r.user,
    (r.session as Record<string, unknown> | undefined)?.user,
    r.tellusUser,
    r.multipassUser,
  ] as Array<Record<string, unknown> | undefined>;
  for (const u of candidates) {
    if (!u) continue;
    const claims = u.claims as Record<string, unknown> | undefined;
    const tenant =
      (u.tenant ?? u.tenantId ?? u.tenant_id ?? claims?.tenant ?? claims?.tenant_id) as
        | string
        | undefined;
    if (tenant) return tenant;
  }
  return DEFAULT_TENANT;
}
