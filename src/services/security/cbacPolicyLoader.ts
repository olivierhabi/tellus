// ---------------------------------------------------------------------------
// src/services/security/cbacPolicyLoader.ts
//
// Loads CBAC Policy rows from Postgres for a given resource. Cached in
// an LRU with a 60-second TTL — policy changes propagate via TTL expiry
// rather than pub/sub. F-P5-09 cache-invalidation broadcast is a Block H
// deliverable; for now, a 60-second worst-case staleness on policy
// updates is acceptable given policy edits are infrequent.
//
// The loader returns null for "no policy row found" — which the CBAC
// evaluator treats as DEFAULT-DENY per cbacPolicy.ts step 0.
// ---------------------------------------------------------------------------

import { LRUCache } from "lru-cache";
import { query } from "../../db";
import type { Policy, PrincipalSelector } from "./cbacPolicy";
import { incCounter } from "../funnel/metrics";

const POLICY_TTL_MS = 60_000;
const POLICY_CACHE_MAX = 5_000;

interface CachedPolicy {
  policy: Policy | null;
  loadedAt: number;
}

const cache = new LRUCache<string, CachedPolicy>({
  max: POLICY_CACHE_MAX,
  ttl: POLICY_TTL_MS,
});

/**
 * Build cache key — includes ontologyId per F-P5-03 tenant isolation.
 * Missing ontologyId is explicit "global" and is legal for resources
 * that are not ontology-scoped (e.g. /admin).
 */
function cacheKey(resourceKind: string, resourceId: string, ontologyId: string | null): string {
  return `${resourceKind}::${ontologyId ?? "__global__"}::${resourceId}`;
}

function rowToPolicy(row: {
  allowed_principals: unknown;
  denied_principals: unknown;
  required_markings: unknown;
}): Policy {
  return {
    allowedPrincipals: Array.isArray(row.allowed_principals)
      ? (row.allowed_principals as PrincipalSelector[])
      : row.allowed_principals === null || row.allowed_principals === undefined
        ? null
        : (row.allowed_principals as PrincipalSelector[]),
    deniedPrincipals: Array.isArray(row.denied_principals)
      ? (row.denied_principals as PrincipalSelector[])
      : null,
    requiredMarkings: Array.isArray(row.required_markings)
      ? (row.required_markings as string[])
      : [],
  };
}

/**
 * Load the CBAC policy for an Action type by api_name. Returns null if
 * no action_type row exists (which the evaluator treats as default-deny).
 */
export async function loadActionTypePolicy(
  ontologyId: string | null,
  apiName: string,
): Promise<Policy | null> {
  const key = cacheKey("action_type", apiName, ontologyId);
  const cached = cache.get(key);
  if (cached) {
    incCounter("tellus_cbac_policy_cache_hit_total", { resource_kind: "action_type" });
    return cached.policy;
  }
  incCounter("tellus_cbac_policy_cache_miss_total", { resource_kind: "action_type" });

  const result = await query(
    `SELECT allowed_principals, denied_principals, required_markings
       FROM action_type
      WHERE api_name = $1
        AND ($2::uuid IS NULL OR ontology_id = $2::uuid)
      LIMIT 1`,
    [apiName, ontologyId],
  );

  const policy =
    result.rowCount === 1
      ? rowToPolicy(
          result.rows[0] as {
            allowed_principals: unknown;
            denied_principals: unknown;
            required_markings: unknown;
          },
        )
      : null;
  cache.set(key, { policy, loadedAt: Date.now() });
  return policy;
}

/**
 * Load CBAC policy for a branch. Branches use a simpler model: the
 * branch row's created_by is the owner; anyone can read unless
 * required_markings are set on the ontology.
 *
 * For now returns a permissive policy that requires authentication only.
 * Branch-specific policies (readers vs writers vs mergers) are Block E
 * branching work — this loader is the integration point, not the full
 * branch-policy model.
 */
export async function loadBranchPolicy(
  ontologyId: string | null,
  _branchId: string,
): Promise<Policy | null> {
  // Minimum safe default: any authenticated subject may interact with
  // branches; deny-list is Block E.
  void ontologyId;
  return {
    allowedPrincipals: [{ type: "any_authenticated" }],
    deniedPrincipals: null,
    requiredMarkings: [],
  };
}

/**
 * Load CBAC policy for the search endpoint. Any authenticated subject
 * may search, but markings still gate per-document visibility at the
 * query-executor layer (pre-query filter).
 */
export async function loadSearchPolicy(): Promise<Policy | null> {
  return {
    allowedPrincipals: [{ type: "any_authenticated" }],
    deniedPrincipals: null,
    requiredMarkings: [],
  };
}

/**
 * Load CBAC policy for the audit query endpoints. Restricted to
 * principals with role "audit-reader" or "audit-admin" per Rwandan
 * Law 058/2021 Art. 29 — only authorized personnel may read audit logs.
 */
export async function loadAuditQueryPolicy(): Promise<Policy | null> {
  return {
    allowedPrincipals: [
      { type: "role", role: "audit-reader" },
      { type: "role", role: "audit-admin" },
      { type: "role", role: "rra-tax-auditor" },
    ],
    deniedPrincipals: null,
    requiredMarkings: [],
  };
}

/** Test / invalidation hook. */
export function __clearPolicyCache(): void {
  cache.clear();
}
