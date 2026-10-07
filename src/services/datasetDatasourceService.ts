// ---------------------------------------------------------------------------
// Dataset-Aware Datasource Service
//
// Updates the datasource registration to accept `datasetId` OR `filePath`.
// When a `datasetId` is provided, the service resolves the dataset's latest
// committed transaction file and validates column mappings against the
// dataset's schema. Includes Levenshtein distance for "Did you mean?"
// suggestions on column name typos.
//
// In Palantir Foundry, backing datasources are always datasets. You never
// point an object type directly at a raw file. This service bridges the
// Dataset layer and the Ontology layer.
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";
import { appError } from "../utils/appError";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterWithDatasetInput {
  datasetId?: string;
  filePath?: string;
  columnMapping: Record<string, string>;
  primaryKeyColumn?: string;
}

export interface RegisterResult {
  objectType: string;
  datasetId: string | null;
  datasetName: string | null;
  filePath: string;
  columnMapping: Record<string, string>;
  primaryKeyColumn: string;
  registeredAt: string;
}

// ---------------------------------------------------------------------------
// Levenshtein Distance
//
// Computes the minimum edit distance between two strings using the classic
// dynamic programming approach. Used for "Did you mean?" suggestions when
// a user provides a column name that doesn't exist in the dataset.
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * The edit distance counts the minimum number of single-character
 * insertions, deletions, or substitutions needed to transform string
 * `a` into string `b`.
 *
 * Time complexity: O(m * n) where m = a.length, n = b.length
 * Space complexity: O(min(m, n)) using two-row optimization
 */
export function levenshteinDistance(a: string, b: string): number {
  // Early termination for trivial cases
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Two-row DP: previous row and current row
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);

  // Initialize first row
  for (let i = 0; i <= m; i++) {
    prev[i] = i;
  }

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1, // deletion
        curr[i - 1] + 1, // insertion
        prev[i - 1] + cost // substitution
      );
    }
    // Swap rows
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

// ---------------------------------------------------------------------------
// Helper: find closest column name suggestion
// ---------------------------------------------------------------------------

/**
 * Find the closest matching column name from the available columns.
 * Returns a suggestion if the edit distance is <= maxDistance (default: 2).
 */
function findClosestColumn(
  input: string,
  availableColumns: string[],
  maxDistance: number = 2
): string | null {
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const col of availableColumns) {
    const dist = levenshteinDistance(input, col);
    if (dist < bestDistance && dist <= maxDistance) {
      bestDistance = dist;
      bestMatch = col;
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// registerWithDataset
//
// Registers a backing datasource for an object type using either a datasetId
// (preferred) or a legacy filePath. Validates all inputs and creates/updates
// the backing_datasource record.
// ---------------------------------------------------------------------------

export async function registerWithDataset(
  objectTypeId: string,
  data: RegisterWithDatasetInput
): Promise<RegisterResult> {
  const { datasetId, filePath, columnMapping, primaryKeyColumn } = data;

  // -----------------------------------------------------------------------
  // Mutual exclusivity check
  // -----------------------------------------------------------------------
  if (datasetId && filePath) {
    throw appError(
      "AMBIGUOUS_DATASOURCE",
      "Provide either datasetId or filePath, not both."
    );
  }

  if (!datasetId && !filePath) {
    throw appError(
      "VALIDATION_FAILED",
      "Either datasetId or filePath must be provided."
    );
  }

  // -----------------------------------------------------------------------
  // Load object type
  // -----------------------------------------------------------------------
  const otResult = await query(
    "SELECT * FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeId}' not found.`
    );
  }
  const objectType = otResult.rows[0];

  // -----------------------------------------------------------------------
  // Load properties for this object type
  // -----------------------------------------------------------------------
  const propsResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const properties = propsResult.rows;

  // -----------------------------------------------------------------------
  // Resolve primary key property api_name
  // -----------------------------------------------------------------------
  let primaryKeyPropertyApiName: string | null = null;
  if (objectType.primary_key_property_id) {
    const pkProp = properties.find(
      (p: any) => p.property_id === objectType.primary_key_property_id
    );
    primaryKeyPropertyApiName = pkProp ? pkProp.api_name : null;
  }

  // -----------------------------------------------------------------------
  // Variables to be resolved
  // -----------------------------------------------------------------------
  let resolvedFilePath: string;
  let resolvedDatasetId: string | null = null;
  let resolvedDatasetName: string | null = null;
  let availableColumns: string[] = [];

  if (datasetId) {
    // -------------------------------------------------------------------
    // Dataset mode: validate dataset and its transactions
    // -------------------------------------------------------------------

    // 1. Dataset must exist
    const dsResult = await query(
      "SELECT * FROM dataset WHERE dataset_id = $1",
      [datasetId]
    );
    if (dsResult.rows.length === 0) {
      throw appError(
        "DATASET_NOT_FOUND",
        `Dataset '${datasetId}' was not found.`
      );
    }
    const dataset = dsResult.rows[0];
    resolvedDatasetId = datasetId;
    resolvedDatasetName = dataset.name;

    // 2. Dataset must have at least one committed transaction
    const txnResult = await query(
      `SELECT file_path FROM dataset_transaction
       WHERE dataset_id = $1 AND status = 'committed'
       ORDER BY committed_at DESC
       LIMIT 1`,
      [datasetId]
    );
    if (txnResult.rows.length === 0) {
      throw appError(
        "DATASET_EMPTY",
        `Dataset '${datasetId}' has no committed data. Upload data to the dataset before using it as a backing datasource.`
      );
    }
    resolvedFilePath = txnResult.rows[0].file_path;

    // 3. Extract available columns from schema_definition
    if (
      dataset.schema_definition &&
      Array.isArray(dataset.schema_definition)
    ) {
      availableColumns = dataset.schema_definition.map((col: any) =>
        typeof col === "string" ? col : col.name || col.columnName || String(col)
      );
    } else if (
      dataset.schema_definition &&
      dataset.schema_definition.columns &&
      Array.isArray(dataset.schema_definition.columns)
    ) {
      availableColumns = dataset.schema_definition.columns.map((col: any) =>
        typeof col === "string" ? col : col.name || col.columnName || String(col)
      );
    }

    // Normalise BOM (U+FEFF) before comparison so legacy datasets
    // whose first column header was ingested with a UTF-8 BOM still
    // match user-supplied mappings (which have the BOM stripped by
    // the JSON body pipeline + inputSanitizer's .trim()).
    const stripBom = (s: string): string =>
      s.replace(/^\uFEFF/, "").replace(/\uFEFF/g, "");
    const normalizedAvailable = new Set(availableColumns.map(stripBom));

    // 4. Validate column mapping values against available columns
    for (const [propApiName, columnName] of Object.entries(columnMapping)) {
      if (!normalizedAvailable.has(stripBom(columnName))) {
        const suggestion = findClosestColumn(columnName, availableColumns);
        const didYouMean = suggestion
          ? ` Did you mean '${stripBom(suggestion)}'?`
          : "";
        throw appError(
          "COLUMN_NOT_FOUND",
          `Column '${columnName}' does not exist in dataset '${datasetId}'. Available columns: [${availableColumns.map((c) => `'${stripBom(c)}'`).join(", ")}].${didYouMean}`
        );
      }
    }

    // 5. Validate primaryKeyColumn against available columns
    if (primaryKeyColumn && !normalizedAvailable.has(stripBom(primaryKeyColumn))) {
      const suggestion = findClosestColumn(
        primaryKeyColumn,
        availableColumns
      );
      const didYouMean = suggestion
        ? ` Did you mean '${stripBom(suggestion)}'?`
        : "";
      throw appError(
        "COLUMN_NOT_FOUND",
        `Column '${primaryKeyColumn}' does not exist in dataset '${datasetId}'. Available columns: [${availableColumns.map((c) => `'${stripBom(c)}'`).join(", ")}].${didYouMean}`
      );
    }

    // 6. Primary key mismatch check
    if (primaryKeyPropertyApiName && primaryKeyColumn) {
      const mappedPkColumn = columnMapping[primaryKeyPropertyApiName];
      if (mappedPkColumn && mappedPkColumn !== primaryKeyColumn) {
        throw appError(
          "PRIMARY_KEY_MISMATCH",
          `The object type '${objectType.api_name}' has primary key property '${primaryKeyPropertyApiName}' mapped to column '${mappedPkColumn}', but primaryKeyColumn is set to '${primaryKeyColumn}'. The primaryKeyColumn must match the column mapped to the primary key property.`
        );
      }
    }

    // 7. One dataset can only back one object type
    const existingDsResult = await query(
      `SELECT ot.api_name
       FROM backing_datasource bs
       JOIN object_type ot ON bs.object_type_id = ot.object_type_id
       WHERE bs.dataset_id = $1 AND bs.object_type_id != $2`,
      [datasetId, objectTypeId]
    );
    if (existingDsResult.rows.length > 0) {
      throw appError(
        "DATASET_ALREADY_BACKING",
        `Dataset '${datasetId}' is already used as a backing datasource for object type '${existingDsResult.rows[0].api_name}'. A single dataset can only back one object type.`
      );
    }
  } else {
    // -------------------------------------------------------------------
    // Legacy file mode
    // -------------------------------------------------------------------
    resolvedFilePath = filePath!;
  }

  // -----------------------------------------------------------------------
  // Determine effective primary key column
  // -----------------------------------------------------------------------
  const effectivePkColumn =
    primaryKeyColumn ||
    (primaryKeyPropertyApiName
      ? columnMapping[primaryKeyPropertyApiName]
      : null) ||
    Object.values(columnMapping)[0] ||
    "";

  // -----------------------------------------------------------------------
  // Upsert backing_datasource
  // -----------------------------------------------------------------------
  const mappingId = crypto.randomUUID();

  const upsertResult = await query(
    `INSERT INTO backing_datasource
       (mapping_id, object_type_id, dataset_id, dataset_name, file_path,
        column_mapping, primary_key_column)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (object_type_id) DO UPDATE SET
       dataset_id = EXCLUDED.dataset_id,
       dataset_name = EXCLUDED.dataset_name,
       file_path = EXCLUDED.file_path,
       column_mapping = EXCLUDED.column_mapping,
       primary_key_column = EXCLUDED.primary_key_column,
       registered_at = now()
     RETURNING *`,
    [
      mappingId,
      objectTypeId,
      resolvedDatasetId,
      resolvedDatasetName || "unnamed",
      resolvedFilePath,
      JSON.stringify(columnMapping),
      effectivePkColumn,
    ]
  );

  const row = upsertResult.rows[0];

  // -----------------------------------------------------------------------
  // Update funnel_state
  // -----------------------------------------------------------------------
  const fsResult = await query(
    "SELECT * FROM funnel_state WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (fsResult.rows.length > 0) {
    const currentStatus = fsResult.rows[0].status;
    let newStatus = currentStatus;

    if (currentStatus === "indexed") {
      newStatus = "stale";
    } else if (currentStatus === "failed") {
      newStatus = "not_indexed";
    }

    if (newStatus !== currentStatus) {
      await query(
        "UPDATE funnel_state SET status = $1, updated_at = NOW() WHERE object_type_id = $2",
        [newStatus, objectTypeId]
      );
    }
  }

  return {
    objectType: objectType.api_name,
    datasetId: resolvedDatasetId,
    datasetName: resolvedDatasetName,
    filePath: resolvedFilePath,
    columnMapping,
    primaryKeyColumn: effectivePkColumn,
    registeredAt: row.registered_at,
  };
}

// ---------------------------------------------------------------------------
// registerWithFoundryDataset
//
// Bridge between the Foundry upload system (`foundry_datasets` +
// `dataset_columns`, S3-backed) and the Ontology layer (`backing_datasource`).
//
// The original `registerWithDataset` path above assumes the "Ontology
// dataset" model: a row in the `dataset` table with at least one
// committed `dataset_transaction` pointing to a file on the local
// filesystem. That model is disconnected from the file uploads exposed
// through `/api/v1/projects/:id/upload`, which land in `foundry_datasets`
// with a schema scanned from an S3 object.
//
// This function lets the "Create a new object type" wizard — which
// drives its Step 1 "Select a datasource" picker off `foundry_datasets`
// — register that selection as a backing datasource without any file
// round-trip. Columns are taken from `dataset_columns`, no filesystem
// access is performed, and the resulting `backing_datasource` row
// mirrors exactly what the legacy path would have produced.
// ---------------------------------------------------------------------------

export interface RegisterWithFoundryDatasetInput {
  foundryDatasetId: string;
  columnMapping: Record<string, string>;
  primaryKeyColumn: string;
}

export async function registerWithFoundryDataset(
  objectTypeId: string,
  data: RegisterWithFoundryDatasetInput,
): Promise<RegisterResult> {
  const { foundryDatasetId, columnMapping, primaryKeyColumn } = data;

  if (!foundryDatasetId) {
    throw appError("VALIDATION_FAILED", "foundryDatasetId is required.");
  }
  if (!columnMapping || Object.keys(columnMapping).length === 0) {
    throw appError("VALIDATION_FAILED", "columnMapping is required and must be non-empty.");
  }
  if (!primaryKeyColumn) {
    throw appError("VALIDATION_FAILED", "primaryKeyColumn is required.");
  }

  // ----- Object type --------------------------------------------------
  const otResult = await query(
    "SELECT * FROM object_type WHERE object_type_id = $1",
    [objectTypeId],
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeId}' not found.`,
    );
  }
  const objectType = otResult.rows[0];

  // ----- Object type properties (for column mapping validation) -------
  const propsResult = await query(
    "SELECT property_id, api_name FROM property WHERE object_type_id = $1",
    [objectTypeId],
  );
  const propertyApiNames = new Set<string>(
    propsResult.rows.map((p: { api_name: string }) => p.api_name),
  );
  for (const propApiName of Object.keys(columnMapping)) {
    if (!propertyApiNames.has(propApiName)) {
      throw appError(
        "COLUMN_MAPPING_INVALID",
        `columnMapping references unknown property '${propApiName}'.`,
      );
    }
  }

  // ----- Foundry dataset ----------------------------------------------
  // Uses the same `foundry_datasets` table that the upload endpoint
  // writes to, so any file the user has uploaded through tellus-fe is
  // a valid candidate.
  const fdResult = await query(
    "SELECT id, name, file_path, original_filename, row_count, status, schema_info FROM foundry_datasets WHERE id = $1",
    [foundryDatasetId],
  );
  if (fdResult.rows.length === 0) {
    throw appError(
      "DATASET_NOT_FOUND",
      `Foundry dataset '${foundryDatasetId}' was not found.`,
    );
  }
  const fd = fdResult.rows[0] as {
    id: string;
    name: string;
    file_path: string | null;
    original_filename: string | null;
    row_count: number | null;
    status: string;
    schema_info: any;
  };

  // Production hardening: never write a UUID-only backing_datasource that
  // can never HEAD-resolve. The 22001 content_hash bug previously left
  // datasets in `error` with a valid S3 object but a truncated row, and
  // the fallback `tag`-only path silently created a corrupt mapping that
  // turned a schema error into a funnel HEAD failure. Fail loudly instead.
  if (fd.status !== "ready") {
    const detail =
      (fd.schema_info as any)?.error ??
      (fd.schema_info as any)?.ingestionValidation?.message ??
      (fd.schema_info as any)?.ingestionValidation?.errorCode ??
      "unknown";
    throw appError(
      "DATASET_NOT_READY",
      `Foundry dataset '${foundryDatasetId}' is not ready (status=${fd.status}). ` +
        `Fix ingestion first (detail: ${detail}). Refusing to create backing_datasource with an unready source.`,
    );
  }
  if (!fd.file_path || typeof fd.file_path !== "string" || fd.file_path.trim().length === 0) {
    throw appError(
      "DATASET_FILE_PATH_MISSING",
      `Foundry dataset '${foundryDatasetId}' has no file_path — cannot build backing_datasource key. Re-ingest the dataset.`,
    );
  }
  // A valid S3 key always contains a '/' (project/folder/object). A bare
  // UUID (e.g. `effc028c-…`) is the pre-fix fallback and must never be
  // persisted again.
  if (!fd.file_path.includes("/")) {
    throw appError(
      "DATASET_FILE_PATH_INVALID",
      `Foundry dataset '${foundryDatasetId}' file_path '${fd.file_path}' is not a valid S3 key (missing '/'). ` +
        `Refusing to write UUID-only backing_datasource that would fail HEAD. Fix the dataset's file_path.`,
    );
  }

  // ----- Foundry columns ----------------------------------------------
  let fcResult = await query(
    "SELECT column_name FROM dataset_columns WHERE dataset_id = $1 ORDER BY ordinal_position ASC",
    [foundryDatasetId],
  );

  // ----- Iceberg fallback ---------------------------------------------
  // Iceberg sync outputs historically had no persisted schema scan: their
  // registry row is created by the table-import flow and nothing populated
  // `dataset_columns` (the CSV parse worker only handles uploaded S3
  // objects). Meanwhile the wizard's datasource picker reads through the
  // live-preview fallback, so users SAW columns and legitimately selected
  // this dataset — then registration failed with "has no columns yet",
  // pointing at a scan worker that would never run.
  //
  // Before giving up on an iceberg-backed dataset, locate its producing
  // table-import and run the same bounded schema scan the Dataset Preview
  // uses, persisting the result so this (and any later consumer) finds a
  // real schema. Only a genuinely unbuilt/unreadable table still errors.
  if (
    fcResult.rows.length === 0 &&
    typeof fd.file_path === "string" &&
    fd.file_path.startsWith("iceberg://")
  ) {
    const imp = await query(
      `SELECT ti.config AS import_config, COALESCE(c.tenant, 'default') AS tenant
         FROM table_imports ti
         LEFT JOIN connectivity_connections c ON c.rid = ti.connection_rid
        WHERE ti.dataset_rid = $1 AND ti.deleted_at IS NULL
        ORDER BY ti.created_at DESC
        LIMIT 1`,
      [`ri.foundry.main.dataset.${foundryDatasetId}`],
    );
    const cfg = imp.rows[0]?.import_config;
    if (cfg && cfg.schema && (cfg.targetTable || cfg.table)) {
      const { persistSyncedSchema } = await import(
        "./datasets/synced-dataset-registry"
      );
      const persisted = await persistSyncedSchema(
        foundryDatasetId,
        {
          schema: String(cfg.schema),
          table: String(cfg.targetTable ?? cfg.table),
          warehouseRoot: cfg.warehouseRoot ? String(cfg.warehouseRoot) : undefined,
        },
        imp.rows[0].tenant ?? "default",
      );
      if (persisted > 0) {
        fcResult = await query(
          "SELECT column_name FROM dataset_columns WHERE dataset_id = $1 ORDER BY ordinal_position ASC",
          [foundryDatasetId],
        );
      }
    }
  }

  if (fcResult.rows.length === 0) {
    const iceberg = typeof fd.file_path === "string" && fd.file_path.startsWith("iceberg://");
    throw appError(
      "DATASET_EMPTY",
      iceberg
        ? `Foundry dataset '${fd.name || foundryDatasetId}' has not been built yet — it has no data or columns. Run its producing sync first.`
        : `Foundry dataset '${foundryDatasetId}' has no columns yet. ` +
            `Wait for the scan worker to finish and try again.`,
    );
  }
  // Normalise BOM (U+FEFF) on both sides before comparison. Older
  // datasets were parsed without csv-parse's `bom: true` option, so
  // their first column header landed in `dataset_columns.column_name`
  // as "\uFEFForder_id". Meanwhile every client-side path (JSON body,
  // inputSanitizer's .trim(), clipboard paste, typing) strips BOM, so
  // the user-supplied mapping shows up without it. Comparing via a
  // BOM-stripped key makes both side symmetric without forcing a
  // costly reparse of every already-ingested dataset.
  const stripBom = (s: string): string => s.replace(/^\uFEFF/, "").replace(/\uFEFF/g, "");
  const availableColumns = fcResult.rows.map(
    (r: { column_name: string }) => r.column_name,
  );
  const normalizedAvailable = new Set(availableColumns.map(stripBom));

  // ----- Validate every mapped source column exists in the dataset ---
  for (const [propApiName, sourceColumn] of Object.entries(columnMapping)) {
    const key = stripBom(sourceColumn);
    if (!normalizedAvailable.has(key)) {
      const suggestion = findClosestColumn(sourceColumn, availableColumns);
      throw appError(
        "COLUMN_MAPPING_INVALID",
        `Property '${propApiName}' maps to column '${sourceColumn}', ` +
          `which does not exist in the dataset.` +
          (suggestion ? ` Did you mean '${stripBom(suggestion)}'?` : ""),
      );
    }
  }
  if (!normalizedAvailable.has(stripBom(primaryKeyColumn))) {
    throw appError(
      "PRIMARY_KEY_MISMATCH",
      `primaryKeyColumn '${primaryKeyColumn}' does not exist in the dataset.`,
    );
  }

  // ----- One-datasource-per-object-type rule --------------------------
  const existingDs = await query(
    "SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId],
  );
  if (existingDs.rows.length > 0) {
    throw appError(
      "DATASOURCE_ALREADY_REGISTERED",
      "This object type already has a registered datasource.",
    );
  }

  // ----- Insert -------------------------------------------------------
  // `backing_datasource` has a UNIQUE index on `file_path` (see
  // `idx_ds_file_path` in migrate.ts). That constraint was designed
  // for the legacy filesystem path where `file_path` actually points
  // at a real file on disk and "each file backs one object type"
  // makes sense. For the Foundry bridge we're storing a synthetic
  // identifier instead, so we key it on BOTH the foundry dataset id
  // AND the object type id — two object types backed by the same
  // foundry dataset therefore get two distinct synthetic paths, and
  // re-running the wizard after any partial failure never collides
  // with a dead row from a previous attempt.
  const tag = `foundry-dataset:${foundryDatasetId}#object-type:${objectTypeId}`;
  // Hardened: fd.file_path is now guaranteed valid (status=ready + contains '/');
  // never fall back to bare UUID tag.
  const filePathValue = `${fd.file_path}#${tag}`;
  // Registration-time marker validation (Blocker 4): the synthetic locator
  // must be exactly `<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>`.
  // A malformed locator can never HEAD-resolve, and the funnel now fails
  // such rows loudly instead of emitting zero rows — so refuse to persist
  // one here.
  if (
    !/^(.+)#foundry-dataset:([0-9a-f-]{36})#object-type:([0-9a-f-]{36})$/i.test(
      filePathValue,
    )
  ) {
    throw appError(
      "DATASOURCE_MARKER_INVALID",
      `Refusing to register backing_datasource with malformed foundry locator '${filePathValue}' — ` +
        `expected '<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>'. Fix the dataset's file_path.`,
    );
  }
  const fileFormat = inferFoundryFileFormat(fd.original_filename || fd.file_path || "");

  let insertResult;
  try {
    insertResult = await query(
      `INSERT INTO backing_datasource
         (object_type_id, dataset_name, file_path, file_format,
          column_mapping, primary_key_column, row_count, column_names)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        objectTypeId,
        fd.name || fd.original_filename || "unnamed",
        filePathValue,
        fileFormat,
        JSON.stringify(columnMapping),
        primaryKeyColumn,
        fd.row_count ?? null,
        availableColumns,
      ],
    );
  } catch (err: any) {
    // Defensive: if the unique index ever fires anyway — e.g. a
    // future migration tightens it — surface a clear DATASOURCE_
    // ALREADY_REGISTERED so the frontend can show a meaningful
    // message instead of a generic 500.
    if (err.code === "23505") {
      throw appError(
        "DATASOURCE_ALREADY_REGISTERED",
        "Another backing datasource is already registered for this object type or file path.",
      );
    }
    throw err;
  }
  const row = insertResult.rows[0];

  // ----- Funnel state bookkeeping -------------------------------------
  const fsResult = await query(
    "SELECT * FROM funnel_state WHERE object_type_id = $1",
    [objectTypeId],
  );
  if (fsResult.rows.length > 0) {
    const currentStatus = fsResult.rows[0].status;
    let newStatus = currentStatus;
    if (currentStatus === "indexed") newStatus = "stale";
    else if (currentStatus === "failed") newStatus = "not_indexed";
    if (newStatus !== currentStatus) {
      await query(
        "UPDATE funnel_state SET status = $1, updated_at = NOW() WHERE object_type_id = $2",
        [newStatus, objectTypeId],
      );
    }
  }

  return {
    objectType: objectType.api_name,
    datasetId: foundryDatasetId,
    datasetName: fd.name || fd.original_filename || null,
    filePath: filePathValue,
    columnMapping,
    primaryKeyColumn,
    registeredAt: row.registered_at,
  };
}

/** Infer backing_datasource.file_format from a Foundry filename. */
function inferFoundryFileFormat(filename: string): "csv" | "json" | "parquet" {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".parquet")) return "parquet";
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) return "json";
  return "csv";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  registerWithDataset,
  registerWithFoundryDataset,
  levenshteinDistance,
  findClosestColumn,
};

export { findClosestColumn };

// ---------------------------------------------------------------------------
// Inline self-tests for levenshteinDistance
// (run: npx tsx src/services/datasetDatasourceService.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
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

  console.log("Running datasetDatasourceService self-tests...\n");

  // =====================================================================
  // levenshteinDistance tests
  // =====================================================================

  // Identical strings
  assert(
    levenshteinDistance("hello", "hello") === 0,
    'levenshtein("hello", "hello") === 0'
  );

  // Empty strings
  assert(
    levenshteinDistance("", "") === 0,
    'levenshtein("", "") === 0'
  );
  assert(
    levenshteinDistance("abc", "") === 3,
    'levenshtein("abc", "") === 3'
  );
  assert(
    levenshteinDistance("", "abc") === 3,
    'levenshtein("", "abc") === 3'
  );

  // Single character operations
  assert(
    levenshteinDistance("a", "b") === 1,
    'levenshtein("a", "b") === 1 (substitution)'
  );
  assert(
    levenshteinDistance("a", "ab") === 1,
    'levenshtein("a", "ab") === 1 (insertion)'
  );
  assert(
    levenshteinDistance("ab", "a") === 1,
    'levenshtein("ab", "a") === 1 (deletion)'
  );

  // Common typos
  assert(
    levenshteinDistance("salary", "salry") === 1,
    'levenshtein("salary", "salry") === 1 (missing letter)'
  );
  assert(
    levenshteinDistance("salary", "saalary") === 1,
    'levenshtein("salary", "saalary") === 1 (extra letter)'
  );
  assert(
    levenshteinDistance("annual_salary", "annual_salry") === 1,
    'levenshtein("annual_salary", "annual_salry") === 1'
  );
  assert(
    levenshteinDistance("annual_salary", "annual_salery") === 1,
    'levenshtein("annual_salary", "annual_salery") === 1 (inserted e)'
  );
  assert(
    levenshteinDistance("employee_id", "employe_id") === 1,
    'levenshtein("employee_id", "employe_id") === 1'
  );

  // Distance 2 (typical "Did you mean?" threshold)
  assert(
    levenshteinDistance("annual_salary", "anual_salry") === 2,
    'levenshtein("annual_salary", "anual_salry") === 2'
  );

  // Large distance — clearly different words
  assert(
    levenshteinDistance("kitten", "sitting") === 3,
    'levenshtein("kitten", "sitting") === 3'
  );
  assert(
    levenshteinDistance("saturday", "sunday") === 3,
    'levenshtein("saturday", "sunday") === 3'
  );

  // Completely different strings
  assert(
    levenshteinDistance("abc", "xyz") === 3,
    'levenshtein("abc", "xyz") === 3'
  );

  // Symmetry
  assert(
    levenshteinDistance("foo", "bar") === levenshteinDistance("bar", "foo"),
    "levenshtein is symmetric"
  );

  // Longer strings
  assert(
    levenshteinDistance("department_name", "department_naem") === 2,
    'levenshtein("department_name", "department_naem") === 2 (transposition-like)'
  );

  // Case sensitivity
  assert(
    levenshteinDistance("Salary", "salary") === 1,
    'levenshtein("Salary", "salary") === 1 (case matters)'
  );

  // =====================================================================
  // findClosestColumn tests
  // =====================================================================

  const columns = [
    "emp_id",
    "full_name",
    "annual_salary",
    "start_date",
    "is_active",
    "department",
  ];

  // Exact match not needed — findClosest still finds it at distance 0
  const exact = findClosestColumn("annual_salary", columns);
  assert(exact === "annual_salary", 'findClosest exact match: "annual_salary"');

  // Typo: "annual_salry" → "annual_salary" (distance 1)
  const typo1 = findClosestColumn("annual_salry", columns);
  assert(
    typo1 === "annual_salary",
    'findClosest typo: "annual_salry" → "annual_salary"'
  );

  // Typo: "emp_idd" → "emp_id" (distance 1)
  const typo2 = findClosestColumn("emp_idd", columns);
  assert(typo2 === "emp_id", 'findClosest typo: "emp_idd" → "emp_id"');

  // Typo: "deprtment" → "department" (distance 2)
  const typo3 = findClosestColumn("deprtment", columns);
  assert(
    typo3 === "department",
    'findClosest typo: "deprtment" → "department"'
  );

  // Too far away: "zzzzz" → null (distance > 2)
  const noMatch = findClosestColumn("zzzzz", columns);
  assert(
    noMatch === null,
    'findClosest no match: "zzzzz" → null'
  );

  // Empty available columns → null
  const emptyResult = findClosestColumn("anything", []);
  assert(emptyResult === null, "findClosest empty columns → null");

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll datasetDatasourceService tests passed");
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
