# TASK 18: Create the OpenSearch Client Wrapper with Retry and Error Handling

**File to modify:** `/src/opensearch.js` (enhance the existing file)

**Purpose:** The raw OpenSearch client can throw various errors: connection refused (OpenSearch is down), timeout (query took too long), 404 (index doesn't exist), 400 (malformed query), 503 (OpenSearch overloaded). Each error type needs different handling. This task adds a wrapper around the OpenSearch client that provides: automatic retry for transient errors, consistent error translation, query logging, and response time tracking.

**Implementation:**

1. **Retry logic for transient errors.** If OpenSearch returns a 503 (Service Unavailable) or a connection error (ECONNREFUSED, ECONNRESET, ETIMEDOUT), retry the request up to 3 times with exponential backoff (100ms, 400ms, 1600ms). Do NOT retry 400 errors (client errors — the query is malformed and retrying won't help) or 404 errors (index doesn't exist — retrying won't help).

2. **Error translation.** Convert OpenSearch errors into our custom error classes:
   - Connection refused / timeout → throw `ObjectDatabaseUnavailableError`
   - 404 on index → throw `ObjectTypeNotFoundError` (with message indicating the object type hasn't been indexed yet, as opposed to not existing in the schema at all)
   - 400 on query → log the full OpenSearch error response (it contains helpful details about what's wrong with the query) and throw `QueryValidationError` with the OpenSearch error message. This is important for debugging — if our query translator produces an invalid OpenSearch query, the error message from OpenSearch tells us exactly what's wrong.
   - 429 (too many requests) → throw `RateLimitError`
   - Any other error → throw `OntologyError` with the raw error message

3. **Query logging.** Log every OpenSearch request with: timestamp, method (search/get/count/bulk), index name, query body (JSON stringified and truncated to 500 chars), response status code, response time in milliseconds, and the number of hits returned. Use a structured log format.

4. **Response time tracking.** Measure and log the time between sending the request and receiving the response. If a query takes longer than 5 seconds, log a WARNING (this indicates a query that needs optimization or an undersized OpenSearch cluster).

5. **Wrapper functions to export:**
   - `searchObjects(index, body)` — wraps `client.search({ index, body })`
   - `getObject(index, id, sourceIncludes)` — wraps `client.get({ index, id, _source_includes })`
   - `countObjects(index, body)` — wraps `client.count({ index, body })`
   - `indexExists(index)` — wraps `client.indices.exists({ index })`

Each wrapper handles retries, error translation, and logging internally, so the calling code never needs to deal with raw OpenSearch errors.
