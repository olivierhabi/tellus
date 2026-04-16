# TASK 25 OF 30: Object Type Summary Statistics

**Objective:** Add a statistics endpoint that returns aggregated metrics about an object type: property counts by type, datasource status, indexing metrics, and a computed health indicator.

**Step-by-step instructions:**

**Part 1: Add getStatistics method to src/services/objectTypeService.js**

The method accepts `ontologyId` and `apiName`. Implementation:

1. Look up the object type: `SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If not found, throw `OBJECT_TYPE_NOT_FOUND`.
2. Query property statistics:
   - Total count: `SELECT COUNT(*) FROM property WHERE object_type_id = $1`
   - Count by base_type: `SELECT base_type, COUNT(*) as count FROM property WHERE object_type_id = $1 GROUP BY base_type`
   - Required count: `SELECT COUNT(*) FROM property WHERE object_type_id = $1 AND is_required = true`
   - Array count: `SELECT COUNT(*) FROM property WHERE object_type_id = $1 AND is_array = true`
3. Fetch backing datasource: `SELECT * FROM backing_datasource WHERE object_type_id = $1` (may be null).
4. Fetch funnel state: `SELECT * FROM funnel_state WHERE object_type_id = $1` (may be null).
5. Compute `propertyCapacityUsed`: `(propertyCount / object_type.max_properties * 100).toFixed(1) + "%"`.
6. Compute `health` based on funnel state:
   - If funnel_state is null or status is `'not_indexed'` → `"not_indexed"`
   - If status is `'indexing'` → `"indexing"`
   - If status is `'indexed'` and `objects_failed === 0` and `edits_pending === 0` → `"healthy"`
   - If status is `'indexed'` and (`edits_pending > 0` or `objects_failed > 0`) → `"warning"`
   - If status is `'stale'` → `"warning"`
   - If status is `'failed'` → `"error"`

Return this exact structure:
```json
{
  "statistics": {
    "propertyCount": 10,
    "propertiesByType": {"string": 5, "double": 2, "date": 2, "boolean": 1},
    "requiredPropertyCount": 3,
    "arrayPropertyCount": 0,
    "propertyCapacityUsed": "0.5%",
    "datasource": {
      "status": "registered",
      "filePath": "/tmp/ontology-testdata/taxpayers.csv",
      "fileFormat": "csv",
      "rowCount": 100,
      "lastScanned": "2025-03-11T12:00:00Z"
    },
    "indexing": {
      "status": "not_indexed",
      "objectsIndexed": 0,
      "objectsFailed": 0,
      "editsPending": 0,
      "lastIndexedAt": null,
      "lastDurationMs": null
    },
    "health": "not_indexed"
  }
}
```

If no datasource is registered, the `datasource` field is `null`.
If no funnel_state exists, the `indexing` field is `null` and `health` is `"not_indexed"`.

**Part 2: Add route to src/routes/objectTypes.js**

`GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/statistics`

Call `objectTypeService.getStatistics(ontologyId, apiName)`. Return HTTP 200 with `sendSuccess(res, result)`.

**Files to modify:** src/services/objectTypeService.js, src/routes/objectTypes.js

**Verification:**
- `GET .../objectTypes/Taxpayer/statistics` after seeding → propertyCount: 10, propertiesByType includes "string": 6, datasource.rowCount: 100, health: "not_indexed"
- `GET .../objectTypes/NonExistent/statistics` → 404 OBJECT_TYPE_NOT_FOUND
- After an object type is created with no datasource → datasource: null, health: "not_indexed"
