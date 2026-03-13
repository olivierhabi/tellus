## TASK 11: Build the File Reader Utility for CSV and JSON

### Context
Multiple services (the reindex engine from Task 7, the metadata extractor from Task 2, and the upcoming integration tests) all need to read CSV and JSON files and parse them into arrays of row objects. Currently this logic is scattered or duplicated. This task creates a single, robust, reusable file reader utility that handles all the edge cases of real-world CSV and JSON data. This is a foundational utility that other tasks depend on, so it must be extremely reliable.

Real-world CSV files from government tax systems like RRA are messy. They may have: extra whitespace in headers and values, quoted fields with commas inside them, empty lines at the end of the file, BOM (Byte Order Mark) characters at the start of UTF-8 files, inconsistent line endings (CRLF vs LF), fields with newlines inside quoted strings, and columns with mixed data types. The file reader must handle all of these cases gracefully without crashing.

### Exact Specification

Create a file at `/src/utils/fileReader.js` that exports these functions:

**Function 1: `readCsvFile(filePath, options = {})`**

This function reads an entire CSV file and returns an array of row objects where each key is a column header and each value is the string value from that cell. It uses `csv-parse` for parsing. The implementation reads the file content in full with `fs.readFileSync` (not streaming) because BOM stripping requires access to the first byte. The final result IS an in-memory array. For week 1, this approach is acceptable — files under 500MB (our upload limit) will fit in memory. True streaming with a transform stream for BOM removal is a future optimization.

Options parameter:
- `maxRows` (integer, default: Infinity): Maximum number of data rows to read (excludes header). Used for preview and metadata extraction.
- `delimiter` (string, default: ','): Field delimiter. Support comma, semicolon, tab, and pipe.
- `skipEmptyLines` (boolean, default: true): Skip completely empty lines.
- `trimHeaders` (boolean, default: true): Trim whitespace from column header names.
- `trimValues` (boolean, default: true): Trim whitespace from cell values.

Implementation requirements:
1. Use `csv-parse` with the `columns: true` option to get objects keyed by header names
2. Handle BOM: If the first character of the file is `\uFEFF`, strip it before parsing. BOM is common in CSV files exported from Excel.
3. Handle empty values: Convert the value to lowercase via `val.trim().toLowerCase()` and check against the set `{'null', 'na', 'n/a', ''}`. If matched, convert to JavaScript `null`. This ensures case-insensitive matching (e.g., "NULL", "Null", "Na", "N/a" all become null).
4. Handle numeric strings: Do NOT convert numeric strings to numbers at this stage. All values should remain as strings (or null). Type conversion happens in the reindex engine based on the property's base_type.
5. Auto-detect delimiter: If the `delimiter` option is not explicitly set, peek at the first line of the file and count occurrences of comma, semicolon, tab, and pipe. Use the one that appears most frequently. This handles files where the user doesn't know what delimiter was used.
6. Return value: `{ rows: [{...}, {...}, ...], headers: ['col1', 'col2', ...], rowCount: 1000 }`

Error handling:
- If the file does not exist: throw with message `"File not found: {filePath}"`
- If the file is empty (0 bytes): return `{ rows: [], headers: [], rowCount: 0 }`
- If the CSV is malformed (e.g., mismatched quotes): throw with message `"CSV parsing error at row {N}: {original error message}"`
- If the file has no header row (detected by checking if the first row looks like data, not headers — heuristic: if more than 50% of first-row values match the regex `/^-?\d+(\.\d+)?$/` after trimming whitespace, it's probably data, not headers. Values with currency symbols, commas, or scientific notation are NOT considered numeric for this heuristic): throw with message `"CSV file appears to have no header row. The first row must contain column names."`

```javascript
const fs = require('fs');
const { parse } = require('csv-parse');

async function readCsvFile(filePath, options = {}) {
  const { maxRows = Infinity, delimiter, skipEmptyLines = true, trimHeaders = true, trimValues = true } = options;
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    return { rows: [], headers: [], rowCount: 0 };
  }
  
  // Strip BOM if present
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  
  // Auto-detect delimiter if not specified
  const effectiveDelimiter = delimiter || detectDelimiter(content.split('\n')[0]);
  
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    let count = 0;
    
    const parser = parse(content, {
      columns: true,
      delimiter: effectiveDelimiter,
      skip_empty_lines: skipEmptyLines,
      trim: trimValues,
      relax_column_count: true, // Handle rows with fewer/more columns than header
    });
    
    parser.on('readable', function () {
      let record;
      while ((record = parser.read()) !== null) {
        if (count >= maxRows) break;
        
        if (!headers) {
          headers = Object.keys(record);
          if (trimHeaders) {
            // Rename keys if headers had whitespace
          }
        }
        
        // Normalize null-like values (case-insensitive)
        for (const key of Object.keys(record)) {
          const val = record[key];
          if (val !== null && val !== undefined) {
            const normalized = val.trim().toLowerCase();
            if (normalized === '' || normalized === 'null' || normalized === 'na' || normalized === 'n/a') {
              record[key] = null;
            }
          }
        }
        
        rows.push(record);
        count++;
      }
    });
    
    parser.on('error', (err) => reject(new Error(`CSV parsing error: ${err.message}`)));
    parser.on('end', () => resolve({ rows, headers: headers || [], rowCount: count }));
  });
}
```

**Function 2: `readJsonFile(filePath, options = {})`**

Reads a JSON file (either a JSON array or JSON Lines format) and returns the same shape as readCsvFile.

Options:
- `maxRows` (integer, default: Infinity)

Implementation:
1. Read the file content
2. Strip BOM if present
3. Determine format:
   - If first non-whitespace character is `[`: parse as JSON array
   - Otherwise: treat as JSON Lines (one JSON object per line)
4. For JSON array: `JSON.parse(content)` and extract rows
5. For JSON Lines: split by newline, parse each non-empty line as JSON
6. Extract headers from the keys of the first object
7. Normalize null-like values (same rules as CSV)
8. Return `{ rows, headers, rowCount }`

Error handling:
- If JSON parsing fails: throw with message `"JSON parsing error: {original error}. File should be a JSON array ([{...}, {...}]) or JSON Lines (one JSON object per line)."`
- If the parsed result is not an array of objects: throw with message `"JSON file must contain an array of objects or JSON Lines format."`

**Function 3: `readFile(filePath, format, options = {})`**

Convenience function that dispatches to readCsvFile or readJsonFile based on the format parameter ('csv', 'json', 'jsonl').

**Function 4: `detectDelimiter(headerLine)`**

Analyzes the first line of a file and returns the most likely delimiter.

```javascript
function detectDelimiter(headerLine) {
  const candidates = [
    { char: ',', count: (headerLine.match(/,/g) || []).length },
    { char: ';', count: (headerLine.match(/;/g) || []).length },
    { char: '\t', count: (headerLine.match(/\t/g) || []).length },
    { char: '|', count: (headerLine.match(/\|/g) || []).length },
  ];
  candidates.sort((a, b) => b.count - a.count);
  return candidates[0].count > 0 ? candidates[0].char : ','; // default to comma
}
```

**Function 5: `countFileRows(filePath, format)`**

Efficiently counts rows without loading the entire file into memory. For CSV: count newlines (minus 1 for header). For JSON array: parse and get length. For JSON Lines: count non-empty lines.

This function is used when we need just the row count without parsing all the data (e.g., for the dataset metadata update after an append).

### Validation Criteria
- CSV with commas, semicolons, tabs, and pipes all parse correctly
- CSV with BOM character parses correctly (no garbage character in first column name)
- CSV with quoted fields containing commas parses correctly
- CSV with empty lines at end doesn't produce empty row objects
- CSV with "null", "NULL", "Null", "NA", "N/A", "na", "n/a", and empty strings all become JavaScript `null` (case-insensitive)
- JSON array format parses correctly
- JSON Lines format parses correctly
- maxRows option limits the number of rows returned
- Empty files return `{ rows: [], headers: [], rowCount: 0 }`
- Invalid CSV returns descriptive error message
- Invalid JSON returns descriptive error message
- detectDelimiter correctly identifies semicolon-separated and tab-separated files
- `countFileRows` returns the correct count for a CSV with 100 rows (returns 100, not 101 — excludes header)
- `readFile` dispatches to `readCsvFile` for format='csv' and `readJsonFile` for format='json' and format='jsonl'
- A CSV file where the first row contains all numeric values (e.g., "2020,2021,2022") throws the no-header-row error
