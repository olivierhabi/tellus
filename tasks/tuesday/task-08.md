# TASK 8: Create the Row Transformer

**File to create:** `/src/services/indexing/rowTransformer.js`

**Purpose:** This module transforms a single CSV row into an OpenSearch document ready for indexing. It is the bridge between the raw CSV data (string values with CSV column names) and the indexed Ontology object (typed values with property API names plus system fields). In Palantir's Funnel architecture, this is the step where a datasource row becomes an Ontology object — the column-to-property mapping is applied, type conversion runs, and system metadata is added.

**Detailed specification:**

The module must export a single function: `transformRow(row, lineNumber, objectType, properties, columnMapping, options)` where:
- `row` — A single row object from the CSV reader, keyed by CSV column names
- `lineNumber` — The 1-indexed line number (for error reporting)
- `objectType` — The object type record from PostgreSQL (needs `api_name`, `primary_key_property_id`)
- `properties` — Array of all property records from PostgreSQL for this object type
- `columnMapping` — The `column_mapping` JSONB from the `backing_datasource` table: `{ "propertyApiName": "csvColumnName" }`
- `options` — Optional configuration:
  - `datasourceVersion` (string, default: null): The transaction/version identifier for this indexing run
  - `strict` (boolean, default: true): If true, reject row on any conversion error. If false, set failed fields to null and continue.

**Step-by-step transformation logic:**

1. **Initialize the document** with system fields:
   ```javascript
   const doc = {
     __objectType: objectType.api_name,
     __lastModified: new Date().toISOString(),
     __version: 1,
     __editedBy: null,
     __datasourceVersion: options.datasourceVersion || null,
   };
   ```

2. **Determine the primary key property.** Find the property whose `property_id` matches `objectType.primary_key_property_id`. Get its API name (e.g., "employeeId"). Look up the corresponding CSV column name from `columnMapping` (e.g., "emp_id"). Extract the raw value from the CSV row. Convert it to a string (primary keys are always stored as strings in `__pk`, even if the property type is integer). Set `doc.__pk = String(convertedPkValue)`.

3. **Iterate over all properties** and for each property:
   a. Look up the CSV column name from `columnMapping[property.api_name]`. If the property has no mapping (not all properties must be mapped — some might be computed or set via actions later), skip it and set the property to null in the document.
   b. Extract the raw value from the CSV row using the column name.
   c. Call `convertValue(rawValue, property)` from Task 6's `/src/services/indexing/typeConverter.js` to perform type conversion.
   d. If conversion succeeds (`valid: true`), set `doc[property.api_name] = converted.value`.
   e. If conversion fails (`valid: false`):
      - If `options.strict` is true, collect the error and mark the row as invalid.
      - If `options.strict` is false, set `doc[property.api_name] = null` and add a warning.

4. **Handle unmapped columns.** CSV columns that are NOT in the `columnMapping` are ignored. They are not included in the document. This is expected — the user explicitly chose which columns map to which properties, and some CSV columns might be irrelevant.

5. **Return the result:**
   ```javascript
   // Success:
   {
     valid: true,
     document: {
       __pk: "EMP-001",
       __objectType: "Employee",
       __lastModified: "2025-03-11T10:30:00.000Z",
       __version: 1,
       __editedBy: null,
       __datasourceVersion: "txn-001",
       employeeId: "EMP-001",
       fullName: "Melissa Chang",
       salary: 145000,
       startDate: "2020-03-15",
       isActive: true,
       skills: ["python", "java", "sql"]
     },
     lineNumber: 1,
     warnings: []
   }
   
   // Failure:
   {
     valid: false,
     document: null,
     lineNumber: 45,
     errors: [
       "Property 'salary': Cannot convert 'not-a-number' to double",
       "Property 'startDate': Cannot parse date 'sometime-in-march'. Accepted formats: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY"
     ],
     warnings: []
   }
   ```

**Test to verify:** Transform a row with: a string property, integer property, double property, date property, boolean property, string_array property, and a geopoint property. Verify all values are correctly typed in the output document. Also test a row with conversion errors in strict and non-strict modes.
