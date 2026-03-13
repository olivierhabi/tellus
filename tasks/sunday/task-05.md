# TASK 5: Create the Object Type ↔ Interface Mapping Table

## Objective
Create the PostgreSQL table that records which Object Types implement which Interfaces, along with the property mapping that connects Interface properties to Object Type properties. This is the bridge table that enables polymorphism in the Ontology.

## Exact Specification

Create a migration file at `/src/migrations/008_create_object_type_interface.sql` with the following table:

`object_type_interface` table columns:

- `object_type_id`: UUID type, NOT NULL, FOREIGN KEY referencing `object_type(object_type_id)` with ON DELETE CASCADE. If an Object Type is deleted, its Interface implementations are automatically removed.

- `interface_id`: UUID type, NOT NULL, FOREIGN KEY referencing `interface(interface_id)` with ON DELETE RESTRICT. You cannot delete an Interface that has implementing Object Types (this is enforced at both the application layer in Task 4 and the database layer here with RESTRICT). The RESTRICT behavior means the database will reject the delete if any rows reference this Interface, providing a safety net even if the application-layer check has a bug.

- `property_mapping`: JSONB type, NOT NULL. This stores the mapping from Interface property API names to Object Type property API names. The shape is: `{ "interfacePropApiName": "objectTypePropApiName" }`. For example, if the HasLocation Interface has properties `latitude` and `longitude`, and the Airport Object Type has properties `airportLatitude` and `airportLongitude`, the mapping would be: `{ "latitude": "airportLatitude", "longitude": "airportLongitude" }`. Every REQUIRED Interface property must appear as a key in this mapping. Optional Interface properties may or may not appear.

- `created_at`: TIMESTAMPTZ type, NOT NULL, DEFAULT now().

- PRIMARY KEY on `(object_type_id, interface_id)`. An Object Type can implement a given Interface only once. This prevents duplicate implementations.

Additionally, create an index on `interface_id` for efficient lookups of all Object Types implementing a given Interface (used by the polymorphic query in Task 8).

**Constraints that MUST be enforced (at the application layer, not the database, because they require cross-table validation):**

1. Every REQUIRED Interface property must have a mapping entry. If the HasLocation Interface has `latitude` (required) and `locationName` (optional), the property_mapping must contain at least `{ "latitude": "someObjectTypeProp" }`. The `locationName` key may be omitted.

2. Each mapped Object Type property must actually exist on the Object Type. If the mapping says `{ "latitude": "airportLatitude" }`, the "airportLatitude" property must exist in the `property` table for this Object Type.

3. The base_type of the mapped Object Type property must match the base_type of the Interface property. If the Interface declares `latitude` as `double`, the mapped Object Type property must also be `double`. A mapping of a `string` property to a `double` Interface property is invalid.

4. A single Object Type property can be mapped to at most one Interface property within a single Interface implementation. You cannot map `airportLatitude` to both `latitude` and `longitude`. However, the same Object Type property CAN be mapped to properties in DIFFERENT Interfaces (e.g., `airportLatitude` could map to `latitude` in HasLocation and `coordinateX` in HasCoordinates — these are separate Interface implementations).

5. An Object Type can implement multiple Interfaces. For example, Airport could implement both HasLocation and Auditable. Each implementation is a separate row in this table.

These 5 constraints must all be validated in the API endpoint (Task 6) before inserting into this table. The database cannot enforce them because they require JOINs across multiple tables during validation.

## Verification
1. Run the migration → verify table exists with correct columns and constraints
2. Insert a valid row → succeeds
3. Insert a duplicate (same object_type_id and interface_id) → fails on PRIMARY KEY
4. Delete an Object Type that has implementations → CASCADE removes the implementation rows
5. Try to DELETE an Interface that has implementations → RESTRICT prevents the delete
6. Insert a row with syntactically valid but semantically incorrect JSON in property_mapping (e.g., `{"foo": "bar"}` where `foo` is not an Interface property name) → PostgreSQL should accept it (JSONB accepts any valid JSON), but the application layer (Task 6) must reject semantically invalid mappings before insertion
