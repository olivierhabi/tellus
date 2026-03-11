# TASK 5 OF 30: Database Migration — Backing Datasource Table

**Objective:** Add the backing_datasource table to src/migrate.js. This table records which data file backs each object type and how file columns map to object properties. Reference: https://www.palantir.com/docs/foundry/object-link-types/create-object-type/ — "select a datasource to back the object type."

**Step-by-step instructions:**

Add `CREATE TABLE IF NOT EXISTS backing_datasource` to src/migrate.js AFTER the property table.

**The backing_datasource table has 13 columns:**

```sql
CREATE TABLE IF NOT EXISTS backing_datasource (
  mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id UUID NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  dataset_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_format TEXT NOT NULL DEFAULT 'csv' CHECK (file_format IN ('csv', 'json', 'parquet')),
  column_mapping JSONB NOT NULL,
  primary_key_column TEXT NOT NULL,
  row_count INTEGER,
  column_names TEXT[],
  schema_hash TEXT,
  last_scanned_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ DEFAULT now(),
  registered_by TEXT DEFAULT 'system'
);
```

Column details:
1. `mapping_id`: UUID primary key.
2. `object_type_id`: FK to object_type with ON DELETE CASCADE. Deleting an object type deletes its datasource.
3. `dataset_name`: human-readable name (e.g., "Employee Dataset").
4. `file_path`: filesystem path to the CSV/JSON file.
5. `file_format`: 'csv', 'json', or 'parquet'. Default 'csv'. (Parquet support is listed for forward compatibility; Week 1 only uses csv and json.)
6. `column_mapping`: JSONB mapping property apiNames to file column names (e.g., `{"employeeId": "emp_id"}`).
7. `primary_key_column`: which file column provides primary key values.
8. `row_count`: nullable, populated after file scan.
9. `column_names`: TEXT array of file column headers, nullable until scanned.
10. `schema_hash`: MD5 hash of sorted column names for change detection.
11. `last_scanned_at`: timestamp of last file scan, nullable.
12. `registered_at`: when the datasource was registered.
13. `registered_by`: defaults to 'system'.

**Unique indexes enforcing Palantir's one-datasource-per-object-type rule:**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_object_type ON backing_datasource(object_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_file_path ON backing_datasource(file_path);
```

- `idx_ds_object_type`: ensures at most one datasource per object type.
- `idx_ds_file_path`: ensures each file backs at most one object type.

Log: "Created table: backing_datasource" (or "Table already exists: backing_datasource").

**Files to modify:** src/migrate.js

**Verification:**
- Table has 13 columns: `\d backing_datasource`
- Two datasources for same object_type → fails unique index `idx_ds_object_type`
- Same file_path for two object types → fails unique index `idx_ds_file_path`
- file_format CHECK rejects invalid: `INSERT ... file_format='xml'` → fails
- ON DELETE CASCADE: deleting an object_type deletes its backing_datasource
- Migration is idempotent
