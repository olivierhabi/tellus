// ---------------------------------------------------------------------------
// dates.ts — defensive timestamp coercion helpers.
//
// PostgreSQL timestamp columns can arrive at the JS layer as either `Date`
// objects OR ISO-8601 strings, depending on which `pg` `typeParser` config
// is active in the current pool. Several pool init paths in this codebase
// intentionally disable date parsing (so query-builder portability stays
// stable across the SQL dialects we target), which means a route that
// blindly calls `r.created_at.toISOString()` crashes at runtime the first
// time a row is returned by a string-mode pool.
//
// `toIso()` accepts both shapes and produces a stable ISO-8601 UTC string,
// or `null` for null/undefined/invalid inputs. `toIsoRequired()` is the
// non-null variant for `NOT NULL` columns; if it ever encounters a corrupt
// value it returns "" (rather than crashing the whole response) so the
// caller can detect and surface the bad row without taking down the
// surrounding endpoint.
//
// History: this previously lived inline at `src/routes/projectWorkspace.ts:109`
// after a 500 was traced to `r.trashed_at?.toISOString is not a function`
// when the folder-scoped trash endpoint actually started returning rows.
// Lifted here so external-references, file-references, and any future
// timestamp consumer share the same coercion path.
// ---------------------------------------------------------------------------

/**
 * Coerce a `pg` timestamp column to an ISO-8601 UTC string.
 *
 *   `Date`            → `date.toISOString()`
 *   `string` (ISO-ish)→ round-tripped through `new Date(...)` to normalise
 *                       the offset format (`+00` → `Z`) and reject NaN
 *   `null` | `undefined` → `null`
 *   anything that fails to parse  → `null`
 *
 * Pure; safe to call from hot paths.
 */
export function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Non-null variant for columns the schema declares `NOT NULL`.
 *
 * Returns `""` (rather than throwing) when the input is null/invalid, so
 * a single corrupt row does not crash an entire list response. Consumers
 * that need stricter handling can detect the empty string and surface a
 * structured error.
 */
export function toIsoRequired(v: Date | string): string {
  return toIso(v) ?? "";
}
