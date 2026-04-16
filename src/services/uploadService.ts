// ---------------------------------------------------------------------------
// Upload Service
//
// Handles file uploads for datasets. Provides multer configuration, file
// format detection, metadata extraction for CSV/JSON/JSONL files, and
// final file placement. Used by the dataset upload route.
// ---------------------------------------------------------------------------

import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parse } from "csv-parse";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum upload size: 500 MB */
const MAX_FILE_SIZE = 500 * 1024 * 1024;

/** Allowed MIME types for upload */
const ALLOWED_MIMES = new Set([
  "text/csv",
  "application/json",
  "application/x-ndjson",
  "application/jsonl",
  "text/plain",
  "application/octet-stream",
]);

/** Maximum sample rows to extract for schema inference */
const MAX_SAMPLE_ROWS = 10;

/** Base directory for dataset storage */
function getDataDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data");
}

/** Upload staging directory */
function getUploadDir(): string {
  return path.join(getDataDir(), "uploads");
}

/** Final dataset storage directory */
function getDatasetDir(): string {
  return path.join(getDataDir(), "datasets");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileMetadata {
  columnNames: string[];
  rowCount: number;
  sampleRows: Record<string, unknown>[];
  inferredTypes: Record<string, string>;
  schemaHash: string;
  fileSizeBytes: number;
}

// ---------------------------------------------------------------------------
// configureMulter
//
// Returns a multer instance configured for dataset uploads. Files are
// stored in the upload staging directory with randomized filenames.
// ---------------------------------------------------------------------------

export function configureMulter(): multer.Multer {
  const uploadDir = getUploadDir();
  fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      // Generate a unique filename: timestamp-random-originalname
      const uniqueId = crypto.randomBytes(8).toString("hex");
      const timestamp = Date.now();
      const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${timestamp}-${uniqueId}-${safeOriginal}`);
    },
  });

  const fileFilter = (
    _req: Express.Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
  ) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      // Check by extension as fallback (some clients send application/octet-stream)
      const ext = path.extname(file.originalname).toLowerCase();
      if ([".csv", ".json", ".jsonl"].includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype} (${ext})`));
      }
    }
  };

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1, // One file per upload
    },
  });
}

// ---------------------------------------------------------------------------
// detectFileFormat
//
// Determines the file format from the original filename extension and
// MIME type. Returns 'csv', 'json', or 'jsonl'.
// ---------------------------------------------------------------------------

export function detectFileFormat(file: Express.Multer.File): string {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";

  // Fallback to MIME type
  if (file.mimetype === "text/csv") return "csv";
  if (file.mimetype === "application/json") return "json";
  if (
    file.mimetype === "application/x-ndjson" ||
    file.mimetype === "application/jsonl"
  )
    return "jsonl";

  // Default: try to detect from content
  return "csv";
}

// ---------------------------------------------------------------------------
// extractCsvMetadata
//
// Reads a CSV file and extracts column names, row count, sample rows,
// inferred types, and a schema hash.
// ---------------------------------------------------------------------------

export async function extractCsvMetadata(
  filePath: string
): Promise<FileMetadata> {
  const stat = fs.statSync(filePath);
  const fileSizeBytes = stat.size;

  return new Promise((resolve, reject) => {
    const sampleRows: Record<string, unknown>[] = [];
    let columnNames: string[] = [];
    let rowCount = 0;

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
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
      // Handle header-only files
      if (rowCount === 0 && columnNames.length === 0) {
        try {
          const content = fs.readFileSync(filePath, "utf-8").trim();
          if (content.length > 0) {
            const headerLine = content.split("\n")[0];
            columnNames = headerLine.split(",").map((c) => c.trim());
          }
        } catch {
          // ignore
        }
      }

      const inferredTypes = inferColumnTypes(columnNames, sampleRows);
      const schemaHash = computeSchemaHash(columnNames);

      resolve({
        columnNames,
        rowCount,
        sampleRows,
        inferredTypes,
        schemaHash,
        fileSizeBytes,
      });
    });

    stream.pipe(parser);
  });
}

// ---------------------------------------------------------------------------
// extractJsonMetadata
//
// Reads a JSON or JSONL file and extracts column names, row count, sample
// rows, inferred types, and a schema hash.
// ---------------------------------------------------------------------------

export async function extractJsonMetadata(
  filePath: string,
  format: "json" | "jsonl"
): Promise<FileMetadata> {
  const stat = fs.statSync(filePath);
  const fileSizeBytes = stat.size;
  const content = fs.readFileSync(filePath, "utf-8");

  let records: Record<string, unknown>[];

  if (format === "jsonl") {
    // JSONL: one JSON object per line
    records = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(
        (r): r is Record<string, unknown> =>
          r !== null && typeof r === "object" && !Array.isArray(r)
      );
  } else {
    // JSON: top-level array
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON file must contain a top-level array.");
    }
    records = parsed.filter(
      (r: unknown): r is Record<string, unknown> =>
        r !== null && typeof r === "object" && !Array.isArray(r)
    );
  }

  const rowCount = records.length;
  const sampleRows = records.slice(0, MAX_SAMPLE_ROWS);

  // Union of all keys across sample rows
  const keySet = new Set<string>();
  for (const row of sampleRows) {
    for (const key of Object.keys(row)) {
      keySet.add(key);
    }
  }
  const columnNames = Array.from(keySet);

  const inferredTypes = inferColumnTypes(columnNames, sampleRows);
  const schemaHash = computeSchemaHash(columnNames);

  return {
    columnNames,
    rowCount,
    sampleRows,
    inferredTypes,
    schemaHash,
    fileSizeBytes,
  };
}

// ---------------------------------------------------------------------------
// moveToFinalLocation
//
// Moves a staged upload file to its final dataset storage location.
// Creates the target directory if needed. Returns the final absolute path.
// ---------------------------------------------------------------------------

export function moveToFinalLocation(
  stagedPath: string,
  datasetId: string,
  originalName: string
): string {
  const datasetDir = getDatasetDir();
  const targetDir = path.join(datasetDir, datasetId);
  fs.mkdirSync(targetDir, { recursive: true });

  const safeOriginal = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const finalPath = path.join(targetDir, safeOriginal);

  // Use rename for atomic move (same filesystem) or copy+delete
  try {
    fs.renameSync(stagedPath, finalPath);
  } catch {
    // Cross-device move: copy then delete
    fs.copyFileSync(stagedPath, finalPath);
    fs.unlinkSync(stagedPath);
  }

  return finalPath;
}

// ---------------------------------------------------------------------------
// Helper: infer column types from sample rows
// ---------------------------------------------------------------------------

function inferColumnTypes(
  columnNames: string[],
  sampleRows: Record<string, unknown>[]
): Record<string, string> {
  const inferredTypes: Record<string, string> = {};

  for (const col of columnNames) {
    const values: string[] = [];
    for (const row of sampleRows) {
      const val = row[col];
      if (val === undefined || val === null) continue;
      const str = String(val).trim();
      if (str === "") continue;
      values.push(str);
    }

    if (values.length === 0) {
      inferredTypes[col] = "string";
      continue;
    }

    if (values.every((v) => /^-?\d+$/.test(v))) {
      inferredTypes[col] = "integer";
      continue;
    }

    if (values.every((v) => /^-?\d+\.?\d*$/.test(v))) {
      inferredTypes[col] = "double";
      continue;
    }

    if (values.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
      inferredTypes[col] = "date";
      continue;
    }

    if (values.every((v) => /^(true|false)$/i.test(v))) {
      inferredTypes[col] = "boolean";
      continue;
    }

    inferredTypes[col] = "string";
  }

  return inferredTypes;
}

// ---------------------------------------------------------------------------
// Helper: compute schema hash from column names
// ---------------------------------------------------------------------------

function computeSchemaHash(columnNames: string[]): string {
  return crypto
    .createHash("md5")
    .update(columnNames.slice().sort().join(","))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Inline self-tests (run directly: npx tsx src/services/uploadService.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
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

  console.log("Running upload service self-tests...\n");

  const tmpDir = "/tmp/upload-service-test";
  fs.mkdirSync(tmpDir, { recursive: true });

  // === 1. configureMulter returns a multer instance ===
  console.log("=== 1. configureMulter ===");
  const upload = configureMulter();
  assert(typeof upload.single === "function", "configureMulter returns multer with .single()");
  assert(typeof upload.array === "function", "configureMulter returns multer with .array()");

  // === 2. detectFileFormat ===
  console.log("\n=== 2. detectFileFormat ===");
  const mockFile = (name: string, mime: string) =>
    ({ originalname: name, mimetype: mime } as Express.Multer.File);

  assert(
    detectFileFormat(mockFile("data.csv", "text/csv")) === "csv",
    "data.csv -> csv"
  );
  assert(
    detectFileFormat(mockFile("data.json", "application/json")) === "json",
    "data.json -> json"
  );
  assert(
    detectFileFormat(mockFile("data.jsonl", "application/x-ndjson")) === "jsonl",
    "data.jsonl -> jsonl"
  );
  assert(
    detectFileFormat(mockFile("data.ndjson", "application/octet-stream")) === "jsonl",
    "data.ndjson -> jsonl"
  );
  assert(
    detectFileFormat(mockFile("unknown.txt", "text/csv")) === "csv",
    "text/csv MIME fallback -> csv"
  );

  // === 3. extractCsvMetadata ===
  console.log("\n=== 3. extractCsvMetadata ===");
  const csvPath = path.join(tmpDir, "test.csv");
  fs.writeFileSync(
    csvPath,
    "id,name,age,active\n1,Alice,30,true\n2,Bob,25,false\n3,Charlie,35,true\n",
    "utf-8"
  );
  const csvMeta = await extractCsvMetadata(csvPath);
  assert(csvMeta.rowCount === 3, `CSV rowCount = ${csvMeta.rowCount} (expected 3)`);
  assert(csvMeta.columnNames.length === 4, "CSV has 4 columns");
  assert(csvMeta.columnNames.includes("id"), "CSV has 'id' column");
  assert(csvMeta.columnNames.includes("name"), "CSV has 'name' column");
  assert(csvMeta.sampleRows.length === 3, "CSV sampleRows has 3 entries");
  assert(csvMeta.inferredTypes.id === "integer", "id is inferred as integer");
  assert(csvMeta.inferredTypes.name === "string", "name is inferred as string");
  assert(csvMeta.inferredTypes.age === "integer", "age is inferred as integer");
  assert(csvMeta.inferredTypes.active === "boolean", "active is inferred as boolean");
  assert(typeof csvMeta.schemaHash === "string" && csvMeta.schemaHash.length === 32, "schemaHash is 32-char MD5");
  assert(csvMeta.fileSizeBytes > 0, "fileSizeBytes > 0");

  // === 4. extractCsvMetadata — empty CSV (header only) ===
  console.log("\n=== 4. extractCsvMetadata (empty) ===");
  const emptyCsvPath = path.join(tmpDir, "empty.csv");
  fs.writeFileSync(emptyCsvPath, "col_a,col_b,col_c\n", "utf-8");
  const emptyMeta = await extractCsvMetadata(emptyCsvPath);
  assert(emptyMeta.rowCount === 0, "Empty CSV rowCount = 0");
  assert(emptyMeta.columnNames.length === 3, "Empty CSV has 3 column names from header");

  // === 5. extractJsonMetadata (JSON array) ===
  console.log("\n=== 5. extractJsonMetadata (JSON) ===");
  const jsonPath = path.join(tmpDir, "test.json");
  const jsonData = [
    { id: 1, name: "Alice", score: 95.5 },
    { id: 2, name: "Bob", score: 88.0 },
    { id: 3, name: "Charlie", score: 72.3 },
  ];
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData), "utf-8");
  const jsonMeta = await extractJsonMetadata(jsonPath, "json");
  assert(jsonMeta.rowCount === 3, `JSON rowCount = ${jsonMeta.rowCount} (expected 3)`);
  assert(jsonMeta.columnNames.includes("id"), "JSON has 'id' column");
  assert(jsonMeta.columnNames.includes("name"), "JSON has 'name' column");
  assert(jsonMeta.columnNames.includes("score"), "JSON has 'score' column");
  assert(jsonMeta.fileSizeBytes > 0, "JSON fileSizeBytes > 0");

  // === 6. extractJsonMetadata (JSONL) ===
  console.log("\n=== 6. extractJsonMetadata (JSONL) ===");
  const jsonlPath = path.join(tmpDir, "test.jsonl");
  fs.writeFileSync(
    jsonlPath,
    '{"id":1,"val":"a"}\n{"id":2,"val":"b"}\n{"id":3,"val":"c"}\n',
    "utf-8"
  );
  const jsonlMeta = await extractJsonMetadata(jsonlPath, "jsonl");
  assert(jsonlMeta.rowCount === 3, `JSONL rowCount = ${jsonlMeta.rowCount} (expected 3)`);
  assert(jsonlMeta.columnNames.includes("id"), "JSONL has 'id' column");
  assert(jsonlMeta.columnNames.includes("val"), "JSONL has 'val' column");

  // === 7. extractJsonMetadata — non-array JSON throws ===
  console.log("\n=== 7. extractJsonMetadata (non-array) ===");
  const nonArrayPath = path.join(tmpDir, "obj.json");
  fs.writeFileSync(nonArrayPath, '{"key":"value"}', "utf-8");
  try {
    await extractJsonMetadata(nonArrayPath, "json");
    assert(false, "Should have thrown for non-array JSON");
  } catch (err: any) {
    assert(
      err.message.includes("top-level array"),
      "Error mentions top-level array"
    );
  }

  // === 8. moveToFinalLocation ===
  console.log("\n=== 8. moveToFinalLocation ===");
  const stageDir = path.join(tmpDir, "staged");
  fs.mkdirSync(stageDir, { recursive: true });
  const stagedFile = path.join(stageDir, "upload.csv");
  fs.writeFileSync(stagedFile, "a,b\n1,2\n", "utf-8");

  // Override DATA_DIR for this test
  const origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;

  const fakeDatasetId = "test-dataset-id-1234";
  const finalPath = moveToFinalLocation(stagedFile, fakeDatasetId, "my data.csv");
  assert(fs.existsSync(finalPath), "Final file exists after move");
  assert(!fs.existsSync(stagedFile), "Staged file removed after move");
  assert(
    finalPath.includes(fakeDatasetId),
    "Final path contains dataset ID"
  );
  assert(finalPath.endsWith("my_data.csv"), "Special chars sanitized in filename");

  // Restore DATA_DIR
  if (origDataDir !== undefined) {
    process.env.DATA_DIR = origDataDir;
  } else {
    delete process.env.DATA_DIR;
  }

  // === 9. Schema hash is deterministic ===
  console.log("\n=== 9. Schema hash deterministic ===");
  const csvPath2 = path.join(tmpDir, "hash.csv");
  fs.writeFileSync(csvPath2, "x,y,z\n1,2,3\n", "utf-8");
  const h1 = await extractCsvMetadata(csvPath2);
  const h2 = await extractCsvMetadata(csvPath2);
  assert(h1.schemaHash === h2.schemaHash, "Same file -> same schemaHash");

  // === 10. Schema hash changes when columns differ ===
  console.log("\n=== 10. Schema hash changes ===");
  fs.writeFileSync(csvPath2, "x,y,z,w\n1,2,3,4\n", "utf-8");
  const h3 = await extractCsvMetadata(csvPath2);
  assert(h3.schemaHash !== h1.schemaHash, "Different columns -> different schemaHash");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll upload service tests passed");
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
