# TASK 16: Create the Indexing API Endpoint — Delete Index

**File to modify:** `/src/routes/indexing.js` (add route to the file created in Task 14)

**Endpoint:** `DELETE /api/v1/ontology/:ontologyId/objectTypes/:apiName/index`

**Purpose:** Deletes the OpenSearch index for an object type. All indexed objects are permanently deleted. The object type definition in PostgreSQL is NOT affected — only the indexed data in OpenSearch is removed. After calling this, the object type will have no queryable objects until it is re-indexed.

This is equivalent to Palantir's "unregister backing datasource" operation, which "prevents its data from appearing in user applications and also removes the history of user data edits."

**Validation:**
1. Verify the ontology exists by querying PostgreSQL. If not found, return 404: `{ error: { code: "ONTOLOGY_NOT_FOUND", message: "Ontology '{ontologyId}' not found" } }`.
2. Verify the object type exists in this ontology. If not found, return 404: `{ error: { code: "OBJECT_TYPE_NOT_FOUND", message: "Object type '{apiName}' not found in ontology '{ontologyId}'" } }`.
3. Check the funnel pipeline state by calling `getState(objectTypeApiName)` from Task 13. If status is `'running'`, return 409: `{ error: { code: "INDEXING_IN_PROGRESS", message: "Cannot delete index for '{apiName}' while indexing is in progress." } }`.

**Execution:**
- Call `deleteIndex(apiName)` from Task 4.
- Call `setState(objectTypeApiName, { status: 'idle', objects_indexed: 0, error_message: null })` from Task 13.

**Idempotent behavior:** If the index does not exist in OpenSearch (already deleted or never created), Task 4's `deleteIndex` returns success. This endpoint also returns 200 in that case — deleting a non-existent index is not an error.

**Response (200):**
```json
{
  "status": "success",
  "message": "Index 'ontology-employee' has been deleted. All indexed objects have been removed. Re-index to restore.",
  "objectTypeApiName": "Employee",
  "indexName": "ontology-employee"
}
```

**Response (200 — index did not exist):**
```json
{
  "status": "success",
  "message": "Index 'ontology-employee' does not exist, nothing to delete.",
  "objectTypeApiName": "Employee",
  "indexName": "ontology-employee"
}
```

**Response (404 — ontology or object type not found):**
```json
{ "error": { "code": "OBJECT_TYPE_NOT_FOUND", "message": "Object type '{apiName}' not found in ontology '{ontologyId}'" } }
```

**Response (409 — indexing in progress):**
```json
{ "error": { "code": "INDEXING_IN_PROGRESS", "message": "Cannot delete index for '{apiName}' while indexing is in progress." } }
```

**Test to verify:** Create an index, call DELETE, verify 200 and index no longer exists. Call DELETE again on the same type, verify 200 (idempotent). Call DELETE while indexing is running, verify 409.
