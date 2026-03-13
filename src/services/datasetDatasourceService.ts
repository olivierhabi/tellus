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
        typeof col === "string" ? col : col.name || String(col)
      );
    }

    // 4. Validate column mapping values against available columns
    for (const [propApiName, columnName] of Object.entries(columnMapping)) {
      if (!availableColumns.includes(columnName)) {
        const suggestion = findClosestColumn(columnName, availableColumns);
        const didYouMean = suggestion
          ? ` Did you mean '${suggestion}'?`
          : "";
        throw appError(
          "COLUMN_NOT_FOUND",
          `Column '${columnName}' does not exist in dataset '${datasetId}'. Available columns: [${availableColumns.map((c) => `'${c}'`).join(", ")}].${didYouMean}`
        );
      }
    }

    // 5. Validate primaryKeyColumn against available columns
    if (primaryKeyColumn && !availableColumns.includes(primaryKeyColumn)) {
      const suggestion = findClosestColumn(
        primaryKeyColumn,
        availableColumns
      );
      const didYouMean = suggestion
        ? ` Did you mean '${suggestion}'?`
        : "";
      throw appError(
        "COLUMN_NOT_FOUND",
        `Column '${primaryKeyColumn}' does not exist in dataset '${datasetId}'. Available columns: [${availableColumns.map((c) => `'${c}'`).join(", ")}].${didYouMean}`
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
// Exports
// ---------------------------------------------------------------------------

export default {
  registerWithDataset,
  levenshteinDistance,
  findClosestColumn,
};

export { findClosestColumn };

// ---------------------------------------------------------------------------
// Inline self-tests for levenshteinDistance
// (run: npx tsx src/services/datasetDatasourceService.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
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
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
