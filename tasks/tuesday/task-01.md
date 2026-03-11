# TASK 1: Create the OpenSearch Client Connection Module

**File to create:** `/src/services/opensearch/client.js`

**Purpose:** This module establishes and manages the connection to the OpenSearch cluster. It is the single point of contact between your application and OpenSearch. Every other module that needs to interact with OpenSearch will import this module rather than creating their own connections. This is critical because OpenSearch connections are expensive to establish and should be reused via connection pooling. In Palantir's architecture, the Object Storage V2 service maintains persistent connections to the underlying search engine cluster, and we need to replicate that pattern.

**Detailed specification:**

You must create a module that exports a singleton OpenSearch client instance configured for the development environment. The client must be created using the `@opensearch-project/opensearch` npm package (already installed from the prerequisites). The connection must point to `http://localhost:9200` by default, but this value must be configurable via an environment variable called `OPENSEARCH_URL` so that the connection can be changed in production without modifying code.

The module must export the following:

1. **`client`** — The singleton OpenSearch client instance. This is the raw client object from the `@opensearch-project/opensearch` package. Other modules will use this to make direct API calls when the wrapper functions below are insufficient.

2. **`ping()`** — An async function that tests the connection to OpenSearch by calling the `client.cluster.health()` API. It must return an object with the following shape: `{ connected: true, clusterName: "docker-cluster", status: "green"|"yellow"|"red", numberOfNodes: 1 }`. If the connection fails, it must return `{ connected: false, error: "Connection refused" }` (or whatever the actual error message is). This function is used by the health check endpoint (Task 30) to verify OpenSearch is reachable.

3. **`waitForConnection(maxRetries, delayMs)`** — An async function that attempts to connect to OpenSearch with retries. This is necessary because when the application starts, OpenSearch might not be ready yet (especially in Docker environments where containers start in parallel). The function must attempt to call `ping()` up to `maxRetries` times (default: 10), waiting `delayMs` milliseconds (default: 2000) between attempts. If all retries fail, it must throw an error with the message `"Failed to connect to OpenSearch after {maxRetries} attempts"`. If it succeeds, it must log `"Connected to OpenSearch cluster: {clusterName} (status: {status})"` to the console.

4. **`getClusterInfo()`** — An async function that returns detailed information about the OpenSearch cluster including: the cluster name, cluster status (green/yellow/red), number of nodes, number of indices, total number of documents across all indices, and total store size in bytes. This is used by the status endpoint and for monitoring. The function must call `client.cluster.stats()` and extract the relevant fields.

**Error handling requirements:**

All functions must catch errors from the OpenSearch client and wrap them in a consistent error format: `{ success: false, error: { code: "OPENSEARCH_CONNECTION_ERROR", message: "...", details: "..." } }`. The `code` field must use a descriptive error code (not just HTTP status codes) because downstream modules need to distinguish between "OpenSearch is down" (retry-able) and "bad query syntax" (not retry-able).

The client must be configured with the following options:
- `node`: The OpenSearch URL from environment variable or default
- `ssl`: Disabled for development (no TLS verification). The OpenSearch Docker container runs without security plugin.
- `requestTimeout`: 30000 milliseconds (30 seconds). This is generous for development but prevents hanging requests.
- `maxRetries`: 3 (the client's built-in retry for transient failures, separate from our `waitForConnection` retries)

**Why this design matters (Palantir context):**

In Palantir's architecture, Object Storage V2 connects to a distributed search engine cluster that may have multiple nodes. The connection must be resilient to individual node failures and must handle retries gracefully. While our development setup uses a single node, the code must be structured so that switching to a multi-node cluster in production only requires changing the connection URL (or providing multiple URLs in an array). The `@opensearch-project/opensearch` client already supports connection sniffing (automatic discovery of cluster nodes), but we disable this for development by not setting the `sniffOnStart` option.

**Test to verify this task is complete:**
Run `node -e "const { ping } = require('./src/services/opensearch/client'); ping().then(console.log)"` and verify it returns `{ connected: true, ... }` with a valid cluster name and status.
