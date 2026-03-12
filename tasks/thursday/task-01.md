# TASK 1: Create the `link_type` PostgreSQL Table

**Objective:** Create the database table that stores link type definitions — the schema for relationships between object types in the Ontology. This table is the relational backbone that tells the system how two object types are connected, what the cardinality of the relationship is, and how to resolve the link at query time (either through a foreign key property on one of the objects, or through a separate join table for many-to-many relationships).

**Why this exists in Palantir:** In Palantir Foundry, a link type is a first-class Ontology concept stored in the Ontology Metadata Service. It is separate from the object types it connects. Link types have their own API names, display names, and descriptions. They define the cardinality (one-to-one, one-to-many, many-to-one, many-to-many) and the mechanism for resolving the link. For one-to-one and one-to-many/many-to-one links, the resolution mechanism is a foreign key — a property on one object type whose value matches the primary key of the other object type. For many-to-many links, the resolution mechanism is a join table — a separate dataset/file that contains pairs of primary keys from both sides.

**Exact SQL to execute:**

```sql
CREATE TABLE link_type (
    link_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
    api_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    
    -- The two object types this link connects
    source_object_type_api_name TEXT NOT NULL,
    target_object_type_api_name TEXT NOT NULL,
    
    -- Cardinality: defines how many objects on each side
    cardinality TEXT NOT NULL CHECK (cardinality IN (
        'ONE_TO_ONE',
        'ONE_TO_MANY',
        'MANY_TO_ONE', 
        'MANY_TO_MANY'
    )),
    
    -- For ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE: which property serves as the foreign key
    -- For ONE_TO_MANY: a property on the TARGET holds the SOURCE's primary key
    --   Example: Employee has companyId property → Company PK
    --   source=Company, target=Employee, fk is on target side (Employee.companyId)
    -- For MANY_TO_ONE: a property on the SOURCE holds the TARGET's primary key
    --   Example: Employee.companyId → Company PK
    --   source=Employee, target=Company, fk is on source side (Employee.companyId)
    -- For ONE_TO_ONE: fk can be on either side
    foreign_key_property_api_name TEXT,
    foreign_key_side TEXT CHECK (foreign_key_side IN ('source', 'target')),
    
    -- For MANY_TO_MANY: a join table (separate file) that maps PKs
    join_table_file_path TEXT,
    join_table_source_column TEXT,
    join_table_target_column TEXT,
    
    -- Whether this link can be traversed in both directions
    is_bidirectional BOOLEAN DEFAULT true,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    
    -- Constraints
    UNIQUE(ontology_id, api_name),
    
    -- Validate that FK fields are set for non-M2M cardinalities
    -- Validate that join table fields are set for M2M cardinality
    -- (These are enforced in application code, not SQL constraints, because 
    --  CHECK constraints can't do conditional field validation across columns cleanly)
    
    -- Validate that source and target object types actually exist
    -- (Enforced in application code by querying object_type table before insert)
    CONSTRAINT valid_source_target CHECK (
        source_object_type_api_name IS NOT NULL AND 
        target_object_type_api_name IS NOT NULL
    )
);

-- Index for fast lookup by source or target object type
CREATE INDEX idx_link_type_source ON link_type(source_object_type_api_name);
CREATE INDEX idx_link_type_target ON link_type(target_object_type_api_name);
CREATE INDEX idx_link_type_ontology ON link_type(ontology_id);
```

**Application-level validations that MUST be enforced when inserting a link type:**

1. The `source_object_type_api_name` must reference an existing object type in the same ontology. Query the `object_type` table to verify: `SELECT 1 FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If no row is returned, reject the request with HTTP 400 and the error message: `"Source object type '${sourceObjectType}' does not exist in this ontology."`.

2. The `target_object_type_api_name` must reference an existing object type in the same ontology. Same validation as above but for the target.

3. If cardinality is `ONE_TO_ONE`, `ONE_TO_MANY`, or `MANY_TO_ONE`, then `foreign_key_property_api_name` and `foreign_key_side` must be provided and must not be null. The property referenced by `foreign_key_property_api_name` must actually exist on the object type indicated by `foreign_key_side`. For example, if `foreign_key_side` is `'source'` and `source_object_type_api_name` is `'Employee'`, then the property `foreign_key_property_api_name` (e.g., `'companyId'`) must exist in the `property` table for the Employee object type. Verify with: `SELECT 1 FROM property p JOIN object_type ot ON p.object_type_id = ot.object_type_id WHERE ot.api_name = $1 AND p.api_name = $2`. If validation fails, return HTTP 400 with: `"Foreign key property '${fkProp}' does not exist on object type '${objectType}'."`.

4. If cardinality is `MANY_TO_MANY`, then `join_table_file_path`, `join_table_source_column`, and `join_table_target_column` must all be provided and must not be null. The file at `join_table_file_path` does not need to exist yet (it can be uploaded later), but the fields must be present in the request. If any are missing, return HTTP 400 with: `"Many-to-many link types require join_table_file_path, join_table_source_column, and join_table_target_column."`.

5. If cardinality is `MANY_TO_MANY`, then `foreign_key_property_api_name` and `foreign_key_side` must be null. These fields are mutually exclusive with the join table fields. If both are provided, return HTTP 400 with: `"Many-to-many link types use join tables, not foreign keys. Remove foreign_key_property_api_name and foreign_key_side."`.

6. The `api_name` must be unique within the ontology. The UNIQUE constraint in PostgreSQL handles this, but you should catch the unique violation error (code `23505`) and return a friendly HTTP 409 with: `"A link type with api_name '${apiName}' already exists in this ontology."`.

7. A link type can connect an object type to itself (self-referential links). For example, an Employee can manage other Employees. Do not reject requests where `source_object_type_api_name === target_object_type_api_name`.

**Default values:**
- `is_bidirectional`: defaults to `true` (most links are bidirectional in Palantir).
- `description`: defaults to `NULL` (optional field).
- `created_at` and `updated_at`: default to `now()`.

**Enum enforcement:** The `cardinality` column uses a SQL `CHECK` constraint (line 22-27 in the SQL above) to enforce valid values at the database level. The `foreign_key_side` column uses a separate `CHECK` constraint (line 38) to enforce `'source'` or `'target'`. Application-level validation in Task 2 should also validate these values before attempting the INSERT to provide better error messages.

**File to modify:** `src/db/migrations.js` — add this table creation to the migration sequence, after the `object_type` and `property` tables (which must exist first because the application-level validations reference them).

**Testing:**
1. Run the migration. Verify the table exists: `\dt link_type` in psql.
2. Verify all columns have the correct types: `\d link_type` in psql.
3. Verify the 3 indexes exist: `\di` in psql — should show `idx_link_type_source`, `idx_link_type_target`, `idx_link_type_ontology`.
4. Verify the CHECK constraint on `cardinality`: attempt `INSERT INTO link_type (ontology_id, api_name, display_name, source_object_type_api_name, target_object_type_api_name, cardinality) VALUES (gen_random_uuid(), 'test', 'test', 'A', 'B', 'INVALID')` — should fail with CHECK violation.
5. Verify the UNIQUE constraint: insert two rows with the same `(ontology_id, api_name)` — should fail with unique violation error code `23505`.
