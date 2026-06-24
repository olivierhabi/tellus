// ---------------------------------------------------------------------------
// securityContext.ts — extract user markings / orgs / CBAC from the JWT
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 28 + Phase A3 (F-02) / A4 (F-03) remediation:
//
//   "Filter injection is mandatory. API middleware injects a security
//    filter into EVERY Elasticsearch query — no opt-out. Filter is
//    constructed from the user's token claims (markings, orgs, cbac).
//    A user with no clearance cannot see documents with a clearance
//    constraint. A document with no `_security` is invisible to
//    marking-constrained users (fail-closed)."
//
// This middleware populates `req.security` with a normalized context
// object. Downstream search handlers call `buildSecurityFilter(req.security)`
// to produce the bool clause that must be injected into every query.
//
// Claim sources (in priority order):
//   - `markings` top-level claim (Keycloak user-attribute protocol mapper)
//   - `realm_access.roles` (legacy fallback — realm roles starting with
//     "marking:" are promoted to markings; all others flow to CBAC)
//
//   - `groups` top-level claim (Keycloak group-membership mapper) → CBAC
//   - `realm_access.roles` (non-marking roles) → CBAC
//
// A principal bearing an internal service identity
// (`req.auth.iss === process.env.TELLUS_INTERNAL_ISSUER`) is treated as
// a system user: markings=[], but the filter is suppressed (match-all)
// via the `systemPrincipal` flag. This mirrors Foundry's distinction
// between Multipass (user auth) and Service-Tokens (machine auth) — a
// human with empty markings fails closed; a service with empty markings
// is explicitly exempted.
//
// Marking-bypass for superadmins (T-26):
//   Foundry's data model gives every principal an explicit set of
//   marking handles; admins are simply principals that hold every
//   handle. We can't enumerate "every handle" cheaply on every read,
//   so we approximate Foundry's "admin holds all handles" with a
//   single role-based bypass: a human bearing the
//   `tellus-superadmin` realm role gets `markingBypass=true`, which
//   short-circuits the marking filter to match-all (same effect as
//   `systemPrincipal`). The two flags are kept ORTHOGONAL because
//   they describe different things:
//     • `systemPrincipal` — "this is a machine, not a human";
//        consumed by audit hooks, PAT gating, explorations RBAC,
//        etc. Setting it for a human would mis-attribute writes.
//     • `markingBypass`   — "this principal may read every marking";
//        consumed ONLY by `buildSecurityFilter`. Human admins set
//        this true while staying systemPrincipal=false so their
//        writes still flow through the human audit path.
//   Service principals get BOTH flags so existing call sites that
//   keyed on `systemPrincipal` for filter bypass keep working.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { TELLUS_SUPERADMIN_ROLE } from "./requireSuperAdmin";

export interface SecurityContext {
  userId: string;
  markings: string[];
  organizations: string[];
  cbac: string[];
  /** Mode for combining multiple markings. */
  markingMode: "disjunctive" | "conjunctive";
  /**
   * True when the principal is an internal service (not a human user).
   * Service principals bypass marking enforcement because they operate
   * on behalf of the platform (Funnel dispatcher, reindex, etc.). All
   * other principals MUST satisfy the marking filter.
   *
   * Note: this flag is consumed by audit / PAT / explorations RBAC.
   * Do NOT set it true for human principals — use `markingBypass`
   * for the read-side filter-skip semantics without polluting the
   * write-side principal-type semantics.
   */
  systemPrincipal: boolean;
  /**
   * True when the principal may read every marking — i.e. the
   * marking filter is suppressed for reads. Orthogonal to
   * `systemPrincipal` (see file header).
   *
   * Sources:
   *   • `systemPrincipal === true`  → always true (service ids
   *     have always bypassed marking enforcement)
   *   • realm role `tellus-superadmin` → true (T-26: aligns with
   *     Foundry's "admin holds all marking handles" model and
   *     with the existing `requireSuperAdmin` route gate)
   *
   * Consumed ONLY by `buildSecurityFilter`. Audit / PAT / RBAC
   * code must continue to key on `systemPrincipal`.
   */
  markingBypass: boolean;
}

declare global {
  namespace Express {
    interface Request {
      security?: SecurityContext;
    }
  }
}

/**
 * Extract a normalized string[] from a claim value. Handles both string-array
 * and space-separated string forms (both valid per RFC 9068 §2.2.3).
 */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * Classify a realm_access.role as either a marking or a CBAC group. Roles
 * prefixed with `marking:` (e.g., `marking:SECRET`) are Markings; everything
 * else is CBAC. This gives operators a single place (Keycloak role naming)
 * to control classification without a custom protocol mapper.
 */
function classifyRole(role: string): { kind: "marking" | "cbac"; value: string } {
  if (role.startsWith("marking:")) return { kind: "marking", value: role.slice("marking:".length) };
  return { kind: "cbac", value: role };
}

const INTERNAL_ISSUER = process.env.TELLUS_INTERNAL_ISSUER || "";

export function securityContext(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const user = (req as any).user || {};
  const token = (req as any).auth || {};
  const principal = (req as any).tellusPrincipal;

  // ---- Markings ---------------------------------------------------------
  const explicitMarkings = asStringArray(user.markings ?? token.markings);
  const roleMarkings: string[] = [];
  const roleCbac: string[] = [];
  for (const role of asStringArray(token.realm_access?.roles)) {
    const c = classifyRole(role);
    if (c.kind === "marking") roleMarkings.push(c.value);
    else roleCbac.push(c.value);
  }
  const markings = [...new Set([...explicitMarkings, ...roleMarkings])];

  // ---- CBAC -------------------------------------------------------------
  const explicitCbac = asStringArray(user.cbac ?? token.cbac);
  const groupCbac = asStringArray(token.groups).map((g) => g.replace(/^\//, ""));
  const cbac = [...new Set([...explicitCbac, ...roleCbac, ...groupCbac])];

  // ---- Organizations ----------------------------------------------------
  const organizations = asStringArray(user.organizations ?? token.orgs);

  // ---- Principal type ---------------------------------------------------
  // A request bearing a PAT with the `system:internal` scope, or a JWT
  // whose issuer matches TELLUS_INTERNAL_ISSUER, is a system principal.
  // Human users with `markings:[]` fail closed; system principals are
  // explicitly exempted (match-all filter).
  const hasSystemScope =
    principal &&
    Array.isArray(principal.scopes) &&
    principal.scopes.includes("system:internal");
  const isInternalIssuer =
    INTERNAL_ISSUER.length > 0 &&
    typeof token.iss === "string" &&
    token.iss === INTERNAL_ISSUER;
  const systemPrincipal = Boolean(hasSystemScope || isInternalIssuer);

  // ---- Marking-bypass (T-26) -------------------------------------------
  // Superadmin holders read everything. We consult BOTH the resolved
  // principal's role list (the canonical post-auth view, populated by
  // the `tellusPrincipal` resolver and respecting role-mapper edits)
  // AND the raw `realm_access.roles` JWT claim (the pre-resolver
  // fallback). Either being present is sufficient.
  const principalRoles: string[] = Array.isArray(principal?.roles)
    ? (principal.roles as string[])
    : [];
  const tokenRoles = asStringArray(token.realm_access?.roles);
  const isSuperAdmin =
    principalRoles.includes(TELLUS_SUPERADMIN_ROLE) ||
    tokenRoles.includes(TELLUS_SUPERADMIN_ROLE);
  const markingBypass = Boolean(systemPrincipal || isSuperAdmin);

  req.security = {
    userId: user.id || principal?.userId || token.sub || "anonymous",
    markings,
    organizations,
    cbac,
    markingMode: "disjunctive",
    systemPrincipal,
    markingBypass,
  };

  next();
}

/**
 * Route-level assertion that MUST be called by data-plane handlers before
 * issuing any OpenSearch read. Returns the SecurityContext on success; on
 * failure, throws a 500-class error that the global error handler converts
 * to a uniform response envelope. Fail-closed: if the middleware has not
 * populated `req.security`, we do NOT fall through to an unfiltered query.
 */
export function requireSecurityContext(req: Request): SecurityContext {
  const ctx = req.security;
  if (!ctx) {
    const err: any = new Error(
      "securityContext middleware did not populate req.security — refusing to execute an unfiltered query",
    );
    err.statusCode = 500;
    err.errorCode = "SECURITY_CONTEXT_MISSING";
    throw err;
  }
  return ctx;
}

/**
 * Build the bool clause that must be ANDed onto every search query.
 * Returns an empty object if the user has no constraints (e.g. the
 * system user used for internal pipelines).
 */
export function buildSecurityFilter(
  ctx: SecurityContext | undefined
): Record<string, unknown> | null {
  // Fail-closed: a missing security context means the middleware did not
  // run or the request carried no auth — in either case we must NOT emit
  // a match-all filter. The route-level `requireSecurityContext` is the
  // primary guard, but this provides defense in depth: a caller that
  // forgets to call `requireSecurityContext` still cannot accidentally
  // ship an unfiltered query because the match-none filter below returns
  // zero results.
  if (!ctx) {
    return { match_none: {} };
  }

  // Marking-bypass principals (internal services AND human
  // superadmins) skip marking enforcement entirely. See file header.
  // We key on `markingBypass` rather than `systemPrincipal` so the
  // bypass is granted via role assignment, not by mis-stamping a
  // human as a service identity. `markingBypass` is the union of
  // (systemPrincipal || tellus-superadmin); legacy contexts without
  // the field default to `systemPrincipal` so older callers keep
  // their behaviour.
  const bypass = (ctx as { markingBypass?: boolean }).markingBypass
    ?? ctx.systemPrincipal;
  if (bypass) {
    return null;
  }

  const must: Record<string, unknown>[] = [];

  // ---- Field name note -------------------------------------------------
  // OpenSearch's default dynamic mapping infers string properties as
  // `text` with a `.keyword` sub-field. `term`/`terms` on a `text` field
  // scores against the analyzed tokens, not the raw value, so it misses
  // exact-match lookups like "PUBLIC". We target `.keyword` everywhere
  // to guarantee exact-match semantics regardless of whether the field
  // was explicitly mapped (via index template) or dynamically inferred.
  // A future index template that maps `_security.*` as pure `keyword`
  // still works because keyword fields accept term queries without the
  // sub-field; we only need to ensure our template keeps the
  // `.keyword` multi-field alongside, or drop the suffix after migration.
  const MARKINGS_FIELD = "_security.markings.keyword";
  const CBAC_FIELD = "_security.cbac.keyword";
  const ORG_FIELD = "_security.org.keyword";

  // ---- Markings (row-level) --------------------------------------------
  // Palantir-1:1 fail-closed: a document MUST carry at least one marking
  // that the user holds. Documents without `_security.markings` are
  // invisible to marking-constrained users (F-03). The public-leak
  // `must_not.exists` branch from the previous implementation is removed
  // — operators who want public data must explicitly tag it
  // `['PUBLIC']`.
  //
  // An authenticated user with `markings:[]` (the "dave" archetype) falls
  // through to an empty `terms` clause which matches zero documents,
  // which is the intended fail-closed behavior.
  must.push(
    ctx.markingMode === "conjunctive"
      ? {
          bool: {
            must: ctx.markings.map((m) => ({
              term: { [MARKINGS_FIELD]: m },
            })),
          },
        }
      : { terms: { [MARKINGS_FIELD]: ctx.markings } },
  );

  // ---- Organizations (column-family-level) -----------------------------
  // Orgs remain permissive-on-absent because "no org tag" historically
  // means "cross-org shared data" in the Foundry model. Operators who
  // need org-strict enforcement set `_security.org` on every doc.
  if (ctx.organizations.length > 0) {
    must.push({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: ORG_FIELD } }] } },
          { terms: { [ORG_FIELD]: ctx.organizations } },
        ],
        minimum_should_match: 1,
      },
    });
  }

  // ---- CBAC (role-based classification) --------------------------------
  // CBAC follows the same fail-closed rule as markings: documents tagged
  // with a CBAC constraint MUST match one of the user's CBAC groups. An
  // untagged document (no `_security.cbac`) is CBAC-unrestricted and
  // visible to anyone who passes the marking filter.
  if (ctx.cbac.length > 0) {
    must.push({
      bool: {
        should: [
          { bool: { must_not: [{ exists: { field: CBAC_FIELD } }] } },
          { terms: { [CBAC_FIELD]: ctx.cbac } },
        ],
        minimum_should_match: 1,
      },
    });
  } else {
    // User with no CBAC groups cannot see CBAC-tagged documents.
    must.push({
      bool: {
        must_not: [{ exists: { field: CBAC_FIELD } }],
      },
    });
  }

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
