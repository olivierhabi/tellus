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
import { bulkIndex, BulkIndexResult, BulkErrorResult } from "./bulkIndexer";
import { client } from "./client";
import {
  createIndex,
  getIndexName,
  indexExists,
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
  /** Orphan documents pruned from OpenSearch (rows that exist in OS but no
   *  longer exist in `object_instances`). */
  rowsOrphanDeleted: number;
  /** Wall-clock time for the whole sync. */
  durationMs: number;
}

const PAGE_SIZE = 1_000;

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
  objectTypeApiName: string
): Promise<SyncResult> {
  const startedAt = Date.now();
  const indexName = getIndexName(objectTypeApiName);

  // ---- 1. Ensure the index exists --------------------------------------
  let indexCreated = false;
  const existsRes = await indexExists(objectTypeApiName);
  if (!existsRes.exists) {
    await createIndex(objectTypeApiName);
    indexCreated = true;
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
  const propsRes = await query(
    `SELECT p.api_name
       FROM property p
       JOIN object_type ot ON ot.object_type_id = p.object_type_id
      WHERE ot.api_name = $1`,
    [objectTypeApiName]
  );
  const canonicalApiNames: string[] = propsRes.rows.map(
    (r) => r.api_name as string
  );
  // Map every plausible source key shape → canonical apiName so a
  // single `propertyAliases.get(srcKey)` resolves the lookup. We seed
  // the identity mapping first (so already-canonical writers keep
  // working) then layer the snake-case + case-insensitive variants.
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

  // ---- 2. Page through `object_instances` and bulk-index ----------------
  let rowsRead = 0;
  let rowsIndexed = 0;
  let offset = 0;
  // Track every primary_key we sync so step 3 can identify orphans in OS
  // that no longer have a backing row in `object_instances` (e.g. when the
  // backing CSV row count shrank from 746 -> 51 between two passes). A Set
  // of strings comfortably fits multi-million-row OTs (~50 bytes per entry).
  const livePks = new Set<string>();

  while (true) {
    // Order by primary_key so retries are deterministic; ontology-wide
    // pagination on PK is index-backed by `idx_object_instances_ot`.
    const page = await query(
      `SELECT primary_key, properties, markings, last_modified_at, version
         FROM object_instances
        WHERE object_type_api_name = $1
        ORDER BY primary_key
        LIMIT $2 OFFSET $3`,
      [objectTypeApiName, PAGE_SIZE, offset]
    );
    if (page.rows.length === 0) break;

    rowsRead += page.rows.length;

    const docs = page.rows.map((row) => {
      livePks.add(String(row.primary_key));
      const canonical = toCanonicalProperties(
        row.properties as Record<string, unknown>,
        propertyAliases
      );
      return {
        __pk: row.primary_key,
        __objectType: objectTypeApiName,
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

    const res = (await bulkIndex(indexName, docs, {
      refreshAfterComplete: true, // make rows queryable immediately for the FE
    })) as BulkIndexResult | BulkErrorResult;

    if ("error" in res) {
      throw new Error(
        `[opensearch sync] bulkIndex error on ${objectTypeApiName} ` +
          `offset=${offset}: ${(res as BulkErrorResult).error}`
      );
    }
    rowsIndexed += res.successCount;

    if (page.rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
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
  if (!indexCreated) {
    const orphanIds: string[] = [];
    const SCROLL_PAGE = 1_000;
    let scrollId: string | undefined;
    try {
      const initialRes = await client.search({
        index: indexName,
        scroll: "1m",
        body: {
          query: { match_all: {} },
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
      // Chunk to keep request bodies under OpenSearch's default 100MB limit.
      const DELETE_BATCH = 1_000;
      for (let i = 0; i < orphanIds.length; i += DELETE_BATCH) {
        const slice = orphanIds.slice(i, i + DELETE_BATCH);
        const bulkBody: Array<Record<string, unknown>> = [];
        for (const id of slice) {
          bulkBody.push({ delete: { _index: indexName, _id: id } });
        }
        const { body } = await client.bulk({
          body: bulkBody,
          refresh: true,
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
    }
  }

  return {
    indexName,
    indexCreated,
    rowsRead,
    rowsIndexed,
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
function toCanonicalProperties(
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
