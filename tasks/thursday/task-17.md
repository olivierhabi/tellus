# TASK 17: Build Join Table Upload Endpoint for MANY_TO_MANY Links

**Objective:** Build an endpoint that allows uploading a join table CSV file for a many-to-many link type. When the join table is uploaded or updated, the link type's `join_table_file_path` is updated to point to the new file.

**Prerequisites:** Tasks 1 and 2 must be complete.

**HTTP method and path:** `POST /api/v2/ontology/:ontologyId/linkTypes/:apiName/joinTable`

**Content-Type:** `multipart/form-data`

**Request:** A CSV file upload with a `file` field. Use Express middleware `multer` for multipart parsing (already available as a project dependency, or add it).

**Maximum file size:** 50 MB. If the uploaded file exceeds this, return HTTP 400 with `{ "error": "File size exceeds maximum of 50 MB." }`.

**Implementation:**

1. Verify the link type exists and has cardinality `MANY_TO_MANY`:
```sql
SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2
```
If not found, return HTTP 404 with `{ "error": "Link type '${apiName}' not found." }`. If cardinality is not `MANY_TO_MANY`, return HTTP 400 with `{ "error": "Join table upload is only valid for MANY_TO_MANY link types. This link type has cardinality '${cardinality}'." }`.

2. Parse the CSV file content. Use `csv-parse/sync` to parse with `{ columns: true, skip_empty_lines: true }`.

3. Validate that the columns specified in `join_table_source_column` and `join_table_target_column` exist in the CSV headers. If either is missing, return HTTP 400 with `{ "error": "CSV is missing required column '${missingColumn}'. Found columns: ${csvHeaders.join(', ')}." }`.

4. Validate row data: iterate through all parsed records and count rows where either the source or target column value is empty, null, or whitespace-only. If any invalid rows are found, return HTTP 400 with `{ "error": "Join table contains ${count} rows with empty/null values in required columns (${sourceColumn} or ${targetColumn}). All rows must have non-empty values." }`.

5. Save the file to `data/join_tables/${linkType.link_type_id}.csv`. Create the `data/join_tables/` directory if it doesn't exist (`fs.mkdirSync(dir, { recursive: true })`).

6. Update the `link_type` row:
```sql
UPDATE link_type SET join_table_file_path = $1, updated_at = now()
WHERE ontology_id = $2 AND api_name = $3
```

7. Calculate summary statistics: total row count, unique source keys, unique target keys.

**Response:** HTTP 200 OK

```json
{
    "uploaded": true,
    "linkType": "studentCourses",
    "rowCount": 15000,
    "sourceColumn": "student_id",
    "targetColumn": "course_id",
    "uniqueSourceKeys": 500,
    "uniqueTargetKeys": 200,
    "filePath": "data/join_tables/uuid.csv"
}
```

**Error responses:**
- HTTP 400 — Not a M2M link type: `{ "error": "Join table upload is only valid for MANY_TO_MANY link types." }`.
- HTTP 400 — Missing CSV column: `{ "error": "CSV is missing required column '${column}'." }`.
- HTTP 400 — Empty/null values in rows: `{ "error": "Join table contains N rows with empty/null values." }`.
- HTTP 400 — File too large: `{ "error": "File size exceeds maximum of 50 MB." }`.
- HTTP 404 — Link type not found: `{ "error": "Link type '${apiName}' not found." }`.
- HTTP 500 — Internal error: `{ "error": "Internal server error" }`.

**File to modify:** `src/routes/linkTypes.js` — add the POST `/:apiName/joinTable` handler.

**Testing:**
1. Create a M2M link type (Student → Course). Upload a valid join table CSV with 3 columns (student_id, course_id, enrollment_date — extra columns are ignored). Verify response shows correct `rowCount`, `uniqueSourceKeys`, `uniqueTargetKeys`.
2. Verify the file was saved to `data/join_tables/{linkTypeId}.csv`.
3. Verify the link resolver now returns results for this M2M link.
4. Upload a CSV missing the `student_id` column — verify HTTP 400 with the missing column name.
5. Upload a CSV with 2 rows having empty `course_id` — verify HTTP 400 with count of invalid rows.
6. Try uploading a join table to a ONE_TO_MANY link type — verify HTTP 400.
