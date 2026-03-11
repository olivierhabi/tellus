# TASK 22: Create the Index Refresh Utility

**File to create:** `/src/services/opensearch/refreshUtil.js`

**Purpose:** Provides explicit index refresh control. OpenSearch's default refresh interval is 1 second, but during bulk indexing, disabling auto-refresh and doing a manual refresh after completion can improve performance by 20-30%.

**Specification:**

Import the OpenSearch client from Task 1's `/src/services/opensearch/client.js`.

Export:

1. **`disableAutoRefresh(indexName)`** — Sets `refresh_interval: "-1"` on the index by calling `client.indices.putSettings({ index: indexName, body: { index: { refresh_interval: "-1" } } })`. Returns `{ success: true, indexName, refreshInterval: "-1" }`.

2. **`enableAutoRefresh(indexName, interval = "1s")`** — Sets `refresh_interval` to the provided `interval` value (JavaScript default parameter: `"1s"`). Calls `client.indices.putSettings({ index: indexName, body: { index: { refresh_interval: interval } } })`. Returns `{ success: true, indexName, refreshInterval: interval }`.

3. **`refreshNow(indexName)`** — Forces an immediate refresh by calling `client.indices.refresh({ index: indexName })`. Returns `{ success: true, indexName }`.

4. **`refreshAll()`** — Refreshes all `ontology-*` indices by calling `client.indices.refresh({ index: "ontology-*" })`. Returns `{ success: true, pattern: "ontology-*" }`.

**Note (not in scope for this task):** Task 10's `bulkIndex()` function may later be modified to optionally call `disableAutoRefresh()` before bulk indexing and `enableAutoRefresh()` + `refreshNow()` after completion. That modification is NOT part of this task — it will be handled as an optimization to Task 10 separately.

**Test to verify:** Create an index, call `disableAutoRefresh`, verify the setting changed. Call `enableAutoRefresh`, verify the setting is restored. Call `refreshNow`, verify no error. Call `refreshAll`, verify no error.
