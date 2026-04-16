# TASK 17: Create the Index Auto-Creation Hook

**File to create:** `/src/services/indexing/autoCreateHook.js`

**Purpose:** When a backing datasource is registered for an object type (via the Day 1 API endpoint `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource`), the OpenSearch index should be automatically created. In Palantir, registering a backing datasource automatically triggers index creation and the first sync. This module provides the hook function that creates the index.

**Specification:**

Export a function `onDatasourceRegistered(objectTypeApiName)` that:
1. Calls `generateIndexMapping(objectTypeApiName)` from Task 3 to generate the mapping.
2. Checks if the index already exists via `indexExists(objectTypeApiName)` from Task 4. If it already exists, return `{ indexCreated: false, indexAlreadyExists: true, indexName: "ontology-{name}" }`.
3. Creates the index via `createIndex(objectTypeApiName)` from Task 4. If creation fails, throw with a descriptive error including the underlying OpenSearch error.
4. Does NOT automatically trigger indexing (the user must explicitly call the index endpoint from Task 14). This is a deliberate choice for Week 1 to keep things simple. In Palantir, registration triggers an automatic first sync, but we'll add that behavior later.
5. Returns: `{ indexCreated: true, indexName: "ontology-employee" }`

**Error handling:**
- If `generateIndexMapping` throws (object type not found, no properties), propagate the error to the caller.
- If `createIndex` throws (OpenSearch unreachable, invalid index name), throw with message: `"Failed to auto-create index for object type '{objectTypeApiName}': {originalError.message}"`.

**Integration (NOT part of this task):** The Day 1 datasource registration endpoint should call `onDatasourceRegistered` after the datasource record is saved to PostgreSQL. That integration is the responsibility of whoever modifies the Day 1 route handler — it is tracked separately and is NOT in scope for this task. This task only creates the hook module.

**Test to verify:** Call `onDatasourceRegistered("Employee")` after creating an Employee object type with properties. Verify the OpenSearch index is created with the correct mapping. Call again — verify it returns `{ indexCreated: false, indexAlreadyExists: true }`.
