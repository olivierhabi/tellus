## TASK 23: Build Integration Test — Mapping Suggestion Engine

### Context
This test verifies that the column mapping suggestion engine (Task 10) produces reasonable suggestions for different column naming conventions. RRA's real datasets will have columns in various naming styles — some in camelCase, some in snake_case, some abbreviated, some in Kinyarwanda or French.

### Exact Specification

Create `/tests/integration/test07_mapping_suggestions.js`:

**Setup:** For each test, create a temporary object type with the specified properties (using `POST /api/v2/ontology/{id}/objectTypes` and `POST /api/v2/ontology/{id}/objectTypes/{apiName}/properties`) and upload a temporary dataset with the specified columns (using `POST /api/v2/datasets/upload`). After all tests complete, clean up all temporary resources.

**Test sequence:**

Test 7.1: Perfect match (column names identical to property API names)
```
Properties: employeeId, fullName, salary, startDate
Columns: employeeId, fullName, salary, startDate
Assert: all mappings have confidence "exact"
Assert: readyToRegister === true
```

Test 7.2: Snake_case to camelCase
```
Properties: employeeId, fullName, salary, startDate
Columns: employee_id, full_name, salary, start_date
Assert: all mappings found with confidence "exact" or "high"
Assert: suggestedMapping.employeeId.column === "employee_id"
Assert: suggestedMapping.fullName.column === "full_name"
Assert: suggestedMapping.salary.column === "salary"
Assert: suggestedMapping.startDate.column === "start_date"
Assert: columnMapping is: { employeeId: "employee_id", fullName: "full_name", salary: "salary", startDate: "start_date" }
```

Test 7.3: Abbreviated columns
```
Properties: employeeId, fullName, annualSalary, departmentName
Columns: emp_id, name, sal, dept
Assert: employeeId → emp_id (substring match)
Assert: fullName → name (substring match)
Assert: annualSalary → sal (partial match, lower confidence)
Assert: departmentName → dept (partial match, lower confidence)
```

Test 7.4: Extra columns in dataset (should appear in unmappedColumns)
```
Properties: employeeId, fullName
Columns: emp_id, full_name, internal_code, legacy_flag, created_at
Assert: employeeId and fullName are mapped
Assert: unmappedColumns includes internal_code, legacy_flag, created_at
```

Test 7.5: Missing columns (required property has no match)
```
Properties: employeeId (required), fullName (required), salary
Columns: emp_id, annual_salary (no full_name equivalent)
Assert: readyToRegister === false (fullName is required but unmapped)
Assert: unmappedProperties includes fullName with reason explaining no match
```

Test 7.6: Type-based disambiguation
```
Properties: amount (double), count (integer), label (string)
Columns: value1 (number), value2 (number), description (string)
Assert: The set {suggestedMapping.amount.column, suggestedMapping.count.column} equals {"value1", "value2"} (order-independent — either assignment is valid since both columns are numeric)
Assert: suggestedMapping.label.column === "description" (both are strings)
```

**Cleanup:**
After all tests complete, delete all temporary ontologies, object types, and datasets.

### Validation Criteria
- Exact name matches get highest confidence
- Snake_case ↔ camelCase conversion works
- Abbreviated names are detected with lower confidence
- Extra columns appear in unmappedColumns
- Missing required properties set readyToRegister=false
- Type compatibility influences mapping choice
- Confidence levels match Task 10's scoring thresholds: exact (>=90), high (70-89), medium (40-69), low (20-39)
