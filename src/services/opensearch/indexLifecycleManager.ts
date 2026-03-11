// ---------------------------------------------------------------------------
// Index Lifecycle Manager
//
// Manages the lifecycle of OpenSearch indices — creating, deleting,
// recreating, updating mappings, checking existence, and retrieving stats.
//
// In Palantir's architecture, when you create an object type and register a
// backing datasource in Ontology Manager, the system automatically creates
// the corresponding index in Object Storage V2. When you add or modify
// properties, the index mapping is updated. When you delete an object type,
// the index is deleted. This module replicates that lifecycle management.
// ---------------------------------------------------------------------------

import { client } from "./client";
import {
  generateIndexMapping,
  getIndexName,
  IndexMappingResult,
} from "./indexMappingGenerator";
import { OpenSearchFieldMapping } from "../mapping/typeMapper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a successful createIndex() call. */
export interface CreateIndexResult {
  success: true;
  indexName: string;
  objectTypeApiName: string;
  propertyCount: number;
  createdAt: string;
}

/** Result of a successful deleteIndex() call. */
export interface DeleteIndexResult {
  success: true;
  indexName: string;
  message?: string;
  deletedAt?: string;
}

/** Result of recreateIndex() — extends CreateIndexResult with recreated flag. */
export interface RecreateIndexResult extends CreateIndexResult {
  recreated: true;
}

/** Result of updateMapping(). */
export interface UpdateMappingResult {
  success: true;
  indexName: string;
  addedProperties: string[];
  unchangedProperties: string[];
  changedProperties: string[];
  removedProperties: string[];
}

/** Result of indexExists(). */
export interface IndexExistsResult {
  exists: boolean;
  indexName: string;
}

/** Result of getIndexStats() when the index exists. */
export interface IndexStatsResult {
  indexName: string;
  exists: true;
  documentCount: number;
  storeSizeBytes: number;
  storeSizeHuman: string;
  lastRefreshTime: string | null;
}

/** Result of getIndexStats() when the index does not exist. */
export interface IndexStatsNotFound {
  indexName: string;
  exists: false;
}

// ---------------------------------------------------------------------------
// Helper: format bytes into human-readable size
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable string using binary units.
 * Uses 1024 as the divisor with one decimal place.
 *
 * Examples: "415 bytes", "4.2 KB", "1.3 MB", "2.0 GB"
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Helper: extract error message from unknown
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// 1. createIndex()
// ---------------------------------------------------------------------------

/**
 * Create a new OpenSearch index for the given object type.
 *
 * Generates the index mapping from PostgreSQL metadata, checks that the
 * index does not already exist, creates it, and verifies creation.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns A CreateIndexResult on success.
 * @throws Error if the index already exists, the object type is invalid,
 *         or the OpenSearch create call fails.
 */
async function createIndex(
  objectTypeApiName: string
): Promise<CreateIndexResult> {
  // Generate the full mapping from PostgreSQL metadata
  const mappingResult: IndexMappingResult =
    await generateIndexMapping(objectTypeApiName);
  const { indexName, mapping, propertyCount } = mappingResult;

  // Check if the index already exists
  const { body: exists } = await client.indices.exists({ index: indexName });

  if (exists) {
    throw new Error(
      `Index '${indexName}' already exists for object type '${objectTypeApiName}'. ` +
        `Use recreateIndex() to rebuild, or deleteIndex() first.`
    );
  }

  // Create the index with settings and mappings
  try {
    await client.indices.create({
      index: indexName,
      body: mapping as unknown as Record<string, unknown>,
    });
  } catch (err: unknown) {
    throw new Error(
      `Failed to create index '${indexName}' for object type '${objectTypeApiName}': ` +
        extractErrorMessage(err)
    );
  }

  // Verify creation by fetching the index
  try {
    await client.indices.get({ index: indexName });
  } catch (err: unknown) {
    throw new Error(
      `Index '${indexName}' was created but verification failed: ` +
        extractErrorMessage(err)
    );
  }

  console.log(
    `Created index '${indexName}' for object type '${objectTypeApiName}' with ${propertyCount} properties`
  );

  return {
    success: true,
    indexName,
    objectTypeApiName,
    propertyCount,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. deleteIndex()
// ---------------------------------------------------------------------------

/**
 * Delete the OpenSearch index for the given object type.
 *
 * Idempotent — deleting a non-existent index is not an error.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns A DeleteIndexResult.
 */
async function deleteIndex(
  objectTypeApiName: string
): Promise<DeleteIndexResult> {
  const indexName = getIndexName(objectTypeApiName);

  // Check if the index exists
  const { body: exists } = await client.indices.exists({ index: indexName });

  if (!exists) {
    return {
      success: true,
      indexName,
      message: `Index '${indexName}' does not exist, nothing to delete`,
    };
  }

  // Delete the index
  try {
    await client.indices.delete({ index: indexName });
  } catch (err: unknown) {
    throw new Error(
      `Failed to delete index '${indexName}': ${extractErrorMessage(err)}`
    );
  }

  console.log(
    `Deleted index '${indexName}' for object type '${objectTypeApiName}'`
  );

  return {
    success: true,
    indexName,
    deletedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 3. recreateIndex()
// ---------------------------------------------------------------------------

/**
 * Delete and recreate the index for the given object type.
 *
 * WARNING: This destroys all indexed data. The caller must re-index after
 * calling this function.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns A RecreateIndexResult.
 */
async function recreateIndex(
  objectTypeApiName: string
): Promise<RecreateIndexResult> {
  await deleteIndex(objectTypeApiName);
  const result = await createIndex(objectTypeApiName);

  console.warn(
    `WARNING: Recreated index '${result.indexName}' — all previously indexed data has been deleted. A full reindex is required.`
  );

  return {
    ...result,
    recreated: true,
  };
}

// ---------------------------------------------------------------------------
// 4. updateMapping()
// ---------------------------------------------------------------------------

/**
 * Add new fields to an existing index mapping without deleting data.
 *
 * OpenSearch allows adding new fields but does NOT allow modifying or
 * removing existing fields. Changed and removed properties are reported
 * in the result so the caller can decide whether a full recreate is needed.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns An UpdateMappingResult describing what changed.
 */
async function updateMapping(
  objectTypeApiName: string
): Promise<UpdateMappingResult> {
  // Generate the desired mapping from PostgreSQL metadata
  const mappingResult: IndexMappingResult =
    await generateIndexMapping(objectTypeApiName);
  const { indexName } = mappingResult;
  const desiredProperties = mappingResult.mapping.mappings.properties;

  // Verify the index exists
  const { body: exists } = await client.indices.exists({ index: indexName });

  if (!exists) {
    throw new Error(
      `Index '${indexName}' does not exist. Use createIndex() first.`
    );
  }

  // Get the existing mapping from OpenSearch
  const { body: existingMappingResponse } = await client.indices.getMapping({
    index: indexName,
  });

  // Extract existing properties — the response is keyed by index name
  const existingMapping = existingMappingResponse as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const indexMapping = existingMapping[indexName] as Record<string, unknown>;
  const mappingsBlock = (indexMapping.mappings ?? {}) as Record<
    string,
    unknown
  >;
  const existingProperties = (mappingsBlock.properties ?? {}) as Record<
    string,
    OpenSearchFieldMapping
  >;

  // Compare desired vs existing
  const addedProperties: string[] = [];
  const unchangedProperties: string[] = [];
  const changedProperties: string[] = [];
  const removedProperties: string[] = [];

  const newFields: Record<string, OpenSearchFieldMapping> = {};

  // Check desired properties against existing
  for (const [propName, desiredMapping] of Object.entries(desiredProperties)) {
    const existingMapping = existingProperties[propName];

    if (!existingMapping) {
      // New property — not in existing mapping
      addedProperties.push(propName);
      newFields[propName] = desiredMapping;
    } else if (
      JSON.stringify(desiredMapping) === JSON.stringify(existingMapping)
    ) {
      // Unchanged — same mapping
      unchangedProperties.push(propName);
    } else {
      // Changed — different mapping (cannot be updated in place)
      changedProperties.push(propName);
      console.warn(
        `Property '${propName}' mapping has changed. This requires recreateIndex() to take effect.`
      );
    }
  }

  // Check for removed properties (in existing but not in desired)
  for (const propName of Object.keys(existingProperties)) {
    if (!desiredProperties[propName]) {
      removedProperties.push(propName);
      console.warn(
        `Property '${propName}' has been removed from the object type but cannot be removed from the OpenSearch mapping. The field will remain in the index but will no longer be populated.`
      );
    }
  }

  // Add new fields if any
  if (addedProperties.length > 0) {
    try {
      await client.indices.putMapping({
        index: indexName,
        body: {
          properties: newFields,
        } as Record<string, unknown>,
      });

      console.log(
        `Updated mapping for index '${indexName}': added ${addedProperties.length} new field(s): ${addedProperties.join(", ")}`
      );
    } catch (err: unknown) {
      throw new Error(
        `Failed to update mapping for index '${indexName}': ${extractErrorMessage(err)}`
      );
    }
  }

  return {
    success: true,
    indexName,
    addedProperties,
    unchangedProperties,
    changedProperties,
    removedProperties,
  };
}

// ---------------------------------------------------------------------------
// 5. indexExists()
// ---------------------------------------------------------------------------

/**
 * Check whether the OpenSearch index for the given object type exists.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns An IndexExistsResult.
 */
async function indexExists(
  objectTypeApiName: string
): Promise<IndexExistsResult> {
  const indexName = getIndexName(objectTypeApiName);

  const { body: exists } = await client.indices.exists({ index: indexName });

  return {
    exists: Boolean(exists),
    indexName,
  };
}

// ---------------------------------------------------------------------------
// 6. getIndexStats()
// ---------------------------------------------------------------------------

/**
 * Return statistics about the OpenSearch index for the given object type.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @returns IndexStatsResult if the index exists, IndexStatsNotFound otherwise.
 * @throws Error if OpenSearch is unreachable.
 */
async function getIndexStats(
  objectTypeApiName: string
): Promise<IndexStatsResult | IndexStatsNotFound> {
  const indexName = getIndexName(objectTypeApiName);

  // Check if the index exists first
  let exists: boolean;
  try {
    const result = await client.indices.exists({ index: indexName });
    exists = Boolean(result.body);
  } catch (err: unknown) {
    throw new Error(
      `Failed to check index '${indexName}' existence: ${extractErrorMessage(err)}`
    );
  }

  if (!exists) {
    return { indexName, exists: false };
  }

  // Get the index stats
  try {
    const { body } = await client.indices.stats({ index: indexName });

    const stats = body as unknown as Record<string, unknown>;
    const allStats = stats._all as Record<string, unknown>;
    const primaries = allStats.primaries as Record<string, unknown>;
    const docs = primaries.docs as Record<string, unknown>;
    const store = primaries.store as Record<string, unknown>;
    const refresh = primaries.refresh as Record<string, unknown> | undefined;

    const storeSizeBytes = (store.size_in_bytes as number) ?? 0;
    const documentCount = (docs.count as number) ?? 0;

    // Extract last refresh time if available
    let lastRefreshTime: string | null = null;
    if (refresh && typeof refresh.external_total_time_in_millis === "number") {
      // The refresh stats don't include an absolute timestamp — use
      // external_total as a relative indicator. We'll report null if
      // not meaningfully available.
      lastRefreshTime = null;
    }

    return {
      indexName,
      exists: true,
      documentCount,
      storeSizeBytes,
      storeSizeHuman: formatBytes(storeSizeBytes),
      lastRefreshTime,
    };
  } catch (err: unknown) {
    throw new Error(
      `Failed to retrieve stats for index '${indexName}': ${extractErrorMessage(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Re-export getIndexName from indexMappingGenerator (canonical source)
// ---------------------------------------------------------------------------

export { getIndexName } from "./indexMappingGenerator";

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  createIndex,
  deleteIndex,
  recreateIndex,
  updateMapping,
  indexExists,
  getIndexStats,
};

export default {
  createIndex,
  deleteIndex,
  recreateIndex,
  updateMapping,
  indexExists,
  getIndexStats,
  getIndexName,
};
