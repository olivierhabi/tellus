# TASK 30: Create the System Health Check Endpoint

**File to create:** `/src/routes/health.js`

**Endpoint:** `GET /api/v2/status`

**Purpose:** Returns comprehensive system health information including the status of all backend services and a summary of indexed data. This is the endpoint the human operator uses at the end of each day to verify everything is working.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-03-11T18:00:00.000Z",
  "services": {
    "postgresql": {
      "connected": true,
      "version": "PostgreSQL 16.1",
      "tables": {
        "ontology": { "rowCount": 1 },
        "object_type": { "rowCount": 3 },
        "property": { "rowCount": 28 },
        "backing_datasource": { "rowCount": 2 },
        "link_type": { "rowCount": 0 },
        "action_type": { "rowCount": 0 },
        "ontology_edit": { "rowCount": 0 },
        "funnel_pipeline_state": { "rowCount": 2 }
      }
    },
    "opensearch": {
      "connected": true,
      "clusterName": "docker-cluster",
      "clusterStatus": "green",
      "nodeCount": 1,
      "indices": {
        "count": 2,
        "totalDocuments": 1050,
        "totalSizeBytes": 525000,
        "details": [
          { "name": "ontology-employee", "documents": 1000, "sizeBytes": 500000 },
          { "name": "ontology-company", "documents": 50, "sizeBytes": 25000 }
        ]
      }
    }
  },
  "ontology": {
    "objectTypes": [
      { "apiName": "Employee", "propertyCount": 10, "objectCount": 1000, "lastIndexed": "2025-03-11T10:30:00Z", "indexStatus": "success" },
      { "apiName": "Company", "propertyCount": 5, "objectCount": 50, "lastIndexed": "2025-03-11T11:00:00Z", "indexStatus": "success" }
    ],
    "linkTypes": [],
    "actionTypes": [],
    "totalObjects": 1050
  },
  "uptime": "8h 30m 15s",
  "version": "0.1.0-day2"
}
```

**Implementation details:**

- All response values are dynamic — query at request time. The JSON example above is illustrative of the response shape only, not hardcoded values.
- **PostgreSQL table counts:** Query these specific tables: `ontology`, `object_type`, `property`, `backing_datasource`, `link_type`, `action_type`, `ontology_edit`, `funnel_pipeline_state`. If a table does not exist yet (e.g., not yet created via migration), return `{ "rowCount": 0, "error": "table does not exist" }` for that table rather than failing the entire endpoint.
- **OpenSearch data:** Use `getIndexStats` from Task 4 and `countAllObjectTypes` from Task 20.
- **Funnel state:** Use `getAllStates` from Task 13.
- **Uptime:** Use `process.uptime()` to get seconds since Node.js process start. Format as `"{h}h {m}m {s}s"` where h, m, s are whole numbers derived from the total seconds.
- **Version:** Read from `require('../../package.json').version`.
- **Overall status:** `"healthy"` if both PostgreSQL and OpenSearch connections succeed, `"degraded"` if one fails, `"unhealthy"` if both fail.

This aggregates information from Tasks 4, 13, and 20.

**Verification command after all 30 tasks are complete:**

```bash
# 1. Run the full test suite
npm test -- --grep "fullPipelineTest"

# 2. Check the health endpoint
curl http://localhost:3000/api/v2/status | jq .

# 3. Manually verify: create an object type, upload CSV, index, query
curl -X POST http://localhost:3000/api/v2/ontology/{id}/objectTypes/Employee/index
curl http://localhost:3000/api/v2/ontology/{id}/objectTypes/Employee/indexing/status
```

**If all 30 tasks pass, Day 2 is complete. Move to Day 3: Query API.**
