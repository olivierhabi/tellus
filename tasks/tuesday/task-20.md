# TASK 20: Create the Object Count by Type Query

**File to create:** `/src/services/opensearch/objectCounter.js`

**Purpose:** Provides fast count queries across all object types. Used by the status dashboard and by the Ontology Manager to show how many objects exist for each type.

**Specification:**

Export:

1. **`countByObjectType(objectTypeApiName)`** — Returns the document count for a single object type's index.
   - Import the OpenSearch client from Task 1's `/src/services/opensearch/client.js`.
   - Import `getIndexName` from Task 3 to compute the index name.
   - Call `client.count({ index: indexName })` to get the document count.
   - Return:
     ```javascript
     { apiName: "Employee", indexName: "ontology-employee", count: 1000 }
     ```
   - If the index does not exist, return: `{ apiName: "Employee", indexName: "ontology-employee", count: 0, exists: false }`.
   - If OpenSearch is unreachable, throw with a descriptive error.

2. **`countAllObjectTypes()`** — Queries all indices matching the `ontology-*` pattern and returns counts for each. Uses `client.cat.indices({ index: "ontology-*", format: "json" })` which returns index name, document count, and store size for each index.

   **Reverse lookup for `apiName`:** To recover the original `apiName` (with correct casing) from the index name, query the `object_type` table in PostgreSQL, matching on lowercased `api_name`. If no matching object type is found for an index, use the index name with the `ontology-` prefix stripped as a fallback.

   Return:
   ```javascript
   {
     objectTypes: [
       { apiName: "Employee", indexName: "ontology-employee", count: 1000, sizeBytes: 500000 },
       { apiName: "Company", indexName: "ontology-company", count: 50, sizeBytes: 25000 }
     ],
     totalObjects: 1050
   }
   ```

   - If no `ontology-*` indices exist, return: `{ objectTypes: [], totalObjects: 0 }`.
   - If OpenSearch is unreachable, throw with a descriptive error.

**Test to verify:** Index two object types, call `countByObjectType` for each and verify correct counts. Call `countAllObjectTypes` and verify both appear with correct totals. Call `countByObjectType` for a non-existent type and verify `{ count: 0, exists: false }`.
