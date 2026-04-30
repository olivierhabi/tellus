// ---------------------------------------------------------------------------
// Primary Key Validator
//
// Validates primary key values across an entire dataset before indexing
// begins (Part A — Funnel Pipeline), and provides single-key existence
// checks against OpenSearch for the Action execution engine (Part B).
//
// In Palantir's Object Storage V2, duplicate primary keys within a single
// transaction are not allowed and cause indexing failures: "You may not have
// duplicate primary keys within a single transaction." This module scans the
// entire dataset and reports all violations before any data is indexed.
//
// Part A: validatePrimaryKeys() — Funnel pre-indexing validation
// Part B: validatePrimaryKeyNotExists / validatePrimaryKeyExists — Action
//         execution guard checks (Day 5)
// ---------------------------------------------------------------------------

import { client } from "../opensearch/client";
import { getIndexName } from "../opensearch/indexMappingGenerator";
import type { CSVRow } from "./csvReader";

// ---------------------------------------------------------------------------
// Types — Part A (Funnel Pipeline)
// ---------------------------------------------------------------------------

/** A row with a null or empty primary key. */
export interface NullKeyEntry {
  lineNumber: number;
  rawValue: string | null;
}

/** A group of rows that share the same primary key value. */
export interface DuplicateKeyGroup {
  value: string;
  occurrences: number[];
  count: number;
}

/** A row whose primary key has leading/trailing whitespace. */
export interface WhitespaceKeyEntry {
  lineNumber: number;
  rawValue: string;
  trimmedValue: string;
}

/** Errors found during primary key validation. */
export interface PKValidationErrors {
  nullKeys: NullKeyEntry[];
  duplicateKeys: DuplicateKeyGroup[];
}

/** Warnings found during primary key validation. */
export interface PKValidationWarnings {
  whitespaceKeys: WhitespaceKeyEntry[];
}

/** Full result of validatePrimaryKeys(). */
export interface PKValidationResult {
  valid: boolean;
  totalRows: number;
  uniqueKeyCount: number;
  errors: PKValidationErrors;
  warnings: PKValidationWarnings;
  summary: string;
}

// ---------------------------------------------------------------------------
// Types — Part B (Action Execution Guards)
// ---------------------------------------------------------------------------

/** Result when the primary key exists in OpenSearch. */
export interface PKExistsResult {
  exists: true;
  existingObject: Record<string, unknown>;
}

/** Result when the primary key does not exist in OpenSearch. */
export interface PKNotExistsResult {
  exists: false;
  error?: string;
}

export type PKLookupResult = PKExistsResult | PKNotExistsResult;

// ---------------------------------------------------------------------------
// Part A: validatePrimaryKeys()
// ---------------------------------------------------------------------------

/**
 * Validate primary keys across all rows from a CSV dataset.
 *
 * Checks for: column existence, null/empty keys, duplicate keys, and
 * whitespace keys. Returns all issues at once so the user can fix their
 * data in a single pass.
 *
 * Performance: O(n) using a Map for duplicate detection — suitable for
 * datasets with millions of rows.
 *
 * @param rows             - Array of row objects from the CSV reader.
 * @param primaryKeyColumn - The CSV column name serving as the primary key.
 * @returns PKValidationResult with all issues and a human-readable summary.
 */
export function validatePrimaryKeys(
  rows: CSVRow[],
  primaryKeyColumn: string
): PKValidationResult {
  // -----------------------------------------------------------------------
  // Column existence check
  // -----------------------------------------------------------------------
  if (rows.length > 0) {
    const firstRow = rows[0];
    if (!(primaryKeyColumn in firstRow)) {
      const availableColumns = Object.keys(firstRow).join(", ");
      throw new Error(
        `Primary key column '${primaryKeyColumn}' does not exist in the dataset. Available columns: ${availableColumns}`
      );
    }
  }

  // -----------------------------------------------------------------------
  // Scan all rows
  // -----------------------------------------------------------------------
  const nullKeys: NullKeyEntry[] = [];
  const whitespaceKeys: WhitespaceKeyEntry[] = [];

  // Map from trimmed key value → array of 1-indexed line numbers
  const keyOccurrences = new Map<string, number[]>();

  for (let i = 0; i < rows.length; i++) {
    const lineNumber = i + 1; // 1-indexed
    const rawValue = rows[i][primaryKeyColumn] ?? null;

    // Null/empty check
    if (rawValue === null || rawValue === undefined || rawValue.trim() === "") {
      nullKeys.push({
        lineNumber,
        rawValue: rawValue === null || rawValue === undefined ? null : rawValue,
      });
      continue;
    }

    // Whitespace check (before trimming)
    const trimmed = rawValue.trim();
    if (rawValue !== trimmed) {
      whitespaceKeys.push({
        lineNumber,
        rawValue,
        trimmedValue: trimmed,
      });
    }

    // Track occurrences for uniqueness check (using trimmed value)
    const existing = keyOccurrences.get(trimmed);
    if (existing) {
      existing.push(lineNumber);
    } else {
      keyOccurrences.set(trimmed, [lineNumber]);
    }
  }

  // -----------------------------------------------------------------------
  // Identify duplicates
  // -----------------------------------------------------------------------
  const duplicateKeys: DuplicateKeyGroup[] = [];
  for (const [value, lineNumbers] of keyOccurrences) {
    if (lineNumbers.length > 1) {
      duplicateKeys.push({
        value,
        occurrences: lineNumbers,
        count: lineNumbers.length,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Build summary
  // -----------------------------------------------------------------------
  const valid = nullKeys.length === 0 && duplicateKeys.length === 0;
  const uniqueKeyCount = keyOccurrences.size;

  const summaryParts: string[] = [];

  if (nullKeys.length > 0) {
    summaryParts.push(
      `Found ${nullKeys.length} null/empty primary key${nullKeys.length === 1 ? "" : "s"}`
    );
  }

  if (duplicateKeys.length > 0) {
    const affectedRows = duplicateKeys.reduce((sum, g) => sum + g.count, 0);
    summaryParts.push(
      `${duplicateKeys.length} duplicate primary key group${duplicateKeys.length === 1 ? "" : "s"} (affecting ${affectedRows} rows total)`
    );
  }

  if (whitespaceKeys.length > 0) {
    summaryParts.push(
      `${whitespaceKeys.length} primary key value${whitespaceKeys.length === 1 ? "" : "s"} ${whitespaceKeys.length === 1 ? "has" : "have"} leading/trailing whitespace`
    );
  }

  let summary: string;
  if (summaryParts.length === 0) {
    summary = `All ${rows.length} primary keys are valid and unique.`;
  } else if (nullKeys.length > 0 && duplicateKeys.length > 0) {
    // Combine null and duplicate messages with "and"
    summary = `Found ${nullKeys.length} null/empty primary key${nullKeys.length === 1 ? "" : "s"} and ${duplicateKeys.length} duplicate primary key group${duplicateKeys.length === 1 ? "" : "s"} (affecting ${duplicateKeys.reduce((sum, g) => sum + g.count, 0)} rows total).`;
    if (whitespaceKeys.length > 0) {
      summary += ` ${whitespaceKeys.length} primary key value${whitespaceKeys.length === 1 ? "" : "s"} ${whitespaceKeys.length === 1 ? "has" : "have"} leading/trailing whitespace.`;
    }
  } else {
    summary = summaryParts.join(". ") + ".";
  }

  return {
    valid,
    totalRows: rows.length,
    uniqueKeyCount,
    errors: {
      nullKeys,
      duplicateKeys,
    },
    warnings: {
      whitespaceKeys,
    },
    summary,
  };
}

// ---------------------------------------------------------------------------
// Part B: validatePrimaryKeyNotExists()
// ---------------------------------------------------------------------------

/**
 * Check whether a specific primary key already exists in the OpenSearch index.
 *
 * Used by the Action execution engine when creating a new object — the
 * primary key must NOT already exist.
 *
 * @param primaryKeyValue    - The primary key value to check.
 * @param objectTypeApiName  - The object type API name (used to derive index).
 * @returns PKLookupResult indicating whether the key exists.
 */
export async function validatePrimaryKeyNotExists(
  primaryKeyValue: string,
  objectTypeApiName: string
): Promise<PKLookupResult> {
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await client.search({
      index: indexName,
      body: {
        query: {
          term: {
            __pk: primaryKeyValue,
          },
        },
        size: 1,
      },
    });

    const hits = body as unknown as Record<string, unknown>;
    const hitsObj = hits.hits as Record<string, unknown>;
    const hitsArray = hitsObj.hits as Array<Record<string, unknown>>;

    if (hitsArray.length > 0) {
      const doc = hitsArray[0];
      return {
        exists: true,
        existingObject: (doc._source ?? doc) as Record<string, unknown>,
      };
    }

    return { exists: false };
  } catch (err: unknown) {
    // If the index doesn't exist, the key doesn't exist
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("index_not_found_exception") || msg.includes("no such index")) {
      return { exists: false };
    }
    throw new Error(
      `Failed to check primary key existence in '${indexName}': ${msg}`
    );
  }
}

// ---------------------------------------------------------------------------
// Part B: validatePrimaryKeyExists()
// ---------------------------------------------------------------------------

/**
 * Check that a specific primary key DOES exist in the OpenSearch index.
 *
 * Used by the Action execution engine for modify/delete operations — the
 * primary key must exist.
 *
 * @param primaryKeyValue    - The primary key value to check.
 * @param objectTypeApiName  - The object type API name (used to derive index).
 * @returns PKLookupResult indicating whether the key exists.
 */
export async function validatePrimaryKeyExists(
  primaryKeyValue: string,
  objectTypeApiName: string
): Promise<PKLookupResult> {
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await client.search({
      index: indexName,
      body: {
        query: {
          term: {
            __pk: primaryKeyValue,
          },
        },
        size: 1,
      },
    });

    const hits = body as unknown as Record<string, unknown>;
    const hitsObj = hits.hits as Record<string, unknown>;
    const hitsArray = hitsObj.hits as Array<Record<string, unknown>>;

    if (hitsArray.length > 0) {
      const doc = hitsArray[0];
      return {
        exists: true,
        existingObject: (doc._source ?? doc) as Record<string, unknown>,
      };
    }

    return {
      exists: false,
      error: `Object with primary key '${primaryKeyValue}' does not exist in object type '${objectTypeApiName}'`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("index_not_found_exception") || msg.includes("no such index")) {
      return {
        exists: false,
        error: `Object with primary key '${primaryKeyValue}' does not exist in object type '${objectTypeApiName}'`,
      };
    }
    throw new Error(
      `Failed to check primary key existence in '${indexName}': ${msg}`
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  validatePrimaryKeys,
  validatePrimaryKeyNotExists,
  validatePrimaryKeyExists,
};

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/primaryKeyValidator.ts)
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

  console.log("Running primaryKeyValidator self-tests...\n");

  // =====================================================================
  // Helper: generate test rows
  // =====================================================================
  function makeRows(
    count: number,
    overrides?: Record<number, Record<string, string>>
  ): CSVRow[] {
    const rows: CSVRow[] = [];
    for (let i = 0; i < count; i++) {
      rows.push({
        id: `KEY-${String(i + 1).padStart(4, "0")}`,
        name: `Name ${i + 1}`,
        value: String((i + 1) * 100),
      });
    }
    // Apply overrides
    if (overrides) {
      for (const [idx, fields] of Object.entries(overrides)) {
        const i = parseInt(idx, 10);
        if (i < rows.length) {
          Object.assign(rows[i], fields);
        }
      }
    }
    return rows;
  }

  // =====================================================================
  // Test 1: All valid — 100 unique keys
  // =====================================================================
  {
    const rows = makeRows(100);
    const result = validatePrimaryKeys(rows, "id");
    assert(result.valid === true, "all valid: valid is true");
    assert(result.totalRows === 100, "all valid: totalRows is 100");
    assert(result.uniqueKeyCount === 100, "all valid: uniqueKeyCount is 100");
    assert(result.errors.nullKeys.length === 0, "all valid: no null keys");
    assert(result.errors.duplicateKeys.length === 0, "all valid: no duplicates");
    assert(result.warnings.whitespaceKeys.length === 0, "all valid: no whitespace");
    assert(result.summary.includes("All 100 primary keys"), "all valid: summary");
  }

  // =====================================================================
  // Test 2: Null/empty primary keys
  // =====================================================================
  {
    const rows = makeRows(10, {
      2: { id: "" },          // row 3 (1-indexed): empty
      6: { id: "   " },       // row 7: whitespace only
    });
    const result = validatePrimaryKeys(rows, "id");
    assert(result.valid === false, "null keys: valid is false");
    assert(result.errors.nullKeys.length === 2, "null keys: found 2 null keys");

    const lineNumbers = result.errors.nullKeys.map((e) => e.lineNumber);
    assert(lineNumbers.includes(3), "null keys: line 3 detected");
    assert(lineNumbers.includes(7), "null keys: line 7 detected");

    // The empty one
    const emptyEntry = result.errors.nullKeys.find((e) => e.lineNumber === 3);
    assert(emptyEntry !== undefined && emptyEntry.rawValue === "", "null keys: raw value is empty string");

    // The whitespace one
    const wsEntry = result.errors.nullKeys.find((e) => e.lineNumber === 7);
    assert(wsEntry !== undefined && wsEntry.rawValue === "   ", "null keys: raw value is whitespace");
  }

  // =====================================================================
  // Test 3: Duplicate primary keys
  // =====================================================================
  {
    const rows = makeRows(10, {
      0: { id: "DUP-001" },   // row 1
      4: { id: "DUP-001" },   // row 5 — duplicate of row 1
      7: { id: "DUP-001" },   // row 8 — triplicate
      2: { id: "DUP-002" },   // row 3
      5: { id: "DUP-002" },   // row 6 — duplicate of row 3
    });
    const result = validatePrimaryKeys(rows, "id");
    assert(result.valid === false, "duplicates: valid is false");
    assert(result.errors.duplicateKeys.length === 2, "duplicates: 2 duplicate groups");

    const dup001 = result.errors.duplicateKeys.find((g) => g.value === "DUP-001");
    assert(dup001 !== undefined, "duplicates: DUP-001 group found");
    if (dup001) {
      assert(dup001.count === 3, "duplicates: DUP-001 count is 3");
      assert(
        dup001.occurrences.includes(1) &&
          dup001.occurrences.includes(5) &&
          dup001.occurrences.includes(8),
        "duplicates: DUP-001 occurrences are [1, 5, 8]"
      );
    }

    const dup002 = result.errors.duplicateKeys.find((g) => g.value === "DUP-002");
    assert(dup002 !== undefined, "duplicates: DUP-002 group found");
    if (dup002) {
      assert(dup002.count === 2, "duplicates: DUP-002 count is 2");
    }
  }

  // =====================================================================
  // Test 4: Whitespace warnings
  // =====================================================================
  {
    const rows = makeRows(5, {
      1: { id: "KEY-002 " },       // trailing space
      3: { id: " KEY-004" },       // leading space
      4: { id: " KEY-005 " },      // both
    });
    const result = validatePrimaryKeys(rows, "id");
    // Whitespace alone does NOT make it invalid
    assert(result.valid === true, "whitespace: valid is still true");
    assert(result.warnings.whitespaceKeys.length === 3, "whitespace: 3 warnings");

    const w1 = result.warnings.whitespaceKeys.find((w) => w.lineNumber === 2);
    assert(w1 !== undefined && w1.rawValue === "KEY-002 " && w1.trimmedValue === "KEY-002",
      "whitespace: trailing space detected");

    const w2 = result.warnings.whitespaceKeys.find((w) => w.lineNumber === 4);
    assert(w2 !== undefined && w2.rawValue === " KEY-004" && w2.trimmedValue === "KEY-004",
      "whitespace: leading space detected");
  }

  // =====================================================================
  // Test 5: Whitespace causing hidden duplicates
  // =====================================================================
  {
    const rows = makeRows(5, {
      0: { id: "KEY-001" },
      1: { id: "KEY-001 " },   // trailing space → trimmed to same value
    });
    const result = validatePrimaryKeys(rows, "id");
    // After trimming, both are "KEY-001" → duplicate
    assert(result.valid === false, "whitespace dup: valid is false");
    assert(result.errors.duplicateKeys.length === 1, "whitespace dup: 1 duplicate group");
    assert(
      result.errors.duplicateKeys[0].value === "KEY-001",
      "whitespace dup: value is KEY-001 (trimmed)"
    );
    assert(result.warnings.whitespaceKeys.length === 1, "whitespace dup: 1 whitespace warning");
  }

  // =====================================================================
  // Test 6: Column does not exist
  // =====================================================================
  {
    const rows = makeRows(3);
    let threw = false;
    let errMsg = "";
    try {
      validatePrimaryKeys(rows, "nonexistent_column");
    } catch (e: unknown) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    assert(threw, "missing column: threw error");
    assert(
      errMsg.includes("nonexistent_column") && errMsg.includes("does not exist"),
      "missing column: error mentions column name"
    );
    assert(errMsg.includes("id") && errMsg.includes("name") && errMsg.includes("value"),
      "missing column: error lists available columns");
  }

  // =====================================================================
  // Test 7: Empty dataset
  // =====================================================================
  {
    const result = validatePrimaryKeys([], "id");
    assert(result.valid === true, "empty: valid is true");
    assert(result.totalRows === 0, "empty: totalRows is 0");
    assert(result.uniqueKeyCount === 0, "empty: uniqueKeyCount is 0");
  }

  // =====================================================================
  // Test 8: Large dataset (1000 rows) with mixed issues
  // =====================================================================
  {
    const rows = makeRows(1000, {
      44:  { id: "" },            // null — row 45
      871: { id: "" },            // null — row 872
      0:   { id: "DUP-001" },    // duplicate group 1
      502: { id: "DUP-001" },
      441: { id: "DUP-442" },    // duplicate group 2
      442: { id: "DUP-442" },
      443: { id: "DUP-442" },
      66:  { id: "KEY-067 " },   // whitespace — row 67
    });
    const result = validatePrimaryKeys(rows, "id");
    assert(result.valid === false, "1000 rows: valid is false");
    assert(result.totalRows === 1000, "1000 rows: totalRows is 1000");
    assert(result.errors.nullKeys.length === 2, "1000 rows: 2 null keys");
    assert(result.errors.duplicateKeys.length === 2, "1000 rows: 2 duplicate groups");
    assert(result.warnings.whitespaceKeys.length === 1, "1000 rows: 1 whitespace warning");

    // Verify summary mentions all issues
    assert(result.summary.includes("2 null/empty"), "1000 rows: summary mentions null");
    assert(result.summary.includes("2 duplicate"), "1000 rows: summary mentions duplicates");
    assert(
      result.summary.includes("5 rows total") || result.summary.includes("affecting 5"),
      "1000 rows: summary mentions affected row count"
    );
    assert(result.summary.includes("whitespace"), "1000 rows: summary mentions whitespace");
  }

  // =====================================================================
  // Test 9: Performance — 100,000 rows should be fast
  // =====================================================================
  {
    const bigRows: CSVRow[] = [];
    for (let i = 0; i < 100000; i++) {
      bigRows.push({ pk: `KEY-${i}`, data: `val-${i}` });
    }
    const start = Date.now();
    const result = validatePrimaryKeys(bigRows, "pk");
    const elapsed = Date.now() - start;
    assert(result.valid === true, "perf: 100k rows valid");
    assert(result.uniqueKeyCount === 100000, "perf: 100k unique keys");
    assert(elapsed < 5000, `perf: completed in ${elapsed}ms (< 5000ms)`);
    console.log(`  (100k rows validated in ${elapsed}ms)`);
  }

  // =====================================================================
  // Test 10: Summary messages for different cases
  // =====================================================================
  {
    // Only whitespace (still valid)
    const rows1 = makeRows(3, { 0: { id: " KEY " } });
    const r1 = validatePrimaryKeys(rows1, "id");
    assert(r1.valid === true, "summary: whitespace only is valid");
    assert(r1.summary.includes("whitespace"), "summary: whitespace message");

    // Only nulls
    const rows2 = makeRows(3, { 0: { id: "" } });
    const r2 = validatePrimaryKeys(rows2, "id");
    assert(r2.valid === false, "summary: null only is invalid");
    assert(r2.summary.includes("null/empty"), "summary: null message");

    // Only duplicates
    const rows3 = makeRows(3, { 0: { id: "SAME" }, 1: { id: "SAME" } });
    const r3 = validatePrimaryKeys(rows3, "id");
    assert(r3.valid === false, "summary: dup only is invalid");
    assert(r3.summary.includes("duplicate"), "summary: dup message");
  }

  // =====================================================================
  // Test 11: Null rawValue vs empty string rawValue in nullKeys
  // =====================================================================
  {
    // Simulate a row where the column key doesn't exist (value is undefined)
    const rows: CSVRow[] = [
      { id: "KEY-1", name: "A" },
      { name: "B" } as unknown as CSVRow, // missing 'id' key → undefined
    ];
    // TypeScript rows have 'id' in type but not in reality for row 2
    // validatePrimaryKeys accesses rows[1]["id"] which is undefined
    const result = validatePrimaryKeys(rows, "id");
    assert(result.errors.nullKeys.length === 1, "undefined key: 1 null key");
    assert(result.errors.nullKeys[0].rawValue === null, "undefined key: rawValue is null");
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll primaryKeyValidator tests passed");
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
