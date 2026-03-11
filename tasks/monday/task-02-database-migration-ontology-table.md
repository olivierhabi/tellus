# TASK 2 OF 30: Database Migration — Ontology Table

**Objective:** Create the migration script (src/migrate.js) and the first database table — ontology — representing the top-level Ontology container. In Palantir Foundry, an Ontology is the root resource that contains all object types, link types, action types, interfaces, and functions. Reference: https://www.palantir.com/docs/foundry/ontology/overview/.

**Step-by-step instructions:**

Create the file src/migrate.js. This script connects to PostgreSQL using the pool from db.js, executes all CREATE TABLE statements in dependency order inside a single transaction, and then disconnects.

At the top of the file, add a comment block listing ALL tables that will be created across the entire week. This serves as a schema roadmap for developers:

```javascript
// Complete migration order (all tables):
// Week 1: ontology, object_type, property, backing_datasource, funnel_state
// Future: link_type, link_join_table, action_type, ontology_edit, action_audit_log, interface, object_type_interface
```

**Migration function structure:**

```javascript
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // CREATE TABLE statements here (Tasks 2–6)
    await client.query('COMMIT');
    console.log('Migration complete. Tables: ontology, object_type, property, backing_datasource, funnel_state');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(0);
}
migrate();
```

**The ontology table (6 columns):**

```sql
CREATE TABLE IF NOT EXISTS ontology (
  ontology_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT DEFAULT 'system'
);
```

Column details:
- `ontology_id`: UUID primary key, auto-generated via `gen_random_uuid()` (built-in since PostgreSQL 13).
- `display_name`: human-readable name, 1–256 chars. The CHECK constraint prevents empty strings and extremely long names.
- `description`: optional free-text. No length limit. Can be null.
- `created_at`: immutable after creation. Application code must NEVER include this in UPDATE statements.
- `updated_at`: application code must set to `NOW()` in every UPDATE statement.
- `created_by`: defaults to `'system'`. Will store authenticated user IDs once auth is added (future sprint).

After the table, create a unique index:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_display_name ON ontology(display_name);
```
This prevents duplicate ontology names.

**Logging:** For each table creation, log whether it was created or already existed. A simple approach: query `information_schema.tables` before each CREATE to check existence, then log accordingly.
- New: `"Created table: ontology"`
- Existing: `"Table already exists: ontology"`

The `IF NOT EXISTS` clause ensures the migration is idempotent — running it multiple times has no adverse effect.

**Files to create:** src/migrate.js (initial version with ontology table only; Tasks 3–6 add more tables to this same file)

**Verification:**
- `npm run migrate` completes and logs "Created table: ontology" then "Migration complete. Tables: ontology, object_type, property, backing_datasource, funnel_state"
- In psql: `\dt` shows ontology table. `\d ontology` shows 6 columns.
- Run `npm run migrate` again — no errors, logs "Table already exists: ontology"
- Insert with empty display_name: `INSERT INTO ontology (display_name) VALUES ('')` → fails CHECK constraint
- Insert with duplicate display_name → fails unique index
