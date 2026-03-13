# TASK 14: Object View API — Property Metadata Enrichment Service

## Objective
Create a reusable service that enriches raw object property values with their metadata (display name, description, base type, required status, Interface membership). This service is used by both the single Object View (Task 11) and the batch Object View (Task 13) to transform raw OpenSearch documents into the enriched property format shown in the responses.

## Exact Specification

Create a file at `/src/services/propertyEnricher.js` that exports the following functions:

**Function 1: `enrichObjectProperties(rawObject, objectTypeMeta, interfaceImplementations)`**

This function takes:
- `rawObject`: The raw document from OpenSearch. This is a flat key-value object like `{ "__pk": "EMP-001", "fullName": "Melissa Chang", "salary": 145000, ... }`
- `objectTypeMeta`: The Object Type definition from PostgreSQL, including all properties with their metadata. This has the shape `{ apiName: "Employee", properties: [{ apiName: "fullName", displayName: "Full Name", baseType: "string", isRequired: false, description: "...", ordinal: 0 }, ...] }`
- `interfaceImplementations`: The list of Interfaces this Object Type implements, with property mappings. Shape: `[{ interfaceApiName: "Auditable", propertyMapping: { "createdDate": "startDate" } }]`

**Property mapping direction:** The `propertyMapping` object uses Interface property names as keys and Object Type property names as values. In the example above, `"createdDate"` is the Interface's property and `"startDate"` is the Object Type's property.

It returns an enriched properties object:
```javascript
{
  "employeeId": {
    "value": "EMP-001",
    "displayName": "Employee ID",
    "description": "Unique identifier for the employee",
    "baseType": "string",
    "isRequired": true,
    "ordinal": 0,
    "isFromInterface": false
  },
  "fullName": {
    "value": "Melissa Chang",
    "displayName": "Full Name",
    "description": null,
    "baseType": "string",
    "isRequired": false,
    "ordinal": 1,
    "isFromInterface": false
  },
  "startDate": {
    "value": "2019-03-15",
    "displayName": "Start Date",
    "description": null,
    "baseType": "date",
    "isRequired": false,
    "ordinal": 3,
    "isFromInterface": true,
    "interfaceMappings": [
      { "interfaceApiName": "Auditable", "interfacePropertyName": "createdDate" }
    ]
  }
}
```

The `isFromInterface` flag is true if this property is mapped to at least one Interface property. The `interfaceMappings` array lists all Interfaces that map to this property (a property can be mapped by multiple Interfaces).

**Key rules for enrichment:**

1. Properties are ordered by `ordinal` value from the Object Type definition, NOT by their order in the OpenSearch document (which is undefined for JSON objects).

2. Properties that exist in the Object Type definition but have a `null` value in the OpenSearch document should still appear in the enriched output with `"value": null`. This distinguishes "the property exists but has no value" from "the property doesn't exist on this type."

3. System fields (`__pk`, `__objectType`, `__lastModified`, `__version`) should be EXCLUDED from the enriched properties output. They appear at the top level of the Object View response, not inside `properties`.

4. If the raw object contains a field that is NOT in the Object Type definition (this shouldn't happen if indexing is correct, but be defensive), log a warning and exclude it from the enriched output. Do not crash.

5. Array properties (e.g., `string_array`) should be returned as JavaScript arrays in the value field. OpenSearch returns arrays natively, so no special conversion is needed, but verify the value is actually an array and not accidentally a single string.

6. Struct properties should be returned as nested objects in the value field, matching the struct_schema definition. The `struct_schema` is stored as a JSONB field on the `property` table row (column `struct_schema`). It is an object whose keys are the allowed field names and whose values are their base types. Verify that the nested object only contains the fields defined in the struct_schema — strip any extra fields.

7. Date properties should be returned as ISO 8601 strings (e.g., "2019-03-15"), not as timestamps or epoch milliseconds. OpenSearch indexes in this project use the `date` mapping type with `format: "strict_date_optional_time||epoch_millis"`. Values stored as epoch milliseconds must be converted to ISO 8601 date strings (e.g., `1552608000000` becomes `"2019-03-15"`). Values already stored as ISO strings should be passed through unchanged.

8. Geopoint properties should be returned as `{ "lat": -1.9686, "lon": 30.1395 }` objects. OpenSearch supports multiple geopoint formats; normalize to this lat/lon object format.

**Function 2: `buildPropertyMetadataCache(ontologyId)`**

This function pre-fetches all Object Type metadata and Interface implementations for an entire Ontology and returns a cache object. This is used by the batch Object View endpoint (Task 13) to avoid repeated PostgreSQL queries — fetch all metadata once, then reuse it for every object in the batch.

```javascript
const cache = await buildPropertyMetadataCache(ontologyId);
// cache = {
//   objectTypes: {
//     "Employee": { properties: [...], interfaces: [...] },
//     "Company": { properties: [...], interfaces: [...] }
//   }
// }

// Usage:
const meta = cache.objectTypes["Employee"];
const enriched = enrichObjectProperties(rawObject, meta, meta.interfaces);
```

The cache should be built with a maximum of 2 PostgreSQL queries (one for all Object Types + properties, one for all Interface implementations), regardless of how many Object Types exist. Use JOINs, not N+1 queries.

**Function 3: `selectProperties(enrichedProperties, selectList)`**

Given an enriched properties object and a `$select` array of property api_names, returns a new object containing only the selected properties. If `selectList` is null or undefined, returns all properties. If a selected property name doesn't exist, silently skip it (don't error).

## Verification
1. Enrich an object with 10 properties → verify all 10 appear with correct metadata
2. Enrich an object where 2 properties are mapped to an Interface → verify `isFromInterface` and `interfaceMappings`
3. Enrich an object with a null property value → verify it appears as `"value": null`
4. Enrich an object with a system field `__pk` → verify it's excluded from properties
5. Enrich an object with a geopoint property → verify lat/lon format
6. Enrich an object with a struct property → verify nested object format
7. Test `selectProperties` with a subset → verify only selected properties returned
8. Test `buildPropertyMetadataCache` → verify it executes exactly 2 PostgreSQL queries (check query count in logs)
9. Performance: Enrich 1,000 objects using the cache → verify it completes in under 1 second
