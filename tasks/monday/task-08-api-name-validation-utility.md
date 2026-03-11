# TASK 8 OF 30: API Name Validation Utility

**Objective:** Create validation functions enforcing Palantir's naming conventions for Ontology resource types. These validators are used by service layers (Tasks 11, 13, 15) to reject invalid names before they reach the database.

**Step-by-step instructions:**

Create src/utils/apiNameValidator.js.

**Validator 1: validateObjectTypeName(name)**

Rules:
- Must match regex: `^[A-Z][a-zA-Z0-9]{0,255}$` (PascalCase, starts with uppercase letter, alphanumeric only, max 256 chars total)
- Must NOT be a reserved word. Reserved words: `Object`, `Function`, `Action`, `Link`, `Interface`, `Property`, `Type`, `Set`, `Query`, `Search`, `Aggregate`, `Ontology`, `System`
- Must NOT start with `__` (double underscore prefix reserved for internal use)

Returns: `{valid: true}` or `{valid: false, error: "Object type name must be PascalCase..."}`.

Error messages:
- If regex fails: `"Object type name must be PascalCase (start with uppercase letter, alphanumeric only, max 256 chars). Got: '{name}'"`
- If reserved: `"'{name}' is a reserved word and cannot be used as an object type name."`
- If starts with `__`: `"Object type name cannot start with '__' (reserved for internal use)."`

**Validator 2: validatePropertyName(name)**

Rules:
- Must match regex: `^[a-z][a-zA-Z0-9]{0,255}$` (camelCase, starts with lowercase letter, alphanumeric only, max 256 chars)
- Must NOT be a reserved word. Reserved words: `__pk`, `__objectType`, `__lastModified`, `__version`, `__editedBy`
- Must NOT start with `__`

Returns: `{valid: true}` or `{valid: false, error: "..."}`.

Error messages:
- If regex fails: `"Property name must be camelCase (start with lowercase letter, alphanumeric only, max 256 chars). Got: '{name}'"`
- If reserved: `"'{name}' is a reserved property name."`
- If starts with `__`: `"Property name cannot start with '__' (reserved for internal use)."`

**Validator 3: validateLinkTypeName(name)** — same rules and regex as validatePropertyName (camelCase).

**Validator 4: validateActionTypeName(name)** — same rules and regex as validatePropertyName (camelCase).

**Validator 5: validateInterfaceName(name)** — same rules and regex as validateObjectTypeName (PascalCase).

Note: Validators 3, 4, and 5 are not used in the current 30-task scope (link types, action types, and interfaces are future sprints). They are included here because the naming rules are defined by the same Palantir specification and should be implemented together. Consumers will be added when those features are built.

**Function 6: toIndexName(objectTypeApiName)**

Converts an object type API name to an OpenSearch index name. Rules:
- Prefix: `"ontology-"`
- Convert apiName to lowercase
- Result: `"ontology-" + apiName.toLowerCase()`
- Example: `"Employee"` → `"ontology-employee"`, `"CustomsDeclaration"` → `"ontology-customsdeclaration"`
- Validation: result must be a valid OpenSearch index name (all lowercase, max 255 bytes, no characters outside `[a-z0-9-]`). If validation fails, throw an Error with message `"Cannot convert '{apiName}' to a valid OpenSearch index name."`. In practice this won't happen because PascalCase names only contain `[A-Za-z0-9]`, but the check is a safety net.

**Exports:** `validateObjectTypeName`, `validatePropertyName`, `validateLinkTypeName`, `validateActionTypeName`, `validateInterfaceName`, `toIndexName`, `RESERVED_OBJECT_TYPE_NAMES` (the array), `RESERVED_PROPERTY_NAMES` (the array).

**Inline self-tests** (run when `require.main === module`):
1. `validateObjectTypeName('Employee')` → `{valid: true}`
2. `validateObjectTypeName('employee')` → `{valid: false, ...}` (starts lowercase)
3. `validateObjectTypeName('Object')` → `{valid: false, ...}` (reserved)
4. `validatePropertyName('employeeId')` → `{valid: true}`
5. `validatePropertyName('EmployeeId')` → `{valid: false, ...}` (starts uppercase)
6. `validatePropertyName('__pk')` → `{valid: false, ...}` (reserved)
7. `toIndexName('Employee')` → `"ontology-employee"`
8. `toIndexName('CustomsDeclaration')` → `"ontology-customsdeclaration"`

**Files to create:** src/utils/apiNameValidator.js

**Verification:**
- `node src/utils/apiNameValidator.js` runs all inline tests and prints "All API name validator tests passed"
