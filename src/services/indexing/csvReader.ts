// ---------------------------------------------------------------------------
// CSV File Reader and Parser
//
// Reads and parses CSV files that serve as backing datasources for object
// types. In Palantir's architecture, datasets are the backing datasources
// for object types (versioned Parquet files). For our implementation we use
// CSV files as the simplest possible dataset format.
//
// All values are returned as raw strings — no type conversion happens here.
// That is the job of the type converter (Task 6).
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { parse as parseStream } from "csv-parse";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for readCSV(). */
export interface ReadCSVOptions {
  delimiter?: string;
  hasHeaders?: boolean;
  encoding?: BufferEncoding;
  skipEmptyRows?: boolean;
  maxRows?: number | null;
  quoteChar?: string;
}

/** A single parsed row, keyed by column name. All values are strings. */
export type CSVRow = Record<string, string>;

/** Successful readCSV() result. */
export interface ReadCSVSuccess {
  success: true;
  filePath: string;
  columns: string[];
  rowCount: number;
  rows: CSVRow[];
  parseWarnings: string[];
  parseDurationMs: number;
  preview?: boolean;
}

/** Error result for any CSV function. */
export interface ReadCSVError {
  success: false;
  error: {
    code: "FILE_NOT_FOUND" | "FILE_EMPTY" | "FILE_READ_ERROR" | "CSV_PARSE_ERROR";
    message: string;
    filePath: string;
  };
}

export type ReadCSVResult = ReadCSVSuccess | ReadCSVError;

/** Result of getCSVSchema(). */
export interface CSVSchemaResult {
  columns: string[];
  filePath: string;
}

/** Error result for getCSVSchema(). */
export type CSVSchemaResponse =
  | CSVSchemaResult
  | ReadCSVError;

/** Result of countCSVRows(). */
export interface CSVRowCountResult {
  rowCount: number;
  filePath: string;
}

export type CSVRowCountResponse =
  | CSVRowCountResult
  | ReadCSVError;

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULTS: Required<Omit<ReadCSVOptions, "maxRows">> & { maxRows: null } = {
  delimiter: ",",
  hasHeaders: true,
  encoding: "utf-8",
  skipEmptyRows: true,
  maxRows: null,
  quoteChar: '"',
};

// ---------------------------------------------------------------------------
// Helper: validate file access, returning an error result or null if OK
// ---------------------------------------------------------------------------

function validateFile(filePath: string): ReadCSVError | null {
  // Check existence
  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      error: {
        code: "FILE_NOT_FOUND",
        message: `File not found: '${filePath}'`,
        filePath,
      },
    };
  }

  // Check file size
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: "FILE_READ_ERROR",
        message: `Cannot stat file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      },
    };
  }

  if (stat.size === 0) {
    return {
      success: false,
      error: {
        code: "FILE_EMPTY",
        message: `File is empty: '${filePath}'`,
        filePath,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: strip UTF-8 BOM from a buffer's first chunk
// ---------------------------------------------------------------------------

function stripBOM(chunk: string): string {
  if (chunk.charCodeAt(0) === 0xfeff) {
    return chunk.slice(1);
  }
  return chunk;
}

// ---------------------------------------------------------------------------
// Core streaming parser
//
// Shared implementation used by readCSV, getCSVPreview, getCSVSchema,
// and countCSVRows with different modes.
// ---------------------------------------------------------------------------

interface ParseMode {
  /** Whether to collect rows into the result array. */
  collectRows: boolean;
  /** Max data rows to collect/count. null = unlimited. */
  maxRows: number | null;
  /** Stop after reading the header (for getCSVSchema). */
  headerOnly: boolean;
  /** Whether to count but not collect (for countCSVRows). */
  countOnly: boolean;
}

interface ParseInternalResult {
  columns: string[];
  rows: CSVRow[];
  rowCount: number;
  parseWarnings: string[];
  parseDurationMs: number;
}

function parseCSVStream(
  filePath: string,
  options: Required<Omit<ReadCSVOptions, "maxRows">> & { maxRows: number | null },
  mode: ParseMode
): Promise<ParseInternalResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const warnings: string[] = [];
    const rows: CSVRow[] = [];
    let columns: string[] = [];
    let rowCount = 0;
    let headerFieldCount = 0;
    let bomStripped = false;
    let aborted = false;

    // Configure parser — use raw array mode so we can control column
    // alignment ourselves and track field count mismatches.
    const parser = parseStream({
      delimiter: options.delimiter,
      quote: options.quoteChar,
      relax_column_count: true,
      skip_empty_lines: options.skipEmptyRows,
      columns: false, // return arrays, not objects
      trim: false,    // we handle trimming ourselves
    });

    const stream = fs.createReadStream(filePath, {
      encoding: options.encoding,
    });

    // Strip BOM from the very first chunk
    stream.on("data", (chunk: string | Buffer) => {
      if (!bomStripped) {
        bomStripped = true;
        const str = typeof chunk === "string" ? chunk : chunk.toString(options.encoding);
        const stripped = stripBOM(str);
        if (stripped !== str) {
          // Replace the chunk — we need to unpipe, push the fixed chunk,
          // and re-pipe. Simplest approach: just manipulate via the parser.
        }
      }
    });

    // Actually, for reliable BOM stripping, use a transform on the first
    // chunk. Simpler: read and strip BOM inline in the readable handler.
    // Let's use a different approach — wrap the stream.

    // Destroy the previous listeners approach and use a simpler method:
    // We'll handle BOM stripping by intercepting in the parser's record
    // callback. Since BOM only affects the first field of the first row,
    // we'll strip it there.

    let isFirstRecord = true;

    parser.on("readable", () => {
      let record: string[] | null;
      while ((record = parser.read() as string[] | null) !== null) {
        if (aborted) return;

        // Strip BOM from very first field of first record
        if (isFirstRecord) {
          isFirstRecord = false;
          if (record.length > 0 && record[0].charCodeAt(0) === 0xfeff) {
            record[0] = record[0].slice(1);
          }
        }

        // First record is the header if hasHeaders is true
        if (options.hasHeaders && columns.length === 0) {
          columns = record.map((h) => h.trim());
          headerFieldCount = columns.length;

          if (mode.headerOnly) {
            aborted = true;
            stream.destroy();
            resolve({
              columns,
              rows: [],
              rowCount: 0,
              parseWarnings: warnings,
              parseDurationMs: Date.now() - startTime,
            });
            return;
          }
          continue;
        }

        // If no headers, generate column names: column_0, column_1, ...
        if (!options.hasHeaders && columns.length === 0) {
          columns = record.map((_, i) => `column_${i}`);
          headerFieldCount = columns.length;
        }

        // Trim all field values
        const trimmed = record.map((v) => v.trim());

        // Skip empty rows (all fields empty after trim)
        if (options.skipEmptyRows && trimmed.every((v) => v === "")) {
          continue;
        }

        rowCount++;
        const dataLineNumber = rowCount; // 1-based line number for data rows

        // Handle field count mismatches
        let aligned: string[];
        if (trimmed.length > headerFieldCount) {
          warnings.push(
            `Row ${dataLineNumber} has ${trimmed.length} fields but header has ${headerFieldCount} fields. Extra fields ignored.`
          );
          aligned = trimmed.slice(0, headerFieldCount);
        } else if (trimmed.length < headerFieldCount) {
          warnings.push(
            `Row ${dataLineNumber} has ${trimmed.length} fields but header has ${headerFieldCount} fields. Missing fields set to empty string.`
          );
          aligned = [...trimmed];
          while (aligned.length < headerFieldCount) {
            aligned.push("");
          }
        } else {
          aligned = trimmed;
        }

        // Build the row object
        if (mode.collectRows && !mode.countOnly) {
          const row: CSVRow = {};
          for (let i = 0; i < columns.length; i++) {
            row[columns[i]] = aligned[i];
          }
          rows.push(row);
        }

        // Check maxRows limit
        if (mode.maxRows !== null && rowCount >= mode.maxRows) {
          aborted = true;
          stream.destroy();
          resolve({
            columns,
            rows,
            rowCount,
            parseWarnings: warnings,
            parseDurationMs: Date.now() - startTime,
          });
          return;
        }
      }
    });

    parser.on("error", (err: Error) => {
      if (!aborted) {
        reject(err);
      }
    });

    parser.on("end", () => {
      if (!aborted) {
        resolve({
          columns,
          rows,
          rowCount,
          parseWarnings: warnings,
          parseDurationMs: Date.now() - startTime,
        });
      }
    });

    stream.on("error", (err: Error) => {
      if (!aborted) {
        reject(err);
      }
    });

    stream.pipe(parser);
  });
}

// ---------------------------------------------------------------------------
// 1. readCSV()
// ---------------------------------------------------------------------------

/**
 * Read and parse a CSV file into an array of row objects.
 *
 * All values are returned as raw strings — no type conversion.
 * Leading/trailing whitespace is trimmed from all values.
 *
 * @param filePath - Absolute or relative path to the CSV file.
 * @param options  - Optional parsing options.
 * @returns A ReadCSVResult (success with rows, or error).
 */
async function readCSV(
  filePath: string,
  options?: ReadCSVOptions
): Promise<ReadCSVResult> {
  // Validate file
  const fileError = validateFile(filePath);
  if (fileError) return fileError;

  // Merge options with defaults
  const opts = {
    delimiter: options?.delimiter ?? DEFAULTS.delimiter,
    hasHeaders: options?.hasHeaders ?? DEFAULTS.hasHeaders,
    encoding: (options?.encoding ?? DEFAULTS.encoding) as BufferEncoding,
    skipEmptyRows: options?.skipEmptyRows ?? DEFAULTS.skipEmptyRows,
    maxRows: options?.maxRows ?? DEFAULTS.maxRows,
    quoteChar: options?.quoteChar ?? DEFAULTS.quoteChar,
  };

  try {
    const result = await parseCSVStream(filePath, opts, {
      collectRows: true,
      maxRows: opts.maxRows,
      headerOnly: false,
      countOnly: false,
    });

    return {
      success: true,
      filePath,
      columns: result.columns,
      rowCount: result.rowCount,
      rows: result.rows,
      parseWarnings: result.parseWarnings,
      parseDurationMs: result.parseDurationMs,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: "CSV_PARSE_ERROR",
        message: `Failed to parse CSV file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 2. getCSVPreview()
// ---------------------------------------------------------------------------

/**
 * Read only the first N rows of a CSV file for preview purposes.
 *
 * @param filePath - Path to the CSV file.
 * @param rowCount - Number of data rows to read (default: 5).
 * @returns A ReadCSVResult with `preview: true`.
 */
async function getCSVPreview(
  filePath: string,
  rowCount: number = 5
): Promise<ReadCSVResult> {
  const result = await readCSV(filePath, { maxRows: rowCount });
  if (result.success) {
    result.preview = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3. getCSVSchema()
// ---------------------------------------------------------------------------

/**
 * Read only the header row and return column names without reading data.
 *
 * @param filePath - Path to the CSV file.
 * @returns Column names and file path, or an error.
 */
async function getCSVSchema(
  filePath: string
): Promise<CSVSchemaResponse> {
  // Validate file
  const fileError = validateFile(filePath);
  if (fileError) return fileError;

  const opts = {
    delimiter: DEFAULTS.delimiter,
    hasHeaders: DEFAULTS.hasHeaders,
    encoding: DEFAULTS.encoding as BufferEncoding,
    skipEmptyRows: DEFAULTS.skipEmptyRows,
    maxRows: DEFAULTS.maxRows,
    quoteChar: DEFAULTS.quoteChar,
  };

  try {
    const result = await parseCSVStream(filePath, opts, {
      collectRows: false,
      maxRows: null,
      headerOnly: true,
      countOnly: false,
    });

    return {
      columns: result.columns,
      filePath,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: "CSV_PARSE_ERROR",
        message: `Failed to read CSV header from '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 4. countCSVRows()
// ---------------------------------------------------------------------------

/**
 * Count the total number of data rows in a CSV file without loading them
 * into memory. Uses the streaming CSV parser to correctly handle quoted
 * fields with embedded newlines.
 *
 * @param filePath - Path to the CSV file.
 * @returns Row count and file path, or an error.
 */
async function countCSVRows(
  filePath: string
): Promise<CSVRowCountResponse> {
  // Validate file
  const fileError = validateFile(filePath);
  if (fileError) return fileError;

  const opts = {
    delimiter: DEFAULTS.delimiter,
    hasHeaders: DEFAULTS.hasHeaders,
    encoding: DEFAULTS.encoding as BufferEncoding,
    skipEmptyRows: DEFAULTS.skipEmptyRows,
    maxRows: DEFAULTS.maxRows,
    quoteChar: DEFAULTS.quoteChar,
  };

  try {
    const result = await parseCSVStream(filePath, opts, {
      collectRows: false,
      maxRows: null,
      headerOnly: false,
      countOnly: true,
    });

    return {
      rowCount: result.rowCount,
      filePath,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: "CSV_PARSE_ERROR",
        message: `Failed to count rows in CSV file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { readCSV, getCSVPreview, getCSVSchema, countCSVRows };
export default { readCSV, getCSVPreview, getCSVSchema, countCSVRows };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/csvReader.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  const path = await import("path");
  const os = await import("os");

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

  console.log("Running csvReader self-tests...\n");

  // -----------------------------------------------------------------------
  // Create a temp directory with test CSV files
  // -----------------------------------------------------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csvreader-test-"));

  // --- Test file 1: standard CSV ---
  const standardCSV = `emp_id,name,department,salary,start_date,is_active,skills
EMP-001,Melissa Chang,Engineering,145000,2020-03-15,true,"python,java,sql"
EMP-002,Jean-Pierre Habimana,Finance,125000,2019-07-01,true,"excel,sap"
EMP-003,Aiko Tanaka,Engineering,155000,2018-01-10,false,"rust,go"
`;
  const standardPath = path.join(tmpDir, "standard.csv");
  fs.writeFileSync(standardPath, standardCSV, "utf-8");

  // --- Test file 2: edge cases ---
  // Includes: fields with commas in quotes, fields with newlines in quotes,
  // empty fields, fields with only whitespace, row with too many fields,
  // row with too few fields
  const edgeCaseCSV = `id,name,description,value
1,"Smith, John","A description with a comma",100
2,"Jane Doe","A description with
a newline inside",200
3,,  ,300
4,  whitespace  ,"  spaces  ",400
5,extra,fields,500,EXTRA1,EXTRA2
6,fewer
7,normal,row,700
`;
  const edgeCasePath = path.join(tmpDir, "edge_cases.csv");
  fs.writeFileSync(edgeCasePath, edgeCaseCSV, "utf-8");

  // --- Test file 3: empty file ---
  const emptyPath = path.join(tmpDir, "empty.csv");
  fs.writeFileSync(emptyPath, "", "utf-8");

  // --- Test file 4: header only, no data rows ---
  const headerOnlyPath = path.join(tmpDir, "header_only.csv");
  fs.writeFileSync(headerOnlyPath, "col_a,col_b,col_c\n", "utf-8");

  // --- Test file 5: BOM-prefixed CSV ---
  const bomPath = path.join(tmpDir, "bom.csv");
  fs.writeFileSync(bomPath, "\uFEFFid,name\n1,Alice\n2,Bob\n", "utf-8");

  // --- Test file 6: semicolon delimiter ---
  const semiPath = path.join(tmpDir, "semi.csv");
  fs.writeFileSync(semiPath, "a;b;c\n1;2;3\n4;5;6\n", "utf-8");

  // --- Test file 7: all-whitespace rows ---
  const wsPath = path.join(tmpDir, "whitespace_rows.csv");
  fs.writeFileSync(wsPath, "x,y\n  ,  \n1,2\n   ,   \n3,4\n", "utf-8");

  // =====================================================================
  // Test: readCSV standard file
  // =====================================================================
  const r1 = await readCSV(standardPath);
  assert(r1.success === true, "standard CSV: success");
  if (r1.success) {
    assert(r1.columns.length === 7, "standard CSV: 7 columns");
    assert(r1.columns[0] === "emp_id", "standard CSV: first column is emp_id");
    assert(r1.rowCount === 3, "standard CSV: 3 rows");
    assert(r1.rows.length === 3, "standard CSV: rows array has 3 elements");
    assert(r1.rows[0].emp_id === "EMP-001", "standard CSV: first row emp_id");
    assert(r1.rows[0].name === "Melissa Chang", "standard CSV: first row name");
    // Quoted field with commas
    assert(r1.rows[0].skills === "python,java,sql", "standard CSV: quoted commas preserved");
    assert(r1.parseWarnings.length === 0, "standard CSV: no warnings");
    assert(typeof r1.parseDurationMs === "number", "standard CSV: parseDurationMs is number");
    // All values are strings
    assert(typeof r1.rows[0].salary === "string", "standard CSV: salary is string (not number)");
    assert(r1.rows[0].salary === "145000", "standard CSV: salary value is '145000'");
  }

  // =====================================================================
  // Test: readCSV edge cases
  // =====================================================================
  const r2 = await readCSV(edgeCasePath);
  assert(r2.success === true, "edge cases: success");
  if (r2.success) {
    assert(r2.columns.length === 4, "edge cases: 4 columns");

    // Row 1: quoted field with comma
    assert(r2.rows[0].name === "Smith, John", "edge: row 1 has comma in name");

    // Row 2: quoted field with embedded newline
    assert(
      r2.rows[1].description === "A description with\na newline inside",
      "edge: row 2 has newline in description"
    );

    // Row 3: empty fields and whitespace-only field
    assert(r2.rows[2].name === "", "edge: row 3 empty name");
    assert(r2.rows[2].description === "", "edge: row 3 whitespace-only description trimmed to empty");

    // Row 4: fields with leading/trailing whitespace trimmed
    assert(r2.rows[3].name === "whitespace", "edge: row 4 whitespace trimmed");
    assert(r2.rows[3].description === "spaces", "edge: row 4 quoted whitespace trimmed");

    // Row 5: too many fields — should be truncated, with warning
    assert(r2.rows[4].id === "5", "edge: row 5 id");
    assert(r2.rows[4].value === "500", "edge: row 5 value");
    assert(
      !("EXTRA1" in r2.rows[4]),
      "edge: row 5 extra fields not in row object"
    );

    // Row 6: too few fields — should be padded, with warning
    assert(r2.rows[5].id === "6", "edge: row 6 id");
    assert(r2.rows[5].name === "fewer", "edge: row 6 name");
    assert(r2.rows[5].description === "", "edge: row 6 missing description is empty string");
    assert(r2.rows[5].value === "", "edge: row 6 missing value is empty string");

    // Row 7: normal
    assert(r2.rows[6].name === "normal", "edge: row 7 normal");

    assert(r2.rowCount === 7, `edge cases: 7 rows (got ${r2.rowCount})`);

    // Warnings for too many / too few fields
    const tooManyWarning = r2.parseWarnings.find((w) => w.includes("Row 5"));
    assert(
      tooManyWarning !== undefined && tooManyWarning.includes("Extra fields ignored"),
      "edge: warning for row with too many fields"
    );
    const tooFewWarning = r2.parseWarnings.find((w) => w.includes("Row 6"));
    assert(
      tooFewWarning !== undefined && tooFewWarning.includes("Missing fields set to empty string"),
      "edge: warning for row with too few fields"
    );
  }

  // =====================================================================
  // Test: file not found
  // =====================================================================
  const r3 = await readCSV(path.join(tmpDir, "nonexistent.csv"));
  assert(r3.success === false, "not found: success is false");
  if (!r3.success) {
    assert(r3.error.code === "FILE_NOT_FOUND", "not found: code is FILE_NOT_FOUND");
  }

  // =====================================================================
  // Test: empty file
  // =====================================================================
  const r4 = await readCSV(emptyPath);
  assert(r4.success === false, "empty file: success is false");
  if (!r4.success) {
    assert(r4.error.code === "FILE_EMPTY", "empty file: code is FILE_EMPTY");
  }

  // =====================================================================
  // Test: header only, no data
  // =====================================================================
  const r5 = await readCSV(headerOnlyPath);
  assert(r5.success === true, "header only: success");
  if (r5.success) {
    assert(r5.columns.length === 3, "header only: 3 columns");
    assert(r5.columns[0] === "col_a", "header only: first column");
    assert(r5.rowCount === 0, "header only: 0 rows");
    assert(r5.rows.length === 0, "header only: empty rows array");
  }

  // =====================================================================
  // Test: BOM stripping
  // =====================================================================
  const r6 = await readCSV(bomPath);
  assert(r6.success === true, "BOM: success");
  if (r6.success) {
    assert(r6.columns[0] === "id", `BOM: first column is 'id' (got '${r6.columns[0]}')`);
    assert(r6.rowCount === 2, "BOM: 2 rows");
  }

  // =====================================================================
  // Test: maxRows option
  // =====================================================================
  const r7 = await readCSV(standardPath, { maxRows: 2 });
  assert(r7.success === true, "maxRows: success");
  if (r7.success) {
    assert(r7.rowCount === 2, "maxRows: 2 rows returned");
    assert(r7.rows.length === 2, "maxRows: rows array has 2 elements");
  }

  // =====================================================================
  // Test: custom delimiter (semicolon)
  // =====================================================================
  const r8 = await readCSV(semiPath, { delimiter: ";" });
  assert(r8.success === true, "semicolon: success");
  if (r8.success) {
    assert(r8.columns.length === 3, "semicolon: 3 columns");
    assert(r8.columns[0] === "a", "semicolon: first column is 'a'");
    assert(r8.rowCount === 2, "semicolon: 2 rows");
    assert(r8.rows[0].a === "1", "semicolon: first row a is '1'");
  }

  // =====================================================================
  // Test: skipEmptyRows (whitespace-only rows skipped by default)
  // =====================================================================
  const r9 = await readCSV(wsPath);
  assert(r9.success === true, "whitespace rows: success");
  if (r9.success) {
    assert(r9.rowCount === 2, `whitespace rows: 2 data rows (got ${r9.rowCount})`);
    assert(r9.rows[0].x === "1", "whitespace rows: first data row x is '1'");
  }

  // =====================================================================
  // Test: skipEmptyRows disabled — whitespace rows included
  // =====================================================================
  const r9b = await readCSV(wsPath, { skipEmptyRows: false });
  assert(r9b.success === true, "skipEmptyRows=false: success");
  if (r9b.success) {
    assert(r9b.rowCount === 4, `skipEmptyRows=false: 4 rows (got ${r9b.rowCount})`);
  }

  // =====================================================================
  // Test: getCSVPreview
  // =====================================================================
  const r10 = await getCSVPreview(standardPath, 2);
  assert(r10.success === true, "preview: success");
  if (r10.success) {
    assert(r10.preview === true, "preview: preview flag is true");
    assert(r10.rowCount === 2, "preview: 2 rows");
    assert(r10.columns.length === 7, "preview: 7 columns");
  }

  // =====================================================================
  // Test: getCSVSchema
  // =====================================================================
  const r11 = await getCSVSchema(standardPath);
  if ("columns" in r11 && !("success" in r11)) {
    assert(r11.columns.length === 7, "schema: 7 columns");
    assert(r11.columns[0] === "emp_id", "schema: first column is emp_id");
    assert(r11.filePath === standardPath, "schema: filePath matches");
    passed++;
  } else if ("success" in r11 && (r11 as ReadCSVError).success === false) {
    failed++;
    console.error("  FAIL: getCSVSchema returned error:", (r11 as ReadCSVError).error.message);
  } else {
    passed++;
  }

  // =====================================================================
  // Test: getCSVSchema on non-existent file
  // =====================================================================
  const r11b = await getCSVSchema(path.join(tmpDir, "nope.csv"));
  assert(
    "success" in r11b && r11b.success === false,
    "schema not found: returns error"
  );

  // =====================================================================
  // Test: countCSVRows
  // =====================================================================
  const r12 = await countCSVRows(standardPath);
  if ("rowCount" in r12 && !("success" in r12)) {
    assert(r12.rowCount === 3, `countCSVRows: 3 rows (got ${r12.rowCount})`);
    passed++;
  } else if ("success" in r12 && (r12 as ReadCSVError).success === false) {
    failed++;
    console.error("  FAIL: countCSVRows returned error:", (r12 as ReadCSVError).error.message);
  } else {
    passed++;
  }

  // =====================================================================
  // Test: countCSVRows with embedded newlines
  // =====================================================================
  const r13 = await countCSVRows(edgeCasePath);
  if ("rowCount" in r13 && !("success" in r13)) {
    assert(r13.rowCount === 7, `countCSVRows edge: 7 rows (got ${r13.rowCount})`);
    passed++;
  } else {
    failed++;
    console.error("  FAIL: countCSVRows edge returned error");
  }

  // =====================================================================
  // Test: countCSVRows on non-existent file
  // =====================================================================
  const r14 = await countCSVRows(path.join(tmpDir, "nope.csv"));
  assert(
    "success" in r14 && r14.success === false,
    "countCSVRows not found: returns error"
  );

  // =====================================================================
  // Cleanup temp directory
  // =====================================================================
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll csvReader tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests().catch((err) => {
    console.error("Self-test error:", err);
    /* v8 ignore next */
    process.exit(1);
  });
}
/* v8 ignore stop */
