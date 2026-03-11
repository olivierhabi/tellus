# TASK 21: Create the Datasource File Validator

**File to create:** `/src/services/indexing/datasourceValidator.js`

**Purpose:** Validates that a datasource file is compatible with an object type before indexing begins. Checks that: the file exists and is readable, all mapped columns exist in the file, the primary key column exists, the file has at least one data row, and the file can be parsed as valid CSV (no binary content, no encoding errors). This runs before the full pipeline to give early, clear error messages.

**Specification:**

Export: `validateDatasource(objectTypeApiName)` that:

1. Looks up the object type record from the `object_type` table by `api_name` to obtain `object_type_id`, then calls `getByObjectType(objectTypeId)` from Monday's `/src/services/datasourceService.js` to fetch the backing datasource config. If no datasource is registered (function returns `null`), return immediately:
   ```javascript
   {
     valid: false,
     checks: {
       fileReadable: { passed: false, error: "No backing datasource registered for object type '{objectTypeApiName}'" },
       allColumnsExist: { passed: false, missingColumns: [] },
       primaryKeyExists: { passed: false },
       hasDataRows: { passed: false, rowCount: 0 },
       previewTypesValid: { passed: false, conversionErrors: [] }
     }
   }
   ```
2. Reads the CSV headers by calling `getCSVSchema(filePath)` from Task 5's `/src/services/indexing/csvReader.js`. If this returns `{ success: false }`, the file check fails.
3. Checks every column name in `column_mapping` exists in the CSV headers array.
4. Checks `primary_key_column` exists in the CSV headers array.
5. Reads a 5-row preview by calling `getCSVPreview(filePath, 5)` from Task 5, then passes each value through `convertValue(value, property)` from Task 6's `/src/services/indexing/typeConverter.js`, collecting conversion failures.
6. Returns a validation report with this exact shape:

```javascript
{
  valid: true|false,
  checks: {
    fileReadable: { passed: true|false, error: "..." },
    allColumnsExist: { passed: true|false, missingColumns: [] },
    primaryKeyExists: { passed: true|false },
    hasDataRows: { passed: true|false, rowCount: 0 },
    previewTypesValid: { passed: true|false, conversionErrors: [
      { row: 1, property: "salary", value: "abc", error: "Cannot convert 'abc' to double" }
    ] }
  }
}
```

The `valid` field is `true` only if ALL checks passed. Individual check results are always included so the caller can see which specific checks failed.

**Test to verify:** Create a valid CSV and verify all checks pass. Create a CSV missing a mapped column, verify `allColumnsExist` fails with the correct missing column name. Create a CSV with type-incompatible values, verify `previewTypesValid` fails with correct errors.
