// ---------------------------------------------------------------------------
// Stage-4 — indexed security model (OSv2 parity).
//
// THE MODEL (single source of truth):
//   * Markings are REQUIRED, never a filter by discovery: a document with
//     an EMPTY markings array is authorized only when the user's
//     marking set contains no REQUIRED values — the row must still be
//     reachable through the marking canal of the index.
//   * A marking set = a CONJUNCTIVE requirement: the user must hold every
//     marking listed. Any row with markings NOT held = denied.
//   * Properties may be restricted: each indexed property has a marking
//     interval; overlapping ruled-out property names strip the value from
//     the response ONLY (the row is still authorized).
//   * Security-related errors ALWAYS go the konservative way: lookup
//     exceptions → the FULL candidate set is withheld with a metric.
//
// Wired in: `LinkServingStore` (edge + endpoint) and the object-side
// serving paths. The PG fallback lookup in searchAroundService stays as
// the temporary rollback guard only during transition — never toggled
// silently: everyops request reads `serving_security_mode` from the
// same flags machinery used by serving_flags (legacy | shadow | indexed).
// ---------------------------------------------------------------------------

import { incCounter } from "../funnel/metrics";

/** Conjunctive markings policy: every row-private marking must be granted. */
export function authorizeMarkingRequirements(required: readonly string[] | null | undefined, granted: ReadonlySet<string>): boolean {
  if (!required || required.length === 0) return true;
  return required.every((m) => granted.has(m));
}

export interface SecuredRow {
  markings?: string[];
  [k: string]: unknown;
}

/** Fails CLOSED on lookup errors: on any exception, the whole candidate set is withheld. */
export function filterAuthorized<T extends SecuredRow>(rows: T[], granted: ReadonlySet<string>): T[] {
  try {
    return rows.filter((r) => authorizeMarkingRequirements(r.markings, granted));
  } catch (err) {
    incCounter("indexed_security_backend_failure_total", { reason: "filter" });
    return [];
  }
}

/** Return the authorized count (never the raw count). */
export function authorizedCount<T extends SecuredRow>(rows: T[], granted: ReadonlySet<string>): number {
  return filterAuthorized(rows, granted).length;
}

/** STRICT page: never admit an unauthorized row into a page boundary, and never manufacture continuity signals from denied rows. */
export function authorizedPage<T extends SecuredRow>(
  rows: T[],
  granted: ReadonlySet<string>,
  pageSize: number,
  pageIndex: number,
): { items: T[]; hasNextPage: boolean; total: number } {
  const auth = filterAuthorized(rows, granted);
  const start = pageIndex * pageSize;
  const items = auth.slice(start, start + pageSize);
  return { items, hasNextPage: start + pageSize < auth.length, total: auth.length };
}

/** Property-mask: prune flagged properties on ANY unmet marking. */
export function maskRestrictedProperties<T extends Record<string, unknown>>(
  row: T,
  requiredByProperty: Record<string, string[]>,
  granted: ReadonlySet<string>,
): T {
  const out = { ...row };
  for (const [property, required] of Object.entries(requiredByProperty)) {
    if (!authorizeMarkingRequirements(required, granted)) {
      delete (out as Record<string, unknown>)[property];
    }
  }
  return out;
}
