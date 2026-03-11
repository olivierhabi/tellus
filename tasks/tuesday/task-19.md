# TASK 19: Create the Reindex Trigger for Property Changes

**File to create:** `/src/services/indexing/propertyChangeHandler.js`

**Purpose:** When a property is added, modified, or deleted on an object type, the OpenSearch index mapping might need to be updated. This module determines what action is recommended based on the type of property change. In Palantir, "changes that require Object Storage to unregister and reregister the backing datasources of an object type will make the objects of that type unavailable in user applications during that reindex time."

**Specification:**

Export: `handlePropertyChange(objectTypeApiName, changeType, property)` where:
- `changeType`: one of `"added"`, `"modified"`, `"deleted"`, `"primary_key_changed"`
- `property`: an object with shape `{ apiName: string, oldType?: string, newType?: string, isPrimaryKey?: boolean }`

**This function is advisory only.** It returns the recommended action but does NOT call `updateMapping()` or any other side-effect function directly. The caller is responsible for executing the recommended action. This makes the function a pure decision function with no side effects.

**Logic by changeType:**

- **`"added"` (Property added):** Return `{ action: "mapping_update_recommended", reindexRequired: false, message: "New property '{property.apiName}' can be added to the OpenSearch mapping without reindexing. Call updateMapping() from Task 4." }`.

- **`"modified"` (Property type changed):** Return `{ action: "reindex_required", reindexRequired: true, reason: "Property type changed from '{property.oldType}' to '{property.newType}'. This requires a full reindex." }`. The caller should inform the user and call `recreateIndex()` from Task 4 followed by a full reindex.

- **`"deleted"` (Property deleted):** Return `{ action: "no_action", reindexRequired: false, note: "Deleted properties remain in OpenSearch mapping but will no longer be populated on new indexes. No reindex needed." }`.

- **`"primary_key_changed"` (Primary key property changed):** Return `{ action: "reindex_required", reindexRequired: true, reason: "Primary key property changed. This is a destructive change that requires a full reindex.", destructive: true }`. In Palantir, this is one of the operations that "will unregister and reregister the backing datasources."

**Validation:**
- If `changeType` is not one of the four valid values, throw: `"Invalid changeType: '{changeType}'. Must be one of: added, modified, deleted, primary_key_changed"`.
- If `changeType` is `"modified"` and `property.oldType` or `property.newType` is missing, throw: `"property.oldType and property.newType are required when changeType is 'modified'"`.

**Test to verify:** Call with each `changeType` and verify the correct return value. Verify that `"modified"` includes old and new type in the reason string. Verify that invalid `changeType` throws. Verify that `"modified"` without `oldType`/`newType` throws.
