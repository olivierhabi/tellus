// ---------------------------------------------------------------------------
// Object Existence Checker
//
// Utility module that checks whether objects exist in the Ontology
// (OpenSearch). Used by both the parameter validator (for object_reference
// parameters) and the rule compiler (for modifyObject/deleteObject rules).
//
// ERROR HANDLING IS CRITICAL: The difference between "object doesn't exist"
// and "I couldn't check because OpenSearch is down" must be clear. If
// OpenSearch is unreachable, every function THROWS an error — never returns
// false/null. Returning false when the check failed would allow actions to
// proceed incorrectly (e.g., creating a duplicate object because we
// couldn't detect the existing one).
//
// Palantir documents specific failure types:
//   - Creating an object with a PK that already exists → "duplicate_primary_key"
//   - Modifying an object that doesn't exist → "object_not_found"
//   - Deleting an object that doesn't exist → "object_not_found"
// ---------------------------------------------------------------------------

import { client as opensearchClient } from "../services/opensearch/client";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { query } from "../db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of IDs per _mget request. */
const MGET_BATCH_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an OpenSearch error is a "not found" (index or
 * document does not exist) vs a real connection/server error.
 *
 * Returns true if the error represents a 404 (not found), meaning the
 * object or index simply does not exist. Returns false for all other
 * errors, which should be propagated to the caller.
 */
function isNotFoundError(err: any): boolean {
  // The OpenSearch client attaches meta info with statusCode
  const statusCode = err?.meta?.statusCode ?? err?.statusCode;
  if (statusCode === 404) return true;

  // Some client versions use a body with status field
  if (err?.body?.status === 404) return true;

  return false;
}

/** Split an array into chunks of a given size. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 1. objectExists — Check if a single object exists
// ---------------------------------------------------------------------------

/**
 * Checks if a single object exists in the Ontology.
 *
 * Uses OpenSearch's EXISTS API (HEAD request) which is faster than GET
 * because it doesn't return the document body.
 *
 * @param objectTypeApiName - The object type to check in
 * @param primaryKey        - The primary key to look for
 * @returns true if the object exists, false if not found
 * @throws Error if OpenSearch is unreachable or returns a server error
 */
export async function objectExists(
  objectTypeApiName: string,
  primaryKey: string
): Promise<boolean> {
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await opensearchClient.exists({
      index: indexName,
      id: primaryKey,
    });
    return body as unknown as boolean;
  } catch (err: any) {
    if (isNotFoundError(err)) {
      // Index itself doesn't exist — object type was never indexed
      return false;
    }
    // Connection error, timeout, etc. — THROW
    throw new Error(
      `Failed to check object existence for ${objectTypeApiName}/${primaryKey}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// 2. fetchObject — Fetch a single object's full document
// ---------------------------------------------------------------------------

/**
 * Fetches a single object from the Ontology.
 *
 * @param objectTypeApiName - The object type
 * @param primaryKey        - The primary key
 * @returns The full object (all properties from _source), or null if not found
 * @throws Error if OpenSearch is unreachable or returns a server error
 */
export async function fetchObject(
  objectTypeApiName: string,
  primaryKey: string
): Promise<Record<string, unknown> | null> {
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await opensearchClient.get({
      index: indexName,
      id: primaryKey,
    });
    return (body as any)._source ?? null;
  } catch (err: any) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw new Error(
      `Failed to fetch object ${objectTypeApiName}/${primaryKey}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. batchCheckExistence — Check multiple objects in one request
// ---------------------------------------------------------------------------

/**
 * Checks existence of multiple objects in a single request.
 * More efficient than calling objectExists() in a loop.
 *
 * Uses OpenSearch's _mget API with _source: false (we only need the
 * "found" boolean, not the document body).
 *
 * @param objectTypeApiName - The object type
 * @param primaryKeys       - Array of primary keys to check
 * @returns Map of primaryKey -> exists (boolean)
 * @throws Error if OpenSearch is unreachable or returns a server error
 */
export async function batchCheckExistence(
  objectTypeApiName: string,
  primaryKeys: string[]
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();

  if (primaryKeys.length === 0) {
    return result;
  }

  const indexName = getIndexName(objectTypeApiName);
  const batches = chunk(primaryKeys, MGET_BATCH_SIZE);

  for (const batch of batches) {
    try {
      const { body } = await opensearchClient.mget({
        index: indexName,
        body: { ids: batch },
        _source: false as any,
      });

      const response = body as unknown as {
        docs: Array<{ _id: string; found: boolean }>;
      };

      for (const doc of response.docs) {
        result.set(doc._id, doc.found === true);
      }
    } catch (err: any) {
      if (isNotFoundError(err)) {
        // Index doesn't exist — none of the objects exist
        for (const pk of batch) {
          result.set(pk, false);
        }
      } else {
        throw new Error(
          `Failed to batch check existence for ${objectTypeApiName}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. batchFetchObjects — Fetch multiple objects in one request
// ---------------------------------------------------------------------------

/**
 * Fetches multiple objects in a single request.
 *
 * Uses OpenSearch's _mget API with _source: true.
 * Only includes found documents in the returned Map.
 *
 * @param objectTypeApiName - The object type
 * @param primaryKeys       - Array of primary keys
 * @returns Map of primaryKey -> object (only for found objects)
 * @throws Error if OpenSearch is unreachable or returns a server error
 */
export async function batchFetchObjects(
  objectTypeApiName: string,
  primaryKeys: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();

  if (primaryKeys.length === 0) {
    return result;
  }

  const indexName = getIndexName(objectTypeApiName);
  const batches = chunk(primaryKeys, MGET_BATCH_SIZE);

  for (const batch of batches) {
    try {
      const { body } = await opensearchClient.mget({
        index: indexName,
        body: { ids: batch },
      });

      const response = body as unknown as {
        docs: Array<{
          _id: string;
          found: boolean;
          _source?: Record<string, unknown>;
        }>;
      };

      for (const doc of response.docs) {
        if (doc.found && doc._source) {
          result.set(doc._id, doc._source);
        }
      }
    } catch (err: any) {
      if (isNotFoundError(err)) {
        // Index doesn't exist — no objects to return
        continue;
      }
      throw new Error(
        `Failed to batch fetch objects for ${objectTypeApiName}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 5. checkObjectType — Verify object type exists and is indexed
// ---------------------------------------------------------------------------

/** Result of checkObjectType. */
export interface ObjectTypeCheckResult {
  exists: boolean;
  indexed: boolean;
  objectCount: number;
}

/**
 * Validates that an object type exists and has been indexed.
 * Checks both PostgreSQL metadata and OpenSearch index status.
 *
 * @param ontologyId        - The ontology
 * @param objectTypeApiName - The object type to check
 * @returns { exists, indexed, objectCount }
 */
export async function checkObjectType(
  ontologyId: string,
  objectTypeApiName: string
): Promise<ObjectTypeCheckResult> {
  // 1. Check PostgreSQL for the object type definition
  const otResult = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, objectTypeApiName]
  );

  if (otResult.rows.length === 0) {
    return { exists: false, indexed: false, objectCount: 0 };
  }

  // 2. Check OpenSearch for the index
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await opensearchClient.count({
      index: indexName,
      body: { query: { match_all: {} } },
    });

    const count = (body as any).count ?? 0;

    return {
      exists: true,
      indexed: true,
      objectCount: count,
    };
  } catch (err: any) {
    if (isNotFoundError(err)) {
      // Index doesn't exist — object type defined but never indexed
      return { exists: true, indexed: false, objectCount: 0 };
    }
    // For connection errors, we still know the type exists in PG
    // but can't determine index status — throw to be safe
    throw new Error(
      `Failed to check index status for ${objectTypeApiName}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  objectExists,
  fetchObject,
  batchCheckExistence,
  batchFetchObjects,
  checkObjectType,
};
