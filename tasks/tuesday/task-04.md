# TASK 4: Create the Index Lifecycle Manager

**File to create:** `/src/services/opensearch/indexLifecycleManager.js`

**Purpose:** This module manages the lifecycle of OpenSearch indices — creating them, checking if they exist, deleting them, and updating their mappings when object type properties change. In Palantir's architecture, when you create an object type and register a backing datasource in Ontology Manager, the system automatically creates the corresponding index in Object Storage V2. When you add or modify properties, the index mapping is updated. When you delete an object type, the index is deleted.

**Detailed specification:**

The module must export the following functions:

1. **`createIndex(objectTypeApiName)`** — Creates a new OpenSearch index for the given object type.

   Step-by-step logic:
   - Call `generateIndexMapping(objectTypeApiName)` from Task 3 to get the mapping document.
   - Check if an index with this name already exists by calling `client.indices.exists({ index: indexName })`.
   - If the index already exists, throw an error: `"Index '{indexName}' already exists for object type '{objectTypeApiName}'. Use recreateIndex() to rebuild, or deleteIndex() first."` This prevents accidental data loss from silently overwriting an existing index.
   - If the index does not exist, create it by calling `client.indices.create({ index: indexName, body: mapping })`.
   - After creation, verify the index was created successfully by calling `client.indices.get({ index: indexName })` and checking that the mapping contains all expected fields.
   - Log the action: `"Created index '{indexName}' for object type '{objectTypeApiName}' with {propertyCount} properties"`.
   - Return: `{ success: true, indexName, objectTypeApiName, propertyCount, createdAt: new Date().toISOString() }`.
   - If the `client.indices.create` call fails, catch the error and return a descriptive error. Common failure reasons: index name is invalid (contains uppercase letters, spaces, or special characters), or OpenSearch is out of disk space.

2. **`deleteIndex(objectTypeApiName)`** — Deletes the OpenSearch index for the given object type.

   Step-by-step logic:
   - Compute the index name using the same naming convention as Task 3.
   - Check if the index exists. If it does not exist, return: `{ success: true, message: "Index '{indexName}' does not exist, nothing to delete" }`. This is idempotent — calling delete on a non-existent index is not an error.
   - If the index exists, call `client.indices.delete({ index: indexName })`.
   - Log: `"Deleted index '{indexName}' for object type '{objectTypeApiName}'"`.
   - Return: `{ success: true, indexName, deletedAt: new Date().toISOString() }`.

3. **`recreateIndex(objectTypeApiName)`** — Deletes and recreates the index. This is used when the object type's properties change in a way that requires a new mapping (for example, changing a property's type from string to integer — OpenSearch does not allow changing field types on an existing index).

   Step-by-step logic:
   - Call `deleteIndex(objectTypeApiName)`.
   - Call `createIndex(objectTypeApiName)`.
   - Return the result of `createIndex` with an additional field `recreated: true`.
   - WARNING: This destroys all indexed data! The caller must re-index after calling this. Log a warning: `"WARNING: Recreated index '{indexName}' — all previously indexed data has been deleted. A full reindex is required."`.

4. **`updateMapping(objectTypeApiName)`** — Adds new fields to an existing index mapping without deleting data. This is used when a new property is added to an object type (a non-destructive change). OpenSearch allows adding new fields to an existing mapping but does NOT allow modifying or removing existing fields.

   Step-by-step logic:
   - Call `generateIndexMapping(objectTypeApiName)` to get the current desired mapping.
   - Get the existing index mapping from OpenSearch by calling `client.indices.getMapping({ index: indexName })`.
   - Compare the existing properties with the desired properties. Identify:
     - **New properties:** Present in desired but not in existing → these will be added.
     - **Unchanged properties:** Present in both with the same mapping → no action needed.
     - **Changed properties:** Present in both but with different mappings → CANNOT be updated in place. Log a warning: `"Property '{propName}' mapping has changed. This requires recreateIndex() to take effect."` Return the list of changed properties in the response so the caller knows a recreate is needed.
     - **Removed properties:** Present in existing but not in desired → OpenSearch does not support removing fields from a mapping. Log a warning: `"Property '{propName}' has been removed from the object type but cannot be removed from the OpenSearch mapping. The field will remain in the index but will no longer be populated."`.
   - If there are new properties, call `client.indices.putMapping({ index: indexName, body: { properties: { ...newFields } } })` to add them.
   - Return: `{ success: true, indexName, addedProperties: [...], unchangedProperties: [...], changedProperties: [...], removedProperties: [...] }`.

5. **`indexExists(objectTypeApiName)`** — Simple check whether the index exists.
   - Returns: `{ exists: true|false, indexName }`.

6. **`getIndexStats(objectTypeApiName)`** — Returns statistics about the index.
   - Call `client.indices.stats({ index: indexName })`.
   - Extract and return: `{ indexName, documentCount, storeSizeBytes, storeSizeHuman, lastRefreshTime }`.
   - Format `storeSizeHuman` using binary units: bytes for values < 1024, KB for values < 1,048,576, MB for values < 1,073,741,824, GB otherwise. Display one decimal place (e.g., "4.2 MB", "1.3 GB", "415 KB"). Use 1024 as the divisor.
   - If the index does not exist, return: `{ indexName, exists: false }`.
   - If OpenSearch is unreachable, throw with a descriptive error including the connection error details.

7. **`getIndexName(objectTypeApiName)`** — Re-exports the `getIndexName` function from Task 3's `/src/services/opensearch/indexMappingGenerator.js` for convenience. This module does NOT re-implement the naming logic — it imports and re-exports from the canonical source (Task 3). All modules may import `getIndexName` from either Task 3 or Task 4.

**Test to verify:** Create an index for "Employee", verify it exists, add a new property to the object type in PostgreSQL, call `updateMapping`, verify the new field appears in the index mapping. Then call `deleteIndex` and verify the index no longer exists.
