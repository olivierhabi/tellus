// ---------------------------------------------------------------------------
// applyContext.ts — single canonical helper for applying request context
// (security filter + branch filter) to an OpenSearch query/body.
//
// T-01: This module is the *only* place in the codebase that knows what
// "apply the request context to a query" means. Every read-path handler
// MUST funnel its query/body through `applyContextToQuery` /
// `applyContextToBody`. The pre-T-01 ad-hoc lambdas (`wrapWithSecurity`)
// in routes/{comparisons,charts}.ts are replaced by calls to these
// functions. The thin delegate in `services/opensearch/client.ts`
// (`injectSecurityFilter`) is preserved for non-route callers but
// also routes through here.
//
// Contracts (see tasks/object-explorer/contracts.md):
//   C-01 — null sec & null branch  → returns query unchanged
//   C-02 — security filter present → ANDed inside `bool.must` beside original
//   C-03 — branch present          → branch disjunct (term OR missing-field)
//   C-04 — empty-string branch     → treated as null (no clause added)
//   C-05 — pure: no I/O, no logging
//   C-06 — applyContextToBody is a thin shim that defaults missing query
//          to `{ match_all: {} }` and threads through applyContextToQuery
//   C-10 — wrapper idempotence: applying twice with same args yields the
//          same result-shape after one canonical normalization
//
// The branch disjunct preserves visibility for legacy documents indexed
// before F-P3-13's mapping change (no `__branch` field) — the
// `must_not.exists` clause keeps them visible. F-P3-15's reindex pass
// will eventually backfill, after which the disjunct can be tightened.
// ---------------------------------------------------------------------------

/**
 * Pure helper. Wraps a query with a security filter clause AND/OR a
 * branch-disjunct clause if either is present.
 *
 * Returns `query` unchanged when both `securityFilter` and `branchId`
 * are nullish or empty. Treats empty string `branchId` as null
 * (no silent main-fallback inside this helper — the caller decides).
 *
 * No I/O, no logging, no side effects. Stable shape:
 *   { bool: { must: [original, ...clauses] } }
 *
 * Idempotence note: calling `applyContextToQuery` twice with the same
 * `(securityFilter, branchId)` produces a deeper but logically-equivalent
 * tree (`bool.must[0]` is the previous result). For tests that need
 * shape stability across re-application, see `normaliseAppliedContext`.
 */
export function applyContextToQuery(
  query: Record<string, unknown>,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null | undefined,
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];

  if (securityFilter !== null && securityFilter !== undefined) {
    clauses.push(securityFilter);
  }

  // Empty string is treated as null: no clause added.
  if (typeof branchId === "string" && branchId.length > 0) {
    clauses.push({
      bool: {
        should: [
          { term: { __branch: branchId } },
          {
            bool: {
              must_not: [{ exists: { field: "__branch" } }],
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }

  if (clauses.length === 0) return query;

  return {
    bool: {
      must: [query, ...clauses],
    },
  };
}

/**
 * Body-level wrapper. Defaults missing `body.query` to `{ match_all: {} }`
 * before threading through `applyContextToQuery`.
 *
 * Body-level fields (size, _source, sort, aggs, …) are passed through
 * untouched — only `query` is rewritten. This is critical for
 * aggregation-only sub-bodies in `_msearch` calls: callers must wrap
 * the `query` field, NOT the entire body.
 */
export function applyContextToBody(
  body: Record<string, unknown>,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null | undefined,
): Record<string, unknown> {
  const original =
    (body.query as Record<string, unknown> | undefined) ?? { match_all: {} };
  return {
    ...body,
    query: applyContextToQuery(original, securityFilter, branchId),
  };
}

/**
 * Test-only helper for the idempotence property: strips one layer of
 * the `bool.must` wrapper if its first child is itself a `bool.must`
 * with the same `clauses[1..]` tail. Used in the property test to
 * compare shapes after one vs two applications.
 *
 * Production code MUST NOT depend on this — it exists for assertion
 * convenience only.
 */
export function flattenAppliedContextOnce(
  q: Record<string, unknown>,
): Record<string, unknown> {
  const outer = q.bool as { must?: unknown[] } | undefined;
  if (!outer || !Array.isArray(outer.must) || outer.must.length < 2) return q;
  const [first, ...tail] = outer.must;
  const inner = (first as { bool?: { must?: unknown[] } } | undefined)?.bool;
  if (!inner || !Array.isArray(inner.must) || inner.must.length < 2) return q;
  const innerTail = inner.must.slice(1);
  if (JSON.stringify(innerTail) !== JSON.stringify(tail)) return q;
  return {
    bool: {
      must: [inner.must[0], ...tail],
    },
  };
}
