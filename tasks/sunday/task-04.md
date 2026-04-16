# TASK 4: Update and Delete Interface API Endpoints

This task has two sub-tasks. They share the same route file but are independent operations.

## Objective
Build the endpoints for updating an existing Interface definition and deleting an Interface. Updates must handle property additions, removals, and modifications atomically. Deletion must cascade properly and include safety checks.

## Exact Specification

## Sub-task 4A: PUT Endpoint for Updating an Interface

**Endpoint 1:** `PUT /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName`

This endpoint replaces the entire Interface definition (except the apiName, which is immutable). The request body has the same shape as the POST body but without `apiName`. The implementation must handle three cases for properties: new properties that don't exist yet (insert), existing properties whose definition changed (update), and properties that existed before but are not in the new request (delete).

**Request Body:**
```json
{
  "displayName": "Has Geographic Location (Updated)",
  "description": "Updated description...",
  "properties": [
    { "apiName": "latitude", "displayName": "Latitude", "baseType": "double", "isRequired": true },
    { "apiName": "longitude", "displayName": "Longitude", "baseType": "double", "isRequired": true },
    { "apiName": "altitude", "displayName": "Altitude (meters)", "baseType": "double", "isRequired": false }
  ]
}
```

In this example, if the Interface previously had properties `latitude`, `longitude`, and `locationName`, the update would: keep `latitude` and `longitude` (possibly updating their display names or other attributes), add `altitude` as a new property, and delete `locationName` because it's no longer in the list.

**Critical validation before applying the update:**

If any property is being REMOVED (existed before, not in the new list) AND there are Object Types implementing this Interface that have mapped one of their properties to the removed Interface property, the operation must be REJECTED. You cannot remove an Interface property that is actively in use. Return HTTP 409 with error code "PROPERTY_IN_USE" and message "Cannot remove Interface property '{propName}' because it is mapped by Object Type '{objectTypeName}'". To check this, query the `object_type_interface` table and inspect the `property_mapping` JSONB column for each implementing Object Type.

If any property's `base_type` is being CHANGED (e.g., from "string" to "integer") AND there are Object Types implementing this Interface with a mapping for that property, the operation must also be REJECTED. Changing a property's type would break existing mappings. Return HTTP 409 with error code "TYPE_CHANGE_CONFLICT" and message "Cannot change base_type of Interface property '{propName}' from '{oldType}' to '{newType}' because it is mapped by Object Type '{objectTypeName}'".

**Database operations (single transaction):**

```
BEGIN
1. UPDATE interface SET display_name = $1, description = $2, updated_at = now() WHERE interface_id = $3
2. Fetch current properties: SELECT * FROM interface_property WHERE interface_id = $3
3. Compute diff:
   - properties_to_insert: in new list but not in current (by api_name)
   - properties_to_update: in both new and current (by api_name), with any of these fields changed: `display_name`, `base_type`, `is_required`, or `ordinal`
   - properties_to_delete: in current but not in new list (by api_name)
4. Validate: none of properties_to_delete are in use (check object_type_interface)
5. Validate: none of properties_to_update have type changes that conflict
6. DELETE FROM interface_property WHERE interface_property_id IN (properties_to_delete ids)
7. UPDATE each property_to_update
8. INSERT each property_to_insert with new UUIDs and ordinals
COMMIT
```

**Success Response (HTTP 200):** Same shape as the POST response (Task 2) with the updated data.

---

## Sub-task 4B: DELETE Endpoint for Removing an Interface

**Endpoint 2:** `DELETE /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName`

Deletes an Interface and all its properties. However, if any Object Types currently implement this Interface, the deletion must be REJECTED. Return HTTP 409 with error code "INTERFACE_IN_USE" and message "Cannot delete Interface '{apiName}' because it is implemented by Object Types: {list of names}".

This is a safety measure. In Palantir, you cannot delete an Interface that is actively being used. The user must first remove the Interface implementation from all Object Types before deleting the Interface itself.

**Database operations (single transaction):**

```
BEGIN
1. Check: SELECT ot.api_name FROM object_type_interface oti JOIN object_type ot ON ot.object_type_id = oti.object_type_id WHERE oti.interface_id = $1
2. If any rows returned → ROLLBACK, return 409
3. DELETE FROM interface_property WHERE interface_id = $1 (CASCADE would handle this, but be explicit)
4. DELETE FROM interface WHERE interface_id = $1
COMMIT
```

**Success Response (HTTP 204 No Content):** Empty body.

## Verification
1. Create an Interface with 3 properties → update it by removing 1 and adding 1 → verify the final state has 3 properties (2 old + 1 new)
2. Have an Object Type implement the Interface → try to remove a mapped property via PUT → verify 409
3. Have an Object Type implement the Interface → try to DELETE the Interface → verify 409
4. Remove the Object Type's implementation → DELETE the Interface → verify 204 and Interface is gone
5. PUT with changed base_type on a mapped property → verify 409
6. PUT with changed display_name on a mapped property → verify 200 (display_name changes are allowed)
7. Verify updated_at timestamp changes on each PUT
