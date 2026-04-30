// ---------------------------------------------------------------------------
// Datasource File Validator
//
// Validates that a datasource file is compatible with an object type before
// indexing begins. Checks that: the file exists and is readable, all mapped
// columns exist in the file, the primary key column exists, the file has at
// least one data row, and the file can be parsed as valid CSV with correct
// types. This runs before the full pipeline to give early, clear error
// messages.
//
// In Palantir's architecture, the Object Data Funnel validates the backing
// datasource schema before starting the sync. If the schema doesn't match
// the object type's property definitions, the sync is rejected with a
// descriptive error.
// ---------------------------------------------------------------------------

import { query as dbQuery } from "../../db";
import { getCSVSchema, getCSVPreview } from "./csvReader";
import { convertValue } from "./typeConverter";
import type { QueryResult } from "pg";
import type { CSVSchemaResponse, ReadCSVResult, CSVRow } from "./csvReader";
import type { PropertyInput } from "../mapping/typeMapper";
import type { ConvertResult } from "./typeConverter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single conversion error from the preview type check. */
export interface ConversionError {
  row: number;
  property: string;
  value: string;
  error: string;
}

/** Result of a single validation check. */
export interface FileReadableCheck {
  passed: boolean;
  error?: string;
}

export interface AllColumnsExistCheck {
  passed: boolean;
  missingColumns: string[];
}

export interface PrimaryKeyExistsCheck {
  passed: boolean;
}

export interface HasDataRowsCheck {
  passed: boolean;
  rowCount: number;
}

export interface PreviewTypesValidCheck {
  passed: boolean;
  conversionErrors: ConversionError[];
}

/** The complete validation report. */
export interface ValidationChecks {
  fileReadable: FileReadableCheck;
  allColumnsExist: AllColumnsExistCheck;
  primaryKeyExists: PrimaryKeyExistsCheck;
  hasDataRows: HasDataRowsCheck;
  previewTypesValid: PreviewTypesValidCheck;
}

export interface ValidationReport {
  valid: boolean;
  checks: ValidationChecks;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Injected dependencies for testing without live services. */
export interface DatasourceValidatorDeps {
  /** Query PostgreSQL. */
  dbQuery: (text: string, values?: unknown[]) => Promise<QueryResult>;
  /** Read CSV headers. */
  getCSVSchema: (filePath: string) => Promise<CSVSchemaResponse>;
  /** Read CSV preview rows. */
  getCSVPreview: (filePath: string, rowCount: number) => Promise<ReadCSVResult>;
  /** Convert a single value. */
  convertValue: (rawValue: string | null | undefined, property: PropertyInput) => ConvertResult;
}

export interface DatasourceValidatorOptions {
  deps?: Partial<DatasourceValidatorDeps>;
}

// ---------------------------------------------------------------------------
// Resolve dependencies
// ---------------------------------------------------------------------------

function resolveDeps(
  partial?: Partial<DatasourceValidatorDeps>
): DatasourceValidatorDeps {
  return {
    dbQuery: partial?.dbQuery ?? dbQuery,
    getCSVSchema: partial?.getCSVSchema ?? getCSVSchema,
    getCSVPreview: partial?.getCSVPreview ?? getCSVPreview,
    convertValue: partial?.convertValue ?? convertValue,
  };
}

// ---------------------------------------------------------------------------
// Default failed report
// ---------------------------------------------------------------------------

function failedReport(fileError: string): ValidationReport {
  return {
    valid: false,
    checks: {
      fileReadable: { passed: false, error: fileError },
      allColumnsExist: { passed: false, missingColumns: [] },
      primaryKeyExists: { passed: false },
      hasDataRows: { passed: false, rowCount: 0 },
      previewTypesValid: { passed: false, conversionErrors: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// validateDatasource()
// ---------------------------------------------------------------------------

/**
 * Validate that a datasource file is compatible with an object type before
 * indexing begins.
 *
 * Performs 5 checks:
 *   1. fileReadable      — file exists and can be parsed as CSV
 *   2. allColumnsExist   — all mapped columns exist in the CSV headers
 *   3. primaryKeyExists  — the primary_key_column exists in the CSV headers
 *   4. hasDataRows       — the CSV has at least one data row
 *   5. previewTypesValid — first 5 rows convert cleanly against property types
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param options           - Optional configuration (e.g. injected deps).
 * @returns A ValidationReport with `valid` true only if ALL checks pass.
 */
export async function validateDatasource(
  objectTypeApiName: string,
  options?: DatasourceValidatorOptions
): Promise<ValidationReport> {
  const deps = resolveDeps(options?.deps);

  // -----------------------------------------------------------------------
  // Step 1: Look up object type and backing datasource
  // -----------------------------------------------------------------------
  const otResult = await deps.dbQuery(
    "SELECT object_type_id FROM object_type WHERE api_name = $1 LIMIT 1",
    [objectTypeApiName]
  );

  if (otResult.rows.length === 0) {
    return failedReport(
      `No backing datasource registered for object type '${objectTypeApiName}'`
    );
  }

  const objectTypeId = otResult.rows[0].object_type_id;

  const dsResult = await deps.dbQuery(
    "SELECT file_path, column_mapping, primary_key_column FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );

  if (dsResult.rows.length === 0) {
    return failedReport(
      `No backing datasource registered for object type '${objectTypeApiName}'`
    );
  }

  const ds = dsResult.rows[0];
  const filePath = ds.file_path as string;
  const columnMapping: Record<string, string> =
    typeof ds.column_mapping === "string"
      ? JSON.parse(ds.column_mapping)
      : ds.column_mapping;
  const primaryKeyColumn = ds.primary_key_column as string;

  // -----------------------------------------------------------------------
  // Step 2: Check file is readable — get CSV schema (headers)
  // -----------------------------------------------------------------------
  const schemaResult = await deps.getCSVSchema(filePath);

  if (!("columns" in schemaResult) || !schemaResult.columns) {
    // getCSVSchema returned { success: false, error: ... }
    const errMsg =
      "error" in schemaResult
        ? (schemaResult as { error: { message: string } }).error.message
        : "File is not readable or is not valid CSV";

    return failedReport(errMsg);
  }

  const csvColumns = new Set(schemaResult.columns);
  const fileReadable: FileReadableCheck = { passed: true };

  // -----------------------------------------------------------------------
  // Step 3: Check all mapped columns exist in the CSV headers
  // -----------------------------------------------------------------------
  // column_mapping is { propertyApiName: csvColumnName }
  // We need to check that every CSV column name (the values) exists in headers.
  const mappedCsvColumns = Object.values(columnMapping);
  const missingColumns = mappedCsvColumns.filter((col) => !csvColumns.has(col));

  const allColumnsExist: AllColumnsExistCheck = {
    passed: missingColumns.length === 0,
    missingColumns,
  };

  // -----------------------------------------------------------------------
  // Step 4: Check primary key column exists in CSV headers
  // -----------------------------------------------------------------------
  const primaryKeyExists: PrimaryKeyExistsCheck = {
    passed: csvColumns.has(primaryKeyColumn),
  };

  // -----------------------------------------------------------------------
  // Step 5: Read preview rows — check file has data and types convert
  // -----------------------------------------------------------------------
  const previewResult = await deps.getCSVPreview(filePath, 5);

  let hasDataRows: HasDataRowsCheck;
  let previewTypesValid: PreviewTypesValidCheck;

  if (!previewResult.success) {
    hasDataRows = { passed: false, rowCount: 0 };
    previewTypesValid = { passed: false, conversionErrors: [] };
  } else {
    const rowCount = previewResult.rowCount;
    hasDataRows = { passed: rowCount > 0, rowCount };

    // -----------------------------------------------------------------
    // Step 5b: Type-check the preview rows against property definitions
    // -----------------------------------------------------------------
    // Fetch properties for this object type
    const propResult = await deps.dbQuery(
      "SELECT api_name, base_type, is_array, is_required FROM property WHERE object_type_id = $1",
      [objectTypeId]
    );

    // Build a map from property api_name -> PropertyInput
    const propertyMap = new Map<string, PropertyInput>();
    for (const row of propResult.rows) {
      propertyMap.set(row.api_name, {
        api_name: row.api_name,
        base_type: row.base_type,
        is_array: row.is_array,
        is_required: row.is_required,
        struct_schema: row.struct_schema ?? null,
      });
    }

    // Inverse mapping: csvColumnName -> propertyApiName
    const inverseMapping = new Map<string, string>();
    for (const [propName, csvCol] of Object.entries(columnMapping)) {
      inverseMapping.set(csvCol, propName);
    }

    const conversionErrors: ConversionError[] = [];

    for (let i = 0; i < previewResult.rows.length; i++) {
      const row: CSVRow = previewResult.rows[i];

      for (const [csvCol, propApiName] of inverseMapping.entries()) {
        const property = propertyMap.get(propApiName);
        if (!property) continue;

        const rawValue = row[csvCol] ?? null;
        const result = deps.convertValue(rawValue, property);

        if (!result.valid) {
          conversionErrors.push({
            row: i + 1,
            property: propApiName,
            value: rawValue ?? "",
            error: result.error,
          });
        }
      }
    }

    previewTypesValid = {
      passed: conversionErrors.length === 0,
      conversionErrors,
    };
  }

  // -----------------------------------------------------------------------
  // Step 6: Build the final report
  // -----------------------------------------------------------------------
  const valid =
    fileReadable.passed &&
    allColumnsExist.passed &&
    primaryKeyExists.passed &&
    hasDataRows.passed &&
    previewTypesValid.passed;

  return {
    valid,
    checks: {
      fileReadable,
      allColumnsExist,
      primaryKeyExists,
      hasDataRows,
      previewTypesValid,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { validateDatasource };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/datasourceValidator.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
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

  console.log("Running datasourceValidator self-tests...\n");

  // =======================================================================
  // Mock helpers
  // =======================================================================

  /** Build a mock QueryResult from rows. */
  function mockQR(rows: Record<string, unknown>[]): QueryResult {
    return {
      rows,
      command: "",
      rowCount: rows.length,
      oid: 0,
      fields: [],
    } as unknown as QueryResult;
  }

  /**
   * Build a mock deps object for a "happy path" scenario.
   *
   * @param opts.objectType  - Object type row (or null to simulate missing).
   * @param opts.datasource  - Backing datasource row (or null to simulate missing).
   * @param opts.properties  - Property rows for type checking.
   * @param opts.csvColumns  - CSV header columns.
   * @param opts.csvRows     - CSV data rows.
   * @param opts.schemaFail  - If true, getCSVSchema returns a failure.
   * @param opts.previewFail - If true, getCSVPreview returns a failure.
   * @param opts.convertOverride - Override convertValue behavior.
   */
  function createMockDeps(opts: {
    objectType?: { object_type_id: string } | null;
    datasource?: {
      file_path: string;
      column_mapping: Record<string, string>;
      primary_key_column: string;
    } | null;
    properties?: Array<{
      api_name: string;
      base_type: string;
      is_array: boolean;
      is_required: boolean;
    }>;
    csvColumns?: string[];
    csvRows?: CSVRow[];
    schemaFail?: boolean;
    previewFail?: boolean;
    convertOverride?: (
      rawValue: string | null | undefined,
      property: PropertyInput
    ) => ConvertResult;
  }): DatasourceValidatorDeps {
    const queryMap: Map<string, () => QueryResult> = new Map();

    // object_type query
    queryMap.set(
      "SELECT object_type_id FROM object_type",
      () => mockQR(opts.objectType ? [opts.objectType] : [])
    );

    // backing_datasource query
    queryMap.set(
      "SELECT file_path, column_mapping, primary_key_column FROM backing_datasource",
      () => mockQR(opts.datasource ? [opts.datasource] : [])
    );

    // property query
    queryMap.set(
      "SELECT api_name, base_type, is_array, is_required FROM property",
      () => mockQR(opts.properties ?? [])
    );

    return {
      dbQuery: async (text: string) => {
        for (const [prefix, fn] of queryMap.entries()) {
          if (text.startsWith(prefix)) return fn();
        }
        return mockQR([]);
      },
      getCSVSchema: async () => {
        if (opts.schemaFail) {
          return {
            success: false as const,
            error: {
              code: "FILE_NOT_FOUND" as const,
              message: "File not found: /data/missing.csv",
              filePath: "/data/missing.csv",
            },
          };
        }
        return {
          columns: opts.csvColumns ?? [],
          filePath: "/data/test.csv",
        };
      },
      getCSVPreview: async () => {
        if (opts.previewFail) {
          return {
            success: false as const,
            error: {
              code: "FILE_READ_ERROR" as const,
              message: "Cannot read file",
              filePath: "/data/test.csv",
            },
          };
        }
        return {
          success: true as const,
          filePath: "/data/test.csv",
          columns: opts.csvColumns ?? [],
          rowCount: (opts.csvRows ?? []).length,
          rows: opts.csvRows ?? [],
          parseWarnings: [],
          parseDurationMs: 1,
        };
      },
      convertValue: opts.convertOverride ?? (
        (_rawValue, _property) => ({ value: _rawValue, valid: true as const })
      ),
    };
  }

  // =======================================================================
  // Test 1: Happy path — all checks pass
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/employees.csv",
        column_mapping: { empId: "emp_id", name: "full_name", salary: "salary" },
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
        { api_name: "name", base_type: "string", is_array: false, is_required: false },
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["emp_id", "full_name", "salary"],
      csvRows: [
        { emp_id: "E001", full_name: "Alice", salary: "50000" },
        { emp_id: "E002", full_name: "Bob", salary: "60000" },
      ],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === true, "happy: valid is true");
    assert(result.checks.fileReadable.passed === true, "happy: fileReadable passed");
    assert(result.checks.allColumnsExist.passed === true, "happy: allColumnsExist passed");
    assert(result.checks.allColumnsExist.missingColumns.length === 0, "happy: no missing columns");
    assert(result.checks.primaryKeyExists.passed === true, "happy: primaryKeyExists passed");
    assert(result.checks.hasDataRows.passed === true, "happy: hasDataRows passed");
    assert(result.checks.hasDataRows.rowCount === 2, "happy: rowCount is 2");
    assert(result.checks.previewTypesValid.passed === true, "happy: previewTypesValid passed");
    assert(result.checks.previewTypesValid.conversionErrors.length === 0, "happy: no conversion errors");
  }

  // =======================================================================
  // Test 2: No object type found
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: null,
    });

    const result = await validateDatasource("NonExistent", { deps });

    assert(result.valid === false, "no ot: valid is false");
    assert(result.checks.fileReadable.passed === false, "no ot: fileReadable failed");
    assert(
      result.checks.fileReadable.error!.includes("No backing datasource registered"),
      `no ot: error message (got: '${result.checks.fileReadable.error}')`
    );
    assert(
      result.checks.fileReadable.error!.includes("NonExistent"),
      "no ot: error mentions apiName"
    );
  }

  // =======================================================================
  // Test 3: No backing datasource registered
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: null,
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "no ds: valid is false");
    assert(result.checks.fileReadable.passed === false, "no ds: fileReadable failed");
    assert(
      result.checks.fileReadable.error!.includes("No backing datasource registered"),
      "no ds: error message"
    );
  }

  // =======================================================================
  // Test 4: File not readable (getCSVSchema fails)
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/missing.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "emp_id",
      },
      schemaFail: true,
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "bad file: valid is false");
    assert(result.checks.fileReadable.passed === false, "bad file: fileReadable failed");
    assert(
      result.checks.fileReadable.error!.includes("File not found"),
      `bad file: error message (got: '${result.checks.fileReadable.error}')`
    );
    // All subsequent checks should be failed too
    assert(result.checks.allColumnsExist.passed === false, "bad file: allColumnsExist failed");
    assert(result.checks.primaryKeyExists.passed === false, "bad file: primaryKeyExists failed");
    assert(result.checks.hasDataRows.passed === false, "bad file: hasDataRows failed");
    assert(result.checks.previewTypesValid.passed === false, "bad file: previewTypesValid failed");
  }

  // =======================================================================
  // Test 5: Missing mapped columns
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id", dept: "department", salary: "salary" },
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
        { api_name: "dept", base_type: "string", is_array: false, is_required: false },
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["emp_id", "salary"],  // missing "department"
      csvRows: [{ emp_id: "E001", salary: "50000" }],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "missing col: valid is false");
    assert(result.checks.fileReadable.passed === true, "missing col: fileReadable passed");
    assert(result.checks.allColumnsExist.passed === false, "missing col: allColumnsExist failed");
    assert(
      result.checks.allColumnsExist.missingColumns.length === 1,
      `missing col: 1 missing (got ${result.checks.allColumnsExist.missingColumns.length})`
    );
    assert(
      result.checks.allColumnsExist.missingColumns[0] === "department",
      `missing col: missing is 'department' (got '${result.checks.allColumnsExist.missingColumns[0]}')`
    );
  }

  // =======================================================================
  // Test 6: Primary key column missing from CSV
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { name: "full_name" },
        primary_key_column: "emp_id",  // not in CSV
      },
      properties: [
        { api_name: "name", base_type: "string", is_array: false, is_required: false },
      ],
      csvColumns: ["full_name"],  // no emp_id
      csvRows: [{ full_name: "Alice" }],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "no pk: valid is false");
    assert(result.checks.primaryKeyExists.passed === false, "no pk: primaryKeyExists failed");
  }

  // =======================================================================
  // Test 7: No data rows (empty CSV with only headers)
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
      ],
      csvColumns: ["emp_id"],
      csvRows: [],  // no data rows
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "no rows: valid is false");
    assert(result.checks.hasDataRows.passed === false, "no rows: hasDataRows failed");
    assert(result.checks.hasDataRows.rowCount === 0, "no rows: rowCount is 0");
  }

  // =======================================================================
  // Test 8: Type conversion failures
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id", salary: "salary" },
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["emp_id", "salary"],
      csvRows: [
        { emp_id: "E001", salary: "abc" },
        { emp_id: "E002", salary: "50000" },
      ],
      convertOverride: (rawValue, property) => {
        if (property.base_type === "double" && rawValue === "abc") {
          return {
            value: null,
            valid: false as const,
            error: "Cannot convert 'abc' to double",
          };
        }
        return { value: rawValue, valid: true as const };
      },
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "type error: valid is false");
    assert(result.checks.previewTypesValid.passed === false, "type error: previewTypesValid failed");

    const errors = result.checks.previewTypesValid.conversionErrors;
    assert(errors.length === 1, `type error: 1 error (got ${errors.length})`);
    assert(errors[0].row === 1, "type error: row is 1");
    assert(errors[0].property === "salary", "type error: property is 'salary'");
    assert(errors[0].value === "abc", "type error: value is 'abc'");
    assert(
      errors[0].error === "Cannot convert 'abc' to double",
      `type error: error message (got: '${errors[0].error}')`
    );
  }

  // =======================================================================
  // Test 9: Multiple missing columns
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: {
          empId: "emp_id",
          dept: "department",
          salary: "salary",
          title: "job_title",
        },
        primary_key_column: "emp_id",
      },
      properties: [],
      csvColumns: ["emp_id"],  // missing department, salary, job_title
      csvRows: [{ emp_id: "E001" }],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(
      result.checks.allColumnsExist.missingColumns.length === 3,
      `multi missing: 3 missing (got ${result.checks.allColumnsExist.missingColumns.length})`
    );
    assert(
      result.checks.allColumnsExist.missingColumns.includes("department"),
      "multi missing: includes 'department'"
    );
    assert(
      result.checks.allColumnsExist.missingColumns.includes("salary"),
      "multi missing: includes 'salary'"
    );
    assert(
      result.checks.allColumnsExist.missingColumns.includes("job_title"),
      "multi missing: includes 'job_title'"
    );
  }

  // =======================================================================
  // Test 10: Multiple conversion errors across rows
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { age: "age", salary: "salary" },
        primary_key_column: "age",
      },
      properties: [
        { api_name: "age", base_type: "integer", is_array: false, is_required: false },
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["age", "salary"],
      csvRows: [
        { age: "not_a_number", salary: "bad" },
        { age: "25", salary: "60000" },
        { age: "xyz", salary: "70000" },
      ],
      convertOverride: (rawValue, property) => {
        if (property.base_type === "integer" && rawValue !== null && isNaN(Number(rawValue))) {
          return { value: null, valid: false as const, error: `Cannot convert '${rawValue}' to integer` };
        }
        if (property.base_type === "double" && rawValue !== null && isNaN(Number(rawValue))) {
          return { value: null, valid: false as const, error: `Cannot convert '${rawValue}' to double` };
        }
        return { value: rawValue, valid: true as const };
      },
    });

    const result = await validateDatasource("Employee", { deps });

    const errors = result.checks.previewTypesValid.conversionErrors;
    assert(errors.length === 3, `multi errors: 3 errors (got ${errors.length})`);

    // Row 1: age and salary both fail
    assert(errors[0].row === 1, "multi errors: first error row 1");
    assert(errors[0].property === "age", "multi errors: first error property 'age'");
    assert(errors[1].row === 1, "multi errors: second error row 1");
    assert(errors[1].property === "salary", "multi errors: second error property 'salary'");

    // Row 3: age fails
    assert(errors[2].row === 3, "multi errors: third error row 3");
    assert(errors[2].property === "age", "multi errors: third error property 'age'");
  }

  // =======================================================================
  // Test 11: Preview fail (getCSVPreview returns error)
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "emp_id",
      },
      csvColumns: ["emp_id"],
      previewFail: true,
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "preview fail: valid is false");
    // fileReadable should pass (schema read worked)
    assert(result.checks.fileReadable.passed === true, "preview fail: fileReadable passed");
    assert(result.checks.hasDataRows.passed === false, "preview fail: hasDataRows failed");
    assert(result.checks.hasDataRows.rowCount === 0, "preview fail: rowCount is 0");
    assert(result.checks.previewTypesValid.passed === false, "preview fail: previewTypesValid failed");
  }

  // =======================================================================
  // Test 12: column_mapping stored as JSON string (not object)
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: JSON.parse(JSON.stringify({ empId: "emp_id" })),
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
      ],
      csvColumns: ["emp_id"],
      csvRows: [{ emp_id: "E001" }],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === true, "json string mapping: valid is true");
  }

  // =======================================================================
  // Test 13: valid is true ONLY when ALL checks pass
  // =======================================================================
  {
    // All pass → true
    const depsAllPass = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
      ],
      csvColumns: ["emp_id"],
      csvRows: [{ emp_id: "E001" }],
    });
    const r1 = await validateDatasource("Employee", { deps: depsAllPass });
    assert(r1.valid === true, "all pass: valid is true");

    // Only primaryKey fails → false
    const depsNoPk = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "id",  // not in CSV
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
      ],
      csvColumns: ["emp_id"],
      csvRows: [{ emp_id: "E001" }],
    });
    const r2 = await validateDatasource("Employee", { deps: depsNoPk });
    assert(r2.valid === false, "pk fail only: valid is false");
    assert(r2.checks.fileReadable.passed === true, "pk fail only: fileReadable still passed");
    assert(r2.checks.allColumnsExist.passed === true, "pk fail only: allColumnsExist still passed");
    assert(r2.checks.primaryKeyExists.passed === false, "pk fail only: primaryKeyExists failed");
    assert(r2.checks.hasDataRows.passed === true, "pk fail only: hasDataRows still passed");
  }

  // =======================================================================
  // Test 14: Return shape — all fields present
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "emp_id",
      },
      properties: [],
      csvColumns: ["emp_id"],
      csvRows: [{ emp_id: "E001" }],
    });
    const result = await validateDatasource("Employee", { deps });

    assert("valid" in result, "shape: has 'valid'");
    assert("checks" in result, "shape: has 'checks'");
    assert("fileReadable" in result.checks, "shape: has 'fileReadable'");
    assert("allColumnsExist" in result.checks, "shape: has 'allColumnsExist'");
    assert("primaryKeyExists" in result.checks, "shape: has 'primaryKeyExists'");
    assert("hasDataRows" in result.checks, "shape: has 'hasDataRows'");
    assert("previewTypesValid" in result.checks, "shape: has 'previewTypesValid'");
    assert("passed" in result.checks.fileReadable, "shape: fileReadable has 'passed'");
    assert("missingColumns" in result.checks.allColumnsExist, "shape: allColumnsExist has 'missingColumns'");
    assert("passed" in result.checks.primaryKeyExists, "shape: primaryKeyExists has 'passed'");
    assert("rowCount" in result.checks.hasDataRows, "shape: hasDataRows has 'rowCount'");
    assert("conversionErrors" in result.checks.previewTypesValid, "shape: previewTypesValid has 'conversionErrors'");
  }

  // =======================================================================
  // Test 15: No-datasource report shape matches spec exactly
  // =======================================================================
  {
    const deps = createMockDeps({ objectType: null });
    const result = await validateDatasource("Orphan", { deps });

    assert(result.valid === false, "no ds shape: valid is false");
    assert(result.checks.fileReadable.passed === false, "no ds shape: fileReadable.passed false");
    assert(result.checks.allColumnsExist.passed === false, "no ds shape: allColumnsExist.passed false");
    assert(result.checks.allColumnsExist.missingColumns.length === 0, "no ds shape: missingColumns empty");
    assert(result.checks.primaryKeyExists.passed === false, "no ds shape: primaryKeyExists.passed false");
    assert(result.checks.hasDataRows.passed === false, "no ds shape: hasDataRows.passed false");
    assert(result.checks.hasDataRows.rowCount === 0, "no ds shape: rowCount 0");
    assert(result.checks.previewTypesValid.passed === false, "no ds shape: previewTypesValid.passed false");
    assert(result.checks.previewTypesValid.conversionErrors.length === 0, "no ds shape: conversionErrors empty");
  }

  // =======================================================================
  // Test 16: Conversion error shape — all fields present
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { salary: "salary" },
        primary_key_column: "salary",
      },
      properties: [
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["salary"],
      csvRows: [{ salary: "bad" }],
      convertOverride: (rawValue, property) => {
        if (property.base_type === "double") {
          return { value: null, valid: false as const, error: "bad number" };
        }
        return { value: rawValue, valid: true as const };
      },
    });

    const result = await validateDatasource("Employee", { deps });
    const err = result.checks.previewTypesValid.conversionErrors[0];

    assert("row" in err, "error shape: has 'row'");
    assert("property" in err, "error shape: has 'property'");
    assert("value" in err, "error shape: has 'value'");
    assert("error" in err, "error shape: has 'error'");
    assert(typeof err.row === "number", "error shape: row is number");
    assert(typeof err.property === "string", "error shape: property is string");
    assert(typeof err.value === "string", "error shape: value is string");
    assert(typeof err.error === "string", "error shape: error is string");
  }

  // =======================================================================
  // Test 17: Properties not in column_mapping are not type-checked
  // =======================================================================
  {
    let convertCalledFor: string[] = [];
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },  // only empId mapped
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
        { api_name: "unmapped", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["emp_id"],
      csvRows: [{ emp_id: "E001" }],
      convertOverride: (_rawValue, property) => {
        convertCalledFor.push(property.api_name);
        return { value: _rawValue, valid: true as const };
      },
    });

    await validateDatasource("Employee", { deps });

    assert(
      !convertCalledFor.includes("unmapped"),
      "unmapped: convertValue not called for unmapped property"
    );
    assert(
      convertCalledFor.includes("empId"),
      "unmapped: convertValue called for mapped property"
    );
  }

  // =======================================================================
  // Test 18: Null rawValue is passed to convertValue (for missing columns)
  // =======================================================================
  {
    let receivedValue: string | null | undefined = "initial";
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "emp_id" },
        primary_key_column: "emp_id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: false },
      ],
      csvColumns: ["emp_id"],
      csvRows: [{ emp_id: undefined as unknown as string }], // simulate missing value
      convertOverride: (rawValue, _property) => {
        receivedValue = rawValue;
        return { value: rawValue, valid: true as const };
      },
    });

    await validateDatasource("Employee", { deps });

    assert(
      receivedValue === null,
      `null value: received null (got: '${receivedValue}')`
    );
  }

  // =======================================================================
  // Test 19: DB query uses the correct objectTypeApiName parameter
  // =======================================================================
  {
    let capturedApiName = "";
    const deps: DatasourceValidatorDeps = {
      dbQuery: async (text, values) => {
        if (text.startsWith("SELECT object_type_id FROM object_type")) {
          capturedApiName = values?.[0] as string;
          return mockQR([]);
        }
        return mockQR([]);
      },
      getCSVSchema: async () => ({ columns: [], filePath: "" }),
      getCSVPreview: async () => ({
        success: true as const,
        filePath: "",
        columns: [],
        rowCount: 0,
        rows: [],
        parseWarnings: [],
        parseDurationMs: 0,
      }),
      convertValue: () => ({ value: null, valid: true as const }),
    };

    await validateDatasource("CustomsDeclaration", { deps });

    assert(
      capturedApiName === "CustomsDeclaration",
      `query param: apiName is 'CustomsDeclaration' (got: '${capturedApiName}')`
    );
  }

  // =======================================================================
  // Test 20: Spec test — valid CSV verifies all checks pass
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/valid.csv",
        column_mapping: { empId: "id", name: "name", salary: "salary" },
        primary_key_column: "id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
        { api_name: "name", base_type: "string", is_array: false, is_required: false },
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["id", "name", "salary"],
      csvRows: [
        { id: "1", name: "Alice", salary: "50000" },
        { id: "2", name: "Bob", salary: "60000" },
      ],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === true, "spec valid: all checks pass");
    assert(result.checks.fileReadable.passed === true, "spec valid: fileReadable");
    assert(result.checks.allColumnsExist.passed === true, "spec valid: allColumnsExist");
    assert(result.checks.primaryKeyExists.passed === true, "spec valid: primaryKeyExists");
    assert(result.checks.hasDataRows.passed === true, "spec valid: hasDataRows");
    assert(result.checks.previewTypesValid.passed === true, "spec valid: previewTypesValid");
  }

  // =======================================================================
  // Test 21: Spec test — missing mapped column fails allColumnsExist
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { empId: "id", dept: "department" },
        primary_key_column: "id",
      },
      properties: [
        { api_name: "empId", base_type: "string", is_array: false, is_required: true },
        { api_name: "dept", base_type: "string", is_array: false, is_required: false },
      ],
      csvColumns: ["id"],  // missing "department"
      csvRows: [{ id: "1" }],
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "spec missing: valid is false");
    assert(result.checks.allColumnsExist.passed === false, "spec missing: allColumnsExist failed");
    assert(
      result.checks.allColumnsExist.missingColumns[0] === "department",
      "spec missing: correct missing column name"
    );
  }

  // =======================================================================
  // Test 22: Spec test — type-incompatible values fail previewTypesValid
  // =======================================================================
  {
    const deps = createMockDeps({
      objectType: { object_type_id: "ot-1" },
      datasource: {
        file_path: "/data/test.csv",
        column_mapping: { salary: "salary" },
        primary_key_column: "salary",
      },
      properties: [
        { api_name: "salary", base_type: "double", is_array: false, is_required: false },
      ],
      csvColumns: ["salary"],
      csvRows: [{ salary: "not_a_number" }],
      convertOverride: (_rawValue, _property) => {
        return { value: null, valid: false as const, error: "Cannot convert 'not_a_number' to double" };
      },
    });

    const result = await validateDatasource("Employee", { deps });

    assert(result.valid === false, "spec type: valid is false");
    assert(result.checks.previewTypesValid.passed === false, "spec type: previewTypesValid failed");
    assert(
      result.checks.previewTypesValid.conversionErrors[0].error === "Cannot convert 'not_a_number' to double",
      "spec type: correct error message"
    );
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll datasourceValidator tests passed");
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
