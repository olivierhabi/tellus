// ---------------------------------------------------------------------------
// File Scanner Service (CSV and JSON)
//
// Scans CSV and JSON files to extract metadata: column names, row count,
// inferred data types, sample rows, and a schema hash. This information is
// stored in the backing_datasource table and passed to the column mapping
// validator (Task 23).
//
// This module is the single source of truth for file scanning —
// datasourceService delegates all scanning here.
// ---------------------------------------------------------------------------

import fs from "fs";
import crypto from "crypto";
import { parse as parseSync } from "csv-parse/sync";
import { parse as parseStream } from "csv-parse";
import { sanitizeCsvHeader } from "../utils/csvHeader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResult {
  columnNames: string[];
  rowCount: number;
  schemaHash: string;
  sampleRows: Record<string, unknown>[];
  inferredTypes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SYNC_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_SAMPLE_ROWS = 10;

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

/**
 * Infer column types from sample rows. Examines all non-empty values per
 * column across the sample and picks the most specific matching type.
 *
 * Rules (checked in order, ALL non-empty values must match):
 *   - integer:  /^-?\d+$/
 *   - double:   /^-?\d+\.?\d*$/
 *   - date:     /^\d{4}-\d{2}-\d{2}$/
 *   - boolean:  /^(true|false)$/i
 *   - string:   fallback
 */
function inferTypes(
  columnNames: string[],
  sampleRows: Record<string, unknown>[]
): Record<string, string> {
  const inferredTypes: Record<string, string> = {};

  for (const col of columnNames) {
    // Collect non-empty string values for this column
    const values: string[] = [];
    for (const row of sampleRows) {
      const val = row[col];
      if (val === undefined || val === null) continue;
      const str = String(val).trim();
      if (str === "") continue;
      values.push(str);
    }

    // No non-empty values → can't infer, default to string
    if (values.length === 0) {
      inferredTypes[col] = "string";
      continue;
    }

    // Check integer: all values match ^-?\d+$
    if (values.every((v) => /^-?\d+$/.test(v))) {
      inferredTypes[col] = "integer";
      continue;
    }

    // Check double: all values match ^-?\d+\.?\d*$
    if (values.every((v) => /^-?\d+\.?\d*$/.test(v))) {
      inferredTypes[col] = "double";
      continue;
    }

    // Check date: all values match ^\d{4}-\d{2}-\d{2}$
    if (values.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
      inferredTypes[col] = "date";
      continue;
    }

    // Check boolean: all values match ^(true|false)$/i
    if (values.every((v) => /^(true|false)$/i.test(v))) {
      inferredTypes[col] = "boolean";
      continue;
    }

    // Fallback
    inferredTypes[col] = "string";
  }

  return inferredTypes;
}

// ---------------------------------------------------------------------------
// Schema hash
// ---------------------------------------------------------------------------

/**
 * Compute an MD5 hash of sorted column names joined by comma.
 * Used for change detection between scans.
 */
function computeSchemaHash(columnNames: string[]): string {
  return crypto
    .createHash("md5")
    .update(columnNames.slice().sort().join(","))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// CSV scanning — synchronous (≤ 100 MB)
// ---------------------------------------------------------------------------

function scanCsvSync(filePath: string): ScanResult {
  let content = fs.readFileSync(filePath, "utf-8");

  // Strip UTF-8 BOM if present
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  const records: Record<string, string>[] = parseSync(content, {
    // See `src/utils/csvHeader.ts` — prevents silent column drop when
    // the file has duplicate or blank header cells.
    columns: (h: string[]) => sanitizeCsvHeader(h, { source: filePath }),
    skip_empty_lines: true,
    relax_column_count: true,
  });

  // Detect inconsistent column counts by checking if relax_column_count
  // was needed. We do a quick heuristic: if any row has a different number
  // of keys than the header, warn.
  if (records.length > 0) {
    const expectedCols = Object.keys(records[0]).length;
    const inconsistent = records.some(
      (r) => Object.keys(r).length !== expectedCols
    );
    if (inconsistent) {
      console.warn("Warning: File has inconsistent column counts.");
    }
  }

  const columnNames = records.length > 0 ? Object.keys(records[0]) : [];

  // For header-only files, try to extract column names from the content
  if (records.length === 0 && content.trim().length > 0) {
    const headerLine = content.trim().split("\n")[0];
    const headerCols = headerLine.split(",").map((c) => c.trim());
    if (headerCols.length > 0 && headerCols[0] !== "") {
      return {
        columnNames: headerCols,
        rowCount: 0,
        schemaHash: computeSchemaHash(headerCols),
        sampleRows: [],
        inferredTypes: {},
      };
    }
  }

  const rowCount = records.length;
  const sampleRows = records.slice(0, MAX_SAMPLE_ROWS);
  const schemaHash = computeSchemaHash(columnNames);
  const inferredTypes = inferTypes(columnNames, sampleRows);

  return { columnNames, rowCount, schemaHash, sampleRows, inferredTypes };
}

// ---------------------------------------------------------------------------
// CSV scanning — streaming (> 100 MB)
// ---------------------------------------------------------------------------

function scanCsvStream(filePath: string): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sampleRows: Record<string, string>[] = [];
    let columnNames: string[] = [];
    let rowCount = 0;

    const parser = parseStream({
      // See `src/utils/csvHeader.ts` — prevents silent column drop when
      // the file has duplicate or blank header cells.
      columns: (h: string[]) => sanitizeCsvHeader(h, { source: filePath }),
      skip_empty_lines: true,
      relax_column_count: true,
    });

    const stream = fs.createReadStream(filePath, "utf-8");

    parser.on("readable", () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        rowCount++;
        if (rowCount === 1) {
          columnNames = Object.keys(record);
        }
        if (sampleRows.length < MAX_SAMPLE_ROWS) {
          sampleRows.push(record);
        }
      }
    });

    parser.on("error", (err) => {
      reject(err);
    });

    parser.on("end", () => {
      const schemaHash = computeSchemaHash(columnNames);
      const inferredTypes = inferTypes(columnNames, sampleRows);
      resolve({
        columnNames,
        rowCount,
        schemaHash,
        sampleRows,
        inferredTypes,
      });
    });

    stream.pipe(parser);
  });
}

// ---------------------------------------------------------------------------
// JSON scanning
// ---------------------------------------------------------------------------

function scanJson(filePath: string): ScanResult {
  const content = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error("JSON file must contain a top-level array.");
  }

  const records: Record<string, unknown>[] = data;
  const rowCount = records.length;
  const sampleRows = records.slice(0, MAX_SAMPLE_ROWS);

  // columnNames: union of all keys across the first 10 elements
  const keySet = new Set<string>();
  for (const row of sampleRows) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const key of Object.keys(row)) {
        keySet.add(key);
      }
    }
  }
  const columnNames = Array.from(keySet);

  const schemaHash = computeSchemaHash(columnNames);
  const inferredTypes = inferTypes(columnNames, sampleRows);

  return { columnNames, rowCount, schemaHash, sampleRows, inferredTypes };
}

// ---------------------------------------------------------------------------
// Main export: scanFile
// ---------------------------------------------------------------------------

/**
 * Scan a CSV or JSON file and return metadata.
 *
 * @param filePath   Absolute path to the file.
 * @param fileFormat 'csv' or 'json'.
 * @returns ScanResult with columnNames, rowCount, schemaHash, sampleRows,
 *          and inferredTypes.
 */
export async function scanFile(
  filePath: string,
  fileFormat: string
): Promise<ScanResult> {
  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (fileFormat === "csv") {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SYNC_SIZE) {
      return scanCsvStream(filePath);
    }
    return scanCsvSync(filePath);
  }

  if (fileFormat === "json") {
    return scanJson(filePath);
  }

  throw new Error(
    `Unsupported file format: '${fileFormat}'. Supported: csv, json.`
  );
}

/**
 * Synchronous version for backward compatibility with existing code that
 * calls scanFile synchronously. Only works for files ≤ 100 MB.
 */
export function scanFileSync(
  filePath: string,
  fileFormat: string
): ScanResult {
  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (fileFormat === "csv") {
    return scanCsvSync(filePath);
  }

  if (fileFormat === "json") {
    return scanJson(filePath);
  }

  throw new Error(
    `Unsupported file format: '${fileFormat}'. Supported: csv, json.`
  );
}

// ---------------------------------------------------------------------------
// Inline self-tests (run directly: npx tsx src/services/fileScannerService.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const path = await import("path");

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

  console.log("Running file scanner self-tests...\n");

  const tmpDir = "/tmp/scanner-test";
  fs.mkdirSync(tmpDir, { recursive: true });

  // === 1. Scan a normal CSV ===
  console.log("=== 1. Normal CSV (100 rows) ===");
  // Use the seeded taxpayers.csv if it exists, otherwise create test data
  const csvPath = "/tmp/ontology-testdata/taxpayers.csv";
  if (fs.existsSync(csvPath)) {
    const r1 = await scanFile(csvPath, "csv");
    assert(r1.columnNames.length > 0, "Has column names");
    assert(r1.rowCount === 100, `rowCount = ${r1.rowCount} (expected 100)`);
    assert(r1.sampleRows.length === 10, "sampleRows has 10 entries");
    assert(
      Object.keys(r1.inferredTypes).length === r1.columnNames.length,
      "inferredTypes has entry for each column"
    );
    assert(typeof r1.schemaHash === "string" && r1.schemaHash.length === 32, "schemaHash is 32-char MD5");
  } else {
    console.log("  SKIP: taxpayers.csv not found (run seed first)");
  }

  // === 2. Empty CSV (header only) ===
  console.log("\n=== 2. Empty CSV (header only) ===");
  const emptyCsv = path.join(tmpDir, "empty.csv");
  fs.writeFileSync(emptyCsv, "id,name,age\n", "utf-8");
  const r2 = await scanFile(emptyCsv, "csv");
  assert(r2.rowCount === 0, "rowCount = 0");
  assert(r2.sampleRows.length === 0, "sampleRows is empty");
  assert(r2.columnNames.length === 3, "columnNames has 3 entries");
  assert(
    r2.columnNames.includes("id") &&
      r2.columnNames.includes("name") &&
      r2.columnNames.includes("age"),
    "columnNames are id, name, age"
  );

  // === 3. JSON array ===
  console.log("\n=== 3. JSON array ===");
  const jsonPath = path.join(tmpDir, "data.json");
  const jsonData = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
    active: i % 2 === 0,
    price: (i + 1) * 9.99,
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData), "utf-8");
  const r3 = await scanFile(jsonPath, "json");
  assert(r3.rowCount === 25, "JSON rowCount = 25");
  assert(r3.sampleRows.length === 10, "JSON sampleRows has 10");
  assert(r3.columnNames.includes("id"), "JSON has id column");
  assert(r3.columnNames.includes("name"), "JSON has name column");
  assert(r3.columnNames.includes("active"), "JSON has active column");
  assert(r3.columnNames.includes("price"), "JSON has price column");

  // === 4. JSON non-array → throws ===
  console.log("\n=== 4. JSON non-array ===");
  const jsonObj = path.join(tmpDir, "obj.json");
  fs.writeFileSync(jsonObj, '{"key": "value"}', "utf-8");
  try {
    await scanFile(jsonObj, "json");
    assert(false, "Should have thrown");
  } catch (err: any) {
    assert(
      err.message.includes("top-level array"),
      "Error mentions top-level array"
    );
  }

  // === 5. File not found ===
  console.log("\n=== 5. File not found ===");
  try {
    await scanFile("/nonexistent/file.csv", "csv");
    assert(false, "Should have thrown");
  } catch (err: any) {
    assert(
      err.message.includes("File not found"),
      "Error mentions file not found"
    );
  }

  // === 6. Schema hash deterministic ===
  console.log("\n=== 6. Schema hash deterministic ===");
  const csvTest = path.join(tmpDir, "hash_test.csv");
  fs.writeFileSync(csvTest, "a,b,c\n1,2,3\n4,5,6\n", "utf-8");
  const h1 = await scanFile(csvTest, "csv");
  const h2 = await scanFile(csvTest, "csv");
  assert(h1.schemaHash === h2.schemaHash, "Same file → same hash");

  // === 7. Schema hash changes when column added ===
  console.log("\n=== 7. Schema hash changes ===");
  fs.writeFileSync(csvTest, "a,b,c,d\n1,2,3,4\n5,6,7,8\n", "utf-8");
  const h3 = await scanFile(csvTest, "csv");
  assert(h3.schemaHash !== h1.schemaHash, "Different columns → different hash");

  // === 8. Type inference ===
  console.log("\n=== 8. Type inference ===");
  const inferCsv = path.join(tmpDir, "infer.csv");
  fs.writeFileSync(
    inferCsv,
    "int_col,dbl_col,date_col,bool_col,str_col\n" +
      "42,3.14,2025-01-15,true,hello\n" +
      "7,2.71,2025-06-30,false,world\n",
    "utf-8"
  );
  const r8 = await scanFile(inferCsv, "csv");
  assert(r8.inferredTypes.int_col === "integer", "int_col → integer");
  assert(r8.inferredTypes.dbl_col === "double", "dbl_col → double");
  assert(r8.inferredTypes.date_col === "date", "date_col → date");
  assert(r8.inferredTypes.bool_col === "boolean", "bool_col → boolean");
  assert(r8.inferredTypes.str_col === "string", "str_col → string");

  // === 9. UTF-8 BOM handling ===
  console.log("\n=== 9. UTF-8 BOM ===");
  const bomCsv = path.join(tmpDir, "bom.csv");
  fs.writeFileSync(bomCsv, "\uFEFFid,name\n1,Alice\n", "utf-8");
  const r9 = await scanFile(bomCsv, "csv");
  assert(r9.columnNames[0] === "id", "BOM stripped — first col is 'id'");
  assert(r9.rowCount === 1, "BOM CSV rowCount = 1");

  // === 10. Unsupported format ===
  console.log("\n=== 10. Unsupported format ===");
  try {
    await scanFile(csvTest, "xml");
    assert(false, "Should have thrown");
  } catch (err: any) {
    assert(
      err.message.includes("Unsupported file format"),
      "Error mentions unsupported format"
    );
  }

  // === 11. Sync version ===
  console.log("\n=== 11. Sync scanFileSync ===");
  const r11 = scanFileSync(inferCsv, "csv");
  assert(r11.rowCount === 2, "Sync scan rowCount = 2");
  assert(r11.inferredTypes.int_col === "integer", "Sync infers integer");

  // === 12. JSON with heterogeneous keys ===
  console.log("\n=== 12. JSON heterogeneous keys ===");
  const hetJson = path.join(tmpDir, "het.json");
  fs.writeFileSync(
    hetJson,
    JSON.stringify([
      { a: 1, b: 2 },
      { b: 3, c: 4 },
      { a: 5, c: 6, d: 7 },
    ]),
    "utf-8"
  );
  const r12 = await scanFile(hetJson, "json");
  assert(r12.columnNames.length === 4, "Union of keys: 4 columns");
  assert(
    ["a", "b", "c", "d"].every((k) => r12.columnNames.includes(k)),
    "All keys a,b,c,d present"
  );

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll file scanner tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests().catch((err) => {
    console.error(err);
    /* v8 ignore next */
    process.exit(1);
  });
}
/* v8 ignore stop */
