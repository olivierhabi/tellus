// ---------------------------------------------------------------------------
// B3 — PostgreSQL OID -> Tellus dataset type mapping (spec §B3 line 139).
//
// Foundry parity: the same OID-to-logical-type table v1 shipped, kept in
// sync so dataset schemas round-trip 1:1 between Magritte (v1) and the
// Node connector (v2).
//
// Tellus logical types (subset shared with Iceberg):
//   - boolean, int16, int32, int64, float32, float64
//   - decimal(precision, scale)   (numeric in PG)
//   - string, binary (bytea)
//   - date, time, timestamp, timestamp_tz
//   - interval (ISO-8601 string)
//   - uuid, json, xml
//   - array<element>              (PG _<elem> OID; element resolved
//                                  recursively)
//   - tstzrange (structured)
// Unknown OIDs map to `string` with a WARN-tagged result.
// ---------------------------------------------------------------------------

export interface TellusType {
  /** Canonical logical type name. */
  name: string;
  /** Numeric precision for decimals, max length for varchar, etc. */
  precision?: number;
  scale?: number;
  /** For array<T>, the element TellusType. */
  element?: TellusType;
  /** Set when the mapping fell back to a default because the OID is unknown. */
  warn?: string;
}

// PostgreSQL OIDs (pg_type.dat). Only the scalars Tellus supports natively.
const SCALARS: Record<number, TellusType> = {
  16: { name: "boolean" }, // bool
  20: { name: "int64" }, // int8
  21: { name: "int16" }, // int2
  23: { name: "int32" }, // int4
  25: { name: "string" }, // text
  17: { name: "binary" }, // bytea
  700: { name: "float32" }, // float4
  701: { name: "float64" }, // float8
  1042: { name: "string" }, // bpchar
  1043: { name: "string" }, // varchar
  1082: { name: "date" }, // date
  1083: { name: "time" }, // time
  1114: { name: "timestamp" }, // timestamp
  1184: { name: "timestamp_tz" }, // timestamptz
  1186: { name: "interval" }, // interval
  2950: { name: "uuid" }, // uuid
  114: { name: "json" }, // json
  3802: { name: "json" }, // jsonb (Tellus collapses to json logical type)
  142: { name: "xml" }, // xml
  3910: { name: "tstzrange" }, // tstzrange
};

// Array OID -> element OID. Source: pg_type.dat (subset).
const ARRAY_TO_ELEMENT: Record<number, number> = {
  1000: 16,
  1005: 21,
  1007: 23,
  1016: 20,
  1009: 25,
  1015: 1043,
  1014: 1042,
  1021: 700,
  1022: 701,
  1115: 1114,
  1182: 1082,
  1183: 1083,
  1185: 1184,
  1187: 1186,
  1231: 1700,
  2951: 2950,
  199: 114,
  3807: 3802,
  143: 142,
  3911: 3910,
  1001: 17,
};

/**
 * Map a PG OID to a Tellus logical type. `typmod` carries precision/scale for
 * `numeric`. Pass `numericTypmod=-1` if unknown.
 */
export function mapOidToTellus(
  oid: number,
  numericTypmod = -1,
): TellusType {
  if (oid === 1700) {
    if (numericTypmod === -1) {
      return { name: "decimal", precision: 38, scale: 9 };
    }
    // Decoded per PG: ((typmod - 4) >> 16) = precision, ((typmod - 4) & 0xffff) = scale.
    const adj = numericTypmod - 4;
    const precision = Math.min(38, (adj >> 16) & 0xffff);
    const scale = adj & 0xffff;
    return { name: "decimal", precision, scale };
  }
  const elementOid = ARRAY_TO_ELEMENT[oid];
  if (elementOid !== undefined) {
    return {
      name: "array",
      element: mapOidToTellus(elementOid, numericTypmod),
    };
  }
  const scalar = SCALARS[oid];
  if (scalar) return { ...scalar };
  return { name: "string", warn: `unknown PG OID ${oid}, fell back to string` };
}

/** Inverse for symmetry / introspection tests. */
export function describeMapping(oid: number): {
  pgOid: number;
  tellus: TellusType;
} {
  return { pgOid: oid, tellus: mapOidToTellus(oid) };
}

// ---------------------------------------------------------------------------
// String-based mapping used by B10 ontology suggest. Consumes the formatted
// pg type (e.g. `integer`, `character varying(64)`, `numeric(38,9)`, `_int4`)
// and returns the Tellus ontology property type. Falls back to "string" on
// any unrecognised input.
// ---------------------------------------------------------------------------

const PG_NAME_TO_TELLUS: Record<string, string> = {
  bool: "boolean",
  boolean: "boolean",
  int2: "integer",
  smallint: "integer",
  int4: "integer",
  integer: "integer",
  int: "integer",
  int8: "long",
  bigint: "long",
  float4: "double",
  real: "double",
  float8: "double",
  "double precision": "double",
  numeric: "decimal",
  decimal: "decimal",
  text: "string",
  varchar: "string",
  "character varying": "string",
  bpchar: "string",
  character: "string",
  uuid: "string",
  date: "date",
  time: "string",
  timestamp: "timestamp",
  "timestamp without time zone": "timestamp",
  timestamptz: "timestamp",
  "timestamp with time zone": "timestamp",
  bytea: "binary",
  json: "string",
  jsonb: "string",
  xml: "string",
  interval: "string",
};

export function mapPgTypeToProperty(pgType: string): string {
  if (!pgType) return "string";
  const trimmed = pgType.trim().toLowerCase();
  // strip width / precision parens — `varchar(64)` -> `varchar`
  const base = trimmed.replace(/\s*\(.*\)\s*$/, "").trim();
  // arrays — `_int4` or `integer[]` -> array
  if (base.startsWith("_") || base.endsWith("[]")) return "array";
  return PG_NAME_TO_TELLUS[base] ?? "string";
}

