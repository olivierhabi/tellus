# TASK 13 OF 30: Object Type Service Layer

**Objective:** Create the service layer for Object Type CRUD with five methods: create, getByApiName, listByOntology, update, and delete. This is the most complex service because object types have relationships with properties, datasources, and funnel state that must all be returned together.

**Step-by-step instructions:**

Create src/services/objectTypeService.js with these five methods:

**Method 1: create(ontologyId, data)**

Accepts ontologyId and an object with: apiName (required), displayName (required), description (optional), icon (optional, defaults to 'cube'), iconColor (optional, defaults to '#1565C0'), status (optional, defaults to 'active').

Implementation steps:
1. Validate apiName using `validateObjectTypeName` from the validator utility (Task 8). If invalid, throw an error with code `INVALID_API_NAME` and the specific validation error message.
2. Check that the ontology exists: `SELECT ontology_id FROM ontology WHERE ontology_id = $1`. If not found, throw `ONTOLOGY_NOT_FOUND`.
3. Insert: `INSERT INTO object_type (ontology_id, api_name, display_name, description, icon, icon_color, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`. Catch PostgreSQL unique constraint violation (error code 23505) and throw `OBJECT_TYPE_ALREADY_EXISTS`.
4. Create the funnel_state record: `INSERT INTO funnel_state (object_type_id, status) VALUES ($1, 'not_indexed')`.
5. Return the created object_type row.

**Method 2: getByApiName(ontologyId, apiName)**

This method executes four separate queries (not a single JOIN) and assembles the result:
1. `SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2` — if no row returned, throw `OBJECT_TYPE_NOT_FOUND`.
2. `SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal, api_name`
3. `SELECT * FROM backing_datasource WHERE object_type_id = $1`
4. `SELECT * FROM funnel_state WHERE object_type_id = $1`

Return: `{objectType: row, properties: rows, datasource: row || null, funnelState: row || null}`. The route handler passes all four parts to `formatObjectType` (Task 9).

**Method 3: listByOntology(ontologyId, paginationParams)**

Accepts ontologyId and pagination params (pageSize, pageToken). Query object types with summary data using LEFT JOINs:
```sql
SELECT ot.*, COUNT(p.property_id) as property_count,
       ds.dataset_name as datasource_name,
       fs.status as index_status, fs.objects_indexed
FROM object_type ot
LEFT JOIN property p ON ot.object_type_id = p.object_type_id
LEFT JOIN backing_datasource ds ON ot.object_type_id = ds.object_type_id
LEFT JOIN funnel_state fs ON ot.object_type_id = fs.object_type_id
WHERE ot.ontology_id = $1
GROUP BY ot.object_type_id, ds.dataset_name, fs.status, fs.objects_indexed
ORDER BY ot.created_at DESC
LIMIT $2 OFFSET $3
```
Return paginated results using `encodePageToken`/`decodePageToken` from Task 9.

**Method 4: update(ontologyId, apiName, data)**

Accepts ontologyId, apiName, and an object with optional fields: displayName, description, icon, iconColor, status. At least one field must be provided.

Implementation:
1. Build a dynamic UPDATE query that only sets the fields present in `data`. Always set `updated_at = NOW()`.
2. Use `RETURNING *` to get the updated row.
3. If no row is returned (object type doesn't exist), throw `OBJECT_TYPE_NOT_FOUND`.
4. If status is being changed to 'deprecated', log a warning: "Object type {apiName} set to deprecated — dependent applications may break."
5. If the new displayName conflicts with an existing object type (PostgreSQL error 23505), throw `OBJECT_TYPE_ALREADY_EXISTS`.
6. Return the updated row.

**Method 5: delete(ontologyId, apiName)**

Implementation:
1. Look up the object type: `SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If not found, throw `OBJECT_TYPE_NOT_FOUND`.
2. Guard check for link_type references: The link_type table does not exist in the current 30-task scope (it is planned for a future sprint). Check if the table exists by querying `pg_tables` for `table_name = 'link_type'`. If the table exists, query: `SELECT link_type_id, api_name FROM link_type WHERE source_object_type = $1 OR target_object_type = $1`. If any exist, throw `VALIDATION_FAILED` with message `"Cannot delete object type: referenced by link types: [names]"`. If the link_type table does not exist yet, skip this check.
3. Delete: `DELETE FROM object_type WHERE object_type_id = $1`. CASCADE handles properties, backing_datasource, and funnel_state.
4. Return void.

**Files to create:** src/services/objectTypeService.js

**Verification:**
- `create` with valid data → returns row with generated UUID and creates funnel_state with status 'not_indexed'
- `create` with duplicate apiName in same ontology → throws OBJECT_TYPE_ALREADY_EXISTS
- `getByApiName` → returns object type with properties array, datasource (or null), and funnelState (or null)
- `getByApiName` with non-existent apiName → throws OBJECT_TYPE_NOT_FOUND
- `listByOntology` → returns paginated list with property_count, datasource_name, and index_status
- `update` with new displayName → returns updated row with new updated_at timestamp
- `delete` → object type and all associated properties, datasource, funnel_state are removed
