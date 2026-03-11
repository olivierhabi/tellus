# TASK 11 OF 30: Ontology Service Layer

**Objective:** Create the service layer for Ontology CRUD operations with five methods: create, getById, list, update, and delete. The service layer contains all business logic and database queries, keeping route handlers thin. This is the simplest service and establishes the pattern for all other services.

**Step-by-step instructions:**

Create src/services/ontologyService.js. Export an object with five async methods:

**Method 1: create({displayName, description, createdBy})**

- `displayName` (required string), `description` (optional string, defaults to null), `createdBy` (optional string, defaults to 'system').
- Check uniqueness: `SELECT ontology_id FROM ontology WHERE display_name = $1`. If a row exists, throw an error with `code: 'ONTOLOGY_ALREADY_EXISTS'` and `message: "An ontology with display name '{displayName}' already exists."`.
- Insert: `INSERT INTO ontology (display_name, description, created_by) VALUES ($1, $2, $3) RETURNING *`.
- Return the full DB row.

**Method 2: getById(ontologyId)**

- `ontologyId` (UUID string).
- Query: `SELECT * FROM ontology WHERE ontology_id = $1`. If no row, throw `{code: 'ONTOLOGY_NOT_FOUND', message: "Ontology '{ontologyId}' not found."}`.
- Also query object type count: `SELECT COUNT(*)::int as count FROM object_type WHERE ontology_id = $1`.
- Return the ontology row with `objectTypeCount` added as a property.

**Method 3: list({pageSize, pageToken})**

- `pageSize` (integer, default 100, max 1000), `pageToken` (string or null).
- Decode pageToken to get offset (default 0) using `decodePageToken` from Task 9.
- Total count: `SELECT COUNT(*)::int FROM ontology`.
- Page query with object type counts:
  ```sql
  SELECT o.*, COALESCE(ot_count.count, 0)::int as object_type_count
  FROM ontology o
  LEFT JOIN (SELECT ontology_id, COUNT(*) as count FROM object_type GROUP BY ontology_id) ot_count
    ON o.ontology_id = ot_count.ontology_id
  ORDER BY o.created_at DESC
  LIMIT $1 OFFSET $2
  ```
- Compute nextPageToken: if `offset + pageSize < totalCount`, encode `offset + pageSize`. Otherwise null.
- Return `{data: rows, totalCount, pageSize, nextPageToken}`.

**Method 4: update(ontologyId, {displayName, description})**

- At least one field must be provided.
- Build a dynamic UPDATE: only SET the fields present in the input. Always SET `updated_at = NOW()`.
- Use `RETURNING *`. If no row returned, throw `ONTOLOGY_NOT_FOUND`.
- Catch PostgreSQL error code `23505` (unique violation on display_name) and throw `ONTOLOGY_ALREADY_EXISTS` with message "An ontology with display name '{displayName}' already exists."
- Return the updated row.

**Method 5: delete(ontologyId)**

- Check existence: `SELECT ontology_id FROM ontology WHERE ontology_id = $1`. If not found, throw `ONTOLOGY_NOT_FOUND`.
- Delete: `DELETE FROM ontology WHERE ontology_id = $1`.
- Due to ON DELETE CASCADE on object_type, this cascades through: object_type → property, backing_datasource, funnel_state.
- Log: `console.log("Deleted ontology ${ontologyId} with all cascaded resources")`.
- Return void (no return value).

All methods use parameterized queries (`$1`, `$2`, etc.) — never concatenate user input into SQL.

**Files to create:** src/services/ontologyService.js

**Verification:**
- `create({displayName: "Test"})` → returns row with generated UUID, created_at, and all fields
- `create({displayName: "Test"})` again → throws `{code: 'ONTOLOGY_ALREADY_EXISTS'}`
- `getById(validId)` → returns ontology with `objectTypeCount: 0`
- `getById('non-existent-uuid')` → throws `{code: 'ONTOLOGY_NOT_FOUND'}`
- `list({pageSize: 10})` → returns `{data: [...], totalCount, pageSize: 10, nextPageToken: null}`
- `update(id, {displayName: "New Name"})` → returns row with updated displayName and new updated_at
- `update(id, {displayName: "Existing Name"})` where name exists → throws `ONTOLOGY_ALREADY_EXISTS`
- `delete(id)` → ontology deleted, all object types cascaded
