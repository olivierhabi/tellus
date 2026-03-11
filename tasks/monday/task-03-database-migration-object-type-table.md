# TASK 3 OF 30: Database Migration — Object Type Table

**Objective:** Add the object_type table to src/migrate.js. This table stores schema definitions for every real-world entity in the Ontology. It is the most referenced table — properties, datasources, and funnel state all have foreign keys pointing to object_type. Reference: https://www.palantir.com/docs/foundry/object-link-types/object-types-overview/.

**Step-by-step instructions:**

Add a `CREATE TABLE IF NOT EXISTS object_type` statement to src/migrate.js AFTER the ontology table (order matters because object_type has a foreign key to ontology).

**The object_type table has exactly 15 columns:**

```sql
CREATE TABLE IF NOT EXISTS object_type (
  object_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  api_name TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  description TEXT,
  icon TEXT DEFAULT 'cube',
  icon_color TEXT DEFAULT '#1565C0',
  primary_key_property_id UUID,
  title_property_id UUID,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'experimental', 'deprecated')),
  edits_via_actions_only BOOLEAN DEFAULT true,
  max_properties INTEGER DEFAULT 2000,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT DEFAULT 'system',
  UNIQUE(ontology_id, api_name)
);
```

Column details:

1. `object_type_id`: UUID primary key.
2. `ontology_id`: FK to ontology with ON DELETE CASCADE. Deleting an ontology deletes all its object types.
3. `api_name`: programmatic name (PascalCase, e.g., Employee, CustomsDeclaration). Validated in application logic (Task 8), not via DB constraint. UNIQUE with ontology_id.
4. `display_name`: human-readable, 1–256 chars.
5. `description`: optional free-text, nullable.
6. `icon`: icon identifier string (default 'cube'). Values: 'person', 'building', 'airplane', 'document', 'money', 'truck', 'globe', 'shield', 'warning'.
7. `icon_color`: hex color string (default '#1565C0', Palantir's default blue).
8. `primary_key_property_id`: UUID, nullable. Set AFTER properties are created. FK to property added via ALTER TABLE in Task 4 (since property table doesn't exist yet). ON DELETE SET NULL.
9. `title_property_id`: UUID, nullable. Same deferred FK behavior as primary_key_property_id.
10. `status`: one of 'active', 'experimental', 'deprecated'. Default 'active'.
11. `edits_via_actions_only`: BOOLEAN, default true. Per Palantir docs, new object types only allow edits via Actions.
12. `max_properties`: INTEGER, default 2000. Palantir's Object Storage V2 limit.
13. `created_at`: immutable timestamp.
14. `updated_at`: updated on every modification.
15. `created_by`: defaults to 'system'.

Create index for fast lookup by ontology:
```sql
CREATE INDEX IF NOT EXISTS idx_object_type_ontology ON object_type(ontology_id);
```

The `UNIQUE(ontology_id, api_name)` constraint automatically creates an index for api_name lookups.

Log: "Created table: object_type" or "Table already exists: object_type".

**Files to modify:** src/migrate.js (add object_type table after ontology table)

**Verification:**
- After migration, `\d object_type` shows 15 columns
- Insert with valid data → succeeds, UUID generated
- Insert with duplicate `api_name` in same ontology → fails UNIQUE constraint
- Insert with same `api_name` in different ontology → succeeds (UNIQUE is scoped to ontology_id)
- Insert with invalid status → fails CHECK constraint
- Delete ontology → cascades to delete object_type rows
