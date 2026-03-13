## TASK 25: Build the Health Check and System Status Endpoint

### Context
Production systems need health monitoring. This task builds comprehensive health check endpoints that report the status of every component in the system: PostgreSQL connectivity, OpenSearch connectivity, disk space, and Ontology statistics. RRA's IT team will use these endpoints to monitor the system and set up alerts.

### Exact Specification

Create the endpoints in a new file `/src/routes/health.js` and register them in `server.js`.

**Endpoint 1: `GET /api/v2/health`**

Simple health check for load balancers and monitoring. Must respond within 500ms.

Response (HTTP 200 if healthy, 503 if unhealthy):
```json
{
  "status": "healthy",
  "timestamp": "2025-03-15T14:00:00.000Z",
  "uptime": 86400,
  "version": "1.0.0"
}
```

The `version` field is read from `package.json`: `require('../../package.json').version`.

Check PostgreSQL with a simple `SELECT 1` query (timeout: 2 seconds).
Check OpenSearch with a `GET /` call (timeout: 2 seconds).
If either fails, return status "unhealthy" with HTTP 503.

**Endpoint 2: `GET /api/v2/status`**

Comprehensive system status with statistics. May take longer (up to 10 seconds).

Response:
```json
{
  "system": {
    "status": "healthy",
    "uptime": 86400,
    "version": "1.0.0",
    "nodeVersion": "v20.11.0",
    "memoryUsage": {
      "rss": "125 MB",
      "heapUsed": "78 MB",
      "heapTotal": "120 MB"
    }
  },
  "postgresql": {
    "status": "connected",
    "responseTime": 2,
    "version": "PostgreSQL 16.1"
  },
  "opensearch": {
    "status": "connected",
    "responseTime": 5,
    "version": "2.17.0",
    "clusterHealth": "green",
    "totalIndices": 3,
    "totalDocuments": 1050,
    "storageSize": "4.2 MB"
  },
  "ontology": {
    "ontologyCount": 1,
    "objectTypeCount": 3,
    "totalObjects": 1050,
    "linkTypeCount": 2,
    "actionTypeCount": 4,
    "interfaceCount": 1,
    "objectTypes": [
      { "apiName": "Employee", "objectCount": 1000, "lastIndexed": "2025-03-15T12:00:00Z", "indexHealth": "healthy" },
      { "apiName": "Company", "objectCount": 5, "lastIndexed": "2025-03-15T12:00:00Z", "indexHealth": "healthy" },
      { "apiName": "Product", "objectCount": 45, "lastIndexed": "2025-03-15T13:00:00Z", "indexHealth": "stale" }
      // indexHealth per object type uses the same rules as Task 15:
      // "healthy" = last reindex succeeded within 24 hours AND zero pending (unindexed) edits
      // "stale" = last reindex was >24 hours ago OR there are pending edits
      // "failed" = last reindex failed
      // "never_indexed" = no reindex has ever been run
    ]
  },
  "datasets": {
    "totalDatasets": 3,
    "totalTransactions": 7,
    "totalStorageBytes": 152340,
    "totalStorageHuman": "148.8 KB"
  },
  "edits": {
    "totalEdits": 62,
    "pendingEdits": 0,
    "indexedEdits": 62
  }
}
```

Collect these statistics by querying:
- `SELECT COUNT(*) FROM object_type` (and similar for other tables)
- OpenSearch `_cluster/health` API
- OpenSearch `_cat/indices?format=json` for per-index stats
- `SELECT object_type_api_name, COUNT(*) FROM ontology_edit GROUP BY object_type_api_name, indexed`
- `process.memoryUsage()` for Node.js memory stats
- `process.uptime()` for uptime

### Validation Criteria
- /health responds in under 500ms
- /health returns 503 when PostgreSQL is down
- /health returns 503 when OpenSearch is down
- /status returns comprehensive statistics matching actual data
- Object type counts match reality
- OpenSearch document counts match indexed objects
