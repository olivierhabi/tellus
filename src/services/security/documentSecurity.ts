// ---------------------------------------------------------------------------
// documentSecurity.ts — compute `_security` for an indexed document
// ---------------------------------------------------------------------------
//
// Phase A4 (F-03) remediation: every document written to OpenSearch MUST
// carry a `_security` field. A document without `_security.markings` is
// invisible to marking-constrained users after the public-leak branch
// was removed from buildSecurityFilter (middleware/securityContext.ts).
//
// This module is the single source of truth for how a document's
// `_security` is computed. Callers include:
//   • editApplicator.ts (action apply → bulk index)
//   • seed.ts (sample data)
//   • reindexService.ts (backfill)
//   • Funnel indexer (streaming CSV → OS)
//   • scripts/backfillSecurity.ts (one-time migration of pre-remediation data)
//
// Default policy:
//   • _security.markings = ['PUBLIC'] unless the caller passes an
//     explicit override (e.g., the seed marks some Taxpayers as 'SECRET'
//     for CBAC integration tests).
//   • _security.cbac = [] (no CBAC restriction).
//   • _security.org = undefined (permissive on absent).
//
// The "default to PUBLIC" choice matches Foundry's behavior when an
// object's backing dataset has no Markings policy: the data is assumed
// PUBLIC until a Markings classifier is attached. A migration-readiness
// audit can locate these defaults via `_security.markings: ['PUBLIC']`
// and reclassify them.
// ---------------------------------------------------------------------------

export const DEFAULT_MARKING = "PUBLIC";

export interface DocumentSecurity {
  /** Row-level marking lattice. Must be non-empty. */
  markings: string[];
  /** Classification-based access control groups. */
  cbac: string[];
  /** Organization scope (optional — permissive on absent). */
  org?: string[];
}

export interface ComputeSecurityOptions {
  /** Override the default markings. Used by the seed for SECRET fixtures. */
  markings?: string[];
  cbac?: string[];
  org?: string[];
}

/**
 * Compute the `_security` block for a document being indexed. Callers that
 * already carry explicit markings (seed, migrations) should pass them; all
 * other callers receive the default PUBLIC classification.
 */
export function computeDocumentSecurity(
  opts: ComputeSecurityOptions = {},
): DocumentSecurity {
  const markings =
    opts.markings && opts.markings.length > 0 ? [...opts.markings] : [DEFAULT_MARKING];
  const sec: DocumentSecurity = {
    markings,
    cbac: opts.cbac ?? [],
  };
  if (opts.org && opts.org.length > 0) sec.org = [...opts.org];
  return sec;
}

/**
 * Merge a computed security block into an in-flight document. Idempotent:
 * if the document already has `_security`, the existing value is preserved.
 * Used by editApplicator's create path to avoid stamping PUBLIC on top of
 * an action-supplied marking.
 */
export function ensureDocumentSecurity<T extends Record<string, unknown>>(
  doc: T,
  opts: ComputeSecurityOptions = {},
): T & { _security: DocumentSecurity } {
  const existing = (doc as { _security?: unknown })._security;
  if (existing && typeof existing === "object" && "markings" in existing) {
    const e = existing as Partial<DocumentSecurity>;
    if (Array.isArray(e.markings) && e.markings.length > 0) {
      return doc as T & { _security: DocumentSecurity };
    }
  }
  return { ...doc, _security: computeDocumentSecurity(opts) };
}
