# TASK 27 OF 30: Schema Diff Utility

**Objective:** Create a utility that computes the difference between two versions of an object type's property schema, and a separate function that computes the difference between two versions of a backing datasource's column list. Both are needed for detecting schema changes, generating migration plans, and warning about breaking changes.

**Step-by-step instructions:**

Create src/utils/schemaDiff.js. Export two functions:

**Function 1: computeSchemaDiff(before, after)**

`before` and `after` are arrays of property definition objects, each with at least: `apiName` (string), `baseType` (string), `displayName` (string), `isRequired` (boolean), `isArray` (boolean), `ordinal` (number), `description` (string|null), `structSchema` (array|null).

Properties are matched by `apiName` (stable identifier). Returns:

```json
{
  "propertiesAdded": [{"apiName": "middleName", "baseType": "string"}],
  "propertiesRemoved": [{"apiName": "legacyCode", "baseType": "string"}],
  "propertiesModified": [
    {
      "apiName": "salary",
      "changes": {
        "baseType": {"before": "integer", "after": "double"},
        "isRequired": {"before": false, "after": true}
      }
    }
  ],
  "propertiesUnchanged": ["employeeId", "fullName"],
  "isBreakingChange": true,
  "breakingReasons": [
    "Property 'legacyCode' was removed. Objects may have data for this property that will be lost.",
    "Property 'salary' baseType changed from 'integer' to 'double'. This requires reindexing.",
    "Property 'salary' isRequired changed from false to true. Existing null values would fail indexing."
  ],
  "summary": "1 added, 1 removed, 1 modified, 2 unchanged. BREAKING CHANGE."
}
```

Breaking change rules (`isBreakingChange = true` if any of these):
- A property was removed
- `baseType` changed (any type → different type)
- `isRequired` changed from `false` to `true` (existing null values would fail indexing)

Non-breaking changes:
- Property added (new property has null values for existing objects)
- `displayName` changed
- `description` changed
- `ordinal` changed
- `isRequired` changed from `true` to `false`

The `summary` string format: `"{added} added, {removed} removed, {modified} modified, {unchanged} unchanged."` Append `" BREAKING CHANGE."` if `isBreakingChange` is true, otherwise append `" No breaking changes."`.

**Function 2: computeColumnDiff(previousColumns, currentColumns)**

`previousColumns` and `currentColumns` are arrays of column name strings (e.g., `["emp_id", "name", "salary"]`).

Columns are matched by exact name (string equality). Returns:

```json
{
  "columnsAdded": ["department", "start_date"],
  "columnsRemoved": ["legacy_code"],
  "columnsUnchanged": ["emp_id", "name", "salary"],
  "hasChanges": true,
  "summary": "2 added, 1 removed, 3 unchanged."
}
```

This function does NOT attempt rename detection. A renamed column appears as one removal + one addition. Rename detection is deferred to a future sprint.

**Files to create:** src/utils/schemaDiff.js

**Verification:**
- Diff with a property added → `propertiesAdded` has 1 entry, `isBreakingChange: false`
- Diff with a property removed → `propertiesRemoved` has 1 entry, `isBreakingChange: true`, reason includes "was removed"
- Diff with baseType change → `propertiesModified` shows the change, `isBreakingChange: true`
- Diff with isRequired false→true → breaking. Diff with isRequired true→false → not breaking.
- Diff with only displayName change → `propertiesModified` shows change, `isBreakingChange: false`
- Column diff with additions and removals → correct counts and `hasChanges: true`
- Column diff with no changes → `hasChanges: false`
- Inline tests: `node src/utils/schemaDiff.js` passes all of the above
