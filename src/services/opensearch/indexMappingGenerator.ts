// ---------------------------------------------------------------------------
// Index Mapping Generator
//
// Takes a complete object type definition (from PostgreSQL — the object type
// metadata plus all its properties) and generates a complete OpenSearch index
// mapping document. This is the document sent to OpenSearch's PUT /{index}
// API to create the index with the correct schema.
//
// In Palantir's Object Storage V2, when you create an object type and
// register a backing datasource, the system automatically generates the
// index mapping and creates (or updates) the corresponding index. This
// module replicates that automatic mapping generation.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { objectIndexPrefix } from "../../config/environmentIdentity";
import {
  mapPropertyToOpenSearch,
  PropertyInput,
  OpenSearchFieldMapping,
} from "../mapping/typeMapper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** System fields appended to every OpenSearch index mapping. */
interface SystemFields {
  __pk: OpenSearchFieldMapping;
  /** Owning ontology. Mandatory v2 isolation predicate. */
  __ontology: OpenSearchFieldMapping;
  /**
   * Phase 2 (OSSv2 parity): stable object rid
   * (`ri.tellus.main.object.<uuid>`). `keyword` so `static` ObjectSet
   * nodes and rid-lookups use O(1) `terms` queries.
   */
  __rid: OpenSearchFieldMapping;
  __objectType: OpenSearchFieldMapping;
  __lastModified: OpenSearchFieldMapping;
  __version: OpenSearchFieldMapping;
  __editedBy: OpenSearchFieldMapping;
  __datasourceVersion: OpenSearchFieldMapping;
  /**
   * F-P3-13: branch this document belongs to. `keyword` so the
   * security filter can use `term` for O(1) lookups. Documents
   * indexed before this mapping was added will be missing the
   * field; the security filter's transitional OR clause
   * (`exists: __branch` must be false) keeps them visible until a
   * reindex pass (tracked under F-P3-15) stamps every legacy doc.
   */
  __branch: OpenSearchFieldMapping;
}

/** The complete index settings block. */
interface IndexSettings {
  "index.knn"?: boolean;
  number_of_shards: number;
  number_of_replicas: number;
  refresh_interval: string;
  max_result_window: number;
  analysis: {
    analyzer: {
      default: {
        type: string;
      };
    };
  };
}

/** The full OpenSearch index creation request body. */
export interface IndexMappingDocument {
  settings: IndexSettings;
  mappings: {
    properties: Record<string, OpenSearchFieldMapping>;
  };
}

/** The result object returned by generateIndexMapping(). */
export interface IndexMappingResult {
  indexName: string;
  objectTypeApiName: string;
  propertyCount: number;
  mapping: IndexMappingDocument;
  systemFields: string[];
  primaryKeyProperty: string;
  primaryKeyOpenSearchType: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** System field names, in order. */
const SYSTEM_FIELD_NAMES: readonly string[] = [
  "__pk",
  "__ontology",
  "__rid",
  "__objectType",
  "__lastModified",
  "__version",
  "__editedBy",
  "__datasourceVersion",
  "__branch",
] as const;

/** System field mappings — always present on every indexed object. */
const SYSTEM_FIELD_MAPPINGS: SystemFields = {
  // Primary key value — always keyword for exact-match lookups
  __pk: { type: "keyword" },
  // Owning ontology — keyword for mandatory isolation filters
  __ontology: { type: "keyword" },
  // Stable object rid — keyword for exact-match `static` set lookups
  __rid: { type: "keyword" },
  // API name of the object type — keyword for cross-index queries
  __objectType: { type: "keyword" },
  // Timestamp when this object was last indexed or edited
  __lastModified: { type: "date" },
  // Monotonically increasing version for optimistic concurrency control
  __version: { type: "long" },
  // User ID of the last editor via an action (null if never edited)
  __editedBy: { type: "keyword" },
  // Transaction ID of the backing datasource version
  __datasourceVersion: { type: "keyword" },
  // F-P3-13: branch UUID this document belongs to.
  __branch: { type: "keyword" },
};

/** Default index settings for development. */
const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  // Env-tunable (see templateRegistry.ts DEFAULT_TEMPLATE_SETTINGS): 4 shards
  // parallelise bulk indexing for large OTs (OlivierOrder2 5.6M). Prod = 1.
  number_of_shards: Number(process.env.OS_INDEX_SHARDS ?? "1"),
  // Env-tunable (see templateRegistry.ts DEFAULT_TEMPLATE_SETTINGS): 0 replicas
  // for single-node dev. Prod must set OS_INDEX_REPLICAS >= 1 once a multi-node
  // cluster exists. MUST match templateRegistry.ts (same env var) — drift
  // diverges template-created vs explicitly-created indices.
  number_of_replicas: Number(process.env.OS_INDEX_REPLICAS ?? "0"),
  refresh_interval: "1s",
  max_result_window: 100000,
  analysis: {
    analyzer: {
      default: {
        type: "standard",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Size-aware shard resolution
//
// A single-shard index is a single indexing pipeline — it caps bulk
// throughput regardless of client-side concurrency. For large OTs (multi-
// million rows) we want OS_INDEX_SHARDS_LARGE (default 4) shards so
// concurrent _bulk requests actually parallelise across indexing threads.
// Small OTs stay at OS_INDEX_SHARDS (default 1) — sharding a 746-row OT
// only adds per-shard overhead.
//
// The row count comes from `backing_datasource.row_count` (stamped at
// registration) with a fallback to a live `object_instances` count. Both
// `generateIndexMapping` (create path) and `verifyIndexShardCount`
// (existing-index guard) resolve through the SAME function so the guard
// can never disagree with the creator.
// ---------------------------------------------------------------------------

const LARGE_OT_ROW_THRESHOLD = Number(
  process.env.OS_LARGE_OT_ROWS ?? "1000000",
);

/** Pure: shard count for a given expected row count. */
export function resolveShardCount(rowCount: number): number {
  const small = Number(process.env.OS_INDEX_SHARDS ?? "1");
  const large = Number(process.env.OS_INDEX_SHARDS_LARGE ?? "4");
  return rowCount >= LARGE_OT_ROW_THRESHOLD ? large : small;
}

/**
 * Expected shard count for an object type, resolved from its backing
 * datasource row_count (fallback: live object_instances count; fallback: 0
 * → small). Best-effort — on any lookup error returns the small default so
 * index creation never fails on a metadata hiccup.
 */
export async function expectedShardCountForObjectType(
  objectTypeApiName: string,
): Promise<number> {
  try {
    const res = await query(
      `SELECT COALESCE(
         (SELECT bd.row_count
            FROM backing_datasource bd
            JOIN object_type ot ON ot.object_type_id = bd.object_type_id
           WHERE ot.api_name = $1
           ORDER BY bd.registered_at DESC LIMIT 1),
         (SELECT count(*) FROM object_instances
           WHERE object_type_api_name = $1)
       ) AS row_count`,
      [objectTypeApiName],
    );
    return resolveShardCount(Number(res.rows[0]?.row_count ?? 0));
  } catch {
    return resolveShardCount(0);
  }
}

// ---------------------------------------------------------------------------
// getIndexName()
// ---------------------------------------------------------------------------

/**
 * Compute the OpenSearch index name from an object type API name.
 *
 * This is the **canonical source** for index name computation — all modules
 * must import this function rather than re-implementing the logic.
 *
 * Rules:
 *   - Prefix: "ontology-"
 *   - API name lowercased
 *   - Non-alphanumeric characters (except dash) replaced with dash
 *
 * Examples:
 *   "Employee"       -> "ontology-employee"
 *   "FlightSchedule" -> "ontology-flightschedule"
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns The OpenSearch index name.
 */
export function getIndexName(
  objectTypeApiName: string,
  ontologyId?: string,
): string {
  // F-P5-03 (P0) closure: tenant-scoped index names.
  //
  // Legacy signature `getIndexName(name)` returned "ontology-${name}" which
  // collided across tenants — two ontologies each defining an `Employee`
  // object type would share the same OpenSearch index, violating tenant
  // isolation.
  //
  // New signature accepts an optional ontologyId; when passed, the index
  // name is "ontology-${ontologyId}-${name}". The legacy path is kept so
  // existing callers keep compiling; each legacy call emits a Prometheus
  // counter (tellus_index_name_missing_tenant_total) so operators can
  // track the migration cliff. Once all callers thread ontologyId, the
  // second parameter will become required in a future release and the
  // legacy fallback removed.
  const slug = objectTypeApiName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (ontologyId !== undefined && ontologyId !== null && ontologyId !== "") {
    const ontSlug = ontologyId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return `${objectIndexPrefix()}${ontSlug}-${slug}`;
  }
  // Legacy fallback — logged as missing-tenant. Callers should be updated.
  // Import lazily to avoid cyclic init when indexMappingGenerator is
  // imported during tests that do not have the metrics module wired.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { incCounter } = require("../funnel/metrics") as {
      incCounter: (name: string, labels: Record<string, string>) => void;
    };
    incCounter("tellus_index_name_missing_tenant_total", {
      object_type: objectTypeApiName,
    });
  } catch {
    // Metrics not loaded yet — silent during early boot is acceptable.
  }
  return `${objectIndexPrefix()}${slug}`;
}

// ---------------------------------------------------------------------------
// generateIndexMapping()
// ---------------------------------------------------------------------------

/**
 * Generate a complete OpenSearch index creation request body for the given
 * object type. Fetches metadata and properties from PostgreSQL, maps every
 * property through the type mapper, and assembles the full mapping document
 * with system fields and index settings.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns An IndexMappingResult containing the index name, mapping document,
 *          and metadata about the generated mapping.
 * @throws Error if the object type is not found, has no properties, or has
 *         no primary key configured.
 */
export async function generateIndexMapping(
  objectTypeApiName: string,
  ontologyId?: string,
): Promise<IndexMappingResult> {
  // -----------------------------------------------------------------------
  // 1. Fetch the object type from PostgreSQL
  // -----------------------------------------------------------------------
  const otResult = await query(
    `SELECT *
       FROM object_type
      WHERE api_name = $1
        AND ($2::uuid IS NULL OR ontology_id = $2::uuid)
      ORDER BY ontology_id`,
    [objectTypeApiName, ontologyId ?? null]
  );

  if (otResult.rows.length === 0) {
    throw new Error(
      `Object type '${objectTypeApiName}' not found in metadata store`
    );
  }

  const objectType = otResult.rows[0];

  // -----------------------------------------------------------------------
  // 2. Fetch all properties for this object type, ordered by ordinal
  // -----------------------------------------------------------------------
  const propsResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal ASC, api_name ASC",
    [objectType.object_type_id]
  );

  if (propsResult.rows.length === 0) {
    throw new Error(
      `Object type '${objectTypeApiName}' has no properties defined`
    );
  }

  const properties = propsResult.rows;
  const embeddingResult = await query(
    `SELECT property_api_name, dimensions
       FROM ontology_embedding_config
      WHERE ontology_id = $1
        AND object_type_api_name = $2
        AND enabled = true`,
    [objectType.ontology_id, objectTypeApiName],
  );
  const embeddingDimensions = new Map<string, number>(
    embeddingResult.rows.map((row) => [
      String(row.property_api_name),
      Number(row.dimensions),
    ]),
  );

  // -----------------------------------------------------------------------
  // 3. Verify the primary key property exists
  // -----------------------------------------------------------------------
  if (!objectType.primary_key_property_id) {
    throw new Error(
      `Object type '${objectTypeApiName}' has no primary key property configured`
    );
  }

  const pkProperty = properties.find(
    (p: Record<string, unknown>) =>
      p.property_id === objectType.primary_key_property_id
  );

  if (!pkProperty) {
    throw new Error(
      `Object type '${objectTypeApiName}' has no primary key property configured`
    );
  }

  // -----------------------------------------------------------------------
  // 4. Build OpenSearch mappings from all properties
  // -----------------------------------------------------------------------
  const fieldMappings: Record<string, OpenSearchFieldMapping> = {};

  // Add system fields first
  for (const fieldName of SYSTEM_FIELD_NAMES) {
    fieldMappings[fieldName] =
      SYSTEM_FIELD_MAPPINGS[fieldName as keyof SystemFields];
  }

  // Add user-defined property mappings
  for (const prop of properties) {
    const propertyInput: PropertyInput = {
      api_name: prop.api_name,
      base_type: prop.base_type,
      is_array: prop.is_array,
      is_required: prop.is_required,
      struct_schema: prop.struct_schema ?? null,
    };

    const dimensions = embeddingDimensions.get(String(prop.api_name));
    fieldMappings[prop.api_name] =
      dimensions && dimensions > 0
        ? ({
            type: "knn_vector",
            dimension: dimensions,
            method: {
              name: "hnsw",
              space_type: "l2",
              engine: "lucene",
            },
          } as unknown as OpenSearchFieldMapping)
        : mapPropertyToOpenSearch(propertyInput);
  }

  // -----------------------------------------------------------------------
  // 5. Assemble the complete index creation request body
  // -----------------------------------------------------------------------
  const indexName = getIndexName(objectTypeApiName);

  // Size-aware shards: large OTs get OS_INDEX_SHARDS_LARGE so bulk
  // indexing parallelises across shards (see resolveShardCount above).
  const numberOfShards = await expectedShardCountForObjectType(
    objectTypeApiName,
  );

  const mapping: IndexMappingDocument = {
    settings: {
      ...DEFAULT_INDEX_SETTINGS,
      number_of_shards: numberOfShards,
      ...(embeddingDimensions.size > 0 ? { "index.knn": true } : {}),
    },
    mappings: {
      properties: fieldMappings,
    },
  };

  return {
    indexName,
    objectTypeApiName,
    propertyCount: properties.length,
    mapping,
    systemFields: [...SYSTEM_FIELD_NAMES],
    primaryKeyProperty: pkProperty.api_name as string,
    primaryKeyOpenSearchType: "keyword",
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { generateIndexMapping, getIndexName };
