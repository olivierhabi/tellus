# TASK 22 OF 30: Struct Schema Validation

**Objective:** Create a dedicated validation module for struct-type properties. When a property has `baseType: 'struct'`, its `structSchema` field must contain a valid array of field definitions. This module handles the complexity of nested structs and generates OpenSearch mappings for struct properties.

**Step-by-step instructions:**

Create src/utils/structValidator.js. Export two functions:

**Function 1: validateStructSchema(schema, currentDepth = 1)**

Performs comprehensive validation of a struct schema. Returns `{valid: true}` or `{valid: false, errors: string[]}`.

Validation rules in order:
1. `schema` must be a non-null array. If not: error `"Struct schema must be a non-null array."`.
2. `schema` must have at least one element. If empty: error `"Struct schema must contain at least one field."`.
3. `schema` must have at most 50 elements. If more: error `"Struct schema exceeds maximum of 50 fields (has {length})."`.
4. For each element in the array:
   a. Must be an object (not null, not array). If not: error `"Struct schema element at index {i} must be an object."`.
   b. Must have `fieldName` (string). If missing: error `"Field at index {i} is missing required property 'fieldName'."`.
   c. Must have `fieldType` (string). If missing: error `"Field at index {i} is missing required property 'fieldType'."`.
   d. `fieldName` must match camelCase regex `^[a-z][a-zA-Z0-9]{0,255}$`. If not: error `"Field '{fieldName}' must be camelCase (start with lowercase, alphanumeric only)."`.
   e. `fieldType` must be in `VALID_BASE_TYPES` (from Task 7). If not: error `"Field '{fieldName}' has invalid type '{fieldType}'. Valid types: {VALID_BASE_TYPES.join(', ')}."`.
   f. May optionally have `fieldDescription` (string) and `fieldRequired` (boolean). Other properties are ignored.
   g. If `fieldType === 'struct'`, the element MUST have `fieldSchema` (array). If missing: error `"Field '{fieldName}' has type 'struct' but is missing 'fieldSchema'."`. Recursively validate `fieldSchema` by calling `validateStructSchema(fieldSchema, currentDepth + 1)`. Merge any errors.
5. Check for duplicate `fieldName` values. If duplicates found: error `"Duplicate field name '{fieldName}' in struct schema."`.
6. Maximum nesting depth: 3 levels. The root struct is level 1. If `currentDepth > 3`: error `"Struct nesting exceeds maximum depth of 3 levels."`. This prevents overly complex OpenSearch mappings.

Depth counting:
- Level 1: the struct property itself (e.g., `address`)
- Level 2: a nested struct inside address (e.g., `address.coordinates`)
- Level 3: a nested struct inside coordinates (e.g., `address.coordinates.metadata`)
- Level 4+: rejected

**Function 2: generateOpenSearchStructMapping(structSchema)**

Recursively builds the OpenSearch object mapping from a validated struct schema. For each field, look up the OpenSearch mapping using `getOpenSearchMapping(fieldType, fieldSchema)` from Task 7 and nest it under `"properties"`.

Example input:
```json
[
  {"fieldName": "street", "fieldType": "string"},
  {"fieldName": "city", "fieldType": "string"},
  {"fieldName": "coordinates", "fieldType": "struct", "fieldSchema": [
    {"fieldName": "lat", "fieldType": "double"},
    {"fieldName": "lon", "fieldType": "double"}
  ]}
]
```

Example output:
```json
{
  "type": "object",
  "properties": {
    "street": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 32766}}},
    "city": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 32766}}},
    "coordinates": {
      "type": "object",
      "properties": {
        "lat": {"type": "double"},
        "lon": {"type": "double"}
      }
    }
  }
}
```

**Integration with Task 15 (propertyService):**

Task 15's `create` method calls `validateStructSchema` when `baseType === 'struct'`. This module is the single source of truth for struct validation — propertyService does NOT duplicate any struct validation logic.

**Exports:** `validateStructSchema`, `generateOpenSearchStructMapping`.

**Files to create:** src/utils/structValidator.js

**Verification:**
- Valid schema `[{fieldName: "street", fieldType: "string"}]` → `{valid: true}`
- Missing fieldName → `{valid: false, errors: ["...missing required property 'fieldName'..."]}`
- Invalid fieldType `"invalid"` → `{valid: false, errors: ["...invalid type..."]}`
- Duplicate fieldNames → `{valid: false, errors: ["Duplicate field name..."]}`
- Nested struct (2 levels deep) → `{valid: true}`
- Nested struct (4 levels deep) → `{valid: false, errors: ["...exceeds maximum depth of 3..."]}`
- 51 fields → `{valid: false, errors: ["...exceeds maximum of 50 fields..."]}`
- `generateOpenSearchStructMapping` with nested struct → correctly nested `{type: "object", properties: {...}}`
