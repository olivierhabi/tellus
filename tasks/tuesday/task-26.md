# TASK 26: Create the Data Sampling and Type Inference Utility

**File to create:** `/src/services/indexing/dataSampler.js`

**Purpose:** Extracts a representative sample of data from a CSV file for preview and type inference purposes. Used by the Ontology Manager UI (Week 2) to show data previews and suggest property types based on actual values.

**Specification:**

Export:

1. **`sampleData(filePath, sampleSize = 20)`** — Returns `sampleSize` data rows (excluding header) distributed evenly across the CSV file.

   **Sampling algorithm:**
   - Read the total row count using `countCSVRows(filePath)` from Task 5.
   - If `sampleSize >= totalRows`, return all rows.
   - If `sampleSize < 1`, throw: `"sampleSize must be at least 1"`.
   - If the file does not exist or is not a valid CSV, return `{ success: false, error: "..." }` (consistent with Task 5's error format).
   - Always include the first data row (row index 0) and the last data row. Fill remaining slots at evenly spaced intervals using `Math.round(i * (totalRows - 1) / (sampleSize - 1))` for `i` in `[0, sampleSize - 1]`. Deduplicate indices if `sampleSize` is close to `totalRows`.
   - Return an array of objects keyed by column header names.

2. **`inferPropertyTypes(filePath, sampleSize = 100)`** — Analyzes a sample of values for each column and infers the most likely Ontology property type.

   **Algorithm:**
   - Uses `sampleData(filePath, sampleSize)` to obtain sample rows.
   - For each column, attempts to convert all non-null sample values to each candidate type in this **priority order**: `boolean`, `integer`, `long`, `double`, `date`, `timestamp`, `string`.
   - The **first type in priority order** where >= 80% of non-null values convert successfully is the inferred type. Priority order ensures that, e.g., "1" is inferred as `boolean` (since it's tried first) rather than `integer` — unless <80% of other values in the column also convert to boolean.
   - If no type reaches 80% success rate, default to `"string"`.
   - **Confidence** is calculated as: `(count of non-null values successfully converted to inferred type) / (count of non-null sample values)`.
   - **Date vs timestamp distinction:** A value is a `date` if it matches date-only formats (`YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, etc.) with no time component. A value is a `timestamp` if it includes a time component (`T` separator, space-separated time, or epoch milliseconds/seconds).
   - Use `convertValue` from Task 6 for the actual conversion attempts.

   Return:
   ```javascript
   {
     columns: {
       "emp_id": { inferredType: "string", sampleValues: ["EMP-001", "EMP-002", ...], confidence: 1.0 },
       "salary": { inferredType: "double", sampleValues: ["145000", "125000", ...], confidence: 0.95 },
       "start_date": { inferredType: "date", sampleValues: ["2020-03-15", "2019-07-01", ...], confidence: 0.90 },
       "is_active": { inferredType: "boolean", sampleValues: ["true", "false", ...], confidence: 1.0 }
     }
   }
   ```

**Test to verify:** Create a CSV with known column types (integers, dates, booleans, mixed). Call `inferPropertyTypes` and verify each column's inferred type matches the expected type. Verify that a column with 50% integers and 50% strings infers as `"string"` (below 80% threshold). Verify that a boolean column with "true"/"false"/"1"/"0" values infers as `"boolean"`.
