// ---------------------------------------------------------------------------
// Mapping Suggestion Service
//
// Suggests column-to-property mappings for backing datasources. When a user
// registers a CSV/JSON file as a datasource for an object type, this service
// analyzes column names and detected types to suggest the best mapping from
// file columns to Ontology properties.
//
// Scoring algorithm:
//   - Name similarity (0-60 points): Normalized Levenshtein distance after
//     normalization (lowercase, strip underscores/hyphens/spaces).
//   - Type compatibility (0-40 points): How well the detected column type
//     matches the property's base type.
//
// Assignment: Greedy algorithm — highest total score is assigned first,
// then both column and property are removed from the candidate pool.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { scanFile, ScanResult } from "./fileScannerService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single suggested mapping from a column to a property. */
export interface MappingSuggestionEntry {
  columnName: string;
  propertyApiName: string;
  score: number;
  nameScore: number;
  typeScore: number;
}

/** Full suggestion result. */
export interface MappingSuggestion {
  suggestions: MappingSuggestionEntry[];
  unmappedColumns: string[];
  unmappedProperties: string[];
  columnMapping: Record<string, string>;
}

/** Options for suggestMapping(). */
export interface SuggestMappingOptions {
  /** Injected dependencies for testing. */
  deps?: Partial<MappingSuggestionDeps>;
}

/** Dependency injection interface. */
export interface MappingSuggestionDeps {
  queryFn: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  scanFile: (filePath: string, fileFormat: string) => Promise<ScanResult>;
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<MappingSuggestionDeps>): MappingSuggestionDeps {
  return {
    queryFn: partial?.queryFn ?? query,
    scanFile: partial?.scanFile ?? scanFile,
  };
}

// ---------------------------------------------------------------------------
// String normalization for comparison
// ---------------------------------------------------------------------------

/**
 * Normalize a string for comparison: lowercase, replace underscores, hyphens,
 * and spaces with nothing (collapse to single word).
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[_\-\s]+/g, "");
}

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Classic dynamic programming implementation with O(m*n) time and O(min(m,n))
 * space (single-row optimization).
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns The minimum number of single-character edits (insert, delete,
 *          substitute) needed to transform a into b.
 */
export function levenshteinDistance(a: string, b: string): number {
  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Previous row of distances
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);

  // Initialize previous row: distance from empty string to a[0..j]
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      if (b[i - 1] === a[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(
          prev[j],       // deletion
          curr[j - 1],   // insertion
          prev[j - 1]    // substitution
        );
      }
    }
    // Swap rows
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

// ---------------------------------------------------------------------------
// Name similarity scoring (0-60)
// ---------------------------------------------------------------------------

/**
 * Score the similarity between a property name and a column name.
 * Both names are normalized (lowercase, strip separators) before comparison.
 *
 * Score = 60 * (1 - levenshteinDistance / maxLength)
 *
 * @returns A score between 0 and 60.
 */
export function nameSimilarity(propName: string, columnName: string): number {
  const a = normalize(propName);
  const b = normalize(columnName);

  // If both empty, perfect match
  if (a.length === 0 && b.length === 0) return 60;

  const maxLen = Math.max(a.length, b.length);
  const dist = levenshteinDistance(a, b);
  const similarity = 1 - dist / maxLen;

  return Math.round(similarity * 60 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Type compatibility scoring (0-40)
// ---------------------------------------------------------------------------

/**
 * Type compatibility matrix: how well a detected column type matches a
 * property base type. 40 = exact match, 20 = compatible (coercible),
 * 0 = incompatible.
 */
const TYPE_COMPAT_MATRIX: Record<string, Record<string, number>> = {
  // Detected type → { property base type → score }
  string: {
    string: 40,
    // Everything can come from a string column with coercion
    boolean: 10, integer: 10, long: 10, double: 10, float: 10,
    date: 10, timestamp: 10, byte: 10, short: 10, decimal: 10,
    geopoint: 5, geoshape: 5, struct: 5,
    string_array: 15, integer_array: 5, double_array: 5,
    boolean_array: 5, timestamp_array: 5,
  },
  integer: {
    integer: 40, long: 35, double: 30, float: 30, decimal: 30,
    short: 25, byte: 20, string: 15, boolean: 10,
    date: 0, timestamp: 5, geopoint: 0, geoshape: 0, struct: 0,
    string_array: 0, integer_array: 20, double_array: 15,
    boolean_array: 0, timestamp_array: 0,
  },
  double: {
    double: 40, float: 35, decimal: 35, long: 20, integer: 15,
    string: 15, short: 10, byte: 10, boolean: 0,
    date: 0, timestamp: 0, geopoint: 0, geoshape: 0, struct: 0,
    string_array: 0, integer_array: 0, double_array: 20,
    boolean_array: 0, timestamp_array: 0,
  },
  boolean: {
    boolean: 40, string: 15, integer: 10,
    long: 5, double: 5, float: 5, decimal: 5,
    date: 0, timestamp: 0, byte: 10, short: 5,
    geopoint: 0, geoshape: 0, struct: 0,
    string_array: 0, integer_array: 0, double_array: 0,
    boolean_array: 20, timestamp_array: 0,
  },
  date: {
    date: 40, timestamp: 30, string: 15,
    integer: 0, long: 0, double: 0, float: 0, decimal: 0,
    boolean: 0, byte: 0, short: 0,
    geopoint: 0, geoshape: 0, struct: 0,
    string_array: 0, integer_array: 0, double_array: 0,
    boolean_array: 0, timestamp_array: 10,
  },
  timestamp: {
    timestamp: 40, date: 25, string: 15,
    integer: 0, long: 5, double: 0, float: 0, decimal: 0,
    boolean: 0, byte: 0, short: 0,
    geopoint: 0, geoshape: 0, struct: 0,
    string_array: 0, integer_array: 0, double_array: 0,
    boolean_array: 0, timestamp_array: 20,
  },
};

/**
 * Score the type compatibility between a detected column type and a
 * property base type.
 *
 * @param palantirType - The property's base type (from Ontology schema).
 * @param detectedType - The inferred type from the file scanner.
 * @returns A score between 0 and 40.
 */
export function typeCompatibilityScore(
  palantirType: string,
  detectedType: string
): number {
  // Look up in the matrix
  const detectedMap = TYPE_COMPAT_MATRIX[detectedType];
  if (detectedMap && palantirType in detectedMap) {
    return detectedMap[palantirType];
  }

  // If the detected type matches the property type exactly, max score
  if (detectedType === palantirType) return 40;

  // String is the fallback detected type — give partial credit
  if (detectedType === "string") return 10;

  // Unknown combination — no compatibility
  return 0;
}

// ---------------------------------------------------------------------------
// suggestMapping()
// ---------------------------------------------------------------------------

/**
 * Suggest a column-to-property mapping for an object type and dataset.
 *
 * Algorithm:
 *   1. Load properties for the object type.
 *   2. Scan the dataset file to get column names and inferred types.
 *   3. For each (column, property) pair, compute a combined score.
 *   4. Greedy assignment: pick the highest-scoring pair, assign it,
 *      remove both from the candidate pool, repeat.
 *
 * @param ontologyId        - The ontology UUID.
 * @param objectTypeApiName - The object type API name.
 * @param datasetId         - The dataset identifier (file path).
 * @param options           - Optional configuration.
 * @returns A MappingSuggestion with suggested mappings and unmapped items.
 */
export async function suggestMapping(
  ontologyId: string,
  objectTypeApiName: string,
  datasetId: string,
  options?: SuggestMappingOptions
): Promise<MappingSuggestion> {
  const deps = resolveDeps(options?.deps);

  // -----------------------------------------------------------------
  // Step 1: Load object type and properties
  // -----------------------------------------------------------------
  const otResult = await deps.queryFn(
    `SELECT ot.object_type_id
     FROM object_type ot
     WHERE ot.ontology_id = $1 AND ot.api_name = $2`,
    [ontologyId, objectTypeApiName]
  );

  if (otResult.rows.length === 0) {
    throw new Error(`Object type '${objectTypeApiName}' not found in ontology '${ontologyId}'.`);
  }

  const objectTypeId = otResult.rows[0].object_type_id;

  const propsResult = await deps.queryFn(
    `SELECT api_name, base_type FROM property WHERE object_type_id = $1 ORDER BY ordinal, api_name`,
    [objectTypeId]
  );

  const properties: Array<{ api_name: string; base_type: string }> = propsResult.rows;

  // -----------------------------------------------------------------
  // Step 2: Get dataset columns and inferred types
  // -----------------------------------------------------------------
  // First check if there's a backing datasource registered with this file path
  const dsResult = await deps.queryFn(
    `SELECT file_path, file_format FROM backing_datasource WHERE object_type_id = $1`,
    [objectTypeId]
  );

  let columnNames: string[];
  let inferredTypes: Record<string, string>;

  if (dsResult.rows.length > 0) {
    // Use the registered datasource's file
    const filePath = dsResult.rows[0].file_path;
    const fileFormat = dsResult.rows[0].file_format || "csv";
    const scanResult = await deps.scanFile(filePath, fileFormat);
    columnNames = scanResult.columnNames;
    inferredTypes = scanResult.inferredTypes;
  } else {
    // Use the provided datasetId as a file path
    const scanResult = await deps.scanFile(datasetId, "csv");
    columnNames = scanResult.columnNames;
    inferredTypes = scanResult.inferredTypes;
  }

  // -----------------------------------------------------------------
  // Step 3: Score all (column, property) pairs
  // -----------------------------------------------------------------
  interface ScoredPair {
    columnName: string;
    propertyApiName: string;
    nameScore: number;
    typeScore: number;
    totalScore: number;
  }

  const scoredPairs: ScoredPair[] = [];

  for (const col of columnNames) {
    for (const prop of properties) {
      const nScore = nameSimilarity(prop.api_name, col);
      const tScore = typeCompatibilityScore(
        prop.base_type,
        inferredTypes[col] || "string"
      );
      scoredPairs.push({
        columnName: col,
        propertyApiName: prop.api_name,
        nameScore: nScore,
        typeScore: tScore,
        totalScore: nScore + tScore,
      });
    }
  }

  // -----------------------------------------------------------------
  // Step 4: Greedy assignment
  // -----------------------------------------------------------------
  // Sort descending by total score
  scoredPairs.sort((a, b) => b.totalScore - a.totalScore);

  const assignedColumns = new Set<string>();
  const assignedProperties = new Set<string>();
  const suggestions: MappingSuggestionEntry[] = [];

  for (const pair of scoredPairs) {
    if (assignedColumns.has(pair.columnName)) continue;
    if (assignedProperties.has(pair.propertyApiName)) continue;

    // Only suggest if score is above a minimum threshold
    if (pair.totalScore < 15) continue;

    suggestions.push({
      columnName: pair.columnName,
      propertyApiName: pair.propertyApiName,
      score: pair.totalScore,
      nameScore: pair.nameScore,
      typeScore: pair.typeScore,
    });

    assignedColumns.add(pair.columnName);
    assignedProperties.add(pair.propertyApiName);
  }

  // -----------------------------------------------------------------
  // Compute unmapped items
  // -----------------------------------------------------------------
  const unmappedColumns = columnNames.filter((c) => !assignedColumns.has(c));
  const unmappedProperties = properties
    .map((p) => p.api_name)
    .filter((p) => !assignedProperties.has(p));

  // Build the column mapping (property api_name -> column name)
  const columnMapping: Record<string, string> = {};
  for (const s of suggestions) {
    columnMapping[s.propertyApiName] = s.columnName;
  }

  return {
    suggestions,
    unmappedColumns,
    unmappedProperties,
    columnMapping,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { levenshteinDistance, nameSimilarity, typeCompatibilityScore, suggestMapping };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/mappingSuggestionService.ts)
// ---------------------------------------------------------------------------

async function runSelfTests(): Promise<void> {
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

  function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
    if (Math.abs(actual - expected) <= tolerance) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label} (expected ~${expected}, got ${actual})`);
    }
  }

  console.log("Running mappingSuggestionService self-tests...\n");

  // =====================================================================
  // Levenshtein distance tests
  // =====================================================================
  console.log("--- Levenshtein distance ---");

  assert(levenshteinDistance("", "") === 0, "lev: empty strings → 0");
  assert(levenshteinDistance("abc", "") === 3, "lev: 'abc' vs '' → 3");
  assert(levenshteinDistance("", "xyz") === 3, "lev: '' vs 'xyz' → 3");
  assert(levenshteinDistance("abc", "abc") === 0, "lev: identical → 0");
  assert(levenshteinDistance("abc", "abd") === 1, "lev: 1 substitution → 1");
  assert(levenshteinDistance("abc", "abcd") === 1, "lev: 1 insertion → 1");
  assert(levenshteinDistance("abcd", "abc") === 1, "lev: 1 deletion → 1");
  assert(levenshteinDistance("kitten", "sitting") === 3, "lev: kitten/sitting → 3");
  assert(levenshteinDistance("saturday", "sunday") === 3, "lev: saturday/sunday → 3");
  assert(levenshteinDistance("book", "back") === 2, "lev: book/back → 2");
  assert(levenshteinDistance("a", "b") === 1, "lev: single char diff → 1");
  assert(levenshteinDistance("abc", "cba") === 2, "lev: abc/cba → 2");

  // Symmetry
  assert(
    levenshteinDistance("hello", "world") === levenshteinDistance("world", "hello"),
    "lev: symmetric"
  );

  // Case sensitivity
  assert(levenshteinDistance("ABC", "abc") === 3, "lev: case sensitive");

  // =====================================================================
  // Name similarity tests
  // =====================================================================
  console.log("\n--- Name similarity ---");

  // Exact match (after normalization)
  assert(nameSimilarity("employeeId", "employee_id") === 60, "name: exact match after normalize → 60");
  assert(nameSimilarity("firstName", "first_name") === 60, "name: camelCase vs snake_case → 60");
  assert(nameSimilarity("fullName", "full-name") === 60, "name: camelCase vs kebab-case → 60");

  // Identical strings
  assert(nameSimilarity("name", "name") === 60, "name: identical → 60");

  // Completely different
  assertClose(nameSimilarity("abc", "xyz"), 0, 1, "name: completely different → ~0");

  // Partial match
  {
    const score = nameSimilarity("salary", "sal");
    assert(score > 0 && score < 60, `name: partial match (salary/sal) → ${score}`);
  }

  // Longer strings with small difference
  {
    const score = nameSimilarity("employeeName", "employeeName1");
    assert(score > 50, `name: small diff on long string → ${score}`);
  }

  // Empty strings
  assert(nameSimilarity("", "") === 60, "name: both empty → 60");

  // =====================================================================
  // Type compatibility tests
  // =====================================================================
  console.log("\n--- Type compatibility ---");

  // Exact type matches
  assert(typeCompatibilityScore("string", "string") === 40, "type: string/string → 40");
  assert(typeCompatibilityScore("integer", "integer") === 40, "type: integer/integer → 40");
  assert(typeCompatibilityScore("double", "double") === 40, "type: double/double → 40");
  assert(typeCompatibilityScore("boolean", "boolean") === 40, "type: boolean/boolean → 40");
  assert(typeCompatibilityScore("date", "date") === 40, "type: date/date → 40");
  assert(typeCompatibilityScore("timestamp", "timestamp") === 40, "type: timestamp/timestamp → 40");

  // Compatible types
  assert(typeCompatibilityScore("long", "integer") === 35, "type: long from integer → 35");
  assert(typeCompatibilityScore("double", "integer") === 30, "type: double from integer → 30");
  assert(typeCompatibilityScore("timestamp", "date") === 30, "type: timestamp from date → 30");
  assert(typeCompatibilityScore("date", "timestamp") === 25, "type: date from timestamp → 25");

  // Incompatible types
  assert(typeCompatibilityScore("date", "integer") === 0, "type: date from integer → 0");
  assert(typeCompatibilityScore("boolean", "double") === 0, "type: boolean from double → 0");
  assert(typeCompatibilityScore("geopoint", "integer") === 0, "type: geopoint from integer → 0");

  // String detected type has partial credit for everything
  assert(typeCompatibilityScore("integer", "string") === 10, "type: integer from string → 10");
  assert(typeCompatibilityScore("date", "string") === 10, "type: date from string → 10");

  // Unknown types
  assert(typeCompatibilityScore("unknown", "unknown") === 40, "type: unknown/unknown → 40 (exact match)");

  // =====================================================================
  // suggestMapping integration tests
  // =====================================================================
  console.log("\n--- suggestMapping ---");

  // --- Test: Perfect match scenario ---
  {
    const deps: MappingSuggestionDeps = {
      queryFn: async (text, values) => {
        if (text.includes("FROM object_type")) {
          return { rows: [{ object_type_id: "ot-1" }] };
        }
        if (text.includes("FROM property")) {
          return {
            rows: [
              { api_name: "employeeId", base_type: "string" },
              { api_name: "fullName", base_type: "string" },
              { api_name: "salary", base_type: "integer" },
              { api_name: "startDate", base_type: "date" },
            ],
          };
        }
        if (text.includes("FROM backing_datasource")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      scanFile: async () => ({
        columnNames: ["employee_id", "full_name", "salary", "start_date"],
        rowCount: 100,
        schemaHash: "abc",
        sampleRows: [],
        inferredTypes: {
          employee_id: "string",
          full_name: "string",
          salary: "integer",
          start_date: "date",
        },
      }),
    };

    const result = await suggestMapping("ont-1", "Employee", "/data/emp.csv", { deps });

    assert(result.suggestions.length === 4, "perfect: 4 suggestions");
    assert(result.unmappedColumns.length === 0, "perfect: no unmapped columns");
    assert(result.unmappedProperties.length === 0, "perfect: no unmapped properties");

    // Check that employeeId maps to employee_id
    const empMapping = result.suggestions.find(
      (s) => s.propertyApiName === "employeeId"
    );
    assert(empMapping !== undefined, "perfect: employeeId mapped");
    assert(empMapping!.columnName === "employee_id", "perfect: employeeId → employee_id");
    assert(empMapping!.score === 100, `perfect: score 100 (got ${empMapping!.score})`);
  }

  // --- Test: Partial match with unmapped items ---
  {
    const deps: MappingSuggestionDeps = {
      queryFn: async (text) => {
        if (text.includes("FROM object_type")) {
          return { rows: [{ object_type_id: "ot-1" }] };
        }
        if (text.includes("FROM property")) {
          return {
            rows: [
              { api_name: "name", base_type: "string" },
              { api_name: "age", base_type: "integer" },
              { api_name: "email", base_type: "string" },
            ],
          };
        }
        if (text.includes("FROM backing_datasource")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      scanFile: async () => ({
        columnNames: ["name", "score", "extra_col"],
        rowCount: 50,
        schemaHash: "def",
        sampleRows: [],
        inferredTypes: { name: "string", score: "integer", extra_col: "string" },
      }),
    };

    const result = await suggestMapping("ont-1", "Person", "/data/people.csv", { deps });

    // "name" → "name" (perfect match)
    const nameMapping = result.suggestions.find((s) => s.propertyApiName === "name");
    assert(nameMapping !== undefined, "partial: name mapped");
    assert(nameMapping!.columnName === "name", "partial: name → name");

    // All 3 columns score above threshold and get mapped to the 3 properties
    assert(
      result.suggestions.length >= 1,
      `partial: has suggestions (got ${result.suggestions.length})`
    );
  }

  // --- Test: Object type not found ---
  {
    const deps: MappingSuggestionDeps = {
      queryFn: async (text) => {
        if (text.includes("FROM object_type")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      scanFile: async () => ({
        columnNames: [],
        rowCount: 0,
        schemaHash: "",
        sampleRows: [],
        inferredTypes: {},
      }),
    };

    let threw = false;
    try {
      await suggestMapping("ont-1", "NonExistent", "/data/x.csv", { deps });
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("not found"),
        "not found: error message"
      );
    }
    assert(threw, "not found: throws");
  }

  // --- Test: Empty properties → all columns unmapped ---
  {
    const deps: MappingSuggestionDeps = {
      queryFn: async (text) => {
        if (text.includes("FROM object_type")) {
          return { rows: [{ object_type_id: "ot-1" }] };
        }
        if (text.includes("FROM property")) {
          return { rows: [] };
        }
        if (text.includes("FROM backing_datasource")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      scanFile: async () => ({
        columnNames: ["col1", "col2"],
        rowCount: 10,
        schemaHash: "xyz",
        sampleRows: [],
        inferredTypes: { col1: "string", col2: "integer" },
      }),
    };

    const result = await suggestMapping("ont-1", "Empty", "/data/x.csv", { deps });
    assert(result.suggestions.length === 0, "empty props: no suggestions");
    assert(result.unmappedColumns.length === 2, "empty props: 2 unmapped columns");
    assert(result.unmappedProperties.length === 0, "empty props: 0 unmapped properties");
  }

  // --- Test: Column mapping output format ---
  {
    const deps: MappingSuggestionDeps = {
      queryFn: async (text) => {
        if (text.includes("FROM object_type")) {
          return { rows: [{ object_type_id: "ot-1" }] };
        }
        if (text.includes("FROM property")) {
          return {
            rows: [
              { api_name: "id", base_type: "string" },
              { api_name: "value", base_type: "integer" },
            ],
          };
        }
        if (text.includes("FROM backing_datasource")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      scanFile: async () => ({
        columnNames: ["id", "value"],
        rowCount: 5,
        schemaHash: "abc",
        sampleRows: [],
        inferredTypes: { id: "string", value: "integer" },
      }),
    };

    const result = await suggestMapping("ont-1", "Test", "/data/x.csv", { deps });
    assert(typeof result.columnMapping === "object", "mapping: is object");
    assert(result.columnMapping.id === "id", "mapping: id → id");
    assert(result.columnMapping.value === "value", "mapping: value → value");
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll mappingSuggestionService tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests().catch((err) => {
    console.error("Self-test error:", err);
    process.exit(1);
  });
}
