// ---------------------------------------------------------------------------
// Integration Test 02: Edit Preservation Across Reindex
//
// Tests that user edits (update, create, delete via actions) survive a
// reindex cycle. This is the CRITICAL contract of the Ontology Engine:
// edits always win over datasource data.
//
// Run: npx tsx tests/integration/test02_edit_preservation.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import os from "os";

const BASE = process.env.API_BASE || "http://localhost:3000";

async function run() {
  let passed = 0;
  let failed = 0;
  const suiteStart = Date.now();

  console.log("=== Integration Test: Edit Preservation Across Reindex ===\n");

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

  async function uploadFile(url: string, filePath: string, fields: Record<string, string> = {}) {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    let body = "";
    for (const [key, value] of Object.entries(fields)) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    }
    body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`;
    const bodyBuffer = Buffer.concat([Buffer.from(body), fileContent, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyBuffer,
    });
    return { status: res.status, body: await res.json() };
  }

  // -------------------------------------------------------------------------
  // CSV generation
  // -------------------------------------------------------------------------

  function generateCSV(count: number): string {
    const header = "emp_id,full_name,email,department,annual_salary,start_date,is_active,skills,office_location,company_id";
    const rows: string[] = [header];
    for (let i = 1; i <= count; i++) {
      const id = `EMP-${String(i).padStart(4, "0")}`;
      const salary = 5000000 + i * 10000;
      rows.push(`${id},Test User ${i},user${i}@rra.gov.rw,Finance,${salary},2020-01-01,true,"SQL",Kigali,COMP-001`);
    }
    return rows.join("\n");
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let ontologyId: string | null = null;
  let datasetId: string | null = null;
  const tmpFile = path.join(os.tmpdir(), `tellus_test02_${Date.now()}.csv`);

  try {
    // -----------------------------------------------------------------------
    // 2.1 Setup: ontology + Employee type + upload + register + reindex
    // -----------------------------------------------------------------------
    const ontRes = await api("GET", "/api/v1/ontology/default");
    ontologyId = ontRes.body?.data?.ontologyId ?? null;

    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/batch`, {
      apiName: "Employee",
      displayName: "Employee",
      primaryKeyProperty: "employeeId",
      titleProperty: "fullName",
      properties: [
        { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
        { apiName: "fullName", displayName: "Full Name", baseType: "string" },
        { apiName: "email", displayName: "Email", baseType: "string" },
        { apiName: "department", displayName: "Department", baseType: "string" },
        { apiName: "salary", displayName: "Salary", baseType: "double" },
        { apiName: "startDate", displayName: "Start Date", baseType: "date" },
        { apiName: "isActive", displayName: "Active", baseType: "boolean" },
        { apiName: "skills", displayName: "Skills", baseType: "string" },
        { apiName: "officeLocation", displayName: "Office", baseType: "string" },
        { apiName: "companyId", displayName: "Company", baseType: "string" },
      ],
    });

    const csv = generateCSV(100);
    fs.writeFileSync(tmpFile, csv);

    const upRes = await uploadFile(`${BASE}/api/v1/datasets/upload`, tmpFile, {
      name: "edit_pres_data",
      transactionType: "SNAPSHOT",
    });
    datasetId = upRes.body?.data?.dataset?.datasetId ?? null;

    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/datasource`, {
      datasetId,
      columnMapping: {
        employeeId: "emp_id", fullName: "full_name", email: "email",
        department: "department", salary: "annual_salary", startDate: "start_date",
        isActive: "is_active", skills: "skills", officeLocation: "office_location",
        companyId: "company_id",
      },
    });

    const rixRes = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const indexed = rixRes.body?.data?.result?.totalObjectsIndexed ?? -1;
    assert(indexed === 100, "2.1 Setup + reindex (100 objects)", `indexed=${indexed}`);

    // -----------------------------------------------------------------------
    // 2.2 Create updateEmployeeSalary action type
    // -----------------------------------------------------------------------
    const actRes = await api("POST", `/api/v1/ontology/${ontologyId}/actionTypes`, {
      apiName: "updateEmployeeSalary",
      displayName: "Update Employee Salary",
      parameters: [
        { apiName: "employeeId", displayName: "Employee ID", type: "string" },
        { apiName: "newSalary", displayName: "New Salary", type: "double" },
      ],
      rules: [{
        type: "modifyObject",
        objectType: "Employee",
        objectKey: { source: "parameter", param: "employeeId" },
        properties: { salary: { source: "parameter", param: "newSalary" } },
      }],
    });
    assert(actRes.status === 201, "2.2 Create updateEmployeeSalary action type", `status=${actRes.status}`);

    // -----------------------------------------------------------------------
    // 2.3 Record original salary of EMP-0001
    // -----------------------------------------------------------------------
    const origRes = await api("GET", "/api/v1/objects/Employee/EMP-0001");
    const origSalary = origRes.body?.data?.salary ?? origRes.body?.salary ?? null;
    assert(origSalary !== null && origSalary !== 999999, "2.3 Record original salary of EMP-0001", `salary=${origSalary}`);

    // -----------------------------------------------------------------------
    // 2.4 Update EMP-0001 salary to 999999
    // -----------------------------------------------------------------------
    const applyRes = await api("POST", `/api/v1/ontology/${ontologyId}/actions/updateEmployeeSalary/apply`, {
      parameters: { employeeId: "EMP-0001", newSalary: 999999 },
    });
    assert(applyRes.status === 200, "2.4 Update EMP-0001 salary to 999999", `status=${applyRes.status}`);

    // -----------------------------------------------------------------------
    // 2.5 Verify salary changed
    // -----------------------------------------------------------------------
    const checkRes = await api("GET", "/api/v1/objects/Employee/EMP-0001");
    const newSalary = checkRes.body?.data?.salary ?? checkRes.body?.salary ?? null;
    assert(newSalary === 999999, "2.5 Verify salary changed", `salary=${newSalary}`);

    // -----------------------------------------------------------------------
    // 2.6 Verify edit recorded
    // -----------------------------------------------------------------------
    const editsRes = await api("GET", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/edits?primaryKey=EMP-0001`);
    const editCount = editsRes.body?.data?.data?.length ?? editsRes.body?.data?.summary?.total ?? 0;
    assert(editCount > 0, "2.6 Verify edit recorded", `editCount=${editCount}`);

    // -----------------------------------------------------------------------
    // 2.7 CRITICAL: Reindex — verify salary STILL 999999
    // -----------------------------------------------------------------------
    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const afterRix = await api("GET", "/api/v1/objects/Employee/EMP-0001");
    const salaryAfterRix = afterRix.body?.data?.salary ?? afterRix.body?.salary ?? null;
    assert(salaryAfterRix === 999999, "2.7 CRITICAL: Salary preserved after reindex", `salary=${salaryAfterRix}`);

    // -----------------------------------------------------------------------
    // 2.8 Check diff endpoint
    // -----------------------------------------------------------------------
    const diffRes = await api("GET", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/edits/diff/EMP-0001`);
    assert(diffRes.status === 200, "2.8 Diff endpoint returns 200", `status=${diffRes.status}`);

    // -----------------------------------------------------------------------
    // 2.9 Create createEmployee action type
    // -----------------------------------------------------------------------
    const createActRes = await api("POST", `/api/v1/ontology/${ontologyId}/actionTypes`, {
      apiName: "createEmployee",
      displayName: "Create Employee",
      parameters: [
        { apiName: "employeeId", displayName: "Employee ID", type: "string" },
        { apiName: "fullName", displayName: "Full Name", type: "string" },
        { apiName: "email", displayName: "Email", type: "string" },
        { apiName: "department", displayName: "Department", type: "string" },
        { apiName: "salary", displayName: "Salary", type: "double" },
      ],
      rules: [{
        type: "createObject",
        objectType: "Employee",
        properties: {
          employeeId: { source: "parameter", param: "employeeId" },
          fullName: { source: "parameter", param: "fullName" },
          email: { source: "parameter", param: "email" },
          department: { source: "parameter", param: "department" },
          salary: { source: "parameter", param: "salary" },
        },
      }],
    });
    assert(createActRes.status === 201, "2.9 Create createEmployee action type", `status=${createActRes.status}`);

    // -----------------------------------------------------------------------
    // 2.10 Create new employee EMP-NEW-TEST via action
    // -----------------------------------------------------------------------
    const createEmpRes = await api("POST", `/api/v1/ontology/${ontologyId}/actions/createEmployee/apply`, {
      parameters: {
        employeeId: "EMP-NEW-TEST",
        fullName: "New Test Employee",
        email: "newtest@rra.gov.rw",
        department: "Engineering",
        salary: 7500000,
      },
    });
    assert(createEmpRes.status === 200, "2.10 Create EMP-NEW-TEST via action", `status=${createEmpRes.status}`);

    // -----------------------------------------------------------------------
    // 2.11 Verify new employee exists
    // -----------------------------------------------------------------------
    const newEmpRes = await api("GET", "/api/v1/objects/Employee/EMP-NEW-TEST");
    assert(newEmpRes.status === 200, "2.11 Verify EMP-NEW-TEST exists", `status=${newEmpRes.status}`);

    // -----------------------------------------------------------------------
    // 2.12 CRITICAL: Reindex — verify EMP-NEW-TEST STILL exists
    // -----------------------------------------------------------------------
    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const afterRix2 = await api("GET", "/api/v1/objects/Employee/EMP-NEW-TEST");
    assert(afterRix2.status === 200, "2.12 CRITICAL: EMP-NEW-TEST survives reindex", `status=${afterRix2.status}`);

    // -----------------------------------------------------------------------
    // 2.13 Create deleteEmployee action type
    // -----------------------------------------------------------------------
    const delActRes = await api("POST", `/api/v1/ontology/${ontologyId}/actionTypes`, {
      apiName: "deleteEmployee",
      displayName: "Delete Employee",
      parameters: [
        { apiName: "employeeId", displayName: "Employee ID", type: "string" },
      ],
      rules: [{
        type: "deleteObject",
        objectType: "Employee",
        objectKey: { source: "parameter", param: "employeeId" },
      }],
    });
    assert(delActRes.status === 201, "2.13 Create deleteEmployee action type", `status=${delActRes.status}`);

    // -----------------------------------------------------------------------
    // 2.14 Delete EMP-0002 via action
    // -----------------------------------------------------------------------
    const deleteRes = await api("POST", `/api/v1/ontology/${ontologyId}/actions/deleteEmployee/apply`, {
      parameters: { employeeId: "EMP-0002" },
    });
    assert(deleteRes.status === 200, "2.14 Delete EMP-0002 via action", `status=${deleteRes.status}`);

    // -----------------------------------------------------------------------
    // 2.15 Verify deleted
    // -----------------------------------------------------------------------
    const delCheck = await api("GET", "/api/v1/objects/Employee/EMP-0002");
    assert(delCheck.status === 404, "2.15 Verify EMP-0002 deleted", `status=${delCheck.status}`);

    // -----------------------------------------------------------------------
    // 2.16 CRITICAL: Reindex — verify EMP-0002 STILL deleted
    // -----------------------------------------------------------------------
    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const afterRix3 = await api("GET", "/api/v1/objects/Employee/EMP-0002");
    assert(afterRix3.status === 404, "2.16 CRITICAL: EMP-0002 stays deleted after reindex", `status=${afterRix3.status}`);

  } finally {
    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    console.log("\n  [cleanup] Removing test data...");
    if (ontologyId) await api("DELETE", `/api/v1/ontology/${ontologyId}`).catch(() => {});
    if (datasetId) await api("DELETE", `/api/v1/datasets/${datasetId}?force=true`).catch(() => {});
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
