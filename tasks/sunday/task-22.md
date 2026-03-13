# TASK 22: OpenSearch Connection Resilience

This task has three sub-tasks.

## Objective
Enhance the OpenSearch client to handle transient connection failures gracefully. OpenSearch may be temporarily unavailable during restarts, network hiccups, or cluster rebalancing. The client must retry failed requests and provide clear error messages when retries are exhausted.

## Exact Specification

Update `/src/opensearch.js` to configure the client with retry logic and connection monitoring:

## Sub-task 22A: Client Configuration and Health Monitoring

Update `/src/opensearch.js` with retry configuration and health monitoring:

```javascript
const { Client } = require('@opensearch-project/opensearch');

const client = new Client({
  node: process.env.OPENSEARCH_URL || 'http://localhost:9200',
  
  // Retry configuration
  maxRetries: 3,              // Retry up to 3 times on failure
  requestTimeout: 30000,       // 30 second timeout per request
  
  // Connection pool configuration
  sniffOnStart: false,         // Don't auto-discover nodes (single node for dev)
  sniffInterval: false,        // Don't periodically discover nodes
  
  // Compression
  compression: 'gzip',        // Compress request/response bodies
});

// Connection health monitoring
let opensearchHealthy = true;
let lastHealthCheck = null;

async function checkOpenSearchHealth() {
  try {
    const result = await client.cluster.health({ timeout: '5s' });
    opensearchHealthy = result.body.status !== 'red';
    lastHealthCheck = {
      status: result.body.status,
      checkedAt: new Date().toISOString(),
      numberOfNodes: result.body.number_of_nodes,
    };
    return lastHealthCheck;
  } catch (err) {
    opensearchHealthy = false;
    lastHealthCheck = {
      status: 'unreachable',
      checkedAt: new Date().toISOString(),
      error: err.message,
    };
    return lastHealthCheck;
  }
}

// Check health on startup
checkOpenSearchHealth().then(health => {
  console.log(JSON.stringify({ type: 'opensearch_health', ...health }));
});

// Periodic health check every 30 seconds
setInterval(checkOpenSearchHealth, 30000);

// Wrapper function that adds context to OpenSearch errors
async function safeQuery(operation, params) {
  try {
    return await operation(params);
  } catch (err) {
    // Enhance error with context
    if (err.meta && err.meta.statusCode === 404 && params.index) {
      const enhancedError = new Error(`OpenSearch index '${params.index}' not found. Has this Object Type been indexed?`);
      enhancedError.meta = err.meta;
      enhancedError.originalError = err;
      throw enhancedError;
    }
    if (err.message && err.message.includes('ECONNREFUSED')) {
      const enhancedError = new Error('Cannot connect to OpenSearch. Is the service running?');
      enhancedError.meta = { statusCode: 503 };
      enhancedError.originalError = err;
      throw enhancedError;
    }
    throw err;
  }
}

module.exports = { 
  client, 
  checkOpenSearchHealth, 
  getHealthStatus: () => ({ healthy: opensearchHealthy, ...lastHealthCheck }),
  safeQuery,
};
```

---

## Sub-task 22C: Refactor Existing OpenSearch Call Sites

**Depends on:** Sub-task 22A

Audit all files in `/src/routes/` and `/src/services/` that call `opensearchClient` methods directly. Wrap each call site with `safeQuery` or ensure it has a try-catch that produces a meaningful error message (not a raw SDK error). No OpenSearch call site in the codebase should expose raw `ECONNREFUSED` or SDK errors to the API consumer.

---

## Sub-task 22B: safeQuery Wrapper and bulkIndex Function

Add the `safeQuery` function to `/src/opensearch.js` (as shown in Sub-task 22A above). Additionally, add the `bulkIndex` function to `/src/services/indexer.js` (not to `opensearch.js`, since it is specific to the indexing workflow):

The `safeQuery` wrapper is particularly important for the indexer (`/src/services/indexer.js`) because a failed bulk indexing operation needs to report which specific documents failed:

```javascript
async function bulkIndex(indexName, documents) {
  const body = [];
  for (const doc of documents) {
    body.push({ index: { _index: indexName, _id: doc.__pk } });
    body.push(doc);
  }
  
  const result = await client.bulk({ body, refresh: 'wait_for' });
  
  if (result.body.errors) {
    const failedItems = result.body.items.filter(item => item.index.error);
    const errors = failedItems.map(item => ({
      documentId: item.index._id,
      error: item.index.error.reason,
      type: item.index.error.type,
    }));
    
    console.error(JSON.stringify({
      type: 'bulk_index_partial_failure',
      index: indexName,
      totalDocuments: documents.length,
      failedDocuments: errors.length,
      errors: errors.slice(0, 10), // Log first 10 failures
    }));
    
    return {
      success: false,
      totalIndexed: documents.length - errors.length,
      totalFailed: errors.length,
      errors,
    };
  }
  
  return {
    success: true,
    totalIndexed: documents.length,
    totalFailed: 0,
    errors: [],
  };
}
```

The `refresh: 'wait_for'` option in the bulk API call ensures that indexed documents are immediately searchable after the API returns. Without this, there's a 1-second delay (the refresh interval) before new documents appear in search results. For week 1 where the primary use case is "upload → index → immediately query," this synchronous refresh is important. In production at scale, you'd remove this and accept eventual consistency.

## Verification
1. Start the server with OpenSearch running → verify health check logs "green" status
2. Stop OpenSearch → make a query → verify error message says "Cannot connect to OpenSearch" (not a raw ECONNREFUSED)
3. Start OpenSearch again → verify health check recovers to "green" within 30 seconds
4. Index 100 documents where 2 have invalid data (e.g., string in a numeric field) → verify partial failure is reported with the specific 2 failed document IDs
5. Verify `refresh: 'wait_for'` is used → index a document and immediately search for it → verify it appears (no 1-second delay)
6. Verify the periodic health check interval (check logs for health check entries every 30 seconds)
