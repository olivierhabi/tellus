# TASK 27: Create the Index Template Registry

**File to create:** `/src/services/opensearch/templateRegistry.js`

**Purpose:** Manages OpenSearch index templates that are applied automatically when new indices are created. Instead of specifying settings on every index creation call, we register a template that applies default settings to all `ontology-*` indices.

**Specification:**

Export: `ensureIndexTemplate()` that creates (or updates) an index template in OpenSearch:

```javascript
client.indices.putTemplate({
  name: "ontology-template",
  body: {
    index_patterns: ["ontology-*"],
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      refresh_interval: "1s",
      max_result_window: 100000
    },
    mappings: {
      properties: {
        __pk: { type: "keyword" },
        __objectType: { type: "keyword" },
        __lastModified: { type: "date" },
        __version: { type: "long" },
        __editedBy: { type: "keyword" },
        __datasourceVersion: { type: "keyword" }
      }
    }
  }
});
```

This ensures that every new `ontology-*` index automatically gets the system fields and default settings. The index mapping generator (Task 3) then adds the object-type-specific property mappings on top.

**Return value:** `ensureIndexTemplate()` must return `{ success: true, action: "created"|"updated", templateName: "ontology-template" }`. On failure, throw with a descriptive error including the OpenSearch error response. Log `"Index template 'ontology-template' ensured (action: created|updated)"` on success.

**Sync with Task 3:** The system field definitions in this template MUST be kept in sync with the system fields defined in Task 3 (`indexMappingGenerator.js`). If they diverge, the template's version applies to new indices created without going through `createIndex`, while Task 3's version applies to explicitly created indices. Consider extracting the shared system field definitions into a constant that both modules import.

Call `ensureIndexTemplate()` during application startup (before any indexing operations). Import the OpenSearch client from Task 1's `/src/services/opensearch/client.js`.
