// ---------------------------------------------------------------------------
// OpenSearch Bulk Indexer
//
// Sends transformed documents to OpenSearch using the bulk API for efficient
// indexing. The bulk API allows indexing thousands of documents in a single
// HTTP request, dramatically faster than indexing one at a time.
//
// In Palantir's Funnel architecture, the Index Job writes the merged result
// into the object database using bulk operations. A single pipeline run
// might index tens of thousands or millions of objects, so efficient bulk
// indexing is critical.
// ---------------------------------------------------------------------------

import { client } from "./client";
import { ensureDocumentSecurity } from "../security/documentSecurity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress callback payload for batch operations. */
export interface BatchCompleteInfo {
  batchNumber: number;
  totalBatches: number;
  documentsInBatch: number;
  totalIndexed: number;
  durationMs: number;
}

/** A single document that failed during bulk indexing. */
export interface FailedDocument {
  primaryKey: string;
  status: number;
  error: string;
}

/** Options for bulkIndex(). */
export interface BulkIndexOptions {
  /** Documents per bulk request (default: 500). */
  batchSize?: number;
  /** Refresh index after all batches (default: true). */
  refreshAfterComplete?: boolean;
  /** Callback after each batch completes. */
  onBatchComplete?: (info: BatchCompleteInfo) => void;
}

/** Result of bulkIndex(). */
export interface BulkIndexResult {
  success: boolean;
  indexName: string;
  totalDocuments: number;
  successCount: number;
  failedCount: number;
  createdCount: number;
  updatedCount: number;
  failedDocuments: FailedDocument[];
  batchCount: number;
  totalDurationMs: number;
  avgBatchDurationMs: number;
}

/** Options for bulkDelete(). */
export interface BulkDeleteOptions {
  /** Deletes per bulk request (default: 500). */
  batchSize?: number;
  /** Refresh index after all batches (default: true). */
  refreshAfterComplete?: boolean;
  /** Callback after each batch completes. */
  onBatchComplete?: (info: BatchCompleteInfo) => void;
}

/** Result of bulkDelete(). */
export interface BulkDeleteResult {
  success: boolean;
  indexName: string;
  totalDocuments: number;
  deletedCount: number;
  failedCount: number;
  failedDocuments: FailedDocument[];
  batchCount: number;
  totalDurationMs: number;
  avgBatchDurationMs: number;
}

/** Result of indexSingleDocument(). */
export interface IndexSingleResult {
  success: true;
  primaryKey: string;
  result: string;
}

/** Result of deleteSingleDocument(). */
export interface DeleteSingleResult {
  success: true;
  primaryKey: string;
  result: string;
}

/** Error result for unreachable cluster. */
export interface BulkErrorResult {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Helper: extract error message
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Helper: split array into chunks
// ---------------------------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 1. bulkIndex()
// ---------------------------------------------------------------------------

/**
 * Index an array of documents into the specified OpenSearch index using the
 * bulk API.
 *
 * Each document must have a `__pk` field used as the OpenSearch document ID.
 * Uses the "index" action which creates or replaces documents (idempotent).
 *
 * @param indexName  - The OpenSearch index name.
 * @param documents  - Array of document objects with `__pk` fields.
 * @param options    - Optional batch configuration.
 * @returns BulkIndexResult or BulkErrorResult if the cluster is unreachable.
 */
export async function bulkIndex(
  indexName: string,
  documents: Array<Record<string, unknown>>,
  options?: BulkIndexOptions
): Promise<BulkIndexResult | BulkErrorResult> {
  const batchSize = options?.batchSize ?? 500;
  const refreshAfterComplete = options?.refreshAfterComplete !== false;
  const onBatchComplete = options?.onBatchComplete;

  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  const failedDocuments: FailedDocument[] = [];

  // Split into batches
  const batches = chunk(documents, batchSize);
  const totalBatches = batches.length;
  let totalIndexed = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchStart = Date.now();

    // Build bulk request body: alternating action + document lines.
    // Phase A4 (F-03) — every indexed document MUST carry `_security.markings`
    // or it becomes invisible to marking-constrained users after the
    // public-leak branch in buildSecurityFilter was removed. The caller
    // (CSV-backed indexing, reindex, seed tools) usually does not know
    // or care about classification, so we default to PUBLIC via
    // `ensureDocumentSecurity`. Callers that DO care (e.g. a pipeline
    // that classifies rows based on a marking column) should set
    // `_security.markings` on the document before passing it in — the
    // helper is idempotent and will not overwrite an explicit marking.
    const bulkBody: Array<Record<string, unknown>> = [];
    for (const doc of batch) {
      const pk = String(doc.__pk);
      bulkBody.push({ index: { _index: indexName, _id: pk } });
      bulkBody.push(ensureDocumentSecurity(doc));
    }

    try {
      const { body } = await client.bulk({ body: bulkBody });

      const response = body as unknown as {
        errors: boolean;
        items: Array<Record<string, { _id: string; status: number; result?: string; error?: { type: string; reason: string } }>>;
      };

      // Process each item result
      for (const item of response.items) {
        const action = item.index;
        if (!action) continue;

        if (action.status >= 400) {
          failedCount++;
          const errorMsg = action.error
            ? `${action.error.type}: ${action.error.reason}`
            : `HTTP ${action.status}`;
          failedDocuments.push({
            primaryKey: action._id,
            status: action.status,
            error: errorMsg,
          });
        } else {
          successCount++;
          if (action.result === "created") {
            createdCount++;
          } else if (action.result === "updated") {
            updatedCount++;
          } else {
            // Other results (e.g., "noop") count as created
            createdCount++;
          }
        }
      }

      totalIndexed += batch.length;
    } catch (err: unknown) {
      // Cluster unreachable or network error — entire batch fails
      return {
        success: false,
        error: {
          code: "OPENSEARCH_UNREACHABLE",
          message: `Bulk index failed on batch ${batchIdx + 1}/${totalBatches}: ${extractErrorMessage(err)}`,
        },
      };
    }

    // Batch complete callback
    if (onBatchComplete) {
      onBatchComplete({
        batchNumber: batchIdx + 1,
        totalBatches,
        documentsInBatch: batch.length,
        totalIndexed,
        durationMs: Date.now() - batchStart,
      });
    }
  }

  // Refresh index to make documents immediately searchable
  if (refreshAfterComplete && documents.length > 0) {
    try {
      await client.indices.refresh({ index: indexName });
    } catch (err: unknown) {
      // Refresh failure is non-fatal — documents will become searchable
      // after the refresh_interval (1s by default)
      console.warn(
        `Warning: Failed to refresh index '${indexName}': ${extractErrorMessage(err)}`
      );
    }
  }

  const totalDurationMs = Date.now() - startTime;

  return {
    success: failedCount === 0,
    indexName,
    totalDocuments: documents.length,
    successCount,
    failedCount,
    createdCount,
    updatedCount,
    failedDocuments,
    batchCount: totalBatches,
    totalDurationMs,
    avgBatchDurationMs: totalBatches > 0 ? Math.round(totalDurationMs / totalBatches) : 0,
  };
}

// ---------------------------------------------------------------------------
// 2. bulkDelete()
// ---------------------------------------------------------------------------

/**
 * Delete multiple documents by primary key using the bulk API.
 *
 * @param indexName    - The OpenSearch index name.
 * @param primaryKeys  - Array of primary key strings to delete.
 * @param options      - Optional batch configuration.
 * @returns BulkDeleteResult or BulkErrorResult if unreachable.
 */
export async function bulkDelete(
  indexName: string,
  primaryKeys: string[],
  options?: BulkDeleteOptions
): Promise<BulkDeleteResult | BulkErrorResult> {
  const batchSize = options?.batchSize ?? 500;
  const refreshAfterComplete = options?.refreshAfterComplete !== false;
  const onBatchComplete = options?.onBatchComplete;

  const startTime = Date.now();
  let deletedCount = 0;
  let failedCount = 0;
  const failedDocuments: FailedDocument[] = [];

  // Split into batches
  const batches = chunk(primaryKeys, batchSize);
  const totalBatches = batches.length;
  let totalProcessed = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchStart = Date.now();

    // Build bulk delete body: only action lines, no document lines
    const bulkBody: Array<Record<string, unknown>> = [];
    for (const pk of batch) {
      bulkBody.push({ delete: { _index: indexName, _id: pk } });
    }

    try {
      const { body } = await client.bulk({ body: bulkBody });

      const response = body as unknown as {
        errors: boolean;
        items: Array<Record<string, { _id: string; status: number; result?: string; error?: { type: string; reason: string } }>>;
      };

      for (const item of response.items) {
        const action = item.delete;
        if (!action) continue;

        // 404 (not_found) is not considered a failure for delete — the
        // document is already gone, which is the desired state.
        if (action.status >= 400 && action.status !== 404) {
          failedCount++;
          const errorMsg = action.error
            ? `${action.error.type}: ${action.error.reason}`
            : `HTTP ${action.status}`;
          failedDocuments.push({
            primaryKey: action._id,
            status: action.status,
            error: errorMsg,
          });
        } else {
          deletedCount++;
        }
      }

      totalProcessed += batch.length;
    } catch (err: unknown) {
      return {
        success: false,
        error: {
          code: "OPENSEARCH_UNREACHABLE",
          message: `Bulk delete failed on batch ${batchIdx + 1}/${totalBatches}: ${extractErrorMessage(err)}`,
        },
      };
    }

    if (onBatchComplete) {
      onBatchComplete({
        batchNumber: batchIdx + 1,
        totalBatches,
        documentsInBatch: batch.length,
        totalIndexed: totalProcessed,
        durationMs: Date.now() - batchStart,
      });
    }
  }

  // Refresh index
  if (refreshAfterComplete && primaryKeys.length > 0) {
    try {
      await client.indices.refresh({ index: indexName });
    } catch (err: unknown) {
      console.warn(
        `Warning: Failed to refresh index '${indexName}': ${extractErrorMessage(err)}`
      );
    }
  }

  const totalDurationMs = Date.now() - startTime;

  return {
    success: failedCount === 0,
    indexName,
    totalDocuments: primaryKeys.length,
    deletedCount,
    failedCount,
    failedDocuments,
    batchCount: totalBatches,
    totalDurationMs,
    avgBatchDurationMs: totalBatches > 0 ? Math.round(totalDurationMs / totalBatches) : 0,
  };
}

// ---------------------------------------------------------------------------
// 3. indexSingleDocument()
// ---------------------------------------------------------------------------

/**
 * Index a single document into OpenSearch with immediate refresh.
 * Used by the Action engine when a single object is created or modified.
 *
 * @param indexName - The OpenSearch index name.
 * @param document  - The document to index (must have __pk field).
 * @returns IndexSingleResult on success.
 * @throws Error if the operation fails.
 */
export async function indexSingleDocument(
  indexName: string,
  document: Record<string, unknown>
): Promise<IndexSingleResult> {
  const pk = String(document.__pk);

  try {
    const { body } = await client.index({
      index: indexName,
      id: pk,
      body: document,
      refresh: "true",
    });

    const response = body as unknown as { result: string };

    return {
      success: true,
      primaryKey: pk,
      result: response.result ?? "created",
    };
  } catch (err: unknown) {
    throw new Error(
      `Failed to index document '${pk}' into '${indexName}': ${extractErrorMessage(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 4. deleteSingleDocument()
// ---------------------------------------------------------------------------

/**
 * Delete a single document from OpenSearch with immediate refresh.
 * Used by the Action engine when an object is deleted.
 *
 * @param indexName  - The OpenSearch index name.
 * @param primaryKey - The primary key of the document to delete.
 * @returns DeleteSingleResult on success.
 * @throws Error if the operation fails.
 */
export async function deleteSingleDocument(
  indexName: string,
  primaryKey: string
): Promise<DeleteSingleResult> {
  try {
    const { body } = await client.delete({
      index: indexName,
      id: primaryKey,
      refresh: "true",
    });

    const response = body as unknown as { result: string };

    return {
      success: true,
      primaryKey,
      result: response.result ?? "deleted",
    };
  } catch (err: unknown) {
    throw new Error(
      `Failed to delete document '${primaryKey}' from '${indexName}': ${extractErrorMessage(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  bulkIndex,
  bulkDelete,
  indexSingleDocument,
  deleteSingleDocument,
  bulkIndexBounded,
  approxDocBytes,
};

/**
 * Rough byte-size estimate for a document, used to bound bulk request
 * bodies by bytes (not just doc count). Uses the JSON-string length of
 * the doc (UTF-8 bytes ≈ JS string length for the ASCII-heavy canonical
 * property bags we index). Deliberately cheap — this is a bound, not an
 * accounting.
 */
export function approxDocBytes(doc: Record<string, unknown>): number {
  try {
    // Array.isArray would double-count; the canonical doc is a flat object.
    return Buffer.byteLength(JSON.stringify(doc), "utf8");
  } catch {
    return 1024; // fallback
  }
}

/** Options for {@link bulkIndexBounded}. */
export interface BulkBoundedOptions {
  /** Max documents per _bulk request. */
  maxDocsPerBulk?: number;
  /** Max payload bytes per _bulk request (whichever limit is hit first). */
  maxBytesPerBulk?: number;
}

/** Structured result of one bounded bulk send (a page's worth of docs). */
export interface BulkBoundedResult {
  /** Documents the bulk API reported as indexed (status < 400). */
  ok: number;
  /** Per-document failures (HTTP 200 overall but item-level errors). */
  failed: FailedDocument[];
  /** True if any item/error signalled OpenSearch write-queue backpressure
   *  (`es_rejected_execution_exception` / HTTP 429). The caller MUST back
   *  off (exp+jitter) and shrink the batch rather than immediately
   *  retrying the same oversized request — burning through Temporal's
   *  attempt budget is the exact failure mode this prevents. */
  backpressure: boolean;
  /** Whole-request error (network / non-backpressure). If set without
   *  backpressure, the cluster is unreachable or rejected the whole
   *  request — the caller throws (vs. backing off). */
  unreachableError?: string;
  /** Sum of approx bytes sent across the batches in this call. */
  bytesSent: number;
  /** Number of _bulk requests issued. */
  bulks: number;
}

/**
 * Index `docs` into `indexName` using the _bulk API, chunked by BOTH a
 * document-count bound AND a byte-size bound (whichever is hit first),
 * with `refresh: false` on every request (the caller refreshes once at
 * the end — per-batch refresh is what made the previous sync too slow to
 * fit the Temporal timeout). Inspects per-item results so a HTTP 200 with
 * `errors: true` is NOT treated as success.
 *
 * Distinguishes **backpressure** (`es_rejected_execution_exception` /
 * 429) from a hard error: on backpressure, returns immediately with the
 * unprocessed remainder left in `docs` for the caller to retry after
 * backing off + shrinking — instead of throwing into Temporal's retry.
 */
export async function bulkIndexBounded(
  indexName: string,
  docs: Array<Record<string, unknown>>,
  opts?: BulkBoundedOptions
): Promise<BulkBoundedResult> {
  const maxDocs = opts?.maxDocsPerBulk ?? 500;
  const maxBytes = opts?.maxBytesPerBulk ?? 10 * 1024 * 1024;
  let ok = 0;
  let bytesSent = 0;
  let bulks = 0;
  let backpressure = false;
  let unreachableError: string | undefined;
  const failed: FailedDocument[] = [];

  let i = 0;
  while (i < docs.length) {
    const batch: Array<Record<string, unknown>> = [];
    let batchBytes = 0;
    while (i < docs.length && batch.length < maxDocs) {
      const doc = docs[i];
      const docBytes = approxDocBytes(doc);
      if (batch.length > 0 && batchBytes + docBytes > maxBytes) break;
      batch.push(doc);
      batchBytes += docBytes;
      i++;
    }
    if (batch.length === 0) break;

    const bulkBody: Array<Record<string, unknown>> = [];
    for (const doc of batch) {
      bulkBody.push({ index: { _index: indexName, _id: String(doc.__pk) } });
      bulkBody.push(ensureDocumentSecurity(doc));
    }
    bytesSent += batchBytes;
    bulks++;

    try {
      const { body } = await client.bulk({ body: bulkBody, refresh: false });
      const resp = body as unknown as {
        errors: boolean;
        items: Array<
          Record<
            string,
            { _id: string; status: number; error?: { type: string; reason: string } }
          >
        >;
      };
      for (const it of resp.items) {
        const action = it.index;
        if (!action) continue;
        if (action.status >= 400) {
          const errType = action.error?.type ?? "";
          if (/es_rejected|rejected_execution/i.test(errType) || action.status === 429) {
            backpressure = true;
          }
          failed.push({
            primaryKey: action._id,
            status: action.status,
            error: action.error
              ? `${action.error.type}: ${action.error.reason}`
              : `HTTP ${action.status}`,
          });
        } else {
          ok++;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/es_rejected|rejected_execution|429/i.test(msg)) {
        backpressure = true;
      }
      unreachableError = msg;
      // Whole-request failure: we don't know which items the server saw,
      // so mark the whole batch failed for the caller's item-level retry.
      for (const doc of batch) {
        failed.push({ primaryKey: String(doc.__pk), status: 0, error: msg });
      }
    }

    if (backpressure) {
      // Stop sending more for this call; the caller backs off + retries the
      // remainder (including this batch's failed docs) with a smaller bound.
      break;
    }
    if (unreachableError && !backpressure) {
      // Hard failure — don't keep going; let the caller throw into Temporal.
      break;
    }
  }

  return { ok, failed, backpressure, unreachableError, bytesSent, bulks };
}
