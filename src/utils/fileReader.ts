// ---------------------------------------------------------------------------
// File Reader Utility
//
// General-purpose file reading utility that supports CSV and JSON formats
// with robust handling of edge cases common in Rwandan/East African data:
//   - UTF-8 BOM stripping
//   - Auto-detect delimiter (comma, semicolon, tab, pipe)
//   - Null normalization (empty strings, "NULL", "N/A", etc.)
//   - JSON array + JSONL (line-delimited JSON) support
//
// This utility is used by the Saturday batch tasks for file import/export
// operations. It provides a simpler, higher-level API than the indexing
// pipeline's csvReader (which is optimized for streaming large files).
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for read functions. */
export interface ReadOptions {
  /** Override auto-detected delimiter (CSV only). */
  delimiter?: string;
  /** Maximum number of rows to read. null = unlimited. */
  maxRows?: number | null;
  /** Whether to normalize null-like values to null. Default: true. */
  normalizeNulls?: boolean;
  /** Character encoding. Default: 'utf-8'. */
  encoding?: BufferEncoding;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Values treated as null during normalization. */
const NULL_VALUES = new Set([
  "", "null", "NULL", "Null",
  "none", "NONE", "None",
  "n/a", "N/A", "NA", "na",
  "nil", "NIL", "Nil",
  "undefined", "UNDEFINED",
  "-", "--", ".",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip UTF-8 BOM (Byte Order Mark) from the beginning of a string.
 * Many spreadsheet programs (Excel) add a BOM to UTF-8 CSV exports.
 */
function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

/**
 * Normalize a value: if it matches a null-like string, return null.
 * Otherwise return the trimmed value (or the original for non-strings).
 */
function normalizeValue(
  value: any,
  normalizeNulls: boolean
): any {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (normalizeNulls && NULL_VALUES.has(trimmed)) {
      return null;
    }
    return trimmed;
  }

  return value;
}

// ---------------------------------------------------------------------------
// detectDelimiter()
// ---------------------------------------------------------------------------

/**
 * Auto-detect the delimiter used in a CSV header line.
 *
 * Checks for tab, pipe, semicolon, and comma (in that order of priority
 * for unambiguous detection). Falls back to comma.
 *
 * @param headerLine - The first line of the CSV file.
 * @returns The detected delimiter character.
 */
export function detectDelimiter(headerLine: string): string {
  // Count occurrences of candidate delimiters
  const candidates = [
    { char: "\t", count: 0 },
    { char: "|", count: 0 },
    { char: ";", count: 0 },
    { char: ",", count: 0 },
  ];

  // Don't count delimiters inside quoted strings
  let inQuote = false;
  for (const ch of headerLine) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;

    for (const c of candidates) {
      if (ch === c.char) c.count++;
    }
  }

  // Pick the delimiter with the highest count (if any)
  // Priority order: tab > pipe > semicolon > comma
  for (const c of candidates) {
    if (c.count > 0) return c.char;
  }

  // Default to comma
  return ",";
}

// ---------------------------------------------------------------------------
// CSV parsing (simple, synchronous, handles quoted fields)
// ---------------------------------------------------------------------------

/**
 * Detect whether the first row of a CSV looks like data (no header row).
 * Heuristic: if more than 50% of first-row values match the pattern of a
 * plain number (optionally negative, optionally decimal), it's probably
 * data, not headers. Values with currency symbols, commas, or scientific
 * notation are NOT considered numeric for this heuristic.
 */
function looksLikeDataRow(firstLine: string, delimiter: string): boolean {
  const fields = firstLine.split(delimiter).map((f) => f.trim().replace(/^"|"$/g, ""));
  if (fields.length === 0) return false;

  const numericPattern = /^-?\d+(\.\d+)?$/;
  let numericCount = 0;

  for (const field of fields) {
    if (numericPattern.test(field)) {
      numericCount++;
    }
  }

  return numericCount / fields.length > 0.5;
}

/**
 * Parse a CSV string into an array of records.
 * Handles quoted fields, embedded delimiters, and embedded newlines.
 */
function parseCSV(
  content: string,
  delimiter: string
): Record<string, string>[] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuote = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (inQuote) {
      if (ch === '"') {
        // Check for escaped quote ("")
        if (i + 1 < content.length && content[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuote = false;
        i++;
        continue;
      }
      currentField += ch;
      i++;
      continue;
    }

    // Not in quote
    if (ch === '"' && currentField === "") {
      // Start of quoted field
      inQuote = true;
      i++;
      continue;
    }

    if (ch === delimiter) {
      currentRow.push(currentField);
      currentField = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      // Handle \r\n or standalone \r
      currentRow.push(currentField);
      currentField = "";
      rows.push(currentRow);
      currentRow = [];
      if (i + 1 < content.length && content[i + 1] === "\n") {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (ch === "\n") {
      currentRow.push(currentField);
      currentField = "";
      rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }

    currentField += ch;
    i++;
  }

  // Handle last field/row
  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  // Filter out empty rows
  const nonEmptyRows = rows.filter(
    (row) => !(row.length === 1 && row[0].trim() === "")
  );

  if (nonEmptyRows.length === 0) return [];

  // First row is headers
  const headers = nonEmptyRows[0].map((h) => h.trim());
  const records: Record<string, string>[] = [];

  for (let r = 1; r < nonEmptyRows.length; r++) {
    const row = nonEmptyRows[r];
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = c < row.length ? row[c] : "";
    }
    records.push(record);
  }

  return records;
}

// ---------------------------------------------------------------------------
// readCsvFile()
// ---------------------------------------------------------------------------

/**
 * Read a CSV file and return an array of record objects.
 *
 * Features:
 *   - BOM stripping
 *   - Auto-detect delimiter (unless overridden)
 *   - Null normalization
 *   - maxRows limit
 *
 * @param filePath - Path to the CSV file.
 * @param options  - Optional read options.
 * @returns Array of records (objects keyed by column name).
 */
export async function readCsvFile(
  filePath: string,
  options?: ReadOptions
): Promise<Record<string, string>[]> {
  const encoding = options?.encoding ?? "utf-8";
  const normalizeNulls = options?.normalizeNulls !== false;
  const maxRows = options?.maxRows ?? null;

  // Read file
  let content = fs.readFileSync(filePath, encoding);

  // Strip BOM
  content = stripBOM(content);

  // Detect or use provided delimiter
  const firstLine = content.split(/\r?\n/)[0] || "";
  const delimiter = options?.delimiter ?? detectDelimiter(firstLine);

  // Check for no-header-row (all numeric first row)
  if (firstLine.trim().length > 0 && looksLikeDataRow(firstLine, delimiter)) {
    throw new Error(
      "CSV file appears to have no header row. The first row must contain column names."
    );
  }

  // Parse
  let records = parseCSV(content, delimiter);

  // Apply maxRows
  if (maxRows !== null && maxRows >= 0) {
    records = records.slice(0, maxRows);
  }

  // Normalize values
  if (normalizeNulls) {
    records = records.map((row) => {
      const normalized: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeValue(value, true);
      }
      return normalized;
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// readJsonFile()
// ---------------------------------------------------------------------------

/**
 * Read a JSON file and return an array of record objects.
 *
 * Supports two formats:
 *   - JSON array: [{ ... }, { ... }, ...]
 *   - JSONL (line-delimited JSON): each line is a separate JSON object
 *
 * @param filePath - Path to the JSON file.
 * @param options  - Optional read options.
 * @returns Array of records.
 */
export async function readJsonFile(
  filePath: string,
  options?: ReadOptions
): Promise<Record<string, any>[]> {
  const encoding = options?.encoding ?? "utf-8";
  const normalizeNulls = options?.normalizeNulls !== false;
  const maxRows = options?.maxRows ?? null;

  // Read file
  let content = fs.readFileSync(filePath, encoding);

  // Strip BOM
  content = stripBOM(content);
  content = content.trim();

  let records: Record<string, any>[];

  if (content.startsWith("[")) {
    // JSON array format
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array, got ${typeof parsed}`);
    }
    records = parsed;
  } else if (content.startsWith("{")) {
    // JSONL format: each line is a JSON object
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
    records = lines.map((line, idx) => {
      try {
        const obj = JSON.parse(line);
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
          throw new Error(`Line ${idx + 1}: expected JSON object`);
        }
        return obj;
      } catch (err) {
        throw new Error(
          `Failed to parse JSONL line ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  } else {
    throw new Error(
      "JSON file must start with '[' (array) or '{' (JSONL). " +
        `Got: '${content.substring(0, 20)}...'`
    );
  }

  // Apply maxRows
  if (maxRows !== null && maxRows >= 0) {
    records = records.slice(0, maxRows);
  }

  // Normalize values
  if (normalizeNulls) {
    records = records.map((row) => {
      const normalized: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeValue(value, true);
      }
      return normalized;
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// readFile()
// ---------------------------------------------------------------------------

/**
 * Read a file in the specified format and return an array of records.
 * Dispatches to readCsvFile() or readJsonFile() based on the format.
 *
 * @param filePath - Path to the file.
 * @param format   - File format: 'csv', 'json', or 'jsonl'.
 * @param options  - Optional read options.
 * @returns Array of records.
 */
export async function readFile(
  filePath: string,
  format: string,
  options?: ReadOptions
): Promise<Record<string, any>[]> {
  const fmt = format.toLowerCase().trim();

  switch (fmt) {
    case "csv":
    case "tsv":
      if (fmt === "tsv" && !options?.delimiter) {
        return readCsvFile(filePath, { ...options, delimiter: "\t" });
      }
      return readCsvFile(filePath, options);

    case "json":
    case "jsonl":
      return readJsonFile(filePath, options);

    default:
      throw new Error(
        `Unsupported file format: '${format}'. Supported: csv, tsv, json, jsonl.`
      );
  }
}

// ---------------------------------------------------------------------------
// countFileRows()
// ---------------------------------------------------------------------------

/**
 * Count the number of data rows in a file without loading all data into memory.
 * For CSV, counts non-empty lines minus the header. For JSON arrays, parses and
 * counts elements. For JSONL, counts non-empty lines.
 *
 * @param filePath - Path to the file.
 * @param format   - File format: 'csv', 'json', or 'jsonl'.
 * @returns The number of data rows.
 */
export async function countFileRows(
  filePath: string,
  format: string
): Promise<number> {
  const fmt = format.toLowerCase().trim();
  const content = stripBOM(fs.readFileSync(filePath, "utf-8"));

  switch (fmt) {
    case "csv":
    case "tsv": {
      const lines = content.split(/\r?\n/);
      // Filter non-empty lines, subtract 1 for header
      const nonEmpty = lines.filter((l) => l.trim() !== "");
      return Math.max(0, nonEmpty.length - 1);
    }

    case "json": {
      const trimmed = content.trim();
      if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return 0;
        return parsed.length;
      }
      // JSONL
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
      return lines.length;
    }

    case "jsonl": {
      const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
      return lines.length;
    }

    default:
      throw new Error(
        `Unsupported file format: '${format}'. Supported: csv, tsv, json, jsonl.`
      );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { readCsvFile, readJsonFile, readFile, detectDelimiter, countFileRows };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/utils/fileReader.ts)
// ---------------------------------------------------------------------------

async function runSelfTests(): Promise<void> {
  const os = await import("os");

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

  console.log("Running fileReader self-tests...\n");

  // -----------------------------------------------------------------------
  // Create temp directory with test files
  // -----------------------------------------------------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filereader-test-"));

  // =====================================================================
  // detectDelimiter tests
  // =====================================================================
  console.log("--- detectDelimiter ---");

  assert(detectDelimiter("a,b,c") === ",", "detect: comma");
  assert(detectDelimiter("a;b;c") === ";", "detect: semicolon");
  assert(detectDelimiter("a\tb\tc") === "\t", "detect: tab");
  assert(detectDelimiter("a|b|c") === "|", "detect: pipe");
  assert(detectDelimiter("abcdef") === ",", "detect: no delimiter → comma default");
  assert(detectDelimiter('"a,b",c,d') === ",", "detect: comma with quotes");
  // Tab takes priority over others
  assert(detectDelimiter("a\tb,c;d|e") === "\t", "detect: tab priority");

  // =====================================================================
  // readCsvFile tests
  // =====================================================================
  console.log("\n--- readCsvFile ---");

  // --- Standard CSV ---
  const csvPath = path.join(tmpDir, "standard.csv");
  fs.writeFileSync(csvPath, "id,name,age\n1,Alice,30\n2,Bob,25\n3,Charlie,35\n", "utf-8");

  {
    const rows = await readCsvFile(csvPath);
    assert(rows.length === 3, "csv: 3 rows");
    assert(rows[0].id === "1", "csv: first id");
    assert(rows[0].name === "Alice", "csv: first name");
    assert(rows[0].age === "30", "csv: first age");
    assert(rows[2].name === "Charlie", "csv: last name");
  }

  // --- BOM CSV ---
  const bomPath = path.join(tmpDir, "bom.csv");
  fs.writeFileSync(bomPath, "\uFEFFid,name\n1,Alice\n2,Bob\n", "utf-8");

  {
    const rows = await readCsvFile(bomPath);
    assert(rows.length === 2, "bom: 2 rows");
    assert(rows[0].id === "1", `bom: first id is '1' (got '${rows[0].id}')`);
  }

  // --- Semicolon delimiter ---
  const semiPath = path.join(tmpDir, "semi.csv");
  fs.writeFileSync(semiPath, "a;b;c\n1;2;3\n4;5;6\n", "utf-8");

  {
    const rows = await readCsvFile(semiPath);
    assert(rows.length === 2, "semi: 2 rows");
    assert(rows[0].a === "1", "semi: first a");
    assert(rows[0].c === "3", "semi: first c");
  }

  // --- Tab delimiter ---
  const tsvPath = path.join(tmpDir, "data.tsv");
  fs.writeFileSync(tsvPath, "x\ty\tz\n10\t20\t30\n40\t50\t60\n", "utf-8");

  {
    const rows = await readCsvFile(tsvPath);
    assert(rows.length === 2, "tsv: 2 rows");
    assert(rows[0].x === "10", "tsv: first x");
  }

  // --- Null normalization ---
  const nullPath = path.join(tmpDir, "nulls.csv");
  fs.writeFileSync(
    nullPath,
    "a,b,c,d,e,f\nvalue,NULL,N/A,,none,-\n",
    "utf-8"
  );

  {
    const rows = await readCsvFile(nullPath);
    assert(rows.length === 1, "nulls: 1 row");
    assert(rows[0].a === "value", "nulls: non-null preserved");
    assert(rows[0].b === null, "nulls: NULL → null");
    assert(rows[0].c === null, "nulls: N/A → null");
    assert(rows[0].d === null, "nulls: empty → null");
    assert(rows[0].e === null, "nulls: none → null");
    assert(rows[0].f === null, "nulls: '-' → null");
  }

  // --- Null normalization disabled ---
  {
    const rows = await readCsvFile(nullPath, { normalizeNulls: false });
    assert(rows[0].b === "NULL", "no-normalize: NULL preserved");
    assert(rows[0].d === "", "no-normalize: empty preserved");
  }

  // --- maxRows ---
  {
    const rows = await readCsvFile(csvPath, { maxRows: 1 });
    assert(rows.length === 1, "maxRows: 1 row");
    assert(rows[0].name === "Alice", "maxRows: first row");
  }

  // --- Quoted fields with commas ---
  const quotedPath = path.join(tmpDir, "quoted.csv");
  fs.writeFileSync(quotedPath, 'id,name,desc\n1,"Smith, John","A ""quoted"" value"\n', "utf-8");

  {
    const rows = await readCsvFile(quotedPath);
    assert(rows.length === 1, "quoted: 1 row");
    assert(rows[0].name === "Smith, John", "quoted: comma in field");
    assert(rows[0].desc === 'A "quoted" value', "quoted: escaped quotes");
  }

  // --- Explicit delimiter override ---
  {
    const rows = await readCsvFile(semiPath, { delimiter: ";" });
    assert(rows.length === 2, "explicit delim: 2 rows");
    assert(rows[0].a === "1", "explicit delim: correct parse");
  }

  // =====================================================================
  // readJsonFile tests
  // =====================================================================
  console.log("\n--- readJsonFile ---");

  // --- JSON array ---
  const jsonPath = path.join(tmpDir, "data.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify([
      { id: 1, name: "Alice", status: null },
      { id: 2, name: "Bob", status: "N/A" },
      { id: 3, name: "Charlie", status: "active" },
    ]),
    "utf-8"
  );

  {
    const rows = await readJsonFile(jsonPath);
    assert(rows.length === 3, "json array: 3 rows");
    assert(rows[0].id === 1, "json array: first id");
    assert(rows[0].status === null, "json array: null preserved");
    assert(rows[1].status === null, "json array: N/A → null");
    assert(rows[2].status === "active", "json array: active preserved");
  }

  // --- JSONL ---
  const jsonlPath = path.join(tmpDir, "data.jsonl");
  fs.writeFileSync(
    jsonlPath,
    '{"id":1,"name":"Alice"}\n{"id":2,"name":"Bob"}\n{"id":3,"name":"Charlie"}\n',
    "utf-8"
  );

  {
    const rows = await readJsonFile(jsonlPath);
    assert(rows.length === 3, "jsonl: 3 rows");
    assert(rows[0].id === 1, "jsonl: first id");
    assert(rows[2].name === "Charlie", "jsonl: last name");
  }

  // --- JSON with BOM ---
  const jsonBomPath = path.join(tmpDir, "bom.json");
  fs.writeFileSync(jsonBomPath, '\uFEFF[{"id":1}]', "utf-8");

  {
    const rows = await readJsonFile(jsonBomPath);
    assert(rows.length === 1, "json bom: 1 row");
    assert(rows[0].id === 1, "json bom: id is 1");
  }

  // --- JSON maxRows ---
  {
    const rows = await readJsonFile(jsonPath, { maxRows: 1 });
    assert(rows.length === 1, "json maxRows: 1 row");
  }

  // --- JSON non-array throws ---
  const jsonObjPath = path.join(tmpDir, "obj.json");
  fs.writeFileSync(jsonObjPath, '{"key":"value"}', "utf-8");

  // JSONL format: single object is valid JSONL
  {
    const rows = await readJsonFile(jsonObjPath);
    assert(rows.length === 1, "jsonl single: 1 row");
  }

  // --- Invalid JSON throws ---
  const invalidJsonPath = path.join(tmpDir, "invalid.json");
  fs.writeFileSync(invalidJsonPath, "not json at all!", "utf-8");

  {
    let threw = false;
    try {
      await readJsonFile(invalidJsonPath);
    } catch {
      threw = true;
    }
    assert(threw, "invalid json: throws");
  }

  // --- No-header-row detection ---
  const noHeaderPath = path.join(tmpDir, "noheader.csv");
  fs.writeFileSync(noHeaderPath, "2020,2021,2022\n100,200,300\n400,500,600\n", "utf-8");

  {
    let threw = false;
    try {
      await readCsvFile(noHeaderPath);
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("no header row"),
        "no-header: error message mentions 'no header row'"
      );
    }
    assert(threw, "no-header: throws for all-numeric first row");
  }

  // File with mixed first row (some text, some numbers) should NOT throw
  const mixedHeaderPath = path.join(tmpDir, "mixedheader.csv");
  fs.writeFileSync(mixedHeaderPath, "id,name,2022\n1,Alice,100\n", "utf-8");

  {
    let threw = false;
    try {
      await readCsvFile(mixedHeaderPath);
    } catch {
      threw = true;
    }
    assert(!threw, "mixed-header: does not throw (less than 50% numeric)");
  }

  // =====================================================================
  // readFile tests
  // =====================================================================
  console.log("\n--- readFile ---");

  {
    const rows = await readFile(csvPath, "csv");
    assert(rows.length === 3, "readFile csv: 3 rows");
  }

  {
    const rows = await readFile(jsonPath, "json");
    assert(rows.length === 3, "readFile json: 3 rows");
  }

  {
    const rows = await readFile(tsvPath, "tsv");
    assert(rows.length === 2, "readFile tsv: 2 rows");
  }

  {
    const rows = await readFile(jsonlPath, "jsonl");
    assert(rows.length === 3, "readFile jsonl: 3 rows");
  }

  // Unsupported format
  {
    let threw = false;
    try {
      await readFile(csvPath, "xml");
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("Unsupported"),
        "unsupported: error message"
      );
    }
    assert(threw, "unsupported format: throws");
  }

  // =====================================================================
  // countFileRows tests
  // =====================================================================
  console.log("\n--- countFileRows ---");

  {
    const count = await countFileRows(csvPath, "csv");
    assert(count === 3, `countFileRows csv: 3 (got ${count})`);
  }

  {
    const count = await countFileRows(jsonPath, "json");
    assert(count === 3, `countFileRows json: 3 (got ${count})`);
  }

  {
    const count = await countFileRows(jsonlPath, "jsonl");
    assert(count === 3, `countFileRows jsonl: 3 (got ${count})`);
  }

  {
    const count = await countFileRows(tsvPath, "csv");
    assert(count === 2, `countFileRows tsv-as-csv: 2 (got ${count})`);
  }

  // Empty CSV (header only)
  const emptyCSVPath = path.join(tmpDir, "empty.csv");
  fs.writeFileSync(emptyCSVPath, "a,b,c\n", "utf-8");
  {
    const count = await countFileRows(emptyCSVPath, "csv");
    assert(count === 0, `countFileRows empty csv: 0 (got ${count})`);
  }

  // Unsupported format
  {
    let threw = false;
    try {
      await countFileRows(csvPath, "xml");
    } catch {
      threw = true;
    }
    assert(threw, "countFileRows unsupported: throws");
  }

  // =====================================================================
  // Cleanup
  // =====================================================================
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll fileReader tests passed");
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
