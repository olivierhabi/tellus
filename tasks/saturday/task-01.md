## TASK 1: Create the Dataset Registry Table in PostgreSQL

### Context
Currently, the system stores uploaded data files directly via the `backing_datasource` table which only has a `file_path` field. This is insufficient because Palantir's dataset model is richer — datasets are versioned, have transaction history, and track metadata about their contents. On Saturday, we need a proper dataset abstraction layer that sits between raw files and the Ontology. This task creates the database schema for that layer.

In Palantir Foundry, a dataset is a wrapper around a collection of files. Datasets support versioning through transactions and maintain full history. Each time data is added, replaced, or modified, a new transaction is created. The transaction types in Palantir are SNAPSHOT (full replacement), APPEND (add new rows), and UPDATE (modify existing rows by primary key). For our week-1 implementation, we will support SNAPSHOT (full file upload replaces previous data) and APPEND (new file adds rows to existing data). UPDATE will be added in a future week.

### Exact Specification

Create a new migration file at `/src/migrations/006_dataset_registry.sql` and a corresponding migration runner. The file must contain the following SQL statements executed in order:

**Table 1: `dataset`**

This table represents a dataset resource in the system. Each dataset is identified by a UUID, has a human-readable name, and tracks where its files are stored on disk. The `schema_definition` column stores the column definitions (names and types) detected from the uploaded file. The `format` column indicates whether the uploaded file was CSV, JSON, or Parquet. The CHECK constraint includes `'parquet'` for forward compatibility; week-1 code will only accept `'csv'` and `'json'` at the API layer. The `created_by` field stores the identifier of the user or system that created the dataset — for week 1 this will always be 'system' since we have no authentication yet.

```sql
CREATE TABLE IF NOT EXISTS dataset (
  dataset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  format TEXT NOT NULL CHECK (format IN ('csv', 'json', 'parquet')),
  schema_definition JSONB NOT NULL DEFAULT '[]',
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL DEFAULT 'system',
  row_count BIGINT DEFAULT 0,
  file_size_bytes BIGINT DEFAULT 0
);
```

The `schema_definition` JSONB column must store an array of column definitions detected from the file. Each element must have this exact shape:
```json
[
  { "columnName": "emp_id", "detectedType": "string", "nullable": true, "sampleValues": ["EMP-001", "EMP-002"] },
  { "columnName": "annual_salary", "detectedType": "integer", "nullable": false, "sampleValues": [120000, 95000] }
]
```

The `detectedType` must be one of: `"string"`, `"integer"`, `"number"`, `"boolean"`, `"date"`, `"timestamp"`, `"null"` (when all values are null). The detection logic is built in Task 2 (`extractCsvMetadata` and `extractJsonMetadata`). This task only creates the table. There is no CHECK constraint on `detectedType` in the database — the validation is enforced at the application layer.

**Table 2: `dataset_transaction`**

This table records every data modification to a dataset. When a file is uploaded, a transaction is created. Transactions are immutable once committed. This follows Palantir's model exactly: "Datasets support versioning through transactions and maintain full history."

```sql
CREATE TABLE IF NOT EXISTS dataset_transaction (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES dataset(dataset_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('SNAPSHOT', 'APPEND')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'aborted')),
  file_path TEXT NOT NULL,
  row_count BIGINT DEFAULT 0,
  file_size_bytes BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'system',
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_txn_dataset_committed ON dataset_transaction(dataset_id, committed_at DESC);
CREATE INDEX idx_txn_status ON dataset_transaction(status);
```

The `metadata` JSONB column can store arbitrary information about the transaction, such as the original filename, upload source, or processing notes.

**Table 3: Alter `backing_datasource` to reference `dataset`**

The existing `backing_datasource` table currently has a raw `file_path` field. We need to modify it to reference the new `dataset` table instead, so that backing datasources are properly linked to versioned datasets.

```sql
ALTER TABLE backing_datasource ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES dataset(dataset_id);
```

Do NOT remove the existing `file_path` column yet — it may be in use by existing code. The migration should be backward-compatible. Existing rows with `file_path` set but `dataset_id` null should continue to work. New code will prefer `dataset_id` when it is set, and fall back to `file_path` when it is not.

**Table 4: `funnel_state`**

This table tracks the indexing state for each object type. It records which dataset transaction was last indexed, so the system knows whether a reindex is needed.

```sql
CREATE TABLE IF NOT EXISTS funnel_state (
  object_type_id UUID PRIMARY KEY REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  last_indexed_transaction_id UUID REFERENCES dataset_transaction(transaction_id),
  last_indexed_at TIMESTAMPTZ,
  objects_indexed BIGINT DEFAULT 0,
  index_status TEXT DEFAULT 'idle' CHECK (index_status IN ('idle', 'running', 'failed', 'completed')),
  error_message TEXT,
  duration_ms INT
);
```

### Migration Runner

Create a file at `/src/migrations/runMigrations.js` that:
1. Connects to PostgreSQL using the existing `db.js` pool
2. Reads all SQL files in the `/src/migrations/` directory sorted alphabetically
3. Executes each one inside a transaction
4. Logs which migrations were applied
5. Is idempotent — uses `IF NOT EXISTS` and `IF NOT EXISTS` so it can be run multiple times safely

Also update `server.js` to call `runMigrations()` at startup before the Express server starts listening.

### Validation Criteria
- All four tables are created successfully in PostgreSQL
- Running the migration twice does not produce errors (idempotent)
- The `dataset_transaction` table has the correct indexes
- The `backing_datasource` table has the new `dataset_id` column alongside the existing `file_path` column
- Foreign key constraints work correctly (deleting a dataset cascades to its transactions; deleting an object_type cascades to its funnel_state)
- The migration runner logs which migrations were applied (e.g., "Applied 006_dataset_registry.sql")
- Running `node src/migrations/runMigrations.js` directly works as a standalone command
- After updating `server.js`, the server calls `runMigrations()` before `app.listen()` and logs success
