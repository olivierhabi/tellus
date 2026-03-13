## TASK 7: Build the Reindex Engine with Multi-Transaction File Merging

### Context
This is the most important task of the day. The reindex engine (Palantir calls it the "Object Data Funnel") reads data from the backing datasource and indexes it into OpenSearch. In Days 1-2, we built a simple indexer that reads a single CSV file. Now we need to upgrade it to handle the Dataset abstraction properly.

The key challenge is **multi-transaction merging**. A dataset may have multiple committed transactions: an initial SNAPSHOT plus several APPENDs. The reindex engine must read ALL committed transaction files, merge them by primary key (if a PK appears in multiple files, the one from the latest transaction wins), and index the merged result.

In Palantir's own words: "Object Storage V2 uses a 'most recent transaction wins' strategy. If the dataset contains more than one row for the same primary key, the data of the row in the most recent transaction will be present in the Ontology."

Additionally, the engine must preserve user edits. When a user executes an Action to modify an Employee's salary, that edit is stored in the `ontology_edit` table. When the datasource is reindexed (because new data was uploaded), the user's edit must NOT be overwritten by the datasource data. User edits take precedence.

### Exact Specification

Create or update the file `/src/services/reindexService.js` with the following function:

**Function: `reindexObjectType(ontologyId, objectTypeApiName)`**

This function performs a complete reindex of a single object type. It returns a result object with statistics about the operation.

**Step 1: Load metadata from PostgreSQL**

Query the object type, its properties, and its backing datasource:
```sql
-- Get object type with properties
SELECT ot.*, 
  json_agg(json_build_object(
    'apiName', p.api_name, 
    'baseType', p.base_type, 
    'isRequired', p.is_required,
    'structSchema', p.struct_schema
  )) as properties
FROM object_type ot
JOIN property p ON p.object_type_id = ot.object_type_id
WHERE ot.api_name = $1
GROUP BY ot.object_type_id;

-- Get backing datasource
SELECT bs.*, d.dataset_id, d.format
FROM backing_datasource bs
LEFT JOIN dataset d ON bs.dataset_id = d.dataset_id
WHERE bs.object_type_id = $1;
```

If no backing datasource is registered, throw an error:
```json
{ "error": "NO_BACKING_DATASOURCE", "message": "Object type 'Employee' has no registered backing datasource. Register one first." }
```

**Step 2: Determine which files to read**

There are two cases:

Case A: `dataset_id` is set (new Dataset model):
```sql
SELECT file_path, type, committed_at
FROM dataset_transaction
WHERE dataset_id = $1 AND status = 'committed'
ORDER BY committed_at ASC;
```
This returns all committed transaction files in chronological order. We need ALL of them to build the complete picture.

Case B: `dataset_id` is NULL, `file_path` is set (legacy mode):
Use just the single file_path. Treat it as a single SNAPSHOT.

**Step 3: Read and merge all transaction files (includes Step 5's duplicate PK check)**

This is the core logic. Create an in-memory Map (JavaScript `Map`) keyed by primary key value. Process each transaction file in chronological order (oldest first). For each transaction, also check for duplicate PKs within that single file (Step 5 logic is embedded here, not a separate phase):

```javascript
const objectMap = new Map(); // key = primary key value, value = { properties }

for (const txn of transactions) {
  // Import readCsvFile / readJsonFile from /src/utils/fileReader.js (Task 11)
  // Dispatch based on dataset format:
  const { rows } = datasetFormat === 'csv'
    ? await readCsvFile(txn.file_path)
    : await readJsonFile(txn.file_path);

  // Step 5 (duplicate PK check) — performed WITHIN this loop, per-transaction:
  const seenInTransaction = new Set();

  for (const row of rows) {
    const pkValue = row[primaryKeyColumn];

    if (pkValue === null || pkValue === undefined || pkValue === '') {
      // Skip rows with null primary key — Palantir behavior:
      // "Your primary key selection must uniquely identify a single row"
      stats.skippedNullPk++;
      continue;
    }

    // Duplicate PK within same transaction = error
    const pkStr = String(pkValue);
    if (seenInTransaction.has(pkStr)) {
      throw new Error(`Duplicate primary key '${pkStr}' found within transaction '${txn.transaction_id}'. Each primary key must appear only once per transaction.`);
    }
    seenInTransaction.add(pkStr);

    // Map CSV/JSON columns to Ontology properties using columnMapping
    const doc = {};
    for (const [propApiName, columnName] of Object.entries(columnMapping)) {
      const rawValue = row[columnName];
      const property = propertiesMap.get(propApiName);
      if (property) {
        // Import convertValue from /src/utils/typeConverter.js (Task 12)
        doc[propApiName] = convertValue(rawValue, property.baseType);
      }
    }

    // "Most recent transaction wins" — later transactions overwrite earlier ones
    objectMap.set(pkStr, doc);
  }
}
```

The `convertValue(rawValue, baseType)` function is imported from `/src/utils/typeConverter.js` (Task 12). It must handle all Palantir base types:
- `string` → String(value), or null if empty
- `integer` → parseInt(value, 10), or null if NaN
- `long` → parseInt(value, 10) (same as integer in JavaScript)
- `double` / `float` → parseFloat(value), or null if NaN
- `boolean` → value === 'true' || value === '1' || value === true
- `date` → validate format YYYY-MM-DD, return as string, or null if invalid
- `timestamp` → validate ISO 8601 format, return as string, or null if invalid
- `geopoint` → parse as { lat: number, lon: number } from either a JSON string or "lat,lon" format
- `string_array` → if the value is a string, split by "|" delimiter; if already an array, use as-is
- `integer_array` → same split logic, then parseInt each element
- `struct` → if the value is a JSON string, parse it; if already an object, use as-is

**Step 4: Check for required property violations**

After merging, iterate through the objectMap and check each object against property definitions:
```javascript
for (const [pk, doc] of objectMap) {
  for (const prop of requiredProperties) {
    if (doc[prop.apiName] === null || doc[prop.apiName] === undefined) {
      // Palantir behavior: "if there is any null value currently set on the backing column for the property, the reindex will fail"
      throw new Error(`Required property '${prop.apiName}' has null value for object with primary key '${pk}'. Reindex aborted.`);
    }
  }
}
```

**Step 5: (Duplicate PK check — integrated into Step 3 above)**

The duplicate PK check within a single transaction is performed during the file-reading loop in Step 3 (see the `seenInTransaction` Set above). It is NOT a separate phase — it must execute within the per-transaction loop, not after all files are read.

**Step 6: Apply user edits (edit preservation)**

This is critical. After building the objectMap from datasource data, overlay any pending user edits from the `ontology_edit` table:

```sql
SELECT * FROM ontology_edit
WHERE object_type_api_name = $1 AND indexed = false
ORDER BY executed_at ASC;
```

Process edits in chronological order:
```javascript
for (const edit of pendingEdits) {
  switch (edit.operation) {
    case 'create':
      // User created an object that doesn't exist in the datasource
      objectMap.set(edit.primary_key, edit.property_values);
      break;
    case 'update':
      // User modified properties — merge with existing, user values win
      const existing = objectMap.get(edit.primary_key) || {};
      objectMap.set(edit.primary_key, { ...existing, ...edit.property_values });
      break;
    case 'delete':
      // User deleted an object — remove from map
      objectMap.delete(edit.primary_key);
      break;
  }
}
```

This ensures that if an employee's salary was changed to 150K via an Action, and the original CSV still says 100K, the Ontology will show 150K after reindex. This is the "edit preservation" behavior.

**Step 7: Build OpenSearch bulk index request**

```javascript
const bulkBody = [];
const indexName = `ontology-${objectTypeApiName.toLowerCase()}`;

for (const [pk, doc] of objectMap) {
  bulkBody.push({ index: { _index: indexName, _id: pk } });
  bulkBody.push({
    __pk: pk,
    __objectType: objectTypeApiName,
    __lastModified: new Date().toISOString(),
    __version: 1,
    ...doc
  });
}
```

**Step 8: Delete the existing index and recreate with current mapping**

For week 1 (full reindex only), we delete and recreate the index to ensure clean state:
```javascript
// Delete existing index if it exists
try {
  await opensearchClient.indices.delete({ index: indexName });
} catch (e) {
  // Index might not exist yet — that's fine
}

// Create index with current mapping — generate using the existing
// generateIndexMapping(objectType, properties) function from Day 2's /src/services/indexingService.js
const indexMapping = generateIndexMapping(objectType, properties);
await opensearchClient.indices.create({ index: indexName, body: indexMapping });
```

**Step 9: Execute the bulk index**

```javascript
if (bulkBody.length > 0) {
  const result = await opensearchClient.bulk({ body: bulkBody, refresh: 'wait_for' });
  
  if (result.body.errors) {
    const errorItems = result.body.items.filter(item => item.index.error);
    throw new Error(`Bulk indexing failed for ${errorItems.length} objects. First error: ${JSON.stringify(errorItems[0].index.error)}`);
  }
}
```

The `refresh: 'wait_for'` parameter ensures that indexed documents are immediately searchable after the bulk operation completes. This matches Palantir's behavior where reindexed data appears in user applications after the sync completes.

**Step 10: Mark edits as indexed**

```sql
UPDATE ontology_edit SET indexed = true, indexed_at = now()
WHERE object_type_api_name = $1 AND indexed = false;
```

**Step 11: Update funnel_state**

```sql
INSERT INTO funnel_state (object_type_id, last_indexed_transaction_id, last_indexed_at, objects_indexed, index_status, duration_ms)
VALUES ($1, $2, now(), $3, 'completed', $4)
ON CONFLICT (object_type_id) DO UPDATE SET
  last_indexed_transaction_id = EXCLUDED.last_indexed_transaction_id,
  last_indexed_at = EXCLUDED.last_indexed_at,
  objects_indexed = EXCLUDED.objects_indexed,
  index_status = EXCLUDED.index_status,
  duration_ms = EXCLUDED.duration_ms,
  error_message = NULL;
```

**Step 12: Return result**

```javascript
// Capture datasource count BEFORE applying edits (Step 6)
const objectsFromDatasource = objectMap.size;

// ... (Step 6 applies edits here — see above) ...

return {
  objectType: objectTypeApiName,
  status: 'completed',
  transactionsProcessed: transactions.length,
  objectsFromDatasource: objectsFromDatasource,
  editsApplied: {
    creates: createCount,
    updates: updateCount,
    deletes: deleteCount
  },
  totalObjectsIndexed: objectMap.size,
  skippedNullPk: stats.skippedNullPk,
  durationMs: Date.now() - startTime
};
```

### Error Handling

If ANY step fails:
1. Update `funnel_state` with `index_status = 'failed'` and `error_message = error.message`
2. Do NOT delete the partially indexed data — leave the index in whatever state it's in (Palantir shows failed syncs and lets users retry)
3. Throw the error so the API endpoint can return it

### Validation Criteria
- Single SNAPSHOT file indexes correctly
- SNAPSHOT + APPEND correctly merges (APPEND rows appear alongside original rows)
- Duplicate PK across transactions: most recent transaction wins
- Duplicate PK within a single transaction: reindex fails with error
- Required property with null value: reindex fails with error
- User edit (update salary) is preserved after reindex — salary stays at the user-edited value
- User edit (create new object) appears in index even though it's not in the datasource
- User edit (delete object) removes it from index even though it's still in the datasource
- After successful reindex, `funnel_state` is updated
- After successful reindex, `ontology_edit.indexed` is set to true
- Empty dataset (0 rows): creates an empty index (no error)
- Large dataset (10K rows): completes without running out of memory
