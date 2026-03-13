# TASK 10: Build the Object Existence Checker for Create/Modify/Delete Validation

**Objective:** Create a utility module that checks whether objects exist in the Ontology (OpenSearch). This module is used by both the parameter validator (for `object_reference` parameters) and the rule compiler (for `modifyObject` and `deleteObject` rules). It needs to be fast because it's called multiple times during action execution, and it needs to handle edge cases correctly.

Palantir's documentation states specific behaviors for object existence:
- Creating an object with a PK that already exists should fail (documented as "duplicate_primary_key" failure type)
- Modifying an object that doesn't exist should fail (documented as "object_not_found" failure type)
- Deleting an object that doesn't exist should fail (same failure type)

**Create the module** at `src/actions/objectChecker.js`.

**The module exports these functions:**

```javascript
/**
 * Checks if a single object exists in the Ontology.
 * 
 * @param {string} objectTypeApiName - The object type to check in
 * @param {string} primaryKey - The primary key to look for
 * @returns {Promise<boolean>} true if the object exists, false otherwise
 * 
 * Implementation: Use OpenSearch's GET document API with _source: false
 * (we only need to know if it exists, not fetch the full document).
 * 
 * opensearchClient.exists({
 *     index: `ontology-${objectTypeApiName.toLowerCase()}`,
 *     id: primaryKey
 * })
 * 
 * Handle errors:
 * - 404 response: return false (object doesn't exist)
 * - Index not found (object type never indexed): return false
 * - Connection error: THROW (don't silently return false, because that could
 *   cause a create action to succeed when it should fail due to duplicate PK)
 */
async function objectExists(objectTypeApiName, primaryKey) {}

/**
 * Fetches a single object from the Ontology.
 * 
 * @param {string} objectTypeApiName - The object type
 * @param {string} primaryKey - The primary key
 * @returns {Promise<Object|null>} The full object (all properties), or null if not found
 * 
 * Implementation: Use OpenSearch's GET document API.
 * Return the _source field of the response.
 * Return null if the document is not found (404).
 * THROW on connection errors.
 */
async function fetchObject(objectTypeApiName, primaryKey) {}

/**
 * Checks existence of multiple objects in a single request.
 * More efficient than calling objectExists() in a loop.
 * 
 * @param {string} objectTypeApiName - The object type
 * @param {Array<string>} primaryKeys - Array of primary keys to check
 * @returns {Promise<Map<string, boolean>>} Map of primaryKey → exists
 * 
 * Implementation: Use OpenSearch's multi-get (_mget) API:
 * opensearchClient.mget({
 *     index: `ontology-${objectTypeApiName.toLowerCase()}`,
 *     body: { ids: primaryKeys },
 *     _source: false
 * })
 * 
 * Parse the response: each doc has a "found" field (boolean).
 * Return a Map where keys are primary keys and values are booleans.
 * 
 * If primaryKeys array is empty, return an empty Map immediately (don't hit OpenSearch).
 * If primaryKeys array has more than 10,000 elements, chunk into batches of 10,000
 * and execute multiple _mget requests. Merge results.
 */
async function batchCheckExistence(objectTypeApiName, primaryKeys) {}

/**
 * Fetches multiple objects in a single request.
 * 
 * @param {string} objectTypeApiName - The object type
 * @param {Array<string>} primaryKeys - Array of primary keys
 * @returns {Promise<Map<string, Object>>} Map of primaryKey → object (only for found objects)
 * 
 * Implementation: Use OpenSearch's _mget API with _source: true.
 * Only include found documents in the returned Map.
 * Chunk into batches of 10,000 if needed.
 */
async function batchFetchObjects(objectTypeApiName, primaryKeys) {}

/**
 * Validates that an object type exists and has been indexed.
 * This checks the PostgreSQL metadata AND verifies the OpenSearch index exists.
 * 
 * @param {string} ontologyId - The ontology
 * @param {string} objectTypeApiName - The object type to check
 * @returns {Promise<{exists: boolean, indexed: boolean, objectCount: number}>}
 *   - exists: true if the object type is defined in PostgreSQL
 *   - indexed: true if the OpenSearch index exists and has documents
 *   - objectCount: number of documents in the index (0 if not indexed)
 * 
 * Implementation:
 * 1. Query object_type table for this api_name
 * 2. If not found: return { exists: false, indexed: false, objectCount: 0 }
 * 3. If found: check OpenSearch:
 *    opensearchClient.count({ index: `ontology-${apiName.toLowerCase()}` })
 *    If index doesn't exist (404): return { exists: true, indexed: false, objectCount: 0 }
 *    If index exists: return { exists: true, indexed: true, objectCount: response.body.count }
 */
async function checkObjectType(ontologyId, objectTypeApiName) {}
```

**Error handling is CRITICAL in this module.** The difference between "object doesn't exist" and "I couldn't check because OpenSearch is down" must be clear. If OpenSearch is unreachable, every function must THROW an error, not return false/null. Returning false when the check failed would allow actions to proceed incorrectly (e.g., creating a duplicate object because we couldn't detect the existing one).

```javascript
// WRONG — silently returns false on connection error
async function objectExists(objectType, pk) {
    try {
        await opensearchClient.get({ index: `ontology-${objectType.toLowerCase()}`, id: pk });
        return true;
    } catch (e) {
        return false; // BUG: This returns false even for connection errors!
    }
}

// CORRECT — distinguishes "not found" from "error"
async function objectExists(objectType, pk) {
    try {
        const response = await opensearchClient.exists({
            index: `ontology-${objectType.toLowerCase()}`,
            id: pk
        });
        return response.body; // true or false
    } catch (e) {
        if (e.meta && e.meta.statusCode === 404) {
            // Index itself doesn't exist — object type was never indexed
            return false;
        }
        // Connection error, timeout, etc. — THROW, don't silently return false
        throw new Error(`Failed to check object existence for ${objectType}/${pk}: ${e.message}`);
    }
}
```

**Test cases:**
```javascript
// Object that exists
const exists = await objectExists('Employee', 'EMP-001');
assert(exists === true);

// Object that doesn't exist
const missing = await objectExists('Employee', 'EMP-NONEXISTENT');
assert(missing === false);

// Object type that was never indexed (no OpenSearch index)
const noIndex = await objectExists('NonexistentType', 'KEY-1');
assert(noIndex === false);

// Batch check
const batch = await batchCheckExistence('Employee', ['EMP-001', 'EMP-002', 'EMP-NONEXISTENT']);
assert(batch.get('EMP-001') === true);
assert(batch.get('EMP-002') === true);
assert(batch.get('EMP-NONEXISTENT') === false);

// Fetch object
const obj = await fetchObject('Employee', 'EMP-001');
assert(obj !== null);
assert(obj.employeeId === 'EMP-001');

// Fetch missing object
const nullObj = await fetchObject('Employee', 'EMP-NONEXISTENT');
assert(nullObj === null);

// Check object type
const typeCheck = await checkObjectType('ontology-id', 'Employee');
assert(typeCheck.exists === true);
assert(typeCheck.indexed === true);
assert(typeCheck.objectCount > 0);
```
