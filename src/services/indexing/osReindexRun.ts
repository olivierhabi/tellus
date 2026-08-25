import fs from "fs";
import { query } from "../../db";
import { appError } from "../../utils/appError";
import { convertValue } from "./typeConverter";
import { ensureDocumentSecurity } from "../security/documentSecurity";
import { getIndexName, createIndex } from "../opensearch/indexLifecycleManager";
import { client } from "../opensearch/client";
import { getObjectStream } from "../storageService";
import type { PropertyInput } from "../mapping/typeMapper";
import { parseCsvReadable } from "./streamingCsv";
import { externalHashMerge } from "./partitionedMerge";
import { parallelBulkIndex } from "./parallelBulkIndexer";

// ---------------------------------------------------------------------------
// osReindexRun.ts (Phase 3: gap 2 — async + checkpointed + resumable)
//
// A self-contained, PG-backed OpenSearch reindex run lifecycle that replaces
// the synchronous, blocking, restart-from-zero `reindexObjectType` path for
// large CSV backings (feature-flagged via FUNNEL_OPENSEARCH_PIPELINE).
//
//   startOsReindexRun()  — INSERT a 'pending' run row, return 202 + run_id
//     IMMEDIATELY (async; the executor runs fire-and-forget in-process).
//   runOsReindexPipeline(runId) — the executor:
//     1. load run + backing metadata (object_type, properties, datasource).
//     2. ensureIndex (createIndex; do NOT deleteIndex on resume — `index` by
//        _id is idempotent, so resume appends/overwrites, never restarts).
//     3. stream CSV → parseCsvReadable → externalHashMerge (bounded memory,
//        deterministic) → onMerged maps columns→ontology props → SKIP the
//        first `indexed_count` already-indexed docs (the resume) → feed the
//        rest to parallelBulkIndex (concurrent batches + backpressure).
//     4. checkpoint `indexed_count` after each batch (onProgress).
//     5. status='indexed' on completion; 'failed' + error_message on throw.
//   resumeOrphanedOsReindexRuns() — boot sweeper: re-queue 'running' rows
//     orphaned by a worker/process crash (the repo's "auto-swept on boot"
//     pattern). The executor's resume-skip means it continues from the last
//     checkpoint, not from zero.
//
// Determinism for resume: the merge yields docs in partition order (0..N-1),
// each partition's docs in CSV-appearance order; CSV stream order + the pure
// FNV-1a hash + stable Map insertion order make the yielded sequence
// identical across runs → skipping the first `indexed_count` is sound.
//
// HONEST SCOPE: single-worker, PG-durable resume (survives process restart,
// resumes from checkpoint). NOT Temporal multi-worker durability or automatic
// activity-retry across nodes — the dev cluster has one worker. Stated plainly.
// ---------------------------------------------------------------------------

const OS_INDEX_CONCURRENCY = Number(process.env.FUNNEL_OS_INDEX_CONCURRENCY ?? 4);
const OS_PARTITION_COUNT = Number(process.env.FUNNEL_OS_PARTITION_COUNT ?? 64);

function isFoundryBridgedPath(p: string | null | undefined): boolean {
  return typeof p === "string" && p.includes("#foundry-dataset:");
}
function stripFoundryTags(p: string): string {
  const i = p.indexOf("#foundry-dataset:");
  return i >= 0 ? p.slice(0, i) : p;
}

interface OsReindexMeta {
  objectTypeId: string;
  propertiesMap: Map<string, any>;
  columnMapping: Record<string, string>;
  primaryKeyColumn: string;
  filePath: string;
  indexName: string;
}

async function loadOsReindexMeta(
  ontologyId: string,
  apiName: string,
): Promise<OsReindexMeta> {
  const otResult = await query(
    `SELECT ot.object_type_id, ot.api_name, ot.primary_key_property_id
       FROM object_type ot
       JOIN ontology o ON ot.ontology_id = o.ontology_id
      WHERE o.ontology_id = $1 AND ot.api_name = $2`,
    [ontologyId, apiName],
  );
  if (otResult.rows.length === 0) {
    throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${apiName}' not found.`, {});
  }
  const objectTypeId = otResult.rows[0].object_type_id;

  const propsResult = await query(
    `SELECT api_name, base_type, is_required, is_array, struct_schema
       FROM property WHERE object_type_id = $1 ORDER BY ordinal, api_name`,
    [objectTypeId],
  );
  const propertiesMap = new Map<string, any>();
  for (const p of propsResult.rows) propertiesMap.set(p.api_name, p);

  const dsResult = await query(
    `SELECT file_path, primary_key_column, column_mapping
       FROM backing_datasource WHERE object_type_id = $1`,
    [objectTypeId],
  );
  if (dsResult.rows.length === 0) {
    throw appError("NO_BACKING_DATASOURCE", `No backing datasource for '${apiName}'.`, {});
  }
  const ds = dsResult.rows[0];
  const columnMapping: Record<string, string> =
    typeof ds.column_mapping === "string"
      ? JSON.parse(ds.column_mapping)
      : ds.column_mapping || {};

  return {
    objectTypeId,
    propertiesMap,
    columnMapping,
    primaryKeyColumn: ds.primary_key_column,
    filePath: ds.file_path,
    indexName: getIndexName(apiName),
  };
}

/** Map a deduped raw CSV row → an OpenSearch-ready, security-stamped doc. */
function mapRow(
  row: Record<string, unknown>,
  meta: OsReindexMeta,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const [propApiName, columnName] of Object.entries(meta.columnMapping)) {
    const rawValue = row[columnName];
    const property = meta.propertiesMap.get(propApiName);
    if (property) {
      const propInput: PropertyInput = {
        api_name: property.api_name,
        base_type: property.base_type,
        is_array: property.is_array || false,
        is_required: property.is_required || false,
        struct_schema: property.struct_schema || null,
      };
      const converted = convertValue(
        rawValue === null || rawValue === undefined ? null : String(rawValue),
        propInput,
      );
      doc[propApiName] = converted.value;
    }
  }
  const pkValue = row[meta.primaryKeyColumn];
  return ensureDocumentSecurity({
    __pk: pkValue,
    __objectType: undefined, // filled below
    __lastModified: new Date().toISOString(),
    __version: 1,
    ...doc,
  });
}

/** Open the backing CSV as a Readable (MinIO for foundry-bridged, else disk). */
async function openBackingStream(filePath: string) {
  if (isFoundryBridgedPath(filePath)) {
    return getObjectStream(stripFoundryTags(filePath));
  }
  return fs.createReadStream(filePath);
}

/** Count docs in the OpenSearch index (0 if missing/unreachable). */
async function countOsIndex(indexName: string): Promise<number> {
  try {
    const r = await client.count({ index: indexName });
    return Number((r as any)?.body?.count ?? 0);
  } catch {
    return 0;
  }
}

let runInFlight = false;
const pendingQueue: string[] = [];

async function runOsReindexPipeline(runId: string): Promise<void> {
  try {
    await query(
      `UPDATE opensearch_reindex_run SET status='running', current_stage='merge', updated_at=now() WHERE run_id=$1`,
      [runId],
    );
    const runResult = await query(
      `SELECT ontology_id, object_type_api_name, indexed_count FROM opensearch_reindex_run WHERE run_id=$1`,
      [runId],
    );
    if (runResult.rows.length === 0) return;
    const { ontology_id, object_type_api_name, indexed_count } = runResult.rows[0];
    let skipCount = Number(indexed_count || 0);

    const meta = await loadOsReindexMeta(ontology_id, object_type_api_name);
    // ensure index exists — do NOT deleteIndex on resume (idempotent append).
    try { await createIndex(object_type_api_name); } catch { /* may exist */ }

    // Checkpoint integrity: the `indexed_count` checkpoint is only valid if
    // the OpenSearch index still RETAINS those docs. A worker/process restart
    // leaves the index intact → resume-skip is correct (no restart from zero).
    // But a search-CLUSTER recreate (the dev OpenSearch container's autoheal
    // wiped it mid-run, reproducing the original incident) loses the index →
    // the checkpoint is stale. Detect that and reset to 0: re-indexing is
    // unavoidable when the store lost the data, but it stays BOUNDED.
    const osCount = await countOsIndex(meta.indexName);
    if (osCount < skipCount) {
      console.warn(
        `[os-reindex] run ${runId}: index has ${osCount} docs but checkpoint says ${skipCount} — search store lost data (recreate?); resetting checkpoint to 0 (bounded re-index).`
      );
      skipCount = 0;
      await query(
        `UPDATE opensearch_reindex_run SET indexed_count=0, updated_at=now() WHERE run_id=$1`,
        [runId],
      );
    } else if (skipCount > 0) {
      console.log(
        `[os-reindex] run ${runId}: resuming from checkpoint ${skipCount} (index has ${osCount} docs intact).`
      );
    }

    await query(
      `UPDATE opensearch_reindex_run SET current_stage='indexing', updated_at=now() WHERE run_id=$1`,
      [runId],
    );

    // Stream → bounded merge → ontology docs → SKIP already-indexed → bulk.
    const stream = await openBackingStream(meta.filePath);
    const { rows } = await parseCsvReadable(stream, {
      source: meta.filePath,
      normalizeNulls: true,
    });
    let yielded = 0;
    let skipped = 0;
    const mergedStream = (async function* () {
      for await (const doc of externalHashMerge(rows, {
        primaryKeyColumn: meta.primaryKeyColumn,
        partitionCount: OS_PARTITION_COUNT,
        onMerged: (rawRow) => {
          const d = mapRow(rawRow, meta);
          d.__objectType = object_type_api_name;
          return d;
        },
      })) {
        yielded++;
        if (skipped < skipCount) { skipped++; continue; } // resume-skip
        yield doc;
      }
    })();

    const checkpoint = async (n: number) => {
      await query(
        `UPDATE opensearch_reindex_run SET indexed_count=$2, updated_at=now() WHERE run_id=$1`,
        [runId, n + skipCount],
      );
    };

    const result = await parallelBulkIndex(mergedStream, {
      indexName: meta.indexName,
      concurrency: OS_INDEX_CONCURRENCY,
      onProgress: checkpoint,
    });

    await query(
      `UPDATE opensearch_reindex_run
         SET status='indexed', current_stage='done',
             indexed_count=$2, total_count=$2, duplicate_count=0,
             completed_at=now(), updated_at=now(), error_message=NULL
       WHERE run_id=$1`,
      [runId, skipCount + result.indexedCount],
    );
    console.log(`[os-reindex] run ${runId} indexed: ${skipCount + result.indexedCount} (skipped ${skipCount}, peakConcurrency ${result.peakConcurrency}, retries ${result.retries})`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await query(
      `UPDATE opensearch_reindex_run
         SET status='failed', error_message=$2, updated_at=now()
       WHERE run_id=$1`,
      [runId, msg.slice(0, 1000)],
    );
    console.error(`[os-reindex] run ${runId} failed: ${msg}`);
  } finally {
    runInFlight = false;
    // Drain the queue (one at a time — single worker).
    if (pendingQueue.length > 0) {
      const next = pendingQueue.shift()!;
      runInFlight = true;
      void runOsReindexPipeline(next);
    }
  }
}

/**
 * Start (or resume) an async OpenSearch reindex run. Returns the run_id
 * immediately (202 Accepted semantics); the executor runs fire-and-forget.
 *
 * Resume semantics: if the most recent run for this object type FAILED with a
 * non-zero checkpoint, re-trigger RESUMES that run (re-queues it) instead of
 * starting fresh — the executor's reset-on-wipe / resume-skip then continues
 * from the checkpoint (index intact) or re-indexes bounded (index lost).
 * A completed ('indexed') or checkpoint-less run starts fresh.
 */
export async function startOsReindexRun(
  ontologyId: string,
  apiName: string,
  triggeredBy: string = "manual",
): Promise<string> {
  const latest = await query(
    `SELECT run_id, status, indexed_count
       FROM opensearch_reindex_run
      WHERE ontology_id = $1 AND object_type_api_name = $2
      ORDER BY started_at DESC LIMIT 1`,
    [ontologyId, apiName],
  );
  let runId: string;
  if (
    latest.rows.length > 0 &&
    latest.rows[0].status === "failed" &&
    Number(latest.rows[0].indexed_count) > 0
  ) {
    // Resume the failed run from its checkpoint.
    runId = latest.rows[0].run_id;
    await query(
      `UPDATE opensearch_reindex_run
          SET status='pending', error_message=NULL, updated_at=now()
        WHERE run_id=$1`,
      [runId],
    );
  } else {
    const insert = await query(
      `INSERT INTO opensearch_reindex_run (ontology_id, object_type_api_name, triggered_by)
       VALUES ($1, $2, $3) RETURNING run_id`,
      [ontologyId, apiName, triggeredBy],
    );
    runId = insert.rows[0].run_id;
  }
  // Single-worker queue: if a run is already in flight, enqueue this one.
  if (runInFlight) {
    pendingQueue.push(runId);
  } else {
    runInFlight = true;
    void runOsReindexPipeline(runId);
  }
  return runId;
}

/**
 * Boot sweeper: re-queue 'running' runs orphaned by a prior worker/process
 * crash. The executor's resume-skip continues from the last checkpoint.
 */
export async function resumeOrphanedOsReindexRuns(): Promise<number> {
  const orphans = await query(
    `UPDATE opensearch_reindex_run
        SET status='pending', updated_at=now()
      WHERE status='running'
      RETURNING run_id`,
  );
  for (const row of orphans.rows) {
    if (runInFlight) pendingQueue.push(row.run_id);
    else { runInFlight = true; void runOsReindexPipeline(row.run_id); }
  }
  return orphans.rows.length;
}

export async function getOsReindexRun(runId: string) {
  const r = await query(
    `SELECT run_id, object_type_api_name, status, current_stage, indexed_count, total_count, error_message, started_at, updated_at, completed_at FROM opensearch_reindex_run WHERE run_id=$1`,
    [runId],
  );
  return r.rows[0] ?? null;
}
