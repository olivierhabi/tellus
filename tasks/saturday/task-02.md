## TASK 2: Build the File Upload Handler with Multer

### Context
Before datasets can be created, users need to upload files to the system. In Palantir Foundry, data enters through Data Connection connectors that sync from source systems. For our week-1 implementation, the primary data ingestion method is file upload via HTTP multipart form data. This task builds the file upload infrastructure that stores files on disk and returns metadata about the uploaded file.

The upload handler must be robust enough to handle files ranging from a few kilobytes (a small test CSV with 10 rows) to several hundred megabytes (a large dataset with millions of rows). It must validate that the uploaded file is in a supported format, store it in a deterministic location on disk, and extract basic metadata (file size, row count for CSV files, column headers).

### Exact Specification

Create a new file at `/src/services/uploadService.js` that exports the following functions:

**Function 1: `configureMulter()`**

This function returns a configured Multer instance that:
- Stores files in `/data/datasets/uploads/` as a temporary staging area
- Uses a UUID-based filename to prevent collisions: `{uuid}-{originalname}`
- Limits file size to 500MB (this is a reasonable week-1 limit; Palantir supports much larger files via chunked upload, but that's a later feature)
- Accepts only files with these MIME types: `text/csv`, `application/json`, `text/plain`, `application/octet-stream` (some systems send CSV as octet-stream)
- Accepts only files with these extensions: `.csv`, `.json`, `.jsonl`
- Rejects all other file types with a clear error message: `"Unsupported file format. Supported formats: CSV (.csv), JSON (.json), JSON Lines (.jsonl)"`

The Multer configuration must use disk storage (not memory storage) because files can be large. The destination directory must be created automatically if it does not exist. Use `fs.mkdirSync(path, { recursive: true })` at module initialization time to ensure the directory exists.

```javascript
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, '../../data/datasets/uploads');

// Ensure directory exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});

// ... file filter, limits, etc.
```

**Function 2: `detectFileFormat(filePath, originalName)`**

This function examines the uploaded file and determines its format. It must:
1. Check the file extension first (`.csv`, `.json`, `.jsonl`)
2. If the extension is ambiguous or missing, peek at the first 1000 bytes of the file content to determine format:
   - If the first non-whitespace character is `[` or `{`, it's JSON
   - If the file contains comma-separated values with a header row, it's CSV
3. Return one of: `'csv'`, `'json'`, `'jsonl'`
4. Throw an error with message `"Unable to detect file format"` if the format cannot be determined

**Function 3: `extractCsvMetadata(filePath)`**

This function reads a CSV file and extracts metadata without loading the entire file into memory. It must:
1. Read only the first 100 rows of the file using a streaming CSV parser (the `csv-parse` package)
2. Extract the column headers from the first row
3. For each column, analyze the first 100 values to detect the data type:
   - If all non-null values match `/^\d{4}-\d{2}-\d{2}$/` → `"date"`
   - If all non-null values match `/^\d{4}-\d{2}-\d{2}T/` → `"timestamp"`
   - If all non-null values are `"true"` or `"false"` (case-insensitive) → `"boolean"`
   - If all non-null values match `/^-?\d+$/ ` → `"integer"` (try integer first)
   - If all non-null values match `/^-?\d+\.?\d*$/` → `"number"`
   - Otherwise → `"string"`
4. Count the total number of rows by streaming through the entire file (do not load into memory — use a line counter)
5. Return an object with this shape:
```javascript
{
  columns: [
    { columnName: "emp_id", detectedType: "string", nullable: false, sampleValues: ["EMP-001", "EMP-002", "EMP-003"] },
    { columnName: "full_name", detectedType: "string", nullable: false, sampleValues: ["Alice Smith", "Bob Jones"] },
    { columnName: "salary", detectedType: "number", nullable: true, sampleValues: [120000, 95000, null] },
    { columnName: "start_date", detectedType: "date", nullable: false, sampleValues: ["2020-01-15", "2019-06-01"] },
    { columnName: "is_active", detectedType: "boolean", nullable: false, sampleValues: [true, true, false] }
  ],
  rowCount: 1000,
  fileSizeBytes: 45678
}
```
6. The `sampleValues` array must contain at most 5 sample values from the first 100 rows
7. The `nullable` flag must be `true` if ANY value in the sampled rows is empty, null, or the string "null" (case-insensitive)

**Function 4: `extractJsonMetadata(filePath)`**

Similar to `extractCsvMetadata` but for JSON files. It must:
1. Determine if the file is a JSON array (starts with `[`) or JSON Lines (one JSON object per line)
2. For JSON array: parse the file, extract keys from the first object as column names
3. For JSON Lines: read the first line, parse it, extract keys as column names
4. Apply the same type detection logic as CSV
5. Return the same metadata shape

**Function 5: `moveToFinalLocation(tempFilePath, datasetId, transactionId)`**

After a dataset and transaction are created, the uploaded file must be moved from the temporary upload location to its permanent storage location. The permanent path follows this convention (matching Palantir's dataset storage model):

```
/data/datasets/{datasetId}/transactions/{transactionId}/{originalFilename}
```

This function must:
1. Create the directory structure using `fs.mkdirSync(dir, { recursive: true })`
2. Move the file using `fs.renameSync(tempPath, finalPath)` (atomic on the same filesystem)
3. Return the final file path

### Error Handling
- If the upload directory cannot be created → throw with message `"Failed to create upload directory: {error}"`
- If the file cannot be read → throw with message `"Failed to read uploaded file: {error}"`
- If CSV parsing fails → throw with message `"Failed to parse CSV file: {error}. Ensure the file is valid CSV with a header row."`
- If JSON parsing fails → throw with message `"Failed to parse JSON file: {error}. Ensure the file is valid JSON array or JSON Lines."`

### Validation Criteria
- Uploading a 1MB CSV file succeeds and returns correct metadata
- Uploading a JSON array file succeeds and returns correct metadata
- Uploading a JSON Lines file succeeds and returns correct metadata
- Uploading a .exe file is rejected with the correct error message
- Uploading a file larger than 500MB is rejected
- Type detection correctly identifies: strings, integers, numbers (floats), booleans, dates, timestamps
- Nullable detection works: a column with some empty cells is marked nullable=true
- Row count is accurate for files with 1, 100, 1000, and 10000 rows
- `detectFileFormat` correctly identifies: a `.csv` file as `'csv'`; a file with no extension whose first non-whitespace character is `{` as `'json'`; an unsupported extension with non-deterministic content throws `"Unable to detect file format"`
- After `moveToFinalLocation`, the file exists at `/data/datasets/{datasetId}/transactions/{transactionId}/{filename}` and the original temp file no longer exists
