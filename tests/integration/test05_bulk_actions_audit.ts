// ---------------------------------------------------------------------------
// Test 05 — Bulk Actions and Audit Trail
//
// Validates bulk action execution with partial success/failure handling,
// stopOnError semantics, and the global audit log endpoint.
//
// Run: npx tsx tests/integration/test05_bulk_actions_audit.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";

const API = process.env.API_BASE || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Multipart upload helper
// ---------------------------------------------------------------------------

async function uploadFile(
  url: string,
  filePath: string,
  fields: Record<string, string> = {}
): Promise<any> {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function generateEmployeeCsv(count: number): string {
  const header = "employee_id,full_name,department,salary\n";
  const rows: string[] = [];
  for (let i = 1; i <= count; i++) {
    rows.push(`EMP${String(i).padStart(4, "0")},Employee ${i},Engineering,${50000 + i * 100}`);
  }
  return header + rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Cleanup tracker
// ---------------------------------------------------------------------------

let ontologyId: string | null = null;
let datasetId: string | null = null;
let tmpCsvPath: string | null = null;

async function cleanup() {
  console.log("\n--- Cleanup ---");
  try {
    if (ontologyId) {
      await api("DELETE", `/api/v1/ontology/${ontologyId}`);
      console.log("  Deleted ontology");
    }
  } catch { /* best effort */ }
  try {
    if (datasetId) {
      await api("DELETE", `/api/v1/datasets/${datasetId}?force=true`);
      console.log("  Deleted dataset");
    }
  } catch { /* best effort */ }
  try {
    if (tmpCsvPath && fs.existsSync(tmpCsvPath)) {
      fs.unlinkSync(tmpCsvPath);
      console.log("  Removed temp CSV");
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Test 05: Bulk Actions and Audit Trail ===\n");

  // -----------------------------------------------------------------------
  // 5.1 Setup: ontology + Employee type + upload 50 employees
  // -----------------------------------------------------------------------
  console.log("5.1  Setup ontology + Employee type + upload 50 employees");

  const ontRes = await api("GET", "/api/v1/ontology/default");
  ontologyId = ontRes.body?.data?.ontologyId ?? ontRes.body?.ontologyId; assert(!!ontologyId, "Enterprise ontology resolved");

  // Create Employee object type with properties via batch
  const otRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/batch`,
    {
      apiName: "Employee",
      displayName: "Employee",
      primaryKeyProperty: "employeeId",
      properties: [
        { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
        { apiName: "fullName", displayName: "Full Name", baseType: "string" },
        { apiName: "department", displayName: "Department", baseType: "string" },
        { apiName: "salary", displayName: "Salary", baseType: "double" },
      ],
    }
  );
  assert(otRes.status === 201, "Employee object type created");

  // Generate and upload CSV
  const csvContent = generateEmployeeCsv(50);
  const tmpDir = path.join(__dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  tmpCsvPath = path.join(tmpDir, `test05_employees_${Date.now()}.csv`);
  fs.writeFileSync(tmpCsvPath, csvContent);

  const uploadRes = await uploadFile(`${API}/api/v1/datasets/upload`, tmpCsvPath, {
    name: "test05_employees",
  });
  assert(uploadRes.status === 201, "Dataset uploaded");
  datasetId = uploadRes.body?.data?.dataset?.datasetId;

  // Register datasource
  const dsRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/Employee/datasource`,
    {
      datasetId,
      columnMapping: {
        employeeId: "employee_id",
        fullName: "full_name",
        department: "department",
        salary: "salary",
      },
    }
  );
  assert(dsRes.status === 201, "Datasource registered");

  // Reindex
  const reindexRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`
  );
  assert(reindexRes.status === 200, "Reindex completed");

  // -----------------------------------------------------------------------
  // 5.2 Create action type "reassignDepartment"
  // -----------------------------------------------------------------------
  console.log("\n5.2  Create action type reassignDepartment");

  const atRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/actionTypes`,
    {
      apiName: "reassignDepartment",
      displayName: "Reassign Department",
      parameters: [
        {
          apiName: "employeeRef",
          displayName: "Employee Reference",
          type: "object_reference",
          objectType: "Employee",
          required: true,
        },
        {
          apiName: "newDepartment",
          displayName: "New Department",
          type: "string",
          required: true,
        },
      ],
      rules: [
        {
          type: "modifyObject",
          objectType: "Employee",
          properties: {
            department: { source: "parameter", param: "newDepartment" },
          },
        },
      ],
    }
  );
  assert(atRes.status === 201, "Action type created");

  // -----------------------------------------------------------------------
  // 5.3 Execute bulk action: 10 valid + 3 invalid (stopOnError=false)
  // -----------------------------------------------------------------------
  console.log("\n5.3  Bulk action: 10 valid + 3 invalid (stopOnError=false)");

  const validRequests = [];
  for (let i = 1; i <= 10; i++) {
    validRequests.push({
      parameters: {
        employeeRef: `EMP${String(i).padStart(4, "0")}`,
        newDepartment: "Sales",
      },
    });
  }
  const invalidRequests = [
    { parameters: { employeeRef: "NONEXISTENT_001", newDepartment: "Sales" } },
    { parameters: { employeeRef: "NONEXISTENT_002", newDepartment: "Sales" } },
    { parameters: { employeeRef: "NONEXISTENT_003", newDepartment: "Sales" } },
  ];

  const bulkRes = await api(
    "POST",
    `/api/v1/actions/reassignDepartment/applyBulk`,
    {
      requests: [...validRequests, ...invalidRequests],
      stopOnError: false,
    }
  );
  assert(bulkRes.status === 200, `Bulk action returned 200 (got ${bulkRes.status})`);
  assert(
    bulkRes.body?.successCount === 10,
    `successCount === 10 (got ${bulkRes.body?.successCount})`
  );
  assert(
    bulkRes.body?.failedCount === 3,
    `failedCount === 3 (got ${bulkRes.body?.failedCount})`
  );

  // -----------------------------------------------------------------------
  // 5.4 Verify employees have new department
  // -----------------------------------------------------------------------
  console.log("\n5.4  Verify employees have new department");

  // Reindex to reflect changes in search
  await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);

  const searchRes = await api("POST", "/api/v1/objects/Employee/search", {
    where: { department: { eq: "Sales" } },
    $pageSize: 50,
  });
  assert(searchRes.status === 200, "Search returned 200");
  const salesCount = searchRes.body?.data?.data?.length ?? searchRes.body?.data?.totalCount ?? 0;
  assert(salesCount >= 10, `At least 10 employees in Sales (got ${salesCount})`);

  // -----------------------------------------------------------------------
  // 5.5 Verify audit log has entries (global audit endpoint)
  // -----------------------------------------------------------------------
  console.log("\n5.5  Verify audit log has entries");

  const auditRes = await api("GET", "/api/v1/audit/log?pageSize=50");
  assert(auditRes.status === 200, "Audit log returned 200");
  const auditEntries = auditRes.body?.data ?? [];
  // We should have at least 13 entries from our bulk action (10 success + 3 failed)
  const reassignEntries = auditEntries.filter(
    (e: any) => e.actionTypeApiName === "reassignDepartment"
  );
  assert(
    reassignEntries.length >= 13,
    `Audit log has >= 13 reassignDepartment entries (got ${reassignEntries.length})`
  );

  // -----------------------------------------------------------------------
  // 5.6 Test stopOnError=true (3 requests: valid, invalid, valid)
  // -----------------------------------------------------------------------
  console.log("\n5.6  Bulk action with stopOnError=true");

  const stopBulkRes = await api(
    "POST",
    `/api/v1/actions/reassignDepartment/applyBulk`,
    {
      requests: [
        { parameters: { employeeRef: "EMP0020", newDepartment: "Marketing" } },
        { parameters: { employeeRef: "NONEXISTENT_999", newDepartment: "Marketing" } },
        { parameters: { employeeRef: "EMP0030", newDepartment: "Marketing" } },
      ],
      stopOnError: true,
    }
  );
  assert(
    stopBulkRes.status === 200 || stopBulkRes.status === 422,
    `stopOnError bulk returned 200 or 422 (got ${stopBulkRes.status})`
  );

  const results = stopBulkRes.body?.results ?? [];
  // First should succeed, second should fail, third should be skipped
  const processedCount = results.filter(
    (r: any) => r.status === "success" || r.status === "failed"
  ).length;
  assert(
    processedCount === 2,
    `Only 2 requests processed (got ${processedCount})`
  );
  const skippedCount = results.filter((r: any) => r.status === "skipped").length;
  assert(skippedCount === 1, `1 request skipped (got ${skippedCount})`);

  // -----------------------------------------------------------------------
  // 5.7 Verify 3rd action's target was NOT changed
  // -----------------------------------------------------------------------
  console.log("\n5.7  Verify 3rd action target was NOT changed");

  await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);

  const emp30Res = await api("GET", "/api/v1/objects/Employee/EMP0030");
  assert(emp30Res.status === 200, "Fetched EMP0030");
  const emp30Dept = emp30Res.body?.data?.department;
  assert(
    emp30Dept !== "Marketing",
    `EMP0030 department is NOT Marketing (got "${emp30Dept}")`
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .then(async () => {
    await cleanup();
    console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("\nFATAL:", err);
    await cleanup();
    process.exit(1);
  });
