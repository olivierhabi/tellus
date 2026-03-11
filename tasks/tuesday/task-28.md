# TASK 28: Create the Comprehensive Indexing Test Suite

**File to create:** `/src/tests/indexing/fullPipelineTest.js`

**Purpose:** An end-to-end integration test that exercises the entire indexing pipeline with realistic data. This is the single most important test — if this passes, the Day 2 deliverable is complete.

**Specification:**

The test must use a **seeded pseudo-random number generator** (e.g., `seedrandom('test-seed-42')`) when calling `generateEmployeeCSV` so that all generated values are deterministic across runs. After generating the CSV, the test must read and parse it to compute expected values for assertions BEFORE indexing.

The test must:

1. **Create an ontology and an "Employee" object type** with these exact properties:
   - `employeeId` (string, primary key)
   - `fullName` (string, required)
   - `email` (string)
   - `salary` (double)
   - `startDate` (date)
   - `isActive` (boolean)
   - `skills` (string_array)
   - `location` (geopoint)
   - `department` (string)
   - `age` (integer)

2. **Generate a test CSV file** with 500 rows using `generateEmployeeCSV` from Task 29, with these edge case options:
   - `duplicateKeyCount: 1` (1 duplicate PK)
   - `nullRequiredCount: 2` (2 null fullName values)
   - `badTypeCount: 5` (5 non-numeric salary values)
   - `emptyRowCount: 0`
   - 3 rows using non-standard date formats: one with `MM/DD/YYYY`, one with `DD-Mon-YYYY`, one with `YYYY/MM/DD`. These test the date parser's format flexibility.
   - Skills column with comma-separated values ("python,java,sql")
   - Location column with lat,lon values ("-1.9403,29.8739")
   - Boolean values using different formats ("true", "1", "yes", "false", "0", "no")

3. **Register the CSV** as a backing datasource.

4. **Trigger indexing with `strict: true`** → verify it FAILS due to data errors. Verify error counts: 1 duplicate PK, 2 null required fields, 5 bad type values.

5. **Generate a second clean CSV** using `generateEmployeeCSV` with all edge-case options set to 0 (no duplicates, no null required fields, no bad types, no empty rows). Use this clean CSV for re-indexing. Re-trigger indexing → verify SUCCESS.

6. **Query OpenSearch to verify** (compute expected values from the clean CSV data BEFORE indexing):
   - Total document count matches the clean CSV row count
   - A specific employee can be retrieved by PK (use the first row's PK)
   - A filter query (`department = "Engineering"`) returns the count matching the number of Engineering rows in the parsed CSV
   - An aggregation (avg salary) returns the average computed from the parsed CSV data (use approximate assertion with ±0.01 tolerance)
   - A full-text search for a name from the first row of the CSV returns the correct employee
   - A geopoint property was indexed correctly (verify lat/lon from the first row)
   - Skills array contains the expected values (verify against the first row)

7. **Create a simulated user edit** by inserting a row into the `ontology_edit` table:
   ```sql
   INSERT INTO ontology_edit (object_type_api_name, primary_key_value, operation, property_values, executed_by, executed_at, indexed)
   VALUES ('Employee', '{pk of first employee}', 'update', '{"salary": 999999}', 'test-user', now(), false)
   ```

8. **Re-trigger indexing** → verify the user edit survives: querying the first employee by PK returns `salary = 999999` instead of the original CSV value.

This test must be self-contained: it creates all test data, runs the pipeline, queries results, and cleans up after itself (delete test indices, remove test CSV files, clean up database rows).
