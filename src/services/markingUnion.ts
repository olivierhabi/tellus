// ---------------------------------------------------------------------------
// Marking-union helper — PB-B7.
//
// The Funnel's mergeStage.ts and the Pipeline Builder's deploy path BOTH
// need to compute:
//
//   effective_markings(row) = ⋃ markings(datasource)
//   effective_markings(dataset) = ⋃ markings(input_dataset)
//
// This module is the single source of truth so the two subsystems can
// never drift. Pure TS, no DB, no IO — cheap to import from operators
// and from property-based tests that hammer the same fixture across
// both callers.
//
// Spec risk callout (PB-B7): propagation MUST be union, not intersection.
// Dropping a marking silently under-protects the output. Tests assert
// set-union invariants explicitly.
// ---------------------------------------------------------------------------

/** Sort order-stable, duplicate-free union of every input. */
export function unionMarkings(...sources: Array<Iterable<string> | null | undefined>): string[] {
  const set = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const m of src) {
      if (typeof m !== "string") continue;
      const t = m.trim();
      if (t.length > 0) set.add(t);
    }
  }
  return Array.from(set).sort();
}

/** True when `required` ⊆ `possessed`. Used for deploy admission. */
export function userHasAllMarkings(
  required: Iterable<string>,
  possessed: Iterable<string>,
): boolean {
  const have = new Set<string>();
  for (const m of possessed) have.add(m);
  for (const m of required) {
    if (!have.has(m)) return false;
  }
  return true;
}

/**
 * Return the list of markings the user is MISSING from `required`.
 * Used to produce actionable MISSING_MARKING:<name> errors.
 */
export function missingMarkings(
  required: Iterable<string>,
  possessed: Iterable<string>,
): string[] {
  const have = new Set<string>();
  for (const m of possessed) have.add(m);
  const missing: string[] = [];
  for (const m of required) {
    if (!have.has(m)) missing.push(m);
  }
  return missing;
}
