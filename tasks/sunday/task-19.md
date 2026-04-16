# TASK 19: Health Check and Status Endpoints

This task has two sub-tasks.

**Depends on:** Task 22 (`checkOpenSearchHealth`), Task 23 (`checkPostgresHealth`). If those tasks are not yet complete, implement the health checks inline in this task and refactor later.

## Objective
Build a comprehensive health check endpoint that reports the status of all system components (PostgreSQL, OpenSearch) and provides operational metrics (object counts, indexing status, uptime). This endpoint is used by monitoring systems, load balancers, and the human operator to verify the system is working correctly.

## Exact Specification

## Sub-task 19A: Simple Health Check Endpoint

**Endpoint 1:** `GET /api/v1/health`

This is a simple "is the system alive" check for load balancers. It should return quickly (<100ms) and only check basic connectivity.

**Response (HTTP 200 if healthy, HTTP 503 if unhealthy):**
```json
{
  "status": "healthy",
  "timestamp": "2025-03-16T18:00:00.000Z",
  "uptime": 86400,
  "version": "1.0.0"
}
```

If PostgreSQL or OpenSearch is unreachable:
```json
{
  "status": "unhealthy",
  "timestamp": "2025-03-16T18:00:00.000Z",
  "uptime": 86400,
  "version": "1.0.0",
  "issues": ["PostgreSQL connection failed", "OpenSearch cluster is red"]
}
```

**Implementation:**
Check PostgreSQL with `SELECT 1` and OpenSearch with `GET /` (cluster info). Both checks must have a 3-second timeout. If either times out, report it as unhealthy.

Use `Promise.allSettled()` (not `Promise.all()`) so that a failure in one check doesn't prevent the other from reporting:

```javascript
const [pgResult, osResult] = await Promise.allSettled([
  pool.query('SELECT 1').then(() => ({ name: 'postgresql', status: 'connected' })),
  opensearchClient.cluster.health({ timeout: '3s' }).then(r => ({ name: 'opensearch', status: r.body.status })),
]);
```

---

## Sub-task 19B: Detailed Status Endpoint

**Endpoint 2:** `GET /api/v1/status`

This is a detailed status endpoint for operators and monitoring dashboards. It returns comprehensive system information.

**Response (HTTP 200):**
```json
{
  "data": {
    "system": {
      "status": "healthy",
      "uptime": 86400,
      "version": "1.0.0",
      "nodeVersion": "v20.11.0",
      "memoryUsage": {
        "heapUsed": 45000000,
        "heapTotal": 67000000,
        "rss": 89000000,
        "external": 1200000
      },
      "startedAt": "2025-03-15T18:00:00.000Z"
    },
    "postgresql": {
      "status": "connected",
      "host": "localhost:5432",
      "database": "ontology",
      "poolSize": { "total": 10, "idle": 8, "waiting": 0 }
    },
    "opensearch": {
      "status": "green",
      "clusterName": "docker-cluster",
      "numberOfNodes": 1,
      "numberOfDataNodes": 1,
      "activePrimaryShards": 5,
      "activeShards": 5,
      "relocatingShards": 0,
      "unassignedShards": 0
    },
    "ontology": {
      "ontologyCount": 1,
      "objectTypeCount": 3,
      "totalObjectsIndexed": 1050,
      "linkTypeCount": 2,
      "actionTypeCount": 3,
      "interfaceCount": 2,
      "objectTypeSummary": [
        { "apiName": "Employee", "objectCount": 1000, "propertyCount": 10, "lastIndexedAt": "2025-03-16T14:30:00Z" },
        { "apiName": "Company", "objectCount": 50, "propertyCount": 5, "lastIndexedAt": "2025-03-16T14:25:00Z" }
      ]
    },
    "recentActivity": {
      "actionsExecutedLast24h": 47,
      "objectsIndexedLast24h": 1050,
      "queriesLast24h": 523,
      "errorsLast24h": 3
    }
  }
}
```

**For the ontology section**, run these queries:
```sql
-- Object type count
SELECT COUNT(*) FROM object_type WHERE ontology_id = $1;

-- Link type count
SELECT COUNT(*) FROM link_type WHERE ontology_id = $1;

-- Action type count
SELECT COUNT(*) FROM action_type WHERE ontology_id = $1;

-- Interface count
SELECT COUNT(*) FROM interface WHERE ontology_id = $1;

-- Per-object-type summary
SELECT 
  ot.api_name,
  (SELECT COUNT(*) FROM property WHERE object_type_id = ot.object_type_id) AS property_count,
  fs.last_indexed_at,
  fs.object_count
FROM object_type ot
LEFT JOIN funnel_state fs ON fs.object_type_id = ot.object_type_id
WHERE ot.ontology_id = $1
ORDER BY ot.api_name;
```

Note: `funnel_state` is a table that should have been created in Day 2 to track indexing state. If it doesn't exist, create it via a new migration file at `/src/migrations/009_create_funnel_state.sql` (not inline in the route handler):
```sql
CREATE TABLE IF NOT EXISTS funnel_state (
  object_type_id UUID PRIMARY KEY REFERENCES object_type(object_type_id),
  last_indexed_at TIMESTAMPTZ,
  object_count INT DEFAULT 0,
  last_duration_ms INT,
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle','running','failed'))
);
```

For the OpenSearch object counts, query each index:
```javascript
for (const ot of objectTypes) {
  const countResult = await opensearchClient.count({ index: `ontology-${ot.api_name.toLowerCase()}` });
  ot.objectCount = countResult.body.count;
}
```

**For the recentActivity section**, query the audit log:
```sql
SELECT COUNT(*) FROM action_audit_log WHERE executed_at > now() - interval '24 hours';
```

The queries and errors counts require either a separate metrics table (that the request logger and error handler write to) or simply counting rows in the audit log. For week 1, just count audit log entries. Add a TODO comment for proper metrics collection later.

**Performance:** The status endpoint makes multiple database queries. Use `Promise.all()` to execute them in parallel. Target: status endpoint should respond in under 500ms.

## Verification
1. GET /health when everything is running → verify 200 with status "healthy"
2. Stop OpenSearch → GET /health → verify 503 with status "unhealthy" and issue listed
3. Start OpenSearch again → GET /health → verify returns to 200
4. GET /status → verify all sections populated with correct counts
5. Verify objectTypeSummary lists all object types with correct object counts
6. Verify OpenSearch section shows correct cluster health
7. Verify memoryUsage shows reasonable values (not 0, not negative)
8. Verify uptime increases between calls
9. Execute 5 actions → verify recentActivity.actionsExecutedLast24h increments
