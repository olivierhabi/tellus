# TASK 18: Build Multi-Rule Action Execution Tests

**Objective:** Create comprehensive integration tests that verify multi-rule actions work correctly. A multi-rule action contains 2+ rules that execute together as an atomic unit. This tests the rule compiler's merge logic (Task 6) and the edit applicator's transactional behavior (Task 7) working together end-to-end.

**Create test file** at `src/tests/multiRuleActions.test.js`.

**Test 1: Create + Link in one action.**
Set up an action type "onboardEmployee" that:
- Rule 1: createObject Employee with given properties
- Rule 2: addLink employeeCompany linking the new employee to an existing company

This tests the `pendingEdits` feature in the link handler (Task 15) — the link rule must detect that the employee was created by a preceding rule in the same action, even though it's not yet in OpenSearch.

```javascript
// Define the action type
await createActionType(ontologyId, {
    apiName: 'onboardEmployee',
    displayName: 'Onboard Employee',
    parameters: [
        { apiName: 'empId', type: 'string', required: true },
        { apiName: 'name', type: 'string', required: true },
        { apiName: 'companyId', type: 'string', required: true }
    ],
    rules: [
        { type: 'createObject', objectType: 'Employee', properties: {
            employeeId: { source: 'parameter', param: 'empId' },
            fullName: { source: 'parameter', param: 'name' },
            companyId: { source: 'parameter', param: 'companyId' }
        }},
        { type: 'addLink', linkType: 'employeeCompany',
          sourceObject: { source: 'parameter', param: 'empId' },
          targetObject: { source: 'parameter', param: 'companyId' } }
    ]
});

// Execute
const result = await executeAction(ontologyId, 'onboardEmployee',
    { empId: 'EMP-ONBOARD', name: 'New Hire', companyId: 'COMP-001' },
    { executedBy: 'hr-admin' }
);
assert(result.success === true);
assert(result.affectedObjects.length >= 1);

// Verify object was created
const emp = await fetchObject('Employee', 'EMP-ONBOARD');
assert(emp.fullName === 'New Hire');

// Verify link was created
const links = await fetchLinkedObjects('Employee', 'EMP-ONBOARD', 'employeeCompany');
assert(links.length === 1);
assert(links[0].__pk === 'COMP-001');
```

**Test 2: Create + Modify in one action (same object).**
An action that creates an employee and immediately modifies a property on the same object. This tests the merge logic: create + modify for the same PK should produce a single 'create' edit with merged properties.

```javascript
await createActionType(ontologyId, {
    apiName: 'createAndTag',
    parameters: [
        { apiName: 'empId', type: 'string', required: true },
        { apiName: 'name', type: 'string', required: true }
    ],
    rules: [
        { type: 'createObject', objectType: 'Employee', properties: {
            employeeId: { source: 'parameter', param: 'empId' },
            fullName: { source: 'parameter', param: 'name' },
            status: { source: 'static', value: 'pending' }
        }},
        { type: 'modifyObject', objectType: 'Employee',
          objectReference: { source: 'parameter', param: 'empId' },
          properties: { status: { source: 'static', value: 'active' } } }
    ]
});

const result = await executeAction(ontologyId, 'createAndTag',
    { empId: 'EMP-TAG', name: 'Tagged Person' }, { executedBy: 'system' });
assert(result.success === true);

// The merged result should have status='active' (modify overrides create's 'pending')
const emp = await fetchObject('Employee', 'EMP-TAG');
assert(emp.status === 'active');
```

**Test 3: Modify multiple objects in one action.**
An action that modifies 3 different employees' departments in one execution.

```javascript
await createActionType(ontologyId, {
    apiName: 'bulkReassign',
    parameters: [
        { apiName: 'emp1', type: 'string', required: true },
        { apiName: 'emp2', type: 'string', required: true },
        { apiName: 'emp3', type: 'string', required: true },
        { apiName: 'newDept', type: 'string', required: true }
    ],
    rules: [
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'parameter', param: 'emp1' },
          properties: { department: { source: 'parameter', param: 'newDept' } } },
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'parameter', param: 'emp2' },
          properties: { department: { source: 'parameter', param: 'newDept' } } },
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'parameter', param: 'emp3' },
          properties: { department: { source: 'parameter', param: 'newDept' } } }
    ]
});

const result = await executeAction(ontologyId, 'bulkReassign',
    { emp1: 'EMP-001', emp2: 'EMP-002', emp3: 'EMP-003', newDept: 'New Dept' },
    { executedBy: 'system' });
assert(result.success === true);
assert(result.affectedObjects.length === 3);

// Verify all three were updated
for (const pk of ['EMP-001', 'EMP-002', 'EMP-003']) {
    const emp = await fetchObject('Employee', pk);
    assert(emp.department === 'New Dept');
}

// Verify single audit log entry (one action execution, not three)
const auditEntry = await getAuditEntry(result.executionId);
assert(auditEntry.affected_object_count === 3);
```

**Test 4: Scale limit enforcement.**
Create an action that would affect more objects than `maxAffectedObjects` and verify it fails.

```javascript
// Create an action type with a low maxAffectedObjects limit
await createActionType(ontologyId, {
    apiName: 'scaleLimitTest',
    displayName: 'Scale Limit Test',
    parameters: [
        { apiName: 'emp1', type: 'string', required: true },
        { apiName: 'emp2', type: 'string', required: true },
        { apiName: 'emp3', type: 'string', required: true },
        { apiName: 'newDept', type: 'string', required: true }
    ],
    rules: [
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'parameter', param: 'emp1' },
          properties: { department: { source: 'parameter', param: 'newDept' } } },
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'parameter', param: 'emp2' },
          properties: { department: { source: 'parameter', param: 'newDept' } } },
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'parameter', param: 'emp3' },
          properties: { department: { source: 'parameter', param: 'newDept' } } }
    ],
    maxAffectedObjects: 2 // limit is 2, but action affects 3 objects
});

const result = await executeAction(ontologyId, 'scaleLimitTest',
    { emp1: 'EMP-001', emp2: 'EMP-002', emp3: 'EMP-003', newDept: 'Overflow' },
    { executedBy: 'system' });
assert(result.success === false);
assert(result.failureType === 'scale_limit');
```

**Test 5: Atomicity test — partial failure should roll back.**
Create a multi-rule action where rule 1 would succeed but rule 2 would fail (e.g., modifying a non-existent object). Verify that rule 1's changes are NOT applied (the entire action is atomic).

```javascript
// First, define the atomicTest action type
await createActionType(ontologyId, {
    apiName: 'atomicTest',
    displayName: 'Atomicity Test',
    parameters: [
        { apiName: 'emp1', type: 'string', required: true },
        { apiName: 'emp2', type: 'string', required: true },
        { apiName: 'newSalary', type: 'double', required: true }
    ],
    rules: [
        // Rule 1: Modify existing EMP-001 (would succeed on its own)
        { type: 'modifyObject', objectType: 'Employee',
          objectReference: { source: 'parameter', param: 'emp1' },
          properties: { salary: { source: 'parameter', param: 'newSalary' } } },
        // Rule 2: Modify nonexistent EMP-FAKE (will fail)
        { type: 'modifyObject', objectType: 'Employee',
          objectReference: { source: 'parameter', param: 'emp2' },
          properties: { salary: { source: 'parameter', param: 'newSalary' } } }
    ]
});

const result = await executeAction(ontologyId, 'atomicTest',
    { emp1: 'EMP-001', emp2: 'EMP-FAKE', newSalary: 999999 },
    { executedBy: 'system' });
assert(result.success === false);
assert(result.failureType === 'object_not_found');

// Verify EMP-001 was NOT modified (rollback)
const emp = await fetchObject('Employee', 'EMP-001');
assert(emp.salary !== 999999); // should still have old salary
```

**Test prerequisites:** Before running these tests, ensure the following objects exist in OpenSearch:
- `Employee` objects with PKs `EMP-001`, `EMP-002`, `EMP-003` (for Tests 3, 4, 5)
- A `Company` object with PK `COMP-001` (for Test 1)

Use `beforeAll` hooks to create this test data via direct OpenSearch indexing or via createObject actions.

**Test framework:** Use the same test framework as the existing test suite (check `package.json` for the configured test runner). If no test runner is configured, use Node.js built-in `node:test` with `node:assert`.
