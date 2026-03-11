// ---------------------------------------------------------------------------
// OpenSearch Client Connection Module
//
// Establishes and manages the singleton connection to the OpenSearch cluster.
// Every module that needs to interact with OpenSearch imports this module
// rather than creating its own connection. The @opensearch-project/opensearch
// client handles connection pooling internally.
//
// In Palantir's architecture, Object Storage V2 maintains persistent
// connections to the underlying search engine cluster. This module replicates
// that pattern: a single client instance is shared across the entire
// application, and the connection URL can be swapped for a multi-node cluster
// in production without code changes.
// ---------------------------------------------------------------------------

import { Client } from "@opensearch-project/opensearch";

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
// ping()
// ---------------------------------------------------------------------------

/**
 * Test the connection to OpenSearch by calling the cluster health API.
 *
 * @returns A PingResult indicating whether the connection succeeded along
 *          with cluster metadata, or a failure object with the error message.
 */
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

/**
 * Attempt to connect to OpenSearch with retries. This is necessary because
 * when the application starts, OpenSearch may not be ready yet (especially
 * in Docker environments where containers start in parallel).
 *
 * @param maxRetries - Maximum number of connection attempts (default: 10).
 * @param delayMs    - Milliseconds to wait between attempts (default: 2000).
 * @throws Error if all retries are exhausted.
 */
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

/**
 * Return detailed information about the OpenSearch cluster including the
 * cluster name, status, node count, index count, total documents, and total
 * store size. Used by the status endpoint and for monitoring.
 *
 * @returns A ClusterInfo object on success.
 * @throws An OpenSearchError if the stats call fails.
 */
async function getClusterInfo(): Promise<ClusterInfo> {
  try {
    const { body } = await client.cluster.stats({});

    // The OpenSearch client types are strict objects; cast through unknown
    // to access dynamic fields safely.
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

export { client, ping, waitForConnection, getClusterInfo };
export default client;
