// ---------------------------------------------------------------------------
// Quickwit Doc Mapping Generator — Task B6
//
// Builds a Quickwit index doc-mapping from an Object Type's property
// definitions. The mapping is the JSON body Quickwit's metastore expects
// when creating an index (POST /api/v1/indexes).
//
// Property-flag contract (per Palantir's Object Type editor, mirrored in
// tellus' `property` table):
//
//   searchable=true   → fast=false, indexed=true,  stored=true
//   sortable=true     → fast=true
//   filterable=true   → indexed=true
//
// Base-type mapping (contract from B6 spec):
//
//   string      → text      (tokenizer=default)
//   integer     → i64
//   long        → i64
//   double      → f64
//   float       → f64
//   boolean     → bool
//   date        → datetime  (rfc3339, output=unix_timestamp_millis)
//   timestamp   → datetime  (rfc3339, output=unix_timestamp_millis)
//   geopoint    → LatLng    (Quickwit's bespoke geo type)
//
// Every index also carries three system fields:
//   __pk          (primary key, fast+indexed, keyword-like text)
//   __version     (i64 — monotonic per-PK counter)
//   __deleted     (bool — tombstone, filterable so DELETEs disappear at
//                  query time *before* Quickwit's merge-policy purges them)
//
// Immutable: a deep copy is returned so callers can mutate freely.
// ---------------------------------------------------------------------------

export interface PropertyFlags {
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
}

export interface QuickwitPropertyInput {
  api_name: string;
  base_type: string;
  is_array?: boolean;
  is_required?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
}

export interface QuickwitFieldMapping {
  name: string;
  type: string;
  fast?: boolean;
  indexed?: boolean;
  stored?: boolean;
  tokenizer?: string;
  input_format?: string;
  output_format?: string;
  fast_precision?: string;
}

export interface QuickwitDocMapping {
  doc_mapping_uid?: string;
  mode: "dynamic" | "strict" | "lenient";
  field_mappings: QuickwitFieldMapping[];
  timestamp_field?: string;
  tag_fields?: string[];
  store_source: boolean;
}

export interface QuickwitIndexConfig {
  version: string;
  index_id: string;
  doc_mapping: QuickwitDocMapping;
  indexing_settings: {
    commit_timeout_secs: number;
    merge_policy:
      | {
          type: "limit_merge";
          max_merge_ops: number;
          merge_factor: number;
          max_merge_factor: number;
        }
      | {
          type: "stable_log";
          min_level_num_docs: number;
          merge_factor: number;
          max_merge_factor: number;
          maturation_period: string;
        };
  };
  search_settings: {
    default_search_fields: string[];
  };
  retention?: {
    period: string;
    schedule: string;
  };
}

export interface BuildIndexConfigInput {
  objectTypeApiName: string;
  properties: QuickwitPropertyInput[];
  primaryKeyApiName: string;
  timestampPropertyApiName?: string;
  commitTimeoutSecs?: number;
}

// ---------------------------------------------------------------------------
// Type map
// ---------------------------------------------------------------------------

const BASE_TYPE_TO_QUICKWIT: Record<string, string> = {
  string: "text",
  boolean: "bool",
  integer: "i64",
  long: "i64",
  short: "i64",
  byte: "i64",
  double: "f64",
  float: "f64",
  decimal: "f64",
  date: "datetime",
  timestamp: "datetime",
  geopoint: "LatLng",
  // Arrays are expressed as the element type with the array flag; Quickwit
  // represents arrays natively via the same mapping (cardinality is inferred).
  string_array: "text",
  integer_array: "i64",
  double_array: "f64",
  boolean_array: "bool",
  timestamp_array: "datetime",
};

// ---------------------------------------------------------------------------
// Index-name convention: ot_<sanitized api name>
// ---------------------------------------------------------------------------

/**
 * Quickwit index id. Lowercased and non-alphanumeric collapsed to `-`
 * (Quickwit accepts `[a-z0-9_-]+` in index ids).
 */
export function getQuickwitIndexId(objectTypeApiName: string): string {
  const sanitized = objectTypeApiName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ot_${sanitized}`;
}

// ---------------------------------------------------------------------------
// buildFieldMapping() — one property → one Quickwit field
// ---------------------------------------------------------------------------

export function buildFieldMapping(prop: QuickwitPropertyInput): QuickwitFieldMapping {
  const baseType = BASE_TYPE_TO_QUICKWIT[prop.base_type];
  if (!baseType) {
    throw new Error(
      `Unsupported base_type for Quickwit mapping: "${prop.base_type}" ` +
        `(property ${prop.api_name})`
    );
  }

  const searchable = prop.searchable !== false;
  const sortable = prop.sortable === true;
  const filterable = prop.filterable !== false;

  // Palantir's flag-to-storage contract (see header). `fast=true` must win
  // whenever sortable is on, because sort requires a columnar column store.
  // `stored=true` is kept for searchable fields so the search path can
  // hydrate documents without a secondary fetch.
  const fast = sortable;
  const indexed = searchable || filterable;
  const stored = searchable;

  const mapping: QuickwitFieldMapping = {
    name: prop.api_name,
    type: baseType,
    fast,
    indexed,
    stored,
  };

  if (baseType === "text") {
    mapping.tokenizer = "default";
  }
  if (baseType === "datetime") {
    mapping.input_format = "rfc3339";
    mapping.output_format = "unix_timestamp_millis";
    if (fast) mapping.fast_precision = "milliseconds";
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// System fields — appended to every Object Type's index
// ---------------------------------------------------------------------------

function systemFields(pkApiName: string): QuickwitFieldMapping[] {
  return [
    {
      name: "__pk",
      type: "text",
      tokenizer: "raw",
      fast: true,
      indexed: true,
      stored: true,
    },
    {
      name: "__version",
      type: "i64",
      fast: true,
      indexed: true,
      stored: true,
    },
    {
      name: "__deleted",
      type: "bool",
      fast: true,
      indexed: true,
      stored: true,
    },
    {
      name: "__object_type",
      type: "text",
      tokenizer: "raw",
      fast: true,
      indexed: true,
      stored: true,
    },
    // Pin the PK api-name-field too so callers can filter by the actual
    // property name (not just `__pk`). If the PK is already in the user
    // property list we let the user field win — it's added below.
    { name: `__pk_${pkApiName}`, type: "text", tokenizer: "raw", fast: true, indexed: true, stored: true },
  ];
}

// ---------------------------------------------------------------------------
// buildIndexConfig() — full Quickwit index config JSON
// ---------------------------------------------------------------------------

export function buildIndexConfig(input: BuildIndexConfigInput): QuickwitIndexConfig {
  if (!input.properties.some((p) => p.api_name === input.primaryKeyApiName)) {
    throw new Error(
      `Primary key property "${input.primaryKeyApiName}" not present in properties`
    );
  }

  const userFields = input.properties.map(buildFieldMapping);
  const systemNames = new Set(systemFields(input.primaryKeyApiName).map((f) => f.name));
  const dedupedUserFields = userFields.filter((f) => !systemNames.has(f.name));

  const fields = [...systemFields(input.primaryKeyApiName), ...dedupedUserFields];

  // Pick searchable text fields as default_search_fields so bare
  // search-string queries hit the text index.
  const defaultSearchFields = dedupedUserFields
    .filter((f) => f.type === "text" && f.indexed && f.tokenizer !== "raw")
    .map((f) => f.name);

  const docMapping: QuickwitDocMapping = {
    mode: "strict",
    field_mappings: fields,
    store_source: true,
  };
  if (input.timestampPropertyApiName) {
    docMapping.timestamp_field = input.timestampPropertyApiName;
  }

  return {
    version: "0.8",
    index_id: getQuickwitIndexId(input.objectTypeApiName),
    doc_mapping: docMapping,
    indexing_settings: {
      // B6 spec: commit_timeout_secs=60 for interactive freshness.
      commit_timeout_secs: input.commitTimeoutSecs ?? 60,
      // B6 spec: compact splits under 10M docs into mature splits of ~10M
      // docs. Quickwit's `stable_log` policy takes a per-level target doc
      // count; a level's splits graduate to the next level once their
      // combined doc count crosses `min_level_num_docs`, so 10M matches
      // the spec threshold directly. The maturation period caps a split's
      // lifetime at the level below so recently-committed documents stay
      // on small splits until compaction.
      merge_policy: {
        type: "stable_log",
        min_level_num_docs: 10_000_000,
        merge_factor: 10,
        max_merge_factor: 12,
        maturation_period: "2days",
      },
    },
    search_settings: {
      default_search_fields: defaultSearchFields,
    },
  };
}
