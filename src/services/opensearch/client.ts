// ---------------------------------------------------------------------------
// OpenSearch Client Connection Module
//
// Establishes and manages the singleton connection to the OpenSearch cluster.
// Every module that needs to interact with OpenSearch imports this module
// rather than creating its own connection. The @opensearch-project/opensearch
// client handles connection pooling internally.
//
// Task 18: Enhanced with retry, error translation, query logging, and
// wrapper functions (searchObjects, getObject, countObjects, indexExists).
// ---------------------------------------------------------------------------

import { Client } from "@opensearch-project/opensearch";
import {
  OPENSEARCH_MAX_RETRIES,
  OPENSEARCH_RETRY_INITIAL_DELAY_MS,
  OPENSEARCH_SLOW_QUERY_THRESHOLD_MS,
} from "../../utils/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Successful ping result. */
export interface PingSuccess {
  connected: true;
  clusterName: string;
  status: string;
  numberOfNodes: number;
}

/** Failed ping result. */
export interface PingFailure {
  connected: false;
  error: string;
}

export type PingResult = PingSuccess | PingFailure;

/** Cluster information returned by getClusterInfo(). */
export interface ClusterInfo {
  clusterName: string;
  status: string;
  numberOfNodes: number;
  numberOfIndices: number;
  totalDocuments: number;
  totalStoreSizeBytes: number;
}

/** Standard error shape for OpenSearch operations. */
export interface OpenSearchError {
  success: false;
  error: {
    code: string;
    message: string;
    details: string;
  };
}

// ---------------------------------------------------------------------------
// Singleton client instance
// ---------------------------------------------------------------------------

const OPENSEARCH_URL = process.env.OPENSEARCH_URL || "http://localhost:9200";

const client = new Client({
  node: OPENSEARCH_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  requestTimeout: 30_000,
  maxRetries: 3,
});

// ---------------------------------------------------------------------------
// Helper: wrap errors in a consistent format
// ---------------------------------------------------------------------------

function wrapError(code: string, message: string, details: string): OpenSearchError {
  return {
    success: false,
    error: { code, message, details },
  };
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Retry logic for transient errors
// ---------------------------------------------------------------------------

function isTransientError(err: any): boolean {
  if (!err) return false;
  const statusCode = err.statusCode ?? err.meta?.statusCode;
  if (statusCode === 503 || statusCode === 429) return true;
  if (
    err.name === "ConnectionError" ||
    err.name === "TimeoutError" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT"
  ) {
    return true;
  }
  return false;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  label: string
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= OPENSEARCH_MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      if (!isTransientError(err) || attempt === OPENSEARCH_MAX_RETRIES) {
        throw err;
      }
      const delay =
        OPENSEARCH_RETRY_INITIAL_DELAY_MS * Math.pow(4, attempt - 1);
      console.warn(
        `[OpenSearch] ${label} attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Query logging helper
// ---------------------------------------------------------------------------

function logQuery(
  method: string,
  index: string,
  body: any,
  statusCode: number,
  durationMs: number,
  hitCount?: number
): void {
  const bodyStr = body ? JSON.stringify(body) : "";
  const truncated =
    bodyStr.length > 500 ? bodyStr.substring(0, 500) + "..." : bodyStr;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    type: "opensearch_query",
    method,
    index,
    body: truncated,
    statusCode,
    durationMs: Math.round(durationMs * 100) / 100,
  };
  if (hitCount !== undefined) entry.hitCount = hitCount;

  console.debug(JSON.stringify(entry));

  if (durationMs > OPENSEARCH_SLOW_QUERY_THRESHOLD_MS) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "slow_opensearch_query",
        method,
        index,
        durationMs: Math.round(durationMs * 100) / 100,
        body: truncated,
        timestamp: new Date().toISOString(),
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Wrapper: searchObjects
// ---------------------------------------------------------------------------

/**
 * Inject a spec §Task 28 security filter into a search body. The original
 * query (whatever shape the caller supplied) is moved under `bool.must` and
 * the security clause is ANDed in alongside it. This is the only place in
 * the code where ES search queries leave user-controlled data — any route
 * that bypasses searchObjects() also bypasses security, which is a bug.
 */
function injectSecurityFilter(
  body: Record<string, unknown>,
  securityFilter: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!securityFilter) return body;
  const original = (body.query as Record<string, unknown> | undefined) || {
    match_all: {},
  };
  return {
    ...body,
    query: {
      bool: {
        must: [original, securityFilter],
      },
    },
  };
}

async function searchObjects(
  index: string,
  body: Record<string, unknown>,
  securityFilter?: Record<string, unknown> | null
): Promise<any> {
  const start = performance.now();
  const finalBody = injectSecurityFilter(body, securityFilter);
  const result = await withRetry(
    () => client.search({ index, body: finalBody }),
    `search(${index})`
  );
  const durationMs = performance.now() - start;
  const hitCount = result.body?.hits?.hits?.length ?? 0;
  logQuery("search", index, finalBody, result.statusCode ?? 200, durationMs, hitCount);
  return result;
}

// ---------------------------------------------------------------------------
// Wrapper: getObject
// ---------------------------------------------------------------------------

async function getObject(
  index: string,
  id: string,
  sourceIncludes?: string[]
): Promise<any> {
  const start = performance.now();
  const params: Record<string, unknown> = { index, id };
  if (sourceIncludes) params._source_includes = sourceIncludes;
  const result = await withRetry(
    () => client.get(params as any),
    `get(${index}/${id})`
  );
  const durationMs = performance.now() - start;
  logQuery("get", index, { id }, result.statusCode ?? 200, durationMs);
  return result;
}

// ---------------------------------------------------------------------------
// Wrapper: countObjects
// ---------------------------------------------------------------------------

async function countObjects(
  index: string,
  body: Record<string, unknown>,
  securityFilter?: Record<string, unknown> | null
): Promise<any> {
  const start = performance.now();
  const finalBody = injectSecurityFilter(body, securityFilter);
  const result = await withRetry(
    () => client.count({ index, body: finalBody }),
    `count(${index})`
  );
  const durationMs = performance.now() - start;
  logQuery("count", index, finalBody, result.statusCode ?? 200, durationMs);
  return result;
}

// ---------------------------------------------------------------------------
// Wrapper: indexExists
// ---------------------------------------------------------------------------

async function indexExists(index: string): Promise<boolean> {
  const start = performance.now();
  try {
    const result = await withRetry(
      () => client.indices.exists({ index }),
      `indexExists(${index})`
    );
    const durationMs = performance.now() - start;
    logQuery("indexExists", index, null, result.statusCode ?? 200, durationMs);
    return result.statusCode === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ping()
// ---------------------------------------------------------------------------

async function ping(): Promise<PingResult> {
  try {
    const { body } = await client.cluster.health({});

    const health = body as Record<string, unknown>;
    return {
      connected: true,
      clusterName: health.cluster_name as string,
      status: health.status as string,
      numberOfNodes: health.number_of_nodes as number,
    };
  } catch (err: unknown) {
    return {
      connected: false,
      error: extractErrorMessage(err),
    };
  }
}

// ---------------------------------------------------------------------------
// waitForConnection()
// ---------------------------------------------------------------------------

async function waitForConnection(
  maxRetries: number = 10,
  delayMs: number = 2000
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await ping();

    if (result.connected) {
      console.log(
        `Connected to OpenSearch cluster: ${result.clusterName} (status: ${result.status})`
      );
      return;
    }

    console.log(
      `OpenSearch connection attempt ${attempt}/${maxRetries} failed: ${result.error}`
    );

    if (attempt < maxRetries) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `Failed to connect to OpenSearch after ${maxRetries} attempts`
  );
}

// ---------------------------------------------------------------------------
// getClusterInfo()
// ---------------------------------------------------------------------------

async function getClusterInfo(): Promise<ClusterInfo> {
  try {
    const { body } = await client.cluster.stats({});

    const stats = body as unknown as Record<string, unknown>;
    const indices = stats.indices as Record<string, unknown>;
    const docs = indices.docs as Record<string, unknown>;
    const store = indices.store as Record<string, unknown>;

    return {
      clusterName: stats.cluster_name as string,
      status: stats.status as string,
      numberOfNodes: (stats.nodes as Record<string, unknown>).count as number,
      numberOfIndices: indices.count as number,
      totalDocuments: docs.count as number,
      totalStoreSizeBytes: store.size_in_bytes as number,
    };
  } catch (err: unknown) {
    throw wrapError(
      "OPENSEARCH_CONNECTION_ERROR",
      "Failed to retrieve cluster information",
      extractErrorMessage(err)
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  client,
  ping,
  waitForConnection,
  getClusterInfo,
  searchObjects,
  getObject,
  countObjects,
  indexExists,
};
export default client;
