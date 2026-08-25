// ---------------------------------------------------------------------------
// Integration Test 01: Full Upload-to-Query Pipeline
//
// Tests the complete lifecycle: create ontology → create object type with
// properties → upload CSV → register datasource → reindex → query objects.
//
// Run: npx tsx tests/integration/test01_upload_to_query.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import os from "os";

const BASE = process.env.API_BASE || (process.env.TEST_BASE_URL ?? "http://localhost:3000");

async function run() {
  let passed = 0;
  let failed = 0;
  const suiteStart = Date.now();

  console.log("=== Integration Test: Full Upload-to-Query Pipeline ===\n");

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function api(method: string, urlPath: string, body?: unknown) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  function assert(condition: boolean, label: string, detail?: string) {
    const t = Date.now() - suiteStart;
    if (condition) {
      console.log(`  Test ${label}: PASS (${t}ms)`);
      passed++;
    } else {
      console.error(`  Test ${label}: FAIL (${t}ms)${detail ? " — " + detail : ""}`);
      failed++;
    }
  }

  async function uploadFile(
    url: string,
    filePath: string,
    fields: Record<string, string> = {},
  ) {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);

    let body = "";
    for (const [key, value] of Object.entries(fields)) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    }
    body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`;

    const bodyBuffer = Buffer.concat([
      Buffer.from(body),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyBuffer,
    });
    return { status: res.status, body: await res.json() };
  }

  // -------------------------------------------------------------------------
  // CSV generation — 100 Rwandan employees
  // -------------------------------------------------------------------------

  const FIRST_NAMES = [
    "Mugabo", "Uwimana", "Iradukunda", "Ishimwe", "Niyonzima", "Uwase",
    "Mutesi", "Habimana", "Ingabire", "Ndayisaba", "Mukeshimana", "Rugamba",
    "Uwera", "Nsengimana", "Kayitesi", "Manzi", "Izabayo", "Tuyisenge",
    "Nkundimana", "Akaliza",
  ];
  const LAST_NAMES = [
    "Mugisha", "Kamanzi", "Nkurunziza", "Hakizimana", "Nshimiyimana",
    "Umutoni", "Bizimana", "Rwigamba", "Gatete", "Munyandamutsa",
    "Karambizi", "Nyiraneza", "Uwamahoro", "Sibomana", "Twagiramungu",
  ];
  const DEPTS = ["Finance", "Engineering", "HR", "Legal", "Marketing", "Operations"];
  const LOCATIONS = ["Kigali", "Butare", "Gisenyi", "Ruhengeri", "Cyangugu", "Kibungo"];
  const SKILLS_POOL = ["Python", "SQL", "Java", "TypeScript", "Excel", "Leadership", "Audit", "Tax Law"];

  function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

  function generateCSV(count: number): string {
    const header = "emp_id,full_name,email,department,annual_salary,start_date,is_active,skills,office_location,company_id";
    const rows: string[] = [header];
    for (let i = 1; i <= count; i++) {
      const id = `EMP-${String(i).padStart(4, "0")}`;
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const name = `${first} ${last}`;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@rra.gov.rw`;
      const dept = pick(DEPTS);
      const salary = 3000000 + Math.floor(Math.random() * 7000000);
      const year = 2015 + Math.floor(Math.random() * 9);
      const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
      const date = `${year}-${month}-01`;
      const active = Math.random() > 0.1 ? "true" : "false";
      const skills = `"${[pick(SKILLS_POOL), pick(SKILLS_POOL)].join(", ")}"`;
      const loc = pick(LOCATIONS);
      const companyId = `COMP-${String(1 + Math.floor(Math.random() * 5)).padStart(3, "0")}`;
      rows.push(`${id},${name},${email},${dept},${salary},${date},${active},${skills},${loc},${companyId}`);
    }
    return rows.join("\n");
  }

  // -------------------------------------------------------------------------
  // State variables for cleanup
  // -------------------------------------------------------------------------

  let ontologyId: string | null = null;
  let datasetId: string | null = null;
  const tmpFile = path.join(os.tmpdir(), `tellus_test01_${Date.now()}.csv`);

  try {
    // -----------------------------------------------------------------------
    // 1.1 Create ontology
    // -----------------------------------------------------------------------
    const ontRes = await api("GET", "/api/v1/ontology/default");
    ontologyId = ontRes.body?.data?.ontologyId ?? ontRes.body?.ontologyId ?? null;
    assert(!!ontologyId, "1.1 Create ontology", `status=${ontRes.status}`);

    // -----------------------------------------------------------------------
    // 1.2 Create Employee object type (batch) with 10 properties
    // -----------------------------------------------------------------------
    const otRes = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/batch`, {
      apiName: "Employee",
      displayName: "Employee",
      description: "RRA employee record",
      primaryKeyProperty: "employeeId",
      titleProperty: "fullName",
      properties: [
        { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
        { apiName: "fullName", displayName: "Full Name", baseType: "string" },
        { apiName: "email", displayName: "Email", baseType: "string" },
        { apiName: "department", displayName: "Department", baseType: "string" },
        { apiName: "salary", displayName: "Annual Salary", baseType: "double" },
        { apiName: "startDate", displayName: "Start Date", baseType: "date" },
        { apiName: "isActive", displayName: "Is Active", baseType: "boolean" },
        { apiName: "skills", displayName: "Skills", baseType: "string" },
        { apiName: "officeLocation", displayName: "Office Location", baseType: "string" },
        { apiName: "companyId", displayName: "Company ID", baseType: "string" },
      ],
    });
    assert(otRes.status === 201, "1.2 Create Employee object type", `status=${otRes.status}`);

    // -----------------------------------------------------------------------
    // 1.3 Generate and upload CSV with 100 rows
    // -----------------------------------------------------------------------
    const csv = generateCSV(100);
    fs.writeFileSync(tmpFile, csv);

    const uploadRes = await uploadFile(`${BASE}/api/v1/datasets/upload`, tmpFile, {
      name: "employee_data_test01",
      description: "Test 01 employee data",
      transactionType: "SNAPSHOT",
    });
    datasetId = uploadRes.body?.data?.dataset?.datasetId ?? null;
    assert(uploadRes.status === 201 && !!datasetId, "1.3 Upload CSV (100 rows)", `status=${uploadRes.status}`);

    // -----------------------------------------------------------------------
    // 1.4 Register backing datasource
    // -----------------------------------------------------------------------
    const dsRes = await api(
      "POST",
      `/api/v1/ontology/${ontologyId}/objectTypes/Employee/datasource`,
      {
        datasetId,
        columnMapping: {
          employeeId: "emp_id",
          fullName: "full_name",
          email: "email",
          department: "department",
          salary: "annual_salary",
          startDate: "start_date",
          isActive: "is_active",
          skills: "skills",
          officeLocation: "office_location",
          companyId: "company_id",
        },
      },
    );
    assert(dsRes.status === 201, "1.4 Register backing datasource", `status=${dsRes.status}`);

    // -----------------------------------------------------------------------
    // 1.5 Trigger reindex, verify 100 objects indexed
    // -----------------------------------------------------------------------
    const rixRes = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const totalIndexed = rixRes.body?.data?.result?.totalObjectsIndexed ?? rixRes.body?.result?.totalObjectsIndexed ?? -1;
    assert(
      rixRes.status === 200 && totalIndexed === 100,
      "1.5 Reindex (100 objects indexed)",
      `status=${rixRes.status}, totalIndexed=${totalIndexed}`,
    );

    // -----------------------------------------------------------------------
    // 1.6 Query all employees, verify count
    // -----------------------------------------------------------------------
    const listRes = await api("GET", "/api/v1/objects/Employee?$pageSize=200");
    const listCount = listRes.body?.data?.totalCount ?? listRes.body?.totalCount ?? -1;
    assert(listCount === 100, "1.6 List all employees (100)", `count=${listCount}`);

    // -----------------------------------------------------------------------
    // 1.7 Get single employee by PK
    // -----------------------------------------------------------------------
    const getRes = await api("GET", "/api/v1/objects/Employee/EMP-0001");
    const pkVal = getRes.body?.data?.employeeId ?? getRes.body?.employeeId ?? null;
    assert(getRes.status === 200 && pkVal === "EMP-0001", "1.7 Get EMP-0001 by PK", `pk=${pkVal}`);

    // -----------------------------------------------------------------------
    // 1.8 Search with eq filter on department
    // -----------------------------------------------------------------------
    const targetDept = "Finance";
    const searchRes = await api("POST", "/api/v1/objects/Employee/search", {
      where: { field: "department", op: "eq", value: targetDept },
      $pageSize: 200,
    });
    const searchData = searchRes.body?.data?.data ?? searchRes.body?.data ?? [];
    const allMatch = searchData.every((o: any) => o.department === targetDept);
    assert(searchRes.status === 200 && allMatch && searchData.length >= 0, "1.8 Search eq filter (department)", `count=${searchData.length}`);

    // -----------------------------------------------------------------------
    // 1.9 Search with compound AND filter
    // -----------------------------------------------------------------------
    const compoundRes = await api("POST", "/api/v1/objects/Employee/search", {
      where: {
        type: "and",
        value: [
          { field: "department", op: "eq", value: targetDept },
          { field: "isActive", op: "eq", value: true },
        ],
      },
      $pageSize: 200,
    });
    const compoundData = compoundRes.body?.data?.data ?? compoundRes.body?.data ?? [];
    assert(compoundRes.status === 200, "1.9 Compound AND filter", `count=${compoundData.length}`);

    // -----------------------------------------------------------------------
    // 1.10 Aggregation (count, avg salary, terms on department)
    // -----------------------------------------------------------------------
    const aggRes = await api("POST", "/api/v1/objects/Employee/aggregate", {
      aggregations: [
        { type: "count", name: "total" },
        { type: "avg", field: "salary", name: "avgSalary" },
        { type: "terms", field: "department", name: "byDept" },
      ],
    });
    const aggTotal = aggRes.body?.data?.total ?? aggRes.body?.total ?? -1;
    assert(aggRes.status === 200 && aggTotal === 100, "1.10 Aggregation (count=100)", `total=${aggTotal}`);

    // -----------------------------------------------------------------------
    // 1.11 Full-text search
    // -----------------------------------------------------------------------
    const ftsRes = await api("POST", "/api/v1/objects/Employee/searchFullText", {
      query: "Kigali",
      $pageSize: 200,
    });
    assert(ftsRes.status === 200, "1.11 Full-text search", `status=${ftsRes.status}`);

  } finally {
    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    console.log("\n  [cleanup] Removing test data...");
    if (ontologyId) {
      await api("DELETE", `/api/v1/ontology/${ontologyId}`).catch(() => {});
    }
    if (datasetId) {
      await api("DELETE", `/api/v1/datasets/${datasetId}?force=true`).catch(() => {});
    }
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const elapsed = Date.now() - suiteStart;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed (${elapsed}ms) ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
