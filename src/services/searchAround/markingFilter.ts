// ---------------------------------------------------------------------------
// Marking predicate — `userSees` only.
//
// F-P3-17: The post-filter helpers `filterByMarkings` and `filterLinkRows`
// that previously lived here were DEAD CODE — no in-tree call sites. They
// were a foot-gun: a post-filter path applied after the result set is
// materialised leaks cardinality via timing/CPU/span duration, which is
// the P0 existence-leak class the live pre-filter path in
// `searchAround/clickhouseTraversal.ts:118` (`arrayAll(x -> has(...))`)
// deliberately avoids. Keeping unused post-filter code next to live
// pre-filter code guaranteed someone would wire them up.
//
// The remaining `userSees` predicate is still used by the query path
// (`searchAroundService.ts:40`) to verify markings on a specific row that
// has ALREADY been fetched under a pre-filter security scope. That
// usage is safe: it does not bound a query with a post-filter, it only
// asserts a positive invariant on a single row.
//
// Palantir marking semantics: `userSees(rowMarkings, userMarkings)` iff
// every marking on the row is in the user's granted marking set
// (AND-composition, not OR).
// ---------------------------------------------------------------------------

export function userSees(
  rowMarkings: readonly string[],
  userMarkings: ReadonlySet<string>
): boolean {
  for (const m of rowMarkings) {
    if (!userMarkings.has(m)) return false;
  }
  return true;
}
