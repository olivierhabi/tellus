/**
 * patScopeMap.ts
 * --------------
 * Route-pattern-based resolver that answers the question "which PAT
 * scope does this HTTP request require?". Called from inside
 * `requireTellusAuth` whenever the resolved principal is a PAT.
 *
 * Rather than decorating every single route handler with
 * `requirePatScope('...')`, we keep the full access model in this
 * file so a reviewer can see the whole scope matrix at a glance,
 * and so every new route added to the app is automatically gated
 * by the fallback rules below (GET → api:read, mutations → api:write).
 *
 * The matching is path-prefix based — no regex — because Express
 * already normalizes `req.baseUrl + req.path` into a stable string
 * and the prefixes we care about are non-overlapping. More specific
 * prefixes are listed first so they win the first-match race.
 *
 * Interactive JWT / cookie sessions bypass this check entirely. It
 * only fires for `req.tellusPrincipal.source === 'pat'`.
 */

import type { Request } from 'express';
import type { TellusPatScope } from './patScopes';

type ScopeRule = {
  /** HTTP method restriction — undefined means "any method". */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Prefix on `req.baseUrl + req.path`. */
  prefix: string;
  /** Scope required when the rule matches. */
  scope: TellusPatScope;
  /**
   * Optional additional predicate for rules that need sub-path
   * inspection (e.g. distinguishing dataset uploads from dataset
   * reads on the same tree).
   */
  when?: (path: string) => boolean;
  /**
   * Human-readable description of the `when` predicate so we can
   * surface it through the public scope-manifest endpoint. The
   * predicate function itself isn't JSON-serializable, so every
   * rule that sets `when` must also set `whenDescription`.
   */
  whenDescription?: string;
};

/**
 * Rules evaluated in order — more specific prefixes must come first.
 * Audit-related endpoints get their own narrow scope so a PAT minted
 * solely for log export can't accidentally read ontology state.
 */
const RULES: ScopeRule[] = [
  // --- Tellus auth surface ----------------------------------------
  { prefix: '/api/v1/auth/me/audit', scope: 'audit:read' },
  { method: 'GET', prefix: '/api/v1/auth/tokens', scope: 'pats:read' },
  { method: 'GET', prefix: '/api/v1/auth/me/webauthn', scope: 'api:read' },
  { prefix: '/api/v1/auth/me/webauthn', scope: 'api:write' },
  { method: 'GET', prefix: '/api/v1/auth/me/totp', scope: 'api:read' },
  { prefix: '/api/v1/auth/me/totp', scope: 'api:write' },
  { method: 'GET', prefix: '/api/v1/auth/me/sessions', scope: 'api:read' },
  { prefix: '/api/v1/auth/me/sessions', scope: 'api:write' },
  { prefix: '/api/v1/auth/me/password', scope: 'api:write' },
  { method: 'GET', prefix: '/api/v1/auth/me', scope: 'api:read' },

  // --- Ontology engine --------------------------------------------
  { method: 'GET', prefix: '/api/v2/ontologies', scope: 'ontology:read' },
  { prefix: '/api/v2/ontologies', scope: 'ontology:write' },

  // --- Dataset lifecycle (upload is its own narrower scope) -------
  {
    prefix: '/api/projects',
    scope: 'datasets:upload',
    when: (p) => /\/datasets(\/|$)/.test(p) && /\/upload|\/datasets$/.test(p),
    whenDescription: 'project sub-path matches /datasets(/|$) AND /upload|/datasets$',
  },
  { method: 'GET', prefix: '/api/datasets', scope: 'datasets:read' },
  { prefix: '/api/datasets', scope: 'datasets:upload' },
  { method: 'GET', prefix: '/api/projects', scope: 'datasets:read' },
  { prefix: '/api/projects', scope: 'api:write' },
  { method: 'GET', prefix: '/api/search', scope: 'datasets:read' },
  { method: 'GET', prefix: '/api/breadcrumb', scope: 'datasets:read' },

  // --- Administrative --------------------------------------------
  { prefix: '/api/v1/auth/admin/applications', scope: 'api:write' },
];

/**
 * Resolve the PAT scope required to serve the given request, or null
 * if the request targets a non-protected path (health probes, the
 * OIDC discovery proxy, etc.). The caller is responsible for
 * rejecting when the PAT's scope list doesn't include the return value.
 */
export function getRequiredPatScope(req: Request): TellusPatScope | null {
  const full = (req.baseUrl || '') + (req.path || '');
  const path = full.split('?')[0] || '/';
  const method = req.method.toUpperCase();

  // Unauthenticated or intentionally-ungated endpoints that PAT
  // holders are free to hit without any scope. Kept in a single
  // constant so the public scope-manifest endpoint can advertise
  // the full list without drifting from the runtime check.
  if (UNAUTHENTICATED_ROUTES.includes(path)) {
    return null;
  }

  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue;
    if (!path.startsWith(rule.prefix)) continue;
    if (rule.when && !rule.when(path)) continue;
    return rule.scope;
  }

  // Fallback: anything else under /api/ requires api:read/write.
  if (path.startsWith('/api/')) {
    return method === 'GET' ? 'api:read' : 'api:write';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public manifest — used by the GET /api/v1/auth/pat-scopes endpoint so
// tooling that mints PATs for third-party apps can read the access model
// without scraping this source file. The returned shape is stable JSON
// and is documented in src/docs/openapi.ts.
// ---------------------------------------------------------------------------

export interface PublicScopeRule {
  method: 'ANY' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  prefix: string;
  scope: TellusPatScope;
  extraCondition?: string;
}

export interface PatScopeManifest {
  /** The closed enum of scopes a PAT can carry. */
  scopes: ReadonlyArray<TellusPatScope>;
  /**
   * Routes explicitly exempt from the scope gate — hit them with any
   * valid PAT (or none at all for the public subset).
   */
  unauthenticatedRoutes: ReadonlyArray<string>;
  /** Rules evaluated in order; first match wins. */
  rules: ReadonlyArray<PublicScopeRule>;
  /** Fallback applied when no rule matches and the path is /api/*. */
  fallback: {
    'GET': TellusPatScope;
    'MUTATION': TellusPatScope;
  };
}

const UNAUTHENTICATED_ROUTES = [
  '/api/v1/auth/health',
  '/api/v1/auth/oidc/config',
  '/api/v1/auth/saml/metadata',
  '/api/v1/auth/login',
  '/api/v1/auth/login/mfa',
  '/api/v1/auth/login/mfa/webauthn-options',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/token-info',
  '/api/v1/auth/check-access',
  '/api/v1/auth/pat-scopes',
  // Mandatory-passkey enrollment handshake — these two endpoints
  // are reached with a `tellus_enroll_*` bearer, not a JWT, and
  // are walked BEFORE the user has a real session. The gate and
  // the route handlers both do their own token resolution, so
  // they must be listed here to bypass the PAT/JWT path entirely.
  '/api/v1/auth/enroll/passkey/options',
  '/api/v1/auth/enroll/passkey/verify',
];

export function getPatScopeManifest(): PatScopeManifest {
  // Import the enum here (vs at the top) so the circular dependency
  // with patScopes.ts stays clean.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TELLUS_PAT_SCOPES } = require('./patScopes') as typeof import('./patScopes');
  return {
    scopes: TELLUS_PAT_SCOPES,
    unauthenticatedRoutes: UNAUTHENTICATED_ROUTES,
    rules: RULES.map<PublicScopeRule>((r) => ({
      method: r.method ?? 'ANY',
      prefix: r.prefix,
      scope: r.scope,
      extraCondition: r.whenDescription,
    })),
    fallback: { GET: 'api:read', MUTATION: 'api:write' },
  };
}
