// ---------------------------------------------------------------------------
// syncObjectInstancesToOpenSearch
//
// Reads every `object_instances` row for an Object Type and pushes the
// canonical document into the per-OT OpenSearch index. This is the
// integration point that closes the gap between:
//
//   - the Temporal funnel pipeline (writes object_instances + Quickwit
//     splits via Kafka), and
//   - the FE search panel (`useObjectSearch` → POST
//     /api/v1/objects/:apiName/search → `executeListObjects` → OpenSearch).
//
// Historically the funnel never touched OpenSearch — the only writer was
// the manual `reindexService.reindexObjectType` path, triggered out-of-band.
// Wizard-created object types whose backing CSV had just been merged into
// Postgres would report `funnel_state.status='indexed'` and
// `objects_indexed=500` but the FE-rendered "CURRENT VALUE" card sat on
// "500 objects pending index | Rows exist but aren't searchable yet"
// because `ontology-<apiname>` simply did not exist in OpenSearch.
//
// This helper is:
//   - **idempotent** — creates the index iff missing, bulk-indexes with
//     the "index" action (creates or replaces by `__pk`).
//   - **streaming** — reads object_instances in 1 000-row pages so a
//     million-row OT doesn't blow the heap.
//   - **safe-by-default** — every doc passes through `ensureDocumentSecurity`
//     inside `bulkIndex`, so marking-constrained users never lose access.
//
// Returns a SyncResult so the caller can log / surface the indexed count
// the same way the existing reindex pipeline does.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  bulkIndexBounded,
  BulkBoundedOptions,
  BulkBoundedResult,
} from "./bulkIndexer";
import { client } from "./client";
import {
  createIndex,
  getIndexName,
  indexExists,
  verifyIndexShardCount,
} from "./indexLifecycleManager";

export interface SyncResult {
  /** OpenSearch index name written to (after slug normalisation). */
  indexName: string;
  /** True when this run had to create the index (cold-start case). */
  indexCreated: boolean;
  /** Rows read from `object_instances`. */
  rowsRead: number;
  /** Documents the bulk API reported as indexed. */
  rowsIndexed: number;
  /** Documents that failed per-item even after retry (HTTP 200 with
   *  `errors:true`). Surfaced so the caller/FE can see partial failures
   *  rather than treating a 200 as full success. */
  rowsFailed: number;
  /** Orphan documents pruned from OpenSearch (rows that exist in OS but no
   *  longer exist in `object_instances`). */
  rowsOrphanDeleted: number;
  /** Wall-clock time for the whole sync. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Bounded, backpressure-aware, resumable bulk indexing.
//
// The prior sync failed at 848k rows because it called bulkIndex with
// `refreshAfterComplete: true` ONCE PER 1000-row page → one
// `indices.refresh()` per page → ~848 forced refreshes, making the sync
// too slow to fit the activity's 10-min startToCloseTimeout →
// ActivityTaskTimedOut → retry → restart from offset 0 (LIMIT/OFFSET) →
// the tail was never reached. These tunables close that off: the refresh
// happens ONCE at the end, bulks are bounded by both doc count and byte
// size, and pagination is keyset (cursor) — O(1) per page and resumable
// across a Temporal retry via the heartbeat cursor. All env-config so dev
// vs. prod can be sized without a code change.
// ---------------------------------------------------------------------------
const PAGE_SIZE = Number(process.env.SYNC_OS_PAGE_DOCS ?? 20_000);
const MAX_DOCS_PER_BULK = Number(process.env.SYNC_OS_BATCH_DOCS ?? 2_000);
/** In-flight _bulk requests per page. >1 parallelises across the index's
 *  shards (see resolveShardCount — large OTs get 4). Shrunk (with maxDocs)
 *  on backpressure. */
const BULK_CONCURRENCY = Math.max(
  1,
  Number(process.env.SYNC_OS_BULK_CONCURRENCY ?? 4),
);
/** Toggle for the bulk-phase index settings (refresh off + async translog)
 *  applied for the duration of the sync. Default ON; set SYNC_OS_BULK_PHASE=0
 *  to disable (e.g. if readers must see rows progressively mid-sync). */
const BULK_PHASE_SETTINGS = (process.env.SYNC_OS_BULK_PHASE ?? "1") !== "0";
const MAX_BYTES_PER_BULK = Number(
  process.env.SYNC_OS_BATCH_BYTES ?? 10 * 1024 * 1024,
);
const REFRESH_MODE = (process.env.SYNC_OS_REFRESH ?? "final") as
  | "final"
  | "none";
const MAX_BACKPRESSURE_BACKOFFS = Number(
  process.env.SYNC_OS_MAX_BACKOFFS ?? 6,
);

/**
 * Read the keyset cursor a Temporal retry heartbeat recorded, so a sync
 * that times out partway through 850k+ docs resumes from the last
 * successfully-indexed position rather than restarting from zero (the
 * prior LIMIT/OFFSET path restarted at offset 0 each retry — the second
 * half of the failure). No-op outside a Temporal activity.
 */
function readResumeCursor(): string {
  try {
    const { Context } = require("@temporalio/activity") as typeof import("@temporalio/activity");
    const details = Context.current().info.heartbeatDetails as
      | string
      | undefined;
    return typeof details === "string" ? details : "";
  } catch {
    return "";
  }
}

/** Record the keyset cursor so a Temporal retry can resume from it. */
function heartbeatCursor(key: string): void {
  try {
    const { Context } = require("@temporalio/activity") as typeof import("@temporalio/activity");
    Context.current().heartbeat(key);
  } catch {
    /* not in a Temporal activity — no-op */
  }
}

/** Exponential + full-jitter backoff for `es_rejected_execution_exception`. */
async function backoff(attempt: number): Promise<void> {
  const base = Math.min(60_000, 500 * 2 ** attempt); // 0.5s, 1s, 2s, … cap 60s
  const jitter = Math.floor(Math.random() * base);
  await new Promise((r) => setTimeout(r, jitter));
}

/** Connection-class failures (stale keep-alive race, transient reset, or a
 *  brief OS hiccup) — distinct from item-level rejections. Observed: after a
 *  multi-second pause (e.g. the pre-loop ANALYZE), firing CONCURRENT bulks
 *  onto idle keep-alive sockets the server had already closed fails ALL of
 *  them instantly with "socket hang up" — the cluster is fine, only the
 *  sockets are stale. These MUST be retried in-place (fresh connections)
 *  instead of failing the whole Temporal activity attempt. */
const MAX_CONN_RETRIES = 5;
function isConnectionError(msg: string): boolean {
  return /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|Connection|timeout/i.test(
    msg,
  );
}

// ---------------------------------------------------------------------------
// Bulk-phase index settings
//
// During the bulk, `refresh_interval: -1` stops the 1s refresh from turning
// a multi-million-doc bulk into constant small-segment creation + merge
// pressure (a 2-3x wall-clock factor), and `translog.durability: async`
// stops every _bulk from fsyncing the translog. Both are restored in the
// caller's `finally` — ALWAYS, including on failure — then the single final
// refresh makes everything searchable at once. Restore targets the same
// defaults `DEFAULT_INDEX_SETTINGS` creates with ("1s" / "request");
// replicas are intentionally untouched (dev=0 already, and prod replica
// policy should not be owned by a sync helper).
// ---------------------------------------------------------------------------

async function enterBulkPhaseSettings(
  indexName: string,
  objectTypeApiName: string,
): Promise<boolean> {
  try {
    await client.indices.putSettings({
      index: indexName,
      body: {
        index: {
          refresh_interval: "-1",
          translog: { durability: "async" },
        },
      },
    });
    console.log(
      `[os-sync] ${objectTypeApiName} bulk-phase settings ON ` +
        `(refresh_interval=-1, translog=async)`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[os-sync] ${objectTypeApiName} bulk-phase settings failed (non-fatal, ` +
        `continuing with live refresh): ${(err as Error).message}`,
    );
    return false;
  }
}

async function restoreBulkPhaseSettings(
  indexName: string,
  objectTypeApiName: string,
): Promise<void> {
  try {
    await client.indices.putSettings({
      index: indexName,
      body: {
        index: {
          refresh_interval: "1s",
          translog: { durability: "request" },
        },
      },
    });
    console.log(
      `[os-sync] ${objectTypeApiName} bulk-phase settings restored ` +
        `(refresh_interval=1s, translog=request)`,
    );
  } catch (err) {
    // Loud but non-throwing: a failed restore leaves the index non-refreshing
    // — the operator MUST see this.
    console.error(
      `[os-sync] ${objectTypeApiName} FAILED to restore bulk-phase settings ` +
        `on '${indexName}' — index may be left with refresh_interval=-1: ` +
        `${(err as Error).message}`,
    );
  }
}

/**
 * Fan a page of docs out across up to `concurrency` in-flight
 * `bulkIndexBounded` calls (each internally bounded by docs+bytes). With a
 * multi-shard index this parallelises across shard indexing threads — the
 * single-request path left the cluster idle between round-trips. Results
 * are merged; any chunk's backpressure/unreachable short-circuits the pool
 * (remaining chunks are simply not started — the caller re-sends the whole
 * page after backing off, which is safe because `_id = __pk` upserts are
 * idempotent).
 */
async function bulkIndexConcurrent(
  indexName: string,
  docs: Array<Record<string, unknown>>,
  opts: BulkBoundedOptions,
  concurrency: number,
): Promise<BulkBoundedResult> {
  const maxDocs = opts.maxDocsPerBulk ?? 500;
  if (concurrency <= 1 || docs.length <= maxDocs) {
    return bulkIndexBounded(indexName, docs, opts);
  }
  const chunks: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < docs.length; i += maxDocs) {
    chunks.push(docs.slice(i, i + maxDocs));
  }
  const merged: BulkBoundedResult = {
    ok: 0,
    failed: [],
    backpressure: false,
    unreachableError: undefined,
    bytesSent: 0,
    bulks: 0,
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (merged.backpressure || merged.unreachableError) return;
      const i = next++;
      if (i >= chunks.length) return;
      const r = await bulkIndexBounded(indexName, chunks[i], opts);
      merged.ok += r.ok;
      merged.failed.push(...r.failed);
      merged.bytesSent += r.bytesSent;
      merged.bulks += r.bulks;
      if (r.backpressure) merged.backpressure = true;
      if (r.unreachableError) merged.unreachableError = r.unreachableError;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, worker),
  );
  return merged;
}

/**
 * Sync every `object_instances` row for the given Object Type into the
 * canonical OpenSearch index. Creates the index on demand.
 *
 * NOTE on tenancy: this helper intentionally uses the legacy single-tenant
 * `getIndexName(apiName)` form (no `ontologyId` arg). Until queryExecutor
 * is migrated to the tenant-scoped form (`getIndexName(apiName, ontologyId)`)
 * the writer and the reader must agree on the same name, otherwise the FE
 * search would still 404. When the multi-tenant migration lands the second
 * arg should be plumbed through here in the same commit.
 */
export async function syncObjectInstancesToOpenSearch(
  objectTypeApiName: string,
  ontologyId?: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const indexName = getIndexName(objectTypeApiName);

  // The legacy entry point accepted only apiName even though apiName is
  // unique inside an ontology, not globally. Resolve it only when the result
  // is unambiguous; production workflow callers must pass ontologyId.
  let resolvedOntologyId = ontologyId;
  if (!resolvedOntologyId) {
    const matches = await query(
      `SELECT DISTINCT ontology_id
         FROM object_type
        WHERE api_name = $1
        ORDER BY ontology_id`,
      [objectTypeApiName],
    );
    if (matches.rows.length !== 1) {
      throw new Error(
        `OpenSearch sync requires ontologyId for '${objectTypeApiName}' ` +
          `(matched ${matches.rows.length} ontologies)`,
      );
    }
    resolvedOntologyId = String(matches.rows[0].ontology_id);
  }

  // ---- 1. Ensure the index exists --------------------------------------
  let indexCreated = false;
  const existsRes = await indexExists(objectTypeApiName);
  if (!existsRes.exists) {
    await createIndex(objectTypeApiName, resolvedOntologyId);
    indexCreated = true;
  } else {
    // Existing index — refuse to silently upsert into one whose shard count
    // drifted from OS_INDEX_SHARDS (e.g. ontology-olivierorder1 was created
    // at 1 shard before OS_INDEX_SHARDS=4 was configured). Fail fast; the
    // operator must delete + recreate (recreateIndex / deleteIndex) to
    // realign. Without this the sync would index into the wrong shape and the
    // divergence would only surface as a perf/capacity anomaly later.
    await verifyIndexShardCount(objectTypeApiName);
  }

  // ---- 1b. Load canonical property registry for this OT ----------------
  //
  // `object_instances.properties` is a JSONB bag keyed by whatever the
  // funnel writer used at merge time. For wizard-created OTs whose
  // backing dataset is a CSV, those keys are the raw CSV column headers
  // (snake_case, e.g. `item_name`, `customer_id`). But every consumer
  // of OpenSearch downstream — the FE picker, `extractTitle` against the
  // OT's `titleProperty.apiName`, `executeSearch` filter predicates,
  // `formatObjectList`'s null-fill against `resolveAllProperties` — keys
  // off the canonical `property.api_name` (camelCase, e.g. `itemName`,
  // `customerId`). If we ship the snake_case bag untouched, the FE asks
  // OS for `itemName`, OS returns `null`, the FE falls back through
  // `primaryKey` and the user sees the UUID instead of "Multifunction
  // Printer". The legacy `reindexService` path solves this implicitly via
  // its property-resolver-driven shape; we mirror that shape here.
  //
  // The mapping is "best-effort" — for any input key without an apiName
  // match (by exact, snake→camel, or case-insensitive transform) the
  // original key is preserved so unmapped fields stay searchable rather
  // than disappearing. Collisions (both shapes in the same doc, e.g.
  // `customer_id` + `customerId`) are resolved by preferring the
  // canonical apiName slot — anything else would let stale source-shape
  // data shadow a current canonical value.
  const propertyAliases = await buildPropertyAliasMap(
    objectTypeApiName,
    resolvedOntologyId
  );

  // ---- 2. Keyset-page through `object_instances` and bounded-bulk-index --
  //
  // Keyset (cursor) pagination — `WHERE primary_key > $lastSeen ORDER BY
  // primary_key LIMIT $page` — NOT `LIMIT/OFFSET`. OFFSET's cost grows
  // with depth (page 850 scans 850k rows) and a retry restarted at offset
  // 0 each time, so the tail of a ~850k set was never reached. Keyset is
  // O(1) per page, index-backed by `idx_object_instances_ot`, and the
  // cursor is resumable across a Temporal retry (heartbeatCursor, below).
  let rowsRead = 0;
  let rowsIndexed = 0;
  let rowsFailed = 0;
  let lastSeenKey = readResumeCursor();
  // A resumed attempt only collects `livePks` for keys AFTER the cursor —
  // the set is PARTIAL. The orphan-prune below MUST be skipped in that case
  // or it deletes every doc the previous attempt indexed (observed: a
  // Temporal retry at cursor ~260k pruned exactly 260,000 live docs and the
  // index came up short vs object_instances).
  const resumedFromCursor = lastSeenKey !== "";
  if (lastSeenKey) {
    console.log(
      `[os-sync] ${objectTypeApiName} resuming from keyset cursor ` +
        `${lastSeenKey.slice(0, 16)}… (Temporal retry)`,
    );
  }
  // Track every primary_key we sync so step 3 can identify orphans in OS
  // that no longer have a backing row in `object_instances` (e.g. when the
  // backing CSV row count shrank from 746 -> 51 between two passes). A Set
  // of strings comfortably fits multi-million-row OTs (~50 bytes per entry).
  const livePks = new Set<string>();
  let maxDocs = MAX_DOCS_PER_BULK;
  let bulkConcurrency = BULK_CONCURRENCY;

  // Per-stage wall-clock accumulators. `fetchBlockedMs` is only the fetch
  // time NOT hidden behind indexing (the prefetch below overlaps page N+1's
  // SELECT with page N's transform + bulk).
  let fetchBlockedMs = 0;
  let transformMs = 0;
  let indexMs = 0;

  // Bulk-phase settings for the duration of the loop; restored in `finally`.
  const bulkPhaseApplied = BULK_PHASE_SETTINGS
    ? await enterBulkPhaseSettings(indexName, objectTypeApiName)
    : false;

  // Freshen planner stats BEFORE the first keyset page. The sync often runs
  // seconds after a merge just inserted millions of rows; with stale stats
  // the first `WHERE ot = $1 AND primary_key > $2 ORDER BY primary_key`
  // planned badly and hit the 60s statement_timeout (observed on the
  // 4.66M-row OlivierOrder10 first page — Temporal had to retry). ANALYZE
  // is seconds and makes the composite-index plan a certainty.
  try {
    const tAnalyze = Date.now();
    await query(`ANALYZE object_instances`);
    console.log(
      `[os-sync] ${objectTypeApiName} ANALYZE object_instances ` +
        `durMs=${Date.now() - tAnalyze}`,
    );
  } catch (err) {
    console.warn(
      `[os-sync] ${objectTypeApiName} ANALYZE failed (non-fatal): ` +
        `${(err as Error).message}`,
    );
  }

  const fetchPage = (afterKey: string) =>
    query(
      `SELECT primary_key, properties, markings, last_modified_at, version, rid
         FROM object_instances
        WHERE ontology_id = $1
          AND object_type_api_name = $2
          AND primary_key > $3
        ORDER BY primary_key
        LIMIT $4`,
      [resolvedOntologyId, objectTypeApiName, afterKey, PAGE_SIZE],
    );

  try {
  // Prefetch pipeline: page N+1's SELECT is issued as soon as page N's last
  // key is known, BEFORE page N is transformed + indexed — PG fetch time
  // hides behind OS bulk time. A rejected prefetch is marked handled (the
  // no-op catch) so it can't become an unhandledRejection while the current
  // page's bulk is still awaited; the real error still throws when awaited.
  let nextPagePromise = fetchPage(lastSeenKey);
  nextPagePromise.catch(() => {});

  while (true) {
    const tFetch = Date.now();
    const page = await nextPagePromise;
    fetchBlockedMs += Date.now() - tFetch;
    if (page.rows.length === 0) break;
    rowsRead += page.rows.length;
    const pageLastKey = String(page.rows[page.rows.length - 1].primary_key);
    const isLastPage = page.rows.length < PAGE_SIZE;
    if (!isLastPage) {
      nextPagePromise = fetchPage(pageLastKey);
      nextPagePromise.catch(() => {});
    }
    const tTransform = Date.now();

    const docs = page.rows.map((row) => {
      livePks.add(String(row.primary_key));
      const canonical = toIndexableProperties(
        toCanonicalProperties(
          row.properties as Record<string, unknown>,
          propertyAliases,
        ),
      );
      return {
        __pk: row.primary_key,
        __objectType: objectTypeApiName,
        __ontology: resolvedOntologyId,
        __rid: row.rid,
        __lastModified: new Date(row.last_modified_at).toISOString(),
        __version: Number(row.version ?? 1),
        // Re-keyed property bag — every key is the canonical
        // `property.api_name` (camelCase) so the FE's
        // `obj[titleProperty]` lookup hits a real value, not a `null`
        // null-fill from `formatObjectList`.
        ...canonical,
        // Carry markings explicitly so `ensureDocumentSecurity` doesn't
        // overwrite a real classification with PUBLIC.
        _security: {
          markings:
            Array.isArray(row.markings) && row.markings.length > 0
              ? row.markings
              : ["PUBLIC"],
        },
      };
    });
    const docsByPk = new Map(docs.map((d) => [String(d.__pk), d]));
    transformMs += Date.now() - tTransform;

    // Retry loop for this page: on backpressure, back off + shrink the
    // bulk bound; on per-item errors (HTTP 200 with errors:true), retry
    // just the failed docs; on a hard (non-backpressure) error, throw
    // into Temporal (which retries from the heartbeat cursor).
    let pending = docs;
    let backoffAttempt = 0;
    let connRetries = 0;
    let pageDone = false;
    while (!pageDone) {
      const t0 = Date.now();
      const res = await bulkIndexConcurrent(
        indexName,
        pending,
        {
          maxDocsPerBulk: maxDocs,
          maxBytesPerBulk: MAX_BYTES_PER_BULK,
        },
        bulkConcurrency,
      );
      indexMs += Date.now() - t0;
      rowsIndexed += res.ok;
      console.log(
        `[os-sync] ${objectTypeApiName} key<${lastSeenKey.slice(0, 12)}… ` +
          `bulks=${res.bulks} docs=${pending.length} ok=${res.ok} ` +
          `failed=${res.failed.length} bytes=${res.bytesSent} ` +
          `durMs=${Date.now() - t0}` +
          (res.backpressure ? " BACKPRESSURE" : "") +
          (res.unreachableError
            ? ` err=${res.unreachableError.slice(0, 120)}`
            : ""),
      );

      if (res.unreachableError && !res.backpressure) {
        if (
          isConnectionError(res.unreachableError) &&
          connRetries < MAX_CONN_RETRIES
        ) {
          connRetries++;
          console.warn(
            `[os-sync] ${objectTypeApiName} connection error at ` +
              `key<${lastSeenKey.slice(0, 12)}… (retry ${connRetries}/` +
              `${MAX_CONN_RETRIES}): ${res.unreachableError.slice(0, 120)}`,
          );
          await backoff(connRetries);
          // Re-send the whole page — idempotent (_id = __pk overwrites).
          pending = docs;
          continue;
        }
        throw new Error(
          `[os-sync] ${objectTypeApiName} bulk unreachable at ` +
            `key<${lastSeenKey.slice(0, 16)}…: ${res.unreachableError}`,
        );
      }

      if (res.backpressure) {
        // es_rejected — back off (exp+jitter) + shrink, don't burn the
        // attempt budget retrying the same oversized request.
        if (backoffAttempt >= MAX_BACKPRESSURE_BACKOFFS) {
          throw new Error(
            `[os-sync] ${objectTypeApiName} backpressure persisted after ` +
              `${MAX_BACKPRESSURE_BACKOFFS} backoffs at ` +
              `key<${lastSeenKey.slice(0, 16)}… — shrinking exhausted`,
          );
        }
        await backoff(backoffAttempt++);
        maxDocs = Math.max(50, Math.floor(maxDocs / 2));
        bulkConcurrency = Math.max(1, Math.floor(bulkConcurrency / 2));
        // Re-send the whole page (idempotent — `_id = __pk` overwrites;
        // the already-succeeded docs re-index cheaply) with the smaller
        // bound so the backpressured + unprocessed docs go through.
        pending = docs;
        continue;
      }

      // Per-item failures (HTTP 200 with errors:true) — retry only the
      // failed docs once; the rest of the page succeeded. Do NOT treat a
      // 200 as full success (the original bug class).
      if (res.failed.length > 0) {
        const retryDocs: Array<Record<string, unknown>> = [];
        for (const f of res.failed) {
          const d = docsByPk.get(f.primaryKey);
          if (d !== undefined) retryDocs.push(d as Record<string, unknown>);
        }
        if (retryDocs.length > 0) {
          await backoff(0);
          const rr = await bulkIndexBounded(indexName, retryDocs, {
            maxDocsPerBulk: maxDocs,
            maxBytesPerBulk: MAX_BYTES_PER_BULK,
          });
          rowsIndexed += rr.ok;
          rowsFailed += rr.failed.length;
          console.log(
            `[os-sync] ${objectTypeApiName} retry-failed docs=${retryDocs.length} ` +
              `ok=${rr.ok} stillFailed=${rr.failed.length}` +
              (rr.failed.length > 0
                ? ` sample=${JSON.stringify(rr.failed.slice(0, 3))}`
                : ""),
          );
          if (rr.failed.length > 0) {
            console.warn(
              `[os-sync] ${objectTypeApiName} ${rr.failed.length} doc(s) ` +
                `still failed after retry — index will be short by that many`,
            );
          }
        }
      }
      pageDone = true;
    }

    // Advance the keyset cursor + record it so a Temporal retry resumes
    // from here (not from zero). Only AFTER the page fully indexed — the
    // prefetch does not change resume semantics.
    lastSeenKey = pageLastKey;
    heartbeatCursor(lastSeenKey);
    if (isLastPage) break;
  }
  } finally {
    if (bulkPhaseApplied) {
      await restoreBulkPhaseSettings(indexName, objectTypeApiName);
    }
  }

  console.log(
    `[os-sync] ${objectTypeApiName} stage-summary rowsRead=${rowsRead} ` +
      `rowsIndexed=${rowsIndexed} fetchBlockedMs=${fetchBlockedMs} ` +
      `transformMs=${transformMs} indexMs=${indexMs} pageSize=${PAGE_SIZE} ` +
      `bulkDocs=${MAX_DOCS_PER_BULK} bulkConcurrency=${BULK_CONCURRENCY} ` +
      `elapsedMs=${Date.now() - startedAt}`,
  );

  // ---- 2b. Single final refresh (replaces the per-page refresh) ---------
  //
  // The prior per-page refresh (~848 for an 848k OT) was the whole reason
  // the sync exceeded the activity timeout. One refresh at the end makes
  // the full batch queryable; the OS `refresh_interval` (1s default)
  // surfaces rows progressively during the sync anyway.
  if (REFRESH_MODE === "final" && rowsRead > 0) {
    const t0 = Date.now();
    try {
      await client.indices.refresh({ index: indexName });
      console.log(
        `[os-sync] ${objectTypeApiName} final refresh durMs=${Date.now() - t0}`,
      );
    } catch (err) {
      console.warn(
        `[os-sync] ${objectTypeApiName} final refresh failed (non-fatal — refresh_interval covers it): ${(err as Error).message}`,
      );
    }
  }

  // ---- 3. Prune orphans (docs in OS not backed by `object_instances`) ---
  //
  // When the backing CSV row count shrinks (e.g. 746 -> 51), the upsert
  // path in step 2 happily updates the 51 surviving documents but leaves
  // the 695 stale documents behind. The FE then surfaces a search count
  // larger than the underlying PG row count, and `objects pending index`
  // never reaches parity. The fix is to scroll the index for every `_id`,
  // compute the orphan set against the `livePks` we collected in step 2,
  // and bulk-delete them.
  //
  // Scaling: scroll memory is constant (we discard hits after the diff
  // check); `livePks` is O(rows) in the writer's heap which is the same
  // ceiling the upsert step already accepts. For multi-million row OTs
  // this stays well under 100MB and is the same shape as the existing
  // reindex pipeline.
  let rowsOrphanDeleted = 0;
  if (resumedFromCursor) {
    console.log(
      `[os-sync] ${objectTypeApiName} resumed from cursor — livePks is ` +
        `partial, SKIPPING orphan-prune (next full sync will prune)`,
    );
  } else if (!indexCreated) {
    // After step 2 the bulk upserted EVERY primary_key in `livePks`, so
    // OS ⊇ livePks. If `osCount === livePks.size` there are NO orphans —
    // skip the scroll entirely. The prior code unconditionally scrolled
    // the whole index (848 round-trips for an 848k OT ≈ 7min to find zero
    // orphans), pushing the sync back over the activity timeout even after
    // the per-page-refresh fix. Only scroll when osCount > livePks.size
    // (the genuine shrink case).
    let osCount = 0;
    try {
      const cnt = await client.count({
        index: indexName,
        body: {
          query: { term: { __ontology: resolvedOntologyId } },
        },
      });
      osCount = Number((cnt.body as { count: number }).count);
    } catch {
      osCount = livePks.size + 1; // count failed → fall through to scroll
    }
    if (osCount <= livePks.size) {
      console.log(
        `[os-sync] ${objectTypeApiName} osCount=${osCount} ≤ livePks=${livePks.size} — no orphans, skipping scroll`,
      );
    } else {
      console.log(
        `[os-sync] ${objectTypeApiName} osCount=${osCount} > livePks=${livePks.size} — scrolling for orphans`,
      );
      const orphanIds: string[] = [];
      const SCROLL_PAGE = 5_000; // larger page → fewer round-trips at scale
      let scrollId: string | undefined;
      try {
        const initialRes = await client.search({
          index: indexName,
          scroll: "1m",
          body: {
            query: { term: { __ontology: resolvedOntologyId } },
            _source: false,
            size: SCROLL_PAGE,
          },
        });
        const initialBody = initialRes.body as unknown as {
          _scroll_id?: string;
          hits: { hits: Array<{ _id: string }> };
        };
        scrollId = initialBody._scroll_id;
        let hits = initialBody.hits.hits;
        while (hits.length > 0) {
          for (const h of hits) {
            if (!livePks.has(h._id)) orphanIds.push(h._id);
          }
          if (!scrollId) break;
          const nextRes = await client.scroll({
            scroll_id: scrollId,
            scroll: "1m",
          });
          const nextBody = nextRes.body as unknown as {
            _scroll_id?: string;
            hits: { hits: Array<{ _id: string }> };
          };
          scrollId = nextBody._scroll_id;
          hits = nextBody.hits.hits;
        }
      } finally {
        if (scrollId) {
          try {
            await client.clearScroll({ scroll_id: scrollId });
          } catch {
            /* best-effort; scroll auto-expires after 1m */
          }
        }
      }

      if (orphanIds.length > 0) {
        // Chunk deletes; refresh ONCE after (not per delete-batch — same
        // per-batch-refresh anti-pattern that made the index path slow).
        const DELETE_BATCH = 1_000;
        for (let i = 0; i < orphanIds.length; i += DELETE_BATCH) {
          const slice = orphanIds.slice(i, i + DELETE_BATCH);
          const bulkBody: Array<Record<string, unknown>> = [];
          for (const id of slice) {
            bulkBody.push({ delete: { _index: indexName, _id: id } });
          }
          const { body } = await client.bulk({
            body: bulkBody,
            refresh: false,
          });
          const resp = body as unknown as {
            errors: boolean;
            items: Array<{ delete?: { status: number } }>;
          };
          for (const it of resp.items) {
            const st = it.delete?.status;
            if (st !== undefined && st < 400) rowsOrphanDeleted += 1;
          }
        }
        try {
          await client.indices.refresh({ index: indexName });
        } catch {
          /* non-fatal — refresh_interval covers it */
        }
      }
      console.log(
        `[os-sync] ${objectTypeApiName} orphan-prune deleted=${rowsOrphanDeleted}`,
      );
    }
  }

  return {
    indexName,
    indexCreated,
    rowsRead,
    rowsIndexed,
    rowsFailed,
    rowsOrphanDeleted,
    durationMs: Date.now() - startedAt,
  };
}

export default { syncObjectInstancesToOpenSearch };

// ---------------------------------------------------------------------------
// Internal helpers (pure, no I/O — safe to unit-test in isolation)
// ---------------------------------------------------------------------------

/**
 * `itemName` → `item_name`. Mirrors the convention the CSV/Parquet ingest
 * pipeline uses when normalising column headers. Multi-word
 * boundaries are detected by `[a-z][A-Z]` and the consecutive
 * uppercase run case `[A-Z][A-Z][a-z]` (so `URLPath` → `url_path`,
 * not `u_r_l_path`). ASCII-only by design — we never accept
 * non-ASCII apiNames upstream.
 */
function camelToSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Re-key a raw property bag (snake_case from CSV ingest, or already
 * canonical from API writes) into the canonical `property.api_name`
 * shape OpenSearch and the FE consume.
 *
 * Precedence inside one input bag:
 *   1. Exact-match canonical key wins — `{itemName: "Printer",
 *      item_name: "stale"}` → `{itemName: "Printer"}` (the source-shape
 *      duplicate is dropped, not merged, to avoid shadowing).
 *   2. Snake-case match next.
 *   3. Case-insensitive match next.
 *   4. Unmapped keys are preserved verbatim so unknown columns stay
 *      visible during schema drift.
 */
/**
 * Build the source-key → canonical `property.api_name` alias map for an
 * Object Type: identity for canonical keys, snake_case and case-insensitive
 * variants, plus the backing datasource's column_mapping (raw CSV column →
 * property apiName). Shared by the full sync and the serving edit projector
 * so both write identically-shaped documents.
 */
export async function buildPropertyAliasMap(
  objectTypeApiName: string,
  ontologyId: string
): Promise<Map<string, string>> {
  const propsRes = await query(
    `SELECT p.api_name
       FROM property p
       JOIN object_type ot ON ot.object_type_id = p.object_type_id
      WHERE ot.api_name = $1 AND ot.ontology_id = $2`,
    [objectTypeApiName, ontologyId]
  );
  const canonicalApiNames: string[] = propsRes.rows.map(
    (r) => r.api_name as string
  );
  const propertyAliases = new Map<string, string>();
  for (const apiName of canonicalApiNames) {
    propertyAliases.set(apiName, apiName);
    const snake = camelToSnake(apiName);
    if (snake !== apiName && !propertyAliases.has(snake)) {
      propertyAliases.set(snake, apiName);
    }
    const lower = apiName.toLowerCase();
    if (lower !== apiName && !propertyAliases.has(lower)) {
      propertyAliases.set(lower, apiName);
    }
  }

  const colMapRes = await query(
    `SELECT column_mapping
       FROM backing_datasource
      WHERE object_type_id = (
        SELECT object_type_id
          FROM object_type
         WHERE api_name = $1 AND ontology_id = $2
      )`,
    [objectTypeApiName, ontologyId]
  );
  if (colMapRes.rows.length > 0) {
    const raw = colMapRes.rows[0].column_mapping;
    const colMapping: Record<string, string> =
      typeof raw === "string" ? JSON.parse(raw) : raw || {};
    for (const [propApiName, sourceColumn] of Object.entries(colMapping)) {
      if (sourceColumn && !propertyAliases.has(sourceColumn)) {
        propertyAliases.set(sourceColumn, propApiName);
      }
    }
  }
  return propertyAliases;
}

/**
 * Coerce a property value into an OpenSearch-indexable shape. The funnel
 * merge stores PG-timestamp-shaped strings ('2026-02-24 10:30:00') in
 * object_instances.properties while date-mapped index fields require
 * ISO 8601 — uncoerced values are rejected by the date mapper (observed:
 * 278/449 RssbFraudSignal docs failing a full sync). Shared by the full
 * sync and the serving edit projector so both write identical documents.
 */
export function toIndexablePropertyValue(value: unknown): unknown {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(value)
  ) {
    const iso = new Date(value.replace(" ", "T") + "Z");
    return Number.isNaN(iso.getTime()) ? value : iso.toISOString();
  }
  return value;
}

/** Apply {@link toIndexablePropertyValue} across a property bag. */
export function toIndexableProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, toIndexablePropertyValue(v)]),
  );
}

export function toCanonicalProperties(
  raw: Record<string, unknown> | null | undefined,
  aliases: Map<string, string>
): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  // First pass: copy canonical (apiName-keyed) entries. Subsequent
  // passes won't overwrite them so a writer that already speaks
  // canonical is authoritative.
  for (const [k, v] of Object.entries(raw)) {
    const canonical = aliases.get(k);
    if (canonical !== undefined && canonical === k) {
      out[canonical] = v;
    }
  }
  // Second pass: snake/case-insensitive matches fill in keys we
  // haven't yet written.
  for (const [k, v] of Object.entries(raw)) {
    if (out[k] !== undefined) continue;
    const canonical = aliases.get(k);
    if (canonical !== undefined && out[canonical] === undefined) {
      out[canonical] = v;
      continue;
    }
    if (canonical === undefined) {
      // Unmapped — preserve verbatim. This is deliberate: schema
      // drift (a new CSV column the OT registry doesn't know about)
      // should remain searchable rather than silently disappear.
      out[k] = v;
    }
  }
  return out;
}
