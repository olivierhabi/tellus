# TASK 5: Create the PUT `/api/v2/ontology/:ontologyId/linkTypes/:apiName` Endpoint

**Objective:** Build the REST API endpoint that updates an existing link type definition. In Palantir Foundry, link type definitions can be modified — for example, changing the display name, description, or even the cardinality (though changing cardinality is a breaking change that requires careful handling). This endpoint allows partial updates — the caller only needs to provide the fields they want to change, and all other fields remain unchanged.

**Why this exists in Palantir:** The Ontology Manager allows editors to update link type metadata (display name, description) without disrupting existing applications. However, certain changes are destructive — changing the cardinality, source/target object types, or foreign key property can break existing applications that depend on the link type. Palantir warns users about these breaking changes before allowing them. In our implementation, we will implement the same behavior: allow all updates but flag destructive changes in the response.

**Prerequisites:** Tasks 1 and 2 must be complete (link_type table and POST endpoint).

**HTTP method and path:** `PUT /api/v2/ontology/:ontologyId/linkTypes/:apiName`

**Request body (all fields optional — partial update):**

```json
{
    "displayName": "string, optional — new display name",
    "description": "string, optional — new description",
    "cardinality": "string, optional — DANGEROUS: changing cardinality is a breaking change",
    "foreignKey": {
        "propertyApiName": "string",
        "side": "source | target"
    },
    "joinTable": {
        "filePath": "string",
        "sourceColumn": "string",
        "targetColumn": "string"
    },
    "isBidirectional": "boolean, optional"
}
```

**Fields that CANNOT be changed via update:**
- `apiName` — the identifier is immutable. If the user wants a different api_name, they must delete and recreate the link type.
- `sourceObjectType` — changing the source object type would invalidate all existing link traversals. Return HTTP 400 with `{ "error": "Cannot change sourceObjectType. Delete and recreate the link type instead." }`.
- `targetObjectType` — same restriction as sourceObjectType. Return HTTP 400 with `{ "error": "Cannot change targetObjectType. Delete and recreate the link type instead." }`.

If the request body contains `sourceObjectType` or `targetObjectType`, reject immediately with HTTP 400 before processing any other fields.

**Partial update semantics:** For each field in the request body:
- If the field is present and has a non-null value, use the new value.
- If the field is absent (not in the request body at all), keep the existing value.
- If the field is explicitly set to `null`, treat it as "clear this field" — set it to NULL in the database. This is only valid for nullable fields (`description`, `foreignKey` fields when switching to M2M, `joinTable` fields when switching away from M2M).
- An empty request body `{}` is valid — it results in no changes. Return HTTP 200 with the existing link type definition unchanged, and an empty `warnings` array.

**Breaking change detection:** If the request includes changes to `cardinality`, `foreignKey`, or `joinTable`, these are breaking changes. Include a warning in the response:

```json
{
    "linkType": { ...updated definition... },
    "warnings": [
        {
            "type": "BREAKING_CHANGE",
            "field": "cardinality",
            "previousValue": "MANY_TO_ONE",
            "newValue": "MANY_TO_MANY",
            "message": "Changing cardinality from MANY_TO_ONE to MANY_TO_MANY will require reindexing and may break existing applications."
        }
    ]
}
```

**Implementation approach:**

1. Fetch the existing link type from the database: `SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2`. If not found, return HTTP 404 with `{ "error": "Link type '${apiName}' not found in this ontology." }`.

2. Check for immutable field modifications. If `sourceObjectType` or `targetObjectType` is in the request body, return HTTP 400 immediately.

3. Merge the request body with the existing values. For each field in the request body that is not `undefined`, use the new value. For all other fields, keep the existing value. This implements partial update semantics.

4. If `cardinality` is being changed, re-validate all the conditional rules:
   - If changing TO `MANY_TO_MANY`: require `joinTable` to be provided (either in this request or already existing on the link type). If neither exists, return HTTP 400 with `{ "error": "Changing to MANY_TO_MANY cardinality requires joinTable configuration (filePath, sourceColumn, targetColumn)." }`.
   - If changing FROM `MANY_TO_MANY` to a FK-based cardinality: require `foreignKey` to be provided (either in this request or already existing). If neither exists, return HTTP 400 with `{ "error": "Changing from MANY_TO_MANY to ${newCardinality} requires foreignKey configuration (propertyApiName, side)." }`.
   - If changing from a FK-based cardinality to another FK-based cardinality: validate the FK property still exists on the correct object type using the same query as Task 2 rule 7.

5. Run the same validation rules as the POST endpoint on the merged result (all the rules from Task 2, rules 3-9, applied to the merged state). Skip rule 10 (uniqueness) since the apiName is not changing.

6. Detect breaking changes by comparing old vs. new values for `cardinality`, `foreignKey.propertyApiName`, `foreignKey.side`, `joinTable.filePath`, `joinTable.sourceColumn`, `joinTable.targetColumn`. For each changed field, add a warning object to the `warnings` array.

7. Update the database row:
```sql
UPDATE link_type
SET display_name = $1, description = $2, cardinality = $3,
    foreign_key_property_api_name = $4, foreign_key_side = $5,
    join_table_file_path = $6, join_table_source_column = $7, join_table_target_column = $8,
    is_bidirectional = $9, updated_at = now()
WHERE ontology_id = $10 AND api_name = $11
RETURNING *
```

8. Return the updated link type definition with any applicable warnings.

**Success response:** HTTP 200 OK

```json
{
    "linkType": {
        "linkTypeId": "uuid",
        "apiName": "employeeCompany",
        "displayName": "Updated Display Name",
        "description": "Updated description",
        "sourceObjectType": "Employee",
        "targetObjectType": "Company",
        "cardinality": "MANY_TO_ONE",
        "foreignKey": {
            "propertyApiName": "companyId",
            "side": "source"
        },
        "joinTable": null,
        "isBidirectional": true,
        "createdAt": "2025-03-11T10:00:00.000Z",
        "updatedAt": "2025-03-13T14:30:00.000Z"
    },
    "warnings": []
}
```

**Error responses:**
- HTTP 400 — Validation failure (invalid cardinality, immutable field change, missing FK/joinTable for cardinality change). Body: `{ "error": "message" }`.
- HTTP 404 — Ontology not found: `{ "error": "Ontology not found" }`.
- HTTP 404 — Link type not found: `{ "error": "Link type '${apiName}' not found in this ontology." }`.
- HTTP 500 — Internal error (catch and log, return `{ "error": "Internal server error" }`).

**File to modify:** `src/routes/linkTypes.js` — add the PUT `/:apiName` handler.

**Testing:**
1. Create a link type, update its `displayName`, verify the change persists and `updatedAt` is updated. Verify `warnings` is an empty array.
2. Update `cardinality` from MANY_TO_ONE to ONE_TO_MANY — verify a BREAKING_CHANGE warning is returned in the response.
3. Try changing `sourceObjectType` — verify HTTP 400 is returned with the immutable field error message.
4. Send an empty request body `{}` — verify HTTP 200 with the unchanged link type.
5. Try changing cardinality to MANY_TO_MANY without providing joinTable — verify HTTP 400.
