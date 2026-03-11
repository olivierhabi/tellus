// ---------------------------------------------------------------------------
// Batch Document Builder
//
// Takes the full output from the CSV reader (all rows) and transforms them
// all into OpenSearch documents, collecting valid documents for indexing and
// invalid documents for error reporting. Orchestrates the row transformer
// (Task 8) across all rows, tracks progress, and builds the final batch
// for OpenSearch's bulk API.
//
// In Palantir's Funnel, this is the batch compilation step — where all rows
// from the datasource are compiled into a batch of object documents ready
// for indexing.
//
// Design: This is a **pure transformation function**. It does NOT fetch
// metadata from PostgreSQL and does NOT validate primary keys. All metadata
// is passed in by the orchestrator (Task 12). Primary key validation is the
// sole responsibility of the orchestrator.
// ---------------------------------------------------------------------------

import {
  transformRow,
  ObjectTypeRecord,
  PropertyRecord,
  PropertyColumnMapping,
  TransformFailure,
} from "./rowTransformer";
import type { CSVRow } from "./csvReader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress callback payload. */
export interface BatchProgress {
  processed: number;
  total: number;
  percentComplete: number;
}

/** Options for buildBatch(). */
export interface BuildBatchOptions {
  /** If true (default), reject row on any conversion error. */
  strict?: boolean;
  /** Transaction/version identifier for this indexing run. */
  datasourceVersion?: string;
  /** Callback called every 100 rows with progress information. */
  onProgress?: (progress: BatchProgress) => void;
}

/** An invalid document entry in the batch result. */
export interface InvalidDocument {
  lineNumber: number;
  errors: string[];
  rawRow: CSVRow;
}

/** The result of buildBatch(). */
export interface BuildBatchResult {
  success: boolean;
  objectTypeApiName: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  validDocuments: Array<Record<string, unknown>>;
  invalidDocuments: InvalidDocument[];
  deduplicatedCount: number;
  datasourceVersion: string | null;
  buildDurationMs: number;
}

// ---------------------------------------------------------------------------
// buildBatch()
// ---------------------------------------------------------------------------

/**
 * Transform all CSV rows into OpenSearch documents, collecting valid and
 * invalid results separately.
 *
 * @param rows             - Array of row objects from the CSV reader.
 * @param objectType       - Object type record from PostgreSQL.
 * @param properties       - Property records from PostgreSQL.
 * @param columnMapping    - Property API name → CSV column name mapping.
 * @param primaryKeyColumn - CSV column name for the primary key (unused
 *                           directly — PK validation is the orchestrator's
 *                           responsibility; included for API completeness).
 * @param options          - Optional configuration.
 * @returns A BuildBatchResult with valid/invalid documents and metrics.
 */
export function buildBatch(
  rows: CSVRow[],
  objectType: ObjectTypeRecord,
  properties: PropertyRecord[],
  columnMapping: PropertyColumnMapping,
  primaryKeyColumn: string,
  options?: BuildBatchOptions
): BuildBatchResult {
  const startTime = Date.now();
  const strict = options?.strict !== false;
  const datasourceVersion = options?.datasourceVersion ?? null;
  const onProgress = options?.onProgress;
  const total = rows.length;

  const validDocuments: Array<Record<string, unknown>> = [];
  const invalidDocuments: InvalidDocument[] = [];

  // -----------------------------------------------------------------------
  // 1. Iterate through all rows, transforming each one
  // -----------------------------------------------------------------------
  for (let i = 0; i < rows.length; i++) {
    const lineNumber = i + 1; // 1-indexed

    const result = transformRow(
      rows[i],
      lineNumber,
      objectType,
      properties,
      columnMapping,
      {
        strict,
        datasourceVersion,
      }
    );

    if (result.valid) {
      validDocuments.push(result.document);
    } else {
      const failure = result as TransformFailure;
      invalidDocuments.push({
        lineNumber: failure.lineNumber,
        errors: failure.errors,
        rawRow: rows[i],
      });
    }

    // Progress callback every 100 rows
    if (onProgress && (lineNumber % 100 === 0)) {
      onProgress({
        processed: lineNumber,
        total,
        percentComplete: Math.round((lineNumber / total) * 100),
      });
    }
  }

  // Final progress callback at 100%
  if (onProgress && total > 0) {
    onProgress({
      processed: total,
      total,
      percentComplete: 100,
    });
  }

  // -----------------------------------------------------------------------
  // 2. Deduplicate by primary key — "last row wins"
  // -----------------------------------------------------------------------
  const beforeDedup = validDocuments.length;
  const deduped = deduplicateByPK(validDocuments);
  const deduplicatedCount = beforeDedup - deduped.length;

  // -----------------------------------------------------------------------
  // 3. Build and return result
  // -----------------------------------------------------------------------
  return {
    success: invalidDocuments.length === 0,
    objectTypeApiName: objectType.api_name,
    totalRows: total,
    validCount: deduped.length,
    invalidCount: invalidDocuments.length,
    validDocuments: deduped,
    invalidDocuments,
    deduplicatedCount,
    datasourceVersion,
    buildDurationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// deduplicateByPK()
// ---------------------------------------------------------------------------

/**
 * Deduplicate documents by __pk field using "last row wins" semantics.
 * This matches Palantir's "most recent transaction wins" behavior.
 *
 * @param documents - Array of valid documents (each with a __pk field).
 * @returns Deduplicated array preserving last occurrence order.
 */
function deduplicateByPK(
  documents: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  // Map from __pk value → index of last occurrence
  const lastOccurrence = new Map<string, number>();

  for (let i = 0; i < documents.length; i++) {
    const pk = String(documents[i].__pk);
    lastOccurrence.set(pk, i);
  }

  // If no duplicates, return original array (fast path)
  if (lastOccurrence.size === documents.length) {
    return documents;
  }

  // Collect only the last occurrence of each PK, preserving order
  const keepIndices = new Set(lastOccurrence.values());
  return documents.filter((_, index) => keepIndices.has(index));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { buildBatch };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/batchDocumentBuilder.ts)
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

  console.log("Running batchDocumentBuilder self-tests...\n");

  // =====================================================================
  // Test fixtures
  // =====================================================================

  const objectType: ObjectTypeRecord = {
    api_name: "Employee",
    primary_key_property_id: "pk-uuid-1",
  };

  const properties: PropertyRecord[] = [
    {
      property_id: "pk-uuid-1",
      api_name: "employeeId",
      base_type: "string",
      is_array: false,
      is_required: true,
    },
    {
      property_id: "uuid-2",
      api_name: "fullName",
      base_type: "string",
      is_array: false,
      is_required: true,
    },
    {
      property_id: "uuid-3",
      api_name: "salary",
      base_type: "double",
      is_array: false,
      is_required: false,
    },
    {
      property_id: "uuid-4",
      api_name: "isActive",
      base_type: "boolean",
      is_array: false,
      is_required: false,
    },
  ];

  const columnMapping: PropertyColumnMapping = {
    employeeId: "emp_id",
    fullName: "full_name",
    salary: "salary",
    isActive: "is_active",
  };

  function makeRow(id: string, name: string, salary: string, active: string): CSVRow {
    return {
      emp_id: id,
      full_name: name,
      salary,
      is_active: active,
    };
  }

  // =====================================================================
  // Test 1: All valid rows
  // =====================================================================
  {
    const rows: CSVRow[] = [
      makeRow("EMP-001", "Alice", "100000", "true"),
      makeRow("EMP-002", "Bob", "90000", "false"),
      makeRow("EMP-003", "Charlie", "110000", "yes"),
    ];

    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id", {
      datasourceVersion: "txn-001",
    });

    assert(result.success === true, "all valid: success");
    assert(result.objectTypeApiName === "Employee", "all valid: objectTypeApiName");
    assert(result.totalRows === 3, "all valid: totalRows");
    assert(result.validCount === 3, "all valid: validCount");
    assert(result.invalidCount === 0, "all valid: invalidCount");
    assert(result.validDocuments.length === 3, "all valid: validDocuments length");
    assert(result.invalidDocuments.length === 0, "all valid: invalidDocuments length");
    assert(result.deduplicatedCount === 0, "all valid: no dedup");
    assert(result.datasourceVersion === "txn-001", "all valid: datasourceVersion");
    assert(typeof result.buildDurationMs === "number", "all valid: buildDurationMs");

    // Verify document structure
    const doc0 = result.validDocuments[0];
    assert(doc0.__pk === "EMP-001", "all valid: doc0 __pk");
    assert(doc0.__objectType === "Employee", "all valid: doc0 __objectType");
    assert(doc0.salary === 100000, "all valid: doc0 salary is number");
    assert(doc0.isActive === true, "all valid: doc0 isActive is boolean");
  }

  // =====================================================================
  // Test 2: Some invalid rows (strict mode)
  // =====================================================================
  {
    const rows: CSVRow[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push(makeRow(`EMP-${i + 1}`, `Name ${i + 1}`, String((i + 1) * 1000), "true"));
    }
    // Inject 5 invalid rows (bad salary values)
    rows[44] = makeRow("EMP-45", "Bad Salary 1", "not-a-number", "true");
    rows[199] = makeRow("EMP-200", "Bad Salary 2", "abc", "true");
    rows[499] = makeRow("EMP-500", "", "50000", "true"); // empty required name
    rows[750] = makeRow("EMP-751", "Bad Salary 3", "xyz", "true");
    rows[871] = makeRow("EMP-872", "Bad Active", "80000", "maybe");

    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id", {
      strict: true,
      datasourceVersion: "txn-002",
    });

    assert(result.success === false, "some invalid: success is false");
    assert(result.totalRows === 1000, "some invalid: totalRows");
    assert(result.validCount === 995, `some invalid: validCount is 995 (got ${result.validCount})`);
    assert(result.invalidCount === 5, `some invalid: invalidCount is 5 (got ${result.invalidCount})`);
    assert(result.validDocuments.length === 995, "some invalid: validDocuments length");
    assert(result.invalidDocuments.length === 5, "some invalid: invalidDocuments length");

    // Verify line numbers of invalid rows
    const invalidLines = result.invalidDocuments.map((d) => d.lineNumber).sort((a, b) => a - b);
    assert(
      invalidLines[0] === 45 &&
        invalidLines[1] === 200 &&
        invalidLines[2] === 500 &&
        invalidLines[3] === 751 &&
        invalidLines[4] === 872,
      `some invalid: line numbers are [45,200,500,751,872] (got [${invalidLines}])`
    );

    // Verify error messages are present
    assert(
      result.invalidDocuments[0].errors.length > 0,
      "some invalid: first invalid has errors"
    );
    assert(
      result.invalidDocuments[0].rawRow.emp_id === "EMP-45",
      "some invalid: rawRow preserved"
    );
  }

  // =====================================================================
  // Test 3: Non-strict mode (errors become warnings, all rows valid)
  // =====================================================================
  {
    const rows: CSVRow[] = [
      makeRow("EMP-001", "Alice", "not-a-number", "true"),
      makeRow("EMP-002", "Bob", "90000", "maybe"),
      makeRow("EMP-003", "Charlie", "110000", "true"),
    ];

    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id", {
      strict: false,
    });

    assert(result.success === true, "non-strict: success is true");
    assert(result.validCount === 3, "non-strict: validCount is 3");
    assert(result.invalidCount === 0, "non-strict: invalidCount is 0");
    assert(result.validDocuments[0].salary === null, "non-strict: bad salary is null");
    assert(result.validDocuments[1].isActive === null, "non-strict: bad boolean is null");
  }

  // =====================================================================
  // Test 4: Duplicate primary keys — last row wins
  // =====================================================================
  {
    const rows: CSVRow[] = [
      makeRow("EMP-001", "Alice v1", "100000", "true"),
      makeRow("EMP-002", "Bob", "90000", "true"),
      makeRow("EMP-001", "Alice v2", "120000", "true"),  // duplicate of row 1
      makeRow("EMP-003", "Charlie", "110000", "true"),
      makeRow("EMP-002", "Bob v2", "95000", "false"),     // duplicate of row 2
    ];

    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id");

    assert(result.success === true, "dedup: success");
    assert(result.totalRows === 5, "dedup: totalRows");
    assert(result.validCount === 3, `dedup: validCount is 3 (got ${result.validCount})`);
    assert(result.deduplicatedCount === 2, `dedup: deduplicatedCount is 2 (got ${result.deduplicatedCount})`);

    // Verify "last row wins" — Alice v2 and Bob v2
    const emp001 = result.validDocuments.find((d) => d.__pk === "EMP-001");
    assert(emp001 !== undefined && emp001.fullName === "Alice v2", "dedup: Alice v2 wins");

    const emp002 = result.validDocuments.find((d) => d.__pk === "EMP-002");
    assert(emp002 !== undefined && emp002.fullName === "Bob v2", "dedup: Bob v2 wins");

    const emp003 = result.validDocuments.find((d) => d.__pk === "EMP-003");
    assert(emp003 !== undefined && emp003.fullName === "Charlie", "dedup: Charlie unchanged");
  }

  // =====================================================================
  // Test 5: Progress callback
  // =====================================================================
  {
    const rows: CSVRow[] = [];
    for (let i = 0; i < 350; i++) {
      rows.push(makeRow(`EMP-${i + 1}`, `Name ${i + 1}`, String(i * 1000), "true"));
    }

    const progressCalls: BatchProgress[] = [];
    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id", {
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    assert(result.validCount === 350, "progress: validCount");

    // Should have callbacks at 100, 200, 300, and final at 350
    assert(
      progressCalls.length === 4,
      `progress: 4 callbacks (got ${progressCalls.length})`
    );

    assert(progressCalls[0].processed === 100, "progress: first callback at 100");
    assert(progressCalls[0].total === 350, "progress: total is 350");
    assert(progressCalls[0].percentComplete === 29, `progress: 29% (got ${progressCalls[0].percentComplete})`);

    assert(progressCalls[1].processed === 200, "progress: second callback at 200");
    assert(progressCalls[2].processed === 300, "progress: third callback at 300");

    // Final callback at 100%
    assert(progressCalls[3].processed === 350, "progress: final at 350");
    assert(progressCalls[3].percentComplete === 100, "progress: final at 100%");
  }

  // =====================================================================
  // Test 6: Empty dataset
  // =====================================================================
  {
    const result = buildBatch([], objectType, properties, columnMapping, "emp_id");

    assert(result.success === true, "empty: success");
    assert(result.totalRows === 0, "empty: totalRows");
    assert(result.validCount === 0, "empty: validCount");
    assert(result.invalidCount === 0, "empty: invalidCount");
    assert(result.validDocuments.length === 0, "empty: no documents");
    assert(result.deduplicatedCount === 0, "empty: no dedup");
  }

  // =====================================================================
  // Test 7: All invalid rows
  // =====================================================================
  {
    const rows: CSVRow[] = [
      makeRow("", "No PK 1", "100", "true"),   // empty PK
      makeRow("", "No PK 2", "200", "true"),   // empty PK
      makeRow("", "No PK 3", "300", "true"),   // empty PK
    ];

    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id");

    assert(result.success === false, "all invalid: success is false");
    assert(result.validCount === 0, "all invalid: validCount is 0");
    assert(result.invalidCount === 3, "all invalid: invalidCount is 3");
  }

  // =====================================================================
  // Test 8: Default options
  // =====================================================================
  {
    const rows: CSVRow[] = [makeRow("EMP-001", "Test", "50000", "true")];
    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id");

    assert(result.success === true, "defaults: success");
    assert(result.datasourceVersion === null, "defaults: datasourceVersion is null");
  }

  // =====================================================================
  // Test 9: Performance — 10,000 rows
  // =====================================================================
  {
    const rows: CSVRow[] = [];
    for (let i = 0; i < 10000; i++) {
      rows.push(makeRow(`EMP-${i}`, `Name-${i}`, String(i * 100), "true"));
    }
    const start = Date.now();
    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id");
    const elapsed = Date.now() - start;

    assert(result.validCount === 10000, "perf: 10k valid");
    assert(elapsed < 5000, `perf: 10k rows in ${elapsed}ms (< 5000ms)`);
    console.log(`  (10k rows built in ${elapsed}ms)`);
  }

  // =====================================================================
  // Test 10: Dedup with invalid rows mixed in
  // =====================================================================
  {
    const rows: CSVRow[] = [
      makeRow("EMP-001", "Alice", "100000", "true"),
      makeRow("EMP-002", "Bob", "not-a-number", "true"),  // invalid
      makeRow("EMP-001", "Alice v2", "110000", "true"),    // dup of row 1
    ];

    const result = buildBatch(rows, objectType, properties, columnMapping, "emp_id");

    assert(result.success === false, "dedup+invalid: success false due to invalid row");
    assert(result.invalidCount === 1, "dedup+invalid: 1 invalid");
    // 2 valid before dedup, 1 deduped → 1 remaining
    assert(result.validCount === 1, `dedup+invalid: validCount 1 (got ${result.validCount})`);
    assert(result.deduplicatedCount === 1, `dedup+invalid: 1 deduped (got ${result.deduplicatedCount})`);
    assert(
      result.validDocuments[0].fullName === "Alice v2",
      "dedup+invalid: Alice v2 wins"
    );
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll batchDocumentBuilder tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
