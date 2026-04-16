# TASK 6: Create the "Implements Interface" API Endpoints

This task has two sub-tasks.

## Objective
Build the API endpoints that allow an Object Type to declare that it implements an Interface by providing a property mapping. Also build the endpoint to remove an Interface implementation from an Object Type.

## Exact Specification

Create a new file `/src/routes/objectTypeInterfaces.js` for these endpoints (they hang off the `objectTypes` path, not the `interfaces` path). Register it in `server.js`.

## Sub-task 6A: POST Endpoint for Declaring Interface Implementation

**Endpoint 1:** `POST /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements`

This endpoint declares that an Object Type implements an Interface, with a property mapping that connects Interface properties to Object Type properties.

**Request Body:**
```json
{
  "interfaceApiName": "HasLocation",
  "propertyMapping": {
    "latitude": "airportLatitude",
    "longitude": "airportLongitude",
    "locationName": "airportName"
  }
}
```

**Validation Rules (ALL must pass before any database write):**

1. The Ontology must exist → 404 if not
2. The Object Type must exist in this Ontology → 404 if not
3. The Interface must exist → 404 if not (look up by `interfaceApiName`)
Note: The Interface is looked up by `interfaceApiName` globally (not scoped to the Ontology), since Interface apiNames are globally unique per Task 1's UNIQUE constraint.
4. The Object Type must not already implement this Interface → 409 ALREADY_EXISTS if it does
5. `propertyMapping` must be a non-null object with at least one key-value pair
6. Every REQUIRED Interface property must be present as a key in the mapping. To check this: query all `interface_property` rows for this Interface where `is_required = true`, and verify each one appears as a key in the mapping. If any required property is missing, return HTTP 400 with error code "MISSING_REQUIRED_MAPPING" and message "Interface property '{propName}' is required but not present in propertyMapping"
7. Every key in the mapping must be a valid Interface property api_name. If a key doesn't match any Interface property, return HTTP 400 with error code "INVALID_MAPPING_KEY" and message "'{key}' is not a property of Interface '{interfaceApiName}'"
8. Every value in the mapping must be a valid property api_name on the Object Type. Query the `property` table for this Object Type and check. If a value doesn't match, return HTTP 400 with error code "INVALID_MAPPING_VALUE" and message "'{value}' is not a property of Object Type '{objectTypeApiName}'"
9. For each mapping pair, the base_type of the Object Type property must match the base_type of the Interface property. If they don't match, return HTTP 400 with error code "TYPE_MISMATCH" and message "Object Type property '{otProp}' has type '{otType}' but Interface property '{ifProp}' requires type '{ifType}'"
10. No two keys in the mapping can map to the same Object Type property value. If `{ "latitude": "airportLat", "longitude": "airportLat" }` is provided, return HTTP 400 with error code "DUPLICATE_MAPPING_TARGET" and message "Object Type property '{value}' is mapped to multiple Interface properties"

**Database operation:**
```sql
INSERT INTO object_type_interface (object_type_id, interface_id, property_mapping)
VALUES ($1, $2, $3)
```

Where `$1` is the Object Type's UUID (looked up by api_name), `$2` is the Interface's UUID (looked up by api_name), and `$3` is the property_mapping JSONB.

**Success Response (HTTP 201):**
```json
{
  "data": {
    "objectTypeApiName": "Airport",
    "interfaceApiName": "HasLocation",
    "propertyMapping": {
      "latitude": "airportLatitude",
      "longitude": "airportLongitude",
      "locationName": "airportName"
    },
    "createdAt": "2025-03-16T15:00:00.000Z"
  }
}
```

---

## Sub-task 6B: DELETE and GET Endpoints for Interface Implementations

**Endpoint 2:** `DELETE /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements/:interfaceApiName`

Removes an Interface implementation from an Object Type. This simply deletes the row from `object_type_interface`.

**Validation:**
1. The Ontology, Object Type, and Interface must all exist → 404 if any don't
2. The Object Type must currently implement this Interface → 404 with message "Object Type '{name}' does not implement Interface '{name}'"

**Success Response (HTTP 204 No Content).**

**Endpoint 3:** `GET /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements`

Returns all Interfaces that this Object Type implements, with their property mappings.

**Response (HTTP 200):**
```json
{
  "data": [
    {
      "interfaceApiName": "HasLocation",
      "interfaceDisplayName": "Has Geographic Location",
      "propertyMapping": {
        "latitude": "airportLatitude",
        "longitude": "airportLongitude"
      }
    },
    {
      "interfaceApiName": "Auditable",
      "interfaceDisplayName": "Is Auditable",
      "propertyMapping": {
        "createdDate": "createdAt",
        "createdBy": "createdByUser"
      }
    }
  ]
}
```

## Verification
1. Create Interface HasLocation with required props latitude (double), longitude (double) and optional locationName (string)
2. Create Object Type Airport with properties: airportLatitude (double), airportLongitude (double), airportName (string)
3. POST implements with correct mapping → 201
4. POST implements again → 409 ALREADY_EXISTS
5. POST implements with missing required property (no latitude mapping) → 400 MISSING_REQUIRED_MAPPING
6. POST implements with type mismatch (map a string property to a double Interface property) → 400 TYPE_MISMATCH
7. POST implements with non-existent Object Type property → 400 INVALID_MAPPING_VALUE
8. GET implements → verify HasLocation appears
9. DELETE implements → 204
10. GET implements → verify empty list
