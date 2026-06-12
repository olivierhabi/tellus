// ---------------------------------------------------------------------------
// Integration Test 04: Link Traversal After Reindex
//
// Tests that link types work correctly across object types, including
// forward and reverse traversal via foreign-key-based MANY_TO_ONE links.
// Also verifies links survive append + reindex cycles.
//
// Run: npx tsx tests/integration/test04_link_traversal.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import os from "os";

const BASE = process.env.API_BASE || "http://localhost:3000";

async function run() {
  let passed = 0;
  let failed = 0;
  const suiteStart = Date.now();

  console.log("=== Integration Test: Link Traversal After Reindex ===\n");

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

  async function appendToDataset(dsId: string, filePath: string) {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fc = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    let mb = `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nAPPEND\r\n`;
    mb += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`;
    const buf = Buffer.concat([Buffer.from(mb), fc, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await fetch(`${BASE}/api/v1/datasets/${dsId}/transactions`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: buf,
    });
    return { status: res.status, body: await res.json() };
  }

  // -------------------------------------------------------------------------
  // CSV generators
  // -------------------------------------------------------------------------

  function generateCompanyCSV(): string {
    const header = "company_id,company_name,industry,hq_city,founded_year";
    const rows = [header];
    const companies = [
      { id: "COMP-001", name: "MTN Rwanda", industry: "Telecom", city: "Kigali", year: 1998 },
      { id: "COMP-002", name: "Bank of Kigali", industry: "Banking", city: "Kigali", year: 1966 },
      { id: "COMP-003", name: "RwandAir", industry: "Aviation", city: "Kigali", year: 2002 },
      { id: "COMP-004", name: "Inyange Industries", industry: "FMCG", city: "Kigali", year: 1996 },
      { id: "COMP-005", name: "BK TecHouse", industry: "Technology", city: "Kigali", year: 2018 },
    ];
    for (const c of companies) {
      rows.push(`${c.id},${c.name},${c.industry},${c.city},${c.year}`);
    }
    return rows.join("\n");
  }

  function generateEmployeeCSV(count: number, startIdx = 1): string {
    const header = "emp_id,full_name,email,department,company_id";
    const rows = [header];
    const companyIds = ["COMP-001", "COMP-002", "COMP-003", "COMP-004", "COMP-005"];
    for (let i = startIdx; i < startIdx + count; i++) {
      const id = `EMP-${String(i).padStart(4, "0")}`;
      // Distribute employees across companies (round-robin)
      const compId = companyIds[(i - 1) % companyIds.length];
      rows.push(`${id},Employee ${i},emp${i}@test.rw,Engineering,${compId}`);
    }
    return rows.join("\n");
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let ontologyId: string | null = null;
  let empDatasetId: string | null = null;
  let compDatasetId: string | null = null;
  const tmpFiles: string[] = [];

  function tmpPath(suffix: string): string {
    const p = path.join(os.tmpdir(), `tellus_test04_${suffix}_${Date.now()}.csv`);
    tmpFiles.push(p);
    return p;
  }

  try {
    // -----------------------------------------------------------------------
    // 4.1 Setup: ontology + Employee type + Company type
    // -----------------------------------------------------------------------
    const ontRes = await api("GET", "/api/v1/ontology/default");
    ontologyId = ontRes.body?.data?.ontologyId ?? null;

    // Create Employee type
    const empOtRes = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/batch`, {
      apiName: "Employee",
      displayName: "Employee",
      primaryKeyProperty: "employeeId",
      titleProperty: "fullName",
      properties: [
        { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
        { apiName: "fullName", displayName: "Full Name", baseType: "string" },
        { apiName: "email", displayName: "Email", baseType: "string" },
        { apiName: "department", displayName: "Department", baseType: "string" },
        { apiName: "companyId", displayName: "Company ID", baseType: "string" },
      ],
    });

    // Create Company type
    const compOtRes = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/batch`, {
      apiName: "Company",
      displayName: "Company",
      primaryKeyProperty: "companyId",
      titleProperty: "companyName",
      properties: [
        { apiName: "companyId", displayName: "Company ID", baseType: "string" },
        { apiName: "companyName", displayName: "Company Name", baseType: "string" },
        { apiName: "industry", displayName: "Industry", baseType: "string" },
        { apiName: "hqCity", displayName: "HQ City", baseType: "string" },
        { apiName: "foundedYear", displayName: "Founded Year", baseType: "integer" },
      ],
    });

    assert(
      empOtRes.status === 201 && compOtRes.status === 201 && !!ontologyId,
      "4.1 Setup ontology + Employee + Company types",
      `emp=${empOtRes.status}, comp=${compOtRes.status}`,
    );

    // -----------------------------------------------------------------------
    // 4.2 Upload employee and company CSVs
    // -----------------------------------------------------------------------
    const empFile = tmpPath("employees");
    fs.writeFileSync(empFile, generateEmployeeCSV(50));

    const compFile = tmpPath("companies");
    fs.writeFileSync(compFile, generateCompanyCSV());

    const empUp = await uploadFile(`${BASE}/api/v1/datasets/upload`, empFile, {
      name: "link_test_employees",
      transactionType: "SNAPSHOT",
    });
    empDatasetId = empUp.body?.data?.dataset?.datasetId ?? null;

    const compUp = await uploadFile(`${BASE}/api/v1/datasets/upload`, compFile, {
      name: "link_test_companies",
      transactionType: "SNAPSHOT",
    });
    compDatasetId = compUp.body?.data?.dataset?.datasetId ?? null;

    assert(
      empUp.status === 201 && compUp.status === 201 && !!empDatasetId && !!compDatasetId,
      "4.2 Upload employee + company CSVs",
      `emp=${empUp.status}, comp=${compUp.status}`,
    );

    // -----------------------------------------------------------------------
    // 4.3 Register datasources + reindex both
    // -----------------------------------------------------------------------
    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/datasource`, {
      datasetId: empDatasetId,
      columnMapping: {
        employeeId: "emp_id",
        fullName: "full_name",
        email: "email",
        department: "department",
        companyId: "company_id",
      },
    });

    await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Company/datasource`, {
      datasetId: compDatasetId,
      columnMapping: {
        companyId: "company_id",
        companyName: "company_name",
        industry: "industry",
        hqCity: "hq_city",
        foundedYear: "founded_year",
      },
    });

    const empRix = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const compRix = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Company/reindex?force=true`);

    const empIndexed = empRix.body?.data?.result?.totalObjectsIndexed ?? -1;
    const compIndexed = compRix.body?.data?.result?.totalObjectsIndexed ?? -1;

    assert(
      empIndexed === 50 && compIndexed === 5,
      "4.3 Register + reindex both types",
      `emp=${empIndexed}, comp=${compIndexed}`,
    );

    // -----------------------------------------------------------------------
    // 4.4 Create MANY_TO_ONE link type: Employee→Company
    // -----------------------------------------------------------------------
    const linkRes = await api("POST", `/api/v1/ontology/${ontologyId}/linkTypes`, {
      apiName: "employeeCompany",
      displayName: "Employee Company",
      description: "Links employees to their company",
      cardinality: "MANY_TO_ONE",
      sourceObjectTypeApiName: "Employee",
      targetObjectTypeApiName: "Company",
      sourcePropertyApiName: "companyId",
      targetPropertyApiName: "companyId",
    });
    assert(linkRes.status === 201, "4.4 Create MANY_TO_ONE link type", `status=${linkRes.status}`);

    // -----------------------------------------------------------------------
    // 4.5 Forward traversal: Employee→Company for EMP-0001
    //     EMP-0001 has companyId=COMP-001 (round-robin: (1-1)%5=0 → COMP-001)
    // -----------------------------------------------------------------------
    const fwdRes = await api("GET", "/api/v1/objects/Employee/EMP-0001/links/employeeCompany?direction=forward");
    const linkedCompany = fwdRes.body?.data?.linkedObject ?? null;
    const linkedCompanyId = linkedCompany?.companyId ?? null;
    assert(
      fwdRes.status === 200 && linkedCompanyId === "COMP-001",
      "4.5 Forward traversal Employee→Company",
      `companyId=${linkedCompanyId}`,
    );

    // -----------------------------------------------------------------------
    // 4.6 Reverse traversal: Company→Employees for COMP-001
    //     COMP-001 gets employees at indices 1,6,11,16,21,26,31,36,41,46 = 10 employees
    // -----------------------------------------------------------------------
    const revRes = await api("GET", "/api/v1/objects/Company/COMP-001/links/employeeCompany?direction=reverse&pageSize=100");
    const linkedEmployees = revRes.body?.data?.linkedObjects ?? [];
    const reverseCount = linkedEmployees.length;
    // 50 employees, round-robin across 5 companies = 10 per company
    assert(
      revRes.status === 200 && reverseCount === 10,
      "4.6 Reverse traversal Company→Employees (10)",
      `count=${reverseCount}`,
    );

    // -----------------------------------------------------------------------
    // 4.7 Append new employees, reindex, verify links still work
    // -----------------------------------------------------------------------
    const appendFile = tmpPath("emp_append");
    // Add 10 more employees (EMP-0051..EMP-0060), all linked to COMP-001
    const appendHeader = "emp_id,full_name,email,department,company_id";
    const appendRows = [appendHeader];
    for (let i = 51; i <= 60; i++) {
      appendRows.push(`EMP-${String(i).padStart(4, "0")},New Employee ${i},newemp${i}@test.rw,Sales,COMP-001`);
    }
    fs.writeFileSync(appendFile, appendRows.join("\n"));

    const appendRes = await appendToDataset(empDatasetId!, appendFile);
    assert(appendRes.status === 201, "4.7a Append 10 new employees", `status=${appendRes.status}`);

    // Reindex employees
    const empRix2 = await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);
    const empIndexed2 = empRix2.body?.data?.result?.totalObjectsIndexed ?? -1;
    assert(empIndexed2 === 60, "4.7b Reindex employees after append (60)", `indexed=${empIndexed2}`);

    // Forward link still works for original employee
    const fwdRes2 = await api("GET", "/api/v1/objects/Employee/EMP-0001/links/employeeCompany?direction=forward");
    const linkedId2 = fwdRes2.body?.data?.linkedObject?.companyId ?? null;
    assert(linkedId2 === "COMP-001", "4.7c Forward link still works after reindex", `companyId=${linkedId2}`);

    // Forward link works for new employee
    const fwdNew = await api("GET", "/api/v1/objects/Employee/EMP-0055/links/employeeCompany?direction=forward");
    const linkedIdNew = fwdNew.body?.data?.linkedObject?.companyId ?? null;
    assert(linkedIdNew === "COMP-001", "4.7d New employee link resolves correctly", `companyId=${linkedIdNew}`);

    // Reverse count for COMP-001 should now be 10 original + 10 new = 20
    const revRes2 = await api("GET", "/api/v1/objects/Company/COMP-001/links/employeeCompany?direction=reverse&pageSize=100");
    const revCount2 = revRes2.body?.data?.linkedObjects?.length ?? -1;
    assert(revCount2 === 20, "4.7e Reverse traversal after append (20)", `count=${revCount2}`);

  } finally {
    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    console.log("\n  [cleanup] Removing test data...");
    if (ontologyId) await api("DELETE", `/api/v1/ontology/${ontologyId}`).catch(() => {});
    if (empDatasetId) await api("DELETE", `/api/v1/datasets/${empDatasetId}?force=true`).catch(() => {});
    if (compDatasetId) await api("DELETE", `/api/v1/datasets/${compDatasetId}?force=true`).catch(() => {});
    for (const f of tmpFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
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
