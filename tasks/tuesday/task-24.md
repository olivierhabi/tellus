# TASK 24: Create the Indexing Error Collector

**File to create:** `/src/services/indexing/errorCollector.js`

**Purpose:** Collects, deduplicates, and summarizes all errors that occur during an indexing pipeline run. Instead of failing on the first error, the system collects all errors and presents them together so the user can fix all issues at once.

**Specification:**

Create a class `IndexingErrorCollector` with the following methods:

- **`addError(category, details)`** — Adds an error to the collection.
  - `category` (string): One of `"primary_key"`, `"type_conversion"`, `"required_null"`, `"opensearch_rejection"`, `"file_read"`.
  - `details` (object):
    ```javascript
    {
      row: 42,                    // optional: row number in the CSV file
      property: "salary",         // optional: property name involved
      value: "not-a-number",      // optional: the offending value
      message: "Cannot convert 'not-a-number' to type double"  // required: human-readable description
    }
    ```

- **`addWarning(category, details)`** — Same signature as `addError`, same `details` shape. Warnings are non-fatal issues (e.g., whitespace in primary keys, truncated values).

- **`hasErrors()`** — Returns `true` if any errors have been added, `false` otherwise. Warnings do not count.

- **`getSummary()`** — Returns a grouped/deduplicated summary:
  ```javascript
  {
    errorCount: 17,
    warningCount: 3,
    errorsByCategory: {
      type_conversion: { count: 15, sample: "15 rows have type conversion errors on the 'salary' property" },
      required_null: { count: 2, sample: "2 rows have null values for required property 'fullName'" }
    },
    warningsByCategory: {
      primary_key: { count: 3, sample: "3 primary key values have leading/trailing whitespace" }
    }
  }
  ```
  **Deduplication rule:** Errors are grouped by the `(category, property)` tuple. Errors with the same category and same property are counted together and represented by a single summary line in the format `"{count} rows have {category} errors on the '{property}' property"`. If `property` is not set, group by `category` alone.

- **`getFullReport()`** — Returns all individual errors and warnings with full details:
  ```javascript
  {
    errors: [
      { category: "type_conversion", row: 42, property: "salary", value: "not-a-number", message: "Cannot convert..." },
      // ...all individual errors
    ],
    warnings: [
      // ...all individual warnings
    ],
    summary: { /* same as getSummary() */ }
  }
  ```

**Test to verify:** Create a collector, add 15 type_conversion errors for "salary", 2 required_null errors for "fullName", and 3 whitespace warnings. Verify `hasErrors()` returns true. Verify `getSummary()` groups correctly. Verify `getFullReport()` contains all 17 individual errors and 3 warnings.
