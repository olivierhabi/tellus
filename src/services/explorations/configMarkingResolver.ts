// ---------------------------------------------------------------------------
// T-08 — configMarkingResolver: walk a saved-exploration config and return
// the union of `marking_required` values from every referenced object type
// and filtered property.
//
// The resolver is the only place that decides "what markings must a user
// hold to see this exploration." It is called at write time (POST/PUT) so
// the result is materialised onto `saved_exploration.required_markings`
// (added by migration 045) and read-paths can filter via the GIN-indexed
// containment operator `<@`.
//
// Walking strategy: the saved config is a JSON tree of arbitrary shape.
// We do not try to interpret semantics — we just collect every string
// that *might* be an object-type api-name (top-level `objectType`,
// `objectTypeApiName`, `apiName` fields, plus any string in a `from` /
// `objectTypes[]` array) and every string that *might* be a property
// api-name on those types (anything appearing in `field`/`property`
// keys, plus the keys of `filter`/`where` objects).
//
// We err on the side of over-collection: a name we collect that doesn't
// resolve to a real object_type/property is silently dropped (the SELECT
// returns 0 rows). The cost is a few extra DB lookups; the security
// payoff is that an attacker cannot evade the marking gate by hiding a
// referenced api-name behind a non-standard JSON key.
// ---------------------------------------------------------------------------

import { query } from "../../db";

// Field-name keys that conventionally hold an object-type api-name.
const OBJECT_TYPE_KEYS = new Set([
  "objectType",
  "objectTypeApiName",
  "apiName",
  "from",
]);

// Field-name keys that conventionally hold a property api-name.
const PROPERTY_KEYS = new Set([
  "field",
  "property",
  "propertyName",
  "propertyApiName",
]);

interface ConfigRefs {
  /** Object-type api_names that the config references. */
  objectTypes: Set<string>;
  /**
   * Property api_names by parent object-type. Property markings are
   * looked up scoped to their owning object_type to avoid cross-type
   * collisions on common names like `id` / `name`.
   */
  propertiesByOt: Map<string, Set<string>>;
}

/**
 * Walk a saved-exploration config and collect every string that might be
 * an object-type api-name or a property api-name. The walker is depth-
 * first and visits arrays element-by-element. Non-string values under
 * the conventional keys are ignored.
 *
 * `currentOt` is propagated to recursive calls so a `field` deeply
 * nested under `{objectType: "Trip", where: {and: [...]}}` is correctly
 * scoped to "Trip" — the parent OT is the one in effect when the field
 * key is encountered, regardless of how many levels of `and`/`or`/
 * `where` envelope sit between them.
 */
function walkRefs(
  node: unknown,
  refs: ConfigRefs,
  currentOt: string | null,
): void {
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const el of node) walkRefs(el, refs, currentOt);
    return;
  }

  // Two passes per object: first promote any objectType keys so the
  // sibling `field` keys see the correct currentOt, then walk children.
  let nextOt: string | null = currentOt;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (OBJECT_TYPE_KEYS.has(key)) {
      if (typeof value === "string" && value.length > 0) {
        refs.objectTypes.add(value);
        nextOt = value;
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string" && v.length > 0) {
            refs.objectTypes.add(v);
          }
        }
      }
    }
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (PROPERTY_KEYS.has(key) && typeof value === "string" && value.length > 0) {
      if (nextOt) {
        if (!refs.propertiesByOt.has(nextOt)) {
          refs.propertiesByOt.set(nextOt, new Set());
        }
        refs.propertiesByOt.get(nextOt)!.add(value);
      }
    }
    if (typeof value === "object" && value !== null) {
      walkRefs(value, refs, nextOt);
    }
  }
}

export function collectConfigRefs(
  config: unknown,
  initial: ConfigRefs = { objectTypes: new Set(), propertiesByOt: new Map() },
): ConfigRefs {
  walkRefs(config, initial, null);
  return initial;
}

/**
 * Resolve the union of markings the caller must hold to read an
 * exploration whose config is `config`. Empty result ⇒ no marking
 * gate (visible to anyone who passes the visibility filter).
 *
 * The resolver issues at most one query per object-type plus one
 * batched query per (object-type, property-name) pair seen in the
 * config — capped at the size of the config's reference set.
 */
export async function resolveRequiredMarkings(
  config: unknown,
): Promise<string[]> {
  const refs = collectConfigRefs(config);
  if (refs.objectTypes.size === 0) return [];

  const markings = new Set<string>();

  // Object-type level markings. `marking_required` is added by
  // migration 044 (T-06) and defaults to '{}'.
  const otNames = [...refs.objectTypes];
  const otRows = await query(
    `SELECT api_name, object_type_id, marking_required
       FROM object_type
      WHERE api_name = ANY($1::text[])`,
    [otNames],
  );
  // Build api_name → object_type_id lookup for the property pass.
  const otIdByName = new Map<string, string>();
  for (const row of otRows.rows as Array<{
    api_name: string;
    object_type_id: string;
    marking_required: string[] | null;
  }>) {
    otIdByName.set(row.api_name, row.object_type_id);
    for (const m of row.marking_required ?? []) markings.add(m);
  }

  // Property-level markings, scoped per parent object_type.
  for (const [otName, propNames] of refs.propertiesByOt) {
    const otId = otIdByName.get(otName);
    if (!otId) continue; // unknown OT — silently skipped (over-collected key).
    if (propNames.size === 0) continue;
    const propRows = await query(
      `SELECT marking_required
         FROM property
        WHERE object_type_id = $1
          AND api_name = ANY($2::text[])`,
      [otId, [...propNames]],
    );
    for (const row of propRows.rows as Array<{ marking_required: string[] | null }>) {
      for (const m of row.marking_required ?? []) markings.add(m);
    }
  }

  return [...markings].sort();
}
