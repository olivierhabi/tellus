# TASK 7: Interface Property Mapping Validation Service

This task has three sub-tasks. All functions live in the same file.

**Depends on:** Task 5 (object_type_interface table), Task 6 (implements endpoint)

## Objective
Extract all the validation logic from Task 6 into a reusable service module that can be called from multiple places (the POST endpoint, the PUT endpoint for updating mappings, and future services like the OSDK code generator that needs to validate mappings). This avoids duplicating complex validation logic across multiple route handlers.

## Exact Specification

Create a file at `/src/services/interfaceValidator.js` that exports the following functions:

## Sub-task 7A: Implement validatePropertyMapping

**Function 1: `validatePropertyMapping(ontologyId, objectTypeApiName, interfaceApiName, propertyMapping)`**

This function performs ALL of the validation rules from Task 6 (rules 5-10) and returns either `{ valid: true }` or `{ valid: false, error: { code, message, details } }`. It must query the database to fetch the Interface's properties and the Object Type's properties, then cross-reference them against the mapping.

The function must be structured as a sequence of checks, where each check returns early if it fails. This makes the validation logic readable and testable:

```javascript
async function validatePropertyMapping(ontologyId, objectTypeApiName, interfaceApiName, propertyMapping) {
  // Step 1: Fetch Interface and its properties
  const interfaceResult = await pool.query(
    'SELECT i.interface_id, ip.api_name, ip.base_type, ip.is_required FROM interface i JOIN interface_property ip ON ip.interface_id = i.interface_id WHERE i.api_name = $1 AND i.ontology_id = $2',
    [interfaceApiName, ontologyId]
  );
  
  if (interfaceResult.rows.length === 0) {
    return { valid: false, error: { code: 'NOT_FOUND', message: `Interface '${interfaceApiName}' not found` } };
  }
  
  const interfaceProperties = interfaceResult.rows;
  
  // Step 2: Fetch Object Type and its properties
  const otResult = await pool.query(
    'SELECT p.api_name, p.base_type FROM property p JOIN object_type ot ON ot.object_type_id = p.object_type_id WHERE ot.api_name = $1 AND ot.ontology_id = $2',
    [objectTypeApiName, ontologyId]
  );
  
  const otProperties = new Map(otResult.rows.map(r => [r.api_name, r.base_type]));
  
  // Step 3: Check that propertyMapping is a valid non-empty object
  if (!propertyMapping || typeof propertyMapping !== 'object' || Array.isArray(propertyMapping) || Object.keys(propertyMapping).length === 0) {
    return { valid: false, error: { code: 'INVALID_PARAMETER', message: 'propertyMapping must be a non-empty object' } };
  }
  
  // Step 4: Check all required Interface properties are mapped
  const requiredProps = interfaceProperties.filter(p => p.is_required);
  for (const reqProp of requiredProps) {
    if (!(reqProp.api_name in propertyMapping)) {
      return { valid: false, error: { code: 'MISSING_REQUIRED_MAPPING', message: `Interface property '${reqProp.api_name}' is required but not present in propertyMapping` } };
    }
  }
  
  // Step 5: Check all mapping keys are valid Interface property names
  const interfacePropNames = new Set(interfaceProperties.map(p => p.api_name));
  for (const key of Object.keys(propertyMapping)) {
    if (!interfacePropNames.has(key)) {
      return { valid: false, error: { code: 'INVALID_MAPPING_KEY', message: `'${key}' is not a property of Interface '${interfaceApiName}'` } };
    }
  }
  
  // Step 6: Check all mapping values are valid Object Type property names
  for (const [ifProp, otProp] of Object.entries(propertyMapping)) {
    if (!otProperties.has(otProp)) {
      return { valid: false, error: { code: 'INVALID_MAPPING_VALUE', message: `'${otProp}' is not a property of Object Type '${objectTypeApiName}'` } };
    }
  }
  
  // Step 7: Check type compatibility
  const interfacePropTypeMap = new Map(interfaceProperties.map(p => [p.api_name, p.base_type]));
  for (const [ifProp, otProp] of Object.entries(propertyMapping)) {
    const ifType = interfacePropTypeMap.get(ifProp);
    const otType = otProperties.get(otProp);
    if (ifType !== otType) {
      return { valid: false, error: { code: 'TYPE_MISMATCH', message: `Object Type property '${otProp}' has type '${otType}' but Interface property '${ifProp}' requires type '${ifType}'` } };
    }
  }
  
  // Step 8: Check no duplicate mapping targets
  const targetValues = Object.values(propertyMapping);
  const uniqueTargets = new Set(targetValues);
  if (targetValues.length !== uniqueTargets.size) {
    const duplicates = targetValues.filter((v, i) => targetValues.indexOf(v) !== i);
    return { valid: false, error: { code: 'DUPLICATE_MAPPING_TARGET', message: `Object Type property '${duplicates[0]}' is mapped to multiple Interface properties` } };
  }
  
  return { valid: true };
}
```

---

## Sub-task 7B: Implement getInterfacePropertiesForObjectType and checkInterfacePropertyInUse

**Function 2: `getInterfacePropertiesForObjectType(objectTypeId)`**

Returns all Interface properties that this Object Type has inherited through its Interface implementations, mapped to the actual Object Type property names. This is used by the Object Views API (Task 11) to show which properties come from which Interfaces.

```javascript
async function getInterfacePropertiesForObjectType(objectTypeId) {
  const result = await pool.query(`
    SELECT 
      i.api_name AS interface_api_name,
      i.display_name AS interface_display_name,
      ip.api_name AS interface_property_name,
      ip.base_type,
      oti.property_mapping
    FROM object_type_interface oti
    JOIN interface i ON i.interface_id = oti.interface_id
    JOIN interface_property ip ON ip.interface_id = i.interface_id
    WHERE oti.object_type_id = $1
    ORDER BY i.api_name, ip.ordinal
  `, [objectTypeId]);
  
  // Group by interface, resolve property mappings
  const interfaceMap = new Map();
  for (const row of result.rows) {
    if (!interfaceMap.has(row.interface_api_name)) {
      interfaceMap.set(row.interface_api_name, {
        interfaceApiName: row.interface_api_name,
        interfaceDisplayName: row.interface_display_name,
        properties: [],
      });
    }
    const iface = interfaceMap.get(row.interface_api_name);
    const mapping = row.property_mapping || {};
    // Find which Object Type property this Interface property maps to
    const mappedToObjectTypeProp = mapping[row.interface_property_name] || null;
    iface.properties.push({
      interfacePropName: row.interface_property_name,
      mappedToObjectTypeProp,
      baseType: row.base_type,
    });
  }
  return Array.from(interfaceMap.values());
}
```

**Function 3: `checkInterfacePropertyInUse(interfaceId, propertyApiName)`**

Checks whether a specific Interface property is currently mapped by any implementing Object Type. Used by the PUT endpoint (Task 4) before removing a property from an Interface definition.

Returns: `{ inUse: boolean, usedBy: string[] }` where `usedBy` is the list of Object Type api_names that map this property.

Export all three functions from the module.

---

## Sub-task 7C: Refactor Route Handlers to Use Validator Service

Update the route handlers in Tasks 4 and 6 to delegate to `interfaceValidator.js`:

1. In the PUT handler (Task 4), replace inline property-in-use checking with a call to `checkInterfacePropertyInUse(interfaceId, propertyApiName)` for each property being removed or type-changed.
2. In the POST implements handler (Task 6), replace inline validation logic (rules 5-10) with a call to `validatePropertyMapping(ontologyId, objectTypeApiName, interfaceApiName, propertyMapping)`.
3. Verify all existing tests for Tasks 4 and 6 still pass after refactoring.

## Verification
1. Write unit tests for `validatePropertyMapping` covering all 8 check steps
2. Test with valid mapping → returns `{ valid: true }`
3. Test with missing required property → returns correct error
4. Test with type mismatch → returns correct error
5. Test with duplicate target → returns correct error
6. Test `getInterfacePropertiesForObjectType` with an Object Type implementing 2 Interfaces
7. Test `checkInterfacePropertyInUse` with a property that is and isn't in use
