# TASK 7: Create the Primary Key Validator

**File to create:** `/src/services/indexing/primaryKeyValidator.js`

**Purpose:** This module validates primary key values across an entire dataset before indexing begins, and provides single-key existence checks against OpenSearch for the Action execution engine. In Palantir's Object Storage V2, duplicate primary keys within a single transaction are not allowed and cause indexing failures. This matches the documented behavior: "You may not have duplicate primary keys within a single transaction." Additionally, the primary key must never be null or empty for any row. This module scans the entire dataset and reports all primary key violations before any data is indexed, so the user can fix their data rather than discovering issues one row at a time during indexing.

**Detailed specification:**

The module must export the following functions:

**Part A: Funnel Pipeline Validation (used by the indexing orchestrator, Task 12)**

1. **`validatePrimaryKeys(rows, primaryKeyColumn)`** — Validates primary keys across all rows.

   **Parameters:**
   - `rows` — Array of row objects from the CSV reader (Task 5). Each row is an object with column names as keys and string values.
   - `primaryKeyColumn` — The name of the CSV column that serves as the primary key (from the `backing_datasource.primary_key_column` field in PostgreSQL).

   **Validation checks (in order):**

   a) **Column existence:** Verify that `primaryKeyColumn` exists as a key in the first row. If not, throw: `"Primary key column '{primaryKeyColumn}' does not exist in the dataset. Available columns: {comma-separated list of actual column names}"`. This catches configuration errors where the user specified the wrong column name in the backing datasource mapping.

   b) **Null/empty check:** Iterate through all rows and identify any rows where the primary key value is null, undefined, or empty string (after trimming). Collect the line numbers (1-indexed) of all offending rows. If any are found, report them all.

   c) **Uniqueness check:** Build a Map<string, number[]> that maps each primary key value to an array of line numbers where it appears. After scanning all rows, identify entries where the array length is > 1 — these are duplicates. Collect all duplicate groups.

   d) **Whitespace check:** Identify primary key values that contain leading or trailing whitespace (before trimming). These are warnings, not errors, because the system will trim them — but the user should know, because "EMP-001" and "EMP-001 " are different in the source data but will be treated as the same after trimming, which might cause unexpected duplicate detection.

   **Return value:**
   ```javascript
   {
     valid: true|false,
     totalRows: 1000,
     uniqueKeyCount: 998,
     errors: {
       nullKeys: [
         { lineNumber: 45, rawValue: null },
         { lineNumber: 872, rawValue: "" }
       ],
       duplicateKeys: [
         {
           value: "EMP-001",
           occurrences: [1, 503],  // line numbers
           count: 2
         },
         {
           value: "EMP-442",
           occurrences: [442, 443, 444],
           count: 3
         }
       ]
     },
     warnings: {
       whitespaceKeys: [
         { lineNumber: 67, rawValue: "EMP-067 ", trimmedValue: "EMP-067" }
       ]
     },
     summary: "Found 2 null/empty primary keys and 2 duplicate primary key groups (affecting 5 rows total). 1 primary key value has leading/trailing whitespace."
   }
   ```

   The `valid` field is `false` if there are ANY null keys OR ANY duplicate keys. Whitespace warnings alone do not make it invalid.

   **Performance consideration:** For a dataset with 1 million rows, this function must complete in under 5 seconds. Using a Map (hash map) for duplicate detection is O(n) which is acceptable. Do NOT use a nested loop (O(n²)) to check for duplicates — that would take minutes for large datasets.

**Part B: Action Execution Guards (used by the Action engine, Day 5)**

Both functions below serve a different Palantir concept (Action execution guard checks) from Part A (Funnel pre-indexing validation). They are co-located in this module because they share the same concern: primary key integrity. The caller determines which functions to use.

2. **`validatePrimaryKeyNotExists(primaryKeyValue, objectTypeApiName)`** — Checks whether a specific primary key already exists in the OpenSearch index. This is used by the Action execution engine (Day 5) when creating a new object — the primary key must not already exist.

   - Import the OpenSearch client from Task 1's `/src/services/opensearch/client.js`.
   - Import `getIndexName` from Task 3 to compute the index name.
   - Query OpenSearch: `{ query: { term: { "__pk": primaryKeyValue } } }` on the object type's index.
   - If a document is found, return `{ exists: true, existingObject: { ...document } }`.
   - If not found, return `{ exists: false }`.

3. **`validatePrimaryKeyExists(primaryKeyValue, objectTypeApiName)`** — The inverse: checks that a primary key DOES exist. Used by the Action engine for modify/delete operations.

   - Same query as above.
   - If found, return `{ exists: true, existingObject: { ...document } }`.
   - If not found, return `{ exists: false, error: "Object with primary key '{primaryKeyValue}' does not exist in object type '{objectTypeApiName}'" }`.

**Note on dual mapping:** This module serves two Palantir concepts: (1) `validatePrimaryKeys` maps to the Object Data Funnel's pre-indexing PK validation, and (2) `validatePrimaryKeyNotExists`/`validatePrimaryKeyExists` map to the Action execution engine's guard checks. Both are co-located because they share the core concern of primary key integrity and the same underlying data model.

**Test to verify:** Create a CSV with: 1000 rows, 2 rows with empty PK, 3 rows with duplicate PK "DUP-001", 1 row with trailing whitespace in PK. Verify the validator catches all issues and reports them correctly. Also test `validatePrimaryKeyNotExists` and `validatePrimaryKeyExists` against an OpenSearch index with known documents.
