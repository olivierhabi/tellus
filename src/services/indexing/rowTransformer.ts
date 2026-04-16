// ---------------------------------------------------------------------------
// Row Transformer
//
// Transforms a single CSV row into an OpenSearch document ready for indexing.
// This is the bridge between raw CSV data (string values with CSV column
// names) and the indexed Ontology object (typed values with property API
// names plus system fields).
//
// In Palantir's Funnel architecture, this is the step where a datasource
// row becomes an Ontology object — the column-to-property mapping is
// applied, type conversion runs, and system metadata is added.
// ---------------------------------------------------------------------------

import { convertValue, ConvertFailure } from "./typeConverter";
import type { PropertyInput } from "../mapping/typeMapper";
import type { CSVRow } from "./csvReader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Column mapping from the `backing_datasource.column_mapping` JSONB column.
 * Keys are property API names, values are CSV column names.
 *   e.g. { employeeId: "emp_id", fullName: "full_name" }
 */
export type PropertyColumnMapping = Record<string, string>;

/** Object type record — the subset of fields we need from PostgreSQL. */
export interface ObjectTypeRecord {
  api_name: string;
  primary_key_property_id: string;
}

/** Property record from PostgreSQL — extends PropertyInput with property_id. */
export interface PropertyRecord extends PropertyInput {
  property_id: string;
}

/** Options for transformRow(). */
export interface TransformOptions {
  /** Transaction/version identifier for this indexing run. */
  datasourceVersion?: string | null;
  /** If true (default), reject row on any conversion error. If false, null failed fields. */
  strict?: boolean;
}

/** Successful transformation result. */
export interface TransformSuccess {
  valid: true;
  document: Record<string, unknown>;
  lineNumber: number;
  warnings: string[];
}

/** Failed transformation result. */
export interface TransformFailure {
  valid: false;
  document: null;
  lineNumber: number;
  errors: string[];
  warnings: string[];
}

export type TransformResult = TransformSuccess | TransformFailure;

// ---------------------------------------------------------------------------
// transformRow()
// ---------------------------------------------------------------------------

/**
 * Transform a single CSV row into an OpenSearch document ready for indexing.
 *
 * Applies the column-to-property mapping, runs type conversion on every
 * field, adds system fields (__pk, __objectType, __lastModified, __version,
 * __editedBy, __datasourceVersion), and returns the complete document.
 *
 * @param row           - A single row from the CSV reader.
 * @param lineNumber    - 1-indexed line number (for error reporting).
 * @param objectType    - The object type record from PostgreSQL.
 * @param properties    - All property records for this object type.
 * @param columnMapping - Map of property API name → CSV column name.
 * @param options       - Optional configuration.
 * @returns A TransformResult with the document or errors.
 */
export function transformRow(
  row: CSVRow,
  lineNumber: number,
  objectType: ObjectTypeRecord,
  properties: PropertyRecord[],
  columnMapping: PropertyColumnMapping,
  options?: TransformOptions
): TransformResult {
  const strict = options?.strict !== false; // default true
  const datasourceVersion = options?.datasourceVersion ?? null;
  const errors: string[] = [];
  const warnings: string[] = [];

  // -----------------------------------------------------------------------
  // 1. Initialize the document with system fields
  // -----------------------------------------------------------------------
  const doc: Record<string, unknown> = {
    __objectType: objectType.api_name,
    __lastModified: new Date().toISOString(),
    __version: 1,
    __editedBy: null,
    __datasourceVersion: datasourceVersion,
  };

  // -----------------------------------------------------------------------
  // 2. Determine and set the primary key
  // -----------------------------------------------------------------------
  const pkProperty = properties.find(
    (p) => p.property_id === objectType.primary_key_property_id
  );

  if (!pkProperty) {
    return {
      valid: false,
      document: null,
      lineNumber,
      errors: [
        `Row ${lineNumber}: Cannot determine primary key — no property matches primary_key_property_id '${objectType.primary_key_property_id}'`,
      ],
      warnings,
    };
  }

  const pkColumnName = columnMapping[pkProperty.api_name];
  const pkRawValue = pkColumnName !== undefined ? (row[pkColumnName] ?? null) : null;

  if (pkRawValue === null || pkRawValue.trim() === "") {
    return {
      valid: false,
      document: null,
      lineNumber,
      errors: [
        `Row ${lineNumber}: Primary key property '${pkProperty.api_name}' has null/empty value`,
      ],
      warnings,
    };
  }

  // Convert the PK value through the type converter (for validation), but
  // always store __pk as a string for exact-match lookups in OpenSearch.
  const pkConvertResult = convertValue(pkRawValue, pkProperty);

  if (!pkConvertResult.valid) {
    return {
      valid: false,
      document: null,
      lineNumber,
      errors: [
        `Row ${lineNumber}: Primary key property '${pkProperty.api_name}': ${(pkConvertResult as ConvertFailure).error}`,
      ],
      warnings,
    };
  }

  doc.__pk = String(pkConvertResult.value);

  // -----------------------------------------------------------------------
  // 3. Iterate over all properties and convert values
  // -----------------------------------------------------------------------
  for (const property of properties) {
    const csvColumnName = columnMapping[property.api_name];

    // Property has no mapping — set to null
    if (csvColumnName === undefined) {
      doc[property.api_name] = null;
      continue;
    }

    const rawValue = row[csvColumnName] ?? null;
    const result = convertValue(rawValue, property);

    if (result.valid) {
      doc[property.api_name] = result.value;
    } else {
      const errorMsg = `Property '${property.api_name}': ${(result as ConvertFailure).error}`;

      if (strict) {
        errors.push(errorMsg);
      } else {
        // Non-strict mode: null the field and add a warning
        doc[property.api_name] = null;
        warnings.push(errorMsg);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. Return result
  // -----------------------------------------------------------------------
  if (errors.length > 0) {
    return {
      valid: false,
      document: null,
      lineNumber,
      errors,
      warnings,
    };
  }

  return {
    valid: true,
    document: doc,
    lineNumber,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { transformRow };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/rowTransformer.ts)
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

  console.log("Running rowTransformer self-tests...\n");

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
      api_name: "startDate",
      base_type: "date",
      is_array: false,
      is_required: false,
    },
    {
      property_id: "uuid-5",
      api_name: "isActive",
      base_type: "boolean",
      is_array: false,
      is_required: false,
    },
    {
      property_id: "uuid-6",
      api_name: "skills",
      base_type: "string_array",
      is_array: true,
      is_required: false,
    },
    {
      property_id: "uuid-7",
      api_name: "location",
      base_type: "geopoint",
      is_array: false,
      is_required: false,
    },
  ];

  const columnMapping: PropertyColumnMapping = {
    employeeId: "emp_id",
    fullName: "full_name",
    salary: "salary",
    startDate: "start_date",
    isActive: "is_active",
    skills: "skills",
    location: "location",
  };

  // =====================================================================
  // Test 1: Fully valid row with all property types
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-001",
      full_name: "Melissa Chang",
      salary: "145000",
      start_date: "2020-03-15",
      is_active: "true",
      skills: "python,java,sql",
      location: "-1.9403,29.8739",
    };

    const result = transformRow(row, 1, objectType, properties, columnMapping, {
      datasourceVersion: "txn-001",
    });

    assert(result.valid === true, "valid row: valid is true");
    if (result.valid) {
      const doc = result.document;
      assert(doc.__pk === "EMP-001", "valid row: __pk");
      assert(doc.__objectType === "Employee", "valid row: __objectType");
      assert(typeof doc.__lastModified === "string", "valid row: __lastModified is string");
      assert(doc.__version === 1, "valid row: __version");
      assert(doc.__editedBy === null, "valid row: __editedBy");
      assert(doc.__datasourceVersion === "txn-001", "valid row: __datasourceVersion");
      assert(doc.employeeId === "EMP-001", "valid row: employeeId");
      assert(doc.fullName === "Melissa Chang", "valid row: fullName");
      assert(doc.salary === 145000, "valid row: salary (double)");
      assert(doc.startDate === "2020-03-15", "valid row: startDate (date)");
      assert(doc.isActive === true, "valid row: isActive (boolean)");

      const skills = doc.skills as string[];
      assert(
        Array.isArray(skills) && skills.length === 3,
        "valid row: skills is array of 3"
      );
      assert(
        skills[0] === "python" && skills[1] === "java" && skills[2] === "sql",
        "valid row: skills values"
      );

      const loc = doc.location as { lat: number; lon: number };
      assert(
        loc.lat === -1.9403 && loc.lon === 29.8739,
        "valid row: location geopoint"
      );
    }
    assert(result.lineNumber === 1, "valid row: lineNumber");
    assert(
      result.valid && result.warnings.length === 0,
      "valid row: no warnings"
    );
  }

  // =====================================================================
  // Test 2: Conversion errors in strict mode
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-002",
      full_name: "John Doe",
      salary: "not-a-number",
      start_date: "sometime-in-march",
      is_active: "true",
      skills: "java",
      location: "-1.94,29.87",
    };

    const result = transformRow(row, 45, objectType, properties, columnMapping, {
      strict: true,
    });

    assert(result.valid === false, "strict errors: valid is false");
    assert(!result.valid && result.document === null, "strict errors: document is null");
    assert(!result.valid && result.errors.length === 2, `strict errors: 2 errors (got ${!result.valid ? result.errors.length : 0})`);
    assert(result.lineNumber === 45, "strict errors: lineNumber");

    if (!result.valid) {
      assert(
        result.errors.some((e) => e.includes("salary")),
        "strict errors: salary error present"
      );
      assert(
        result.errors.some((e) => e.includes("startDate")),
        "strict errors: startDate error present"
      );
    }
  }

  // =====================================================================
  // Test 3: Conversion errors in non-strict mode
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-003",
      full_name: "Jane Smith",
      salary: "not-a-number",
      start_date: "sometime-in-march",
      is_active: "true",
      skills: "python",
      location: "-1.94,29.87",
    };

    const result = transformRow(row, 12, objectType, properties, columnMapping, {
      strict: false,
    });

    assert(result.valid === true, "non-strict: valid is true (errors become warnings)");
    if (result.valid) {
      assert(result.document.salary === null, "non-strict: salary is null");
      assert(result.document.startDate === null, "non-strict: startDate is null");
      assert(result.warnings.length === 2, `non-strict: 2 warnings (got ${result.warnings.length})`);
      assert(result.document.fullName === "Jane Smith", "non-strict: valid fields still converted");
      assert(result.document.isActive === true, "non-strict: isActive still true");
    }
  }

  // =====================================================================
  // Test 4: Null primary key → immediate failure
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "",
      full_name: "No PK",
      salary: "100",
      start_date: "2025-01-01",
      is_active: "true",
      skills: "none",
      location: "0,0",
    };

    const result = transformRow(row, 99, objectType, properties, columnMapping);

    assert(result.valid === false, "null PK: valid is false");
    assert(!result.valid && result.errors.length === 1, "null PK: 1 error");
    assert(
      !result.valid && result.errors[0].includes("null/empty"),
      "null PK: error mentions null/empty"
    );
  }

  // =====================================================================
  // Test 5: Unmapped property → set to null
  // =====================================================================
  {
    // Column mapping that doesn't include skills or location
    const partialMapping: PropertyColumnMapping = {
      employeeId: "emp_id",
      fullName: "full_name",
      salary: "salary",
      startDate: "start_date",
      isActive: "is_active",
      // skills and location NOT mapped
    };

    const row: CSVRow = {
      emp_id: "EMP-004",
      full_name: "Partial Map",
      salary: "50000",
      start_date: "2024-01-01",
      is_active: "false",
    };

    const result = transformRow(row, 1, objectType, properties, partialMapping);

    assert(result.valid === true, "unmapped: valid is true");
    if (result.valid) {
      assert(result.document.skills === null, "unmapped: skills is null");
      assert(result.document.location === null, "unmapped: location is null");
      assert(result.document.salary === 50000, "unmapped: salary still converted");
    }
  }

  // =====================================================================
  // Test 6: PK property not found (bad primary_key_property_id)
  // =====================================================================
  {
    const badObjectType: ObjectTypeRecord = {
      api_name: "Employee",
      primary_key_property_id: "nonexistent-uuid",
    };

    const row: CSVRow = {
      emp_id: "EMP-005",
      full_name: "Bad PK ID",
    };

    const result = transformRow(row, 1, badObjectType, properties, columnMapping);

    assert(result.valid === false, "bad PK id: valid is false");
    assert(
      !result.valid && result.errors[0].includes("Cannot determine primary key"),
      "bad PK id: error message"
    );
  }

  // =====================================================================
  // Test 7: Integer primary key → __pk is still a string
  // =====================================================================
  {
    const intPkProperties: PropertyRecord[] = [
      {
        property_id: "int-pk-uuid",
        api_name: "numericId",
        base_type: "integer",
        is_array: false,
        is_required: true,
      },
      {
        property_id: "uuid-name",
        api_name: "label",
        base_type: "string",
        is_array: false,
        is_required: false,
      },
    ];

    const intOT: ObjectTypeRecord = {
      api_name: "NumberedItem",
      primary_key_property_id: "int-pk-uuid",
    };

    const intMapping: PropertyColumnMapping = {
      numericId: "id",
      label: "label",
    };

    const row: CSVRow = { id: "42", label: "Test" };
    const result = transformRow(row, 1, intOT, intPkProperties, intMapping);

    assert(result.valid === true, "int PK: valid");
    if (result.valid) {
      assert(result.document.__pk === "42", "int PK: __pk is string '42'");
      assert(typeof result.document.__pk === "string", "int PK: __pk type is string");
      assert(result.document.numericId === 42, "int PK: numericId is number 42");
    }
  }

  // =====================================================================
  // Test 8: Default options (no options object)
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-006",
      full_name: "Default Opts",
      salary: "80000",
      start_date: "2023-06-15",
      is_active: "no",
      skills: "go",
      location: "0,0",
    };

    const result = transformRow(row, 1, objectType, properties, columnMapping);

    assert(result.valid === true, "defaults: valid");
    if (result.valid) {
      assert(result.document.__datasourceVersion === null, "defaults: datasourceVersion is null");
      assert(result.document.isActive === false, "defaults: isActive is false");
    }
  }

  // =====================================================================
  // Test 9: Extra CSV columns are ignored
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-007",
      full_name: "Extra Cols",
      salary: "90000",
      start_date: "2022-01-01",
      is_active: "true",
      skills: "rust",
      location: "1.0,2.0",
      extra_col_1: "ignored",
      extra_col_2: "also ignored",
    };

    const result = transformRow(row, 1, objectType, properties, columnMapping);

    assert(result.valid === true, "extra cols: valid");
    if (result.valid) {
      assert(!("extra_col_1" in result.document), "extra cols: extra_col_1 not in document");
      assert(!("extra_col_2" in result.document), "extra cols: extra_col_2 not in document");
    }
  }

  // =====================================================================
  // Test 10: Required field missing in strict mode
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-008",
      full_name: "",   // required field is empty
      salary: "100000",
      start_date: "2025-01-01",
      is_active: "true",
      skills: "java",
      location: "0,0",
    };

    const result = transformRow(row, 10, objectType, properties, columnMapping, {
      strict: true,
    });

    assert(result.valid === false, "required empty: valid is false");
    assert(
      !result.valid && result.errors.some((e) => e.includes("fullName") && e.includes("Required")),
      "required empty: error mentions fullName and Required"
    );
  }

  // =====================================================================
  // Test 11: Required field missing in non-strict mode
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-009",
      full_name: "",   // required field is empty
      salary: "100000",
      start_date: "2025-01-01",
      is_active: "true",
      skills: "java",
      location: "0,0",
    };

    const result = transformRow(row, 10, objectType, properties, columnMapping, {
      strict: false,
    });

    assert(result.valid === true, "required non-strict: valid is true");
    if (result.valid) {
      assert(result.document.fullName === null, "required non-strict: fullName is null");
      assert(result.warnings.length === 1, "required non-strict: 1 warning");
    }
  }

  // =====================================================================
  // Test 12: System fields present in output
  // =====================================================================
  {
    const row: CSVRow = {
      emp_id: "EMP-010",
      full_name: "System Fields",
      salary: "50000",
      start_date: "2025-01-01",
      is_active: "true",
      skills: "test",
      location: "0,0",
    };

    const result = transformRow(row, 1, objectType, properties, columnMapping);

    assert(result.valid === true, "system fields: valid");
    if (result.valid) {
      const doc = result.document;
      const systemFieldNames = [
        "__pk",
        "__objectType",
        "__lastModified",
        "__version",
        "__editedBy",
        "__datasourceVersion",
      ];
      for (const field of systemFieldNames) {
        assert(field in doc, `system fields: '${field}' present in document`);
      }
    }
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll rowTransformer tests passed");
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
