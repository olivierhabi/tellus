// ---------------------------------------------------------------------------
// securityContext.ts — extract user markings / orgs / CBAC from request
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 28:
//   "Filter injection is mandatory. API middleware injects a security
//    filter into EVERY Elasticsearch query — no opt-out. Filter is
//    constructed from the user's token claims (markings, orgs, cbac)."
//
// This middleware populates `req.security` with a normalized context
// object. Downstream search handlers call `buildSecurityFilter(req.security)`
// to produce the bool clause that must be injected into every query.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";

export interface SecurityContext {
  userId: string;
  markings: string[];
  organizations: string[];
  cbac: string[];
  /** Mode for combining multiple markings. */
  markingMode: "disjunctive" | "conjunctive";
}

declare global {
  namespace Express {
    interface Request {
      security?: SecurityContext;
    }
  }
}

export function securityContext(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const user = (req as any).user || {};
  const token = (req as any).auth || {};

  // Pull claims either from JWT (Keycloak) or from a pre-populated user.
  const markings: string[] =
    user.markings || token.markings || token.realm_access?.roles || [];
  const organizations: string[] =
    user.organizations || token.orgs || token.groups || [];
  const cbac: string[] = user.cbac || token.cbac || [];

  req.security = {
    userId: user.id || token.sub || "anonymous",
    markings: Array.isArray(markings) ? markings : [],
    organizations: Array.isArray(organizations) ? organizations : [],
    cbac: Array.isArray(cbac) ? cbac : [],
    markingMode: "disjunctive",
  };

  next();
}

/**
 * Build the bool clause that must be ANDed onto every search query.
 * Returns an empty object if the user has no constraints (e.g. the
 * system user used for internal pipelines).
 */
export function buildSecurityFilter(
  ctx: SecurityContext | undefined
): Record<string, unknown> | null {
  if (!ctx) return null;
  const must: Record<string, unknown>[] = [];

  if (ctx.markings.length > 0) {
    // Row-level: documents must carry at least one of the user's markings,
    // or have no marking at all (public rows).
    must.push({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: "_security.markings" } }] } },
          ctx.markingMode === "conjunctive"
            ? {
                bool: {
                  must: ctx.markings.map((m) => ({
                    term: { "_security.markings": m },
                  })),
                },
              }
            : { terms: { "_security.markings": ctx.markings } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  if (ctx.organizations.length > 0) {
    must.push({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: "_security.org" } }] } },
          { terms: { "_security.org": ctx.organizations } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  if (ctx.cbac.length > 0) {
    must.push({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: "_security.cbac" } }] } },
          { terms: { "_security.cbac": ctx.cbac } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  if (must.length === 0) return null;
  return { bool: { must } };
}

/**
 * Strip properties the user isn't allowed to see. The response serializer
 * calls this on every row before returning it. `propertyMarkings` maps
 * propertyApiName → required marking; if the user lacks that marking we
 * drop the key from the response (column-level security).
 */
export function stripColumns(
  row: Record<string, unknown>,
  propertyMarkings: Record<string, string>,
  ctx: SecurityContext | undefined
): Record<string, unknown> {
  if (!ctx) return row;
  const userMarkings = new Set(ctx.markings);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const required = propertyMarkings[k];
    if (required && !userMarkings.has(required)) continue;
    out[k] = v;
  }
  return out;
}
