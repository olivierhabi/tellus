## TASK 13: Build the Edit Preservation Verification Endpoint

### Context
One of the most critical behaviors of Palantir's Ontology is edit preservation: when a user modifies an object via an Action, and then the backing datasource is reindexed (because new data was uploaded), the user's edit must NOT be overwritten. The edit takes precedence over the datasource data. This task builds an endpoint that allows users to verify which edits exist for an object type and their current state (indexed or pending).

This is also a debugging tool — when something seems wrong after a reindex, the user can check whether their edits were applied correctly.

### Exact Specification

**Endpoint 1: `GET /api/v2/ontology/:ontologyId/objectTypes/:apiName/edits`**

Returns all edits for the specified object type, with filtering and pagination.

Query parameters:
- `pageSize` (integer, default: 50, max: 500)
- `pageToken` (string, optional): base64-encoded executed_at timestamp for cursor pagination
- `indexed` (boolean, optional): Filter by indexed status. If "true", show only indexed edits. If "false", show only pending (unindexed) edits. If omitted, show all.
- `operation` (string, optional): Filter by operation type. One of: "create", "update", "delete"
- `primaryKey` (string, optional): Filter edits for a specific object by primary key

SQL query:
```sql
SELECT e.*, at.display_name as action_display_name
FROM ontology_edit e
LEFT JOIN action_type at ON e.action_type_api_name = at.api_name
WHERE e.object_type_api_name = $1
  AND ($2::boolean IS NULL OR e.indexed = $2)
  AND ($3::text IS NULL OR e.operation = $3)
  AND ($4::text IS NULL OR e.primary_key = $4)
  AND ($5::timestamptz IS NULL OR e.executed_at < $5)
ORDER BY e.executed_at DESC
LIMIT $6;
```

Response:
```json
{
  "data": [
    {
      "editId": "...",
      "objectType": "Employee",
      "primaryKey": "EMP-001",
      "operation": "update",
      "propertyValues": { "salary": 150000 },
      "actionType": "updateSalary",
      "actionDisplayName": "Update Employee Salary",
      "executedBy": "system",
      "executedAt": "2025-03-15T10:30:00.000Z",
      "indexed": true,
      "indexedAt": "2025-03-15T10:31:00.000Z"
    },
    {
      "editId": "...",
      "objectType": "Employee",
      "primaryKey": "EMP-NEW-001",
      "operation": "create",
      "propertyValues": { "employeeId": "EMP-NEW-001", "fullName": "New Hire", "salary": 90000 },
      "actionType": "createEmployee",
      "actionDisplayName": "Create Employee",
      "executedBy": "system",
      "executedAt": "2025-03-15T11:00:00.000Z",
      "indexed": false,
      "indexedAt": null
    }
  ],
  "summary": {
    "totalEdits": 7,
    "pendingEdits": 1,
    "indexedEdits": 6,
    "byOperation": { "create": 2, "update": 4, "delete": 1 }
  },
  "nextPageToken": "..."
}
```

**Endpoint 2: `GET /api/v2/ontology/:ontologyId/objectTypes/:apiName/edits/diff/:primaryKey`**

This endpoint shows the difference between the datasource value and the current Ontology value (including edits) for a specific object. This lets users see exactly what edits are being preserved.

Response:
```json
{
  "primaryKey": "EMP-001",
  "objectType": "Employee",
  "datasourceValues": {
    "employeeId": "EMP-001",
    "fullName": "Melissa Chang",
    "salary": 100000,
    "department": "Engineering"
  },
  "currentOntologyValues": {
    "employeeId": "EMP-001",
    "fullName": "Melissa Chang",
    "salary": 150000,
    "department": "Engineering"
  },
  "appliedEdits": [
    {
      "editId": "...",
      "operation": "update",
      "propertyValues": { "salary": 150000 },
      "actionType": "updateSalary",
      "executedAt": "2025-03-15T10:30:00.000Z"
    }
  ],
  "diff": {
    "salary": { "datasource": 100000, "ontology": 150000, "source": "user_edit" }
  }
}
```

To compute the `datasourceValues`, the endpoint must:
1. Read all committed transaction files for the backing datasource's dataset (using `readCsvFile`/`readJsonFile` from `/src/utils/fileReader.js` — Task 11)
2. Merge rows using the same "most recent transaction wins" logic as Step 3 of the reindex engine (Task 7). Refactor the reindex engine's file-reading/merging code into a reusable function (e.g., `readAndMergeDatasourceRows(objectTypeApiName)`) if not already done.
3. Find the row matching the primary key in the merged result
4. Apply column mapping to convert raw column values to property-keyed values
5. Do NOT apply user edits — these are the raw datasource values

If the object exists only via an Action-created edit (no row in datasource), `datasourceValues` should be `null` and the diff should show all Ontology properties as `source: "user_edit"`.

If the primaryKey does not exist in either datasource or the Ontology (OpenSearch), return HTTP 404:
```json
{ "error": "OBJECT_NOT_FOUND", "message": "Object with primary key 'EMP-999' not found in datasource or Ontology." }
```

To compute the `currentOntologyValues`, the endpoint queries OpenSearch for the object by primary key.

The `diff` object only includes properties where the datasource value differs from the current Ontology value (i.e., where a user edit has changed the value). Each diff entry has `source: "user_edit"` — since the diff only contains properties where values differ, and the only reason they differ is because a user edit changed the Ontology value, the source is always `"user_edit"`. Properties where datasource and Ontology values match are NOT included in the diff.

### Validation Criteria
- GET /edits returns all edits for an object type, sorted newest first
- Filtering by indexed=false returns only pending edits
- Filtering by operation="update" returns only update edits
- Filtering by primaryKey returns only edits for that object
- Pagination with pageToken correctly advances through results
- The summary object accurately counts total/pending/indexed/byOperation
- GET /edits/diff shows the correct difference between datasource and Ontology
- GET /edits/diff for an object created entirely via Action shows `datasourceValues: null` and all properties in the diff
- GET /edits/diff for a non-existent primary key returns HTTP 404
- After reindex, previously pending edits become indexed
- The diff correctly identifies which properties were changed by user edits (source is always "user_edit" in the diff)
