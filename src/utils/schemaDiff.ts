// ---------------------------------------------------------------------------
// Schema Diff Utility
//
// Computes differences between two versions of an object type's property
// schema, and between two versions of a backing datasource's column list.
// Used for detecting schema changes, generating migration plans, and
// warning about breaking changes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropertyDef {
  apiName: string;
  baseType: string;
  displayName: string;
  isRequired: boolean;
  isArray: boolean;
  ordinal: number;
  description: string | null;
  structSchema: unknown[] | null;
}

interface PropertyChange {
  before: unknown;
  after: unknown;
}

interface ModifiedProperty {
  apiName: string;
  changes: Record<string, PropertyChange>;
}

interface AddedProperty {
  apiName: string;
  baseType: string;
}

interface RemovedProperty {
  apiName: string;
  baseType: string;
}

export interface SchemaDiffResult {
  propertiesAdded: AddedProperty[];
  propertiesRemoved: RemovedProperty[];
  propertiesModified: ModifiedProperty[];
  propertiesUnchanged: string[];
  isBreakingChange: boolean;
  breakingReasons: string[];
  summary: string;
}

export interface ColumnDiffResult {
  columnsAdded: string[];
  columnsRemoved: string[];
  columnsUnchanged: string[];
  hasChanges: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Comparable property fields (checked for modifications)
// ---------------------------------------------------------------------------

const COMPARABLE_FIELDS: (keyof PropertyDef)[] = [
  "baseType",
  "displayName",
  "isRequired",
  "isArray",
  "ordinal",
  "description",
  "structSchema",
];

// ---------------------------------------------------------------------------
// Function 1: computeSchemaDiff
// ---------------------------------------------------------------------------

/**
 * Compute the difference between two versions of an object type's property
 * schema. Properties are matched by apiName (stable identifier).
 */
export function computeSchemaDiff(
  before: PropertyDef[],
  after: PropertyDef[]
): SchemaDiffResult {
  const beforeMap = new Map<string, PropertyDef>();
  for (const p of before) {
    beforeMap.set(p.apiName, p);
  }

  const afterMap = new Map<string, PropertyDef>();
  for (const p of after) {
    afterMap.set(p.apiName, p);
  }

  const propertiesAdded: AddedProperty[] = [];
  const propertiesRemoved: RemovedProperty[] = [];
  const propertiesModified: ModifiedProperty[] = [];
  const propertiesUnchanged: string[] = [];
  const breakingReasons: string[] = [];

  // Detect removals: in before but not in after
  for (const [apiName, bProp] of beforeMap) {
    if (!afterMap.has(apiName)) {
      propertiesRemoved.push({ apiName, baseType: bProp.baseType });
      breakingReasons.push(
        `Property '${apiName}' was removed. Objects may have data for this property that will be lost.`
      );
    }
  }

  // Detect additions: in after but not in before
  for (const [apiName, aProp] of afterMap) {
    if (!beforeMap.has(apiName)) {
      propertiesAdded.push({ apiName, baseType: aProp.baseType });
    }
  }

  // Detect modifications and unchanged: in both
  for (const [apiName, bProp] of beforeMap) {
    const aProp = afterMap.get(apiName);
    if (!aProp) continue; // already handled as removal

    const changes: Record<string, PropertyChange> = {};

    for (const field of COMPARABLE_FIELDS) {
      const bVal = bProp[field];
      const aVal = aProp[field];

      // Deep compare for structSchema (array/object)
      if (field === "structSchema") {
        const bStr = JSON.stringify(bVal ?? null);
        const aStr = JSON.stringify(aVal ?? null);
        if (bStr !== aStr) {
          changes[field] = { before: bVal, after: aVal };
        }
      } else if (bVal !== aVal) {
        changes[field] = { before: bVal, after: aVal };
      }
    }

    if (Object.keys(changes).length === 0) {
      propertiesUnchanged.push(apiName);
    } else {
      propertiesModified.push({ apiName, changes });

      // Check for breaking changes in modifications
      if (changes.baseType) {
        breakingReasons.push(
          `Property '${apiName}' baseType changed from '${changes.baseType.before}' to '${changes.baseType.after}'. This requires reindexing.`
        );
      }
      if (changes.isRequired) {
        if (changes.isRequired.before === false && changes.isRequired.after === true) {
          breakingReasons.push(
            `Property '${apiName}' isRequired changed from false to true. Existing null values would fail indexing.`
          );
        }
      }
    }
  }

  const isBreakingChange = breakingReasons.length > 0;

  const summary =
    `${propertiesAdded.length} added, ` +
    `${propertiesRemoved.length} removed, ` +
    `${propertiesModified.length} modified, ` +
    `${propertiesUnchanged.length} unchanged.` +
    (isBreakingChange ? " BREAKING CHANGE." : " No breaking changes.");

  return {
    propertiesAdded,
    propertiesRemoved,
    propertiesModified,
    propertiesUnchanged,
    isBreakingChange,
    breakingReasons,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Function 2: computeColumnDiff
// ---------------------------------------------------------------------------

/**
 * Compute the difference between two versions of a backing datasource's
 * column list. Columns are matched by exact name (string equality).
 * Does NOT attempt rename detection.
 */
export function computeColumnDiff(
  previousColumns: string[],
  currentColumns: string[]
): ColumnDiffResult {
  const prevSet = new Set(previousColumns);
  const currSet = new Set(currentColumns);

  const columnsAdded: string[] = [];
  const columnsRemoved: string[] = [];
  const columnsUnchanged: string[] = [];

  // Added: in current but not in previous
  for (const col of currentColumns) {
    if (!prevSet.has(col)) {
      columnsAdded.push(col);
    }
  }

  // Removed: in previous but not in current
  for (const col of previousColumns) {
    if (!currSet.has(col)) {
      columnsRemoved.push(col);
    }
  }

  // Unchanged: in both
  for (const col of previousColumns) {
    if (currSet.has(col)) {
      columnsUnchanged.push(col);
    }
  }

  const hasChanges = columnsAdded.length > 0 || columnsRemoved.length > 0;

  const summary =
    `${columnsAdded.length} added, ` +
    `${columnsRemoved.length} removed, ` +
    `${columnsUnchanged.length} unchanged.`;

  return {
    columnsAdded,
    columnsRemoved,
    columnsUnchanged,
    hasChanges,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Inline self-tests (run directly: npx tsx src/utils/schemaDiff.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS: ${label}`);
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  // Helper to create a minimal PropertyDef
  function prop(
    apiName: string,
    baseType: string = "string",
    overrides: Partial<PropertyDef> = {}
  ): PropertyDef {
    return {
      apiName,
      baseType,
      displayName: apiName,
      isRequired: false,
      isArray: false,
      ordinal: 0,
      description: null,
      structSchema: null,
      ...overrides,
    };
  }

  console.log("Running schema diff self-tests...\n");

  // =========================================================================
  // computeSchemaDiff tests
  // =========================================================================

  // === 1. Property added → not breaking ===
  console.log("=== 1. Property added ===");
  {
    const before = [prop("employeeId"), prop("fullName")];
    const after = [prop("employeeId"), prop("fullName"), prop("middleName")];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesAdded.length === 1, "1 property added");
    assert(diff.propertiesAdded[0].apiName === "middleName", "added middleName");
    assert(diff.propertiesRemoved.length === 0, "0 removed");
    assert(diff.propertiesModified.length === 0, "0 modified");
    assert(diff.propertiesUnchanged.length === 2, "2 unchanged");
    assert(diff.isBreakingChange === false, "not breaking");
    assert(diff.breakingReasons.length === 0, "no breaking reasons");
    assert(diff.summary.includes("1 added"), "summary has '1 added'");
    assert(diff.summary.includes("No breaking changes"), "summary says no breaking");
  }

  // === 2. Property removed → breaking ===
  console.log("\n=== 2. Property removed ===");
  {
    const before = [prop("employeeId"), prop("fullName"), prop("legacyCode")];
    const after = [prop("employeeId"), prop("fullName")];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesRemoved.length === 1, "1 property removed");
    assert(diff.propertiesRemoved[0].apiName === "legacyCode", "removed legacyCode");
    assert(diff.isBreakingChange === true, "is breaking");
    assert(
      diff.breakingReasons.some((r) => r.includes("was removed")),
      "reason includes 'was removed'"
    );
  }

  // === 3. baseType changed → breaking ===
  console.log("\n=== 3. baseType changed ===");
  {
    const before = [prop("employeeId"), prop("salary", "integer")];
    const after = [prop("employeeId"), prop("salary", "double")];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(diff.propertiesModified[0].apiName === "salary", "modified salary");
    assert(
      diff.propertiesModified[0].changes.baseType !== undefined,
      "baseType changed"
    );
    assert(
      diff.propertiesModified[0].changes.baseType.before === "integer",
      "before = integer"
    );
    assert(
      diff.propertiesModified[0].changes.baseType.after === "double",
      "after = double"
    );
    assert(diff.isBreakingChange === true, "is breaking");
    assert(
      diff.breakingReasons.some((r) => r.includes("baseType changed")),
      "reason includes 'baseType changed'"
    );
    assert(
      diff.breakingReasons.some((r) => r.includes("requires reindexing")),
      "reason includes 'requires reindexing'"
    );
  }

  // === 4. isRequired false→true → breaking ===
  console.log("\n=== 4. isRequired false→true ===");
  {
    const before = [prop("salary", "double", { isRequired: false })];
    const after = [prop("salary", "double", { isRequired: true })];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(diff.isBreakingChange === true, "is breaking");
    assert(
      diff.breakingReasons.some((r) =>
        r.includes("isRequired changed from false to true")
      ),
      "reason includes isRequired change"
    );
  }

  // === 5. isRequired true→false → not breaking ===
  console.log("\n=== 5. isRequired true→false ===");
  {
    const before = [prop("salary", "double", { isRequired: true })];
    const after = [prop("salary", "double", { isRequired: false })];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(diff.isBreakingChange === false, "not breaking");
    assert(diff.breakingReasons.length === 0, "no breaking reasons");
  }

  // === 6. displayName change only → not breaking ===
  console.log("\n=== 6. displayName change only ===");
  {
    const before = [prop("salary", "double", { displayName: "Salary" })];
    const after = [prop("salary", "double", { displayName: "Annual Salary" })];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(
      diff.propertiesModified[0].changes.displayName !== undefined,
      "displayName changed"
    );
    assert(diff.isBreakingChange === false, "not breaking");
  }

  // === 7. description change only → not breaking ===
  console.log("\n=== 7. description change only ===");
  {
    const before = [prop("salary", "double", { description: null })];
    const after = [
      prop("salary", "double", { description: "Annual salary in USD" }),
    ];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(diff.isBreakingChange === false, "not breaking");
  }

  // === 8. ordinal change only → not breaking ===
  console.log("\n=== 8. ordinal change only ===");
  {
    const before = [prop("salary", "double", { ordinal: 0 })];
    const after = [prop("salary", "double", { ordinal: 5 })];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(diff.isBreakingChange === false, "not breaking");
  }

  // === 9. No changes → empty diff ===
  console.log("\n=== 9. No changes ===");
  {
    const schema = [prop("employeeId"), prop("fullName"), prop("salary", "double")];
    const diff = computeSchemaDiff(schema, schema);

    assert(diff.propertiesAdded.length === 0, "0 added");
    assert(diff.propertiesRemoved.length === 0, "0 removed");
    assert(diff.propertiesModified.length === 0, "0 modified");
    assert(diff.propertiesUnchanged.length === 3, "3 unchanged");
    assert(diff.isBreakingChange === false, "not breaking");
    assert(diff.summary.includes("No breaking changes"), "summary ok");
  }

  // === 10. Multiple changes at once ===
  console.log("\n=== 10. Multiple changes ===");
  {
    const before = [
      prop("employeeId"),
      prop("fullName"),
      prop("legacyCode"),
      prop("salary", "integer"),
    ];
    const after = [
      prop("employeeId"),
      prop("fullName"),
      prop("middleName"),
      prop("salary", "double"),
    ];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesAdded.length === 1, "1 added (middleName)");
    assert(diff.propertiesRemoved.length === 1, "1 removed (legacyCode)");
    assert(diff.propertiesModified.length === 1, "1 modified (salary)");
    assert(diff.propertiesUnchanged.length === 2, "2 unchanged");
    assert(diff.isBreakingChange === true, "is breaking");
    assert(diff.breakingReasons.length === 2, "2 breaking reasons");
    assert(
      diff.summary === "1 added, 1 removed, 1 modified, 2 unchanged. BREAKING CHANGE.",
      `summary = "${diff.summary}"`
    );
  }

  // === 11. Empty before / after ===
  console.log("\n=== 11. Empty schemas ===");
  {
    const diff1 = computeSchemaDiff([], [prop("newProp")]);
    assert(diff1.propertiesAdded.length === 1, "added 1 to empty schema");
    assert(diff1.isBreakingChange === false, "not breaking (addition only)");

    const diff2 = computeSchemaDiff([prop("oldProp")], []);
    assert(diff2.propertiesRemoved.length === 1, "removed 1 to empty schema");
    assert(diff2.isBreakingChange === true, "breaking (removal)");

    const diff3 = computeSchemaDiff([], []);
    assert(diff3.propertiesUnchanged.length === 0, "both empty → 0 unchanged");
    assert(diff3.isBreakingChange === false, "both empty → not breaking");
  }

  // === 12. structSchema change ===
  console.log("\n=== 12. structSchema change ===");
  {
    const before = [
      prop("meta", "struct", {
        structSchema: [{ fieldName: "key", fieldType: "string" }],
      }),
    ];
    const after = [
      prop("meta", "struct", {
        structSchema: [
          { fieldName: "key", fieldType: "string" },
          { fieldName: "value", fieldType: "string" },
        ],
      }),
    ];
    const diff = computeSchemaDiff(before, after);

    assert(diff.propertiesModified.length === 1, "1 modified");
    assert(
      diff.propertiesModified[0].changes.structSchema !== undefined,
      "structSchema changed"
    );
    assert(diff.isBreakingChange === false, "structSchema change alone is not breaking");
  }

  // =========================================================================
  // computeColumnDiff tests
  // =========================================================================

  console.log("\n=== 13. Column additions and removals ===");
  {
    const prev = ["emp_id", "name", "salary"];
    const curr = ["emp_id", "name", "salary", "department", "start_date"];
    const diff = computeColumnDiff(prev, curr);

    assert(diff.columnsAdded.length === 2, "2 columns added");
    assert(
      diff.columnsAdded.includes("department") &&
        diff.columnsAdded.includes("start_date"),
      "added department and start_date"
    );
    assert(diff.columnsRemoved.length === 0, "0 removed");
    assert(diff.columnsUnchanged.length === 3, "3 unchanged");
    assert(diff.hasChanges === true, "has changes");
    assert(
      diff.summary === "2 added, 0 removed, 3 unchanged.",
      `summary = "${diff.summary}"`
    );
  }

  console.log("\n=== 14. Column removals ===");
  {
    const prev = ["emp_id", "name", "salary", "legacy_code"];
    const curr = ["emp_id", "name", "salary"];
    const diff = computeColumnDiff(prev, curr);

    assert(diff.columnsAdded.length === 0, "0 added");
    assert(diff.columnsRemoved.length === 1, "1 removed");
    assert(diff.columnsRemoved[0] === "legacy_code", "removed legacy_code");
    assert(diff.hasChanges === true, "has changes");
  }

  console.log("\n=== 15. No column changes ===");
  {
    const cols = ["emp_id", "name", "salary"];
    const diff = computeColumnDiff(cols, cols);

    assert(diff.columnsAdded.length === 0, "0 added");
    assert(diff.columnsRemoved.length === 0, "0 removed");
    assert(diff.columnsUnchanged.length === 3, "3 unchanged");
    assert(diff.hasChanges === false, "no changes");
    assert(
      diff.summary === "0 added, 0 removed, 3 unchanged.",
      `summary = "${diff.summary}"`
    );
  }

  console.log("\n=== 16. Column rename appears as add + remove ===");
  {
    const prev = ["emp_id", "old_name"];
    const curr = ["emp_id", "new_name"];
    const diff = computeColumnDiff(prev, curr);

    assert(diff.columnsAdded.length === 1, "1 added (new_name)");
    assert(diff.columnsAdded[0] === "new_name", "added new_name");
    assert(diff.columnsRemoved.length === 1, "1 removed (old_name)");
    assert(diff.columnsRemoved[0] === "old_name", "removed old_name");
    assert(diff.hasChanges === true, "has changes");
  }

  console.log("\n=== 17. Empty column lists ===");
  {
    const diff1 = computeColumnDiff([], ["col_a"]);
    assert(diff1.columnsAdded.length === 1, "1 added to empty");
    assert(diff1.hasChanges === true, "has changes");

    const diff2 = computeColumnDiff(["col_a"], []);
    assert(diff2.columnsRemoved.length === 1, "1 removed to empty");
    assert(diff2.hasChanges === true, "has changes");

    const diff3 = computeColumnDiff([], []);
    assert(diff3.hasChanges === false, "both empty → no changes");
  }

  // === Summary ===
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll schema diff tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
