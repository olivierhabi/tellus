# TASK 5: Create the CSV File Reader and Parser

**File to create:** `/src/services/indexing/csvReader.js`

**Purpose:** This module reads and parses CSV files that serve as backing datasources for object types. In Palantir's architecture, datasets are the backing datasources for object types. A dataset is a versioned collection of files (usually Parquet). For our Week 1 implementation, we use CSV files as the simplest possible dataset format. This module must read a CSV file from the filesystem, parse it into rows, and return the data in a standardized format that the indexer can consume.

**Detailed specification:**

The module must export the following functions:

1. **`readCSV(filePath, options)`** — Reads and parses a CSV file.

   **Parameters:**
   - `filePath` (string): The absolute or relative path to the CSV file on the filesystem.
   - `options` (object, optional):
     - `delimiter` (string, default: ","): The field delimiter. Some CSV files use semicolons, tabs, or pipes.
     - `hasHeaders` (boolean, default: true): Whether the first row is a header row.
     - `encoding` (string, default: "utf-8"): File encoding. Must also support "latin1" and "utf-16le" for files from legacy systems.
     - `skipEmptyRows` (boolean, default: true): Whether to skip rows where all fields are empty.
     - `maxRows` (number, default: null): Maximum number of data rows to read (not counting header). Null means read all rows. This is useful for testing and for preview functionality.
     - `quoteChar` (string, default: '"'): The character used to quote fields that contain delimiters or newlines.

   **Return value:**
   ```javascript
   {
     success: true,
     filePath: "/data/employees.csv",
     columns: ["emp_id", "name", "department", "salary", "start_date", "is_active", "skills"],
     rowCount: 1000,
     rows: [
       { emp_id: "EMP-001", name: "Melissa Chang", department: "Engineering", salary: "145000", start_date: "2020-03-15", is_active: "true", skills: "python,java,sql" },
       { emp_id: "EMP-002", name: "Jean-Pierre Habimana", department: "Finance", salary: "125000", start_date: "2019-07-01", is_active: "true", skills: "excel,sap" },
       // ...all rows as objects keyed by column name
     ],
     parseWarnings: [],
     parseDurationMs: 45
   }
   ```

   **Critical behavior:**
   - Every value in the returned rows must be a STRING. No type conversion happens here — that's the job of the type converter (Task 6). The CSV parser must return raw strings exactly as they appear in the file.
   - Leading and trailing whitespace must be trimmed from all values. A field that contains only whitespace must be treated as an empty string.
   - Empty strings must be preserved as empty strings, not converted to null. The type converter will handle the null conversion based on the property's `is_required` setting.
   - The function must be memory-efficient for large files. Use `csv-parse` with its streaming API, not the sync API. Read the file line by line using a readable stream, pipe it through the CSV parser, and collect rows into an array. For very large files (>100MB), this should not load the entire file into memory at once — but for Week 1, buffering all rows into an array is acceptable because we're not dealing with files larger than a few hundred MB.
   - If the file does not exist, return: `{ success: false, error: { code: "FILE_NOT_FOUND", message: "File not found: '{filePath}'", filePath } }`.
   - If the file is empty (0 bytes), return: `{ success: false, error: { code: "FILE_EMPTY", message: "File is empty: '{filePath}'", filePath } }`.
   - If the file has a header row but no data rows, return `{ success: true, columns: [...], rowCount: 0, rows: [] }` — this is valid (an empty dataset).
   - If a row has more fields than the header, add a warning to `parseWarnings`: `"Row {lineNumber} has {actualCount} fields but header has {expectedCount} fields. Extra fields ignored."`. Truncate the row to match the header field count.
   - If a row has fewer fields than the header, add a warning: `"Row {lineNumber} has {actualCount} fields but header has {expectedCount} fields. Missing fields set to empty string."`. Pad the row with empty strings.
   - Track the line number (starting from 1 for the first data row, not counting the header) so that error messages can reference specific rows.

2. **`getCSVPreview(filePath, rowCount)`** — Reads only the first `rowCount` rows (default: 5) and returns them along with column names. This is used by the Ontology Manager (Week 2) to show a preview of the dataset before the user creates the column mapping.

   Return format is the same as `readCSV` (including `columns`, `rows`, `rowCount`, `parseWarnings`, and `parseDurationMs`) plus an additional field `preview: true`, limited to the first `rowCount` data rows.

3. **`getCSVSchema(filePath)`** — Reads only the header row and returns the column names without reading any data. This is a very fast operation used to populate the column mapping UI.

   Return: `{ columns: ["emp_id", "name", "department", ...], filePath }`.

4. **`countCSVRows(filePath)`** — Counts the total number of data rows without loading them into memory. Uses the `csv-parse` streaming parser (not raw newline counting) to correctly count rows, since CSV fields may contain embedded newlines inside quoted values. This is used to show progress during indexing ("Indexing row 500 of 1000...").

   Return: `{ rowCount: 1000, filePath }`.

**Error handling:** All functions must return (not throw) filesystem errors in a consistent format: `{ success: false, error: { code: "FILE_NOT_FOUND"|"FILE_EMPTY"|"FILE_READ_ERROR"|"CSV_PARSE_ERROR", message: "...", filePath: "..." } }`. This matches the error object pattern used in Task 1. Functions never throw — they always return an object with `success: true` or `success: false`.

**Test to verify:** Create a test CSV file with 100 rows including edge cases: fields with commas inside quotes, fields with newlines inside quotes, empty fields, fields with only whitespace, a row with too many fields, a row with too few fields. Verify all edge cases are handled correctly.
