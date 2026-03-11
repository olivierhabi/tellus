# TASK 4 OF 30: Database Migration — Property Table and Foreign Key Constraints

**Objective:** Add the property table to src/migrate.js and create the deferred foreign key constraints from object_type to property. The property table stores every field definition for every object type and must support all 23 Palantir base types. Reference: https://www.palantir.com/docs/foundry/object-link-types/base-types/.

**Step-by-step instructions:**

Add `CREATE TABLE IF NOT EXISTS property` to src/migrate.js AFTER the object_type table.

**The property table has 11 columns:**

```sql
CREATE TABLE IF NOT EXISTS property (
  property_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id UUID NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  api_name TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  description TEXT,
  base_type TEXT NOT NULL CHECK (base_type IN (
    'string','boolean','integer','long','double','float','byte','short','decimal',
    'date','timestamp','geopoint','geoshape','struct',
    'string_array','integer_array','double_array','boolean_array','timestamp_array',
    'attachment','marking','media_reference','timeseries'
  )),
  struct_schema JSONB,
  is_required BOOLEAN DEFAULT false,
  is_array BOOLEAN DEFAULT false,
  is_shared BOOLEAN DEFAULT false,
  ordinal INTEGER DEFAULT 0,
  UNIQUE(object_type_id, api_name)
);
```

Column details:
1. `property_id`: UUID primary key.
2. `object_type_id`: FK to object_type with ON DELETE CASCADE. Deleting an object type deletes all its properties.
3. `api_name`: camelCase name (validated in application logic, Task 8). UNIQUE within an object type.
4. `display_name`: human-readable, 1–256 chars.
5. `description`: optional, nullable.
6. `base_type`: one of the 23 Palantir types. The CHECK constraint lists all 23.
7. `struct_schema`: JSONB, nullable. Only non-null when `base_type = 'struct'`. Contains array of `{fieldName, fieldType, ...}`.
8. `is_required`: default false. When true, null values cause indexing to fail.
9. `is_array`: default false. Auto-set to true by application logic when base_type ends with '_array'.
10. `is_shared`: default false. For shared properties (deferred to future sprint).
11. `ordinal`: display order. Lower = displayed first. Default 0.

Create index:
```sql
CREATE INDEX IF NOT EXISTS idx_property_object_type ON property(object_type_id);
```

**Deferred foreign key constraints:**

After creating the property table, add FK constraints from object_type back to property. These could not be created in Task 3 because the property table didn't exist yet.

Use DO blocks since ALTER TABLE ADD CONSTRAINT does not support IF NOT EXISTS:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_primary_key') THEN
    ALTER TABLE object_type ADD CONSTRAINT fk_ot_primary_key
      FOREIGN KEY (primary_key_property_id) REFERENCES property(property_id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_title_prop') THEN
    ALTER TABLE object_type ADD CONSTRAINT fk_ot_title_prop
      FOREIGN KEY (title_property_id) REFERENCES property(property_id) ON DELETE SET NULL;
  END IF;
END $$;
```

ON DELETE SET NULL means: if the primary key or title property is deleted, the reference becomes null rather than cascade-deleting the object type. This preserves the object type definition.

Log: "Created table: property", "Added FK constraint: fk_ot_primary_key", "Added FK constraint: fk_ot_title_prop" (or "already exists" variants).

**Files to modify:** src/migrate.js (add property table + ALTER TABLEs)

**Verification:**
- Property table has 11 columns: `\d property`
- base_type CHECK rejects invalid: `INSERT INTO property (object_type_id, api_name, display_name, base_type) VALUES (gen_random_uuid(), 'test', 'Test', 'invalid')` → fails
- base_type CHECK accepts all 23 types
- FK from object_type to property works: setting `primary_key_property_id` to a valid `property_id` → succeeds
- Setting `primary_key_property_id` to a non-existent UUID → fails FK constraint
- Deleting a property that is the primary key → object_type.primary_key_property_id becomes NULL (ON DELETE SET NULL)
- ON DELETE CASCADE: deleting an object_type deletes all its properties
- Migration is idempotent: running twice produces no errors
