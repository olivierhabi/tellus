// ---------------------------------------------------------------------------
// F-P3-13 — HTTP branch-header resolver for read-path routes.
//
// Complements the frozen `src/services/branchContext.ts` module from
// F-P3-12. That module owns the write-path resolution (`resolveBranchIdOrMain`
// with `main`-branch fallback); this helper is the narrower read-path
// equivalent: it reads the `x-branch-id` header and returns the UUID or
// `null` without touching the database.
//
// Why the split:
//   - Write-path callers always know the ontology and can afford the
//     `ontology_branch` lookup; they use `resolveBranchIdOrMain`.
//   - Read-path callers often have only an `objectType` param and
//     deriving `ontologyId` is an extra PG round-trip per request.
//     The security-filter's transitional OR clause in
//     `src/services/opensearch/client.ts:injectSecurityFilter` keeps
//     legacy docs (those without `__branch`) visible under a `null`
//     branchId, so `null` is a safe-by-construction default for
//     untagged reads.
//
// If a route HAS a resolved ontologyId already, it may forward that to
// `resolveBranchIdOrMain(ontologyId, readBranchHeader(req))` instead of
// calling this helper directly. Both code paths are acceptable.
// ---------------------------------------------------------------------------

export interface MinimalReqForHeader {
  get?: (name: string) => string | undefined;
  headers?: Record<string, unknown>;
}

/**
 * Read the `x-branch-id` HTTP header and normalise it to `string | null`.
 * Empty / whitespace-only values become `null`.
 */
export function readBranchHeader(req: MinimalReqForHeader): string | null {
  const fromGet =
    typeof req.get === "function" ? req.get("x-branch-id") : undefined;
  const fromHeaders = (req.headers as Record<string, unknown> | undefined)?.[
    "x-branch-id"
  ];
  const raw = (fromGet ?? (fromHeaders as string | undefined)) || null;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}
