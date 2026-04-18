// ---------------------------------------------------------------------------
// Marking filter — Task B10
//
// Palantir's access model is a hybrid of ABAC and mandatory access
// controls: every object/link carries a `markings` array, and a user
// "sees" a row iff *every* marking on that row is in the user's granted
// marking set. (Markings are AND-composed, not OR-composed — missing one
// means the row is withheld.)
//
// This module implements the AND-composition filter at the API boundary.
// We keep it intentionally thin: callers (query path, traversal path)
// just `filter(rows, userMarkings)` and trust the output to be
// ACL-safe.
// ---------------------------------------------------------------------------

export interface MarkedRow<T extends object> {
  row: T;
  markings: string[];
}

export function userSees(
  rowMarkings: readonly string[],
  userMarkings: ReadonlySet<string>
): boolean {
  for (const m of rowMarkings) {
    if (!userMarkings.has(m)) return false;
  }
  return true;
}

export function filterByMarkings<T extends object>(
  rows: Array<MarkedRow<T>>,
  userMarkings: ReadonlySet<string>
): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (userSees(r.markings, userMarkings)) out.push(r.row);
  }
  return out;
}

/**
 * Subtract PKs the user cannot see. Works against the row shape
 * ClickHouse's link tables produce (`{ source_pk, target_pk, markings }`).
 *
 * Semantics: the user must be cleared for the *link's* markings (not the
 * markings of the endpoints — those are enforced by the per-Object-Type
 * query path). This is B10's narrow contract: it drops links.
 */
export function filterLinkRows<
  T extends { source_pk: string; target_pk: string; markings?: string[] | null }
>(rows: T[], userMarkings: ReadonlySet<string>): T[] {
  const out: T[] = [];
  for (const r of rows) {
    if (userSees(r.markings ?? [], userMarkings)) out.push(r);
  }
  return out;
}
