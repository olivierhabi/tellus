// ---------------------------------------------------------------------------
// Shared Test Fixture — Query Test Setup & Teardown (Task 26)
//
// Creates a test ontology with Employee + Company object types, generates
// 100 deterministic Employee records, indexes them into OpenSearch, and
// provides teardown to clean up afterwards.
// ---------------------------------------------------------------------------

import { api } from "../helpers/api";

// ---------------------------------------------------------------------------
// Test employees — 5 explicit + 95 generated = 100 total
// ---------------------------------------------------------------------------

const DEPARTMENTS = ["Engineering", "Sales", "Marketing", "Finance", "HR"];
const SKILL_POOL = [
  "Python", "TypeScript", "SQL", "Java", "Kubernetes",
  "Salesforce", "HubSpot", "SEO", "Analytics", "Excel",
  "SAP", "React", "Node.js", "Docker", "AWS",
];

export interface TestEmployee {
  employeeId: string;
  fullName: string;
  email: string | null;
  salary: number;
  department: string;
  startDate: string;
  isActive: boolean;
  skills: string[];
}

// 5 explicit employees
const EXPLICIT_EMPLOYEES: TestEmployee[] = [
  { employeeId: "EMP-001", fullName: "Melissa Chang", email: "melissa.chang@acme.com", salary: 145000, department: "Engineering", startDate: "2021-03-15", isActive: true, skills: ["Python", "TypeScript", "SQL"] },
  { employeeId: "EMP-002", fullName: "Diego Rodriguez", email: "diego.rodriguez@acme.com", salary: 130000, department: "Sales", startDate: "2022-08-01", isActive: true, skills: ["Salesforce", "HubSpot"] },
  { employeeId: "EMP-003", fullName: "Akriti Patel", email: "akriti.patel@acme.com", salary: 155000, department: "Engineering", startDate: "2020-06-20", isActive: true, skills: ["Java", "Kubernetes"] },
  { employeeId: "EMP-004", fullName: "Michael O'Brien", email: "michael.obrien@acme.com", salary: 120000, department: "Marketing", startDate: "2023-01-10", isActive: false, skills: ["SEO", "Analytics"] },
  { employeeId: "EMP-005", fullName: "Jean-Pierre Habimana", email: "jp.habimana@acme.com", salary: 160000, department: "Finance", startDate: "2019-11-05", isActive: true, skills: ["Excel", "SAP"] },
];

// Generate 95 more employees (EMP-006 through EMP-100)
function generateEmployees(): TestEmployee[] {
  const employees: TestEmployee[] = [...EXPLICIT_EMPLOYEES];

  // Department distribution among generated: 20 Eng, 20 Sales, 20 Mkt, 20 Fin, 15 HR
  const deptDistribution = [
    ...Array(20).fill("Engineering"),
    ...Array(20).fill("Sales"),
    ...Array(20).fill("Marketing"),
    ...Array(20).fill("Finance"),
    ...Array(15).fill("HR"),
  ];

  // isActive distribution: 76 true, 19 false (to total 80 true, 20 false with explicit)
  const activeDistribution = [
    ...Array(76).fill(true),
    ...Array(19).fill(false),
  ];

  const years = [2019, 2020, 2021, 2022, 2023, 2024];

  for (let i = 0; i < 95; i++) {
    const empNum = i + 6;
    const empId = `EMP-${String(empNum).padStart(3, "0")}`;
    const salary = 50000 + Math.round((i / 95) * 150000);
    const dept = deptDistribution[i];
    const active = activeDistribution[i];
    const yearIdx = Math.floor((i / 95) * years.length);
    const year = years[Math.min(yearIdx, years.length - 1)];
    const month = String((i % 12) + 1).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    const startDate = `${year}-${month}-${day}`;

    // Email: null for EMP-050 and EMP-075
    const email = empNum === 50 || empNum === 75
      ? null
      : `emp${empNum}@acme.com`;

    // Skills: 1-3 from rotating pool
    const skillCount = (i % 3) + 1;
    const skills: string[] = [];
    for (let s = 0; s < skillCount; s++) {
      skills.push(SKILL_POOL[(i + s) % SKILL_POOL.length]);
    }

    employees.push({
      employeeId: empId,
      fullName: `Employee ${empNum}`,
      email,
      salary,
      department: dept,
      startDate,
      isActive: active,
      skills,
    });
  }

  return employees;
}

export const TEST_EMPLOYEES = generateEmployees();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testOntologyId: string | null = null;

export async function setupTestData(): Promise<string> {
  // Create ontology
  const { body: ontBody } = await api("POST", "/api/v2/ontologies", {
    displayName: "QueryTestOntology",
    description: "Test ontology for query integration tests",
  });
  testOntologyId = ontBody?.data?.ontologyId || ontBody?.ontologyId;
  if (!testOntologyId) throw new Error("Failed to create test ontology");

  // Create Employee object type
  await api("POST", `/api/v2/ontologies/${testOntologyId}/objectTypes`, {
    apiName: "QueryTestEmployee",
    displayName: "Query Test Employee",
    description: "Employee for query testing",
  });

  // Create properties
  const props = [
    { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
    { apiName: "fullName", displayName: "Full Name", baseType: "string" },
    { apiName: "email", displayName: "Email", baseType: "string" },
    { apiName: "salary", displayName: "Salary", baseType: "double" },
    { apiName: "department", displayName: "Department", baseType: "string" },
    { apiName: "startDate", displayName: "Start Date", baseType: "date" },
    { apiName: "isActive", displayName: "Is Active", baseType: "boolean" },
    { apiName: "skills", displayName: "Skills", baseType: "string" },
  ];

  for (const p of props) {
    await api("POST", `/api/v2/ontologies/${testOntologyId}/objectTypes/QueryTestEmployee/properties`, p);
  }

  // Create Company object type (empty — for pagination cross-type test)
  await api("POST", `/api/v2/ontologies/${testOntologyId}/objectTypes`, {
    apiName: "QueryTestCompany",
    displayName: "Query Test Company",
    description: "Company for query testing",
  });
  await api("POST", `/api/v2/ontologies/${testOntologyId}/objectTypes/QueryTestCompany/properties`, {
    apiName: "companyId", displayName: "Company ID", baseType: "string",
  });
  await api("POST", `/api/v2/ontologies/${testOntologyId}/objectTypes/QueryTestCompany/properties`, {
    apiName: "name", displayName: "Name", baseType: "string",
  });

  return testOntologyId;
}

export async function teardownTestData(): Promise<void> {
  if (testOntologyId) {
    await api("DELETE", `/api/v2/ontologies/${testOntologyId}`);
    testOntologyId = null;
  }
}
