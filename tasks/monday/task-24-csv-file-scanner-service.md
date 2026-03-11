# TASK 24 OF 30: File Scanner Service (CSV and JSON)

**Objective:** Create a service that scans CSV and JSON files to extract metadata: column names, row count, inferred data types, sample rows, and a schema hash. This information is stored in the backing_datasource table and passed to the column mapping validator (Task 23).

**Step-by-step instructions:**

Create src/services/fileScannerService.js.

**Export: scanFile(filePath, fileFormat)**

Parameters:
- `filePath` (string): absolute path to the file
- `fileFormat` (string): `'csv'` or `'json'`

Returns:
```javascript
{
  columnNames: string[],    // column/field names
  rowCount: number,         // total number of data rows (excluding header for CSV)
  schemaHash: string,       // MD5 hash for change detection
  sampleRows: object[],     // first 10 rows as objects keyed by column name
  inferredTypes: object     // {columnName: inferredType}
}
```

**CSV scanning:**

Use the `csv-parse` library (installed in Task 1).

For files ≤ 100MB (`fs.statSync(filePath).size <= 100 * 1024 * 1024`):
1. Read the entire file: `fs.readFileSync(filePath, 'utf-8')`.
2. Strip UTF-8 BOM if present: `if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)`.
3. Parse using `csv-parse/sync` with `{columns: true, skip_empty_lines: true, relax_column_count: true}`.
4. `columnNames`: the keys of the first parsed row (these come from the header).
5. `rowCount`: the length of the parsed array.
6. `sampleRows`: the first 10 elements of the parsed array.

For files > 100MB:
1. Use `csv-parse` in streaming mode with `fs.createReadStream`.
2. Count rows as they stream through.
3. Collect the first 10 rows as sampleRows.
4. Extract columnNames from the first row.
5. Do NOT load the entire file into memory.

**JSON scanning:**

1. Read the file: `fs.readFileSync(filePath, 'utf-8')`.
2. Parse: `JSON.parse(content)`. If the result is not an array, throw an Error: `"JSON file must contain a top-level array."`.
3. `columnNames`: union of all keys across the first 10 elements. Use `new Set()` to collect unique keys.
4. `rowCount`: array length.
5. `sampleRows`: first 10 elements.

Note: For Week 1, JSON files must fit in memory. Streaming JSON parsing is deferred to a future sprint.

**Type inference (both formats):**

For each column in `columnNames`, examine the values in `sampleRows`:
- If all non-empty values match `^-?\d+$` → infer `'integer'`
- If all non-empty values match `^-?\d+\.?\d*$` → infer `'double'`
- If all non-empty values match `^\d{4}-\d{2}-\d{2}$` → infer `'date'`
- If all non-empty values match `^(true|false)$/i` → infer `'boolean'`
- Otherwise → infer `'string'`

Store in `inferredTypes` as `{columnName: inferredType}`.

**Schema hash:**

Compute as MD5 of the sorted column names joined by comma: `md5(columnNames.sort().join(','))`. Use Node.js built-in `crypto.createHash('md5')`. This hash is stored in the backing_datasource table and compared during re-scans (Task 17) to detect schema changes.

**Edge cases:**
- Empty file (header only, no data rows): `rowCount: 0`, `sampleRows: []`, `inferredTypes: {}` (no data to infer from).
- File with inconsistent column counts (some CSV rows have more/fewer columns than the header): the `relax_column_count: true` option handles this. Log a warning: `"Warning: File has inconsistent column counts."`.
- File not found: throw an Error with message `"File not found: {filePath}"`. (The calling code in Task 17 catches this and throws `DATASOURCE_FILE_NOT_FOUND`.)

**Files to create:** src/services/fileScannerService.js

**Verification:**
- Scan a 100-row CSV → `columnNames` matches header, `rowCount: 100`, `sampleRows` has 10 entries, `inferredTypes` has type for each column
- Scan an empty CSV (header only) → `rowCount: 0`, `sampleRows: []`
- Scan a JSON array file → correct `columnNames` (union of keys), `rowCount` matches array length
- Scan non-existent file → throws "File not found: ..."
- Schema hash is deterministic: scanning the same file twice produces the same hash
- Scanning after adding a column produces a different hash
