// ---------------------------------------------------------------------------
// Reindex Service — Multi-Transaction File Merging Engine
//
// THE MOST IMPORTANT FILE. Implements the 12-step pipeline that reads data
// from a backing datasource (either dataset-backed or legacy file-backed),
// merges multiple transaction files by primary key, applies user edits,
// and indexes the result into OpenSearch.
//
// In Palantir's architecture, this is the "Object Data Funnel" — the
// pipeline that converts raw data from datasets into searchable objects
// in Object Storage V2.
//
// 12-Step Pipeline:
//   1. Load metadata (object type, properties, datasource, dataset)
//   2. Determine transaction files to process
//   3. Read & merge all transaction files (Map keyed by PK, latest wins)
//   4. Apply user edits (ontology_edit table: create/update/delete)
//   5. Build OpenSearch bulk request
//   6. Delete/recreate index
//   7. Execute bulk index
//   8. Mark edits as indexed
//   9. Update funnel_state
//  10. Record reindex history
//  11. Return stats
//
// Must handle both dataset-backed AND legacy file-backed datasources.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { query, getClient } from "../db";
import { appError } from "../utils/appError";
import { convertValue } from "./indexing/typeConverter";
import { client } from "./opensearch/client";
import {
  getIndexName,
} from "./opensearch/indexLifecycleManager";
import { generateIndexMapping } from "./opensearch/indexMappingGenerator";
import { getObjectBuffer, getObjectStream } from "./storageService";
import { parseCsvReadable } from "./indexing/streamingCsv";
import { ensureDocumentSecurity } from "./security/documentSecurity";
import { bulkUpsertInstances } from "../models/objectInstance";
import { deterministicObjectRid } from "./objectIdentity";
import type { PropertyInput } from "./mapping/typeMapper";
import { deriveMainBranchId } from "./branchContext";

// ---------------------------------------------------------------------------
// Pipeline stage tracking — matches the 4-stage Funnel spec
// (ontology-object explorer.md §1.7, item 47).
// ---------------------------------------------------------------------------

type PipelineStage = "changelog" | "merge_changes" | "indexing" | "hydration";

/** Keep the live generation and at most one immediate rollback generation. */
export function obsoleteReindexGenerations(
  generations: readonly string[],
  live: string,
  rollback: string | null,
): string[] {
  const retained = new Set([live, ...(rollback ? [rollback] : [])]);
  return generations.filter((index) => !retained.has(index));
}

/**
 * Write the live pipeline stage into `funnel_pipeline_state`. Called
 * at the start of each major step in `reindexObjectType` so the
 * frontend's status poller can surface which stage is running.
 * Errors are swallowed — stage tracking is best-effort and must
 * never break the core reindex path.
 */
async function setPipelineStage(
  objectTypeApiName: string,
  stage: PipelineStage | null,
  status: "running" | "success" | "failed" = "running",
): Promise<void> {
  try {
    await query(
      `INSERT INTO funnel_pipeline_state
         (object_type_api_name, status, current_stage, stage_started_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (object_type_api_name) DO UPDATE SET
         status = EXCLUDED.status,
         current_stage = EXCLUDED.current_stage,
         stage_started_at = EXCLUDED.stage_started_at,
         updated_at = now()`,
      [objectTypeApiName, status, stage, stage ? new Date() : null],
    );
  } catch (err) {
    console.warn(
      `[Reindex] setPipelineStage failed (best-effort)`,
      (err as Error).message,
    );
  }
}

// ---------------------------------------------------------------------------
// Foundry-dataset bridge helpers
//
// When an object type is backed via `registerWithFoundryDataset`, the
// `backing_datasource.file_path` is a SYNTHETIC string of the form
// `<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>`. The pre-tag
// prefix is the real S3 key stored in `foundry_datasets.file_path`,
// which is uploaded via `storageService.uploadObject` (MinIO-backed).
//
// These helpers let the reindex pipeline transparently read from
// MinIO when the synthetic tag is present, so foundry-bridged object
// types reindex without needing a parallel "Ontology dataset" row.
// ---------------------------------------------------------------------------

function isFoundryBridgedPath(filePath: string | null | undefined): boolean {
  return typeof filePath === "string" && filePath.includes("#foundry-dataset:");
}

function stripFoundryTags(filePath: string): string {
  // Everything before the first `#foundry-dataset:` segment is the
  // real S3 object key.
  const idx = filePath.indexOf("#foundry-dataset:");
  return idx >= 0 ? filePath.slice(0, idx) : filePath;
}

async function readFoundryBridgedFile(
  rawFilePath: string,
  format: string,
): Promise<{ rows: AsyncIterable<Record<string, unknown>> }> {
  const s3Key = stripFoundryTags(rawFilePath);
  if (!s3Key) {
    throw new Error(
      `Foundry-bridged datasource has no resolvable S3 key in '${rawFilePath}'`,
    );
  }

  if (format === "csv" || format === "tsv") {
    // Stream the S3 object straight through csv-parse — never
    // materializing the whole file as a Buffer/string. The legacy path
    // did `getObjectBuffer(s3Key).toString("utf-8")`, which for any file
    // larger than `Buffer.constants.MAX_STRING_LENGTH` (512 MiB) throws
    // "Cannot create a string longer than 0x1fffffe8 characters" and
    // sinks the whole reindex (stuck at changelog/merge). A 5.6 M-row
    // / 854 MB backing CSV hit exactly this. Streaming keeps memory flat
    // at csv-parse's high-water-mark regardless of file size.
    //
    // `normalizeNulls: true` preserves the legacy semantics where empty
    // / null-like cells become SQL NULL before `convertValue` sees them.
    const stream = await getObjectStream(s3Key);
    const { rows } = await parseCsvReadable(stream, {
      source: rawFilePath,
      delimiter: format === "tsv" ? "\t" : ",",
      normalizeNulls: true,
    });
    return { rows };
  }

  if (format === "json" || format === "jsonl") {
    // JSON can't be row-streamed as cheaply as CSV (a top-level array
    // needs the whole document), so the buffered read stays here. The
    // reported breakage is CSV-only; JSON backings are typically small
    // NDJSON/arrays. A >512 MiB JSON backing would need a streaming
    // JSON parser — flagged as a known limitation, not the bug at hand.
    const buffer = await getObjectBuffer(s3Key);
    const trimmed = buffer.toString("utf-8").trim();
    let records: Record<string, unknown>[];
    if (trimmed.startsWith("[")) {
      records = JSON.parse(trimmed);
    } else {
      records = trimmed
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }
    // Wrap the materialized array in an async iterable so the merge loop
    // can use one uniform `for await` contract for CSV (streamed) + JSON.
    const rows: AsyncIterable<Record<string, unknown>> = (async function* () {
      for (const r of records) yield r;
    })();
    return { rows };
  }
  throw new Error(`Unsupported foundry-bridge file format: '${format}'`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReindexResult {
  objectType: string;
  status: "completed";
  transactionsProcessed: number;
  objectsFromDatasource: number;
  editsApplied: {
    creates: number;
    updates: number;
    deletes: number;
  };
  totalObjectsIndexed: number;
  skippedNullPk: number;
  duplicatePkInTransaction: number;
  durationMs: number;
}

interface TransactionFile {
  transaction_id: string;
  file_path: string;
  transaction_type: string;
  committed_at: string;
  /**
   * True for the SYNTHETIC transaction that legacy file-backed and
   * foundry-bridged datasources fabricate below — those have no row in
   * `dataset_transaction`, so their `transaction_id` is a human-readable label
   * ("legacy" / "foundry-bridge"), NOT a uuid. It must never reach
   * `object_instances.source_transaction_id`, which is a `uuid` column: doing so
   * aborts the whole reindex with `invalid input syntax for type uuid:
   * "foundry-bridge"` (a 2026-08-16 production 500 on Force Reindex for every
   * wizard-created object type). The label stays usable for logs and the
   * reindex_history metadata blob.
   */
  synthetic?: boolean;
}

interface ReindexStats {
  skippedNullPk: number;
  duplicatePkInTransaction: number;
  createCount: number;
  updateCount: number;
  deleteCount: number;
}

// ---------------------------------------------------------------------------
// Helper: read a CSV file and return rows
// ---------------------------------------------------------------------------

async function readCsvFile(
  filePath: string
): Promise<{ rows: AsyncIterable<Record<string, unknown>> }> {
  // Stream the disk file through csv-parse instead of `fs.readFileSync` +
  // `parse(content)`. Same MAX_STRING_LENGTH fix as the foundry-bridged
  // path — a local transaction file can also exceed 512 MiB, and the
  // old whole-string read would throw identically. `normalizeNulls`
  // preserves the legacy null-like -> SQL NULL coercion.
  const stream = fs.createReadStream(filePath);
  const { rows } = await parseCsvReadable(stream, {
    source: filePath,
    normalizeNulls: true,
  });
  return { rows };
}

// ---------------------------------------------------------------------------
// Helper: read a JSON file and return rows
// ---------------------------------------------------------------------------

async function readJsonFile(
  filePath: string
): Promise<{ rows: AsyncIterable<Record<string, unknown>> }> {
  // KNOWN LIMITATION (same as the foundry-bridged JSON branch): JSON can't
  // be row-streamed as cheaply as CSV (a top-level array needs the whole
  // document), so this stays a whole-file `readFileSync` + `JSON.parse`. A
  // >512 MiB local JSON/JSONL transaction file would throw the same
  // `Cannot create a string longer than 0x1fffffe8 characters` the CSV
  // streaming path fixed. Large JSON backings are uncommon vs CSV; if one
  // shows up, route it through a streaming JSON parser (JSONL line-stream
  // or a streaming JSON AST reader).
  let content = fs.readFileSync(filePath, "utf-8");

  // Strip BOM
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  content = content.trim();

  let records: Record<string, unknown>[];

  if (content.startsWith("[")) {
    // JSON array
    records = JSON.parse(content);
    if (!Array.isArray(records)) {
      throw new Error("JSON file must contain an array of objects.");
    }
  } else {
    // JSON Lines
    records = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  // Normalize null-like string values
  for (const record of records) {
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (typeof val === "string") {
        const normalized = val.trim().toLowerCase();
        if (
          normalized === "" ||
          normalized === "null" ||
          normalized === "na" ||
          normalized === "n/a"
        ) {
          (record as any)[key] = null;
        }
      }
    }
  }

  // Wrap the materialized array in an async iterable so the merge loop's
  // uniform `for await` contract holds for JSON as well as streamed CSV.
  const rows: AsyncIterable<Record<string, unknown>> = (async function* () {
    for (const r of records) yield r;
  })();
  return { rows };
}

// ---------------------------------------------------------------------------
// Helper: read file based on format
// ---------------------------------------------------------------------------

async function readFile(
  filePath: string,
  format: string
): Promise<{ rows: AsyncIterable<Record<string, unknown>> }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (format === "csv") {
    return readCsvFile(filePath);
  }
  if (format === "json" || format === "jsonl") {
    return readJsonFile(filePath);
  }
  throw new Error(`Unsupported file format: '${format}'`);
}

/**
 * Classify an OpenSearch bulk error as transient (retry-worthy) vs.
 * permanent. Socket resets / timeouts / throttling / server errors are
 * transient — a fresh connection from the pool usually succeeds next try.
 * Per-item 4xx (e.g. a malformed doc) is permanent and is surfaced via the
 * batch's `bulkErrors` collection rather than retried here.
 */
function isTransientBulkError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  const code = String(err?.code ?? err?.name ?? "").toLowerCase();
  if (
    code === "es_connection_error" ||
    code === "response_timeout" ||
    code === "not_found_connection"
  ) {
    return true;
  }
  if (
    /epipe|econnreset|econnrefused|etimedout|socket hang up|write epipe|connection|timeout|reset by peer/.test(
      msg,
    )
  ) {
    return true;
  }
  const status: number | undefined =
    err?.meta?.statusCode ?? err?.statusCode ?? err?.status;
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Parse a positive-integer env override with a safe default. A bare
 * `Number(process.env.X ?? def)` silently yields NaN (non-numeric value),
 * 0, or a negative for misconfigurations like `REINDEX_BULK_BATCH_DOCS=abc`
 * / `=0` / `= ` — which would either never flush (NaN → one giant bulk) or
 * flush every single doc (0 → 5.6 M one-doc bulks), reintroducing the exact
 * memory/request-size blowup the streaming + batching fix removed. Fail loud
 * is not an option at boot, so fall back to the documented default instead.
 */
function parsePositiveIntEnv(
  value: string | undefined,
  def: number,
): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// ---------------------------------------------------------------------------
// Main: reindexObjectType
//
// Performs a complete reindex of a single object type through a 12-step
// pipeline.
// ---------------------------------------------------------------------------

export async function reindexObjectType(
  ontologyId: string,
  objectTypeApiName: string
): Promise<ReindexResult> {
  const startTime = Date.now();
  const stats: ReindexStats = {
    skippedNullPk: 0,
    duplicatePkInTransaction: 0,
    createCount: 0,
    updateCount: 0,
    deleteCount: 0,
  };

  let objectTypeId: string;
  /** Label of the last transaction merged — for logs and reindex_history only. */
  let lastTransactionId: string | null = null;
  /**
   * The same value, but ONLY when it is a real `dataset_transaction` uuid. This
   * is the one that may be written to `object_instances.source_transaction_id`
   * (a `uuid` column). Synthetic labels stay null here — see
   * TransactionFile.synthetic.
   */
  let lastTransactionUuid: string | null = null;
  let replacementIndexName: string | null = null;
  let replacementCutoverComplete = false;
  let rollbackIndexName: string | null = null;

  try {
    // =================================================================
    // Stage 1: CHANGELOG — load metadata + read every committed
    // transaction / file into memory. Spec §1.7 item 47 calls this
    // the "changelog" stage: assemble the ordered sequence of
    // changes that need to be merged.
    // =================================================================
    await setPipelineStage(objectTypeApiName, "changelog");

    // Get object type
    const otResult = await query(
      `SELECT ot.object_type_id, ot.api_name, ot.primary_key_property_id
       FROM object_type ot
       JOIN ontology o ON ot.ontology_id = o.ontology_id
       WHERE o.ontology_id = $1 AND ot.api_name = $2`,
      [ontologyId, objectTypeApiName]
    );
    if (otResult.rows.length === 0) {
      throw appError(
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${objectTypeApiName}' not found in ontology '${ontologyId}'.`,
        { failedAtStep: "metadata_load" }
      );
    }
    const objectTypeRow = otResult.rows[0];
    objectTypeId = objectTypeRow.object_type_id;

    // Get properties
    const propsResult = await query(
      `SELECT property_id, api_name, base_type, is_required, is_array,
              struct_schema
       FROM property
       WHERE object_type_id = $1
       ORDER BY ordinal, api_name`,
      [objectTypeId]
    );
    const properties = propsResult.rows;
    const propertiesMap = new Map<string, any>();
    for (const prop of properties) {
      propertiesMap.set(prop.api_name, prop);
    }

    // Identify required properties
    const requiredProperties = properties.filter(
      (p: any) => p.is_required === true
    );

    // Get backing datasource
    const dsResult = await query(
      `SELECT bs.*, d.file_format as dataset_format, d.name as dataset_name
       FROM backing_datasource bs
       LEFT JOIN dataset d ON bs.dataset_id = d.dataset_id
       WHERE bs.object_type_id = $1`,
      [objectTypeId]
    );
    if (dsResult.rows.length === 0) {
      throw appError(
        "NO_BACKING_DATASOURCE",
        `Object type '${objectTypeApiName}' has no registered backing datasource. Register one first.`,
        { failedAtStep: "metadata_load" }
      );
    }
    const datasource = dsResult.rows[0];

    const columnMapping: Record<string, string> =
      typeof datasource.column_mapping === "string"
        ? JSON.parse(datasource.column_mapping)
        : datasource.column_mapping || {};
    const primaryKeyColumn: string = datasource.primary_key_column;

    // Resolve primary key property api_name
    let primaryKeyPropertyApiName: string | null = null;
    if (objectTypeRow.primary_key_property_id) {
      const pkProp = properties.find(
        (p: any) => p.property_id === objectTypeRow.primary_key_property_id
      );
      primaryKeyPropertyApiName = pkProp ? pkProp.api_name : null;
    }

    console.log(
      `[Reindex] Step 1: Loaded metadata for '${objectTypeApiName}' — ` +
        `${properties.length} properties, PK column: '${primaryKeyColumn}'`
    );

    // =================================================================
    // Step 2: Determine which files to read
    // =================================================================

    let transactions: TransactionFile[] = [];
    let datasetFormat: string = "csv"; // Default for legacy

    if (datasource.dataset_id) {
      // Case A: dataset-backed
      datasetFormat = datasource.dataset_format || "csv";

      const txnResult = await query(
        `SELECT transaction_id, file_path, transaction_type, committed_at
         FROM dataset_transaction
         WHERE dataset_id = $1 AND status = 'committed'
           AND (metadata->>'superseded' IS NULL OR metadata->>'superseded' != 'true')
         ORDER BY committed_at ASC`,
        [datasource.dataset_id]
      );
      transactions = txnResult.rows;
    } else {
      // Case B: legacy file-backed  OR  Case C: foundry-dataset bridged
      //
      // Both land here because they share a single synthetic
      // "transaction" (no committed `dataset_transaction` rows).
      // The distinction is made further down in Step 3 when the
      // file is actually read: `isFoundryBridgedPath` decides
      // whether to pull from MinIO or from local disk.
      transactions = [
        {
          transaction_id: isFoundryBridgedPath(datasource.file_path)
            ? "foundry-bridge"
            : "legacy",
          file_path: datasource.file_path,
          transaction_type: "SNAPSHOT",
          committed_at: new Date().toISOString(),
          // Not a uuid — see TransactionFile.synthetic.
          synthetic: true,
        },
      ];
      // Format detection: prefer the explicit `file_format` column
      // (foundry uploads always set this), then fall back to the
      // file extension of the pre-tag S3 key for safety.
      if (datasource.file_format) {
        datasetFormat = datasource.file_format;
      } else {
        const cleanPath = isFoundryBridgedPath(datasource.file_path)
          ? stripFoundryTags(datasource.file_path)
          : datasource.file_path;
        const ext = path.extname(cleanPath).toLowerCase();
        if (ext === ".json" || ext === ".jsonl") {
          datasetFormat = "json";
        } else {
          datasetFormat = "csv";
        }
      }
    }

    if (transactions.length === 0) {
      throw appError(
        "NO_BACKING_DATASOURCE",
        `Object type '${objectTypeApiName}' has no committed transaction files to index.`,
        { failedAtStep: "file_read" }
      );
    }

    console.log(
      `[Reindex] Step 2: Found ${transactions.length} transaction(s) to process`
    );

    // =================================================================
    // Stage 2: MERGE CHANGES — read every transaction file in
    // chronological order into a single `Map<pk, row>`. SNAPSHOTs
    // clear the map; APPENDs overlay. This is the "merge changes"
    // stage from the Funnel spec — we collapse the changelog into
    // the final state we'll hand to the indexer.
    // =================================================================
    await setPipelineStage(objectTypeApiName, "merge_changes");

    const objectMap = new Map<string, Record<string, unknown>>();

    // BOUNDED, and honest about why. The transaction FILES are streamed
    // (parseCsvReadable), so we no longer materialise a 5.6 M-row array before
    // the merge starts — but this Map is still O(distinct PKs) live objects,
    // each holding a full property doc. At a few million objects that is
    // multiple GB of heap, and the failure mode is the worst kind: V8
    // aborts the WHOLE Node process on OOM, so one oversized Force Reindex
    // takes down every unrelated request in flight, and the run's own
    // funnel_run row is left stranded at status='running' with no error
    // recorded (there is no catch block that survives an OOM abort).
    //
    // This guard does NOT make the legacy reindex path scale — it converts an
    // unattributable process kill into a clean, attributable, per-object-type
    // error that names the object type, the count, and the knob. Genuinely
    // fixing it means spilling the merge to disk (DuckDB, as the OSv2 funnel's
    // mergeChangesSQL already does) instead of collapsing it in heap; that is
    // the Object Storage V2 funnel path, which is why large types should go
    // through the funnel rather than Force Reindex.
    const REINDEX_MAX_MERGED_OBJECTS = parsePositiveIntEnv(
      process.env.REINDEX_MAX_MERGED_OBJECTS,
      2_000_000,
    );
    const assertMergeBudget = () => {
      if (objectMap.size <= REINDEX_MAX_MERGED_OBJECTS) return;
      throw appError(
        "REINDEX_TOO_LARGE",
        `Object type '${objectTypeApiName}' merged past ${REINDEX_MAX_MERGED_OBJECTS} distinct primary keys, ` +
          `the in-memory limit for the datasource reindex path. Aborting before the process runs out of heap. ` +
          `Index this object type through the Object Storage V2 funnel (which merges on disk via DuckDB), ` +
          `or raise REINDEX_MAX_MERGED_OBJECTS if this process has headroom for it.`,
        { failedAtStep: "merge_changes" },
      );
    };

    for (const txn of transactions) {
      // Rows now arrive as an async iterable (streamed from S3/disk via
      // `parseCsvReadable`) rather than a materialized array, so a 5.6 M-row
      // backing file no longer OOMs the process before the merge even starts.
      let rowSource: AsyncIterable<Record<string, unknown>>;
      try {
        // Case C (foundry-dataset bridge): the synthetic file_path
        // contains `#foundry-dataset:<uuid>` — we strip the tag to
        // get the real MinIO object key and read via the storage
        // client, bypassing the local-filesystem `readFile` path
        // entirely. This is what makes wizard-created object types
        // (which upload to MinIO via the foundry pipeline) actually
        // indexable without requiring an Ontology `dataset_transaction`.
        //
        // Case A and Case B continue through the legacy disk reader.
        const fileResult = isFoundryBridgedPath(txn.file_path)
          ? await readFoundryBridgedFile(txn.file_path, datasetFormat)
          : await readFile(txn.file_path, datasetFormat);
        rowSource = fileResult.rows;
      } catch (err: any) {
        throw appError(
          "REINDEX_FAILED",
          `Failed to read transaction file '${txn.file_path}': ${err.message}`,
          { failedAtStep: "file_read", transactionId: txn.transaction_id }
        );
      }

      // For SNAPSHOT transactions, clear the map (replace all data)
      if (txn.transaction_type === "SNAPSHOT") {
        objectMap.clear();
      }

      // Track duplicate PKs within this single transaction
      const seenInTransaction = new Set<string>();

      for await (const row of rowSource) {
        const pkRawValue = row[primaryKeyColumn];

        // Skip rows with null/empty primary key
        if (
          pkRawValue === null ||
          pkRawValue === undefined ||
          String(pkRawValue).trim() === ""
        ) {
          stats.skippedNullPk++;
          continue;
        }

        const pkStr = String(pkRawValue).trim();

        // Same PK seen earlier in THIS transaction. Re-snapshot / CDC
        // sources legitimately re-record an object with updated values
        // (the orders_bureau_transactional_system.part01.csv backing has
        // ~949 K such updated duplicates across 5.6 M rows — same order_id,
        // different quantity/dates). The merge's `objectMap.set` below
        // implements "last row wins" (the most recent state of the object),
        // which is the correct semantics for updates and is already how
        // cross-transaction duplicates are resolved. Throwing here (the old
        // behaviour) was inconsistent with that and broke any re-snapshot
        // datasource the moment it was large enough to reach this check
        // (before the streaming-read fix it died earlier at MAX_STRING_LENGTH
        // and masked this guard). Count + continue so operators still see
        // the duplicates in the run stats without blocking the index.
        if (seenInTransaction.has(pkStr)) {
          stats.duplicatePkInTransaction++;
          // fall through — objectMap.set below overwrites with this (latest) row
        } else {
          seenInTransaction.add(pkStr);
        }

        // Map CSV/JSON columns to Ontology properties using columnMapping
        const doc: Record<string, unknown> = {};
        for (const [propApiName, columnName] of Object.entries(
          columnMapping
        )) {
          const rawValue = row[columnName];
          const property = propertiesMap.get(propApiName);
          if (property) {
            // Convert value to proper type
            const propInput: PropertyInput = {
              api_name: property.api_name,
              base_type: property.base_type,
              is_array: property.is_array || false,
              is_required: property.is_required || false,
              struct_schema: property.struct_schema || null,
            };
            const converted = convertValue(
              rawValue === null || rawValue === undefined
                ? null
                : String(rawValue),
              propInput
            );
            doc[propApiName] = converted.value;
          }
        }

        // "Most recent row wins" across the changelog. For a re-snapshot
        // (a duplicate PK within this transaction) merge field-by-field and
        // DON'T let a null/missing cell on the later row null out a real
        // value the earlier row set: a ragged shorter row under
        // relax_column_count omits the column → rawValue undefined →
        // convertValue→null, and a blind objectMap.set would clobber the
        // real value with null (silent data loss). Latest-non-null wins.
        const existing = objectMap.get(pkStr);
        if (existing) {
          for (const [k, v] of Object.entries(doc)) {
            if (v !== null && v !== undefined) existing[k] = v;
          }
        } else {
          objectMap.set(pkStr, doc);
          // Only a NEW key can grow the map, so check on that edge only —
          // an overwrite of an existing key is memory-neutral.
          if (objectMap.size % 50_000 === 0) assertMergeBudget();
        }
      }

      lastTransactionId = txn.transaction_id;
      lastTransactionUuid = txn.synthetic ? null : txn.transaction_id;
    }

    // The sampled check above fires every 50 000 new keys, so a run that ends
    // just past the budget slips through it. Check once more on the exact
    // final size before committing to the indexing stage.
    assertMergeBudget();

    // Capture datasource count BEFORE applying edits
    const objectsFromDatasource = objectMap.size;

    console.log(
      `[Reindex] Step 3: Merged ${transactions.length} transaction(s) → ` +
        `${objectsFromDatasource} objects (${stats.skippedNullPk} skipped null PK, ${stats.duplicatePkInTransaction} duplicate-PK updates applied last-wins)`
    );

    // =================================================================
    // Step 4: Check for required property violations
    // =================================================================

    for (const [pk, doc] of objectMap) {
      for (const prop of requiredProperties) {
        if (
          doc[prop.api_name] === null ||
          doc[prop.api_name] === undefined
        ) {
          throw appError(
            "REINDEX_FAILED",
            `Required property '${prop.api_name}' has null value for object with primary key '${pk}'. Reindex aborted.`,
            { failedAtStep: "required_property_validation" }
          );
        }
      }
    }

    console.log(
      `[Reindex] Step 4: Required property validation passed`
    );

    // =================================================================
    // Step 5 (Duplicate PK check): Integrated into Step 3 above
    // =================================================================

    // =================================================================
    // Step 6: Apply user edits (edit preservation)
    // =================================================================

    const editsResult = await query(
      `SELECT * FROM ontology_edit
       WHERE object_type_api_name = $1 AND indexed = false
       ORDER BY executed_at ASC`,
      [objectTypeApiName]
    );
    const pendingEdits = editsResult.rows;
    const editIds: string[] = [];

    for (const edit of pendingEdits) {
      editIds.push(edit.edit_id);

      switch (edit.operation) {
        case "create":
          // User created an object not in the datasource
          objectMap.set(
            edit.primary_key,
            edit.property_values || {}
          );
          stats.createCount++;
          break;

        case "update": {
          // User modified properties — merge with existing, user values win
          const existing = objectMap.get(edit.primary_key) || {};
          objectMap.set(edit.primary_key, {
            ...existing,
            ...(edit.property_values || {}),
          });
          stats.updateCount++;
          break;
        }

        case "delete":
          // User deleted an object — remove from map
          objectMap.delete(edit.primary_key);
          stats.deleteCount++;
          break;
      }
    }

    console.log(
      `[Reindex] Step 6: Applied ${pendingEdits.length} user edits ` +
        `(${stats.createCount} creates, ${stats.updateCount} updates, ${stats.deleteCount} deletes)`
    );

    // =================================================================
    // Stage 3: INDEXING — build the OpenSearch bulk body, recreate
    // the per-object-type index, and push every merged document.
    // This is the "indexing" stage from the Funnel spec: the
    // merged state lands in the search store.
    // =================================================================
    await setPipelineStage(objectTypeApiName, "indexing");

    const indexName = getIndexName(objectTypeApiName);
    // Snapshot the serving generation before creating the replacement. A
    // Funnel sync can create the canonical index asynchronously; resolving it
    // after a long bulk write would mistake that concurrent index for the
    // generation this run must preserve as rollback state.
    let servingIndices: string[] = [];
    let canonicalIsAlias = false;
    try {
      const aliases = await client.indices.getAlias({ name: indexName });
      const aliasBody = (aliases as any)?.body ?? {};
      servingIndices = Object.keys(aliasBody);
      canonicalIsAlias = servingIndices.length > 0;
      rollbackIndexName =
        servingIndices.find(
          (candidate) =>
            aliasBody[candidate]?.aliases?.[indexName]?.is_write_index === true,
        ) ??
        servingIndices[0] ??
        null;
    } catch {
      const exists = await client.indices.exists({ index: indexName });
      if ((exists as any)?.body === true) servingIndices = [indexName];
    }
    // Millisecond timestamps alone collide when a previously interrupted
    // process is restarted with a restored/frozen clock. The replacement is
    // never a durable identifier, so add entropy while retaining a sortable
    // timestamp prefix for operations and lifecycle cleanup.
    // =================================================================
    // Step 8: Create an isolated sibling index. The serving index/alias is
    // left untouched until every replacement document has landed.
    // =================================================================
    try {
      const generated = await generateIndexMapping(objectTypeApiName, ontologyId);
      let created = false;
      let lastCreateError: Error | null = null;
      // An interrupted client can receive a create retry after OpenSearch has
      // already accepted the first request. Treat name contention as a normal
      // allocation retry; any other create failure remains terminal.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        replacementIndexName =
          `${indexName}-replacement-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        try {
          await client.indices.create({
            index: replacementIndexName,
            body: generated.mapping as unknown as Record<string, unknown>,
          });
          created = true;
          break;
        } catch (err: any) {
          lastCreateError = err;
          if (!String(err?.message ?? err).includes("resource_already_exists_exception")) {
            throw err;
          }
        }
      }
      if (!created) throw lastCreateError ?? new Error("replacement index allocation failed");
    } catch (err: any) {
      throw appError(
        "REINDEX_FAILED",
        `Failed to create replacement OpenSearch index '${replacementIndexName}': ${err.message}`,
        { failedAtStep: "opensearch_indexing" }
      );
    }
    if (!replacementIndexName) {
      throw appError(
        "REINDEX_FAILED",
        "Replacement index allocation completed without an index name.",
        { failedAtStep: "opensearch_indexing" },
      );
    }

    console.log(
      `[Reindex] Step 8: Replacement index '${replacementIndexName}' created; serving '${indexName}' remains online`
    );

    // =================================================================
    // Step 7 + 9: Batched bulk index. The old path built ONE giant
    // `bulkBody` array (2 entries per object — action + doc) for the whole
    // merged map, then issued a single `client.bulk` with it. For a 5.6 M-
    // row object type that's an 11.2 M-entry array (~GBs) AND a single
    // OpenSearch request far past its budget. Stream the map through fixed-
    // size batches instead — memory stays bounded by `BULK_BATCH_DOCS`,
    // not by the object count, and each batch is a normal-sized bulk
    // request. `refresh` is deferred to the final batch so the index only
    // pays the refresh cost once the whole run has landed.
    // =================================================================

    const BULK_BATCH_DOCS = parsePositiveIntEnv(
      process.env.REINDEX_BULK_BATCH_DOCS,
      2000,
    );
    // Bulk writes are NOT read-SLO traffic. The shared opensearch client is
    // capped at a 5 s `requestTimeout` (F-P4-04) so a single slow read can't
    // head-of-line-block the process — but a 2000-doc bulk into a growing
    // index (segment merges, refresh) legitimately takes longer than 5 s, so
    // that cap turns every bulk past ~1 M docs into a "socket hang up" /
    // ECONNRESET. Override the timeout per bulk call so writes aren't bound
    // by the read SLO. Reads still use the 5 s default.
    const BULK_REQUEST_TIMEOUT = parsePositiveIntEnv(
      process.env.OPENSEARCH_BULK_REQUEST_TIMEOUT,
      60_000,
    );
    const totalDocs = objectMap.size;
    let indexedCount = 0;
    const bulkErrors: any[] = [];
    const batch: Record<string, unknown>[] = [];
    let batchDocs = 0;
    let processedDocs = 0;

    const flushBatch = async (refresh: boolean | "wait_for") => {
      if (batch.length === 0) return;
      // The `index` action is keyed by `_id`, so a retried batch is
      // idempotent (re-indexing the same _id overwrites). Sustained bulk
      // load against a small cluster occasionally drops a socket
      // (write EPIPE / ECONNRESET / timeout / 429 / 5xx) — retry the
      // batch a few times with backoff before failing the whole run.
      const MAX_BULK_ATTEMPTS = 4;
      let result: any;
      for (let attempt = 1; attempt <= MAX_BULK_ATTEMPTS; attempt++) {
        try {
          result = await client.bulk(
            { body: batch, refresh },
            // Per-call transport override: bulk writes are not bound by the
            // 5 s read SLO (see BULK_REQUEST_TIMEOUT above). Passed as the
            // transport-options arg, not a Bulk_Request field.
            { requestTimeout: BULK_REQUEST_TIMEOUT },
          );
          break;
        } catch (err: any) {
          if (isTransientBulkError(err) && attempt < MAX_BULK_ATTEMPTS) {
            console.warn(
              `[Reindex] bulk batch failed (attempt ${attempt}/${MAX_BULK_ATTEMPTS}): ${err.message}; retrying…`
            );
            await new Promise((r) => setTimeout(r, 500 * attempt));
            continue;
          }
          if (err.code === "REINDEX_FAILED") throw err;
          throw appError(
            "REINDEX_FAILED",
            `OpenSearch bulk indexing failed: ${err.message}`,
            { failedAtStep: "opensearch_indexing" }
          );
        }
      }
      const items: any[] = result?.body?.items || [];
      for (const item of items) {
        if (
          item.index?.status === 200 ||
          item.index?.status === 201
        ) {
          indexedCount++;
        } else if (item.index?.error && bulkErrors.length < 10) {
          bulkErrors.push(item.index.error);
        }
      }
      batch.length = 0;
      batchDocs = 0;
    };

    const instanceRows: import("../models/objectInstance").UpsertInstanceInput[] = [];
    for (const [pk, doc] of objectMap) {
      // Phase A4 (F-03) — stamp `_security.markings` via the shared helper
      // so reindexed docs are visible to marking-constrained users. The
      // helper is idempotent: if the source doc already carries
      // `_security`, its classification is preserved.
      const secured = ensureDocumentSecurity({
        __pk: pk,
        // Phase 2 (object identity): persist-stable rid on reindex.
        __rid:
          (doc.__rid as string | undefined) ??
          deterministicObjectRid(ontologyId, objectTypeApiName, pk),
        __objectType: objectTypeApiName,
        __ontology: ontologyId,
        __lastModified: new Date().toISOString(),
        __version: 1,
        ...doc,
      });
      batch.push({ index: { _index: replacementIndexName, _id: pk } });
      batch.push(secured);
      // Rwanda QA §3.4 — the direct read-by-primary-key path resolves from
      // object_instances; a datasource reindex must leave it populated too,
      // otherwise read-your-writes breaks for every datasource-backed type.
      instanceRows.push({
        ontology_id: ontologyId,
        object_type_api_name: objectTypeApiName,
        primary_key: pk,
        properties: doc,
        markings: secured._security?.markings ?? [],
        source_datasource_id: null,
        // NOT lastTransactionId — that may be a synthetic label
        // ("foundry-bridge" / "legacy") and this column is a `uuid`.
        source_transaction_id: lastTransactionUuid,
      });
      batchDocs++;
      processedDocs++;
      if (batchDocs >= BULK_BATCH_DOCS) {
        await flushBatch(processedDocs >= totalDocs ? "wait_for" : false);
        await bulkUpsertInstances(instanceRows.splice(0));
      }
    }
    // Flush any trailing partial batch (no-op if the last full batch above
    // already wait_for'd — in which case `batch` is empty).
    await flushBatch("wait_for");
    await bulkUpsertInstances(instanceRows.splice(0));

    // The datasource documents above are assembled before Object Storage's
    // upsert decides whether an existing row keeps or increments its version.
    // Synchronize the authoritative versions into the replacement index
    // before cutover; hard-coding `__version: 1` made every browser selection
    // stale after the second seed/reindex run.
    const versionRows = await query(
      `SELECT primary_key, version
         FROM object_instances
        WHERE ontology_id = $1
          AND branch_id = $2
          AND object_type_api_name = $3
          -- A recreated datasource can legitimately omit a row that remains
          -- in object_instances from a prior action/writeback. Only update
          -- documents materialized into this replacement index; otherwise
          -- OpenSearch rejects the bulk update as a missing document.
          AND primary_key = ANY($4::text[])`,
      [
        ontologyId,
        deriveMainBranchId(ontologyId),
        objectTypeApiName,
        [...objectMap.keys()],
      ],
    );
    for (let offset = 0; offset < versionRows.rows.length; offset += 1_000) {
      const versionBody: Array<Record<string, unknown>> = [];
      for (const row of versionRows.rows.slice(offset, offset + 1_000)) {
        versionBody.push({ update: { _index: replacementIndexName, _id: row.primary_key } });
        versionBody.push({ doc: { __version: Number(row.version) } });
      }
      if (versionBody.length > 0) {
        const versionResult = await client.bulk({
          body: versionBody,
          refresh: offset + 1_000 >= versionRows.rows.length ? "wait_for" : false,
        } as any);
        if ((versionResult as any)?.body?.errors) {
          throw appError(
            "REINDEX_FAILED",
            "Failed to synchronize object versions into the replacement index.",
            { failedAtStep: "opensearch_version_sync" },
          );
        }
      }
    }

    if (bulkErrors.length > 0) {
      throw appError(
        "REINDEX_FAILED",
        `Bulk indexing failed for some objects. First error: ${JSON.stringify(bulkErrors[0])}`,
        { failedAtStep: "opensearch_indexing" }
      );
    }

    console.log(
      `[Reindex] Step 7+9: Indexed ${indexedCount} of ${totalDocs} objects into '${replacementIndexName}'`
    );

    // Confirm the replacement is complete before cutover. A mismatch means
    // the sibling is discarded and the serving generation remains intact.
    const replacementCount = await client.count({
      index: replacementIndexName,
    });
    const actualReplacementCount = Number(
      (replacementCount as any)?.body?.count ?? 0,
    );
    if (actualReplacementCount !== totalDocs) {
      throw appError(
        "REINDEX_FAILED",
        `Replacement index count mismatch: expected ${totalDocs}, got ${actualReplacementCount}.`,
        { failedAtStep: "opensearch_validation" },
      );
    }

    if (!canonicalIsAlias && servingIndices.includes(indexName)) {
      rollbackIndexName =
        `${indexName}-rollback-${Date.now().toString(36)}`;
      const generated = await generateIndexMapping(
        objectTypeApiName,
        ontologyId,
      );
      await client.indices.create({
        index: rollbackIndexName,
        body: generated.mapping as unknown as Record<string, unknown>,
      });
      await client.reindex({
        body: {
          source: { index: indexName },
          dest: { index: rollbackIndexName },
        },
        wait_for_completion: true,
        refresh: true,
      } as any);
      const rollbackCount = await client.count({ index: rollbackIndexName });
      const actualRollbackCount = Number(
        (rollbackCount as any)?.body?.count ?? 0,
      );
      const servingCount = await client.count({ index: indexName });
      const expectedRollbackCount = Number(
        (servingCount as any)?.body?.count ?? 0,
      );
      if (actualRollbackCount !== expectedRollbackCount) {
        throw appError(
          "REINDEX_FAILED",
          `Rollback copy count mismatch: expected ${expectedRollbackCount}, got ${actualRollbackCount}.`,
          { failedAtStep: "opensearch_rollback_copy" },
        );
      }
    }

    // If no serving generation existed when this run started, a concurrently
    // dispatched Funnel sync may have created the canonical index while the
    // replacement was bulk-indexing. It cannot be a rollback source, because
    // it was never serving at this run's snapshot. Only remove it when it has
    // converged to the exact replacement cardinality; otherwise fail closed
    // rather than cutting over around an incomplete concurrent writer.
    if (!canonicalIsAlias && servingIndices.length === 0) {
      const lateCanonicalExists = await client.indices.exists({ index: indexName });
      if ((lateCanonicalExists as any)?.body === true) {
        let actualLateCanonicalCount = -1;
        // The competing sync may have created its index just before its final
        // bulk/refresh. Give that in-flight writer a short, bounded window to
        // converge; a different or stalled writer is still rejected below.
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const lateCanonicalCount = await client.count({ index: indexName });
          actualLateCanonicalCount = Number(
            (lateCanonicalCount as any)?.body?.count ?? 0,
          );
          if (actualLateCanonicalCount === totalDocs) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        if (actualLateCanonicalCount !== totalDocs) {
          throw appError(
            "REINDEX_FAILED",
            `Concurrent canonical index count mismatch: expected ${totalDocs}, got ${actualLateCanonicalCount}.`,
            { failedAtStep: "opensearch_concurrent_indexing" },
          );
        }
        servingIndices = [indexName];
      }
    }

    const aliasActions: Array<Record<string, unknown>> = [];
    if (canonicalIsAlias) {
      for (const oldIndex of servingIndices) {
        aliasActions.push({
          remove: { index: oldIndex, alias: indexName },
        });
      }
    } else if (servingIndices.includes(indexName)) {
      aliasActions.push({ remove_index: { index: indexName } });
    }
    aliasActions.push({
      add: {
        index: replacementIndexName,
        alias: indexName,
        is_write_index: true,
      },
    });
    await client.indices.updateAliases({
      body: { actions: aliasActions },
    });
    replacementCutoverComplete = true;
    console.log(
      `[Reindex] Cutover: alias '${indexName}' now serves '${replacementIndexName}'` +
        (rollbackIndexName
          ? `; rollback generation retained as '${rollbackIndexName}'`
          : ""),
    );

    // Successful reindexes used to retain every historical sibling forever.
    // Frequent clean-seed QA runs therefore exhausted OpenSearch's shard
    // ceiling. Retain only the live generation and its immediate predecessor;
    // older siblings have no alias and cannot participate in rollback.
    try {
      const generations = await client.indices.get({
        index: `${indexName}-replacement-*,${indexName}-rollback-*`,
        allow_no_indices: true,
        ignore_unavailable: true,
      } as any);
      const names = Object.keys((generations as any)?.body ?? {});
      const obsolete = obsoleteReindexGenerations(
        names,
        replacementIndexName,
        rollbackIndexName,
      );
      if (obsolete.length > 0) {
        await client.indices.delete({ index: obsolete.join(",") });
      }
    } catch (cleanupError) {
      console.warn(
        `[Reindex] historical generation cleanup failed (best-effort): ${(cleanupError as Error).message}`,
      );
    }

    // =================================================================
    // Stage 4: HYDRATION — mark the `ontology_edit` rows as indexed
    // so the next pass through `checkReindexNeeded` treats them as
    // caught-up, bump `funnel_state` to `indexed`, and record the
    // run in `reindex_history`. Spec §1.7 names this stage "hydration":
    // everything downstream of the search index gets caught up to
    // the new state of the world.
    // =================================================================
    await setPipelineStage(objectTypeApiName, "hydration");

    if (editIds.length > 0) {
      await query(
        `UPDATE ontology_edit SET indexed = true, indexed_at = now()
         WHERE edit_id = ANY($1)`,
        [editIds]
      );
    }

    console.log(
      `[Reindex] Hydration: marked ${editIds.length} edits as indexed`
    );

    // =================================================================
    // Step 11: Update funnel_state
    // =================================================================

    const durationMs = Date.now() - startTime;

    await query(
      `INSERT INTO funnel_state (object_type_id, status, objects_indexed, last_indexed_at,
         last_index_duration_ms, error_message, index_name)
       VALUES ($1, 'indexed', $2, now(), $3, NULL, $4)
       ON CONFLICT (object_type_id) DO UPDATE SET
         status = 'indexed',
         objects_indexed = EXCLUDED.objects_indexed,
         last_indexed_at = EXCLUDED.last_indexed_at,
         last_index_duration_ms = EXCLUDED.last_index_duration_ms,
         error_message = NULL,
         index_name = EXCLUDED.index_name,
         updated_at = now()`,
      [objectTypeId, indexedCount, durationMs, indexName]
    );

    // Also update funnel_pipeline_state if it exists. Clears
    // `current_stage` so the frontend status poller sees the
    // pipeline has settled and can drop the spinner.
    try {
      await query(
        `INSERT INTO funnel_pipeline_state
           (object_type_api_name, status, current_stage, stage_started_at,
            last_indexed_at, objects_indexed, duration_ms, error_message, updated_at)
         VALUES ($1, 'success', NULL, NULL, now(), $2, $3, NULL, now())
         ON CONFLICT (object_type_api_name) DO UPDATE SET
           status = 'success',
           current_stage = NULL,
           stage_started_at = NULL,
           last_indexed_at = now(),
           objects_indexed = $2,
           duration_ms = $3,
           error_message = NULL,
           updated_at = now()`,
        [objectTypeApiName, indexedCount, durationMs]
      );
    } catch {
      // Non-critical — funnel_pipeline_state may not exist
    }

    console.log(
      `[Reindex] Step 11: Updated funnel_state to 'indexed' ` +
        `(${indexedCount} objects, ${durationMs}ms)`
    );

    // =================================================================
    // Step 12: Record reindex history
    // =================================================================

    await query(
      `INSERT INTO reindex_history
         (object_type_api_name, status, triggered_by, started_at,
          completed_at, duration_ms, transactions_processed,
          objects_from_datasource, edits_applied, total_objects_indexed,
          error_message, metadata)
       VALUES ($1, 'success', 'manual', $2, now(), $3, $4, $5, $6, $7, NULL, $8)`,
      [
        objectTypeApiName,
        new Date(startTime).toISOString(),
        durationMs,
        transactions.length,
        objectsFromDatasource,
        pendingEdits.length,
        indexedCount,
        JSON.stringify({
          lastTransactionId,
          replacementIndexName,
          rollbackIndexName,
          skippedNullPk: stats.skippedNullPk,
          duplicatePkInTransaction: stats.duplicatePkInTransaction,
          editsBreakdown: {
            creates: stats.createCount,
            updates: stats.updateCount,
            deletes: stats.deleteCount,
          },
        }),
      ]
    );

    console.log(
      `[Reindex] Step 12: Recorded reindex history. Pipeline complete.`
    );

    // =================================================================
    // Return result
    // =================================================================

    return {
      objectType: objectTypeApiName,
      status: "completed",
      transactionsProcessed: transactions.length,
      objectsFromDatasource,
      editsApplied: {
        creates: stats.createCount,
        updates: stats.updateCount,
        deletes: stats.deleteCount,
      },
      totalObjectsIndexed: indexedCount,
      skippedNullPk: stats.skippedNullPk,
      duplicatePkInTransaction: stats.duplicatePkInTransaction,
      durationMs,
    };
  } catch (err: any) {
    // =================================================================
    // Error handling: update funnel_state to 'failed'
    // =================================================================
    const durationMs = Date.now() - startTime;

    // Before cutover, a failed sibling is never allowed to affect the live
    // alias. Best-effort cleanup keeps retries idempotent.
    if (replacementIndexName && !replacementCutoverComplete) {
      try {
        await client.indices.delete({ index: replacementIndexName });
      } catch {
        // The sibling may not have been created, or OpenSearch may be down.
      }
    }

    // Try to update funnel_state with failure info
    try {
      if (objectTypeId!) {
        await query(
          `UPDATE funnel_state
           SET status = 'failed',
               error_message = $1,
               last_index_duration_ms = $2,
               updated_at = now()
           WHERE object_type_id = $3`,
          [err.message, durationMs, objectTypeId!]
        );
      }
    } catch {
      // Best-effort state update
    }

    // Try to update funnel_pipeline_state — clear `current_stage`
    // so the frontend spinner drops back to idle on failure.
    try {
      await query(
        `INSERT INTO funnel_pipeline_state
           (object_type_api_name, status, current_stage, stage_started_at, error_message, updated_at)
         VALUES ($1, 'failed', NULL, NULL, $2, now())
         ON CONFLICT (object_type_api_name) DO UPDATE SET
           status = 'failed',
           current_stage = NULL,
           stage_started_at = NULL,
           error_message = $2,
           updated_at = now()`,
        [objectTypeApiName, err.message]
      );
    } catch {
      // Non-critical
    }

    // Record failed reindex in history
    try {
      await query(
        `INSERT INTO reindex_history
           (object_type_api_name, status, triggered_by, started_at,
            completed_at, duration_ms, error_message, metadata)
         VALUES ($1, 'failed', 'manual', $2, now(), $3, $4, $5)`,
        [
          objectTypeApiName,
          new Date(startTime).toISOString(),
          durationMs,
          err.message,
          JSON.stringify({
            failedAtStep: err.details?.failedAtStep || "unknown",
          }),
        ]
      );
    } catch {
      // Best-effort history recording
    }

    // Re-throw the error for the route handler
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { reindexObjectType };
