// ---------------------------------------------------------------------------
// interfacePropertyCompat.ts — base-type compatibility matrix for interface
// implementation mappings.
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 8:
//   "Property type compatibility validation on implementation mapping
//    (String→String OK, Integer→String FAIL → 400 INCOMPATIBLE_PROPERTY_TYPE)."
//
// A concrete object type's property is mapped onto an interface property.
// The mapping is accepted only when the object property's base type can
// safely be treated as the interface property's base type. We use a
// directed compatibility graph: `from → to`. For numeric types we allow
// widening conversions (Integer → Long, Integer → Double, …). For String
// we accept an exact match and a few obvious narrowing coercions.
// ---------------------------------------------------------------------------

import { OntologyError } from "../utils/queryErrors";

const COMPAT: Record<string, Set<string>> = {
  string: new Set(["string"]),
  boolean: new Set(["boolean"]),
  integer: new Set(["integer", "long", "double", "float"]),
  long: new Set(["long", "double"]),
  float: new Set(["float", "double"]),
  double: new Set(["double"]),
  byte: new Set(["byte", "short", "integer", "long", "double"]),
  short: new Set(["short", "integer", "long", "double"]),
  decimal: new Set(["decimal", "double"]),
  date: new Set(["date", "timestamp"]),
  timestamp: new Set(["timestamp"]),
  geopoint: new Set(["geopoint"]),
  geoshape: new Set(["geoshape"]),
  struct: new Set(["struct"]),
  // Array types only compose with themselves
  string_array: new Set(["string_array"]),
  integer_array: new Set(["integer_array", "long_array"]),
  long_array: new Set(["long_array"]),
  double_array: new Set(["double_array"]),
  boolean_array: new Set(["boolean_array"]),
  timestamp_array: new Set(["timestamp_array"]),
};

/**
 * Verify that `from` can be mapped onto `to`. Throws
 * INCOMPATIBLE_PROPERTY_TYPE with both types in `parameters` on failure.
 */
export function assertPropertyTypeCompatible(
  from: string,
  to: string,
  context: { objectType?: string; interfaceProperty?: string } = {}
): void {
  const src = (from || "").toLowerCase();
  const dst = (to || "").toLowerCase();
  const allowed = COMPAT[src];
  if (!allowed || !allowed.has(dst)) {
    throw new OntologyError(
      `Property base type '${from}' cannot be mapped onto '${to}'.`,
      "INCOMPATIBLE_PROPERTY_TYPE",
      400,
      { from, to, ...context }
    );
  }
}
