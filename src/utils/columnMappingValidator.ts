// ---------------------------------------------------------------------------
// Column Mapping Validation Service
//
// Validates the column mapping used when registering a backing datasource.
// The column mapping tells the indexer how to translate file columns into
// object properties.
//
// This module is the single source of truth for column mapping validation —
// datasourceService.register delegates all mapping checks here.
// ---------------------------------------------------------------------------

import { coerceFromString } from "./typeSystem";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnMappingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface PropertyRow {
  api_name: string;
  base_type: string;
  is_required: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// validateColumnMapping
// ---------------------------------------------------------------------------

/**
 * Validate a column mapping against the object type's properties and file
 * columns. Returns `{valid, errors, warnings}`.
 *
 * @param columnMapping               Maps property apiNames to file column names.
 * @param properties                  Property DB rows for the object type.
 * @param fileColumns                 Column names from the file header.
 * @param primaryKeyPropertyApiName   The api_name of the primary key property.
 * @param sampleRows                  First 10 rows from the file as objects.
 */
export function validateColumnMapping(
  columnMapping: unknown,
  properties: PropertyRow[],
  fileColumns: string[],
  primaryKeyPropertyApiName: string | null,
  sampleRows: Record<string, unknown>[] = []
): ColumnMappingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- Rule 1: Must be a non-null object with at least one key ----------
  if (
    columnMapping === null ||
    columnMapping === undefined ||
    typeof columnMapping !== "object" ||
    Array.isArray(columnMapping) ||
    Object.keys(columnMapping as object).length === 0
  ) {
    errors.push("Column mapping must be a non-empty object.");
    return { valid: false, errors, warnings };
  }

  const mapping = columnMapping as Record<string, string>;

  // Build lookup structures
  const propertyApiNames = new Set(properties.map((p) => p.api_name));
  const propertyByApiName = new Map<string, PropertyRow>();
  for (const p of properties) {
    propertyByApiName.set(p.api_name, p);
  }
  const fileColumnSet = new Set(fileColumns);

  // ---- Rule 2: Every KEY must match an existing property ----------------
  const availableProps = properties.map((p) => p.api_name).join(", ");
  for (const key of Object.keys(mapping)) {
    if (!propertyApiNames.has(key)) {
      errors.push(
        `Property '${key}' in column mapping does not exist on this object type. Available properties: [${availableProps}].`
      );
    }
  }

  // ---- Rule 3: Every VALUE must match a file column ---------------------
  const availableCols = fileColumns.join(", ");
  for (const [key, value] of Object.entries(mapping)) {
    if (!fileColumnSet.has(value)) {
      errors.push(
        `Column '${value}' in mapping for property '${key}' does not exist in the file. Available columns: [${availableCols}].`
      );
    }
  }

  // ---- Rule 4: Primary key property must be included --------------------
  if (
    primaryKeyPropertyApiName &&
    !(primaryKeyPropertyApiName in mapping)
  ) {
    errors.push(
      `Primary key property '${primaryKeyPropertyApiName}' must be included in the column mapping.`
    );
  }

  // ---- Rule 5: Duplicate column values → warning ------------------------
  const columnToProps = new Map<string, string[]>();
  for (const [propName, colName] of Object.entries(mapping)) {
    if (!columnToProps.has(colName)) {
      columnToProps.set(colName, []);
    }
    columnToProps.get(colName)!.push(propName);
  }
  for (const [colName, props] of columnToProps) {
    if (props.length > 1) {
      // Generate pairwise warnings
      for (let i = 0; i < props.length - 1; i++) {
        for (let j = i + 1; j < props.length; j++) {
          warnings.push(
            `Warning: Properties '${props[i]}' and '${props[j]}' both map to column '${colName}'. Both properties will have the same value.`
          );
        }
      }
    }
  }

  // ---- Rule 6: Required properties must be in the mapping ---------------
  for (const prop of properties) {
    if (prop.is_required && !(prop.api_name in mapping)) {
      errors.push(
        `Required property '${prop.api_name}' is not included in the column mapping. All objects will have null values for this property, which will cause indexing to fail.`
      );
    }
  }

  // ---- Rule 7: Type compatibility check using sample data ---------------
  if (sampleRows.length > 0) {
    const rowsToCheck = sampleRows.slice(0, 10);

    for (const [propApiName, colName] of Object.entries(mapping)) {
      const prop = propertyByApiName.get(propApiName);
      if (!prop) continue; // Already flagged as unknown property in rule 2
      if (!fileColumnSet.has(colName)) continue; // Already flagged in rule 3

      let failureCount = 0;
      const MAX_FAILURES_PER_PROP = 3;

      for (let rowIdx = 0; rowIdx < rowsToCheck.length; rowIdx++) {
        if (failureCount >= MAX_FAILURES_PER_PROP) break;

        const row = rowsToCheck[rowIdx];
        const rawValue = row[colName];

        // Skip null/undefined/empty — those are fine (they become null)
        if (
          rawValue === null ||
          rawValue === undefined ||
          rawValue === ""
        ) {
          continue;
        }

        const strValue = String(rawValue);

        try {
          coerceFromString(prop.base_type, strValue);
        } catch {
          failureCount++;
          warnings.push(
            `Column '${colName}' mapped to property '${propApiName}' (type: ${prop.base_type}) contains value '${strValue}' in row ${rowIdx + 1} that cannot be coerced. These rows will fail during indexing.`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Inline self-tests (run directly: npx tsx src/utils/columnMappingValidator.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS: ${label}`);
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running column mapping validator self-tests...\n");

  // Test properties
  const props: PropertyRow[] = [
    { api_name: "empId", base_type: "string", is_required: true },
    { api_name: "fullName", base_type: "string", is_required: true },
    { api_name: "salary", base_type: "double", is_required: false },
    { api_name: "age", base_type: "integer", is_required: false },
    { api_name: "active", base_type: "boolean", is_required: false },
  ];
  const fileCols = ["emp_id", "full_name", "salary", "age", "is_active"];
  const pkProp = "empId";

  // === 1. Valid mapping ===
  console.log("=== 1. Valid mapping ===");
  const r1 = validateColumnMapping(
    { empId: "emp_id", fullName: "full_name", salary: "salary" },
    props,
    fileCols,
    pkProp,
    []
  );
  assert(r1.valid === true, "Valid mapping → valid");
  assert(r1.errors.length === 0, "No errors");
  assert(r1.warnings.length === 0, "No warnings");

  // === 2. Property not on object type ===
  console.log("\n=== 2. Unknown property ===");
  const r2 = validateColumnMapping(
    { empId: "emp_id", bogus: "full_name" },
    props,
    fileCols,
    pkProp,
    []
  );
  assert(r2.valid === false, "Unknown property → invalid");
  assert(
    r2.errors.some((e) =>
      e.includes("Property 'bogus'") && e.includes("does not exist")
    ),
    "Error mentions property name"
  );
  assert(
    r2.errors.some((e) => e.includes("Available properties:")),
    "Error lists available properties"
  );

  // === 3. Column not in file ===
  console.log("\n=== 3. Unknown column ===");
  const r3 = validateColumnMapping(
    { empId: "emp_id", fullName: "nonexistent_col" },
    props,
    fileCols,
    pkProp,
    []
  );
  assert(r3.valid === false, "Unknown column → invalid");
  assert(
    r3.errors.some((e) =>
      e.includes("Column 'nonexistent_col'") && e.includes("does not exist in the file")
    ),
    "Error mentions column name"
  );
  assert(
    r3.errors.some((e) => e.includes("Available columns:")),
    "Error lists available columns"
  );

  // === 4. Missing PK property ===
  console.log("\n=== 4. Missing PK ===");
  const r4 = validateColumnMapping(
    { fullName: "full_name" },
    props,
    fileCols,
    pkProp,
    []
  );
  assert(r4.valid === false, "Missing PK → invalid");
  assert(
    r4.errors.some((e) =>
      e.includes("Primary key property 'empId'") && e.includes("must be included")
    ),
    "Error mentions PK property name"
  );

  // === 5. Duplicate column values → warning ===
  console.log("\n=== 5. Duplicate column mapping ===");
  const r5 = validateColumnMapping(
    { empId: "emp_id", fullName: "emp_id", salary: "salary" },
    props,
    fileCols,
    pkProp,
    []
  );
  assert(r5.valid === true, "Duplicate column → still valid (warning only)");
  assert(r5.warnings.length > 0, "Has warnings");
  assert(
    r5.warnings.some((w) =>
      w.includes("both map to column 'emp_id'")
    ),
    "Warning mentions duplicate column"
  );

  // === 6. Required property not mapped ===
  console.log("\n=== 6. Required property not mapped ===");
  const r6 = validateColumnMapping(
    { empId: "emp_id" }, // fullName is required but not mapped
    props,
    fileCols,
    pkProp,
    []
  );
  assert(r6.valid === false, "Missing required → invalid");
  assert(
    r6.errors.some((e) =>
      e.includes("Required property 'fullName'") && e.includes("not included")
    ),
    "Error mentions required property"
  );

  // === 7. Type compatibility — non-numeric in double column ===
  console.log("\n=== 7. Type compatibility warning ===");
  const sampleRows = [
    { emp_id: "1", full_name: "Alice", salary: "50000", age: "30", is_active: "true" },
    { emp_id: "2", full_name: "Bob", salary: "not_a_number", age: "25", is_active: "false" },
    { emp_id: "3", full_name: "Carol", salary: "60000", age: "old", is_active: "yes" },
  ];
  const r7 = validateColumnMapping(
    { empId: "emp_id", fullName: "full_name", salary: "salary", age: "age" },
    props,
    fileCols,
    pkProp,
    sampleRows
  );
  assert(r7.valid === true, "Type issues → valid (warnings only)");
  assert(r7.warnings.length >= 2, `Has warnings (${r7.warnings.length})`);
  assert(
    r7.warnings.some((w) =>
      w.includes("'not_a_number'") && w.includes("row 2")
    ),
    "Warning for salary 'not_a_number' in row 2"
  );
  assert(
    r7.warnings.some((w) =>
      w.includes("'old'") && w.includes("row 3")
    ),
    "Warning for age 'old' in row 3"
  );

  // === 8. Empty mapping ===
  console.log("\n=== 8. Empty mapping ===");
  const r8 = validateColumnMapping({}, props, fileCols, pkProp, []);
  assert(r8.valid === false, "Empty mapping → invalid");
  assert(
    r8.errors.some((e) => e.includes("non-empty object")),
    "Error mentions non-empty"
  );

  // === 9. Null mapping ===
  console.log("\n=== 9. Null mapping ===");
  const r9 = validateColumnMapping(null, props, fileCols, pkProp, []);
  assert(r9.valid === false, "Null mapping → invalid");
  assert(
    r9.errors.some((e) => e.includes("non-empty object")),
    "Error mentions non-empty"
  );

  // === 10. No PK set (null) — PK check skipped ===
  console.log("\n=== 10. No PK set (null) ===");
  const r10 = validateColumnMapping(
    { fullName: "full_name" },
    props,
    fileCols,
    null, // no PK set
    []
  );
  // Should still fail due to required property 'empId' not mapped
  assert(
    !r10.errors.some((e) => e.includes("Primary key")),
    "No PK error when pkProp is null"
  );

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll column mapping validator tests passed");
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
