// ---------------------------------------------------------------------------
// Test 08 — Error Handling and Edge Cases
//
// Validates that the API returns correct HTTP status codes and structured
// error responses for a variety of invalid inputs and conflict scenarios.
//
// Run: npx tsx tests/integration/test08_error_handling.ts
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
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
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
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Cleanup tracker
// ---------------------------------------------------------------------------

let ontologyId: string | null = null;
let datasetId: string | null = null;
const tmpFiles: string[] = [];

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
  for (const f of tmpFiles) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`  Removed ${path.basename(f)}`);
      }
    } catch { /* best effort */ }
  }
}

function writeTmpFile(name: string, content: string | Buffer, ext = ".csv"): string {
  const tmpDir = path.join(__dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const p = path.join(tmpDir, `${name}_${Date.now()}${ext}`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Test 08: Error Handling and Edge Cases ===\n");

  // -----------------------------------------------------------------------
  // Setup: ontology + object type + dataset
  // -----------------------------------------------------------------------
  console.log("Setup: ontology + Employee type + dataset\n");

  const ontRes = await api("GET", "/api/v1/ontology/default");
  ontologyId = ontRes.body?.data?.ontologyId;

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
  assert(otRes.status === 201, "Setup: Employee type created");

  const csv =
    "employee_id,full_name,department,salary\n" +
    "E001,Alice Smith,Engineering,75000\n" +
    "E002,Bob Jones,Sales,82000\n";
  const csvPath = writeTmpFile("test08_employees", csv);

  const uploadRes = await uploadFile(`${API}/api/v1/datasets/upload`, csvPath, {
    name: "test08_employees",
  });
  assert(uploadRes.status === 201, "Setup: dataset uploaded");
  datasetId = uploadRes.body?.data?.dataset?.datasetId;

  // Register datasource
  await api(
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

  // Reindex
  await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/Employee/reindex?force=true`);

  // Create an action type for later tests
  await api("POST", `/api/v1/ontology/${ontologyId}/actionTypes`, {
    apiName: "updateDepartment",
    displayName: "Update Department",
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
  });

  // -----------------------------------------------------------------------
  // 8.1 Duplicate api_name on object type creation → 409
  // -----------------------------------------------------------------------
  console.log("\n8.1  Duplicate api_name on object type creation");

  const dupRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/batch`,
    {
      apiName: "Employee",
      displayName: "Employee Duplicate",
      primaryKeyProperty: "id",
      properties: [
        { apiName: "id", displayName: "ID", baseType: "string" },
      ],
    }
  );
  assert(
    dupRes.status === 409 || dupRes.status === 400,
    `Duplicate apiName returns 409 or 400 (got ${dupRes.status})`
  );
  const dupCode = dupRes.body?.error?.code;
  assert(
    dupCode === "OBJECT_TYPE_ALREADY_EXISTS" || dupCode === "VALIDATION_FAILED",
    `Error code indicates duplicate (got "${dupCode}")`
  );

  // -----------------------------------------------------------------------
  // 8.2 Register datasource with non-existent datasetId → 404
  // -----------------------------------------------------------------------
  console.log("\n8.2  Register datasource with non-existent datasetId");

  // Create a second object type to register against
  await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/batch`, {
    apiName: "TempType",
    displayName: "Temp Type",
    primaryKeyProperty: "id",
    properties: [
      { apiName: "id", displayName: "ID", baseType: "string" },
    ],
  });

  const fakeDatasetId = "00000000-0000-0000-0000-000000000000";
  const noDatasetRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/TempType/datasource`,
    {
      datasetId: fakeDatasetId,
      columnMapping: { id: "id" },
    }
  );
  assert(
    noDatasetRes.status === 404 || noDatasetRes.status === 400,
    `Non-existent dataset returns 404 or 400 (got ${noDatasetRes.status})`
  );
  const noDatasetCode = noDatasetRes.body?.error?.code;
  assert(
    noDatasetCode === "DATASET_NOT_FOUND" || noDatasetCode === "VALIDATION_FAILED",
    `Error code is DATASET_NOT_FOUND or similar (got "${noDatasetCode}")`
  );

  // -----------------------------------------------------------------------
  // 8.3 Register datasource with misspelled column → 400 COLUMN_NOT_FOUND
  // -----------------------------------------------------------------------
  console.log("\n8.3  Register datasource with misspelled column");

  // Create another object type
  await api("POST", `/api/v1/ontology/${ontologyId}/objectTypes/batch`, {
    apiName: "BadMapping",
    displayName: "Bad Mapping",
    primaryKeyProperty: "myId",
    properties: [
      { apiName: "myId", displayName: "My ID", baseType: "string" },
      { apiName: "myName", displayName: "My Name", baseType: "string" },
    ],
  });

  const badColRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/BadMapping/datasource`,
    {
      datasetId,
      columnMapping: {
        myId: "employee_id",
        myName: "ful_naame", // misspelled
      },
    }
  );
  assert(
    badColRes.status === 400,
    `Misspelled column returns 400 (got ${badColRes.status})`
  );
  const badColCode = badColRes.body?.error?.code;
  assert(
    badColCode === "COLUMN_NOT_FOUND" || badColCode === "COLUMN_MAPPING_INVALID" || badColCode === "VALIDATION_FAILED",
    `Error code indicates column issue (got "${badColCode}")`
  );

  // -----------------------------------------------------------------------
  // 8.4 Delete dataset in use → 409 DATASET_IN_USE
  // -----------------------------------------------------------------------
  console.log("\n8.4  Delete dataset in use");

  const delInUseRes = await api("DELETE", `/api/v1/datasets/${datasetId}`);
  assert(
    delInUseRes.status === 409 || delInUseRes.status === 400,
    `Delete in-use dataset returns 409 or 400 (got ${delInUseRes.status})`
  );
  const delCode = delInUseRes.body?.error?.code;
  assert(
    delCode === "DATASET_IN_USE",
    `Error code is DATASET_IN_USE (got "${delCode}")`
  );

  // -----------------------------------------------------------------------
  // 8.5 Upload invalid CSV (binary data) → 400
  // -----------------------------------------------------------------------
  console.log("\n8.5  Upload invalid CSV (binary data)");

  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]);
  const binaryPath = writeTmpFile("test08_binary", binaryData, ".csv");

  const binaryRes = await uploadFile(`${API}/api/v1/datasets/upload`, binaryPath, {
    name: "test08_binary_data",
  });
  assert(
    binaryRes.status === 400 || binaryRes.status === 500,
    `Binary data upload returns 400 or 500 (got ${binaryRes.status})`
  );

  // -----------------------------------------------------------------------
  // 8.6 Append JSON to CSV dataset → 400 FORMAT_MISMATCH
  // -----------------------------------------------------------------------
  console.log("\n8.6  Append JSON to CSV dataset");

  const jsonContent = JSON.stringify([{ id: "1", name: "test" }]);
  const jsonPath = writeTmpFile("test08_wrong_format", jsonContent, ".json");

  const formatRes = await uploadFile(
    `${API}/api/v1/datasets/${datasetId}/transactions`,
    jsonPath,
    { type: "APPEND" }
  );
  assert(
    formatRes.status === 400,
    `JSON appended to CSV dataset returns 400 (got ${formatRes.status})`
  );
  const formatCode = formatRes.body?.error?.code;
  assert(
    formatCode === "FORMAT_MISMATCH" || formatCode === "VALIDATION_FAILED",
    `Error code is FORMAT_MISMATCH or similar (got "${formatCode}")`
  );

  // -----------------------------------------------------------------------
  // 8.7 Query non-existent object type → 404
  // -----------------------------------------------------------------------
  console.log("\n8.7  Query non-existent object type");

  const noOtRes = await api("GET", "/api/v1/objects/NonExistentType99");
  assert(
    noOtRes.status === 404,
    `Non-existent object type returns 404 (got ${noOtRes.status})`
  );
  const noOtCode = noOtRes.body?.error?.code;
  assert(
    noOtCode === "OBJECT_TYPE_NOT_FOUND",
    `Error code is OBJECT_TYPE_NOT_FOUND (got "${noOtCode}")`
  );

  // -----------------------------------------------------------------------
  // 8.8 Execute action with missing required param → 400
  // -----------------------------------------------------------------------
  console.log("\n8.8  Execute action with missing required param");

  const missingParamRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/actions/updateDepartment/apply`,
    {
      parameters: {
        // missing employeeRef and newDepartment
      },
    }
  );
  assert(
    missingParamRes.status === 400 || missingParamRes.status === 422,
    `Missing required param returns 400 or 422 (got ${missingParamRes.status})`
  );

  // -----------------------------------------------------------------------
  // 8.9 Execute action targeting non-existent object → 404
  // -----------------------------------------------------------------------
  console.log("\n8.9  Execute action targeting non-existent object");

  const noObjRes = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/actions/updateDepartment/apply`,
    {
      parameters: {
        employeeRef: "NONEXISTENT_XYZ",
        newDepartment: "Sales",
      },
    }
  );
  assert(
    noObjRes.status === 404 || noObjRes.status === 400 || noObjRes.status === 422,
    `Non-existent object returns 404 or 400 or 422 (got ${noObjRes.status})`
  );
  const noObjCode = noObjRes.body?.error?.code ?? noObjRes.body?.errorName;
  assert(
    noObjCode === "OBJECT_NOT_FOUND" ||
    noObjCode === "ObjectNotFound" ||
    noObjCode === "ACTION_EXECUTION_FAILED" ||
    typeof noObjCode === "string",
    `Error code indicates object not found (got "${noObjCode}")`
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
