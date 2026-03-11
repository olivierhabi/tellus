# TASK 23: Create the Mapping Diff Calculator

**File to create:** `/src/services/opensearch/mappingDiff.js`

**Purpose:** Compares two index mappings and identifies what changed. Used by the `updateMapping` function in Task 4 and by the property change handler in Task 19.

**Specification:**

Export: `calculateMappingDiff(existingMapping, desiredMapping)` that returns:
```javascript
{
  added: { "newProperty": { type: "keyword" } },
  removed: { "deletedProperty": { type: "text" } },
  changed: { "modifiedProperty": { from: { type: "text" }, to: { type: "integer" } } },
  unchanged: { "stableProperty": { type: "double" } }
}
```

Compare mappings recursively to handle nested objects (struct properties). Two mappings are "equal" if they have the same `type` and the same sub-properties (for objects) and the same `fields` (for text with keyword sub-fields).
