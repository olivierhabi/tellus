// ---------------------------------------------------------------------------
// Indexing Orchestrator
//
// Coordinates the end-to-end indexing pipeline for an object type. When
// someone calls "index this object type," this module runs all 7 stages:
//
//   Stage 1: Load metadata from PostgreSQL
//   Stage 2: Prepare the OpenSearch index
//   Stage 3: Read the CSV datasource
//   Stage 4: Validate primary keys
//   Stage 5: Transform rows into documents
//   Stage 6: Merge user edits (Action engine)
//   Stage 7: Bulk-index into OpenSearch
//
// In Palantir's architecture, the Object Data Funnel orchestrates this
// pipeline as a series of jobs (Changelog -> Merge -> Index -> Metadata).
// Our orchestrator replicates this pipeline in a simplified single-pass form.
//
// Design: All external dependencies (DB queries, OpenSearch, CSV reader, etc.)
// are injectable via the `deps` option, allowing comprehensive self-tests
// without any live services.
// ---------------------------------------------------------------------------

import { query as dbQuery } from "../../db";
import { readCSV, ReadCSVResult } from "./csvReader";
import { validatePrimaryKeys, PKValidationResult } from "./primaryKeyValidator";
import { buildBatch, BuildBatchResult, BatchProgress } from "./batchDocumentBuilder";
import { mergeEditsWithDatasource, MergeResult, QueryFn } from "./editMerger";
import { objectTypeIndexName } from "../opensearch/objectIndexNames";
import {
  createIndex,
  deleteIndex,
  recreateIndex,
  updateMapping,
  indexExists,
  getIndexName,
} from "../opensearch/indexLifecycleManager";
import {
  bulkIndex,
  BulkIndexResult,
  BulkErrorResult,
} from "../opensearch/bulkIndexer";
import {
  setRunning as funnelSetRunning,
  setSuccess as funnelSetSuccess,
  setFailed as funnelSetFailed,
} from "../../models/funnelState";
import type { ObjectTypeRecord, PropertyRecord, PropertyColumnMapping } from "./rowTransformer";
import type { CSVRow } from "./csvReader";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress callback payload from the orchestrator. */
export interface PipelineProgress {
  stage: number;
  totalStages: number;
  stageName: string;
  message: string;
  /** Nested progress from Stage 5 (batch transform). */
  batchProgress?: BatchProgress;
}

/** Options for indexObjectType(). */
export interface IndexObjectTypeOptions {
  /** If true, delete and recreate the OpenSearch index. Default: false. */
  forceRecreateIndex?: boolean;
  /** If true, abort on any data validation errors. Default: true. */
  strict?: boolean;
  /** Progress callback fired at each stage. */
  onProgress?: (progress: PipelineProgress) => void;
  /** Injected dependencies for testing. */
  deps?: Partial<OrchestratorDeps>;
}

/** Stage 1 metadata result. */
export interface Stage1Result {
  properties: number;
  datasource: string;
}

/** Stage 2 index result. */
export interface Stage2Result {
  action: "created" | "updated" | "recreated";
  indexName: string;
}

/** Stage 3 read result. */
export interface Stage3Result {
  rowCount: number;
  durationMs: number;
}

/** Stage 4 validate result. */
export interface Stage4Result {
  uniqueKeys: number;
  durationMs: number;
}

/** Stage 5 transform result. */
export interface Stage5Result {
  validCount: number;
  invalidCount: number;
  durationMs: number;
}

/** Stage 6 merge result. */
export interface Stage6Result {
  editsApplied: number;
  finalCount: number;
  durationMs: number;
}

/** Stage 7 index result. */
export interface Stage7Result {
  successCount: number;
  failedCount: number;
  durationMs: number;
}

/** Full pipeline result returned by indexObjectType(). */
export interface PipelineResult {
  success: true;
  objectTypeApiName: string;
  indexName: string;
  pipeline: {
    stage1_metadata: Stage1Result;
    stage2_index: Stage2Result;
    stage3_read: Stage3Result;
    stage4_validate: Stage4Result;
    stage5_transform: Stage5Result;
    stage6_merge: Stage6Result;
    stage7_index: Stage7Result;
  };
  totalDurationMs: number;
  objectsIndexed: number;
  timestamp: string;
}

/** Failure result when the pipeline cannot complete. */
export interface PipelineFailure {
  success: false;
  objectTypeApiName: string;
  failedAtStage: number;
  stageName: string;
  error: string;
  details?: Record<string, unknown>;
  totalDurationMs: number;
  timestamp: string;
}

export type IndexObjectTypeResult = PipelineResult | PipelineFailure;

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

/**
 * All external calls the orchestrator makes, grouped for injectable testing.
 * Each function mirrors the real module's signature.
 */
export interface OrchestratorDeps {
  // Database
  queryFn: (text: string, values?: unknown[]) => Promise<QueryResult>;

  // Index lifecycle (Stage 2)
  indexExists: (apiName: string) => Promise<{ exists: boolean; indexName: string }>;
  createIndex: (apiName: string) => Promise<{ success: true; indexName: string }>;
  recreateIndex: (apiName: string) => Promise<{ success: true; indexName: string; recreated: true }>;
  updateMapping: (apiName: string) => Promise<{ success: true; indexName: string }>;
  getIndexName: (apiName: string) => string;

  // CSV reader (Stage 3)
  readCSV: (filePath: string) => Promise<ReadCSVResult>;

  // PK validator (Stage 4)
  validatePrimaryKeys: (rows: CSVRow[], pkColumn: string) => PKValidationResult;

  // Batch builder (Stage 5)
  buildBatch: typeof buildBatch;

  // Edit merger (Stage 6)
  mergeEditsWithDatasource: typeof mergeEditsWithDatasource;

  // Bulk indexer (Stage 7)
  bulkIndex: typeof bulkIndex;

  // Funnel state (Task 13 forward dependency)
  setRunning: (objectTypeApiName: string) => Promise<void>;
  setSuccess: (objectTypeApiName: string, objectsIndexed: number, durationMs: number, datasourceVersion: string | null) => Promise<void>;
  setFailed: (objectTypeApiName: string, errorMessage: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default funnel state functions — delegate to the funnelState model
// (Task 13). The model manages the `funnel_pipeline_state` table and
// centralizes all state management logic.
// ---------------------------------------------------------------------------

async function defaultSetRunning(objectTypeApiName: string): Promise<void> {
  await funnelSetRunning(objectTypeApiName);
  await mirrorFunnelStateUi(objectTypeApiName, { status: "indexing" });
}

async function defaultSetSuccess(
  objectTypeApiName: string,
  objectsIndexed: number,
  durationMs: number,
  datasourceVersion: string | null
): Promise<void> {
  await funnelSetSuccess(objectTypeApiName, objectsIndexed, durationMs, datasourceVersion);
  await mirrorFunnelStateUi(objectTypeApiName, {
    status: "indexed",
    objectsIndexed,
    durationMs,
  });
}

async function defaultSetFailed(
  objectTypeApiName: string,
  errorMessage: string
): Promise<void> {
  await funnelSetFailed(objectTypeApiName, errorMessage);
  await mirrorFunnelStateUi(objectTypeApiName, { status: "failed", error: errorMessage });
}

/**
 * Mirror the detailed `funnel_pipeline_state` write into the UI-facing
 * `funnel_state` table.
 *
 * The funnelState model writes the detailed, apiName-keyed execution ledger
 * to `funnel_pipeline_state`. The object-type GET (`objectTypeService`) joins
 * the SEPARATE `funnel_state` table (object_type_id-keyed) to populate the
 * `index_status` badge and `object_count`. The funnel dispatcher projects one
 * into the other at its terminal — but the direct `indexObjectType` pipeline
 * never did, so a successful manual or auto index left the badge stuck at
 * "not_indexed / 0 objects". This keeps the two in sync on every indexing run.
 *
 * Non-fatal: the `funnel_pipeline_state` write is the source of truth; this
 * is purely the UI projection, so any error here is logged and swallowed.
 */
async function mirrorFunnelStateUi(
  objectTypeApiName: string,
  fields: {
    status: "indexing" | "indexed" | "failed";
    objectsIndexed?: number;
    durationMs?: number;
    error?: string;
  },
): Promise<void> {
  try {
    const ot = await dbQuery(
      "SELECT object_type_id FROM object_type WHERE api_name = $1",
      [objectTypeApiName],
    );
    if (ot.rows.length === 0) return;
    const objectTypeId = ot.rows[0].object_type_id as string;
    const indexName = getIndexName(objectTypeApiName);
    await dbQuery(
      `INSERT INTO funnel_state
         (object_type_id, status, objects_indexed, last_indexed_at,
          last_index_duration_ms, index_name, error_message, error_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (object_type_id) DO UPDATE SET
         status                 = EXCLUDED.status,
         objects_indexed        = CASE WHEN EXCLUDED.status = 'indexed'
                                       THEN EXCLUDED.objects_indexed
                                       ELSE funnel_state.objects_indexed END,
         last_indexed_at        = CASE WHEN EXCLUDED.status = 'indexed'
                                       THEN EXCLUDED.last_indexed_at
                                       ELSE funnel_state.last_indexed_at END,
         last_index_duration_ms = CASE WHEN EXCLUDED.status = 'indexed'
                                       THEN EXCLUDED.last_index_duration_ms
                                       ELSE funnel_state.last_index_duration_ms END,
         index_name             = COALESCE(EXCLUDED.index_name, funnel_state.index_name),
         error_message          = CASE WHEN EXCLUDED.status = 'failed'
                                       THEN EXCLUDED.error_message
                                       ELSE NULL END,
         error_count            = CASE WHEN EXCLUDED.status = 'failed'
                                       THEN funnel_state.error_count + 1
                                       ELSE 0 END,
         updated_at             = now()`,
      [
        objectTypeId,
        fields.status,
        fields.objectsIndexed ?? 0,
        fields.status === "indexed" ? new Date() : null,
        fields.durationMs ?? null,
        indexName,
        fields.status === "failed" ? (fields.error ?? "Indexing failed") : null,
        fields.status === "failed" ? 1 : 0,
      ],
    );
  } catch (err) {
    console.warn(
      `[indexing] failed to mirror funnel_state UI status for '${objectTypeApiName}':`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Build the deps object with defaults
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    queryFn: partial?.queryFn ?? dbQuery,
    indexExists: partial?.indexExists ?? indexExists,
    createIndex: partial?.createIndex ?? createIndex,
    recreateIndex: partial?.recreateIndex ?? recreateIndex,
    updateMapping: partial?.updateMapping ?? updateMapping,
    getIndexName: partial?.getIndexName ?? getIndexName,
    readCSV: partial?.readCSV ?? readCSV,
    validatePrimaryKeys: partial?.validatePrimaryKeys ?? validatePrimaryKeys,
    buildBatch: partial?.buildBatch ?? buildBatch,
    mergeEditsWithDatasource: partial?.mergeEditsWithDatasource ?? mergeEditsWithDatasource,
    bulkIndex: partial?.bulkIndex ?? bulkIndex,
    setRunning: partial?.setRunning ?? defaultSetRunning,
    setSuccess: partial?.setSuccess ?? defaultSetSuccess,
    setFailed: partial?.setFailed ?? defaultSetFailed,
  };
}

// ---------------------------------------------------------------------------
// indexObjectType()
// ---------------------------------------------------------------------------

/**
 * Run the full 7-stage indexing pipeline for an object type.
 *
 * @param objectTypeApiName - The API name of the object type to index.
 * @param options           - Optional pipeline configuration.
 * @returns A PipelineResult on success, or PipelineFailure on failure.
 */
export async function indexObjectType(
  objectTypeApiName: string,
  options?: IndexObjectTypeOptions
): Promise<IndexObjectTypeResult> {
  const forceRecreateIndex = options?.forceRecreateIndex ?? false;
  const strict = options?.strict !== false;
  const onProgress = options?.onProgress;
  const deps = resolveDeps(options?.deps);
  const pipelineStart = Date.now();

  function emitProgress(stage: number, stageName: string, message: string, batchProgress?: BatchProgress): void {
    if (onProgress) {
      onProgress({ stage, totalStages: 7, stageName, message, batchProgress });
    }
  }

  function makeDuration(): number {
    return Date.now() - pipelineStart;
  }

  function makeFailure(stage: number, stageName: string, error: string, details?: Record<string, unknown>): PipelineFailure {
    return {
      success: false,
      objectTypeApiName,
      failedAtStage: stage,
      stageName,
      error,
      details,
      totalDurationMs: Date.now() - pipelineStart,
      timestamp: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Set funnel state to "running" before Stage 1
  // -----------------------------------------------------------------------
  try {
    await deps.setRunning(objectTypeApiName);
  } catch {
    // Non-fatal — funnel state might not exist for this object type yet
  }

  try {
    // =====================================================================
    // Stage 1: Load Metadata
    // =====================================================================
    const stage1Start = Date.now();

    // Fetch object type by api_name
    const otResult = await deps.queryFn(
      "SELECT object_type_id, api_name, primary_key_property_id FROM object_type WHERE api_name = $1 LIMIT 1",
      [objectTypeApiName]
    );
    if (otResult.rows.length === 0) {
      const failure = makeFailure(1, "Load Metadata", `Object type '${objectTypeApiName}' not found.`);
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }
    const objectTypeRow = otResult.rows[0];
    const objectTypeId = objectTypeRow.object_type_id;

    const objectType: ObjectTypeRecord = {
      api_name: objectTypeRow.api_name,
      primary_key_property_id: objectTypeRow.primary_key_property_id,
    };

    // Fetch properties
    const propsResult = await deps.queryFn(
      "SELECT property_id, api_name, base_type, is_array, is_required FROM property WHERE object_type_id = $1 ORDER BY ordinal, api_name",
      [objectTypeId]
    );
    if (propsResult.rows.length === 0) {
      const failure = makeFailure(1, "Load Metadata", `Object type '${objectTypeApiName}' has no properties defined.`);
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }
    const properties: PropertyRecord[] = propsResult.rows as PropertyRecord[];

    // Fetch backing datasource
    const dsResult = await deps.queryFn(
      "SELECT mapping_id, file_path, column_mapping, primary_key_column FROM backing_datasource WHERE object_type_id = $1",
      [objectTypeId]
    );
    if (dsResult.rows.length === 0) {
      const failure = makeFailure(
        1,
        "Load Metadata",
        `Object type '${objectTypeApiName}' has no backing datasource registered. Register a datasource first.`
      );
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }
    const datasource = dsResult.rows[0];
    const filePath: string = datasource.file_path;
    const columnMapping: PropertyColumnMapping =
      typeof datasource.column_mapping === "string"
        ? JSON.parse(datasource.column_mapping)
        : datasource.column_mapping;
    const primaryKeyColumn: string = datasource.primary_key_column;

    const stage1Result: Stage1Result = {
      properties: properties.length,
      datasource: filePath,
    };

    console.log(
      `Stage 1/7: Loaded metadata for '${objectTypeApiName}' — ${properties.length} properties, datasource: '${filePath}'`
    );
    emitProgress(1, "Load Metadata", `Loaded ${properties.length} properties from '${filePath}'`);

    // =====================================================================
    // Stage 2: Prepare Index
    // =====================================================================
    const stage2Start = Date.now();
    const indexName = deps.getIndexName(objectTypeApiName);
    let stage2Action: "created" | "updated" | "recreated";

    const existsResult = await deps.indexExists(objectTypeApiName);

    if (!existsResult.exists) {
      await deps.createIndex(objectTypeApiName);
      stage2Action = "created";
    } else if (forceRecreateIndex) {
      await deps.recreateIndex(objectTypeApiName);
      stage2Action = "recreated";
    } else {
      await deps.updateMapping(objectTypeApiName);
      stage2Action = "updated";
    }

    const stage2Result: Stage2Result = {
      action: stage2Action,
      indexName,
    };

    console.log(`Stage 2/7: Index '${indexName}' ready`);
    emitProgress(2, "Prepare Index", `Index '${indexName}' ${stage2Action}`);

    // =====================================================================
    // Stage 3: Read Datasource
    // =====================================================================
    const stage3Start = Date.now();
    const csvResult = await deps.readCSV(filePath);

    if (!csvResult.success) {
      const failure = makeFailure(3, "Read Datasource", csvResult.error.message, {
        code: csvResult.error.code,
        filePath: csvResult.error.filePath,
      });
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }

    const rows = csvResult.rows;
    const stage3Duration = Date.now() - stage3Start;

    const stage3Result: Stage3Result = {
      rowCount: rows.length,
      durationMs: stage3Duration,
    };

    console.log(`Stage 3/7: Read ${rows.length} rows from '${filePath}'`);
    emitProgress(3, "Read Datasource", `Read ${rows.length} rows`);

    // =====================================================================
    // Stage 4: Validate Primary Keys
    // =====================================================================
    const stage4Start = Date.now();
    let pkValidation: PKValidationResult;

    try {
      pkValidation = deps.validatePrimaryKeys(rows, primaryKeyColumn);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const failure = makeFailure(4, "Validate Primary Keys", errMsg);
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }

    if (!pkValidation.valid) {
      const failure = makeFailure(4, "Validate Primary Keys", pkValidation.summary, {
        nullKeys: pkValidation.errors.nullKeys.length,
        duplicateKeys: pkValidation.errors.duplicateKeys.length,
      });
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }

    const stage4Duration = Date.now() - stage4Start;
    const stage4Result: Stage4Result = {
      uniqueKeys: pkValidation.uniqueKeyCount,
      durationMs: stage4Duration,
    };

    console.log(`Stage 4/7: Primary keys validated — ${pkValidation.uniqueKeyCount} unique keys`);
    emitProgress(4, "Validate Primary Keys", `${pkValidation.uniqueKeyCount} unique keys`);

    // =====================================================================
    // Stage 5: Transform Rows
    // =====================================================================
    const stage5Start = Date.now();

    const datasourceVersion = `ds-${Date.now()}`;
    const batchResult: BuildBatchResult = deps.buildBatch(
      rows,
      objectType,
      properties,
      columnMapping,
      primaryKeyColumn,
      {
        strict,
        datasourceVersion,
        onProgress: (bp) => {
          emitProgress(5, "Transform Rows", `Transforming: ${bp.processed}/${bp.total}`, bp);
        },
      }
    );

    if (strict && batchResult.invalidCount > 0) {
      const failure = makeFailure(5, "Transform Rows", `${batchResult.invalidCount} rows failed validation in strict mode`, {
        invalidCount: batchResult.invalidCount,
        firstErrors: batchResult.invalidDocuments.slice(0, 5).map((d) => ({
          lineNumber: d.lineNumber,
          errors: d.errors,
        })),
      });
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }

    const stage5Duration = Date.now() - stage5Start;
    const stage5Result: Stage5Result = {
      validCount: batchResult.validCount,
      invalidCount: batchResult.invalidCount,
      durationMs: stage5Duration,
    };

    console.log(
      `Stage 5/7: Transformed ${batchResult.validCount}/${batchResult.totalRows} rows (${batchResult.invalidCount} rejected)`
    );
    emitProgress(5, "Transform Rows", `${batchResult.validCount} valid, ${batchResult.invalidCount} rejected`);

    // =====================================================================
    // Stage 6: Merge User Edits
    // =====================================================================
    const stage6Start = Date.now();

    const mergeResult: MergeResult = await deps.mergeEditsWithDatasource(
      batchResult.validDocuments,
      objectTypeApiName,
      { queryFn: deps.queryFn as QueryFn }
    );

    const stage6Duration = Date.now() - stage6Start;
    const stage6Result: Stage6Result = {
      editsApplied: mergeResult.stats.editsApplied,
      finalCount: mergeResult.stats.finalDocumentCount,
      durationMs: stage6Duration,
    };

    console.log(
      `Stage 6/7: Merged ${mergeResult.stats.editsApplied} user edits — ${mergeResult.stats.finalDocumentCount} documents to index`
    );
    emitProgress(6, "Merge User Edits", `${mergeResult.stats.editsApplied} edits, ${mergeResult.stats.finalDocumentCount} documents`);

    // =====================================================================
    // Stage 7: Bulk Index
    // =====================================================================
    const stage7Start = Date.now();

    const bulkResult = await deps.bulkIndex(
      indexName,
      mergeResult.mergedDocuments
    );

    // Check if bulk indexing returned an error result (cluster unreachable)
    if (!bulkResult.success && "error" in bulkResult) {
      const errorResult = bulkResult as BulkErrorResult;
      const failure = makeFailure(7, "Bulk Index", errorResult.error.message, {
        code: errorResult.error.code,
      });
      await safeSetFailed(deps, objectTypeApiName, failure.error);
      return failure;
    }

    const indexResult = bulkResult as BulkIndexResult;
    const stage7Duration = Date.now() - stage7Start;
    const stage7Result: Stage7Result = {
      successCount: indexResult.successCount,
      failedCount: indexResult.failedCount,
      durationMs: stage7Duration,
    };

    console.log(
      `Stage 7/7: Indexed ${indexResult.successCount}/${indexResult.totalDocuments} documents in ${stage7Duration}ms`
    );
    emitProgress(7, "Bulk Index", `Indexed ${indexResult.successCount} documents`);

    // =====================================================================
    // Pipeline complete — set funnel state to success
    // =====================================================================
    const totalDurationMs = Date.now() - pipelineStart;

    await safeSetSuccess(
      deps,
      objectTypeApiName,
      indexResult.successCount,
      totalDurationMs,
      datasourceVersion
    );

    return {
      success: true,
      objectTypeApiName,
      indexName,
      pipeline: {
        stage1_metadata: stage1Result,
        stage2_index: stage2Result,
        stage3_read: stage3Result,
        stage4_validate: stage4Result,
        stage5_transform: stage5Result,
        stage6_merge: stage6Result,
        stage7_index: stage7Result,
      },
      totalDurationMs,
      objectsIndexed: indexResult.successCount,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // Unexpected error — set funnel state to failed and re-throw
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeSetFailed(deps, objectTypeApiName, errMsg);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Safe funnel state wrappers (never throw)
// ---------------------------------------------------------------------------

async function safeSetFailed(
  deps: OrchestratorDeps,
  objectTypeApiName: string,
  errorMessage: string
): Promise<void> {
  try {
    await deps.setFailed(objectTypeApiName, errorMessage);
  } catch {
    // Non-fatal — funnel state update failure should not mask the real error
  }
}

async function safeSetSuccess(
  deps: OrchestratorDeps,
  objectTypeApiName: string,
  objectsIndexed: number,
  durationMs: number,
  datasourceVersion: string | null
): Promise<void> {
  try {
    await deps.setSuccess(objectTypeApiName, objectsIndexed, durationMs, datasourceVersion);
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { indexObjectType };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/indexingOrchestrator.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  // These self-tests assert the DEFAULT index-name shape (e.g.
  // "ontology-employee") byte-for-byte. Under a FUNN-ISO prefixed lane
  // (vitest pins OS_INDEX_PREFIX=ttest-ontology-) the assertion broke —
  // the naming mechanics they check are prefix-independent. Pin the
  // default prefix for the duration of the test; restore after.
  const savedPrefix = process.env.OS_INDEX_PREFIX;
  process.env.OS_INDEX_PREFIX = "ontology-";
  try {
    await runSelfTestsImpl();
  } finally {
    if (savedPrefix === undefined) delete process.env.OS_INDEX_PREFIX;
    else process.env.OS_INDEX_PREFIX = savedPrefix;
  }
}

async function runSelfTestsImpl(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running indexingOrchestrator self-tests...\n");

  // =======================================================================
  // Mock infrastructure
  // =======================================================================

  /** Mock DB state for a single object type with properties and datasource. */
  interface MockDB {
    objectType: { object_type_id: string; api_name: string; primary_key_property_id: string };
    properties: PropertyRecord[];
    datasource: { mapping_id: string; file_path: string; column_mapping: PropertyColumnMapping; primary_key_column: string };
    csvRows: CSVRow[];
    editRecords: Array<Record<string, unknown>>;
    funnelCalls: string[];
  }

  function createDefaultMockDB(): MockDB {
    return {
      objectType: {
        object_type_id: "ot-uuid-1",
        api_name: "Employee",
        primary_key_property_id: "pk-uuid-1",
      },
      properties: [
        { property_id: "pk-uuid-1", api_name: "employeeId", base_type: "string", is_array: false, is_required: true },
        { property_id: "uuid-2", api_name: "fullName", base_type: "string", is_array: false, is_required: true },
        { property_id: "uuid-3", api_name: "salary", base_type: "double", is_array: false, is_required: false },
        { property_id: "uuid-4", api_name: "isActive", base_type: "boolean", is_array: false, is_required: false },
      ],
      datasource: {
        mapping_id: "ds-uuid-1",
        file_path: "/data/employees.csv",
        column_mapping: { employeeId: "emp_id", fullName: "full_name", salary: "salary", isActive: "is_active" },
        primary_key_column: "emp_id",
      },
      csvRows: [
        { emp_id: "EMP-001", full_name: "Alice", salary: "100000", is_active: "true" },
        { emp_id: "EMP-002", full_name: "Bob", salary: "90000", is_active: "false" },
        { emp_id: "EMP-003", full_name: "Charlie", salary: "110000", is_active: "true" },
        { emp_id: "EMP-004", full_name: "Diana", salary: "95000", is_active: "true" },
        { emp_id: "EMP-005", full_name: "Eve", salary: "120000", is_active: "false" },
        { emp_id: "EMP-006", full_name: "Frank", salary: "85000", is_active: "true" },
        { emp_id: "EMP-007", full_name: "Grace", salary: "105000", is_active: "true" },
        { emp_id: "EMP-008", full_name: "Hank", salary: "92000", is_active: "false" },
        { emp_id: "EMP-009", full_name: "Ivy", salary: "115000", is_active: "true" },
        { emp_id: "EMP-010", full_name: "Jack", salary: "88000", is_active: "true" },
      ],
      editRecords: [],
      funnelCalls: [],
    };
  }

  /**
   * Create a fully mocked OrchestratorDeps from a MockDB, with configurable
   * behaviors for index existence, bulk indexing, etc.
   */
  function createMockDeps(
    mockDB: MockDB,
    overrides?: {
      indexExistsResult?: boolean;
      bulkIndexFail?: boolean;
      readCSVFail?: boolean;
    }
  ): OrchestratorDeps {
    const ixExists = overrides?.indexExistsResult ?? false;
    const bulkFail = overrides?.bulkIndexFail ?? false;
    const readFail = overrides?.readCSVFail ?? false;

    const mockQueryFn = async (text: string, values?: unknown[]): Promise<QueryResult> => {
      // object_type lookup
      if (text.includes("FROM object_type") && text.includes("api_name")) {
        const apiName = values?.[0];
        if (apiName === mockDB.objectType.api_name) {
          return { rows: [mockDB.objectType], rowCount: 1 } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }

      // properties lookup
      if (text.includes("FROM property")) {
        return { rows: mockDB.properties, rowCount: mockDB.properties.length } as unknown as QueryResult;
      }

      // backing_datasource lookup
      if (text.includes("FROM backing_datasource")) {
        return { rows: [mockDB.datasource], rowCount: 1 } as unknown as QueryResult;
      }

      // ontology_edit queries (from editMerger)
      if (text.includes("FROM ontology_edit") && text.includes("indexed = false")) {
        return { rows: mockDB.editRecords.filter((e: Record<string, unknown>) => e.indexed === false), rowCount: 0 } as unknown as QueryResult;
      }
      if (text.includes("FROM ontology_edit") && text.includes("operation IN")) {
        return { rows: mockDB.editRecords.filter((e: Record<string, unknown>) => e.operation === "update" || e.operation === "create"), rowCount: 0 } as unknown as QueryResult;
      }
      if (text.includes("UPDATE ontology_edit")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }

      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    };

    return {
      queryFn: mockQueryFn,

      indexExists: async (apiName: string) => ({
        exists: ixExists,
        indexName: objectTypeIndexName(apiName),
      }),

      createIndex: async (apiName: string) => ({
        success: true as const,
        indexName: objectTypeIndexName(apiName),
      }),

      recreateIndex: async (apiName: string) => ({
        success: true as const,
        indexName: objectTypeIndexName(apiName),
        recreated: true as const,
      }),

      updateMapping: async (apiName: string) => ({
        success: true as const,
        indexName: objectTypeIndexName(apiName),
      }),

      getIndexName: (apiName: string) => objectTypeIndexName(apiName),

      readCSV: async (filePath: string): Promise<ReadCSVResult> => {
        if (readFail) {
          return {
            success: false,
            error: { code: "FILE_NOT_FOUND", message: `File not found: ${filePath}`, filePath },
          };
        }
        return {
          success: true,
          filePath,
          columns: Object.keys(mockDB.csvRows[0] || {}),
          rowCount: mockDB.csvRows.length,
          rows: mockDB.csvRows,
          parseWarnings: [],
          parseDurationMs: 5,
        };
      },

      validatePrimaryKeys,
      buildBatch,

      mergeEditsWithDatasource: async (docs, apiName, opts) => {
        return mergeEditsWithDatasource(docs, apiName, { queryFn: mockQueryFn as QueryFn });
      },

      bulkIndex: async (indexName, documents): Promise<BulkIndexResult | BulkErrorResult> => {
        if (bulkFail) {
          return {
            success: false,
            error: { code: "OPENSEARCH_UNREACHABLE", message: "Connection refused" },
          };
        }
        return {
          success: true,
          indexName,
          totalDocuments: documents.length,
          successCount: documents.length,
          failedCount: 0,
          createdCount: documents.length,
          updatedCount: 0,
          failedDocuments: [],
          batchCount: 1,
          totalDurationMs: 10,
          avgBatchDurationMs: 10,
        };
      },

      setRunning: async (apiName: string) => { mockDB.funnelCalls.push(`setRunning:${apiName}`); },
      setSuccess: async (apiName: string, count: number) => { mockDB.funnelCalls.push(`setSuccess:${apiName}:${count}`); },
      setFailed: async (apiName: string, err: string) => { mockDB.funnelCalls.push(`setFailed:${apiName}:${err.substring(0, 50)}`); },
    };
  }

  // =======================================================================
  // Test 1: Full successful pipeline — 10 rows, no edits
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db);

    const result = await indexObjectType("Employee", { deps });

    assert(result.success === true, "full pipeline: success");
    if (result.success) {
      assert(result.objectTypeApiName === "Employee", "full pipeline: objectTypeApiName");
      assert(result.indexName === "ontology-employee", "full pipeline: indexName");
      assert(result.objectsIndexed === 10, `full pipeline: objectsIndexed 10 (got ${result.objectsIndexed})`);
      assert(result.pipeline.stage1_metadata.properties === 4, "full pipeline: 4 properties");
      assert(result.pipeline.stage1_metadata.datasource === "/data/employees.csv", "full pipeline: datasource path");
      assert(result.pipeline.stage2_index.action === "created", "full pipeline: index created");
      assert(result.pipeline.stage3_read.rowCount === 10, "full pipeline: 10 rows read");
      assert(result.pipeline.stage4_validate.uniqueKeys === 10, "full pipeline: 10 unique keys");
      assert(result.pipeline.stage5_transform.validCount === 10, "full pipeline: 10 valid transforms");
      assert(result.pipeline.stage5_transform.invalidCount === 0, "full pipeline: 0 invalid transforms");
      assert(result.pipeline.stage6_merge.editsApplied === 0, "full pipeline: 0 edits merged");
      assert(result.pipeline.stage6_merge.finalCount === 10, "full pipeline: 10 final documents");
      assert(result.pipeline.stage7_index.successCount === 10, "full pipeline: 10 indexed");
      assert(result.pipeline.stage7_index.failedCount === 0, "full pipeline: 0 failed");
      assert(typeof result.totalDurationMs === "number", "full pipeline: totalDurationMs");
      assert(typeof result.timestamp === "string", "full pipeline: timestamp");
    }
  }

  // =======================================================================
  // Test 2: Object type not found
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db);

    const result = await indexObjectType("NonExistent", { deps });

    assert(result.success === false, "not found: success false");
    if (!result.success) {
      assert(result.failedAtStage === 1, "not found: failed at stage 1");
      assert(result.error.includes("not found"), "not found: error message");
    }
  }

  // =======================================================================
  // Test 3: No datasource registered
  // =======================================================================
  {
    const db = createDefaultMockDB();
    // Override queryFn to return empty datasource
    const baseDeps = createMockDeps(db);
    const deps: OrchestratorDeps = {
      ...baseDeps,
      queryFn: async (text: string, values?: unknown[]): Promise<QueryResult> => {
        if (text.includes("FROM backing_datasource")) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        return baseDeps.queryFn(text, values);
      },
    };

    const result = await indexObjectType("Employee", { deps });

    assert(result.success === false, "no datasource: success false");
    if (!result.success) {
      assert(result.failedAtStage === 1, "no datasource: failed at stage 1");
      assert(result.error.includes("no backing datasource"), "no datasource: error message");
    }
  }

  // =======================================================================
  // Test 4: Index already exists — update mapping (default behavior)
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db, { indexExistsResult: true });

    const result = await indexObjectType("Employee", { deps });

    assert(result.success === true, "update mapping: success");
    if (result.success) {
      assert(result.pipeline.stage2_index.action === "updated", "update mapping: action is updated");
    }
  }

  // =======================================================================
  // Test 5: Force recreate index
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db, { indexExistsResult: true });

    const result = await indexObjectType("Employee", {
      forceRecreateIndex: true,
      deps,
    });

    assert(result.success === true, "force recreate: success");
    if (result.success) {
      assert(result.pipeline.stage2_index.action === "recreated", "force recreate: action is recreated");
    }
  }

  // =======================================================================
  // Test 6: CSV read failure
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db, { readCSVFail: true });

    const result = await indexObjectType("Employee", { deps });

    assert(result.success === false, "csv fail: success false");
    if (!result.success) {
      assert(result.failedAtStage === 3, "csv fail: failed at stage 3");
      assert(result.error.includes("File not found"), "csv fail: error message");
    }
  }

  // =======================================================================
  // Test 7: Duplicate primary keys — validation failure
  // =======================================================================
  {
    const db = createDefaultMockDB();
    // Add duplicate PK rows
    db.csvRows.push({ emp_id: "EMP-001", full_name: "Duplicate", salary: "50000", is_active: "true" });

    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { deps });

    assert(result.success === false, "dup PK: success false");
    if (!result.success) {
      assert(result.failedAtStage === 4, `dup PK: failed at stage 4 (got ${result.failedAtStage})`);
      assert(result.error.includes("duplicate") || result.error.includes("Duplicate") || result.error.includes("FAIL"), `dup PK: error mentions duplicates (got: ${result.error.substring(0, 80)})`);
    }
  }

  // =======================================================================
  // Test 8: Invalid rows in strict mode — failure at stage 5
  // =======================================================================
  {
    const db = createDefaultMockDB();
    // Add a row with invalid salary (not a number)
    db.csvRows = [
      { emp_id: "EMP-001", full_name: "Alice", salary: "not-a-number", is_active: "true" },
      { emp_id: "EMP-002", full_name: "Bob", salary: "90000", is_active: "true" },
    ];

    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { strict: true, deps });

    assert(result.success === false, "strict fail: success false");
    if (!result.success) {
      assert(result.failedAtStage === 5, `strict fail: failed at stage 5 (got ${result.failedAtStage})`);
    }
  }

  // =======================================================================
  // Test 9: Invalid rows in non-strict mode — continues successfully
  // =======================================================================
  {
    const db = createDefaultMockDB();
    db.csvRows = [
      { emp_id: "EMP-001", full_name: "Alice", salary: "not-a-number", is_active: "true" },
      { emp_id: "EMP-002", full_name: "Bob", salary: "90000", is_active: "true" },
    ];

    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { strict: false, deps });

    assert(result.success === true, "non-strict: success true");
    if (result.success) {
      assert(result.objectsIndexed === 2, `non-strict: 2 indexed (got ${result.objectsIndexed})`);
    }
  }

  // =======================================================================
  // Test 10: Bulk index failure (OpenSearch unreachable)
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db, { bulkIndexFail: true });

    const result = await indexObjectType("Employee", { deps });

    assert(result.success === false, "bulk fail: success false");
    if (!result.success) {
      assert(result.failedAtStage === 7, `bulk fail: failed at stage 7 (got ${result.failedAtStage})`);
      assert(result.error.includes("Connection refused"), "bulk fail: error message");
    }
  }

  // =======================================================================
  // Test 11: Progress callback fires for all stages
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db);

    const progressCalls: PipelineProgress[] = [];
    const result = await indexObjectType("Employee", {
      deps,
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    assert(result.success === true, "progress: success");

    const stages = progressCalls.map((p) => p.stage);
    assert(stages.includes(1), "progress: stage 1 fired");
    assert(stages.includes(2), "progress: stage 2 fired");
    assert(stages.includes(3), "progress: stage 3 fired");
    assert(stages.includes(4), "progress: stage 4 fired");
    assert(stages.includes(5), "progress: stage 5 fired");
    assert(stages.includes(6), "progress: stage 6 fired");
    assert(stages.includes(7), "progress: stage 7 fired");

    assert(progressCalls.every((p) => p.totalStages === 7), "progress: totalStages always 7");
  }

  // =======================================================================
  // Test 12: Funnel state lifecycle — setRunning → setSuccess
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db);

    await indexObjectType("Employee", { deps });

    assert(
      db.funnelCalls[0] === "setRunning:Employee",
      `funnel: setRunning called first (got: ${db.funnelCalls[0]})`
    );
    assert(
      db.funnelCalls[db.funnelCalls.length - 1].startsWith("setSuccess:Employee:10"),
      `funnel: setSuccess called last (got: ${db.funnelCalls[db.funnelCalls.length - 1]})`
    );
  }

  // =======================================================================
  // Test 13: Funnel state on failure — setRunning → setFailed
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db, { readCSVFail: true });

    await indexObjectType("Employee", { deps });

    assert(
      db.funnelCalls[0] === "setRunning:Employee",
      "funnel fail: setRunning called first"
    );
    assert(
      db.funnelCalls.some((c) => c.startsWith("setFailed:Employee")),
      "funnel fail: setFailed called"
    );
  }

  // =======================================================================
  // Test 14: Edit merger integration — edits applied during pipeline
  // =======================================================================
  {
    const db = createDefaultMockDB();
    db.editRecords = [
      {
        edit_id: "ed-1",
        object_type_api_name: "Employee",
        primary_key: "EMP-003",
        operation: "update",
        property_values: { salary: 999999 },
        executed_by: "auditor1",
        executed_at: "2025-06-15T10:00:00.000Z",
        indexed: false,
      },
      {
        edit_id: "ed-2",
        object_type_api_name: "Employee",
        primary_key: "EMP-005",
        operation: "delete",
        property_values: null,
        executed_by: "admin",
        executed_at: "2025-06-15T11:00:00.000Z",
        indexed: false,
      },
    ];

    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { deps });

    assert(result.success === true, "edits: success");
    if (result.success) {
      assert(result.pipeline.stage6_merge.editsApplied === 2, `edits: 2 edits applied (got ${result.pipeline.stage6_merge.editsApplied})`);
      // 10 datasource - 1 delete = 9 final
      assert(result.pipeline.stage6_merge.finalCount === 9, `edits: 9 final docs (got ${result.pipeline.stage6_merge.finalCount})`);
      assert(result.objectsIndexed === 9, `edits: 9 indexed (got ${result.objectsIndexed})`);
    }
  }

  // =======================================================================
  // Test 15: No properties → failure at stage 1
  // =======================================================================
  {
    const db = createDefaultMockDB();
    db.properties = [];
    const deps = createMockDeps(db);

    // Override queryFn to return empty properties
    const baseDeps = deps;
    const depsFix: OrchestratorDeps = {
      ...baseDeps,
      queryFn: async (text: string, values?: unknown[]): Promise<QueryResult> => {
        if (text.includes("FROM property")) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        return baseDeps.queryFn(text, values);
      },
    };

    const result = await indexObjectType("Employee", { deps: depsFix });

    assert(result.success === false, "no props: success false");
    if (!result.success) {
      assert(result.failedAtStage === 1, "no props: failed at stage 1");
      assert(result.error.includes("no properties"), "no props: error message");
    }
  }

  // =======================================================================
  // Test 16: Idempotency — running pipeline twice on same data
  // =======================================================================
  {
    const db = createDefaultMockDB();

    // First run: index does not exist → creates it
    const deps1 = createMockDeps(db, { indexExistsResult: false });
    const result1 = await indexObjectType("Employee", { deps: deps1 });

    // Second run: index exists → updates mapping
    const deps2 = createMockDeps(db, { indexExistsResult: true });
    const result2 = await indexObjectType("Employee", { deps: deps2 });

    assert(result1.success === true, "idempotent: first run success");
    assert(result2.success === true, "idempotent: second run success");
    if (result1.success && result2.success) {
      assert(result1.pipeline.stage2_index.action === "created", "idempotent: first run creates");
      assert(result2.pipeline.stage2_index.action === "updated", "idempotent: second run updates");
      assert(result1.objectsIndexed === result2.objectsIndexed, "idempotent: same document count");
    }
  }

  // =======================================================================
  // Test 17: Large dataset — 1000 rows performance
  // =======================================================================
  {
    const db = createDefaultMockDB();
    db.csvRows = [];
    for (let i = 0; i < 1000; i++) {
      db.csvRows.push({
        emp_id: `EMP-${String(i + 1).padStart(4, "0")}`,
        full_name: `Employee ${i + 1}`,
        salary: String((i + 1) * 1000),
        is_active: i % 3 === 0 ? "false" : "true",
      });
    }

    const deps = createMockDeps(db);
    const start = Date.now();
    const result = await indexObjectType("Employee", { deps });
    const elapsed = Date.now() - start;

    assert(result.success === true, "perf 1k: success");
    if (result.success) {
      assert(result.objectsIndexed === 1000, `perf 1k: 1000 indexed (got ${result.objectsIndexed})`);
    }
    assert(elapsed < 5000, `perf 1k: completed in ${elapsed}ms (< 5000ms)`);
    console.log(`  (1000-row pipeline completed in ${elapsed}ms)`);
  }

  // =======================================================================
  // Test 18: Column mapping from JSON string (not object)
  // =======================================================================
  {
    const db = createDefaultMockDB();
    // Simulate column_mapping stored as JSON string (some DB drivers do this)
    (db.datasource as Record<string, unknown>).column_mapping = JSON.stringify(db.datasource.column_mapping);

    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { deps });

    assert(result.success === true, "json string mapping: success");
    if (result.success) {
      assert(result.objectsIndexed === 10, "json string mapping: 10 indexed");
    }
  }

  // =======================================================================
  // Test 19: Empty dataset — 0 rows
  // =======================================================================
  {
    const db = createDefaultMockDB();
    db.csvRows = [];

    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { deps });

    assert(result.success === true, "empty: success");
    if (result.success) {
      assert(result.objectsIndexed === 0, "empty: 0 indexed");
      assert(result.pipeline.stage3_read.rowCount === 0, "empty: 0 rows read");
      assert(result.pipeline.stage5_transform.validCount === 0, "empty: 0 valid");
      assert(result.pipeline.stage7_index.successCount === 0, "empty: 0 bulk indexed");
    }
  }

  // =======================================================================
  // Test 20: Pipeline result structure completeness
  // =======================================================================
  {
    const db = createDefaultMockDB();
    const deps = createMockDeps(db);
    const result = await indexObjectType("Employee", { deps });

    assert(result.success === true, "structure: success");
    if (result.success) {
      // Verify all expected top-level keys
      assert("objectTypeApiName" in result, "structure: objectTypeApiName");
      assert("indexName" in result, "structure: indexName");
      assert("pipeline" in result, "structure: pipeline");
      assert("totalDurationMs" in result, "structure: totalDurationMs");
      assert("objectsIndexed" in result, "structure: objectsIndexed");
      assert("timestamp" in result, "structure: timestamp");

      // Verify all pipeline stages
      assert("stage1_metadata" in result.pipeline, "structure: stage1_metadata");
      assert("stage2_index" in result.pipeline, "structure: stage2_index");
      assert("stage3_read" in result.pipeline, "structure: stage3_read");
      assert("stage4_validate" in result.pipeline, "structure: stage4_validate");
      assert("stage5_transform" in result.pipeline, "structure: stage5_transform");
      assert("stage6_merge" in result.pipeline, "structure: stage6_merge");
      assert("stage7_index" in result.pipeline, "structure: stage7_index");
    }
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll indexingOrchestrator tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
