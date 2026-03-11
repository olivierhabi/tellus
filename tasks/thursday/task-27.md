# TASK 27: Build Automated Integration Test Suite for the Link Subsystem

**Objective:** Create a comprehensive integration test file that tests every link resolver, Search Around, link count endpoints, and self-referential links through HTTP API calls. This test file should be runnable with a single command and should set up its own test data and tear it down after.

**Prerequisites:** Tasks 1-17 and Task 21 must be fully implemented and functional. The Express server must be running at `http://localhost:3000` with PostgreSQL and OpenSearch accessible before running this test suite.

**Test framework:** Use Node.js 20's built-in test runner (`node:test` module with `describe`, `it`, `before`, `after`). Use `node:assert/strict` for assertions. Do NOT use Jest or any third-party test framework.

**Testing interface:** All tests must be **integration tests** calling the HTTP API endpoints using Node.js's built-in `fetch` (available in Node 20+). Do NOT import resolver functions directly — test the full stack: Express routing → validation → resolver dispatch → OpenSearch queries → response formatting.

**Run command:** `node --test tests/linkResolvers.test.js`

**Implementation:** Create `tests/linkResolvers.test.js`:

**Test Data Setup (in `before` hook):**

Create the following test data via API calls to `http://localhost:3000`:

1. Create a test ontology with `apiName: "test_link_suite_${Date.now()}"` (unique name to avoid collisions). Store the returned `ontologyId`.

2. Create 4 object types with these exact schemas:
   - `TestCompany`: properties `companyId` (string, PK), `companyName` (string), `industry` (string)
   - `TestEmployee`: properties `employeeId` (string, PK), `fullName` (string), `department` (string), `companyId` (string), `managerId` (string)
   - `TestTicket`: properties `ticketId` (string, PK), `title` (string), `status` (string), `assigneeEmployeeId` (string)
   - `TestCourse`: properties `courseId` (string, PK), `courseName` (string)

3. Upload CSV data via the existing CSV upload endpoints:
   - 3 Companies: `COMP-001,Acme,Technology` / `COMP-002,Globex,Manufacturing` / `COMP-003,Initech,Technology`
   - 10 Employees:
     - `EMP-001,Alice,Engineering,COMP-001,` (managerId=null, top manager)
     - `EMP-002,Bob,Engineering,COMP-001,EMP-001`
     - `EMP-003,Carol,Sales,COMP-002,EMP-001`
     - `EMP-004,Dave,Engineering,COMP-001,EMP-001`
     - `EMP-005,Eve,Engineering,,` (companyId=null — no company link)
     - `EMP-006,Frank,Sales,COMP-999,` (companyId=COMP-999 — orphaned FK)
     - `EMP-007,Grace,Engineering,COMP-001,`
     - `EMP-008,Heidi,Manufacturing,COMP-002,`
     - `EMP-009,Ivan,Sales,COMP-002,`
     - `EMP-010,Judy,Engineering,COMP-003,`
   - 5 Tickets: `TKT-001,Bug Fix,open,EMP-001` / `TKT-002,Feature,closed,EMP-001` / `TKT-003,Task,open,EMP-002` / `TKT-004,Bug Fix,open,EMP-003` / `TKT-005,Feature,open,EMP-004`
   - 3 Courses: `CRS-001,Databases,` / `CRS-002,Networking,` / `CRS-003,Security,`
   - For pagination testing: 505 additional Tickets (TKT-P001 through TKT-P505) all with `assigneeEmployeeId=EMP-010`.

4. Index all 4 object types into OpenSearch.

5. Create link types:
   - `companyEmployees`: Company → Employee, ONE_TO_MANY, FK: `companyId` on target side, bidirectional: true
   - `employeeCompany`: Employee → Company, MANY_TO_ONE, FK: `companyId` on source side, bidirectional: true
   - `employeeTickets`: Employee → Ticket, ONE_TO_MANY, FK: `assigneeEmployeeId` on target side, bidirectional: true
   - `employeeCourses`: Employee → Course, MANY_TO_MANY, join table, bidirectional: true
   - `manages`: Employee → Employee, ONE_TO_MANY, FK: `managerId` on target side, bidirectional: true (self-referential)

6. Create and upload the MANY_TO_MANY join table CSV at `data/join_tables/test_employee_courses.csv`:
   ```
   employeeId,courseId
   EMP-001,CRS-001
   EMP-001,CRS-002
   EMP-002,CRS-001
   EMP-003,CRS-003
   EMP-004,CRS-001
   EMP-004,CRS-002
   EMP-004,CRS-003
   ```
   Upload via the Task 17 join table upload endpoint.

**Test Cases (28 total):**

```
describe('ONE_TO_MANY', () => {
  // Test 1: Forward - Company → Employees
  it('resolves Company COMP-001 → Employees', async () => {
    // GET /api/v2/objects/TestCompany/COMP-001/links/companyEmployees
    // Expect: data contains EMP-001, EMP-002, EMP-004, EMP-007 (4 employees with companyId=COMP-001)
    // Expect: totalCount = 4
  });

  // Test 2: Forward - Company with many employees (pagination)
  it('paginates through COMP-003 tickets via EMP-010', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-010/links/employeeTickets?$pageSize=100
    // Expect: data.length = 100, nextPageToken is not null, totalCount = 505
    // Follow nextPageToken for 5 more pages, verify all 505 tickets received
  });

  // Test 3: Forward with targetFilter
  it('filters Employees by department', async () => {
    // GET /api/v2/objects/TestCompany/COMP-001/links/companyEmployees
    //   with targetFilter: { type: "eq", field: "department", value: "Engineering" }
    // Expect: only Engineering employees returned (EMP-001, EMP-002, EMP-004, EMP-007)
  });

  // Test 4: Reverse - Employee → Company (reverse of ONE_TO_MANY = MANY_TO_ONE)
  it('resolves reverse: Employee → Company via companyEmployees', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-001/links/companyEmployees
    // Expect: data is single object COMP-001
  });
});

describe('MANY_TO_ONE', () => {
  // Test 5: Forward - Employee → Company
  it('resolves Employee EMP-002 → Company', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-002/links/employeeCompany
    // Expect: data = { __primaryKey: "COMP-001", ... }
  });

  // Test 6: Reverse - Company → Employees (reverse of MANY_TO_ONE = ONE_TO_MANY)
  it('resolves reverse: Company → Employees via employeeCompany', async () => {
    // GET /api/v2/objects/TestCompany/COMP-001/links/employeeCompany
    // Expect: data is array of employees with companyId=COMP-001
  });

  // Test 7: Null FK value
  it('returns null for Employee with no company (null FK)', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-005/links/employeeCompany
    // Expect: data = null, linked = false
  });

  // Test 8: Orphaned FK value
  it('returns null for Employee with orphaned FK', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-006/links/employeeCompany
    // Expect: data = null, linked = false (COMP-999 doesn't exist)
  });
});

describe('MANY_TO_MANY', () => {
  // Test 9: Forward - Employee → Courses
  it('resolves Employee EMP-001 → Courses', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-001/links/employeeCourses
    // Expect: data contains CRS-001 and CRS-002, totalCount = 2
  });

  // Test 10: Forward - Employee with 3 courses
  it('resolves Employee EMP-004 → Courses (3 courses)', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-004/links/employeeCourses
    // Expect: data contains CRS-001, CRS-002, CRS-003, totalCount = 3
  });

  // Test 11: Reverse - Course → Employees
  it('resolves reverse: Course CRS-001 → Employees', async () => {
    // GET /api/v2/objects/TestCourse/CRS-001/links/employeeCourses
    // Expect: data contains EMP-001, EMP-002, EMP-004, totalCount = 3
  });

  // Test 12: Employee with no courses
  it('returns empty for Employee with no courses', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-005/links/employeeCourses
    // Expect: data = [], totalCount = 0
  });
});

describe('Self-referential links', () => {
  // Test 13: Forward - Manager → Reports
  it('resolves EMP-001 → managed employees (forward)', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-001/links/manages
    // Expect: data contains EMP-002, EMP-003, EMP-004 (3 reports)
    // Expect: EMP-001 is NOT in results (self-exclusion)
  });

  // Test 14: Reverse - Employee → Manager
  it('resolves EMP-002 → manager (reverse)', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-002/links/manages?$direction=reverse
    // Expect: data = { __primaryKey: "EMP-001", ... }
  });

  // Test 15: Forward default for self-referential
  it('defaults to forward when no direction specified', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-002/links/manages (no $direction)
    // Expect: forward traversal — returns employees where managerId=EMP-002 (empty)
    // Expect: totalCount = 0
  });
});

describe('Search Around', () => {
  // Test 16: Basic Search Around
  it('finds all Tickets for Engineering Employees', async () => {
    // POST /api/v2/objects/TestEmployee/searchAround
    // Body: { sourceFilter: { type: "eq", field: "department", value: "Engineering" },
    //         linkType: "employeeTickets" }
    // Expect: tickets assigned to Engineering employees (EMP-001: TKT-001,TKT-002; EMP-002: TKT-003; EMP-004: TKT-005)
  });

  // Test 17: Search Around with targetFilter
  it('finds open Tickets for Engineering Employees', async () => {
    // POST /api/v2/objects/TestEmployee/searchAround
    // Body: { sourceFilter: { type: "eq", field: "department", value: "Engineering" },
    //         linkType: "employeeTickets",
    //         targetFilter: { type: "eq", field: "status", value: "open" } }
    // Expect: only open tickets (TKT-001, TKT-003, TKT-005)
  });
});

describe('Link Count', () => {
  // Test 18: Single link count
  it('counts COMP-001 employees', async () => {
    // GET /api/v2/objects/TestCompany/COMP-001/links/companyEmployees/count
    // Expect: count = 4
  });

  // Test 19: Zero link count
  it('returns 0 for object with no links', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-005/links/employeeTickets/count
    // Expect: count = 0
  });

  // Test 20: Bulk link count
  it('returns counts for all link types on Employee', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-001/links
    // Expect: links array contains entries for employeeCompany (count=1),
    //         employeeTickets (count=2), employeeCourses (count=2), manages (count=3)
  });
});

describe('Error cases', () => {
  // Test 21: Non-existent link type
  it('returns 404 for non-existent link type', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-001/links/nonExistentLink
    // Expect: HTTP 404
  });

  // Test 22: Object type not part of link
  it('returns 400 when object type is not part of link', async () => {
    // GET /api/v2/objects/TestTicket/TKT-001/links/companyEmployees
    // Expect: HTTP 400
  });

  // Test 23: Non-existent starting object
  it('returns 404 for non-existent starting object', async () => {
    // GET /api/v2/objects/TestEmployee/NONEXISTENT/links/employeeCompany
    // Expect: HTTP 404
  });

  // Test 24: Invalid direction parameter
  it('returns 400 for invalid direction', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-001/links/manages?$direction=sideways
    // Expect: HTTP 400
  });

  // Test 25: Non-bidirectional reverse traversal
  // (Create a non-bidirectional link type in setup, or create it inline)
  it('returns 400 for reverse traversal on non-bidirectional link', async () => {
    // Create a non-bidirectional link type, attempt reverse traversal
    // Expect: HTTP 400
  });
});

describe('Pagination edge cases', () => {
  // Test 26: pageSize=1 returns correct nextPageToken
  it('paginates with pageSize=1', async () => {
    // GET /api/v2/objects/TestCompany/COMP-001/links/companyEmployees?$pageSize=1
    // Expect: data.length = 1, nextPageToken is not null
  });

  // Test 27: Following pageToken to completion
  it('traverses all pages to completion', async () => {
    // Start with pageSize=2 on COMP-001 → Employees (4 total)
    // Page 1: 2 results + nextPageToken
    // Page 2: 2 results + nextPageToken = null
    // Verify all 4 unique employees received across both pages
  });

  // Test 28: Large page size (>10000) is capped silently
  it('caps pageSize at 10000', async () => {
    // GET /api/v2/objects/TestEmployee/EMP-010/links/employeeTickets?$pageSize=99999
    // Should not error — pageSize is silently capped at 10000
    // Expect: HTTP 200
  });
});
```

**Test Data Teardown (in `after` hook):**

Wrap teardown in `try/finally` to ensure it runs even if tests fail:

1. Delete all OpenSearch indices matching the test object types: `DELETE /ontology-testcompany`, `DELETE /ontology-testemployee`, `DELETE /ontology-testticket`, `DELETE /ontology-testcourse`.
2. Delete the test ontology via `DELETE /api/v2/ontology/${ontologyId}` (which should CASCADE delete object_type, property, and link_type rows via PostgreSQL CASCADE constraints).
3. Delete the join table CSV file: `data/join_tables/test_employee_courses.csv`.

**File to create:** `tests/linkResolvers.test.js`

**Testing:** Run `node --test tests/linkResolvers.test.js` and verify all 28 tests pass.
