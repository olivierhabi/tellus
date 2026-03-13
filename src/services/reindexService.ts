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
import { query, getClient } from "../db";
import { appError } from "../utils/appError";
import { convertValue } from "./indexing/typeConverter";
import { client } from "./opensearch/client";
import {
  getIndexName,
  deleteIndex,
  createIndex,
} from "./opensearch/indexLifecycleManager";
import type { PropertyInput } from "./mapping/typeMapper";

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
  durationMs: number;
}

interface TransactionFile {
  transaction_id: string;
  file_path: string;
  transaction_type: string;
  committed_at: string;
}

interface ReindexStats {
  skippedNullPk: number;
  createCount: number;
  updateCount: number;
  deleteCount: number;
}

// ---------------------------------------------------------------------------
// Helper: read a CSV file and return rows
// ---------------------------------------------------------------------------

async function readCsvFile(
  filePath: string
): Promise<{ rows: Record<string, string>[]; headers: string[] }> {
  const { parse } = await import("csv-parse/sync");

  let content = fs.readFileSync(filePath, "utf-8");

  // Strip BOM
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  const records: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];

  // Normalize null-like values
  for (const record of records) {
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (val !== null && val !== undefined) {
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

  return { rows: records, headers };
}

// ---------------------------------------------------------------------------
// Helper: read a JSON file and return rows
// ---------------------------------------------------------------------------

async function readJsonFile(
  filePath: string
): Promise<{ rows: Record<string, unknown>[]; headers: string[] }> {
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

  const headers: string[] = [];
  const keySet = new Set<string>();
  for (const row of records) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const key of Object.keys(row)) {
        if (!keySet.has(key)) {
          keySet.add(key);
          headers.push(key);
        }
      }
    }
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

  return { rows: records, headers };
}

// ---------------------------------------------------------------------------
// Helper: read file based on format
// ---------------------------------------------------------------------------

async function readFile(
  filePath: string,
  format: string
): Promise<{ rows: Record<string, unknown>[]; headers: string[] }> {
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
    createCount: 0,
    updateCount: 0,
    deleteCount: 0,
  };

  let objectTypeId: string;
  let lastTransactionId: string | null = null;

  try {
    // =================================================================
    // Step 1: Load metadata from PostgreSQL
    // =================================================================

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
      // Case B: legacy file-backed
      transactions = [
        {
          transaction_id: "legacy",
          file_path: datasource.file_path,
          transaction_type: "SNAPSHOT",
          committed_at: new Date().toISOString(),
        },
      ];
      // Detect format from file extension
      const ext = path.extname(datasource.file_path).toLowerCase();
      if (ext === ".json" || ext === ".jsonl") {
        datasetFormat = "json";
      } else {
        datasetFormat = "csv";
      }
      // Also check if the datasource has a file_format column
      if (datasource.file_format) {
        datasetFormat = datasource.file_format;
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
    // Step 3: Read & merge all transaction files
    //
    // In-memory Map keyed by primary key value. Process each transaction
    // file in chronological order (oldest first). For SNAPSHOT transactions,
    // clear the map first (it replaces all previous data). For APPEND
    // transactions, add to the existing map.
    // =================================================================

    const objectMap = new Map<string, Record<string, unknown>>();

    for (const txn of transactions) {
      let rows: Record<string, unknown>[];
      try {
        const fileResult = await readFile(txn.file_path, datasetFormat);
        rows = fileResult.rows;
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

      for (const row of rows) {
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

        // Duplicate PK within same transaction = error
        if (seenInTransaction.has(pkStr)) {
          throw appError(
            "REINDEX_FAILED",
            `Duplicate primary key '${pkStr}' found within transaction '${txn.transaction_id}'. Each primary key must appear only once per transaction.`,
            { failedAtStep: "duplicate_pk_check" }
          );
        }
        seenInTransaction.add(pkStr);

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

        // "Most recent transaction wins" — later transactions overwrite
        objectMap.set(pkStr, doc);
      }

      lastTransactionId = txn.transaction_id;
    }

    // Capture datasource count BEFORE applying edits
    const objectsFromDatasource = objectMap.size;

    console.log(
      `[Reindex] Step 3: Merged ${transactions.length} transaction(s) → ` +
        `${objectsFromDatasource} objects (${stats.skippedNullPk} skipped null PK)`
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
    // Step 7: Build OpenSearch bulk request
    // =================================================================

    const indexName = getIndexName(objectTypeApiName);
    const bulkBody: Record<string, unknown>[] = [];

    for (const [pk, doc] of objectMap) {
      bulkBody.push({ index: { _index: indexName, _id: pk } });
      bulkBody.push({
        __pk: pk,
        __objectType: objectTypeApiName,
        __lastModified: new Date().toISOString(),
        __version: 1,
        ...doc,
      });
    }

    console.log(
      `[Reindex] Step 7: Built bulk request with ${objectMap.size} documents`
    );

    // =================================================================
    // Step 8: Delete/recreate index
    // =================================================================

    try {
      await deleteIndex(objectTypeApiName);
    } catch {
      // Index might not exist yet — that's fine
    }

    try {
      await createIndex(objectTypeApiName);
    } catch (err: any) {
      throw appError(
        "REINDEX_FAILED",
        `Failed to create OpenSearch index '${indexName}': ${err.message}`,
        { failedAtStep: "opensearch_indexing" }
      );
    }

    console.log(
      `[Reindex] Step 8: Index '${indexName}' recreated`
    );

    // =================================================================
    // Step 9: Execute the bulk index
    // =================================================================

    let indexedCount = objectMap.size;

    if (bulkBody.length > 0) {
      try {
        const result = await client.bulk({
          body: bulkBody,
          refresh: "wait_for",
        });

        if (result.body.errors) {
          const errorItems = (result.body.items || []).filter(
            (item: any) => item.index?.error
          );
          if (errorItems.length > 0) {
            const firstError = errorItems[0].index.error;
            throw appError(
              "REINDEX_FAILED",
              `Bulk indexing failed for ${errorItems.length} objects. First error: ${JSON.stringify(firstError)}`,
              { failedAtStep: "opensearch_indexing" }
            );
          }
        }

        // Count successes
        const items = result.body.items || [];
        indexedCount = items.filter(
          (item: any) =>
            item.index?.status === 200 || item.index?.status === 201
        ).length;
      } catch (err: any) {
        if (err.code === "REINDEX_FAILED") throw err;
        throw appError(
          "REINDEX_FAILED",
          `OpenSearch bulk indexing failed: ${err.message}`,
          { failedAtStep: "opensearch_indexing" }
        );
      }
    } else {
      indexedCount = 0;
    }

    console.log(
      `[Reindex] Step 9: Indexed ${indexedCount} objects into '${indexName}'`
    );

    // =================================================================
    // Step 10: Mark edits as indexed
    // =================================================================

    if (editIds.length > 0) {
      await query(
        `UPDATE ontology_edit SET indexed = true, indexed_at = now()
         WHERE edit_id = ANY($1)`,
        [editIds]
      );
    }

    console.log(
      `[Reindex] Step 10: Marked ${editIds.length} edits as indexed`
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

    // Also update funnel_pipeline_state if it exists
    try {
      await query(
        `INSERT INTO funnel_pipeline_state
           (object_type_api_name, status, last_indexed_at, objects_indexed,
            duration_ms, error_message, updated_at)
         VALUES ($1, 'success', now(), $2, $3, NULL, now())
         ON CONFLICT (object_type_api_name) DO UPDATE SET
           status = 'success',
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
          skippedNullPk: stats.skippedNullPk,
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
      durationMs,
    };
  } catch (err: any) {
    // =================================================================
    // Error handling: update funnel_state to 'failed'
    // =================================================================
    const durationMs = Date.now() - startTime;

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

    // Try to update funnel_pipeline_state
    try {
      await query(
        `INSERT INTO funnel_pipeline_state
           (object_type_api_name, status, error_message, updated_at)
         VALUES ($1, 'failed', $2, now())
         ON CONFLICT (object_type_api_name) DO UPDATE SET
           status = 'failed',
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
