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
  number_of_shards: 1,
  number_of_replicas: 0,
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
    return `ontology-${ontSlug}-${slug}`;
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
  return `ontology-${slug}`;
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
  objectTypeApiName: string
): Promise<IndexMappingResult> {
  // -----------------------------------------------------------------------
  // 1. Fetch the object type from PostgreSQL
  // -----------------------------------------------------------------------
  const otResult = await query(
    "SELECT * FROM object_type WHERE api_name = $1",
    [objectTypeApiName]
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

    fieldMappings[prop.api_name] = mapPropertyToOpenSearch(propertyInput);
  }

  // -----------------------------------------------------------------------
  // 5. Assemble the complete index creation request body
  // -----------------------------------------------------------------------
  const indexName = getIndexName(objectTypeApiName);

  const mapping: IndexMappingDocument = {
    settings: { ...DEFAULT_INDEX_SETTINGS },
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
