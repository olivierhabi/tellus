// ---------------------------------------------------------------------------
// Link Resolver Test Suite
//
// Comprehensive automated test exercising every link resolver with every
// cardinality, both directions, filters, pagination, and edge cases.
//
// Self-contained: creates its own ontology, object types, CSV data,
// OpenSearch indices, and link types — then tears it all down.
//
// Run:  npx tsx tests/linkResolvers.test.ts
//
// Requires: PostgreSQL running + OpenSearch running on localhost:9200
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { Runner } from "./helpers/runner";
import { api, BASE_URL } from "./helpers/api";
import { ensureServer, stopServer } from "./helpers/server";
import { client as osClient } from "../src/services/opensearch/client";
import { query as dbQuery } from "../src/db";

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

interface State {
  ontologyId: string;
  companyOtId: string;
  employeeOtId: string;
  ticketOtId: string;
  courseOtId: string;
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const state: State = {
  ontologyId: "",
  companyOtId: "",
  employeeOtId: "",
  ticketOtId: "",
  courseOtId: "",
};

// ---------------------------------------------------------------------------
// CSV generators
// ---------------------------------------------------------------------------

function writeCSV(filename: string, header: string, rows: string[]): string {
  const filePath = path.join(DATA_DIR, filename);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, [header, ...rows].join("\n") + "\n", "utf-8");
  return filePath;
}

function generateCompanyCSV(): string {
  const rows: string[] = [];
  for (let i = 1; i <= 5; i++) {
    rows.push(`C${String(i).padStart(3, "0")},Company ${i},Industry ${i % 3}`);
  }
  return writeCSV("test-link-companies.csv", "company_id,name,industry", rows);
}

function generateEmployeeCSV(count: number): string {
  const rows: string[] = [];
  const depts = ["Engineering", "Sales", "HR"];
  for (let i = 1; i <= count; i++) {
    const companyId = `C${String(((i - 1) % 5) + 1).padStart(3, "0")}`;
    const managerId = i > 5 ? `E${String(i - 5).padStart(4, "0")}` : "";
    rows.push(
      `E${String(i).padStart(4, "0")},Employee ${i},${companyId},${depts[i % 3]},${50000 + i * 100},${managerId}`
    );
  }
  return writeCSV("test-link-employees.csv", "emp_id,name,company_id,department,salary,manager_id", rows);
}

function generateTicketCSV(): string {
  const rows: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const assignee = `E${String(((i - 1) % 10) + 1).padStart(4, "0")}`;
    rows.push(`T${String(i).padStart(3, "0")},Ticket ${i},${assignee},open`);
  }
  return writeCSV("test-link-tickets.csv", "ticket_id,title,assignee_id,status", rows);
}

function generateCourseCSV(): string {
  const rows: string[] = [];
  // Course 1-10: each course has enrollees as CSV-style FK refs
  // For MANY_TO_MANY we use a shared FK pattern: courses have an "instructor_id"
  // pointing to employee PKs, and employees have company_id.
  for (let i = 1; i <= 10; i++) {
    const instructor = `E${String(((i - 1) % 10) + 1).padStart(4, "0")}`;
    rows.push(`COURSE-${String(i).padStart(3, "0")},Course ${i},${instructor},active`);
  }
  return writeCSV("test-link-courses.csv", "course_id,title,instructor_id,status", rows);
}

// ---------------------------------------------------------------------------
// Cleanup CSV files
// ---------------------------------------------------------------------------

function cleanupCSV(): void {
  const files = [
    "test-link-companies.csv",
    "test-link-employees.csv",
    "test-link-tickets.csv",
    "test-link-courses.csv",
  ];
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// ---------------------------------------------------------------------------
// Helper: wait for indexing to complete
// ---------------------------------------------------------------------------

async function triggerIndex(
  ontologyId: string,
  apiName: string,
  opts: Record<string, unknown> = {}
): Promise<any> {
  const { status, body } = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/${apiName}/index`,
    { forceRecreateIndex: true, strict: false, ...opts }
  );

  // Force an immediate OpenSearch refresh so documents are searchable
  // right away (default refresh_interval is 1s which is too slow for tests)
  if (status === 200) {
    const indexName = `ontology-${apiName.toLowerCase()}`;
    try {
      await osClient.indices.refresh({ index: indexName });
    } catch {
      // Index may not exist if indexing failed — ignore
    }
  }

  return { status, body };
}

// ---------------------------------------------------------------------------
// Setup: Create ontology, object types, upload CSVs, index, create links
// ---------------------------------------------------------------------------

async function setup(t: Runner): Promise<void> {
  t.section("Setup: Create ontology, object types, data, and link types");

  // 1. Create ontology
  await t.test("Create test ontology", async () => {
    const { status, body } = await api("GET", "/api/v1/ontology/default");
    t.assert(status === 200, `Expected 200, got ${status}`);
    state.ontologyId = body.ontologyId ?? body?.data?.ontologyId;
    t.assert(!!state.ontologyId, "ontologyId set");
  });

  // Singleton deployment: the ontology is the shared canonical enterprise
  // ontology, so leftover artifacts from a prior (interrupted) run of this
  // suite — or from another suite that created the same apiNames — would
  // make the create calls below 409 and skew the "List link types returns 5"
  // count. Clean them up idempotently before creating anything.
  await cleanupLinkResolverArtifacts();

  const oid = () => state.ontologyId;

  // 2. Create Company object type
  await t.test("Create Company object type", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/batch`,
      {
        apiName: "Company",
        displayName: "Company",
        properties: [
          { apiName: "companyId", displayName: "Company ID", baseType: "string", isRequired: true },
          { apiName: "name", displayName: "Name", baseType: "string" },
          { apiName: "industry", displayName: "Industry", baseType: "string" },
        ],
        primaryKeyProperty: "companyId",
        titleProperty: "name",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  // 3. Create Employee object type (with companyId FK and managerId self-ref FK)
  await t.test("Create LREmployee object type", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/batch`,
      {
        apiName: "LREmployee",
        displayName: "LREmployee",
        properties: [
          { apiName: "employeeId", displayName: "Employee ID", baseType: "string", isRequired: true },
          { apiName: "name", displayName: "Name", baseType: "string" },
          { apiName: "companyId", displayName: "Company ID (FK)", baseType: "string" },
          { apiName: "department", displayName: "Department", baseType: "string" },
          { apiName: "salary", displayName: "Salary", baseType: "double" },
          { apiName: "managerId", displayName: "Manager ID (self-ref FK)", baseType: "string" },
        ],
        primaryKeyProperty: "employeeId",
        titleProperty: "name",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  // 4. Create Ticket object type (with assigneeId FK → Employee)
  await t.test("Create Ticket object type", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/batch`,
      {
        apiName: "Ticket",
        displayName: "Ticket",
        properties: [
          { apiName: "ticketId", displayName: "Ticket ID", baseType: "string", isRequired: true },
          { apiName: "title", displayName: "Title", baseType: "string" },
          { apiName: "assigneeId", displayName: "Assignee ID (FK)", baseType: "string" },
          { apiName: "status", displayName: "Status", baseType: "string" },
        ],
        primaryKeyProperty: "ticketId",
        titleProperty: "title",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  // 5. Create Course object type (for MANY_TO_MANY)
  await t.test("Create Course object type", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/batch`,
      {
        apiName: "Course",
        displayName: "Course",
        properties: [
          { apiName: "courseId", displayName: "Course ID", baseType: "string", isRequired: true },
          { apiName: "title", displayName: "Title", baseType: "string" },
          { apiName: "instructorId", displayName: "Instructor ID (FK)", baseType: "string" },
          { apiName: "status", displayName: "Status", baseType: "string" },
        ],
        primaryKeyProperty: "courseId",
        titleProperty: "title",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  // 6. Generate and register CSVs
  const companyCsvPath = generateCompanyCSV();
  const employeeCsvPath = generateEmployeeCSV(20); // 20 employees for most tests
  const ticketCsvPath = generateTicketCSV();
  const courseCsvPath = generateCourseCSV();

  await t.test("Register Company datasource", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/Company/datasource`,
      {
        datasetName: "Company DS",
        filePath: companyCsvPath,
        fileFormat: "csv",
        columnMapping: { companyId: "company_id", name: "name", industry: "industry" },
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
  });

  await t.test("Register Employee datasource", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/LREmployee/datasource`,
      {
        datasetName: "Employee DS",
        filePath: employeeCsvPath,
        fileFormat: "csv",
        columnMapping: {
          employeeId: "emp_id",
          name: "name",
          companyId: "company_id",
          department: "department",
          salary: "salary",
          managerId: "manager_id",
        },
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
  });

  await t.test("Register Ticket datasource", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/Ticket/datasource`,
      {
        datasetName: "Ticket DS",
        filePath: ticketCsvPath,
        fileFormat: "csv",
        columnMapping: { ticketId: "ticket_id", title: "title", assigneeId: "assignee_id", status: "status" },
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
  });

  await t.test("Register Course datasource", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/objectTypes/Course/datasource`,
      {
        datasetName: "Course DS",
        filePath: courseCsvPath,
        fileFormat: "csv",
        columnMapping: { courseId: "course_id", title: "title", instructorId: "instructor_id", status: "status" },
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}`);
  });

  // 7. Index all object types
  await t.test("Index Company", async () => {
    const { status, body } = await triggerIndex(oid(), "Company");
    t.assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body?.error || body?.status).substring(0, 200)}`);
  });

  await t.test("Index LREmployee", async () => {
    const { status, body } = await triggerIndex(oid(), "LREmployee");
    t.assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body?.error || body?.status).substring(0, 200)}`);
  });

  await t.test("Index Ticket", async () => {
    const { status, body } = await triggerIndex(oid(), "Ticket");
    t.assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body?.error || body?.status).substring(0, 200)}`);
  });

  await t.test("Index Course", async () => {
    const { status, body } = await triggerIndex(oid(), "Course");
    t.assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body?.error || body?.status).substring(0, 200)}`);
  });

  // 8. Create link types for all 4 cardinalities
  //
  // ONE_TO_MANY:  Company (source) → Employee (target via companyId FK on Employee)
  // MANY_TO_ONE:  Employee (source via companyId FK) → Company (target)
  // ONE_TO_ONE:   Employee (source) → Ticket (target via assigneeId FK) [1:1 for test]
  // MANY_TO_MANY: Employee (source) ↔ Course (target via instructorId FK)
  // Self-ref:     Employee (source) → Employee (target via managerId FK)

  await t.test("Create ONE_TO_MANY link: companyEmployees", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/linkTypes`,
      {
        apiName: "companyEmployees",
        displayName: "Company Employees",
        cardinality: "ONE_TO_MANY",
        sourceObjectTypeApiName: "Company",
        targetObjectTypeApiName: "LREmployee",
        targetPropertyApiName: "companyId",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  await t.test("Create MANY_TO_ONE link: employeeCompany", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/linkTypes`,
      {
        apiName: "employeeCompany",
        displayName: "Employee Company",
        cardinality: "MANY_TO_ONE",
        sourceObjectTypeApiName: "LREmployee",
        targetObjectTypeApiName: "Company",
        sourcePropertyApiName: "companyId",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  await t.test("Create ONE_TO_ONE link: employeeTicket", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/linkTypes`,
      {
        apiName: "employeeTicket",
        displayName: "Employee Ticket",
        cardinality: "ONE_TO_ONE",
        sourceObjectTypeApiName: "LREmployee",
        targetObjectTypeApiName: "Ticket",
        targetPropertyApiName: "assigneeId",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  await t.test("Create MANY_TO_MANY link: employeeCourses", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/linkTypes`,
      {
        apiName: "employeeCourses",
        displayName: "Employee Courses",
        cardinality: "MANY_TO_MANY",
        sourceObjectTypeApiName: "LREmployee",
        targetObjectTypeApiName: "Course",
        targetPropertyApiName: "instructorId",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });

  await t.test("Create self-referential link: employeeManager", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${oid()}/linkTypes`,
      {
        apiName: "employeeManager",
        displayName: "Employee Manager",
        cardinality: "MANY_TO_ONE",
        sourceObjectTypeApiName: "LREmployee",
        targetObjectTypeApiName: "LREmployee",
        sourcePropertyApiName: "managerId",
      }
    );
    t.assert(status === 201, `Expected 201, got ${status}: ${JSON.stringify(body).substring(0, 200)}`);
  });
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function linkUrl(apiName: string): string {
  return `/api/v1/ontology/${state.ontologyId}/linkTypes/${apiName}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runLinkTests(t: Runner): Promise<void> {
  // =========================================================================
  // Test 1: Link type CRUD — list
  // =========================================================================
  t.section("Link Type CRUD");

  await t.test("1. List link types returns the 5 created", async () => {
    const { status, body } = await api("GET", `/api/v1/ontology/${state.ontologyId}/linkTypes`);
    t.assert(status === 200, `Expected 200, got ${status}`);
    // Singleton deployment: the canonical ontology is shared and may already
    // contain seeded link types (e.g. taxpayerBusiness). Assert the 5 link
    // types this suite created are all present rather than the exact total.
    const names = (body.data || []).map((o: any) => o.apiName);
    for (const expected of LR_LINK_TYPES.filter((n) => n !== "tempLink")) {
      t.assert(names.includes(expected), `link type '${expected}' present`);
    }
    t.assert(names.length >= 5, `at least 5 link types, got ${names.length}`);
  });

  await t.test("2. Get link type by apiName", async () => {
    const { status, body } = await api("GET", `${linkUrl("companyEmployees")}`);
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.apiName === "companyEmployees", `apiName = ${body.apiName}`);
    t.assert(body.cardinality === "ONE_TO_MANY", `cardinality = ${body.cardinality}`);
  });

  // =========================================================================
  // Test 3-4: ONE_TO_MANY forward and reverse
  // =========================================================================
  t.section("ONE_TO_MANY: Company → Employees");

  await t.test("3. ONE_TO_MANY forward: Company C001 → Employees", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {
      objectPK: "C001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // Employees with companyId = C001: E0001, E0006, E0011, E0016 (every 5th, offset by 1)
    t.assert(body.totalCount === 4, `Expected 4 employees, got ${body.totalCount}`);
    const pks = body.linkedObjects.map((o: any) => o.employeeId);
    t.assert(pks.includes("E0001"), "Contains E0001");
    t.assert(pks.includes("E0006"), "Contains E0006");
  });

  await t.test("4. ONE_TO_MANY reverse: Employee E0001 → Company", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {
      objectPK: "E0001",
      direction: "reverse",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.totalCount === 1, `Expected 1 company, got ${body.totalCount}`);
    t.assert(body.linkedObjects[0].companyId === "C001", `Company is C001`);
  });

  // =========================================================================
  // Test 5-6: MANY_TO_ONE forward and reverse
  // =========================================================================
  t.section("MANY_TO_ONE: Employee → Company");

  await t.test("5. MANY_TO_ONE forward: Employee E0001 → Company", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/resolve`, {
      objectPK: "E0001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // MANY_TO_ONE forward returns singular { linkedObject } (at most one result)
    t.assert(body.linkedObject !== undefined, `Expected linkedObject, got ${JSON.stringify(body)}`);
    t.assert(body.linkedObject.companyId === "C001", "Resolved to C001");
  });

  await t.test("6. MANY_TO_ONE reverse: Company C001 → Employees", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/resolve`, {
      objectPK: "C001",
      direction: "reverse",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.totalCount === 4, `Expected 4 employees, got ${body.totalCount}`);
  });

  // =========================================================================
  // Test 7-8: ONE_TO_ONE forward and reverse
  // =========================================================================
  t.section("ONE_TO_ONE: Employee ↔ Ticket");

  await t.test("7. ONE_TO_ONE forward: Employee E0001 → Ticket", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeTicket")}/resolve`, {
      objectPK: "E0001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // ONE_TO_ONE forward returns singular { linkedObject } (at most one result)
    t.assert(body.linkedObject !== undefined, `Expected linkedObject, got ${JSON.stringify(body)}`);
    t.assert(body.linkedObject.assigneeId === "E0001", "Ticket assigned to E0001");
  });

  await t.test("8. ONE_TO_ONE reverse: Ticket T001 → Employee", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeTicket")}/resolve`, {
      objectPK: "T001",
      direction: "reverse",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.totalCount === 1, `Expected 1 employee, got ${body.totalCount}`);
    t.assert(body.linkedObjects[0].employeeId === "E0001", "Resolved to E0001");
  });

  // =========================================================================
  // Test 9-10: MANY_TO_MANY forward and reverse
  // =========================================================================
  t.section("MANY_TO_MANY: Employee ↔ Course");

  await t.test("9. MANY_TO_MANY forward: Employee E0001 → Courses", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCourses")}/resolve`, {
      objectPK: "E0001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // Courses with instructorId = E0001: COURSE-001 and COURSE-011 (but only 10 courses)
    t.assert(body.totalCount >= 1, `Expected at least 1 course, got ${body.totalCount}`);
  });

  await t.test("10. MANY_TO_MANY reverse: Course COURSE-001 → Employees", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCourses")}/resolve`, {
      objectPK: "COURSE-001",
      direction: "reverse",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // No source property set on employeeCourses, so reverse via sourcePropertyApiName is empty
    // This is expected since we only set targetPropertyApiName
    // The reverse for MANY_TO_MANY needs sourcePropertyApiName — this tests the "no source prop" edge case
    t.assert(body.totalCount === 0, `Expected 0 (no source property set), got ${body.totalCount}`);
  });

  // =========================================================================
  // Test 11-12: Target filter
  // =========================================================================
  t.section("Target Filters");

  await t.test("11. ONE_TO_MANY with targetFilter: C001 employees in Engineering", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {
      objectPK: "C001",
      direction: "forward",
      targetFilter: { department: "Engineering" },
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // Only Engineering employees of C001
    for (const obj of body.linkedObjects) {
      t.assert(obj.department === "Engineering", `Employee ${obj.employeeId} is in Engineering`);
    }
  });

  await t.test("12. MANY_TO_ONE with targetFilter: filter by industry", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/resolve`, {
      objectPK: "E0001",
      direction: "forward",
      targetFilter: { industry: "Industry 1" },
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // MANY_TO_ONE forward returns singular { linkedObject } — C001 has industry "Industry 1"
    t.assert(body.linkedObject !== undefined && body.linkedObject !== null, `Expected linkedObject match, got ${JSON.stringify(body)}`);
  });

  await t.test("13. Target filter returning no results", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/resolve`, {
      objectPK: "E0001",
      direction: "forward",
      targetFilter: { industry: "NonexistentIndustry" },
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // MANY_TO_ONE forward returns singular { linkedObject: null } when no match
    t.assert(body.linkedObject === null, `Expected null linkedObject, got ${JSON.stringify(body.linkedObject)}`);
  });

  // =========================================================================
  // Test 14: Pagination
  // =========================================================================
  t.section("Pagination");

  await t.test("14. Pagination on ONE_TO_MANY: page 1", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {
      objectPK: "C001",
      direction: "forward",
      pageSize: 2,
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.linkedObjects.length === 2, `Page 1: 2 items, got ${body.linkedObjects.length}`);
    t.assert(body.totalCount === 4, `Total: 4, got ${body.totalCount}`);
    t.assert(body.nextPageToken !== null, "Has next page token");

    // Page 2
    const { body: body2 } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {
      objectPK: "C001",
      direction: "forward",
      pageSize: 2,
      pageToken: body.nextPageToken,
    });
    t.assert(body2.linkedObjects.length === 2, `Page 2: 2 items, got ${body2.linkedObjects.length}`);

    // Verify no overlap between pages
    const page1PKs = new Set(body.linkedObjects.map((o: any) => o.employeeId));
    const page2PKs = body2.linkedObjects.map((o: any) => o.employeeId);
    for (const pk of page2PKs) {
      t.assert(!page1PKs.has(pk), `No overlap: ${pk} not in page 1`);
    }
  });

  // =========================================================================
  // Test 15: Self-referential link
  // =========================================================================
  t.section("Self-referential Links");

  await t.test("15. Self-ref forward: Employee E0006 → Manager", async () => {
    // E0006 has managerId = E0001 (i=6, manager = E0001 since 6-5=1)
    // employeeManager is MANY_TO_ONE → forward returns singular { linkedObject }
    const { status, body } = await api("POST", `${linkUrl("employeeManager")}/resolve`, {
      objectPK: "E0006",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.linkedObject !== undefined && body.linkedObject !== null, `Expected 1 manager, got ${JSON.stringify(body)}`);
    t.assert(body.linkedObject.employeeId === "E0001", "Manager is E0001");
  });

  await t.test("16. Self-ref reverse: Employee E0001 → Direct reports", async () => {
    // Employees with managerId = E0001: E0006, E0011, E0016
    const { status, body } = await api("POST", `${linkUrl("employeeManager")}/resolve`, {
      objectPK: "E0001",
      direction: "reverse",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.totalCount >= 1, `Expected at least 1 report, got ${body.totalCount}`);
    const reporterIds = body.linkedObjects.map((o: any) => o.employeeId);
    t.assert(reporterIds.includes("E0006"), "E0006 reports to E0001");
  });

  // =========================================================================
  // Test 17: Empty results — object with no links
  // =========================================================================
  t.section("Edge Cases");

  await t.test("17. No links: Employee E0001 has no manager (empty managerId)", async () => {
    // E0001 has managerId = "" (empty), so forward resolve should return null
    // MANY_TO_ONE forward returns singular { linkedObject: null }
    const { status, body } = await api("POST", `${linkUrl("employeeManager")}/resolve`, {
      objectPK: "E0001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.linkedObject === null, `Expected null (no manager), got ${JSON.stringify(body.linkedObject)}`);
  });

  // =========================================================================
  // Test 18: Null FK value
  // =========================================================================

  await t.test("18. Null FK: first 5 employees have empty managerId", async () => {
    // E0001-E0005 have empty managerId
    // MANY_TO_ONE forward returns singular { linkedObject: null }
    const { status, body } = await api("POST", `${linkUrl("employeeManager")}/resolve`, {
      objectPK: "E0003",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.linkedObject === null, `Expected null for null FK, got ${JSON.stringify(body.linkedObject)}`);
  });

  // =========================================================================
  // Test 19: Orphaned FK value (FK points to non-existent PK)
  // =========================================================================

  await t.test("19. Orphaned FK: resolve non-existent company", async () => {
    // This tests resolving forward for an employee whose companyId doesn't match
    // any indexed company. Using nonexistent PK.
    // MANY_TO_ONE forward returns singular { linkedObject: null }
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/resolve`, {
      objectPK: "NONEXISTENT",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.linkedObject === null, `Expected null for non-existent source, got ${JSON.stringify(body.linkedObject)}`);
  });

  // =========================================================================
  // Test 20-22: Count endpoints
  // =========================================================================
  t.section("Link Count");

  await t.test("20. Count: ONE_TO_MANY forward for C001", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/count`, {
      objectPK: "C001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.count === 4, `Expected count=4, got ${body.count}`);
    t.assert(body.linkTypeApiName === "companyEmployees", `apiName = ${body.linkTypeApiName}`);
  });

  await t.test("21. Count: MANY_TO_ONE forward for E0001", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/count`, {
      objectPK: "E0001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.count === 1, `Expected count=1, got ${body.count}`);
  });

  await t.test("22. Count: ONE_TO_ONE forward for E0001", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeTicket")}/count`, {
      objectPK: "E0001",
      direction: "forward",
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.count >= 1, `Expected count>=1, got ${body.count}`);
  });

  // =========================================================================
  // Test 23: Bulk count
  // =========================================================================
  t.section("Bulk Count");

  await t.test("23. Bulk count across multiple link types", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${state.ontologyId}/linkTypes/bulkCount`,
      {
        requests: [
          { linkTypeApiName: "companyEmployees", objectPK: "C001", direction: "forward" },
          { linkTypeApiName: "companyEmployees", objectPK: "C002", direction: "forward" },
          { linkTypeApiName: "employeeCompany", objectPK: "E0001", direction: "forward" },
          { linkTypeApiName: "nonexistentLink", objectPK: "X", direction: "forward" },
        ],
      }
    );
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.results.length === 4, `Expected 4 results, got ${body.results.length}`);
    t.assert(body.results[0].count === 4, `C001 employees = 4, got ${body.results[0].count}`);
    t.assert(body.results[2].count === 1, `E0001 company = 1, got ${body.results[2].count}`);
    // Non-existent link type returns null count and an error
    t.assert(body.results[3].count === null || body.results[3].count === 0, `Nonexistent link = 0 or null, got ${body.results[3].count}`);
    t.assert(body.results[3].error !== undefined, "Nonexistent link has error");
  });

  // =========================================================================
  // Test 24: Search Around
  // =========================================================================
  t.section("Search Around");

  await t.test("24. Search Around: Employees in Engineering → their Companies", async () => {
    const { status, body } = await api("POST", `${linkUrl("employeeCompany")}/searchAround`, {
      direction: "forward",
      sourceFilter: { department: "Engineering" },
    });
    t.assert(status === 200, `Expected 200, got ${status}`);
    // Engineering employees point to various companies
    t.assert(body.totalCount >= 1, `Expected at least 1 linked company, got ${body.totalCount}`);
    // All returned objects should be companies (have companyId)
    for (const obj of body.linkedObjects) {
      t.assert(obj.companyId !== undefined, `Linked object has companyId: ${obj.companyId}`);
    }
  });

  // =========================================================================
  // Test 25: Validation errors
  // =========================================================================
  t.section("Validation Errors");

  await t.test("25. Resolve without required fields returns 400", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {});
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "VALIDATION_FAILED", `code = ${body.error.code}`);
  });

  await t.test("26. Resolve with invalid direction returns 400", async () => {
    const { status, body } = await api("POST", `${linkUrl("companyEmployees")}/resolve`, {
      objectPK: "C001",
      direction: "sideways",
    });
    t.assert(status === 400, `Expected 400, got ${status}`);
  });

  await t.test("27. Resolve non-existent link type returns 404", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${state.ontologyId}/linkTypes/nonexistentLink/resolve`,
      { objectPK: "X", direction: "forward" }
    );
    t.assert(status === 404, `Expected 404, got ${status}`);
  });

  await t.test("28. Duplicate link type creation returns 409", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${state.ontologyId}/linkTypes`,
      {
        apiName: "companyEmployees",
        displayName: "Duplicate",
        cardinality: "ONE_TO_MANY",
        sourceObjectTypeApiName: "Company",
        targetObjectTypeApiName: "LREmployee",
      }
    );
    t.assert(status === 409, `Expected 409, got ${status}`);
  });

  await t.test("29. Invalid cardinality returns 400", async () => {
    const { status } = await api(
      "POST",
      `/api/v1/ontology/${state.ontologyId}/linkTypes`,
      {
        apiName: "badLink",
        displayName: "Bad",
        cardinality: "INVALID",
        sourceObjectTypeApiName: "Company",
        targetObjectTypeApiName: "LREmployee",
      }
    );
    t.assert(status === 400, `Expected 400, got ${status}`);
  });

  // =========================================================================
  // Test 30: Delete link type
  // =========================================================================
  t.section("Link Type Deletion");

  await t.test("30. Delete link type", async () => {
    // Create a temporary link, then delete it
    const { status: createStatus } = await api(
      "POST",
      `/api/v1/ontology/${state.ontologyId}/linkTypes`,
      {
        apiName: "tempLink",
        displayName: "Temporary",
        cardinality: "ONE_TO_ONE",
        sourceObjectTypeApiName: "Company",
        targetObjectTypeApiName: "LREmployee",
      }
    );
    t.assert(createStatus === 201, `Create temp link: ${createStatus}`);

    const { status: deleteStatus } = await api(
      "DELETE",
      `/api/v1/ontology/${state.ontologyId}/linkTypes/tempLink`
    );
    t.assert(deleteStatus === 200, `Delete temp link: ${deleteStatus}`);

    // Verify it's gone
    const { status: getStatus } = await api(
      "GET",
      `/api/v1/ontology/${state.ontologyId}/linkTypes/tempLink`
    );
    t.assert(getStatus === 404, `After delete, GET returns 404: ${getStatus}`);
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardown(t: Runner): Promise<void> {
  t.section("Teardown");

  // Delete OpenSearch indices + the object/link types this suite created.
  // (See setup() for why explicit cleanup is required under the singleton
  // deployment — the ontology-level cascade no longer fires.)
  await cleanupLinkResolverArtifacts();

  // Confirm the ontology delete is frozen under the singleton deployment.
  await t.test("Delete test ontology", async () => {
    const { status } = await api("DELETE", `/api/v1/ontology/${state.ontologyId}`);
    t.assert(status === 204 || status === 200 || status === 409, `Expected 204/200/409, got ${status}`);
  });

  // Clean up CSV files
  cleanupCSV();
  console.log("  CSV files cleaned up.");
}

// ---------------------------------------------------------------------------
// Idempotent cleanup of the artifacts this suite creates. Called from both
// setup (pre-clean leftovers from a prior run) and teardown. Safe to call
// when nothing exists — every deletion ignores errors.
// ---------------------------------------------------------------------------
const LR_LINK_TYPES = [
  "companyEmployees",
  "employeeCompany",
  "employeeTicket",
  "employeeCourses",
  "employeeManager",
  "tempLink",
];
const LR_OBJECT_TYPES = ["Company", "LREmployee", "Ticket", "Course"];

async function cleanupLinkResolverArtifacts(): Promise<void> {
  if (!state.ontologyId) return;
  for (const apiName of LR_OBJECT_TYPES) {
    try {
      await api(
        "DELETE",
        `/api/v1/ontology/${state.ontologyId}/objectTypes/${apiName}/index`
      );
    } catch {
      // Ignore — index may not exist
    }
  }
  for (const apiName of LR_LINK_TYPES) {
    try {
      await api("DELETE", `/api/v1/ontology/${state.ontologyId}/linkTypes/${apiName}`);
    } catch {
      // Ignore — link type may not exist
    }
  }
  for (const apiName of LR_OBJECT_TYPES) {
    try {
      await api("DELETE", `/api/v1/ontology/${state.ontologyId}/objectTypes/${apiName}`);
    } catch {
      // Ignore — object type may not exist
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nLink Resolver Test Suite\n`);
  console.log(`Testing against: ${BASE_URL}\n`);

  const t = new Runner();

  await ensureServer();

  // Check OpenSearch availability
  let opensearchAvailable = false;
  try {
    const { isOpenSearchAvailable } = await import("./helpers/opensearchLane");
    opensearchAvailable = await isOpenSearchAvailable();
  } catch {
    opensearchAvailable = false;
  }

  if (!opensearchAvailable) {
    console.log("ERROR: OpenSearch is not available (https + Basic auth, see tests/helpers/opensearchLane.ts).");
    console.log("This test suite requires a running OpenSearch instance for link resolution.");
    console.log("Start OpenSearch and try again.\n");
    stopServer();
    process.exit(1);
  }

  // Reset any stale "running" pipeline states from previous failed test runs
  try {
    await dbQuery(
      `UPDATE funnel_pipeline_state SET status = 'failed', error_message = 'reset by test pre-cleanup' WHERE status = 'running'`
    );
  } catch {
    // Table may not exist or DB not connected — ignore
  }

  try {
    await setup(t);
    await runLinkTests(t);
    await teardown(t);
  } catch (err) {
    console.error("\nFatal error:", err);
    // Attempt teardown even on fatal error
    try {
      await teardown(t);
    } catch {
      // Ignore teardown errors
    }
  }

  t.summary("Link Resolver");

  stopServer();
  process.exit(t.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  stopServer();
  process.exit(1);
});
